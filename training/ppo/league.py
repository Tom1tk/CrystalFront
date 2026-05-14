"""
Crystal Front League Manager — Phase 4.

Manages a pool of opponents (scripted bots + historical checkpoints) for
PPO training.  Opponents are sampled with Prioritised Fictitious Self-Play
(PFSP) weighting: opponents the current agent struggles to beat are sampled
more often, creating a natural curriculum.

Reference:
  Vinyals et al., "Grandmaster level in StarCraft II using multi-agent
  reinforcement learning" (Nature, 2019) — Section "League Training".
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np


# ── constants ─────────────────────────────────────────────────────────────────

# Scripted bot names accepted by the Node.js stdio runner.
SCRIPTED_BOTS = ["idle", "rush", "turtle", "macro"]

# Minimum priority floor — ensures every active opponent gets some play,
# preventing the distribution from collapsing onto a single opponent.
MIN_PRIORITY = 0.01


# ── data ──────────────────────────────────────────────────────────────────────

@dataclass
class OpponentRecord:
    """Metadata for one opponent in the league pool."""
    name: str                     # e.g. "idle", "rush", "checkpoint_000050"
    type: str                     # "scripted" or "checkpoint"
    bot_name: Optional[str] = None       # for scripted: "idle", "rush", etc.
    checkpoint_path: Optional[str] = None  # for checkpoint: path to .pt file
    added_at_update: int = 0      # training update when added to pool
    active: bool = True           # can be played?  checkpoints need ONNX (Phase 6)


@dataclass
class LeagueState:
    """Serialisable league state for save/load."""
    opponents: dict[str, OpponentRecord] = field(default_factory=dict)
    win_counts: dict[str, int] = field(default_factory=dict)
    total_counts: dict[str, int] = field(default_factory=dict)
    current_update: int = 0
    pfsp_temperature: float = 0.5
    add_interval: int = 100


# ── manager ───────────────────────────────────────────────────────────────────

class LeagueManager:
    """
    Manages opponent pool, PFSP sampling, and win-rate tracking.

    Usage in train.py::

        league = LeagueManager(num_envs=8, pfsp_temperature=0.5, add_interval=100)
        for update in range(num_updates):
            # Sample opponents for this rollout (per-env)
            opponents = league.sample_opponents(cfg.num_envs)

            # When an episode ends:
            league.record_result(opponent_name, won=(winner == "headless-blue"))

            # After the PPO update:
            league.step_update(update, checkpoint_path)
    """

    def __init__(
        self,
        num_envs: int = 8,
        pfsp_temperature: float = 0.5,
        add_interval: int = 100,
        results_dir: str = "runs",
        seed_bots: Optional[list[str]] = None,
    ):
        if seed_bots is None:
            seed_bots = list(SCRIPTED_BOTS)

        self.num_envs = num_envs
        self.results_dir = Path(results_dir)

        self.state = LeagueState(
            pfsp_temperature=pfsp_temperature,
            add_interval=add_interval,
        )

        # Seed with scripted bots
        for bot_name in seed_bots:
            if bot_name in SCRIPTED_BOTS:
                self.state.opponents[bot_name] = OpponentRecord(
                    name=bot_name,
                    type="scripted",
                    bot_name=bot_name,
                    active=True,
                )

        # Per-episode tracking (cleared each rollout)
        self._episode_opponents: dict[int, str] = {}   # env_idx → opponent name
        self._ready_for_episode: set[int] = set()       # env_idx has been sampled

    # ── sampling ──────────────────────────────────────────────────────────────

    def sample_opponent(self, seed: int | None = None) -> str:
        """
        Sample ONE opponent name with PFSP weighting.

        Weight ∝ (1 − win_rate) ^ pfsp_temperature, clipped to MIN_PRIORITY.
        """
        rng = np.random.default_rng(seed)
        active = [o for o in self.state.opponents.values() if o.active]

        if not active:
            # Fallback — should never happen; always at least one scripted bot
            return SCRIPTED_BOTS[0]

        if len(active) == 1:
            return active[0].name

        weights = []
        for opp in active:
            total = self.state.total_counts.get(opp.name, 0)
            wins = self.state.win_counts.get(opp.name, 0)
            win_rate = wins / max(total, 1)
            priority = max(MIN_PRIORITY, 1.0 - win_rate)
            weights.append(priority ** self.state.pfsp_temperature)

        total_w = sum(weights)
        probs = np.array(weights) / total_w
        idx = rng.choice(len(active), p=probs)
        return active[idx].name

    def sample_opponents(self, n: int) -> list[str]:
        """Sample n opponent names with PFSP weighting."""
        return [self.sample_opponent() for _ in range(n)]

    # ── per-episode tracking (called from train loop) ─────────────────────────

    def assign_env_opponent(self, env_idx: int) -> str:
        """Sample a fresh opponent for env_idx and record the assignment."""
        name = self.sample_opponent()
        self._episode_opponents[env_idx] = name
        self._ready_for_episode.add(env_idx)
        return name

    def get_env_opponent(self, env_idx: int) -> str:
        """Return the opponent currently assigned to this env."""
        return self._episode_opponents.get(env_idx, SCRIPTED_BOTS[0])

    def clear_env(self, env_idx: int) -> None:
        """Reset tracking for env_idx (called when episode ends)."""
        self._ready_for_episode.discard(env_idx)
        if env_idx in self._episode_opponents:
            del self._episode_opponents[env_idx]

    # ── results ───────────────────────────────────────────────────────────────

    def record_result(self, opponent_name: str, won: bool) -> None:
        """Record the outcome of one episode."""
        if opponent_name not in self.state.total_counts:
            self.state.total_counts[opponent_name] = 0
            self.state.win_counts[opponent_name] = 0
        self.state.total_counts[opponent_name] += 1
        if won:
            self.state.win_counts[opponent_name] += 1

    def get_win_rate(self, opponent_name: str) -> float:
        """Current win rate against a specific opponent."""
        total = self.state.total_counts.get(opponent_name, 0)
        wins = self.state.win_counts.get(opponent_name, 0)
        return wins / max(total, 1)

    def get_win_rate_matrix(self) -> dict:
        """Full win-rate matrix: {opponent_name: {total, wins, win_rate}}."""
        matrix = {}
        for name, opp in self.state.opponents.items():
            total = self.state.total_counts.get(name, 0)
            wins = self.state.win_counts.get(name, 0)
            matrix[name] = {
                "total": total,
                "wins": wins,
                "win_rate": wins / max(total, 1),
                "type": opp.type,
                "active": opp.active,
                "added_at_update": opp.added_at_update,
            }
        return matrix

    # ── lifecycle ─────────────────────────────────────────────────────────────

    def step_update(self, update_num: int, checkpoint_path: str | None = None) -> None:
        """Called after each PPO update.  May add a checkpoint to the pool."""
        self.state.current_update = update_num

        if (
            checkpoint_path
            and self.state.add_interval > 0
            and update_num % self.state.add_interval == 0
            and update_num > 0
        ):
            self._add_checkpoint(checkpoint_path, update_num)

    def _add_checkpoint(self, path: str, update_num: int) -> None:
        """Register a saved policy checkpoint as a (currently inactive) opponent.

        Checkpoints are marked active=False until Phase 6 provides ONNX export +
        in-process inference so they can actually play.  When activated, PFSP
        sampling will include them automatically.
        """
        name = f"checkpoint_{update_num:06d}"
        if name in self.state.opponents:
            return  # already registered

        self.state.opponents[name] = OpponentRecord(
            name=name,
            type="checkpoint",
            bot_name=None,
            checkpoint_path=os.path.abspath(path),
            added_at_update=update_num,
            active=False,   # activate in Phase 6
        )

    # ── persistence ───────────────────────────────────────────────────────────

    def save_state(self, path: str) -> None:
        """Save league state to a JSON file (opponents + win matrix)."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)

        payload = {
            "current_update": self.state.current_update,
            "pfsp_temperature": self.state.pfsp_temperature,
            "add_interval": self.state.add_interval,
            "opponents": {
                name: {
                    "name": o.name,
                    "type": o.type,
                    "bot_name": o.bot_name,
                    "checkpoint_path": o.checkpoint_path,
                    "added_at_update": o.added_at_update,
                    "active": o.active,
                }
                for name, o in self.state.opponents.items()
            },
            "win_counts": dict(self.state.win_counts),
            "total_counts": dict(self.state.total_counts),
        }
        p.write_text(json.dumps(payload, indent=2))

    def load_state(self, path: str) -> None:
        """Load league state from a JSON file."""
        with open(path) as f:
            data = json.load(f)

        self.state.current_update = data.get("current_update", 0)
        self.state.pfsp_temperature = data.get("pfsp_temperature", 0.5)
        self.state.add_interval = data.get("add_interval", 100)
        self.state.win_counts = data.get("win_counts", {})
        self.state.total_counts = data.get("total_counts", {})

        self.state.opponents = {}
        for name, o in data.get("opponents", {}).items():
            self.state.opponents[name] = OpponentRecord(
                name=o["name"],
                type=o["type"],
                bot_name=o.get("bot_name"),
                checkpoint_path=o.get("checkpoint_path"),
                added_at_update=o.get("added_at_update", 0),
                active=o.get("active", True),
            )
