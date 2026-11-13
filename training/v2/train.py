#!/usr/bin/env python3
"""
v2 PPO trainer (G-10 M1 step 1: feed-forward PPO against scripted opponents).

One learner seat per slot, the other seat a scripted bot. Each slot draws a new
training map, seed, side and opponent when its episode ends (applied by the
runner one episode later). Three value heads (win, shaped, aux) with their own
γ/λ; advantages normalised per head and mixed (ML_RETRAIN_IMPLEMENTATION.md §7.2).

    python3 -m training.v2.train --run smoke --opponents idle --minutes 5
"""
from __future__ import annotations

import argparse
import json
import random
import time
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import torch
from torch.utils.tensorboard import SummaryWriter

from training.env.vec_env_v2 import VecEnvV2
from training.v2 import spaces as S
from training.v2.batch import pad_entities, stack_masks, stack_obs, static_grid
from training.v2.model import HEADS, Agent, teacher_actions, wire_actions

REPO = Path(__file__).resolve().parents[2]
VALUE_HEADS = ("win", "shaped", "aux")


def parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--procs", type=int, default=18)
    ap.add_argument("--slots", type=int, default=8, help="slots per process")
    ap.add_argument("--rollout", type=int, default=128)
    ap.add_argument("--minutes", type=float, default=5.0, help="wall-clock budget (0 = none)")
    ap.add_argument("--decisions", type=int, default=0, help="decision budget; schedules then run on decisions, not time (resume continues the count)")
    ap.add_argument("--stop-win-rate", type=float, default=0.0, help="stop when the last 200 episodes reach this win rate (a trigger for a fixed-seed evaluation, not a result)")
    ap.add_argument("--updates", type=int, default=0, help="stop after this many updates (0 = time budget only)")
    ap.add_argument("--opponents", default="idle", help="comma-separated scripted bots")
    ap.add_argument("--maps", default=",".join(S.TRAIN_MAPS))
    ap.add_argument("--max-ticks", type=int, default=12000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--lr-end", type=float, default=5e-5)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--minibatches", type=int, default=8)
    ap.add_argument("--clip", type=float, default=0.1)
    ap.add_argument("--ent", type=float, default=0.01)
    ap.add_argument("--ent-end", type=float, default=0.001)
    ap.add_argument("--vf", type=float, default=0.5)
    ap.add_argument("--max-grad", type=float, default=0.5)
    ap.add_argument("--gamma", default="0.999,0.99,0.999", help="win,shaped,aux")
    ap.add_argument("--lam", default="0.99,0.95,0.99", help="win,shaped,aux")
    ap.add_argument("--mix-start", default="0.1,0.8,0.1", help="advantage weights win,shaped,aux at the start")
    ap.add_argument("--mix-end", default="0.8,0.1,0.1", help="... at the end of the budget (shaped never below 0.1)")
    ap.add_argument("--shaped-w", default="1,0.5,1,1", help="weights for res,army,dmg,ctrl")
    ap.add_argument("--checkpoint-every", type=int, default=50)
    ap.add_argument("--resume", default="")
    ap.add_argument("--imitate", action="store_true", help="behaviour cloning: both seats are teach:<bot> from --opponents; policy heads learn the teacher's actions (cross-entropy), value heads the returns")
    ap.add_argument("--overfit", action="store_true", help="with --imitate: collect one rollout and train on it repeatedly (overfit probe: loss < 0.05)")
    a = ap.parse_args()
    for maps in a.maps.split(","):
        if maps in S.HELD_OUT_MAPS:
            raise SystemExit(f"{maps} is a held-out map and must not be used for training")
    return a


def floats(s: str) -> np.ndarray:
    return np.asarray([float(x) for x in s.split(",")], dtype=np.float32)


def to_t(o: dict[str, np.ndarray], dev) -> dict[str, torch.Tensor]:
    return {k: torch.as_tensor(v, device=dev) for k, v in o.items()}


