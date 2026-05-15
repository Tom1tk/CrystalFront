"""
Crystal Front Gymnasium environment.

Wraps one Node.js stdio subprocess (headless/src/stdioRunner.ts).
Blue = policy agent, Red = scripted opponent.

Observation space: Dict with:
  global      (12,)             -- normalised scalar game state
  entities    (MAX_ENTITIES,11) -- per-entity features (raw, incl. typeIndex)
  entity_mask (MAX_ENTITIES,)   -- True where slot is occupied
  nodes       (MAX_NODES,5)     -- per-node features
  node_mask   (MAX_NODES,)      -- True where slot is occupied

Action space: Discrete(73) -- see headless/src/actionIndex.ts

Legal mask is returned in info["legal_mask"] (bool[73]).  The policy should
zero out illegal logits before sampling.
"""

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np

# ── constants matching TypeScript types.ts / actionIndex.ts ─────────────────

GLOBAL_DIM    = 12
ENTITY_DIM    = 11   # raw features per entity (typeIndex as scalar 0-9)
NODE_DIM      = 5
MAX_ENTITIES  = 64
MAX_NODES     = 8
ACTION_SPACE_SIZE = 73

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
                 startup_delay: float = 0.0):
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
        self._proc: subprocess.Popen | None = None
        self._episode_count = 0
        self._last_legal_mask = np.ones(ACTION_SPACE_SIZE, dtype=bool)
        self._current_opponent = opponent  # may change per reset in league mode

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
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()

    def _recv(self) -> dict:
        assert self._proc and self._proc.stdout
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("Node subprocess exited unexpectedly")
        msg = json.loads(line.strip())
        if msg.get("type") == "error":
            raise RuntimeError(f"Node error: {msg['message']}")
        return msg

    # ── gym interface ─────────────────────────────────────────────────────────

    def reset(self, seed: int | None = None, options: dict | None = None):
        super().reset(seed=seed)
        self._ensure_proc()

        # Allow per-reset opponent override (Phase 4 league training).
        # options["opponent"] takes precedence over self.opponent.
        opponent = self.opponent
        if options is not None and "opponent" in options:
            opponent = options["opponent"]

        self._episode_count += 1
        rng_seed = int(seed) if seed is not None else int(np.random.randint(0, 2**31))
        do_save = (
            self.save_replay_every > 0
            and self._episode_count % self.save_replay_every == 0
        )
        self._send({"type": "reset", "seed": rng_seed, "opponent": opponent, "save_replay": do_save})


        # Store the active opponent so callers can inspect it.
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

        # Entities
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
