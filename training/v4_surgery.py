#!/usr/bin/env python3
"""
Rebuild R1 S8 (docs/REBUILD_R1_PLAN.md): a v3 checkpoint (b3) → layout v4 weights that play the same.

    CF_LAYOUT=v4 python3 training/v4_surgery.py checkpoints/v2/b3-main/cycle_2.pt checkpoints/v4/surgery/b3c2_v4.pt --check

- Input columns are copied by name (the TypeScript layouts: GLOBAL_NAMES, ENTITY_FEATURES, MEMORY_FEATURES,
  DYN_CHANNELS + STATIC_CHANNELS); new inputs get zero columns. That covers the entity projection, globals (then the
  16 z columns), memory (slot × feature, slots 16..23 new), grid conv, critic (both seats' globals).
- New branches feed in through zero columns: the attention pool (core), the opponent model's new groups (opp_in),
  the critic encoder (value). The critic encoder and the pool keep their fresh initialisation.
- Point-target heads (target, etgt, scout_target): anchors 0..36 and memory 37..52 keep their rows; the grid and
  `none` move from 53.. to 61..; the new memory rows 53..60 get weight 0 and bias −10 (almost never picked).
- The opponent model's new groups start uniform (zero rows).

--check plays the same scripted games (teach seats, so both layouts play identical games) in a v3 process with the
source and here with the result, and compares every head's logits, the LSTM state and the opponent model's old
groups on 200 states: they must match within 1e-5 (the v4 point targets compared after the index remap; the LSTM
state relative to its size, since the cell state is unbounded and drifts in float32 over 250 decisions).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from training.v2 import spaces as S  # noqa: E402

TOL = 1e-5
MEM_BIAS = -10.0
# Paired games for --check: teach seats (the scripted bots play, the network only scores the states).
CHECK_SLOTS = [
    {"seed": 51, "map": "shardfall", "blue": "teach:backdoor", "red": "teach:flank"},
    {"seed": 52, "map": "ironreed", "blue": "teach:hidden", "red": "teach:swing"},
]
CHECK_FROM, CHECK_EVERY, CHECK_DECISIONS = 50, 4, 250  # 4 streams × 50 recorded decisions = 200 states
O_ATTACK_MOVE, O_MOVE = 1, 2  # actions.ts ORDERS: the tail graphs are scored for these (unit row 0)


def layout_names() -> dict:
    """Feature names of both layouts, from the TypeScript sources."""
    js = ("import * as a from './headless/src/v3/observation.ts'; import * as b from './headless/src/v4/observation.ts';"
          "const f = (m: any) => ({ globals: m.GLOBAL_NAMES, entity: m.ENTITY_FEATURES, memory: m.MEMORY_FEATURES,"
          " grid: [...m.DYN_CHANNELS, ...m.STATIC_CHANNELS] });"
          "console.log(JSON.stringify({ v3: f(a), v4: f(b) }));")
    out = subprocess.run(["npx", "tsx", "-e", js], cwd=REPO, capture_output=True, text=True, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def surgery(sd3: dict, names: dict) -> dict:
    from training.v2.model import Agent

    torch.manual_seed(0)
    a = Agent()
    sd = a.state_dict()
    n3, n4 = names["v3"], names["v4"]
    idx = {k: torch.tensor([n4[k].index(x) for x in n3[k]]) for k in n3}  # v3 column → v4 column
    g3, g4 = len(n3["globals"]), len(n4["globals"])
    assert g4 == S.N_GLOBALS and len(n4["entity"]) == S.ENTITY_F and len(n4["memory"]) == S.MEMORY_F
    done = set()

    def put(key: str, w: torch.Tensor) -> None:
        assert w.shape == sd[key].shape, (key, w.shape, sd[key].shape)
        sd[key] = w
        done.add(key)

    def zeros(key: str) -> torch.Tensor:
        return torch.zeros_like(sd[key])

    # Inputs by name.
    w = zeros("ent_proj.weight")
    w[:, idx["entity"]] = sd3["ent_proj.weight"]
    put("ent_proj.weight", w)
    w, v = zeros("glob.0.weight"), sd3["glob.0.weight"]
    w[:, idx["globals"]] = v[:, :g3]
    w[:, g4:] = v[:, g3:]  # z embedding columns
    put("glob.0.weight", w)
    w, v = zeros("memory.0.weight"), sd3["memory.0.weight"]
    m3, m4 = len(n3["memory"]), len(n4["memory"])
    for m in range(v.shape[1] // m3):
        w[:, m * m4 + idx["memory"]] = v[:, m * m3:(m + 1) * m3]
    put("memory.0.weight", w)
    w = zeros("cnn.0.weight")
    w[:, idx["grid"]] = sd3["cnn.0.weight"]
    put("cnn.0.weight", w)
    w, v = zeros("critic.0.weight"), sd3["critic.0.weight"]
    w[:, idx["globals"]] = v[:, :g3]
    w[:, g4 + idx["globals"]] = v[:, g3:]
    put("critic.0.weight", w)
    # New branches through zero columns / rows.
    for key, n in (("core.0.weight", sd3["core.0.weight"].shape[1]), ("value.0.weight", sd3["value.0.weight"].shape[1]),
                   ("opp_in.weight", sd3["opp_in.weight"].shape[1])):
        w = zeros(key)
        w[:, :n] = sd3[key]
        put(key, w)
    for key in ("opp.weight", "opp.bias"):
        w = zeros(key)
        w[:sd3[key].shape[0]] = sd3[key]
        put(key, w)
    # Point targets: grid and none move from 53 to 61; new memory rows almost never picked.
    old0 = sd3["target.bias"].shape[0] - S.GRID_CELLS - 1  # 53: v3's first grid target
    for head in ("target", "etgt", "scout_target"):
        for p in ("weight", "bias"):
            key, v = f"{head}.{p}", sd3[f"{head}.{p}"]
            w = zeros(key)
            w[:old0], w[S.TARGET_GRID0:] = v[:old0], v[old0:]
            if p == "bias":
                w[old0:S.TARGET_GRID0] = MEM_BIAS
            put(key, w)
    # Everything else with the same shape is copied; v4-only modules keep their fresh init.
    for key, v in sd3.items():
        if key in done:
            continue
        if key not in sd or sd[key].shape != v.shape:
            raise RuntimeError(f"no surgery rule for {key}: {tuple(v.shape)} → {tuple(sd[key].shape) if key in sd else 'missing'}")
        sd[key] = v.clone()
    return sd


def collect(agent, n_decisions: int = CHECK_DECISIONS) -> dict[str, np.ndarray]:
    """Every head's logits (export graphs: every choice it can be conditioned on), the LSTM state and the opponent
    model on the recorded states of CHECK_SLOTS, in this process's layout."""
    from training.env.vec_env_v2 import VecEnvV2
    from training.v2.batch import stack_obs, static_grid
    from training.v2.export_onnx import MAIN_OUT, Main, ScoutTail

    torch.backends.mha.set_fastpath_enabled(False)
    main, tail = Main(agent, scout=True), ScoutTail(agent)
    env = VecEnvV2(CHECK_SLOTS, n_procs=2, max_ticks=20000, critic=False)
    rec: dict[str, list] = {}
    try:
        cur = env.reset()
        state = [agent.zero_state(1, "cpu") for _ in cur]
        for d in range(n_decisions):
            for k, s in enumerate(cur):
                o = stack_obs([s.obs], [static_grid(env.static[s.slot])], [None])
                ent = np.zeros((1, S.PTR, S.ENTITY_F), dtype=np.float32)
                ent[:, :o["ent"].shape[1]] = o["ent"]
                t = {k_: torch.from_numpy(v) for k_, v in o.items() if k_ != "critic"}
                with torch.no_grad():
                    outs = main(t["globals"], t["z"], torch.from_numpy(ent), t["ent_n"], t["nodes"], t["memory"], t["grid"], *state[k])
                    state[k] = (outs[0], outs[1])
                    if d >= CHECK_FROM and (d - CHECK_FROM) % CHECK_EVERY == 0:
                        tl = tail(outs[3], outs[4], torch.tensor([O_ATTACK_MOVE]), torch.tensor([0]), torch.tensor([1.0]),
                                  torch.tensor([O_MOVE]))
                        for name, x in zip(MAIN_OUT + ["scoutOrder"] + ["target", "ptr", "scoutTarget", "scoutPtr"], list(outs) + list(tl)):
                            rec.setdefault(name, []).append(x.numpy().copy())
            out = env.step([None] * len(cur))
            assert not any(tr.done or tr.truncated for tr in out.transitions), "a check game ended early"
            cur = out.current
    finally:
        env.close()
    return {k: np.concatenate(v) for k, v in rec.items()}


