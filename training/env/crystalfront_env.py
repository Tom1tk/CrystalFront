"""
Crystal Front Gymnasium environment.

Wraps one Node.js stdio subprocess (headless/src/stdioRunner.ts).
Blue = policy agent, Red = scripted opponent.

Observation space: Dict with:
  global      (22,)             -- normalised scalar game state (v0.1.57: 18→22)
  entities    (MAX_ENTITIES,12) -- per-entity features (v0.1.57: 11→12, added inAttackRange)
  entity_mask (MAX_ENTITIES,)   -- True where slot is occupied
  nodes       (MAX_NODES,5)     -- per-node features
  node_mask   (MAX_NODES,)      -- True where slot is occupied

Action space: Discrete(81) -- see headless/src/actionIndex.ts (v0.2.3-ML: 58→66 → 71)

Legal mask is returned in info["legal_mask"] (bool[81]).  The policy should
zero out illegal logits before sampling.
"""

import os
import subprocess
import time
from pathlib import Path
from typing import Any

try:
    import orjson
    def _json_loads(b):  return orjson.loads(b)
    def _json_dumps(obj): return orjson.dumps(obj).decode() + "\n"
except ImportError:
    import json as _json
    def _json_loads(b):  return _json.loads(b)
    def _json_dumps(obj): return _json.dumps(obj) + "\n"

import gymnasium as gym
import numpy as np

# ── constants matching TypeScript types.ts / actionIndex.ts ─────────────────

GLOBAL_DIM    = 22   # 18 base + 4 threat geometry features (v0.1.57)
ENTITY_DIM    = 12   # raw features per entity (v0.1.57: +inAttackRange)
NODE_DIM      = 5
MAX_ENTITIES  = 64
MAX_NODES     = 8
ACTION_SPACE_SIZE = 81  # v0.2.3-ML: 58→66 → 71 (targeting_friend, spread_fire × 4 groups)

REPO_ROOT = Path(__file__).resolve().parents[2]
TSX_BIN   = str(REPO_ROOT / "node_modules/.bin/tsx")
RUNNER    = str(REPO_ROOT / "headless/src/stdioRunner.ts")

# Global field order (must match buildObservation → GlobalFeatures in types.ts)
GLOBAL_KEYS = [
    "ownResources", "ownSupply", "ownMaxSupply", "oppVisibleSupply",
    "tick", "scoreDiff",
    "ownCrystalHealthFrac", "oppCrystalHealthFrac",
    "ownResourcesWinFrac", "oppResourcesWinFrac",
    "ownLifetimeResourcesFrac", "oppLifetimeResourcesFrac",
    # Enemy composition (v0.1.49)
    "enemyWorkerCount", "enemySkirmisherCount", "enemyBruiserCount",
    "enemyBarracksCount", "enemyTurretCount", "enemyForwardUnitFrac",
    # Threat geometry (v0.1.57)
    "nearestEnemyToCrystalDistNorm", "ownCombatInOwnHalf",
    "enemyCombatInOwnHalf", "totalVisibleEnemyCombat",
]


