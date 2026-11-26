#!/usr/bin/env python3
"""
v2 network checks (no game needed):
1. A feed-forward checkpoint loads into the recurrent network and gives the same outputs
   (memory and opponent-model feedback start at zero).
2. trunk_seq (training) reproduces step-by-step trunk (rollout), with episode resets.
3. CF_LAYOUT=v4: shapes, the attention pool's null token (no enemies, no memory), the pool starting
   silent, the full critic, the new opponent groups, and load_weights with the v4 modules missing.

    python3 training/test_model_v2.py [checkpoint.pt]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import torch

from training.v2 import spaces as S  # noqa: E402
from training.v2.model import V4_PARAMS, Agent, bin_counts, load_weights, opp_targets  # noqa: E402

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


def fake_critic(o: dict, n: int = 30) -> dict:
    b = o["globals"].shape[0]
    return {**o, "critic": torch.randn(b, 2 * S.N_GLOBALS), "c_ent": torch.randn(b, n, S.ENTITY_F), "c_ent_n": torch.randint(0, n + 1, (b,)),
            "c_nodes": torch.randn(b, S.N_NODES, S.NODE_F), "c_grid": torch.randn(b, S.GRID_DYN_C + S.GRID_STATIC_C, S.GRID_ROWS, S.GRID_COLS)}


@torch.no_grad()
def test_v4() -> None:
    a = Agent().eval()
    b = 5
    o = fake_critic(fake_obs(b))
    o["ent"][:, :, 1] = (torch.rand(b, o["ent"].shape[1]) > 0.5).float()
    o["memory"][:, :, 0] = (torch.rand(b, S.N_MEMORY) > 0.5).float()
    h, E, valid, _, opp = a.trunk(o, a.zero_state(b, dev))
    v = a.values(h, o)
    assert h.shape == (b, 384) and E.shape == (b, 12, 128) and v.shape == (b, 3) and opp.shape == (b, a.n_opp), (h.shape, E.shape, v.shape, opp.shape)
    assert a.n_opp == (S.OPP_UNITS + S.OPP_BUILDINGS) * S.OPP_BINS + 38 + 3 * S.OPP_BINS + 38, a.n_opp
    print(f"ok: v4 shapes (n_opp {a.n_opp})")
    # Null token: no enemy rows, no filled memory, even no entities at all, and no critic entities.
    e = {**o}
    e["ent"] = o["ent"].clone(); e["ent"][:, :, 1] = 0.0
    e["memory"] = o["memory"].clone(); e["memory"][:, :, 0] = 0.0
    e["ent_n"] = torch.tensor([0, 1, 0, 3, 0])
    e["c_ent_n"] = torch.zeros(b, dtype=torch.long)
    h2, _, _, _, opp2 = a.trunk(e, a.zero_state(b, dev))
    assert torch.isfinite(h2).all() and torch.isfinite(a.values(h2, e)).all() and torch.isfinite(opp2).all(), "NaN with empty sets"
    print("ok: v4 null token keeps empty sets finite")
    # The pool starts silent: its core input columns are zero, so its weights do not change the output.
    x0, _, _ = a.encode(o)
    for p_ in list(a.pool.parameters()) + list(a.pool_out.parameters()) + list(a.mem_tok.parameters()):
        p_.add_(torch.randn_like(p_))
    x1, _, _ = a.encode(o)
    assert torch.allclose(x0, x1), "pool changes the output at init"
    print("ok: v4 attention pool starts silent")
    # Opponent model: per-group probabilities and the new targets.
    pr = a.opp_probs(opp)
    k = S.OPP_UNITS + S.OPP_BUILDINGS
    sums = torch.cat([pr[:, :k * 6].view(b, k, 6).sum(-1), pr[:, k * 6:k * 6 + 38].sum(-1, keepdim=True),
                      pr[:, k * 6 + 38:k * 6 + 56].view(b, 3, 6).sum(-1), pr[:, k * 6 + 56:].sum(-1, keepdim=True)], 1)
    assert torch.allclose(sums, torch.ones_like(sums), atol=1e-5), sums
    lab = [{"units": [0] * S.OPP_UNITS, "buildings": [1] * S.OPP_BUILDINGS, "armyAnchor": 37, "nearBuildings": 2, "nearCombat": 0, "workersOut": 6, "nearAnchor": 4}] * b
    t = torch.as_tensor(opp_targets(lab))
    assert t.shape == (b, k + 5) and t[0, k + 1:].tolist() == [2, 0, 4, 4], t[0]
    l = a.opp_loss(opp, t)
    assert torch.isfinite(l) and l > 0, l
    print(f"ok: v4 opponent groups (loss {float(l):.3f})")
    # load_weights tolerates a checkpoint without the v4 modules.
    sd = {k_: v_ for k_, v_ in Agent().state_dict().items() if not k_.startswith(V4_PARAMS)}
    load_weights(Agent(), sd)
    print("ok: load_weights tolerates missing v4 modules")


def test_bins() -> None:
    assert bin_counts(np.array([0, 1, 2, 3, 4, 5, 8, 9, 40])).tolist() == [0, 1, 2, 3, 3, 4, 4, 5, 5]
    print("ok: count bins")


if __name__ == "__main__":
    test_bins()
    test_sequence_matches_steps()
    if S.LAYOUT == "v4":
        test_v4()
    test_feedforward_checkpoint(sys.argv[1] if len(sys.argv) > 1 else "checkpoints/v2/m2-imitate/final.pt")
