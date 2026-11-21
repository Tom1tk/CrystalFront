"""
M4 parity: the server's TypeScript policy (headless/src/v2/neural.ts, ONNX) against
the PyTorch checkpoint over whole recorded episodes.

neuralGame.ts --log records each decision the TS policy made: its observation,
masks, chosen action and per-head log-probabilities. Here the PyTorch model replays
the same episode (LSTM state carried from decision to decision) and scores those
actions; every head's log-probability must match. That covers the ONNX graphs,
the LSTM state hand-off, and the TS masking / autoregressive chain.

    npx tsx headless/src/v2/neuralGame.ts --model models/policy-hard --bots rush2,turtle --seeds 1 --log /tmp/parity.jsonl
    python3 -m training.v2.test_onnx_parity --checkpoint checkpoints/v2/lg2-main/cycle_3.pt --log /tmp/parity.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys

import torch

from training.v2 import spaces as S
from training.v2.batch import stack_masks, stack_obs, static_grid
from training.v2.export_onnx import load
from training.v2.model import HEADS

TOL = 2e-3


def given(action: dict) -> dict[str, torch.Tensor]:
    e, ar = action["econ"], action["army"]
    vals = dict(zip(HEADS, [*e, *ar]))
    return {k: torch.tensor([v]) for k, v in vals.items()}


def run(ckpt: str, log: str) -> int:
    agent = load(ckpt)
    worst, n, bad, games = 0.0, 0, 0, 0
    state = static = None
    cur = None
    with open(log) as f, torch.no_grad():
        for line in f:
            r = json.loads(line)
            if r["game"] != cur:
                cur, games = r["game"], games + 1
                state = agent.zero_state(1, "cpu")
                static = static_grid({"data": r["static"]})
            o = {k: torch.from_numpy(v) for k, v in stack_obs([r["obs"]], [static], [None]).items()}
            masks = {k: torch.from_numpy(v) for k, v in stack_masks([r["masks"]]).items()}
            h, E, valid, state, _ = agent.trunk(o, state)
            rows = {}
            g = given(r["action"])
            # Mask rows actually used for the given choices (same selection as sampling)
            b = torch.arange(1)
            e = g["econ"]
            bi = (e - S.ECON_BUILD0).clamp(0, S.N_BUILDINGS - 1)
            ki = (e - S.ECON_REPAIR).clamp(0, S.ECON_PTR_KINDS - 1)
            rows = {"econ": masks["econ"], "site": masks["site"][b, bi], "econPtr": masks["econPtr"][b, ki],
                    "econTarget": masks["econTarget"], "group": masks["group"], "order": masks["order"][b, g["group"]],
                    "unit": masks["unit"][b, g["order"]], "target": masks["target"][b, g["order"]], "ptr": masks["ptr"][b, g["order"]]}
            head_lp: dict = {}
            agent.policy(h, E, valid, rows=rows, given=g, head_lp=head_lp)
            for k in HEADS:
                ref = float(head_lp[k][0])
                ts = float(r["logp"].get(k, 0.0))
                d = abs(ref - ts)
                worst = max(worst, d)
                if d > TOL:
                    bad += 1
                    if bad <= 10:
                        print(f"game {cur} step {r['step']} head {k}: torch {ref:.5f} ts {ts:.5f}")
            n += 1
    print(f"{games} games, {n} decisions, {n * len(HEADS)} head log-probs; worst |Δ| {worst:.2e}; {bad} over {TOL}")
    return 1 if bad or n == 0 else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--log", required=True)
    a = ap.parse_args()
    sys.exit(run(a.checkpoint, a.log))