class CrystalFrontEnv(gym.Env):
    """Single-agent Crystal Front env driven by a Node.js subprocess."""

    metadata = {"render_modes": []}

    observation_space = gym.spaces.Dict({
        "global":      gym.spaces.Box(-np.inf, np.inf, (GLOBAL_DIM,),              dtype=np.float32),
        "entities":    gym.spaces.Box(-np.inf, np.inf, (MAX_ENTITIES, ENTITY_DIM), dtype=np.float32),
        "entity_mask": gym.spaces.Box(0, 1,            (MAX_ENTITIES,),            dtype=np.bool_),
        "nodes":       gym.spaces.Box(-np.inf, np.inf, (MAX_NODES, NODE_DIM),      dtype=np.float32),
        "node_mask":   gym.spaces.Box(0, 1,            (MAX_NODES,),               dtype=np.bool_),
    })
    action_space = gym.spaces.Discrete(ACTION_SPACE_SIZE)

    def __init__(self, opponent: str = "macro", save_replay_every: int = 0,
                 startup_delay: float = 0.0, demo_bot: str | None = None):
        """
        Args:
            opponent:          scripted bot to play against
            save_replay_every: save a replay every N episodes (0 = never)
            startup_delay:     seconds to wait before spawning the subprocess
                               (stagger env startups to avoid simultaneous tsx spikes)
        """
        super().__init__()
        self.opponent = opponent
        self.save_replay_every = save_replay_every
        self._startup_delay = startup_delay
        self._demo_bot = demo_bot
        self._proc: subprocess.Popen | None = None
        self._episode_count = 0
        self._last_legal_mask = np.ones(ACTION_SPACE_SIZE, dtype=bool)
        self._current_opponent = opponent

    # ── lifecycle ─────────────────────────────────────────────────────────────

    def _ensure_proc(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        if self._startup_delay > 0:
            time.sleep(self._startup_delay)
            self._startup_delay = 0.0  # only delay once
        self._proc = subprocess.Popen(
            [TSX_BIN, RUNNER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            cwd=str(REPO_ROOT),
        )

    def close(self) -> None:
        if self._proc is not None:
            try:
                self._send({"type": "close"})
            except Exception:
                pass
            self._proc.kill()
            self._proc = None

    # ── communication ─────────────────────────────────────────────────────────

    def _send(self, msg: dict) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write(_json_dumps(msg))
        self._proc.stdin.flush()

    def _recv(self) -> dict:
        assert self._proc and self._proc.stdout
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("Node subprocess exited unexpectedly")
        msg = _json_loads(line.strip())
        if msg.get("type") == "error":
            raise RuntimeError(f"Node error: {msg['message']}")
        return msg

    # ── gym interface ─────────────────────────────────────────────────────────

    def reset(self, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        self._ensure_proc()

        # Allow per-reset opponent override (Phase 4 league training).
        opponent = self.opponent
        if options is not None and "opponent" in options:
            opponent = options["opponent"]

        # Opponent sampling modes
        if opponent == "random":
            import random as _random
            opponent = _random.choice(["idle", "rush", "turtle", "macro"])
        elif opponent == "combat":
            import random as _random
            opponent = _random.choice(["rush", "macro"])
        elif opponent == "combat_weak":
            # Phase 1 curriculum: learn basic combat vs weak opponents
            import random as _random
            opponent = _random.choice(["idle", "turtle", "rush_weak"])
        elif opponent == "combat_medium":
            # Phase 2 curriculum: scale up combat vs medium opponents
            import random as _random
            opponent = _random.choice(["turtle", "rush_weak", "rush_medium", "macro"])
        # passive: single known-beatable bot — no sampling needed

        self._episode_count += 1
        rng_seed = int(seed) if seed is not None else int(np.random.randint(0, 2**31))
        do_save = (
            self.save_replay_every > 0
            and self._episode_count % self.save_replay_every == 0
        )
        msg_reset: dict = {"type": "reset", "seed": rng_seed, "opponent": opponent, "save_replay": do_save}
        if self._demo_bot:
            msg_reset["demo_bot"] = self._demo_bot
        self._send(msg_reset)

        self._current_opponent = opponent
        msg = self._recv()
        assert msg["type"] == "ready", f"Expected 'ready', got {msg['type']}"
        obs = self._parse_obs(msg["obs"])
        self._last_legal_mask = np.array(msg["legalMask"], dtype=bool)
        return obs, {"legal_mask": self._last_legal_mask.copy()}

    def step(self, action: int):
        self._send({"type": "step", "action": int(action)})
        msg = self._recv()
        assert msg["type"] == "step_result", f"Expected 'step_result', got {msg['type']}"
        obs    = self._parse_obs(msg["obs"])
        reward = float(msg["reward"])
        done   = bool(msg["done"])
        self._last_legal_mask = np.array(msg["legalMask"], dtype=bool)
        info = dict(msg.get("info", {}))
        info["legal_mask"] = self._last_legal_mask.copy()
        return obs, reward, done, False, info  # (obs, reward, terminated, truncated, info)

    # ── observation encoding ──────────────────────────────────────────────────

    def _parse_obs(self, raw: dict) -> dict:
        # Global: extract fields in canonical order
        g = raw["global"]
        global_vec = np.array([g[k] for k in GLOBAL_KEYS], dtype=np.float32)

        # Entities (12 features, including new inAttackRange)
        ents = raw.get("entities", [])
        entity_mat  = np.zeros((MAX_ENTITIES, ENTITY_DIM), dtype=np.float32)
        entity_mask = np.zeros(MAX_ENTITIES, dtype=bool)
        for i, e in enumerate(ents[:MAX_ENTITIES]):
            entity_mat[i] = [
                e["typeIndex"],
                e["owner"],
                e["xNorm"], e["yNorm"],
                e["healthFrac"],
                e["constructionFrac"],
                float(e["isAttacking"]),
                float(e["isMoving"]),
                float(e["isGathering"]),
                float(e["isBuilding"]),
                e["attackCooldownNorm"],
                float(e.get("inAttackRange", False)),  # v0.1.57
            ]
            entity_mask[i] = True

        # Nodes
        node_list = raw.get("nodes", [])
        node_mat  = np.zeros((MAX_NODES, NODE_DIM), dtype=np.float32)
        node_mask = np.zeros(MAX_NODES, dtype=bool)
        for i, n in enumerate(node_list[:MAX_NODES]):
            node_mat[i] = [
                n["xNorm"], n["yNorm"],
                n["remainingFrac"],
                float(n["gathererCount"]),
                float(n["isContested"]),
            ]
            node_mask[i] = True

        return {
            "global":      global_vec,
            "entities":    entity_mat,
            "entity_mask": entity_mask,
            "nodes":       node_mat,
            "node_mask":   node_mask,
        }
