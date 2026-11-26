#!/usr/bin/env python3
"""
Rebuild R1 S7 tests (docs/REBUILD_R1_PLAN.md): UPGO returns and the ROA scouting reward
(training/v2/r1.py), and the opponent-model cross-entropy H (Agent.opp_ce).

    CF_LAYOUT=v4 python3 training/test_r1.py
"""
import math
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from training.v2 import spaces as S  # noqa: E402
from training.v2.model import OPP_NEW_COUNTS, Agent  # noqa: E402
from training.v2.r1 import RoaReward, upgo_returns  # noqa: E402

FAILED = []


def check(cond: bool, msg: str) -> None:
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILED.append(msg)


def col(*xs):
    """(T,) → (T, 1, 1)."""
    return np.array(xs, dtype=np.float64).reshape(-1, 1, 1)


def upgo_tests() -> None:
    print("UPGO returns")
    g = np.array([0.5])
    # 3 steps by hand, γ = 0.5, no episode end, V(after the rollout) = 1:
    #   G2 = 2 + .5·1 = 2.5
    #   step 2 beat its value (2 + .5·1 = 2.5 ≥ .5)  → G1 = 0 + .5·G2 = 1.25
    #   step 1 did not (0 + .5·.5 = .25 < 1)          → G0 = 1 + .5·V1 = 1.5
    rew, vals = col(1, 0, 2), col(0.5, 1.0, 0.5)
    end, boot = np.zeros((3, 1), bool), np.zeros((3, 1, 1))
    G = upgo_returns(rew, vals, end, boot, np.array([[1.0]]), g)
    check(np.allclose(G.ravel(), [1.5, 1.25, 2.5]), f"3 steps by hand: {G.ravel().tolist()}")

    # 6 steps, γ = 0.5, an episode ends (done, boot 0) at step 2; the next one is truncated at step 5 with V(final) = 4.
    rew, vals = col(0, 0, 1, 0, 0, 2), col(0.2, 0.4, 0.8, 1.0, 1.0, 1.0)
    end = np.zeros((6, 1), bool)
    end[2, 0] = end[5, 0] = True
    boot = np.zeros((6, 1, 1))
    boot[5] = 4.0
    G = upgo_returns(rew, vals, end, boot, np.array([[9.0]]), g)
    # By hand:
    #   G5 = 2 + .5·4 = 4                    (truncated: bootstraps from V(final), not last_v)
    #   step 5 beat V5 (2 + .5·4 = 4 ≥ 1)   → G4 = 0 + .5·4 = 2
    #   step 4 did not (0 + .5·1 = .5 < 1)   → G3 = 0 + .5·V4 = .5
    #   G2 = 1 + .5·0 = 1                    (done)
    #   step 2 beat V2 (1 + 0 = 1 ≥ .8)     → G1 = 0 + .5·1 = .5
    #   step 1 beat V1 (0 + .5·.8 = .4 ≥ .4) → G0 = 0 + .5·.5 = .25
    want = [0.25, 0.5, 1.0, 0.5, 2.0, 4.0]
    check(np.allclose(G.ravel(), want), f"6 steps by hand (done at 2, truncated at 5): {G.ravel().tolist()}")
    rew2 = rew.copy()
    rew2[3:] += 100.0
    G2 = upgo_returns(rew2, vals, end, boot, np.array([[9.0]]), g)
    check(np.allclose(G2[:3], G[:3]), "rewards after an episode end do not reach back across it")

    # Shapes: per head, per stream.
    T, B, H = 7, 3, 3
    rng = np.random.default_rng(0)
    r, v = rng.normal(size=(T, B, H)), rng.normal(size=(T, B, H))
    e = rng.random((T, B)) < 0.2
    G = upgo_returns(r, v, e, np.zeros((T, B, H)), rng.normal(size=(B, H)), np.array([0.99, 0.9, 0.5]))
    one = upgo_returns(r[:, 1:2, 2:3], v[:, 1:2, 2:3], e[:, 1:2], np.zeros((T, 1, 1)), np.zeros((1, 1)), np.array([0.5]))
    G1 = upgo_returns(r, v, e, np.zeros((T, B, H)), np.zeros((B, H)), np.array([0.99, 0.9, 0.5]))
    check(G.shape == (T, B, H) and np.allclose(G1[:, 1, 2], one[:, 0, 0]), "streams and heads are independent")


