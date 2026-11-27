#!/usr/bin/env python3
"""
Rebuild R1 S10 (docs/REBUILD_R1_PLAN.md): scenario starts from lost games.

    python3 training/v2/scenarios.py docs/eval/r1-main-c2-hard64.json docs/eval/b3-v4-hard64.json \\
        --replays /root/CrystalFront-train/replays --out checkpoints/v4/scenarios/r2

For every loss (against --opps) in the evaluations' saved replays, two scenarios (runner.ts Scenario):
- event: 20–40 s (uniform) before the first of: an enemy building within 900 px of the own crystal, an enemy
  worker in the own half (after 30 s), the first raid (≥ 3 enemy combat units within 700 px); see
  headless/src/v4/scenarioEvents.ts. Skipped when that leaves less than 30 s of game before it.
- random: a uniform decision between 30 s and 20 s before the end.
Handovers snap down to a decision tick. The replays are copied into --out (checkpoints/ is shared by the
training worktree); --out/index.json lists the scenarios as slot configs plus `opp` and `kind`, with paths
relative to the repository root (the runner's working directory). train.py --scenarios reads it.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from training.v2 import spaces as S  # noqa: E402

TPS = 10
HARD = "backdoor,flank,swing,hidden,rush_post"
MIN_TICK = 30 * TPS


def snap(decisions: list[int], tick: int) -> int | None:
    """The last decision tick at or before `tick`."""
    ok = [d for d in decisions if d <= tick]
    return ok[-1] if ok else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("evals", nargs="+", help="evaluation JSONs (evaluate.py --save-replays)")
    ap.add_argument("--replays", default="replays", help="directory of the saved replays")
    ap.add_argument("--opps", default=HARD)
    ap.add_argument("--out", default="checkpoints/v4/scenarios/r2")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    want = set(a.opps.split(","))
    games = []
    for f in a.evals:
        for g in json.load(open(f))["games"]:
            if g.get("result") == "loss" and g["opp"] in want and g.get("replayId") and g["map"] not in S.HELD_OUT_MAPS:
                games.append(g)
    if not games:
        raise SystemExit("no losses with saved replays")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    src = [Path(a.replays) / f"{g['replayId']}.json" for g in games]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
        json.dump([{"replay": str(p.resolve()), "seat": g["side"]} for p, g in zip(src, games)], tf)
    lines = subprocess.run(["npx", "tsx", "headless/src/v4/scenarioEvents.ts", tf.name], cwd=REPO,
                           capture_output=True, text=True, check=True).stdout.strip().splitlines()
    Path(tf.name).unlink()
    events = [json.loads(x) for x in lines]
    assert len(events) == len(games)

    scenarios, firsts = [], Counter()
    for g, p, ev in zip(games, src, events):
        r = json.load(open(p))
        dst = out / p.name
        shutil.copyfile(p, dst)
        rel = os.path.relpath(os.path.abspath(dst), REPO)  # the runner's working directory is the repository root
        if rel.startswith(".."):
            rel = os.path.abspath(dst)
        other = "red" if g["side"] == "blue" else "blue"
        assert r[g["side"]] == "policy" and r[other] == f"bot:{g['opp']}", (p, r["blue"], r["red"])
        base = {"seed": r["seed"], "map": r["mapId"], "blue": r["blue"], "red": r["red"], "learner": [g["side"]], "opp": g["opp"]}
        dec, end = ev["decisions"], r["outcome"]["ticks"]
        hits = {k: ev[k] for k in ("outpost", "builder", "raid") if ev[k] is not None}
        if hits:
            kind = min(hits, key=hits.get)
            t = snap(dec, hits[kind] - rng.randint(20 * TPS, 40 * TPS))
            if t is not None and t >= MIN_TICK:
                firsts[kind] += 1
                scenarios.append({**base, "kind": f"event:{kind}", "scenario": {"replay": rel, "tick": t, "seat": g["side"]}})
        lo, hi = MIN_TICK, end - 20 * TPS
        cand = [d for d in dec if lo <= d <= hi]
        if cand:
            scenarios.append({**base, "kind": "random", "scenario": {"replay": rel, "tick": rng.choice(cand), "seat": g["side"]}})
    (out / "index.json").write_text(json.dumps({"evals": a.evals, "seed": a.seed, "scenarios": scenarios}, indent=1))
    by = Counter(s["opp"] for s in scenarios)
    print(f"{len(games)} losses → {len(scenarios)} scenarios in {out}/index.json")
    print("  by opponent: " + ", ".join(f"{k} {v}" for k, v in sorted(by.items())))
    print("  event handovers by first event: " + ", ".join(f"{k} {v}" for k, v in sorted(firsts.items())))


if __name__ == "__main__":
    main()
