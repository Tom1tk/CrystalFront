"""
Rebuild R1 S7 (docs/REBUILD_R1_PLAN.md): UPGO returns and the ROA scouting reward, kept apart from
train.py so they can be tested on hand-made sequences (training/test_r1.py).
"""
from __future__ import annotations

from collections import deque

import numpy as np


def upgo_returns(rew: np.ndarray, vals: np.ndarray, ended: np.ndarray, boot: np.ndarray, last_v: np.ndarray,
                 gamma: np.ndarray) -> np.ndarray:
    """AlphaStar UPGO return per value head: G_t = r_t + γ·(G_{t+1} if r_{t+1} + γ·V'_{t+1} ≥ V_{t+1} else V_{t+1}),
    where V'_{t+1} is step t+1's bootstrap (V_{t+2}, or `boot` when t+1 ends an episode, `last_v` at the rollout end).
    A step that ends an episode bootstraps from `boot` (0 when done, V(final obs) when truncated).
    rew / vals / boot: (T, B, H); ended: (T, B); last_v: (B, H); gamma: (H,). Returns (T, B, H)."""
    T = rew.shape[0]
    nxt_v = np.empty_like(vals)  # each step's own bootstrap value
    for t in range(T):
        nxt_v[t] = last_v if t == T - 1 else vals[t + 1]
        nxt_v[t] = np.where(ended[t][:, None], boot[t], nxt_v[t])
    g = np.zeros_like(vals)
    for t in reversed(range(T)):
        if t == T - 1:
            tail = nxt_v[t]
        else:
            good = rew[t + 1] + gamma * nxt_v[t + 1] >= vals[t + 1]
            tail = np.where(good, g[t + 1], vals[t + 1])
            tail = np.where(ended[t][:, None], boot[t], tail)
        g[t] = rew[t] + gamma * tail
    return g


class RoaReward:
    """Online ROA scouting reward per stream: r_t = max(0, min(H over the last `window` decisions) − H_t), with H_t the
    reference model's opponent-model cross-entropy now. History is per episode (cleared at a stream's first decision);
    the first decision of an episode gets 0."""

    def __init__(self, n: int, window: int = 38):
        self.hist = [deque(maxlen=window) for _ in range(n)]

    def step(self, H: np.ndarray, first: np.ndarray) -> np.ndarray:
        r = np.zeros(len(H), dtype=np.float32)
        for b, (h, f) in enumerate(zip(H, first)):
            q = self.hist[b]
            if f:
                q.clear()
            if q:
                r[b] = max(0.0, min(q) - float(h))
            q.append(float(h))
        return r
