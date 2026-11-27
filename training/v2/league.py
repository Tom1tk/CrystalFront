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

Rebuild R1 S11, --forced-exploiters bot:z,...: after step 3, for each entry a strategy-forced exploiter starts
from the main agent's cycle snapshot and trains for --forced-decisions against it with train.py --shadow-bot
<bot> --fixed-z <z> (the bot's econ and army action as a cross-entropy target, its build list as a reward; no KL).
It is evaluated against that snapshot with saved replays and checked by headless/src/v4/fidelity.ts
(strategy = the bot's name): only an exploiter that plays the bot's plan joins the main agent's pool for
the next cycle. Results either way go in the league record under "forced".

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
    ap.add_argument("--forced-exploiters", default="", help="comma-separated bot:z (bot in fidelity.ts STRATEGIES: backdoor, flank)")
    ap.add_argument("--forced-decisions", type=int, default=1_000_000)
    ap.add_argument("--forced-args", default="--build-w 1.0 --shadow-coef 1.0 --shadow-coef-end 0.3",
                    help="train.py arguments for forced exploiters, after --exploiter-args (their --kl-coef is then set to 0)")
    a = ap.parse_args()

    py = [sys.executable, "-m"]
    logs = REPO / "logs"
    logs.mkdir(exist_ok=True)
    main_run = f"{a.run}-main"
    total = a.cycles * a.main_decisions
    exploiters: list[str] = []
    record = REPO / "docs" / "eval" / f"league-{a.run}.json"
    hist = json.loads(record.read_text()) if record.exists() else {"cycles": []}
    hist.setdefault("forced", [])
    forced = [(b, int(z)) for b, z in (x.split(":") for x in a.forced_exploiters.split(",") if x)]
    for b, _ in forced:
        if b not in ("backdoor", "flank"):
            raise SystemExit(f"--forced-exploiters: no fidelity check for {b}")

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
        # 4. strategy-forced exploiters; those that play their plan join the pool
        for b, z in forced:
            fr = f"{a.run}-f{k}-{b}"
            ffinal = CK / fr / "final.pt"
            done = [f for f in hist["forced"] if f["cycle"] == k and f["bot"] == b]
            if not done:
                if not ffinal.exists():
                    run(py + ["training.v2.train", "--run", fr, "--init", str(snap), "--minutes", "0", "--opponents", f"ckpt:{snap.relative_to(REPO)}",
                              "--decisions", str(a.forced_decisions)] + a.exploiter_args.split() + a.forced_args.split()
                        + ["--kl-coef", "0", "--shadow-bot", b, "--fixed-z", str(z)], logs / f"{fr}.log")
                out = REPO / "docs" / "eval" / f"{fr}-vs-main.json"
                run(py + ["training.eval.evaluate", "--checkpoint", str(ffinal), "--opponents", f"ckpt:{snap.relative_to(REPO)}",
                          "--maps", "train", "--seeds", str(a.eval_seeds), "--save-replays", "--out", str(out)] + a.eval_args.split(), logs / f"{fr}.log")
                fout = REPO / "docs" / "eval" / f"{fr}-fidelity.json"
                run(["npx", "tsx", "headless/src/v4/fidelity.ts", str(out), "--strategy", b, "--replays", "replays", "--out", str(fout)], logs / f"{fr}.log")
                r = json.loads(out.read_text())["games"]
                fid = json.loads(fout.read_text())
                done = [{"cycle": k, "bot": b, "z": z, "exploiter": str(ffinal.relative_to(REPO)), "win_rate": sum(g["result"] == "win" for g in r) / len(r),
                         "games": len(r), "fidelity": fid["rate"], "pass": fid["pass"]}]
                hist["forced"] += done
                record.write_text(json.dumps(hist, indent=1))
                print(f"cycle {k}: forced {b} (z {z}) beats the frozen main agent {done[0]['win_rate']:.2f}, plays the plan in "
                      f"{fid['rate']:.2f} of games: {'joins the pool' if fid['pass'] else 'left out'}", flush=True)
            if done[0]["pass"]:
                exploiters.append(done[0]["exploiter"])


if __name__ == "__main__":
    main()