class Slots:
    """Per-slot episode config draws."""

    def __init__(self, a: argparse.Namespace, rng: random.Random):
        self.maps, self.opps, self.rng = a.maps.split(","), a.opponents.split(","), rng
        self.imitate = a.imitate

    def draw(self) -> dict:
        if self.imitate:  # scripted v scripted, both seats teaching
            return {"seed": self.rng.randrange(1 << 30), "map": self.rng.choice(self.maps),
                    "blue": f"teach:{self.rng.choice(self.opps)}", "red": f"teach:{self.rng.choice(self.opps)}"}
        learner_blue = self.rng.random() < 0.5
        opp = f"bot:{self.rng.choice(self.opps)}"
        return {"seed": self.rng.randrange(1 << 30), "map": self.rng.choice(self.maps),
                "blue": "policy" if learner_blue else opp, "red": opp if learner_blue else "policy"}


def main() -> None:
    a = parse()
    rng = random.Random(a.seed)
    torch.manual_seed(a.seed)
    np.random.seed(a.seed)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    gamma, lam = floats(a.gamma), floats(a.lam)
    mix0, mix1 = floats(a.mix_start), floats(a.mix_end)
    shaped_w = floats(a.shaped_w)

    run_dir = REPO / "runs" / a.run
    ck_dir = REPO / "checkpoints" / "v2" / a.run
    ck_dir.mkdir(parents=True, exist_ok=True)
    writer = SummaryWriter(str(run_dir))
    (ck_dir / "config.json").write_text(json.dumps(vars(a), indent=2))

    agent = Agent().to(dev)
    opt = torch.optim.Adam(agent.parameters(), lr=a.lr, eps=1e-5)
    update0, decisions0 = 0, 0
    if a.resume:
        ck = torch.load(a.resume, map_location=dev)
        agent.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        update0 = ck["update"]
        decisions0 = ck.get("decisions", 0)
    print(f"params: {sum(p.numel() for p in agent.parameters()) / 1e6:.2f} M, device {dev}", flush=True)

    slots = Slots(a, rng)
    n_slots = a.procs * a.slots
    env = VecEnvV2([slots.draw() for _ in range(n_slots)], n_procs=a.procs, max_ticks=a.max_ticks)
    cur = env.reset()
    S.check_sizes(cur[0].obs, cur[0].masks)
    statics = [static_grid(s) for s in env.static]
    B = len(cur)
    want = "teach" if a.imitate else "learner"
    assert B == n_slots * (2 if a.imitate else 1) and all(s.role == want for s in cur), f"unexpected streams for this mode (want {want})"
    ep_steps = np.zeros(B, dtype=np.int64)
    ep_train = np.zeros((B, 5), dtype=np.int64)
    ep_ret = np.zeros((B, 3))

    recent = deque(maxlen=200)
    t_start = time.time()
    update = update0
    total_decisions = decisions0
    budget_s = a.minutes * 60
    while True:
        elapsed = time.time() - t_start
        if (a.minutes and elapsed >= budget_s) or (a.updates and update - update0 >= a.updates) or (a.decisions and total_decisions >= a.decisions):
            break
        if a.stop_win_rate and len(recent) == recent.maxlen and np.mean([e["win"] for e in recent]) >= a.stop_win_rate:
            print(f"stop: last {len(recent)} episodes at or above {a.stop_win_rate} wins", flush=True)
            break
        if a.decisions:
            frac = min(1.0, total_decisions / a.decisions)
        else:
            frac = min(1.0, elapsed / budget_s) if a.minutes else (update - update0) / max(1, a.updates)
        lr = a.lr + (a.lr_end - a.lr) * frac
        for pg in opt.param_groups:
            pg["lr"] = lr
        ent_coef = a.ent + (a.ent_end - a.ent) * frac
        mix = mix0 + (mix1 - mix0) * frac
        mix[1] = max(mix[1], 0.1)

        # ── rollout ──────────────────────────────────────────────────────────
        T = a.rollout
        if not (a.overfit and update > update0):  # overfit probe: train on the first rollout only
            store = defaultdict(list)
            rew = np.zeros((T, B, 3), dtype=np.float32)
            ended = np.zeros((T, B), dtype=bool)
            boot = np.zeros((T, B, 3), dtype=np.float32)
            t_roll = time.time()
            t_env = 0.0
            agent.eval()
            for t in range(T):
                obs = stack_obs([s.obs for s in cur], [statics[s.slot] for s in cur], [s.critic for s in cur])
                masks = stack_masks([s.masks for s in cur])
                if a.imitate:  # teachers carry their template's z; evaluation plays z = 0, so half the samples see 0
                    obs["z"][np.random.rand(B) < 0.5] = 0
                with torch.no_grad():
                    ot = to_t(obs, dev)
                    h, E, valid = agent.trunk(ot)
                    given = teacher_actions([s.teacher for s in cur], dev) if a.imitate else None
                    out, rows, lp, _ = agent.policy(h, E, valid, masks=to_t(masks, dev), given=given)
                    v = agent.values(h, ot["critic"])
                acts = [None] * B if a.imitate else wire_actions(out)
                store["obs"].append({k: (x.astype(np.float16) if k in ("grid", "ent") else x) for k, x in obs.items()})
                store["rows"].append({k: r.cpu().numpy() for k, r in rows.items()})
                store["act"].append({k: out[k].cpu().numpy() for k in HEADS})
                store["lp"].append(lp.cpu().numpy())
                store["v"].append(v.cpu().numpy())
                te = time.time()
                res = env.step(acts)
                t_env += time.time() - te
                total_decisions += B

                term_idx = []
                for j, tr in enumerate(res.transitions):
                    r = tr.reward
                    minutes = ep_steps[j] * S.DECISION_TICKS / S.TICKS_PER_MINUTE
                    sh = np.asarray([r["shaped"][k] for k in S.SHAPED_KEYS], dtype=np.float32)
                    rew[t, j] = (r["win"], float((sh * shaped_w).sum()) * 0.6 ** (minutes / 10), sh[0] + sh[1])
                    ep_ret[j] += rew[t, j]
                    ep_steps[j] += 1
                    e = int(store["act"][-1]["econ"][j])
                    if 1 <= e <= 5:
                        ep_train[j, e - 1] += 1
                    if tr.done or tr.truncated:
                        ended[t, j] = True
                        if tr.truncated:
                            term_idx.append(j)
                        info = tr.info
                        won = info["winner"] == tr.side
                        recent.append({"win": won, "loss": info["winner"] not in (None, tr.side), "trunc": tr.truncated,
                                       "winType": info.get("winType"), "ticks": info["ticks"],
                                       "opp": info["episode"]["red" if tr.side == "blue" else "blue"],
                                       "map": info["episode"]["map"], "side": tr.side, "ret": ep_ret[j].copy(),
                                       "train": ep_train[j].copy()})
                        ep_steps[j] = 0
                        ep_train[j] = 0
                        ep_ret[j] = 0
                if term_idx:  # truncation: bootstrap from the final observation (old episode's static grid)
                    tobs = stack_obs([res.transitions[j].terminal["obs"] for j in term_idx],
                                     [statics[res.transitions[j].slot] for j in term_idx],
                                     [res.transitions[j].terminal.get("critic") for j in term_idx])
                    with torch.no_grad():
                        ot = to_t(tobs, dev)
                        hb, _, _ = agent.trunk(ot)
                        boot[t, term_idx] = agent.values(hb, ot["critic"]).cpu().numpy()
                for i in res.new_episodes:
                    statics[i] = static_grid(env.static[i])
                    env.configure(i, **slots.draw())
                cur = res.current
            with torch.no_grad():
                obs = stack_obs([s.obs for s in cur], [statics[s.slot] for s in cur], [s.critic for s in cur])
                ot = to_t(obs, dev)
                last_v = agent.values(agent.trunk(ot)[0], ot["critic"]).cpu().numpy()
            roll_s = time.time() - t_roll

            # ── GAE per value head ───────────────────────────────────────────────
            vals = np.stack(store["v"])  # (T, B, 3)
            adv = np.zeros_like(vals)
            last = np.zeros((B, 3), dtype=np.float32)
            for t in reversed(range(T)):
                nxt = last_v if t == T - 1 else vals[t + 1]
                nxt = np.where(ended[t][:, None], boot[t], nxt)
                nonterm = (~ended[t])[:, None].astype(np.float32)
                delta = rew[t] + gamma * nxt - vals[t]
                last = delta + gamma * lam * nonterm * last
                adv[t] = last
            ret = adv + vals

            # ── flatten ──────────────────────────────────────────────────────────
            N = T * B
            flat = {}
            for k in store["obs"][0]:
                if k == "ent":
                    flat[k] = pad_entities([o[k] for o in store["obs"]])
                else:
                    flat[k] = np.concatenate([o[k] for o in store["obs"]])
            f_rows = {k: np.concatenate([r[k] for r in store["rows"]]) for k in store["rows"][0]}
            f_act = {k: np.concatenate([x[k] for x in store["act"]]) for k in HEADS}
            f_lp = np.concatenate(store["lp"])
            f_adv = adv.reshape(N, 3)
            f_ret = ret.reshape(N, 3)
            f_v = vals.reshape(N, 3)
            nadv = (f_adv - f_adv.mean(0)) / (f_adv.std(0) + 1e-8)
            mixed = (nadv * mix).sum(1)

        # ── PPO update ───────────────────────────────────────────────────────
        agent.train()
        t_upd = time.time()
        logs = defaultdict(list)
        mb = N // a.minibatches
        for _ in range(a.epochs):
            perm = np.random.permutation(N)
            for m in range(a.minibatches):
                idx = perm[m * mb:(m + 1) * mb]
                o = {k: torch.as_tensor(flat[k][idx], device=dev) for k in flat}
                o["grid"], o["ent"] = o["grid"].float(), o["ent"].float()
                n_used = int(o["ent_n"].max().clamp(min=1))
                o["ent"] = o["ent"][:, :n_used]
                rows_t = {k: torch.as_tensor(f_rows[k][idx], device=dev) for k in f_rows}
                act_t = {k: torch.as_tensor(f_act[k][idx], device=dev) for k in HEADS}
                h, E, valid = agent.trunk(o)
                head_lp = {}
                po, _, lp, ent = agent.policy(h, E, valid, rows=rows_t, given=act_t, head_lp=head_lp)
                v = agent.values(h, o["critic"])
                old_lp = torch.as_tensor(f_lp[idx], device=dev)
                ratio = (lp - old_lp).exp()
                if a.imitate:  # behaviour cloning: cross-entropy on the teacher's actions
                    pg = -lp.mean()
                else:
                    A = torch.as_tensor(mixed[idx], device=dev)
                    pg = -torch.min(ratio * A, ratio.clamp(1 - a.clip, 1 + a.clip) * A).mean()
                R = torch.as_tensor(f_ret[idx], device=dev)
                V0 = torch.as_tensor(f_v[idx], device=dev)
                vc = V0 + (v - V0).clamp(-a.clip, a.clip)
                vl = torch.max((v - R) ** 2, (vc - R) ** 2).mean(0)  # per head
                ent_total = sum(e.mean() for e in ent.values())
                loss = pg + a.vf * vl.sum() - (0.0 if a.imitate else ent_coef) * ent_total
                opt.zero_grad()
                loss.backward()
                gn = torch.nn.utils.clip_grad_norm_(agent.parameters(), a.max_grad)
                opt.step()
                if not torch.isfinite(loss):
                    raise RuntimeError(f"non-finite loss at update {update}")
                with torch.no_grad():
                    logs["loss/policy"].append(pg.item())
                    for i, k in enumerate(VALUE_HEADS):
                        logs[f"loss/value_{k}"].append(vl[i].item())
                    logs["loss/total"].append(loss.item())
                    logs["ppo/approx_kl"].append(((ratio - 1) - (lp - old_lp)).mean().item())
                    logs["ppo/clip_frac"].append(((ratio - 1).abs() > a.clip).float().mean().item())
                    logs["ppo/grad_norm"].append(gn.item())
                    for k, e in ent.items():
                        logs[f"entropy/{k}"].append(e.mean().item())
                    for k, l in head_lp.items():  # per-head cross-entropy over decisions where the head is active
                        logs[f"ce/{k}"].append((-l.sum() / po[k + "_on"].sum().clamp(min=1)).item())
        upd_s = time.time() - t_upd
        update += 1

        # ── logging ──────────────────────────────────────────────────────────
        step = total_decisions
        for k, vs in logs.items():
            writer.add_scalar(k, float(np.mean(vs)), step)
        for i, k in enumerate(VALUE_HEADS):
            var = f_ret[:, i].var()
            writer.add_scalar(f"value/explained_var_{k}", float(1 - (f_ret[:, i] - f_v[:, i]).var() / var) if var > 1e-8 else 0.0, step)
            writer.add_scalar(f"value/mean_return_{k}", float(f_ret[:, i].mean()), step)
            writer.add_scalar(f"reward/mean_{k}", float(rew[..., i].mean()), step)
        writer.add_scalar("noop/econ", float((f_act["econ"] == 0).mean()), step)
        writer.add_scalar("noop/army_group", float((f_act["group"] == 0).mean()), step)
        writer.add_scalar("perf/decisions_per_s", T * B / roll_s, step)
        writer.add_scalar("perf/env_share", t_env / roll_s, step)
        writer.add_scalar("perf/update_s", upd_s, step)
        writer.add_scalar("sched/lr", lr, step)
        writer.add_scalar("sched/ent_coef", ent_coef, step)
        writer.add_scalar("sched/mix_win", float(mix[0]), step)
        if recent:
            rc = list(recent)
            writer.add_scalar("episode/win_rate", np.mean([e["win"] for e in rc]), step)
            writer.add_scalar("episode/loss_rate", np.mean([e["loss"] for e in rc]), step)
            writer.add_scalar("episode/trunc_rate", np.mean([e["trunc"] for e in rc]), step)
            writer.add_scalar("episode/length_ticks", np.mean([e["ticks"] for e in rc]), step)
            for wt in ("combat", "control"):
                writer.add_scalar(f"episode/wintype_{wt}", np.mean([e["winType"] == wt for e in rc]), step)
            for i, k in enumerate(VALUE_HEADS):
                writer.add_scalar(f"episode/return_{k}", np.mean([e["ret"][i] for e in rc]), step)
            for i, u in enumerate(("worker", "skirmisher", "gunner", "bruiser", "medic")):
                writer.add_scalar(f"production/{u}", np.mean([e["train"][i] for e in rc]), step)
            for side in ("blue", "red"):
                sw = [e["win"] for e in rc if e["side"] == side]
                if sw:
                    writer.add_scalar(f"episode/win_rate_{side}", np.mean(sw), step)
            by_opp = defaultdict(list)
            for e in rc:
                by_opp[e["opp"]].append(e["win"])
            for o_, ws in by_opp.items():
                writer.add_scalar(f"win_rate/{o_.replace(':', '_')}", np.mean(ws), step)
        wr = np.mean([e["win"] for e in recent]) if recent else float("nan")
        print(f"update {update} decisions {total_decisions} | {T * B / roll_s:.0f} dec/s (env {t_env / roll_s:.0%}) "
              f"update {upd_s:.1f}s | loss {np.mean(logs['loss/total']):.4f} pg {np.mean(logs['loss/policy']):.4f} "
              f"kl {np.mean(logs['ppo/approx_kl']):.4f} | episodes {len(recent)} win {wr:.2f}", flush=True)
        if update % a.checkpoint_every == 0:
            torch.save({"model": agent.state_dict(), "opt": opt.state_dict(), "update": update, "decisions": total_decisions, "config": vars(a)}, ck_dir / f"update_{update}.pt")
    torch.save({"model": agent.state_dict(), "opt": opt.state_dict(), "update": update, "decisions": total_decisions, "config": vars(a)}, ck_dir / "final.pt")
    writer.close()
    env.close()
    print(f"done: {update - update0} updates, {total_decisions - decisions0} decisions, {time.time() - t_start:.0f}s", flush=True)


if __name__ == "__main__":
    main()
