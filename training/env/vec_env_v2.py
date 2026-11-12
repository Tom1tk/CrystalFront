"""
Protocol-v2 vectorised environment (G-10 M0 T7; ML_RETRAIN_IMPLEMENTATION.md §5.8).

Spawns `n_procs` Node runners (headless/dist/v2/vecRunner.js), splits the slots
between them and flattens every non-bot seat into a *stream* (slot, side).

Seat specs: "policy" (Python sends the action), "bot:<name>" (played inside
Node, no stream) or "teach:<name>" (the bot plays; the stream carries the
bot's choice as `teacher`, for imitation; Python sends no action).

Each stream has a role: "learner" or "frozen" for policy seats (from the slot's
`learner` list, default: every policy seat learns), "teach" for teach seats.
Python-only keys in a slot config (`learner`) are never sent to Node.

    env = VecEnvV2([{"seed": 1, "map": "shardfall", "blue": "policy", "red": "bot:random"}])
    cur = env.reset()                    # list of Stream, aligned with env.streams
    out = env.step(actions)              # actions: one per stream (None for teach)
    out.transitions                      # aligned with the streams BEFORE the step
    out.current                          # aligned with env.streams AFTER the step

A slot that ends (done or truncated) autoresets inside Node: its transition
carries `terminal` (final obs/critic/oppLabels) and `info`; `current` holds
the next episode's first observation. The stream layout can change only at
an episode boundary (after `configure` changed a slot's seats), which is why
transitions and current observations are returned separately.

Rewards are raw components {win, shaped: {res, army, dmg, ctrl}}; weights and
schedules are applied by the trainer (ML_RETRAIN_PLAN §7.4).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import orjson

    def _loads(b: str | bytes) -> Any:
        return orjson.loads(b)

    def _dumps(obj: Any) -> bytes:
        return orjson.dumps(obj) + b"\n"
except ImportError:  # pragma: no cover
    def _loads(b: str | bytes) -> Any:
        return json.loads(b)

    def _dumps(obj: Any) -> bytes:
        return (json.dumps(obj) + "\n").encode()

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER_JS = REPO_ROOT / "headless/dist/v2/vecRunner.js"
# Must match OBS_SCHEMA_VERSION in headless/src/v2/observation.ts.
OBS_SCHEMA_VERSION = 1
SIDES = ("blue", "red")
PY_ONLY_KEYS = ("learner",)


@dataclass
class Stream:
    """One seat's current decision point."""
    slot: int
    side: str
    role: str                    # "learner" | "frozen" | "teach"
    obs: dict
    masks: dict                  # econ[E], group[G], order[G][O], target[O][T] as 0/1
    critic: dict | None
    opp_labels: dict
    teacher: dict | None         # {"econ", "army": [g, o, t]} for teach seats


@dataclass
class Transition:
    """What one stream got from the step it acted in."""
    slot: int
    side: str
    role: str
    reward: dict                 # {"win": ±1|0, "shaped": {res, army, dmg, ctrl}}
    done: bool                   # terminated by the rules
    truncated: bool              # hit the tick cap
    terminal: dict | None        # final obs/critic/oppLabels when done or truncated
    info: dict


@dataclass
class StepOut:
    transitions: list[Transition]
    current: list[Stream]
    # Per slot, when the slot started a new episode this step: {"static", "episode"}.
    new_episodes: dict[int, dict] = field(default_factory=dict)


def _check_dist_fresh() -> None:
    """Fail loudly if any TS source bundled into the runner is newer than the build."""
    if not RUNNER_JS.exists():
        raise RuntimeError(f"{RUNNER_JS} missing — run: npm run build:headless")
    built = RUNNER_JS.stat().st_mtime
    for d in ("headless", "server", "shared"):
        for p in (REPO_ROOT / d / "src").rglob("*.ts"):
            if p.stat().st_mtime > built:
                raise RuntimeError(f"headless/dist is stale ({p} is newer) — run: npm run build:headless")


def _node_bin() -> str:
    found = shutil.which("node")
    if found:
        return found
    if Path("/root/.local/bin/node").exists():
        return "/root/.local/bin/node"
    raise RuntimeError("node not found on PATH")


