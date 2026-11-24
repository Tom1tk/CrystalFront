"""
Sizes and layout of observation v2 (schema 5) / action space v7 (headless/src/v2/observation.ts,
headless/src/v2/actions.ts). `check_sizes` compares them with a live observation.
"""
import os

# Observation
N_GLOBALS = 61
ENTITY_F = 36
N_NODES, NODE_F = 20, 13
N_MEMORY, MEMORY_F = 16, 15
GRID_DYN_C, GRID_STATIC_C, GRID_ROWS, GRID_COLS = 5, 5, 15, 50
GRID_CELLS = GRID_ROWS * GRID_COLS
N_Z = 32                       # strategy token embedding size (z < N_Z)

# Actions
ECON = 63
N_BUILDINGS, BUILD_SITES = 5, 760
PTR = 200
ECON_PTR_KINDS = 3
TARGETS = 804
N_GROUPS, N_ORDERS = 11, 12
ECON_BUILD0, ECON_ASSIGN0, ECON_REPAIR, ECON_RALLY = 7, 12, 60, 61
GROUP_UNIT = 10
GROUP_SCOUT = 9  # the Outrider (v3)
TARGET_NONE = 803
TARGET_GRID0 = 53              # 37 anchors + 16 memory slots, then the 750 grid cells
NAMED_SITES = 10               # then 750 grid build sites
POINT_ORDERS = (1, 2, 3)       # attack_move, move, guard
PTR_ORDERS = (6, 7, 11)        # focus, heal, cover

# Mainline 0.10 (beta ruleset): observation v3 (schema 7) / action space v8 from headless/src/v3,
# selected with CF_LAYOUT=v3 before anything imports this module. Adds the Outrider (a unit type,
# a train action, an opponent-model unit) and the Surge globals; see training/v3_surgery.py.
LAYOUT = os.environ.get("CF_LAYOUT", "v2")
if LAYOUT not in ("v2", "v3"):
    raise RuntimeError(f"CF_LAYOUT={LAYOUT!r}: expected v2 or v3")
if LAYOUT == "v3":
    N_GLOBALS, ENTITY_F, ECON = 68, 37, 64
    ECON_BUILD0, ECON_ASSIGN0, ECON_REPAIR, ECON_RALLY = 8, 13, 61, 62

# Maps (server/src/match/pool/manifest.json). The held-out maps must never be
# used for imitation data, training or hyperparameter selection.
HELD_OUT_MAPS = ("prism-ridge", "duskvale")
TRAIN_MAPS = ("shardfall", "basalt-run", "twin-spires", "hollow-crown", "glimmerfen", "saltmarsh", "ironreed", "cinder-flats")

# Opponent-model labels (observation.ts oppLabels): counts binned 0, 1, 2, 3-4, 5-8, 9+;
# army location as the nearest of the 37 anchor targets, or 37 = none seen.
OPP_UNITS, OPP_BUILDINGS = (7 if LAYOUT == "v3" else 6), 5
OPP_BINS = 6
N_ANCHORS = 37

# Reward components (headless/src/v2/rewards.ts)
SHAPED_KEYS = ("res", "army", "dmg", "ctrl")
DECISION_TICKS = 8
TICKS_PER_MINUTE = 600


def check_sizes(obs: dict, masks: dict) -> None:
    """Fail loudly if the runner's layout differs from these constants."""
    got = {
        "globals": len(obs["globals"]), "nodes": (len(obs["nodes"]), len(obs["nodes"][0])),
        "memory": (len(obs["memory"]), len(obs["memory"][0])), "grid": len(obs["grid"]),
        "econ": len(masks["econ"]), "site": (len(masks["site"]), len(masks["site"][0])),
        "econPtr": (len(masks["econPtr"]), len(masks["econPtr"][0])), "econTarget": len(masks["econTarget"]),
        "group": len(masks["group"]), "order": (len(masks["order"]), len(masks["order"][0])),
        "unit": (len(masks["unit"]), len(masks["unit"][0])), "target": (len(masks["target"]), len(masks["target"][0])),
        "ptr": (len(masks["ptr"]), len(masks["ptr"][0])),
    }
    want = {
        "globals": N_GLOBALS, "nodes": (N_NODES, NODE_F), "memory": (N_MEMORY, MEMORY_F), "grid": GRID_DYN_C * GRID_CELLS,
        "econ": ECON, "site": (N_BUILDINGS, BUILD_SITES), "econPtr": (ECON_PTR_KINDS, PTR), "econTarget": TARGETS,
        "group": N_GROUPS, "order": (N_GROUPS, N_ORDERS), "unit": (N_ORDERS, PTR), "target": (N_ORDERS, TARGETS),
        "ptr": (N_ORDERS, PTR),
    }
    bad = {k: (got[k], want[k]) for k in want if got[k] != want[k]}
    if obs["entities"] and len(obs["entities"][0]) != ENTITY_F:
        bad["entities"] = (len(obs["entities"][0]), ENTITY_F)
    if bad:
        raise RuntimeError(f"observation/action layout changed (got, expected): {bad} — update training/v2/spaces.py")


def check_layout(layout: dict) -> None:
    """Packed mode: the same check against the shapes the runner reports in `ready`."""
    sh = lambda v: v[0] if len(v) == 1 else tuple(v)
    got = {"globals": layout["globals"], "nodes": tuple(layout["nodes"]), "memory": tuple(layout["memory"]), "grid": layout["grid"],
           "entities": layout["entityF"], **{k: sh(v) for k, v in layout["masks"]}}
    want = {
        "globals": N_GLOBALS, "nodes": (N_NODES, NODE_F), "memory": (N_MEMORY, MEMORY_F), "grid": GRID_DYN_C * GRID_CELLS,
        "entities": ENTITY_F,
        "econ": ECON, "site": (N_BUILDINGS, BUILD_SITES), "econPtr": (ECON_PTR_KINDS, PTR), "econTarget": TARGETS,
        "group": N_GROUPS, "order": (N_GROUPS, N_ORDERS), "unit": (N_ORDERS, PTR), "target": (N_ORDERS, TARGETS),
        "ptr": (N_ORDERS, PTR), **({"scoutOrder": N_ORDERS} if LAYOUT == "v3" else {}),
    }
    bad = {k: (got.get(k), want[k]) for k in want if got.get(k) != want[k]}
    if [k for k, _ in layout["masks"]] != ["econ", "site", "econPtr", "econTarget", "group", "order", "unit", "target", "ptr"] + (["scoutOrder"] if LAYOUT == "v3" else []):
        bad["mask order"] = [k for k, _ in layout["masks"]]
    if bad:
        raise RuntimeError(f"packed layout changed (got, expected): {bad} — update training/v2/spaces.py")
