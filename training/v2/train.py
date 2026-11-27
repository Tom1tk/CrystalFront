#!/usr/bin/env python3
"""
v2 PPO trainer (G-10 M1: recurrent PPO against scripted bots and frozen checkpoints).

One learner seat per slot. The other seat is a scripted bot (`idle`) or a frozen
checkpoint (`ckpt:<path>`, played by that network in Python). Each slot draws a
new training map, seed, side and opponent when its episode ends (applied by the
runner one episode later); with --pfsp, opponents the learner loses to are drawn
more often. Three value heads (win, shaped, aux) with their own γ/λ; advantages
normalised per head and mixed (ML_RETRAIN_IMPLEMENTATION.md §7.2). The network
is recurrent: rollouts carry an LSTM state per stream and updates replay
--seq-decision sequences from their stored start states. An opponent-model head
is trained on the enemy's true counts (supervised, --opp-coef).

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
from training.v2.model import HEADS, SCOUT_HEADS, Agent, load_weights, opp_targets, teacher_actions, wire_actions
from training.v2.r1 import RoaReward, upgo_returns

REPO = Path(__file__).resolve().parents[2]
VALUE_HEADS = ("win", "shaped", "aux")
ARMY_HEADS = ("group", "order", "unit", "target", "ptr")
DEFENCE_HEADS = ("group", "order", "unit", "target")
# Trained during --value-warmup (everything else, the policy's trunk and heads, is held still).
WARMUP_PREFIXES = ("value.", "critic.", "c_", "opp.")


def parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--procs", type=int, default=18)
    ap.add_argument("--slots", type=int, default=8, help="slots per process")
    ap.add_argument("--rollout", type=int, default=128)
    ap.add_argument("--minutes", type=float, default=5.0, help="wall-clock budget (0 = none)")
    ap.add_argument("--decisions", type=int, default=0, help="decision budget; schedules then run on decisions, not time (resume continues the count)")
    ap.add_argument("--stop-decisions", type=int, default=0, help="stop at this many total decisions, while the schedules still run over --decisions (league cycles resume a run in pieces)")
    ap.add_argument("--stop-win-rate", type=float, default=0.0, help="stop when the last 200 episodes reach this win rate (a trigger for a fixed-seed evaluation, not a result)")
    ap.add_argument("--updates", type=int, default=0, help="stop after this many updates (0 = time budget only)")
    ap.add_argument("--opponents", default="idle", help="comma-separated scripted bots and/or ckpt:<checkpoint path> (frozen networks)")
    ap.add_argument("--pfsp", action="store_true", help="draw opponents by (1 - recent win rate)^2, floored at 0.1 (AlphaStar's prioritised sampling)")
    ap.add_argument("--seq", type=int, default=32, help="LSTM training sequence length in decisions (divides --rollout)")
    ap.add_argument("--opp-coef", type=float, default=0.5, help="weight of the opponent-model loss")
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
    ap.add_argument("--init", default="", help="start from these model weights (fresh optimiser and counters); with --kl-coef, also the frozen reference policy")
    ap.add_argument("--kl-coef", type=float, default=0.0, help="KL penalty toward the --init policy (k3 estimator on the taken actions)")
    ap.add_argument("--kl-anneal", type=float, default=0.5, help="fraction of the budget over which --kl-coef anneals linearly to 0")
    ap.add_argument("--scout-teacher", action="store_true", help="distil the scripted Outrider (scout.ts, careful) through the scout slot: cross-entropy on its slot order every decision (none = keep going)")
    ap.add_argument("--scout-coef", type=float, default=1.0, help="weight of the scout distillation loss at the start (averaged over all decisions)")
    ap.add_argument("--scout-coef-end", type=float, default=0.1, help="... at the end of the budget (linear)")
    ap.add_argument("--intel-w", type=float, default=0.0, help="weight of the first-sighting reward (shaped.intel, runner.ts) at the start")
    ap.add_argument("--intel-anneal", type=float, default=0.5, help="fraction of the budget over which --intel-w anneals linearly to 0")
    # Rebuild R1 S7 (docs/REBUILD_R1_PLAN.md); all off by default.
    ap.add_argument("--value-warmup", type=int, default=0, help="for the first N updates train only the value, critic and opponent-model losses (policy held still)")
    ap.add_argument("--upgo-coef", type=float, default=0.0, help="weight of the UPGO policy loss (AlphaStar; per value head, mixed like the PPO advantage)")
    ap.add_argument("--switch-w", type=float, default=0.0, help="cost per order switch (shaped.switch, runner.ts) on the shaped head, own seat only (v4)")
    ap.add_argument("--scout-lock", type=int, default=1, choices=(0, 1), help="the scout slot's 50-tick commitment (v4: 0 turns it off)")
    ap.add_argument("--scout-reward", default="none", choices=("none", "roa"), help="roa: reward new lows of the reference model's opponent-model cross-entropy (30 s window, near-base groups x3)")
    ap.add_argument("--scout-w", type=float, default=0.0, help="weight of the --scout-reward at the start (shaped head)")
    ap.add_argument("--scout-anneal", type=float, default=0.5, help="fraction of the budget over which --scout-w anneals linearly to 0")
    ap.add_argument("--defence-teacher", action="store_true", help="cross-entropy on the scripted defence order (defence.ts) while a defence rule holds (v4)")
    ap.add_argument("--defence-coef", type=float, default=0.5, help="weight of the defence teacher loss at the start")
    ap.add_argument("--defence-coef-end", type=float, default=0.05, help="... at the end of the budget (linear)")
    # Rebuild R1 S10: scenario starts (runner.ts Scenario; built by training/v2/scenarios.py).
    ap.add_argument("--scenarios", default="", help="scenario index (training/v2/scenarios.py): with --scenario-frac, some episodes start at a lost game's handover tick")
    ap.add_argument("--scenario-frac", type=float, default=0.25, help="share of episodes drawn from --scenarios (opponent by the PFSP weight, then a uniform scenario of it)")
    ap.add_argument("--imitate", action="store_true", help="behaviour cloning: both seats are teach:<bot> from --opponents; policy heads learn the teacher's actions (cross-entropy), value heads the returns")
    ap.add_argument("--overfit", action="store_true", help="with --imitate: collect one rollout and train on it repeatedly (overfit probe: loss < 0.05)")
    a = ap.parse_args()
    if (a.switch_w > 0 or a.defence_teacher or not a.scout_lock) and S.LAYOUT != "v4":
        raise SystemExit("--switch-w, --defence-teacher and --scout-lock 0 need CF_LAYOUT=v4")
    if a.scenarios and (a.imitate or S.LAYOUT != "v4"):
        raise SystemExit("--scenarios needs CF_LAYOUT=v4 and no --imitate")
    if a.scout_reward == "roa" and not a.init:
        raise SystemExit("--scout-reward roa needs --init (the frozen reference model)")
    for maps in a.maps.split(","):
        if maps in S.HELD_OUT_MAPS:
            raise SystemExit(f"{maps} is a held-out map and must not be used for training")
    return a


def floats(s: str) -> np.ndarray:
    return np.asarray([float(x) for x in s.split(",")], dtype=np.float32)


def to_t(o: dict[str, np.ndarray], dev) -> dict[str, torch.Tensor]:
    return {k: torch.as_tensor(v, device=dev) for k, v in o.items()}


def opp_tag(o: str) -> str:
    """Short opponent name for logs: bot name, or <run>/<file> for a checkpoint."""
    if o.startswith("ckpt:"):
        p = Path(o[5:])
        return f"{p.parent.name}/{p.stem}"
    return o


class Slots:
    """Per-slot episode config draws. With `pfsp`, opponents are weighted by (1 - p)^2 (floor 0.1),
    p = the learner's win rate over its last 50 games against them (0.5 until 10 games).
    With --scenarios, a --scenario-frac share of draws are scenario starts: the opponent by the same weight
    (uniform without --pfsp), then one of its scenarios uniformly; their results are kept apart
    (`scenario:<opp>`) and do not count towards the PFSP win rates."""

    def __init__(self, a: argparse.Namespace, rng: random.Random):
        self.maps, self.opps, self.rng = a.maps.split(","), a.opponents.split(","), rng
        self.imitate, self.pfsp = a.imitate, a.pfsp
        self.hist = {o: deque(maxlen=50) for o in self.opps}
        self.scen: dict[str, list[dict]] = defaultdict(list)
        if a.scenarios:
            for sc in json.load(open(a.scenarios))["scenarios"]:
                self.scen[sc["opp"]].append(sc)
            print(f"scenarios: {sum(map(len, self.scen.values()))} from {a.scenarios} ({', '.join(f'{o} {len(v)}' for o, v in sorted(self.scen.items()))}), "
                  f"{a.scenario_frac:.0%} of episodes", flush=True)
        self.scenario_frac = a.scenario_frac
        assert not (self.imitate and any(o.startswith("ckpt:") for o in self.opps)), "imitation needs scripted teachers"

    def record(self, opp: str, won: bool) -> None:
        if opp in self.hist:
            self.hist[opp].append(float(won))

    def win_rate(self, o: str) -> float:
        h = self.hist[o]
        return float(np.mean(h)) if len(h) >= 10 else 0.5

    def weight(self, o: str) -> float:
        return max((1 - (self.win_rate(o) if o in self.hist else 0.5)) ** 2, 0.1)

    def weights(self) -> list[float]:
        return [self.weight(o) for o in self.opps]

    def draw(self) -> dict:
        """Returns the slot config, plus the Python-side key `opp` (the opponent's name in --opponents)."""
        if self.imitate:  # scripted v scripted, both seats teaching
            return {"seed": self.rng.randrange(1 << 30), "map": self.rng.choice(self.maps),
                    "blue": f"teach:{self.rng.choice(self.opps)}", "red": f"teach:{self.rng.choice(self.opps)}", "opp": "teach"}
        if self.scen and self.rng.random() < self.scenario_frac:
            so = sorted(self.scen)
            o = self.rng.choices(so, weights=[self.weight(x) for x in so])[0] if self.pfsp else self.rng.choice(so)
            sc = self.rng.choice(self.scen[o])
            return {k: sc[k] for k in ("seed", "map", "blue", "red", "learner", "scenario")} | {"opp": f"scenario:{o}"}
        learner = "blue" if self.rng.random() < 0.5 else "red"
        o = self.rng.choices(self.opps, weights=self.weights())[0] if self.pfsp else self.rng.choice(self.opps)
        cfg = {"seed": self.rng.randrange(1 << 30), "map": self.rng.choice(self.maps), "opp": o}
        if self.scen:
            cfg["scenario"] = None  # slot settings persist across episodes
        if o.startswith("ckpt:"):  # both seats are networks; only the learner's seat trains
            cfg.update(blue="policy", red="policy", learner=[learner])
        else:
            other = "red" if learner == "blue" else "blue"
            cfg.update({learner: "policy", other: f"bot:{o}", "learner": [learner]})
        return cfg


class Frozen:
    """Frozen checkpoint opponents: one network per path, LSTM state per slot."""

    def __init__(self, paths: list[str], n_slots: int, dev):
        self.dev, self.nets = dev, {}
        for p in paths:
            net = Agent().to(dev)
            load_weights(net, torch.load(p, map_location=dev)["model"])
            net.eval()
            self.nets[p] = net
        d = Agent().lstm.hidden_size
        self.h = torch.zeros(n_slots, d, device=dev)
        self.c = torch.zeros(n_slots, d, device=dev)

    def reset(self, slot: int) -> None:
        self.h[slot] = 0
        self.c[slot] = 0

    @torch.no_grad()
    def act(self, streams, statics, path_of_slot) -> dict[int, dict]:
        """streams: list of (stream index, Stream) for frozen seats → {stream index: wire action}."""
        acts = {}
        by = defaultdict(list)
        for j, s in streams:
            by[path_of_slot[s.slot]].append((j, s))
        for path, group in by.items():
            net = self.nets[path]
            ss = [s for _, s in group]
            sl = torch.as_tensor([s.slot for s in ss], device=self.dev)
            obs = stack_obs([s.obs for s in ss], [statics[s.slot] for s in ss], [None] * len(ss))
            h, E, valid, (hs, cs), _ = net.trunk(to_t(obs, self.dev), (self.h[sl], self.c[sl]))
            out, _, _, _ = net.policy(h, E, valid, masks=to_t(stack_masks([s.masks for s in ss]), self.dev))
            self.h[sl], self.c[sl] = hs, cs
            for (j, _), w in zip(group, wire_actions(out)):
                acts[j] = w
        return acts


def main() -> None:
    a = parse()
    rng = random.Random(a.seed)
    torch.manual_seed(a.seed)
    np.random.seed(a.seed)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    gamma, lam = floats(a.gamma), floats(a.lam)
    mix0, mix1 = floats(a.mix_start), floats(a.mix_end)
    shaped_w = floats(a.shaped_w)
    assert a.rollout % a.seq == 0, "--seq must divide --rollout"

    run_dir = REPO / "runs" / a.run
    ck_dir = REPO / "checkpoints" / "v2" / a.run
    ck_dir.mkdir(parents=True, exist_ok=True)
    writer = SummaryWriter(str(run_dir))
    (ck_dir / "config.json").write_text(json.dumps(vars(a), indent=2))

    agent = Agent().to(dev)
    opt = torch.optim.Adam(agent.parameters(), lr=a.lr, eps=1e-5)
    update0, decisions0 = 0, 0
    ref = None
    if a.init:
        load_weights(agent, torch.load(a.init, map_location=dev)["model"])
        if a.kl_coef > 0 or a.scout_reward == "roa":
            ref = Agent().to(dev)
            ref.load_state_dict(agent.state_dict())
            ref.eval()
            for p_ in ref.parameters():
                p_.requires_grad_(False)
    if a.resume:
        ck = torch.load(a.resume, map_location=dev)
        agent.load_state_dict(ck["model"])
        opt.load_state_dict(ck["opt"])
        update0 = ck["update"]
        decisions0 = ck.get("decisions", 0)
    print(f"params: {sum(p.numel() for p in agent.parameters()) / 1e6:.2f} M, device {dev}", flush=True)

    slots = Slots(a, rng)
    n_slots = a.procs * a.slots
    draws = [slots.draw() for _ in range(n_slots)]
    cur_opp = [d.pop("opp") for d in draws]           # opponent of each slot's current episode
    pending_opp: list[str | None] = [None] * n_slots  # ... of its next episode (configured, not started)
    frozen = Frozen([o[5:] for o in slots.opps if o.startswith("ckpt:")], n_slots, dev)
    env = VecEnvV2(draws, n_procs=a.procs, max_ticks=a.max_ticks, packed=True, scout_teacher=a.scout_teacher,
                   scout_lock=bool(a.scout_lock), switch_cost=a.switch_w > 0, defence_teacher=a.defence_teacher)
    cur = env.reset()
    S.check_layout(env.layout)
    statics = [static_grid(s) for s in env.static]
    want = "teach" if a.imitate else "learner"
    lrn = [j for j, s in enumerate(cur) if s.role == want]
    B = len(lrn)
    assert B == n_slots * (2 if a.imitate else 1), f"unexpected streams for this mode (want {want})"
    row_key = [(cur[j].slot, a.imitate and cur[j].side) for j in lrn]  # buffer row b ↔ slot (and side when imitating)
    b_of_slot = defaultdict(list)  # learner buffer rows of each slot (stable: one per slot, or two when imitating)
    for b, j in enumerate(lrn):
        b_of_slot[cur[j].slot].append(b)
    ep_steps = np.zeros(B, dtype=np.int64)
    ep_train = np.zeros((B, S.ECON_BUILD0 - 1), dtype=np.int64)
    ep_ret = np.zeros((B, 3))
    hc = agent.zero_state(B, dev)
    hc_ref = agent.zero_state(B, dev)
    first = np.ones(B, dtype=bool)  # the next observation starts an episode
    roa = RoaReward(B)

    recent = deque(maxlen=200)
    t_start = time.time()
    update = update0
    total_decisions = decisions0
    budget_s = a.minutes * 60
    while True:
        elapsed = time.time() - t_start
        if (a.minutes and elapsed >= budget_s) or (a.updates and update - update0 >= a.updates) or (a.decisions and total_decisions >= a.decisions) \
                or (a.stop_decisions and total_decisions >= a.stop_decisions):
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
        kl_coef = a.kl_coef * max(0.0, 1.0 - frac / a.kl_anneal) if a.kl_coef > 0 and ref is not None else 0.0
        scout_coef = a.scout_coef + (a.scout_coef_end - a.scout_coef) * frac
        intel_w = a.intel_w * max(0.0, 1.0 - frac / a.intel_anneal) if a.intel_anneal > 0 else 0.0
        scout_w = a.scout_w * max(0.0, 1.0 - frac / a.scout_anneal) if a.scout_reward == "roa" and a.scout_anneal > 0 else 0.0
        defence_coef = a.defence_coef + (a.defence_coef_end - a.defence_coef) * frac
        warm = update < a.value_warmup  # update counts from 0 with --init, so each cycle warms up its fresh critic

        # ── rollout ──────────────────────────────────────────────────────────
        T, L = a.rollout, a.seq
        if not (a.overfit and update > update0):  # overfit probe: train on the first rollout only
            store = defaultdict(list)
            rew = np.zeros((T, B, 3), dtype=np.float32)
            ended = np.zeros((T, B), dtype=bool)
            firsts = np.zeros((T, B), dtype=bool)
            boot = np.zeros((T, B, 3), dtype=np.float32)
            t_roll = time.time()
            t_env = 0.0
            agent.eval()
            for t in range(T):
                ls = [cur[j] for j in lrn]
                obs = stack_obs([s.obs for s in ls], [statics[s.slot] for s in ls], [s.critic for s in ls])
                masks = stack_masks([s.masks for s in ls])
                opp_t = opp_targets([s.opp_labels for s in ls])
                if a.imitate:  # teachers carry their template's z; evaluation plays z = 0, so half the samples see 0
                    obs["z"][np.random.rand(B) < 0.5] = 0
                firsts[t] = first
                keep = torch.as_tensor(~first, device=dev).float().unsqueeze(1)
                hc = (hc[0] * keep, hc[1] * keep)
                hc_ref = (hc_ref[0] * keep, hc_ref[1] * keep)
                if t % L == 0:
                    store["h0"].append(hc[0].cpu().numpy())
                    store["c0"].append(hc[1].cpu().numpy())
                with torch.no_grad():
                    ot = to_t(obs, dev)
                    h, E, valid, hc, _ = agent.trunk(ot, hc)
                    given = teacher_actions([s.teacher for s in ls], dev) if a.imitate else None
                    out, rows, lp, _ = agent.policy(h, E, valid, masks=to_t(masks, dev), given=given)
                    v = agent.values(h, ot)
                    if ref is not None:  # the KL leaves out the scout slot, which the reference never had
                        hr, Er, vr, hc_ref, ropp = ref.trunk(ot, hc_ref)
                        rh = {}
                        rlp = ref.policy(hr, Er, vr, rows=rows, given=out, head_lp=rh)[2]
                        store["ref_lp"].append((rlp - sum(rh.get(k, 0) for k in SCOUT_HEADS)).cpu().numpy())
                        if a.defence_teacher:  # army heads, left out of the KL where the defence label applies
                            store["ref_army"].append(sum(rh[k] for k in ARMY_HEADS).cpu().numpy())
                        if a.scout_reward == "roa":  # H_t: the reference's opponent-model cross-entropy on the true labels
                            H = ref.opp_ce(ropp, torch.as_tensor(opp_t, device=dev)).cpu().numpy()
                            store["roa"].append(roa.step(H, firsts[t]))
                            store["roa_H"].append(H)
                if a.scout_teacher:  # the scripted Outrider's slot order, with its mask rows (illegal labels → none)
                    lab = np.asarray([s.scout_teacher or [0, S.TARGET_NONE, 0] for s in ls], dtype=np.int64)
                    ar_ = np.arange(B)
                    so = lab[:, 0]
                    is_pt, is_pr = np.isin(so, S.POINT_ORDERS), np.isin(so, S.PTR_ORDERS)
                    ok = masks["scoutOrder"][ar_, so].astype(bool)
                    ok &= ~is_pt | masks["target"][ar_, so, lab[:, 1]].astype(bool)
                    ok &= ~is_pr | masks["ptr"][ar_, so, lab[:, 2]].astype(bool)
                    lab[~ok] = (0, S.TARGET_NONE, 0)
                    store["s_lab"].append(lab)
                    store["s_bad"].append(~ok)
                    store["s_rows"].append({"scoutOrder": masks["scoutOrder"], "scoutTarget": masks["target"][ar_, lab[:, 0]],
                                            "scoutPtr": masks["ptr"][ar_, lab[:, 0]]})
                if a.defence_teacher:  # the scripted defence order while a rule holds; elsewhere the taken action (unused)
                    ar_ = np.arange(B)
                    tk = {k: out[k].cpu().numpy() for k in DEFENCE_HEADS}
                    lab = np.stack([tk[k] for k in DEFENCE_HEADS], 1).astype(np.int64)
                    don = np.zeros(B, dtype=bool)
                    for b_, s in enumerate(ls):
                        if s.defence_teacher:
                            lab[b_] = s.defence_teacher
                            don[b_] = True
                    g_, o_, u_, t_ = lab.T
                    ok = masks["group"][ar_, g_].astype(bool) & masks["order"][ar_, g_, o_].astype(bool)
                    ok &= (g_ != S.GROUP_UNIT) | masks["unit"][ar_, o_, u_].astype(bool)
                    ok &= ~np.isin(o_, S.POINT_ORDERS) | masks["target"][ar_, o_, t_].astype(bool)
                    bad = don & ~ok
                    don &= ok
                    lab[~don] = np.stack([tk[k] for k in DEFENCE_HEADS], 1)[~don]
                    rows_np = {k: rows[k].cpu().numpy() for k in DEFENCE_HEADS}
                    m_rows = {"group": masks["group"], "order": masks["order"][ar_, lab[:, 0]], "unit": masks["unit"][ar_, lab[:, 1]],
                              "target": masks["target"][ar_, lab[:, 1]]}
                    store["d_lab"].append(lab)
                    store["d_on"].append(don)
                    store["d_bad"].append(bad)
                    store["d_rows"].append({k: np.where(don.reshape(-1, *[1] * (m_rows[k].ndim - 1)), m_rows[k], rows_np[k]) for k in DEFENCE_HEADS})
                acts = [None] * len(cur)
                if not a.imitate:
                    for j, w in zip(lrn, wire_actions(out)):
                        acts[j] = w
                    fz = [(j, s) for j, s in enumerate(cur) if s.role == "frozen"]
                    if fz:
                        for j, w in frozen.act(fz, statics, [o[5:] if o.startswith("ckpt:") else None for o in cur_opp]).items():
                            acts[j] = w
                store["obs"].append({k: (x.astype(np.float16) if k in ("grid", "ent", "c_grid", "c_ent") else x) for k, x in obs.items()})
                store["opp"].append(opp_t)
                store["rows"].append({k: r.cpu().numpy() for k, r in rows.items()})
                store["act"].append({k: out[k].cpu().numpy() for k in HEADS})
                store["lp"].append(lp.cpu().numpy())
                store["v"].append(v.cpu().numpy())
                te = time.time()
                res = env.step(acts)
                t_env += time.time() - te
                total_decisions += B

                term_idx = []
                trs = [res.transitions[j] for j in lrn]
                for j, tr in enumerate(trs):
                    r = tr.reward
                    minutes = ep_steps[j] * S.DECISION_TICKS / S.TICKS_PER_MINUTE
                    sh = np.asarray([r["shaped"][k] for k in S.SHAPED_KEYS], dtype=np.float32)
                    shaped_r = float((sh * shaped_w).sum()) * 0.6 ** (minutes / 10) + intel_w * r["shaped"].get("intel", 0.0)
                    shaped_r -= a.switch_w * r["shaped"].get("switch", 0.0)
                    if a.switch_w > 0:
                        store["switch"].append(r["shaped"].get("switch", 0.0))
                    if scout_w:
                        shaped_r += scout_w * float(store["roa"][-1][j])
                    rew[t, j] = (r["win"], shaped_r, sh[0] + sh[1])
                    ep_ret[j] += rew[t, j]
                    ep_steps[j] += 1
                    e = int(store["act"][-1]["econ"][j])
                    if 1 <= e < S.ECON_BUILD0:  # train worker … bulwark (… outrider in v3)
                        ep_train[j, e - 1] += 1
                    if tr.done or tr.truncated:
                        ended[t, j] = True
                        if tr.truncated:
                            term_idx.append(j)
                        info = tr.info
                        won = info["winner"] == tr.side
                        opp = cur_opp[tr.slot] if not a.imitate else info["episode"]["red" if tr.side == "blue" else "blue"]
                        slots.record(opp, won)
                        recent.append({"win": won, "loss": info["winner"] not in (None, tr.side), "trunc": tr.truncated,
                                       "winType": info.get("winType"), "ticks": info["ticks"], "opp": opp_tag(opp),
                                       "map": info["episode"]["map"], "side": tr.side, "ret": ep_ret[j].copy(),
                                       "train": ep_train[j].copy()})
                        ep_steps[j] = 0
                        ep_train[j] = 0
                        ep_ret[j] = 0
                if term_idx:  # truncation: bootstrap from the final observation (old episode's static grid and memory)
                    tobs = stack_obs([trs[j].terminal["obs"] for j in term_idx],
                                     [statics[trs[j].slot] for j in term_idx],
                                     [trs[j].terminal.get("critic") for j in term_idx])
                    ti = torch.as_tensor(term_idx, device=dev)
                    with torch.no_grad():
                        ot = to_t(tobs, dev)
                        hb, _, _, _, _ = agent.trunk(ot, (hc[0][ti], hc[1][ti]))
                        boot[t, term_idx] = agent.values(hb, ot).cpu().numpy()
                first[:] = False
                for i in res.new_episodes:
                    statics[i] = static_grid(env.static[i])
                    for b in b_of_slot[i]:
                        first[b] = True
                    frozen.reset(i)
                    if pending_opp[i] is not None:
                        cur_opp[i] = pending_opp[i]
                    d = slots.draw()
                    pending_opp[i] = d.pop("opp")
                    env.configure(i, **d)
                cur = res.current
                lrn = [j for j, s in enumerate(cur) if s.role == want]
                assert [(cur[j].slot, a.imitate and cur[j].side) for j in lrn] == row_key, "learner stream layout changed"
            with torch.no_grad():
                ls = [cur[j] for j in lrn]
                obs = stack_obs([s.obs for s in ls], [statics[s.slot] for s in ls], [s.critic for s in ls])
                ot = to_t(obs, dev)
                keep = torch.as_tensor(~first, device=dev).float().unsqueeze(1)
                hl, _, _, _, _ = agent.trunk(ot, (hc[0] * keep, hc[1] * keep))
                last_v = agent.values(hl, ot).cpu().numpy()
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
            if a.upgo_coef > 0:
                up = upgo_returns(rew, vals, ended, boot, last_v, gamma) - vals
                f_up = up.reshape(T * B, 3)
                upgo_mixed = (((f_up - f_up.mean(0)) / (f_up.std(0) + 1e-8)) * mix).sum(1)

            # ── flatten (time-major: row t * B + b) ──────────────────────────────
            N = T * B
            flat = {}
            for k in store["obs"][0]:
                if k in ("ent", "c_ent"):
                    flat[k] = pad_entities([o[k] for o in store["obs"]])
                else:
                    flat[k] = np.concatenate([o[k] for o in store["obs"]])
            f_rows = {k: np.concatenate([r[k] for r in store["rows"]]) for k in store["rows"][0]}
            f_act = {k: np.concatenate([x[k] for x in store["act"]]) for k in HEADS}
            f_lp = np.concatenate(store["lp"])
            f_ref = np.concatenate(store["ref_lp"]) if ref is not None else None
            if a.scout_teacher:
                s_lab = np.concatenate(store["s_lab"])
                s_rows = {k: np.concatenate([r[k] for r in store["s_rows"]]) for k in SCOUT_HEADS}
                s_bad = np.concatenate(store["s_bad"])
            if a.defence_teacher:
                d_lab, d_on, d_bad = np.concatenate(store["d_lab"]), np.concatenate(store["d_on"]), np.concatenate(store["d_bad"])
                d_rows = {k: np.concatenate([r[k] for r in store["d_rows"]]) for k in DEFENCE_HEADS}
                f_ref_army = np.concatenate(store["ref_army"]) if ref is not None else None
            f_opp = np.concatenate(store["opp"])
            f_first = firsts.reshape(N)
            h0, c0 = np.stack(store["h0"]), np.stack(store["c0"])  # (T / L, B, d)
            f_adv = adv.reshape(N, 3)
            f_ret = ret.reshape(N, 3)
            f_v = vals.reshape(N, 3)
            nadv = (f_adv - f_adv.mean(0)) / (f_adv.std(0) + 1e-8)
            mixed = (nadv * mix).sum(1)

        # ── PPO update over sequences (chunk c, stream b) ────────────────────
        agent.train()
        t_upd = time.time()
        logs = defaultdict(list)
        n_seq = (T // L) * B
        mb = n_seq // a.minibatches
        for _ in range(a.epochs):
            perm = np.random.permutation(n_seq)
            for m in range(a.minibatches):
                sq = perm[m * mb:(m + 1) * mb]
                ch, bb = sq // B, sq % B
                idx = (((ch * L)[None, :] + np.arange(L)[:, None]) * B + bb[None, :]).reshape(-1)  # time-major
                o = {k: torch.as_tensor(flat[k][idx], device=dev) for k in flat}
                o["grid"], o["ent"] = o["grid"].float(), o["ent"].float()
                n_used = int(o["ent_n"].max().clamp(min=1))
                o["ent"] = o["ent"][:, :n_used]
                if "c_ent" in o:  # full critic (v4)
                    o["c_grid"], o["c_ent"] = o["c_grid"].float(), o["c_ent"].float()[:, :int(o["c_ent_n"].max().clamp(min=1))]
                rows_t = {k: torch.as_tensor(f_rows[k][idx], device=dev) for k in f_rows}
                act_t = {k: torch.as_tensor(f_act[k][idx], device=dev) for k in HEADS}
                st = (torch.as_tensor(h0[ch, bb], device=dev), torch.as_tensor(c0[ch, bb], device=dev))
                h, E, valid, opp_logits = agent.trunk_seq(o, st, torch.as_tensor(f_first[idx], device=dev), L)
                head_lp = {}
                po, _, lp, ent = agent.policy(h, E, valid, rows=rows_t, given=act_t, head_lp=head_lp)
                v = agent.values(h, o)
                old_lp = torch.as_tensor(f_lp[idx], device=dev)
                ratio = (lp - old_lp).exp()
                if a.imitate:  # behaviour cloning: cross-entropy on the teacher's actions
                    pg = -lp.mean()
                else:
                    A = torch.as_tensor(mixed[idx], device=dev)
                    pg = -torch.min(ratio * A, ratio.clamp(1 - a.clip, 1 + a.clip) * A).mean()
                    if a.upgo_coef > 0:  # UPGO: −c · min(ratio, 1) · A^U · log π (ratio not differentiated)
                        upgo = -(ratio.detach().clamp(max=1.0) * torch.as_tensor(upgo_mixed[idx], device=dev) * lp).mean()
                        logs["loss/upgo"].append(upgo.item())
                        pg = pg + a.upgo_coef * upgo
                if warm:
                    pg = pg * 0.0
                R = torch.as_tensor(f_ret[idx], device=dev)
                V0 = torch.as_tensor(f_v[idx], device=dev)
                vc = V0 + (v - V0).clamp(-a.clip, a.clip)
                vl = torch.max((v - R) ** 2, (vc - R) ** 2).mean(0)  # per head
                ent_total = sum(e.mean() for e in ent.values())
                ol = agent.opp_loss(opp_logits, torch.as_tensor(f_opp[idx], device=dev))
                loss = pg + a.vf * vl.sum() - (0.0 if a.imitate or warm else ent_coef) * ent_total + a.opp_coef * ol
                if a.kl_coef > 0 and ref is not None:  # k3 estimator of KL(policy || reference) on the taken actions, scout slot left out
                    lp_ns = lp - sum(head_lp[k] for k in SCOUT_HEADS)
                    rlp_ = torch.as_tensor(f_ref[idx], device=dev)
                    if a.defence_teacher:  # ... and the army heads where the defence label applies
                        don_t = torch.as_tensor(d_on[idx], device=dev).float()
                        lp_ns = lp_ns - don_t * sum(head_lp[k] for k in ARMY_HEADS)
                        rlp_ = rlp_ - don_t * torch.as_tensor(f_ref_army[idx], device=dev)
                    logr = (rlp_ - lp_ns).clamp(max=20.0)
                    kl_ref = (logr.exp() - 1 - logr).mean()
                    loss = loss + kl_coef * kl_ref
                    logs["kl/ref"].append(kl_ref.item())
                if a.defence_teacher and not warm:  # cross-entropy on the scripted defence order, where it applies
                    dlp = {}
                    lab = torch.as_tensor(d_lab[idx], device=dev)
                    agent.policy(h, E, valid, rows={**rows_t, **{k: torch.as_tensor(d_rows[k][idx], device=dev) for k in DEFENCE_HEADS}},
                                 given={**act_t, **{k: lab[:, i] for i, k in enumerate(DEFENCE_HEADS)}}, head_lp=dlp)
                    don_t = torch.as_tensor(d_on[idx], device=dev).float()
                    d_ce = -(sum(dlp[k] for k in DEFENCE_HEADS) * don_t).sum() / don_t.sum().clamp(min=1)
                    loss = loss + defence_coef * d_ce
                    logs["defence/ce"].append(d_ce.item())
                if a.scout_teacher and not warm:  # scout distillation: cross-entropy on the scripted Outrider's slot order, every decision
                    tlp = {}
                    lab = torch.as_tensor(s_lab[idx], device=dev)
                    agent.policy(h, E, valid, rows={**rows_t, **{k: torch.as_tensor(s_rows[k][idx], device=dev) for k in SCOUT_HEADS}},
                                 given={**act_t, "scoutOrder": lab[:, 0], "scoutTarget": lab[:, 1], "scoutPtr": lab[:, 2]}, head_lp=tlp)
                    s_lp = sum(tlp[k] for k in SCOUT_HEADS)
                    scout_ce = -s_lp.mean()
                    loss = loss + scout_coef * scout_ce
                    logs["scout/ce"].append(scout_ce.item())
                    act_ = lab[:, 0] > 0
                    logs["scout/ce_orders"].append((-(s_lp * act_).sum() / act_.sum().clamp(min=1)).item())
                opt.zero_grad()
                loss.backward()
                if warm:  # value warm-up: only the value, critic and opponent-model parameters move
                    for n_, p_ in agent.named_parameters():
                        if not n_.startswith(WARMUP_PREFIXES):
                            p_.grad = None
                gn = torch.nn.utils.clip_grad_norm_(agent.parameters(), a.max_grad)
                opt.step()
                if not torch.isfinite(loss):
                    raise RuntimeError(f"non-finite loss at update {update}")
                with torch.no_grad():
                    logs["loss/policy"].append(pg.item())
                    logs["loss/opp_model"].append(ol.item())
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
        writer.add_scalar("scout/policy_rate", float((f_act["scoutOrder"] > 0).mean()), step)
        writer.add_scalar("reward/intel_w", intel_w, step)
        writer.add_scalar("sched/value_warmup", float(warm), step)
        if a.scout_reward == "roa":
            writer.add_scalar("reward/scout_w", scout_w, step)
            writer.add_scalar("scout/roa_reward", float(np.mean(store["roa"])), step)
            writer.add_scalar("scout/roa_H", float(np.mean(store["roa_H"])), step)
        if a.switch_w > 0:
            writer.add_scalar("reward/switch_per_decision", float(np.mean(store["switch"])) if store["switch"] else 0.0, step)
        if a.defence_teacher:
            writer.add_scalar("defence/label_rate", float(d_on.mean()), step)
            writer.add_scalar("defence/label_illegal", float(d_bad.mean()), step)
            writer.add_scalar("defence/follow", float((d_on & (f_act["group"] == d_lab[:, 0]) & (f_act["order"] == d_lab[:, 1])).sum() / max(1, d_on.sum())), step)
            writer.add_scalar("sched/defence_coef", defence_coef, step)
        if a.scout_teacher:
            writer.add_scalar("scout/teacher_rate", float((s_lab[:, 0] > 0).mean()), step)
            writer.add_scalar("scout/teacher_illegal", float(s_bad.mean()), step)
            writer.add_scalar("sched/scout_coef", scout_coef, step)
        writer.add_scalar("perf/decisions_per_s", T * B / roll_s, step)
        writer.add_scalar("perf/env_share", t_env / roll_s, step)
        writer.add_scalar("perf/update_s", upd_s, step)
        writer.add_scalar("sched/lr", lr, step)
        writer.add_scalar("sched/ent_coef", ent_coef, step)
        writer.add_scalar("sched/mix_win", float(mix[0]), step)
        writer.add_scalar("sched/kl_coef", kl_coef, step)
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
            for i, u in enumerate(("worker", "skirmisher", "gunner", "bruiser", "medic", "bulwark", "outrider")[:S.ECON_BUILD0 - 1]):
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
            if a.pfsp:
                for o_, w_ in zip(slots.opps, slots.weights()):
                    writer.add_scalar(f"pfsp/weight_{opp_tag(o_).replace(':', '_')}", w_, step)
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
