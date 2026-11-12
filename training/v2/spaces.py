"""
Sizes and layout of observation v2 / action space v3 (headless/src/v2/observation.ts,
headless/src/v2/actions.ts). `check_sizes` compares them with a live observation.
"""

# Observation
N_GLOBALS = 51
ENTITY_F = 32
N_NODES, NODE_F = 20, 13
N_MEMORY, MEMORY_F = 16, 14
GRID_DYN_C, GRID_STATIC_C, GRID_ROWS, GRID_COLS = 5, 5, 15, 50
GRID_CELLS = GRID_ROWS * GRID_COLS
N_Z = 32                       # strategy token embedding size (z < N_Z)

# Actions
ECON = 61
N_BUILDINGS, BUILD_SITES = 4, 760
PTR = 200
ECON_PTR_KINDS = 3
TARGETS = 804
N_GROUPS, N_ORDERS = 10, 11
ECON_BUILD0, ECON_ASSIGN0, ECON_REPAIR, ECON_RALLY = 6, 10, 58, 59
GROUP_UNIT = 9
TARGET_NONE = 803
TARGET_GRID0 = 53              # 37 anchors + 16 memory slots, then the 750 grid cells
NAMED_SITES = 10               # then 750 grid build sites
POINT_ORDERS = (1, 2, 3)       # attack_move, move, guard
PTR_ORDERS = (6, 7)            # focus, heal

# Maps (server/src/match/pool/manifest.json). The held-out maps must never be
# used for imitation data, training or hyperparameter selection.
HELD_OUT_MAPS = ("prism-ridge", "duskvale")
TRAIN_MAPS = ("shardfall", "basalt-run", "twin-spires", "hollow-crown", "glimmerfen", "saltmarsh", "ironreed", "cinder-flats")

# Opponent-model labels (observation.ts oppLabels)
OPP_UNITS, OPP_BUILDINGS = 5, 4

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
