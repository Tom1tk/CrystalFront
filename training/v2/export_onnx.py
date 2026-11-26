"""
Export a v2 checkpoint to ONNX for the server's neural bot (M4).

The policy chooses its heads one after another (econ → site / pointer / target;
group → order → unit → target / pointer), so sampling stays in TypeScript
(headless/src/v2/neural.ts). Two graphs, batch size 1:

  <out>.main.onnx  observation + LSTM state → new LSTM state, opponent-model
                   probabilities, and the logits of every head for every choice
                   it can be conditioned on:
                     econ (63) · site per building (5, 760) · econPtr per kind (3, 200)
                     econTarget (804, rally) · group (11) · order per group (11, 12)
                     unit per order (12, 200)
                   plus hh (the heads' input) and E (entity embeddings) for the tail.
  <out>.tail.onnx  hh, E, chosen order, chosen unit, unit_on → target (804), ptr (200)
                   (both depend on the chosen unit's embedding).
Scout slot (v3/v4, a checkpoint trained with one; meta scoutSlot): main also outputs
scoutOrder (12); the tail also takes scout_order and returns scoutTarget (804) and
scoutPtr (200).

Entities are always padded to N = 200 (spaces.PTR) rows with ent_n the real count
(the attention reshape does not trace with a dynamic N; padded rows are masked, as
in training). Pointer logits cover all 200 rows; the caller masks rows ≥ ent_n.
v4 (CF_LAYOUT=v4): the same graphs; the attention pool is part of the main graph, the critic is not exported.

Usage:
    python -m training.v2.export_onnx --checkpoint checkpoints/v2/lg2-main/cycle_3.pt --out models/policy-v0.9.0-ML
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import torch
import torch.nn as nn

from training.v2 import spaces as S
from training.v2.model import Agent, load_weights


class Main(nn.Module):
    def __init__(self, a: Agent, scout: bool = False):
        super().__init__()
        self.a, self.scout = a, scout

    def forward(self, globals_, z, ent, ent_n, nodes, memory, grid, h0, c0):
        a = self.a
        o = {"globals": globals_, "z": z, "ent": ent, "ent_n": ent_n, "nodes": nodes, "memory": memory, "grid": grid}
        x, E, _ = a.encode(o)
        h1, c1 = a.lstm(x, (h0, c0))
        hh, opp = a._heads_in(x + a.mem_out(h1))
        sc = 1.0 / math.sqrt(a.d_ent)
        ptr = lambda q: torch.einsum("bkd,bnd->bkn", q, E) * sc  # noqa: E731  (B, K, 200)
        site = a.site(hh.unsqueeze(1) + a.build_emb.weight.unsqueeze(0))                   # (1, 5, 760)
        hk = hh.unsqueeze(1) + a.eptr_emb.weight.unsqueeze(0)                               # (1, 3, d)
        econ_ptr = ptr(a.eptr_q(hk))                                                        # (1, 3, 200)
        econ_target = a.etgt(hh + a.eptr_emb.weight[1])                                     # (1, 804): rally only
        order = a.order(hh.unsqueeze(1) + a.group_emb.weight.unsqueeze(0))                  # (1, 11, 12)
        unit = ptr(a.unit_q(hh.unsqueeze(1) + a.order_emb.weight.unsqueeze(0)))             # (1, 12, 200)
        outs = (h1, c1, a.opp_probs(opp), hh, E, a.econ(hh), site, econ_ptr, econ_target, a.group(hh), order, unit)
        return outs + (a.scout_order(hh + a.group_emb.weight[S.GROUP_SCOUT]),) if self.scout else outs


class Tail(nn.Module):
    def __init__(self, a: Agent):
        super().__init__()
        self.a = a

    def forward(self, hh, E, order, unit, unit_on):
        a = self.a
        ue = torch.index_select(E[0], 0, unit)                                             # (1, d_ent)
        hu = hh + a.order_emb(order) + a.unit_proj(ue) * unit_on.unsqueeze(-1)
        sc = 1.0 / math.sqrt(a.d_ent)
        return a.target(hu), torch.einsum("bd,bnd->bn", a.ptr_q(hu), E) * sc


class ScoutTail(Tail):
    def forward(self, hh, E, order, unit, unit_on, scout_order):
        a = self.a
        target, ptr = super().forward(hh, E, order, unit, unit_on)
        hs = hh + a.order_emb(scout_order)
        sc = 1.0 / math.sqrt(a.d_ent)
        return target, ptr, a.scout_target(hs), torch.einsum("bd,bnd->bn", a.scout_ptr_q(hs), E) * sc


MAIN_IN = ["globals", "z", "ent", "ent_n", "nodes", "memory", "grid", "h0", "c0"]
MAIN_OUT = ["h1", "c1", "opp", "hh", "E", "econ", "site", "econPtr", "econTarget", "group", "order", "unit"]
TAIL_IN = ["hh", "E", "order", "unit", "unit_on"]
TAIL_OUT = ["target", "ptr"]
SCOUT_MAIN_OUT, SCOUT_TAIL_IN, SCOUT_TAIL_OUT = ["scoutOrder"], ["scout_order"], ["scoutTarget", "scoutPtr"]


def dummy(n: int = 7):
    """Example inputs: n real entities padded to PTR rows."""
    d = 384
    return (torch.zeros(1, S.N_GLOBALS), torch.zeros(1, dtype=torch.long), torch.cat([torch.randn(1, n, S.ENTITY_F), torch.zeros(1, S.PTR - n, S.ENTITY_F)], 1),
            torch.tensor([n]), torch.zeros(1, S.N_NODES, S.NODE_F), torch.zeros(1, S.N_MEMORY, S.MEMORY_F),
            torch.zeros(1, S.GRID_DYN_C + S.GRID_STATIC_C, S.GRID_ROWS, S.GRID_COLS), torch.zeros(1, d), torch.zeros(1, d))


def load(path: str) -> tuple[Agent, bool]:
    """The agent, and whether its checkpoint was trained with the scout slot."""
    a = Agent()
    sd = torch.load(path, map_location="cpu")["model"]
    load_weights(a, sd)
    return a.eval(), "scout_order.weight" in sd


def export(ckpt: str, out: str) -> None:
    torch.backends.mha.set_fastpath_enabled(False)  # the fused encoder kernel has no ONNX export
    a, scout = load(ckpt)
    scout = scout and S.LAYOUT in ("v3", "v4")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    args = dummy()
    main_out = MAIN_OUT + (SCOUT_MAIN_OUT if scout else [])
    tail_in, tail_out = TAIL_IN + (SCOUT_TAIL_IN if scout else []), TAIL_OUT + (SCOUT_TAIL_OUT if scout else [])
    with torch.no_grad():
        torch.onnx.export(Main(a, scout), args, f"{out}.main.onnx", input_names=MAIN_IN, output_names=main_out, opset_version=17, dynamo=False)
        outs = Main(a, scout)(*args)
        tail_args = (outs[3], outs[4], torch.tensor([1]), torch.tensor([2]), torch.tensor([1.0])) + ((torch.tensor([2]),) if scout else ())
        torch.onnx.export(ScoutTail(a) if scout else Tail(a), tail_args, f"{out}.tail.onnx", input_names=tail_in, output_names=tail_out,
                          opset_version=17, dynamo=False)
    meta = {"checkpoint": ckpt, "layout": S.LAYOUT,
            "obsSchemaVersion": {"v2": 5, "v3": 7, "v4": 8}[S.LAYOUT],
            "actionSpaceVersion": {"v2": 7, "v3": 9 if scout else 8, "v4": 10}[S.LAYOUT], "hidden": 384,
            "nOpp": a.n_opp, "scoutSlot": scout, "main": {"in": MAIN_IN, "out": main_out}, "tail": {"in": tail_in, "out": tail_out}}
    Path(f"{out}.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {out}.main.onnx, {out}.tail.onnx, {out}.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True, help="output prefix (writes .main.onnx, .tail.onnx, .json)")
    a = ap.parse_args()
    export(a.checkpoint, a.out)
