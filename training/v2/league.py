#!/usr/bin/env python3
"""
League training in sequence (ML_RETRAIN_PLAN §7.3, exploiter cycles).

Each cycle:
  1. the main agent trains for --main-decisions more decisions against the scripted
     pool plus every exploiter so far, drawn by loss-weighted sampling (--pfsp);
  2. a fresh exploiter starts from --init and trains for --exploiter-decisions
     against only the frozen main agent;
  3. the exploiter's win rate against that frozen agent is measured (exploitability)
     and the exploiter joins the main agent's pool.
A one-plan agent keeps meeting an opponent built to beat that plan.

    python3 -m training.v2.league --run lg1 --init checkpoints/v2/<bc>/final.pt --bots macro,swarm,... \\
        --cycles 4 --main-decisions 5000000 --exploiter-decisions 3000000

Re-running the same command resumes: finished stages (their final.pt exists) are skipped.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CK = REPO / "checkpoints" / "v2"


def run(cmd: list[str], log: Path) -> None:
    print("$ " + " ".join(cmd), flush=True)
    with open(log, "a") as f:
        subprocess.run(cmd, cwd=REPO, stdout=f, stderr=subprocess.STDOUT, check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="league name; runs are <run>-main, <run>-x1, <run>-x2, ...")
    ap.add_argument("--init", required=True, help="imitation checkpoint: the main agent's start, KL reference and every exploiter's start")
    ap.add_argument("--bots", required=True, help="comma-separated scripted pool")
    ap.add_argument("--cycles", type=int, default=4)
    ap.add_argument("--main-decisions", type=int, default=5_000_000)
    ap.add_argument("--exploiter-decisions", type=int, default=3_000_000)
    ap.add_argument("--eval-seeds", type=int, default=2, help="exploitability games per map per seat")
    ap.add_argument("--train-args", default="--kl-coef 1.0 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20",
                    help="extra train.py arguments for the main agent")
    ap.add_argument("--exploiter-args", default="--kl-coef 0.5 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20")
    ap.add_argument("--eval-args", default="", help="extra evaluate.py arguments")
    a = ap.parse_args()

    py = [sys.executable, "-m"]
    logs = REPO / "logs"
    logs.mkdir(exist_ok=True)
    main_run = f"{a.run}-main"
    total = a.cycles * a.main_decisions
    exploiters: list[str] = []
    record = REPO / "docs" / "eval" / f"league-{a.run}.json"
    hist = json.loads(record.read_text()) if record.exists() else {"cycles": []}

    for k in range(1, a.cycles + 1):
        # 1. main agent, resumed from its last stage
        snap = CK / main_run / f"cycle_{k}.pt"
        if not snap.exists():
            prev = CK / main_run / f"cycle_{k - 1}.pt"
            cmd = py + ["training.v2.train", "--run", main_run, "--init", a.init, "--pfsp", "--minutes", "0",
                        "--opponents", ",".join(a.bots.split(",") + [f"ckpt:{x}" for x in exploiters]),
                        "--decisions", str(total), "--stop-decisions", str(k * a.main_decisions)] + a.train_args.split()
            if prev.exists():
                cmd += ["--resume", str(prev)]
            run(cmd, logs / f"{main_run}.log")
            (CK / main_run / "final.pt").rename(snap)
        # 2. exploiter against the frozen main agent
        xr = f"{a.run}-x{k}"
        xfinal = CK / xr / "final.pt"
        if not xfinal.exists():
            run(py + ["training.v2.train", "--run", xr, "--init", a.init, "--minutes", "0", "--opponents", f"ckpt:{snap.relative_to(REPO)}",
                      "--decisions", str(a.exploiter_decisions)] + a.exploiter_args.split(), logs / f"{xr}.log")
        exploiters.append(str(xfinal.relative_to(REPO)))
        # 3. exploitability
        if not any(c["cycle"] == k for c in hist["cycles"]):
            out = REPO / "docs" / "eval" / f"{xr}-vs-main.json"
            run(py + ["training.eval.evaluate", "--checkpoint", str(xfinal), "--opponents", f"ckpt:{snap.relative_to(REPO)}",
                      "--maps", "train", "--seeds", str(a.eval_seeds), "--out", str(out)] + a.eval_args.split(), logs / f"{xr}.log")
            r = json.loads(out.read_text())["games"]
            wr = sum(g["result"] == "win" for g in r) / len(r)
            hist["cycles"].append({"cycle": k, "main": str(snap.relative_to(REPO)), "exploiter": exploiters[-1], "exploiter_win_rate": wr, "games": len(r)})
            record.parent.mkdir(parents=True, exist_ok=True)
            record.write_text(json.dumps(hist, indent=1))
            print(f"cycle {k}: exploiter beats the frozen main agent {wr:.2f} ({len(r)} games)", flush=True)


if __name__ == "__main__":
    main()