class _Proc:
    def __init__(self) -> None:
        self.p = subprocess.Popen(
            [_node_bin(), str(RUNNER_JS)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
            cwd=str(REPO_ROOT), bufsize=1 << 20,
        )

    def send(self, msg: dict) -> None:
        assert self.p.stdin
        self.p.stdin.write(_dumps(msg))
        self.p.stdin.flush()

    def recv(self, expect: str) -> dict:
        assert self.p.stdout
        line = self.p.stdout.readline()
        if not line:
            raise RuntimeError(f"runner exited (code {self.p.poll()})")
        msg = _loads(line)
        if msg.get("type") == "error":
            raise RuntimeError(f"runner error: {msg.get('message')}")
        if msg.get("type") != expect:
            raise RuntimeError(f"expected {expect!r}, got {msg.get('type')!r}")
        return msg

    def close(self) -> None:
        if self.p.poll() is None:
            try:
                self.send({"type": "close"})
                self.p.wait(timeout=5)
            except Exception:
                self.p.kill()


def _seat_kind(spec: str) -> str:
    return "policy" if spec == "policy" else spec.split(":", 1)[0]


class VecEnvV2:
    def __init__(
        self,
        slots: list[dict],
        n_procs: int = 1,
        decision_interval: int = 8,
        max_ticks: int = 12000,
        critic: bool = True,
    ) -> None:
        if not slots:
            raise ValueError("need at least one slot")
        self.n_procs = max(1, min(n_procs, len(slots)))
        self.decision_interval = decision_interval
        self.max_ticks = max_ticks
        self.critic = critic
        self.cfg = [dict(s) for s in slots]
        # Slot i lives in process owner[i] at local index local[i] (contiguous blocks).
        per = -(-len(slots) // self.n_procs)
        self.owner = [i // per for i in range(len(slots))]
        self.local = [i % per for i in range(len(slots))]
        self.n_procs = self.owner[-1] + 1
        self._pending: dict[int, dict] = {}
        self.static: list[dict | None] = [None] * len(slots)
        self.episode: list[dict | None] = [None] * len(slots)
        self.streams: list[tuple[int, str, str]] = []
        self._procs: list[_Proc] = []

    # ── lifecycle ────────────────────────────────────────────────────────────

    def _roles(self, i: int) -> dict[str, str]:
        c = self.cfg[i]
        learners = c.get("learner")
        out = {}
        for side in SIDES:
            kind = _seat_kind(c.get(side, "policy" if side == "blue" else "bot:idle"))
            if kind == "teach":
                out[side] = "teach"
            elif kind == "policy":
                out[side] = "learner" if learners is None or side in learners else "frozen"
        return out

    def _wire_cfg(self, c: dict) -> dict:
        return {k: v for k, v in c.items() if k not in PY_ONLY_KEYS}

    def reset(self) -> list[Stream]:
        _check_dist_fresh()
        self.close()
        self._procs = [_Proc() for _ in range(self.n_procs)]
        self._pending.clear()
        for p in range(self.n_procs):
            self._procs[p].send({
                "type": "reset_all", "decision_interval": self.decision_interval,
                "max_ticks": self.max_ticks, "critic": self.critic,
                "slots": [self._wire_cfg(c) for i, c in enumerate(self.cfg) if self.owner[i] == p],
            })
        per_slot: list[dict] = []
        for p in range(self.n_procs):
            msg = self._procs[p].recv("ready")
            if msg.get("schemaVersion") != OBS_SCHEMA_VERSION:
                raise RuntimeError(f"obs schemaVersion {msg.get('schemaVersion')} != {OBS_SCHEMA_VERSION} (update vec_env_v2.py)")
            per_slot.extend(msg["slots"])
        for i, s in enumerate(per_slot):
            self.static[i], self.episode[i] = s["static"], s["episode"]
        return self._current([s["seats"] for s in per_slot])

    def close(self) -> None:
        for p in self._procs:
            p.close()
        self._procs = []

    def __enter__(self) -> "VecEnvV2":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ── stepping ─────────────────────────────────────────────────────────────

    def _current(self, seats_per_slot: list[dict]) -> list[Stream]:
        cur: list[Stream] = []
        for i, seats in enumerate(seats_per_slot):
            roles = self._roles(i)
            if set(seats) != set(roles):
                raise RuntimeError(f"slot {i}: runner sent seats {sorted(seats)}, expected {sorted(roles)}")
            for side in SIDES:
                if side in seats:
                    s = seats[side]
                    cur.append(Stream(i, side, roles[side], s["obs"], s["masks"], s.get("critic"), s["oppLabels"], s["teacher"]))
        self.streams = [(s.slot, s.side, s.role) for s in cur]
        return cur

    def step(self, actions: list[dict | None]) -> StepOut:
        """`actions[j]` is the wire action {"econ": e, "army": [g, o, t]} for stream j (None for teach streams)."""
        if len(actions) != len(self.streams):
            raise ValueError(f"expected {len(self.streams)} actions, got {len(actions)}")
        per_slot: list[dict] = [{} for _ in self.cfg]
        for (slot, side, role), a in zip(self.streams, actions):
            if role != "teach":
                if a is None:
                    raise ValueError(f"slot {slot} {side}: policy stream needs an action")
                per_slot[slot][side] = a
        for p in range(self.n_procs):
            self._procs[p].send({"type": "step", "actions": [per_slot[i] for i in range(len(self.cfg)) if self.owner[i] == p]})
        results: list[dict] = []
        for p in range(self.n_procs):
            results.extend(self._procs[p].recv("step_result")["slots"])

        transitions = []
        for slot, side, role in self.streams:
            r = results[slot]
            term = r["terminal"][side] if r["terminal"] else None
            transitions.append(Transition(slot, side, role, r["rewards"][side], r["done"], r["truncated"], term, r["info"]))
        new_eps = {}
        for i, r in enumerate(results):
            if r["done"] or r["truncated"]:
                if i in self._pending:
                    ch = self._pending.pop(i)
                    if "z" in ch:  # Node merges z per side
                        ch = {**ch, "z": {**self.cfg[i].get("z", {}), **ch["z"]}}
                    self.cfg[i].update(ch)
                self.static[i], self.episode[i] = r["static"], r["episode"]
                new_eps[i] = {"static": r["static"], "episode": r["episode"]}
        return StepOut(transitions, self._current([r["seats"] for r in results]), new_eps)

    def configure(self, slot: int, **changes: Any) -> None:
        """Change a slot's config (seed, map, blue, red, z, save_replay, learner) from its next episode on."""
        merged = {**self._pending.get(slot, {}), **changes}
        wire = self._wire_cfg(changes)
        if wire:
            p = self.owner[slot]
            self._procs[p].send({"type": "configure", "slots": [{"index": self.local[slot], **wire}]})
            self._procs[p].recv("configured")
        self._pending[slot] = merged
