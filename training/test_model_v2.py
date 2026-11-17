#!/usr/bin/env python3
"""
v2 network checks (no game needed):
1. A feed-forward checkpoint loads into the recurrent network and gives the same outputs
   (memory and opponent-model feedback start at zero).
2. trunk_seq (training) reproduces step-by-step trunk (rollout), with episode resets.

    python3 training/test_model_v2.py [checkpoint.pt]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch

from training.v2 import spaces as S  # noqa: E402
from training.v2.model import Agent, bin_counts, load_weights  # noqa: E402

torch.manual_seed(0)
dev = torch.device("cpu")


def fake_obs(b: int, n: int = 12) -> dict:
    return {
        "globals": torch.randn(b, S.N_GLOBALS), "z": torch.zeros(b, dtype=torch.long),
        "ent": torch.randn(b, n, S.ENTITY_F), "ent_n": torch.randint(1, n + 1, (b,)),
        "nodes": torch.randn(b, S.N_NODES, S.NODE_F), "memory": torch.randn(b, S.N_MEMORY, S.MEMORY_F),
        "grid": torch.randn(b, S.GRID_DYN_C + S.GRID_STATIC_C, S.GRID_ROWS, S.GRID_COLS),
    }


@torch.no_grad()
def test_feedforward_checkpoint(path: str) -> None:
    sd = torch.load(path, map_location=dev)["model"]
    a = Agent()
    load_weights(a, sd)
    a.eval()
    o = fake_obs(6)
    x, _, _ = a.encode(o)
    h, _, _, _, _ = a.trunk(o, a.zero_state(6, dev))
    assert torch.allclose(h, x), "new modules change the old network's output"
    print("ok: feed-forward checkpoint loads and plays unchanged")


@torch.no_grad()
def test_sequence_matches_steps() -> None:
    a = Agent()
    for m in (a.mem_out, a.opp_in):  # make memory and feedback matter
        torch.nn.init.normal_(m.weight, std=0.05)
    a.eval()
    L, n = 6, 4
    obs = [fake_obs(n) for _ in range(L)]
    first = torch.zeros(L, n, dtype=torch.bool)
    first[2, 1] = first[0, 3] = first[4, 0] = True
    h0 = (torch.randn(n, a.lstm.hidden_size), torch.randn(n, a.lstm.hidden_size))
    st, steps = h0, []
    for t in range(L):
        keep = (~first[t]).float().unsqueeze(1)
        st = (st[0] * keep, st[1] * keep)
        if t == 0:
            st0 = st
        h, _, _, st, _ = a.trunk(obs[t], st)
        steps.append(h)
    cat = {k: torch.cat([o[k] for o in obs]) for k in obs[0]}
    hs, _, _, _ = a.trunk_seq(cat, st0, first.reshape(-1), L)
    assert torch.allclose(hs, torch.cat(steps), atol=1e-5), (hs - torch.cat(steps)).abs().max()
    print(f"ok: sequence pass matches step-by-step rollout (max diff {(hs - torch.cat(steps)).abs().max():.1e})")


def test_bins() -> None:
    assert bin_counts(np.array([0, 1, 2, 3, 4, 5, 8, 9, 40])).tolist() == [0, 1, 2, 3, 3, 4, 4, 5, 5]
    print("ok: count bins")


if __name__ == "__main__":
    test_bins()
    test_sequence_matches_steps()
    test_feedforward_checkpoint(sys.argv[1] if len(sys.argv) > 1 else "checkpoints/v2/m2-imitate/final.pt")