def roa_tests() -> None:
    print("ROA scouting reward")
    roa = RoaReward(1, window=38)
    seq = [5.0, 4.0, 4.5, 3.0, 3.2, 3.0, 2.0]
    got = [float(roa.step(np.array([h]), np.array([i == 0]))[0]) for i, h in enumerate(seq)]
    check(np.allclose(got, [0, 1, 0, 1, 0, 0, 1]), f"rewards new lows only: {got}")

    # Wobbles within 30 s (38 decisions) pay nothing: down to 1, back up, down to 1.5 again.
    roa = RoaReward(1, window=38)
    hs = [3.0, 1.0] + [2.0] * 30 + [1.5, 2.0, 1.0]
    rs = [float(roa.step(np.array([h]), np.array([i == 0]))[0]) for i, h in enumerate(hs)]
    check(np.isclose(rs[1], 2.0) and sum(rs[2:]) == 0.0, f"wobbles within the window give 0 (total after the low: {sum(rs[2:])})")
    # ... but once the low is older than the window, a new dip counts again.
    roa = RoaReward(1, window=38)
    hs = [1.0] + [2.0] * 38 + [1.5]
    rs = [float(roa.step(np.array([h]), np.array([i == 0]))[0]) for i, h in enumerate(hs)]
    check(np.isclose(rs[-1], 0.5), f"a low older than the window no longer counts: {rs[-1]}")

    # Episodes and streams are separate.
    roa = RoaReward(2)
    roa.step(np.array([1.0, 5.0]), np.array([True, True]))
    r = roa.step(np.array([3.0, 3.0]), np.array([True, False]))
    check(r.tolist() == [0.0, 2.0], f"a new episode starts its own history; streams are separate: {r.tolist()}")


def opp_ce_tests() -> None:
    print("opponent-model cross-entropy (Agent.opp_ce)")
    torch.manual_seed(0)
    a = Agent()
    B = 4
    n_counts = S.OPP_UNITS + S.OPP_BUILDINGS
    v4 = S.LAYOUT == "v4"
    kn = len(OPP_NEW_COUNTS) if v4 else 0
    n_lab = n_counts + 1 + (kn + 1 if v4 else 0)
    labels = torch.zeros(B, n_lab, dtype=torch.long)
    opp = torch.zeros(B, a.n_opp)
    H = a.opp_ce(opp, labels)
    # Uniform logits: every group's CE is log(#classes); weights 1, near-base groups 3 (v4).
    la, lb = math.log(S.N_ANCHORS + 1), math.log(S.OPP_BINS)
    if v4:
        wn = [3.0 if n.startswith("near") else 1.0 for n in OPP_NEW_COUNTS]
        want = (n_counts * lb + la + sum(wn) * lb + 3.0 * la) / (n_counts + 1 + sum(wn) + 3.0)
    else:
        want = (n_counts * lb + la) / (n_counts + 1)
    check(torch.allclose(H, torch.full((B,), want), atol=1e-5), f"uniform logits: H = {H[0]:.5f}, want {want:.5f}")
    # Confident and right: H near 0; confident and wrong on a near-base group costs 3× a unit-count group.
    sure = torch.full((B, a.n_opp), -30.0)
    nb = n_counts * S.OPP_BINS
    for k in range(n_counts):
        sure[:, k * S.OPP_BINS] = 30.0
    sure[:, nb] = 30.0
    if v4:
        na = nb + S.N_ANCHORS + 1
        for k in range(kn):
            sure[:, na + k * S.OPP_BINS] = 30.0
        sure[:, na + kn * S.OPP_BINS] = 30.0
    check(bool((a.opp_ce(sure, labels) < 1e-4).all()), "confident and right: H ≈ 0")
    if v4:
        near = [i for i, n in enumerate(OPP_NEW_COUNTS) if n.startswith("near")][0]
        wrong_u, wrong_n = labels.clone(), labels.clone()
        wrong_u[:, 0] = 1
        wrong_n[:, n_counts + 1 + near] = 1
        hu, hn = a.opp_ce(sure, wrong_u)[0].item(), a.opp_ce(sure, wrong_n)[0].item()
        check(abs(hn / hu - 3.0) < 1e-3, f"a wrong near-base group costs 3× a wrong unit count ({hn:.2f} vs {hu:.2f})")


if __name__ == "__main__":
    upgo_tests()
    roa_tests()
    opp_ce_tests()
    print(f"\n{'FAILED: ' + str(len(FAILED)) if FAILED else 'all passed'}")
    sys.exit(1 if FAILED else 0)
