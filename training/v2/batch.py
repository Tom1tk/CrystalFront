"""
Observation and mask batching for the v2 learner.

Observations become fixed-size numpy arrays, except entities, which are padded
to the largest row count in the batch (pointer logits are padded back to PTR).
The static grid comes once per episode (`VecEnvV2.static`) and is concatenated
with the dynamic grid channels.
"""
from __future__ import annotations

import numpy as np

from training.v2 import spaces as S

OBS_KEYS = ("globals", "z", "ent", "ent_n", "nodes", "memory", "grid", "critic")


def static_grid(static: dict) -> np.ndarray:
    return np.asarray(static["data"], dtype=np.float32).reshape(S.GRID_STATIC_C, S.GRID_ROWS, S.GRID_COLS)


def stack_obs(obs_list: list[dict], statics: list[np.ndarray], critics: list[dict | None]) -> dict[str, np.ndarray]:
    """obs_list[i] is a stream's `obs`, statics[i] its slot's static grid, critics[i] its `critic` (or None)."""
    b = len(obs_list)
    n_max = max(1, max(len(o["entities"]) for o in obs_list))
    ent = np.zeros((b, n_max, S.ENTITY_F), dtype=np.float32)
    ent_n = np.zeros(b, dtype=np.int64)
    for i, o in enumerate(obs_list):
        n = len(o["entities"])
        if n:
            ent[i, :n] = o["entities"]
        ent_n[i] = n
    dyn = np.asarray([o["grid"] for o in obs_list], dtype=np.float32).reshape(b, S.GRID_DYN_C, S.GRID_ROWS, S.GRID_COLS)
    grid = np.concatenate([dyn, np.stack(statics)], axis=1)
    critic = np.zeros((b, 2 * S.N_GLOBALS), dtype=np.float32)
    full = {}
    if S.FULL_CRITIC:
        # Packed: {globals (2 × N_GLOBALS), nodes, grid, entities}; JSON: the runner's {self, enemy} blocks.
        cs = [None if c is None else c if "globals" in c else
              {"globals": np.concatenate([c["self"]["globals"], c["enemy"]["globals"]]), "nodes": c["self"]["nodes"],
               "grid": c["self"]["grid"], "entities": c["self"]["entities"]} for c in critics]
        nc = max([1] + [len(c["entities"]) for c in cs if c is not None])
        c_ent = np.zeros((b, nc, S.ENTITY_F), dtype=np.float32)
        c_ent_n = np.zeros(b, dtype=np.int64)
        c_nodes = np.zeros((b, S.N_NODES, S.NODE_F), dtype=np.float32)
        c_dyn = np.zeros((b, S.GRID_DYN_C, S.GRID_ROWS, S.GRID_COLS), dtype=np.float32)
        for i, c in enumerate(cs):
            if c is None:
                continue
            critic[i] = c["globals"]
            n = len(c["entities"])
            if n:
                c_ent[i, :n] = c["entities"]
            c_ent_n[i] = n
            c_nodes[i] = c["nodes"]
            c_dyn[i] = np.asarray(c["grid"], dtype=np.float32).reshape(S.GRID_DYN_C, S.GRID_ROWS, S.GRID_COLS)
        full = {"c_ent": c_ent, "c_ent_n": c_ent_n, "c_nodes": c_nodes, "c_grid": np.concatenate([c_dyn, np.stack(statics)], axis=1)}
    else:
        for i, c in enumerate(critics):
            if isinstance(c, np.ndarray):  # packed: [own globals | enemy globals]
                critic[i] = c
            elif c is not None:
                critic[i, :S.N_GLOBALS] = c["self"]["globals"]
                critic[i, S.N_GLOBALS:] = c["enemy"]["globals"]
    return {**full,
        "globals": np.asarray([o["globals"] for o in obs_list], dtype=np.float32),
        "z": np.asarray([o["z"] for o in obs_list], dtype=np.int64),
        "ent": ent, "ent_n": ent_n,
        "nodes": np.asarray([o["nodes"] for o in obs_list], dtype=np.float32),
        "memory": np.asarray([o["memory"] for o in obs_list], dtype=np.float32),
        "grid": grid, "critic": critic,
    }


MASK_KEYS = ("econ", "site", "econPtr", "econTarget", "group", "order", "unit", "target", "ptr") + (("scoutOrder",) if S.SCOUT_SLOT else ())


MASK_SHAPES = {
    "econ": (S.ECON,), "site": (S.N_BUILDINGS, S.BUILD_SITES), "econPtr": (S.ECON_PTR_KINDS, S.PTR), "econTarget": (S.TARGETS,),
    "group": (S.N_GROUPS,), "order": (S.N_GROUPS, S.N_ORDERS), "unit": (S.N_ORDERS, S.PTR), "target": (S.N_ORDERS, S.TARGETS),
    "ptr": (S.N_ORDERS, S.PTR), "scoutOrder": (S.N_ORDERS,),
}


def stack_masks(mask_list: list) -> dict[str, np.ndarray]:
    """Per-stream masks: dicts of lists (JSON mode) or packed uint8 bit strings (packed mode)."""
    if not isinstance(mask_list[0], np.ndarray):
        return {k: np.asarray([m[k] for m in mask_list], dtype=bool) for k in MASK_KEYS}
    bits = np.unpackbits(np.stack(mask_list), axis=1).view(bool)
    out, k = {}, 0
    for key in MASK_KEYS:
        shape = MASK_SHAPES[key]
        n = int(np.prod(shape))
        out[key] = bits[:, k:k + n].reshape(len(mask_list), *shape)
        k += n
    return out


def pad_entities(chunks: list[np.ndarray]) -> np.ndarray:
    """Concatenate (b_i, n_i, F) entity arrays along the batch, padding n to the max."""
    n = max(c.shape[1] for c in chunks)
    out = np.zeros((sum(c.shape[0] for c in chunks), n, chunks[0].shape[2]), dtype=chunks[0].dtype)
    o = 0
    for c in chunks:
        out[o:o + c.shape[0], :c.shape[1]] = c
        o += c.shape[0]
    return out
