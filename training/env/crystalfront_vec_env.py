"""
Vectorised Crystal Front environment.

Wraps ONE Node.js subprocess running N matches simultaneously via stdioVecRunner.
Blue = policy agent, Red = scripted opponent.

- reset() → list of (obs, info) length N
- step(actions) → list of (obs, reward, done, truncated, info) length N

On done, the slot is IMMEDIATELY autoreset inside Node.  The returned obs/legalMask
is from the fresh episode.  Python does NOT call reset() on done envs.

The legal_mask for the NEW episode is in info["legal_mask"] for done slots.
"""

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np

try:
    import orjson
    def _loads(b: str | bytes) -> dict:   return orjson.loads(b)
    def _dumps(obj: dict) -> str:         return orjson.dumps(obj).decode() + "\n"
except ImportError:
    def _loads(b: str | bytes) -> dict:   return json.loads(b)
    def _dumps(obj: dict) -> str:         return json.dumps(obj) + "\n"

GLOBAL_DIM    = 22
ENTITY_DIM    = 12
NODE_DIM      = 5
MAX_ENTITIES  = 64
MAX_NODES     = 8
ACTION_SPACE_SIZE = 81

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_BIN  = str(REPO_ROOT / "node_modules/.bin/tsx")
VEC_RUNNER_TS  = str(REPO_ROOT / "headless/src/stdioVecRunner.ts")
VEC_RUNNER_JS  = str(REPO_ROOT / "headless/dist/stdioVecRunner.js")

GLOBAL_KEYS = [
    "ownResources", "ownSupply", "ownMaxSupply", "oppVisibleSupply",
    "tick", "scoreDiff",
    "ownCrystalHealthFrac", "oppCrystalHealthFrac",
    "ownResourcesWinFrac", "oppResourcesWinFrac",
    "ownLifetimeResourcesFrac", "oppLifetimeResourcesFrac",
    "enemyWorkerCount", "enemySkirmisherCount", "enemyBruiserCount",
    "enemyBarracksCount", "enemyTurretCount", "enemyForwardUnitFrac",
    "nearestEnemyToCrystalDistNorm", "ownCombatInOwnHalf",
    "enemyCombatInOwnHalf", "totalVisibleEnemyCombat",
]


class CrystalFrontVecEnv:
    """Single Node process running vec_size games simultaneously."""

    def __init__(
        self,
        vec_size: int = 4,
        opponent: str = "idle",
        save_replay_every: int = 0,
        startup_delay: float = 0.0,
        config_overrides: dict | None = None,
        max_ticks: int = 6000,
    ):
        self.vec_size          = vec_size
        self.opponent          = opponent
        self.save_replay_every = save_replay_every
        self._startup_delay    = startup_delay
        self._config_overrides = config_overrides or {}
        self._max_ticks        = max_ticks
        self._proc: subprocess.Popen | None = None
        self._last_legal_masks = [np.ones(ACTION_SPACE_SIZE, dtype=bool)] * vec_size

    # ── lifecycle ─────────────────────────────────────────────────────────────

    def _ensure_proc(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        if self._startup_delay > 0:
            time.sleep(self._startup_delay)
            self._startup_delay = 0.0
        # Use pre-compiled JS if available; fall back to tsx
        if Path(VEC_RUNNER_JS).exists():
            cmd = ["/root/.local/bin/node", VEC_RUNNER_JS]
        else:
            cmd = [NODE_BIN, VEC_RUNNER_TS]
        self._proc = subprocess.Popen(
            cmd,
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
        self._proc.stdin.write(_dumps(msg))
        self._proc.stdin.flush()

    def _recv(self) -> dict:
        assert self._proc and self._proc.stdout
        line = self._proc.stdout.readline()
        if not line:
            raise RuntimeError("Vec Node subprocess exited unexpectedly")
        msg = _loads(line.strip())
        if msg.get("type") == "error":
            raise RuntimeError(f"Node error: {msg['message']}")
        return msg

    # ── gym-like interface ────────────────────────────────────────────────────

    def reset(self, seeds: list[int] | None = None, options: list[dict] | None = None):
        """Returns list of (obs, info) tuples, length vec_size."""
        self._ensure_proc()

        if seeds is None:
            seeds = [int(np.random.randint(0, 2**31)) for _ in range(self.vec_size)]

        opponents = []
        for i in range(self.vec_size):
            opp = self.opponent
            if options is not None and options[i] and "opponent" in options[i]:
                opp = options[i]["opponent"]
            opponents.append(self._resolve_opponent(opp))

        save_replays = [False] * self.vec_size

        msg: dict = {
            "type":             "reset_all",
            "seeds":            seeds,
            "opponents":        opponents,
            "save_replays":     save_replays,
            "save_replay_every": self.save_replay_every,
            "max_ticks":        self._max_ticks,
        }
        if self._config_overrides:
            msg["config_overrides"] = self._config_overrides
        self._send(msg)
        msg = self._recv()
        assert msg["type"] == "ready", f"Expected 'ready', got {msg['type']}"

        results = []
        for i, slot in enumerate(msg["slots"]):
            obs  = self._parse_obs(slot["obs"])
            mask = np.array(slot["legalMask"], dtype=bool)
            self._last_legal_masks[i] = mask
            results.append((obs, {"legal_mask": mask.copy()}))
        return results

    def step(self, actions: list[int]):
        """
        Send vec_size actions, receive vec_size results.
        Returns list of (obs, reward, done, truncated, info).
        On done, obs is from the freshly-reset new episode.
        """
        self._send({"type": "step", "actions": actions})
        msg = self._recv()
        assert msg["type"] == "step_result", f"Expected 'step_result', got {msg['type']}"

        results = []
        for i, slot in enumerate(msg["slots"]):
            obs   = self._parse_obs(slot["obs"])
            mask  = np.array(slot["legalMask"], dtype=bool)
            self._last_legal_masks[i] = mask
            info  = dict(slot.get("info", {}))
            info["legal_mask"] = mask.copy()
            results.append((obs, float(slot["reward"]), bool(slot["done"]), False, info))
        return results

    # ── observation parsing ───────────────────────────────────────────────────

    def _parse_obs(self, raw: dict) -> dict:
        g = raw["global"]
        global_vec = np.array([g[k] for k in GLOBAL_KEYS], dtype=np.float32)

        ents = raw.get("entities", [])
        entity_mat  = np.zeros((MAX_ENTITIES, ENTITY_DIM), dtype=np.float32)
        entity_mask = np.zeros(MAX_ENTITIES, dtype=bool)
        for i, e in enumerate(ents[:MAX_ENTITIES]):
            entity_mat[i] = [
                e["typeIndex"], e["owner"],
                e["xNorm"], e["yNorm"],
                e["healthFrac"], e["constructionFrac"],
                float(e["isAttacking"]), float(e["isMoving"]),
                float(e["isGathering"]), float(e["isBuilding"]),
                e["attackCooldownNorm"],
                float(e.get("inAttackRange", False)),
            ]
            entity_mask[i] = True

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

    def _resolve_opponent(self, opp: str) -> str:
        import random as _random
        if opp == "random":
            return _random.choice(["idle", "rush", "turtle", "macro"])
        if opp == "combat":
            return _random.choice(["rush", "macro"])
        if opp == "combat_weak":
            return _random.choice(["idle", "turtle", "rush_weak"])
        if opp == "combat_medium":
            return _random.choice(["turtle", "rush_weak", "rush_medium", "macro"])
        return opp