def to_v3(rec: dict[str, np.ndarray], n_opp3: int) -> dict[str, np.ndarray]:
    """v4 outputs in v3 numbering: point targets without the new memory rows, the opponent model's old groups."""
    out = dict(rec)
    old0 = S.TARGET_GRID0 - (S.N_MEMORY - 16)
    for k in ("econTarget", "target", "scoutTarget"):
        x = rec[k]
        out[k] = np.concatenate([x[..., :old0], x[..., S.TARGET_GRID0:]], -1)
    out["opp"] = rec["opp"][..., :n_opp3]
    return out


def reference(src: str, out: str) -> None:
    """(v3 process) the source checkpoint's outputs on the check states."""
    from training.v2.model import Agent, load_weights

    a = Agent()
    load_weights(a, torch.load(src, map_location="cpu")["model"])
    np.savez(out, **collect(a.eval()))


def check(src: str, dst: str) -> bool:
    from training.v2.model import Agent, load_weights

    with tempfile.TemporaryDirectory() as tmp:
        ref_path = os.path.join(tmp, "v3.npz")
        subprocess.run([sys.executable, __file__, "--reference", src, ref_path], cwd=REPO, check=True,
                       env={**os.environ, "CF_LAYOUT": "v3"})
        ref = dict(np.load(ref_path))
    a = Agent()
    load_weights(a, torch.load(dst, map_location="cpu")["model"])
    got = to_v3(collect(a.eval()), ref["opp"].shape[-1])
    ok = True
    n = ref["econ"].shape[0]
    for k in ref:
        if got[k].shape != ref[k].shape:
            print(f"  {k}: shape {got[k].shape} vs {ref[k].shape}")
            ok = False
            continue
        d = float(np.abs(got[k] - ref[k]).max())
        rel = k in ("h1", "c1")  # the LSTM state (c is unbounded): relative to its size
        if rel:
            d /= max(1.0, float(np.abs(ref[k]).max()))
        ok &= d <= TOL
        print(f"  {'ok  ' if d <= TOL else 'FAIL'} {k:11s} {str(ref[k].shape[1:]):16s} max |Δ| {d:.2e}{' (relative)' if rel else ''}")
    print(f"{n} states: {'all within' if ok else 'NOT within'} {TOL}")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="v3 checkpoint")
    ap.add_argument("dst", help="v4 checkpoint to write")
    ap.add_argument("--check", action="store_true", help="compare the two networks on 200 replayed states")
    ap.add_argument("--reference", action="store_true", help=argparse.SUPPRESS)  # internal: v3 side of --check
    a = ap.parse_args()
    if a.reference:
        assert S.LAYOUT == "v3"
        reference(a.src, a.dst)
        return
    if S.LAYOUT != "v4":
        raise SystemExit("run with CF_LAYOUT=v4")
    ck = torch.load(a.src, map_location="cpu")
    sd = surgery(ck["model"], layout_names())
    Path(a.dst).parent.mkdir(parents=True, exist_ok=True)
    torch.save({"model": sd, "surgery": {"from": a.src, "layout": "v4"}, "config": ck.get("config", {})}, a.dst)
    print(f"wrote {a.dst}")
    if a.check and not check(a.src, a.dst):
        sys.exit(1)


if __name__ == "__main__":
    main()
