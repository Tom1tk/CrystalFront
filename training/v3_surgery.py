#!/usr/bin/env python3
"""
Network surgery for the mainline 0.10 bot round (docs/MAINLINE_0.10_PLAN.md §4.2).

Turns a v2 checkpoint (observation v2 schema 5, action space v7: the 0.9 bots) into a v3 model
(observation v3 schema 7, action space v8: the beta ruleset). Inputs and outputs are matched by
name, read from the TypeScript layouts themselves:

  globals, entity features  columns copied by name; v3 `builder` is the renamed v2 `scout` (the
                            worker taken off autopilot); new inputs (Outrider counts and type,
                            Surge globals) get zero weights
  critic                    the same map for both seats' globals
  econ head                 rows copied, the new "train Outrider" row gets zero weights and a bias
                            OUTRIDER_BIAS below the lowest train bias (so it is about never picked)
  opponent model            the Outrider is a new unit group: zero `opp_in` columns (no effect on the
                            policy), zero `opp` rows

With the new inputs at their 0.9 values the v3 model gives the v2 model's outputs (`--check`).

    python3 training/v3_surgery.py checkpoints/v2/lg2-main/cycle_3.pt checkpoints/v3/surgery/cycle_3_v3.pt --check
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import torch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
OUTRIDER_BIAS = 8.0

NAMES_TS = """
import * as O2 from "./headless/src/v2/observation.ts";
import * as O3 from "./headless/src/v3/observation.ts";
import * as A2 from "./headless/src/v2/actions.ts";
import * as A3 from "./headless/src/v3/actions.ts";
const econ = (A: any) => Array.from({ length: A.ECON_SIZE }, (_, i) => JSON.stringify(A.decodeEcon(i)));
console.log(JSON.stringify({
  v2: { globals: O2.GLOBAL_NAMES, entity: O2.ENTITY_FEATURES, units: A2.TRAIN_UNITS, buildings: A2.BUILDINGS, econ: econ(A2) },
  v3: { globals: O3.GLOBAL_NAMES, entity: O3.ENTITY_FEATURES, units: A3.TRAIN_UNITS, buildings: A3.BUILDINGS, econ: econ(A3) },
}));
"""
RENAMED = {"builder": "scout"}


def layout_names() -> dict:
    out = subprocess.run(["npx", "tsx", "-e", NAMES_TS], cwd=REPO, capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def index_map(old: list[str], new: list[str]) -> list[int | None]:
    """For each new name, the old index (None: new input)."""
    return [old.index(RENAMED.get(n, n)) if RENAMED.get(n, n) in old else None for n in new]


def remap(t: torch.Tensor, dim: int, idx: list[int | None]) -> torch.Tensor:
    shape = list(t.shape)
    shape[dim] = len(idx)
    out = torch.zeros(shape, dtype=t.dtype)
    for j, i in enumerate(idx):
        if i is not None:
            out.select(dim, j).copy_(t.select(dim, i))
    return out


def opp_map(v2: dict, v3: dict, bins: int, n_anchor_rows: int) -> list[int | None]:
    """Opponent-model outputs: (units + buildings) groups of `bins`, then the anchor classes."""
    g2 = v2["units"] + v2["buildings"]
    idx: list[int | None] = []
    for g in v3["units"] + v3["buildings"]:
        k = g2.index(g) if g in g2 else None
        idx += [None if k is None else k * bins + b for b in range(bins)]
    base = len(g2) * bins
    return idx + [base + a for a in range(n_anchor_rows)]


def surgery(sd: dict, names: dict) -> tuple[dict, dict]:
    from training.v2 import spaces as S  # v3 layout (CF_LAYOUT=v3 set by main)
    v2, v3 = names["v2"], names["v3"]
    g = index_map(v2["globals"], v3["globals"])
    ent = index_map(v2["entity"], v3["entity"])
    econ = index_map(v2["econ"], v3["econ"])
    n2 = len(v2["globals"])
    n_anchor = sd["opp.weight"].shape[0] - (len(v2["units"]) + len(v2["buildings"])) * S.OPP_BINS
    opp = opp_map(v2, v3, S.OPP_BINS, n_anchor)
    out = dict(sd)
    out["ent_proj.weight"] = remap(sd["ent_proj.weight"], 1, ent)
    z = sd["glob.0.weight"].shape[1] - n2
    out["glob.0.weight"] = remap(sd["glob.0.weight"], 1, g + list(range(n2, n2 + z)))
    out["critic.0.weight"] = remap(sd["critic.0.weight"], 1, g + [None if i is None else i + n2 for i in g])
    out["econ.weight"] = remap(sd["econ.weight"], 0, econ)
    out["econ.bias"] = remap(sd["econ.bias"], 0, econ)
    train_rows = [j for j, n in enumerate(v2["econ"]) if json.loads(n).get("kind") == "train"]
    for j, i in enumerate(econ):
        if i is None:
            out["econ.bias"][j] = sd["econ.bias"][train_rows].min() - OUTRIDER_BIAS
    out["opp.weight"] = remap(sd["opp.weight"], 0, opp)
    out["opp.bias"] = remap(sd["opp.bias"], 0, opp)
    out["opp_in.weight"] = remap(sd["opp_in.weight"], 1, opp)
    new = {
        "globals": [n for n, i in zip(v3["globals"], g) if i is None],
        "entity": [n for n, i in zip(v3["entity"], ent) if i is None],
        "econ": [n for n, i in zip(v3["econ"], econ) if i is None],
        "opp_rows": sum(i is None for i in opp),
    }
    return out, new


def check(sd2: dict, sd3: dict, names: dict, seed: int = 0) -> None:
    """Same outputs: a random v2 input and its v3 counterpart (new inputs at their 0.9 values)."""
    from training.v2 import spaces as S3
    from training.v2 import model as M3
    v2, v3 = names["v2"], names["v3"]
    gen = torch.Generator().manual_seed(seed)
    B, N = 4, 30
    g2 = torch.rand(B, len(v2["globals"]), generator=gen)
    e2 = torch.rand(B, N, len(v2["entity"]), generator=gen)
    g_idx, e_idx = index_map(v2["globals"], v3["globals"]), index_map(v2["entity"], v3["entity"])
    zero_val = {"surge_stage": 0.0, "surge_next": 1.0, "cap_left": 1.0}
    g3 = remap(g2, 1, g_idx)
    for j, (n, i) in enumerate(zip(v3["globals"], g_idx)):
        if i is None:
            g3[:, j] = zero_val.get(n, 0.0)

    def feats(sd: dict, gl: torch.Tensor, ent: torch.Tensor):
        z = sd["glob.0.weight"].shape[1] - gl.shape[1]
        gz = torch.cat([gl, torch.zeros(B, z)], 1)
        glob = torch.relu(gz @ sd["glob.0.weight"].T + sd["glob.0.bias"])
        e = ent @ sd["ent_proj.weight"].T + sd["ent_proj.bias"]
        crit = torch.relu(torch.cat([gl, gl], 1) @ sd["critic.0.weight"].T + sd["critic.0.bias"])
        return glob, e, crit

    a, b = feats(sd2, g2, e2), feats(sd3, g3, remap(e2, 2, e_idx))
    for name, x, y in zip(("globals encoder", "entity projection", "critic encoder"), a, b):
        err = (x - y).abs().max().item()
        print(f"  {'ok  ' if err < 1e-5 else 'FAIL'} {name}: max |Δ| {err:.2e}")
        assert err < 1e-5, name
    # Heads: same logits on the shared rows; the new econ row loses to every train row by OUTRIDER_BIAS.
    h = torch.rand(B, sd2["econ.weight"].shape[1], generator=gen)
    l2, l3 = h @ sd2["econ.weight"].T + sd2["econ.bias"], h @ sd3["econ.weight"].T + sd3["econ.bias"]
    econ = index_map(v2["econ"], v3["econ"])
    keep = [j for j, i in enumerate(econ) if i is not None]
    err = (l3[:, keep] - l2[:, [econ[j] for j in keep]]).abs().max().item()
    p_new = torch.softmax(l3, -1)[:, [j for j, i in enumerate(econ) if i is None]].max().item()
    print(f"  {'ok  ' if err < 1e-5 else 'FAIL'} econ logits on shared actions: max |Δ| {err:.2e}; new action prob ≤ {p_new:.1e}")
    assert err < 1e-5 and p_new < 1e-2
    # The full v3 network accepts the weights (shapes match the v3 layout).
    agent = M3.Agent()
    M3.load_weights(agent, sd3)
    print(f"  ok   loads into the v3 Agent (N_GLOBALS {S3.N_GLOBALS}, ENTITY_F {S3.ENTITY_F}, ECON {S3.ECON}, OPP_UNITS {S3.OPP_UNITS})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    os.environ["CF_LAYOUT"] = "v3"
    names = layout_names()
    ck = torch.load(args.src, map_location="cpu", weights_only=False)
    sd2 = ck["model"] if "model" in ck else ck
    sd3, new = surgery(sd2, names)
    print("new inputs/outputs (zero-initialised):", json.dumps(new))
    if args.check:
        check(sd2, sd3, names)
    Path(args.dst).parent.mkdir(parents=True, exist_ok=True)
    cfg = dict(ck.get("config") or {})
    cfg["surgery"] = {"from": str(args.src), "layout": "v3"}
    torch.save({"model": sd3, "update": 0, "decisions": 0, "config": cfg}, args.dst)
    print("wrote", args.dst)


if __name__ == "__main__":
    main()
