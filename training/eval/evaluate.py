#!/usr/bin/env python3
"""
v2 evaluation harness (ML_RETRAIN_IMPLEMENTATION.md §8).

Plays a checkpoint (or a scripted bot, for oracle checks) against each opponent
on each map, once per seed from both seats, and reports win / loss / draw
(truncation) rates with 95% Wilson intervals. Seeds come from a committed seed
file, so every evaluation of every checkpoint plays the same games.

    python3 -m training.eval.evaluate --checkpoint checkpoints/v2/<run>/final.pt \
        --opponents idle,rush1 --maps train --seeds 13 --out docs/eval/<name>.json
    python3 -m training.eval.evaluate --checkpoint bot:macro --opponents idle   # oracle
"""
from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import torch

from training.env.vec_env_v2 import VecEnvV2
from training.v2 import spaces as S
from training.v2.batch import stack_masks, stack_obs, static_grid
from training.v2.model import Agent, wire_actions

HERE = Path(__file__).resolve().parent
SEED_FILE = HERE / "seeds" / "eval-v1.txt"


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True, help="path to a v2 checkpoint, or bot:<name>")
    ap.add_argument("--opponents", default="idle")
    ap.add_argument("--maps", default="train", help="'train', 'heldout' or a comma-separated list")
    ap.add_argument("--seeds", type=int, default=13, help="first N seeds of the seed file (games per map per seat)")
    ap.add_argument("--procs", type=int, default=18)
    ap.add_argument("--slots", type=int, default=8)
    ap.add_argument("--max-ticks", type=int, default=12000)
    ap.add_argument("--greedy", action="store_true", help="argmax actions instead of sampling")
    ap.add_argument("--torch-seed", type=int, default=0)
    ap.add_argument("--out", default="", help="JSON results path")
    return ap.parse_args()


def main() -> None:
    a = parse()
    maps = {"train": list(S.TRAIN_MAPS), "heldout": list(S.HELD_OUT_MAPS)}.get(a.maps) or a.maps.split(",")
    seeds = [int(x) for x in SEED_FILE.read_text().split()][: a.seeds]
    games = [{"seed": s, "map": m, "opp": o, "side": side}
             for o in a.opponents.split(",") for m in maps for s in seeds for side in ("blue", "red")]

    # A scripted bot under evaluation sits in a teach seat: it chooses its own
    # actions but still reports transitions, like the policy seat.
    is_bot = a.checkpoint.startswith("bot:")
    me = "teach:" + a.checkpoint[4:] if is_bot else "policy"
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if not is_bot:
        torch.manual_seed(a.torch_seed)
        agent = Agent().to(dev)
        agent.load_state_dict(torch.load(a.checkpoint, map_location=dev)["model"])
        agent.eval()

    def cfg(g: dict) -> dict:
        opp = f"bot:{g['opp']}"
        return {"seed": g["seed"], "map": g["map"], "blue": me if g["side"] == "blue" else opp,
                "red": opp if g["side"] == "blue" else me}

    # Slot i plays games i, i + n, i + 2n, ...; the next game is configured while
    # the current one runs, so it starts as soon as the current one ends.
    n = min(len(games), a.procs * a.slots)
    queue = [games[i::n] for i in range(n)]
    pos = [0] * n
    env = VecEnvV2([cfg(q[0]) for q in queue], n_procs=a.procs, max_ticks=a.max_ticks, critic=False)
    cur = env.reset()
    statics = [static_grid(s) for s in env.static]
    for i in range(n):
        if len(queue[i]) > 1:
            env.configure(i, **cfg(queue[i][1]))
    results, t0 = [], time.time()
    while len(results) < len(games):
        if is_bot:
            acts = [None] * len(cur)
        else:
            obs = stack_obs([s.obs for s in cur], [statics[s.slot] for s in cur], [None] * len(cur))
            masks = stack_masks([s.masks for s in cur])
            with torch.no_grad():
                ot = {k: torch.as_tensor(v, device=dev) for k, v in obs.items()}
                h, E, valid = agent.trunk(ot)
                out, _, _, _ = agent.policy(h, E, valid, masks={k: torch.as_tensor(v, device=dev) for k, v in masks.items()}, greedy=a.greedy)
            acts = wire_actions(out)
        res = env.step(acts)
        for tr in res.transitions:
            i = tr.slot
            if not (tr.done or tr.truncated) or pos[i] >= len(queue[i]):
                continue  # still playing, or a filler episode after this slot's queue ran out
            g, info = queue[i][pos[i]], tr.info
            ep = info["episode"]
            assert ep["seed"] == g["seed"] and ep["map"] == g["map"] and tr.side == g["side"], (ep, g, tr.side)
            w = info["winner"]
            results.append({**g, "result": "win" if w == g["side"] else "draw" if w is None else "loss",
                            "winType": info.get("winType"), "ticks": info["ticks"],
                            "stats": info.get("stats", {}).get(g["side"])})
            pos[i] += 1
            if pos[i] + 1 < len(queue[i]):
                env.configure(i, **cfg(queue[i][pos[i] + 1]))
            if len(results) % 100 == 0:
                print(f"  {len(results)}/{len(games)} games, {time.time() - t0:.0f}s", flush=True)
        for i in res.new_episodes:
            statics[i] = static_grid(env.static[i])
        cur = res.current
    env.close()
    report(a, results, time.time() - t0)


def summarise(rs: list[dict]) -> dict:
    n = len(rs)
    c = {k: sum(r["result"] == k for r in rs) for k in ("win", "loss", "draw")}
    return {"n": n, **c, **{f"{k}_ci": wilson(c[k], n) for k in c},
            "ticks": float(np.mean([r["ticks"] for r in rs])) if rs else 0.0,
            "winTypes": dict(Counter(r["winType"] for r in rs if r["result"] == "win"))}


def report(a: argparse.Namespace, results: list[dict], secs: float) -> None:
    by = defaultdict(list)
    for r in results:
        by[r["opp"]].append(r)
    out = {"checkpoint": a.checkpoint, "greedy": a.greedy, "seeds": a.seeds, "seconds": round(secs),
           "opponents": {}, "games": results}
    print(f"{a.checkpoint}: {len(results)} games in {secs:.0f}s")
    print(f"{'opponent':18s} {'n':>4s}  {'win':>5s} [95% CI]      {'loss':>5s}  {'draw':>5s}  ticks  blue/red win")
    for o, rs in by.items():
        s = summarise(rs)
        s["maps"] = {m: summarise([r for r in rs if r["map"] == m]) for m in sorted({r["map"] for r in rs})}
        s["sides"] = {sd: summarise([r for r in rs if r["side"] == sd]) for sd in ("blue", "red")}
        out["opponents"][o] = s
        lo, hi = s["win_ci"]
        print(f"{o:18s} {s['n']:4d}  {s['win'] / s['n']:5.2f} [{lo:.2f}, {hi:.2f}]  {s['loss'] / s['n']:5.2f}  "
              f"{s['draw'] / s['n']:5.2f}  {s['ticks']:5.0f}  {s['sides']['blue']['win'] / max(1, s['sides']['blue']['n']):.2f}/"
              f"{s['sides']['red']['win'] / max(1, s['sides']['red']['n']):.2f}")
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(out, indent=1))
        print(f"wrote {a.out}")


if __name__ == "__main__":
    main()
