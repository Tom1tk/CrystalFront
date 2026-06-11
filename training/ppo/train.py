"""
Crystal Front PPO Trainer — v0.2.8-ML optimised build

Based on CleanRL's PPO reference implementation (https://github.com/vwxyzjn/cleanrl).

Key optimisations vs prior version:
  - Vectorised Node runner: VEC_SIZE games per Node process, far fewer subprocesses
  - GPU rollout buffer: obs/logprobs/values stored on device, no re-upload for PPO
  - bf16 autocast for policy inference (bf16 natively fast on gfx1100 / RDNA3)
  - torch.compile(mode="reduce-overhead") — reduces per-step kernel launch cost
  - GAE computed on GPU with torch ops (no numpy loop)
  - orjson for JSON encode/decode in env
  - ROCm tuning env vars
  - torch.set_float32_matmul_precision("high")
  - np.bincount for action histograms

Hyperparameter guidance:
  num_envs  — total parallel games (across all Node processes)
              num_procs = num_envs // VEC_SIZE Node processes are actually spawned
              With 12 vCPUs: num_envs=20, VEC_SIZE=4 → 5 Node processes (recommended)
  num_steps — rollout length per env; raise to 1536+ so GAE spans a meaningful
              fraction of the 6000-tick episode horizon
  VEC_SIZE  — games per Node process (default 4)
"""

from __future__ import annotations

import os

# ── ROCm / GPU tuning env vars (set before torch import) ─────────────────────
os.environ.setdefault("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "1")   # flash-attn gfx1100
os.environ.setdefault("PYTORCH_TUNABLEOP_ENABLED",               "1")   # auto-tune GEMMs
os.environ.setdefault("PYTORCH_TUNABLEOP_TUNING",                "1")   # persist tuning to csv
os.environ.setdefault("MIOPEN_FIND_MODE",                        "FAST") # skip exhaustive search
os.environ.setdefault("MIOPEN_USER_DB_PATH",      "/root/.cache/miopen") # persistent kernel cache
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION",                "11.0.0")

import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.tensorboard import SummaryWriter
import tyro

torch.set_float32_matmul_precision("high")

# ── project imports ───────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from training.env.crystalfront_vec_env import (
    CrystalFrontVecEnv,
    GLOBAL_DIM, ENTITY_DIM, NODE_DIM,
    MAX_ENTITIES, MAX_NODES, ACTION_SPACE_SIZE,
)
from training.env.crystalfront_env import CrystalFrontEnv  # kept for legacy checkpoint compat
from training.ppo.policy import CrystalFrontAgent, RNDModel
from training.ppo.league import LeagueManager, SCRIPTED_BOTS


# ── curriculum stages ─────────────────────────────────────────────────────────
# Each stage defines the training environment.  Promote when win_rate ≥
# promotion_threshold over eval_window episodes.  Regress when stuck for
# max_steps_per_stage steps.
#
# map_width / crystal_health / starting_resources / max_ticks / opponent
# 0 values → use game default.

from dataclasses import dataclass as _dc, field as _field

@_dc
class CurriculumStage:
    name:                str
    map_width:           int        = 0
    crystal_health:      int        = 0
    starting_resources:  int        = 0
    max_ticks:           int        = 3000
    opponent:            str        = "idle"
    promotion_threshold: float      = 0.70
    eval_window:         int        = 100
    max_steps:           int        = 2_000_000
    pre_place_barracks:  bool       = False
    pre_place_units:     list[str]  = _field(default_factory=list)


CURRICULUM: list[CurriculumStage] = [
    # 0a: pre-placed barracks + 2 skirmishers — agent only needs attack_move (Phase A)
    CurriculumStage("0a", map_width=800, crystal_health=50, starting_resources=200, max_ticks=2000, opponent="idle",
                    pre_place_barracks=True, pre_place_units=["skirmisher", "skirmisher"],
                    promotion_threshold=0.85, max_steps=500_000),
    # 0b: pre-placed barracks only — Phase B, resumes directly from 0a weights (no 0a5)
    # With 0a value function (100% wins with 2 skirmishers), the gradient for
    # "train 1 unit → attack → win" is strong enough to solve 0b immediately.
    CurriculumStage("0b", map_width=800, crystal_health=50, starting_resources=200, max_ticks=2000, opponent="idle",
                    pre_place_barracks=True, pre_place_units=[],
                    promotion_threshold=0.70, max_steps=500_000),
    # 0b5: no scaffolding, 200 resources — build immediately, no gathering needed yet
    CurriculumStage("0b5", map_width=800, crystal_health=50, starting_resources=200, max_ticks=2000, opponent="idle",
                    promotion_threshold=0.70, max_steps=500_000),
    # 0c: no scaffolding, 50 resources — must gather before building
    CurriculumStage("0c", map_width=800,  crystal_health=50,  starting_resources=50,  max_ticks=2000, opponent="idle",        promotion_threshold=0.70, max_steps=500_000),
    # Review §9.5 Day 5 exact config — the target breakthrough stage
    CurriculumStage("day5", map_width=1500, crystal_health=200, starting_resources=50,  max_ticks=3000, opponent="idle",        promotion_threshold=0.50, max_steps=1_250_000),
    CurriculumStage("1a",   map_width=1500, crystal_health=100, starting_resources=50,  max_ticks=3000, opponent="idle",        promotion_threshold=0.70, max_steps=750_000),
    CurriculumStage("1b", map_width=1500, crystal_health=100, starting_resources=50,  max_ticks=3000, opponent="passive",     promotion_threshold=0.70, max_steps=750_000),
    CurriculumStage("2a", map_width=3000, crystal_health=300, starting_resources=50,  max_ticks=5000, opponent="passive",     promotion_threshold=0.70, max_steps=1_000_000),
    # Rule R3: one slider at a time. 2a5→2a6→2b slides starting_resources 200→75→50.
    # 200: build immediately, no gathering. 75: build immediately, must gather for units.
    # 50: must gather before building AND for units (full chain).
    CurriculumStage("2a5", map_width=3000, crystal_health=300, starting_resources=200, max_ticks=5000, opponent="rush_weak",   promotion_threshold=0.50, max_steps=750_000),
    CurriculumStage("2a6", map_width=3000, crystal_health=300, starting_resources=75,  max_ticks=5000, opponent="rush_weak",   promotion_threshold=0.50, max_steps=750_000),
    CurriculumStage("2b", map_width=3000, crystal_health=300, starting_resources=50,  max_ticks=5000, opponent="rush_weak",   promotion_threshold=0.50, max_steps=1_250_000),
    CurriculumStage("3a",   map_width=0, crystal_health=0, starting_resources=50,  max_ticks=6000, opponent="passive",     promotion_threshold=0.70, max_steps=1_250_000),
    # Rule R3 — one variable at a time through the rush_medium wall (§A6.3 second review):
    # 3a_rw:     passive→rush_weak on 6000px (skill transfer from 3000px, clears in ~1 window)
    # 3a_rwm:    rush_weak→rush_weak_medium on 6000px (6 units, push@300 — needs 2 agent units)
    # 3a_rm_3k:  rush_weak_medium→rush_medium on 3000px (familiar map, full-strength opponent)
    # 3a1:       3000px→6000px rush_medium, 2 pre-placed skirmishers (map scale-up with scaffold)
    # 3a2:       remove 1 skirmisher — agent must train one more unit
    # 3a5:       remove all scaffold — agent builds and trains from scratch (200 res head start)
    # 3b:        reduce starting resources to 50 — full difficulty
    CurriculumStage("3a_rw",    map_width=0,    crystal_health=0,   starting_resources=200, max_ticks=6000, opponent="rush_weak",        promotion_threshold=0.50, max_steps=1_000_000),
    CurriculumStage("3a_rwm",   map_width=0,    crystal_health=0,   starting_resources=200, max_ticks=6000, opponent="rush_weak_medium",  promotion_threshold=0.50, max_steps=1_000_000),
    CurriculumStage("3a_rm_3k", map_width=3000, crystal_health=300, starting_resources=200, max_ticks=5000, opponent="rush_medium",
                    pre_place_units=["skirmisher", "skirmisher"],
                    promotion_threshold=0.50, max_steps=1_000_000),
    CurriculumStage("3a1",      map_width=0,    crystal_health=0,   starting_resources=200, max_ticks=6000, opponent="rush_medium",
                    pre_place_units=["skirmisher", "skirmisher"],
                    promotion_threshold=0.50, max_steps=1_000_000),
    CurriculumStage("3a2",      map_width=0,    crystal_health=0,   starting_resources=200, max_ticks=6000, opponent="rush_medium",
                    pre_place_units=["skirmisher"],
                    promotion_threshold=0.50, max_steps=1_000_000),
    CurriculumStage("3a5",      map_width=0,    crystal_health=0,   starting_resources=200, max_ticks=6000, opponent="rush_medium", promotion_threshold=0.50, max_steps=1_000_000),
    CurriculumStage("3b",  map_width=0, crystal_health=0, starting_resources=50,  max_ticks=6000, opponent="rush_medium", promotion_threshold=0.50, max_steps=2_000_000),
    CurriculumStage("4",  map_width=0,    crystal_health=0,   starting_resources=50,  max_ticks=6000, opponent="league",      promotion_threshold=0.60, max_steps=5_000_000),
]


# ── config ────────────────────────────────────────────────────────────────────

@dataclass
class Config:
    # Experiment identity
    exp_name:  str = "crystalfront_ppo"
    seed:      int = 1
    device:    str = "cuda"

    # Environment
    num_envs:           int = 20       # total parallel games
    vec_size:           int = 4        # games per Node process; num_procs = num_envs // vec_size
    opponent:           str = "idle"
    save_replay_every:  int = 10
    decision_interval:  int = 8        # engine ticks held per agent decision (frame skip)

    # Training duration
    total_timesteps: int = 5_000_000

    # Optimiser
    learning_rate: float = 3e-4
    anneal_lr:     bool  = True

    # PPO rollout
    num_steps:      int   = 256        # episodes are now <=750 decisions (k=8); shorter rollout, faster updates
    gamma:          float = 0.99       # at k=8, half-life ~= 69 decisions ~= 550 ticks of game time
    gae_lambda:     float = 0.95

    # PPO update
    update_epochs:    int   = 4
    num_minibatches:  int   = 4        # 20×256 / 4 = 1280 per minibatch
    clip_coef:        float = 0.2
    norm_adv:         bool  = True
    clip_vloss:       bool  = True
    ent_coef:         float = 0.02
    vf_coef:          float = 0.5
    max_grad_norm:    float = 0.5

    # Network
    entity_d_model:  int = 64
    entity_n_heads:  int = 4
    entity_n_layers: int = 2
    node_d_model:    int = 32
    mlp_hidden:      int = 384         # wider trunk; free SPS on this GPU

    # Logging & checkpoints
    log_dir:        str = "runs"
    checkpoint_dir: str = "checkpoints"
    save_interval:  int = 50
    checkpoint:     str = ""

    # Compiler
    compile_agent:  bool = True        # torch.compile(mode="reduce-overhead")

    # MatchConfig overrides for curriculum (0 = use default)
    map_width:          int   = 0      # 0 = use game default (6000)
    crystal_health:     int   = 0      # 0 = use game default (1000)
    starting_resources: int   = 0      # 0 = use game default (50)
    max_ticks:          int   = 6000   # episode truncation tick

    # Curriculum (set curriculum=True to use CURRICULUM stages)
    curriculum:           bool  = False
    curriculum_stage:     int   = 0    # index into CURRICULUM list (0 = first stage)

    # Action forcing (Option B — suppress noop when idle during training)
    action_forcing_scale:      float = 0.0  # 0.0 = off, 1.0 = always force when conditions met
    action_forcing_fade_start: int   = 0    # global step to begin linear fade (0 = no fade)
    action_forcing_fade_end:   int   = 0    # global step where scale reaches 0.0

    # RND intrinsic motivation (Option γ)
    rnd_coef:       float = 0.0   # 0.0 = off; try 0.01 for Option γ
    rnd_embed_dim:  int   = 64    # embedding size for both target and predictor networks

    # League (Phase 4)
    league:               bool  = False
    league_pfsp_temp:     float = 0.5
    league_add_interval:  int   = 100
    league_state:         str   = ""

    @property
    def num_procs(self) -> int:
        return max(1, self.num_envs // self.vec_size)

    @property
    def batch_size(self) -> int:
        return self.num_envs * self.num_steps

    @property
    def minibatch_size(self) -> int:
        return self.batch_size // self.num_minibatches


# ── utilities ─────────────────────────────────────────────────────────────────

def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def obs_list_to_device(obs_list: list[dict], device: torch.device) -> dict[str, torch.Tensor]:
    """Stack a list of obs dicts (one per env) into batched device tensors."""
    globals_np      = np.stack([o["global"]      for o in obs_list])
    entities_np     = np.stack([o["entities"]    for o in obs_list])
    entity_masks_np = np.stack([o["entity_mask"] for o in obs_list])
    nodes_np        = np.stack([o["nodes"]       for o in obs_list])
    node_masks_np   = np.stack([o["node_mask"]   for o in obs_list])
    return {
        "global":      torch.from_numpy(globals_np).to(device),
        "entities":    torch.from_numpy(entities_np).to(device),
        "entity_mask": torch.from_numpy(entity_masks_np).to(device),
        "nodes":       torch.from_numpy(nodes_np).to(device),
        "node_mask":   torch.from_numpy(node_masks_np).to(device),
    }


# ── rollout buffer ────────────────────────────────────────────────────────────

class RolloutBuffer:
    """
    Stores one rollout (num_steps × num_envs transitions) as GPU tensors.

    All data lives on device — no H2D re-upload during the PPO update phase.
    Obs are copied to GPU during rollout collection (non_blocking where possible).
    """

    def __init__(self, num_steps: int, num_envs: int, device: torch.device):
        self.T = num_steps
        self.E = num_envs
        self.device = device

        self.globals      = torch.zeros((num_steps, num_envs, GLOBAL_DIM),               device=device)
        self.entities     = torch.zeros((num_steps, num_envs, MAX_ENTITIES, ENTITY_DIM), device=device)
        self.entity_masks = torch.zeros((num_steps, num_envs, MAX_ENTITIES),             device=device, dtype=torch.bool)
        self.nodes        = torch.zeros((num_steps, num_envs, MAX_NODES, NODE_DIM),      device=device)
        self.node_masks   = torch.zeros((num_steps, num_envs, MAX_NODES),                device=device, dtype=torch.bool)
        self.legal_masks  = torch.zeros((num_steps, num_envs, ACTION_SPACE_SIZE),        device=device, dtype=torch.bool)

        self.actions  = torch.zeros((num_steps, num_envs), dtype=torch.long,   device=device)
        self.logprobs = torch.zeros((num_steps, num_envs),                     device=device)
        self.rewards  = torch.zeros((num_steps, num_envs),                     device=device)
        self.dones    = torch.zeros((num_steps, num_envs),                     device=device)
        self.values   = torch.zeros((num_steps, num_envs),                     device=device)

    def add(
        self,
        step: int,
        obs_list: list[dict],          # list of obs dicts, one per env (CPU numpy)
        legal_masks_np: np.ndarray,    # (num_envs, ACTION_SPACE_SIZE) bool
        actions_t:  torch.Tensor,      # (num_envs,)  on device
        logprobs_t: torch.Tensor,      # (num_envs,)  on device
        rewards_np: np.ndarray,        # (num_envs,)
        dones_np:   np.ndarray,        # (num_envs,)
        values_t:   torch.Tensor,      # (num_envs,)  on device
    ) -> None:
        # Upload obs in one batch (non_blocking: queues DMA without stalling Python)
        g  = np.stack([o["global"]      for o in obs_list])
        e  = np.stack([o["entities"]    for o in obs_list])
        em = np.stack([o["entity_mask"] for o in obs_list])
        n  = np.stack([o["nodes"]       for o in obs_list])
        nm = np.stack([o["node_mask"]   for o in obs_list])

        self.globals[step].copy_(torch.from_numpy(g),  non_blocking=True)
        self.entities[step].copy_(torch.from_numpy(e),  non_blocking=True)
        self.entity_masks[step].copy_(torch.from_numpy(em), non_blocking=True)
        self.nodes[step].copy_(torch.from_numpy(n),   non_blocking=True)
        self.node_masks[step].copy_(torch.from_numpy(nm), non_blocking=True)
        self.legal_masks[step].copy_(
            torch.from_numpy(legal_masks_np), non_blocking=True)

        # Policy outputs already on device — direct assignment, no copy
        self.actions[step]  = actions_t.detach()
        self.logprobs[step] = logprobs_t.detach()
        self.values[step]   = values_t.detach()

        # Small CPU arrays — synchronous (only 20 floats each)
        self.rewards[step] = torch.tensor(rewards_np, dtype=torch.float32, device=self.device)
        self.dones[step]   = torch.tensor(dones_np,   dtype=torch.float32, device=self.device)

    def flatten(self) -> dict[str, torch.Tensor]:
        """Flatten (T, E, ...) → (T*E, ...).  All tensors already on device."""
        B = self.T * self.E
        return {
            "globals":      self.globals.view(B, GLOBAL_DIM),
            "entities":     self.entities.view(B, MAX_ENTITIES, ENTITY_DIM),
            "entity_masks": self.entity_masks.view(B, MAX_ENTITIES),
            "nodes":        self.nodes.view(B, MAX_NODES, NODE_DIM),
            "node_masks":   self.node_masks.view(B, MAX_NODES),
            "legal_masks":  self.legal_masks.view(B, ACTION_SPACE_SIZE),
            "actions":      self.actions.view(B),
            "logprobs":     self.logprobs.view(B),
            "rewards":      self.rewards.view(B),
            "dones":        self.dones.view(B),
            "values":       self.values.view(B),
        }


# ── training ──────────────────────────────────────────────────────────────────

def train(cfg: Config) -> None:
    set_seed(cfg.seed)
    device = torch.device(cfg.device)

    import json as _json
    _pkg_path = REPO_ROOT / "package.json"
    _version  = _json.loads(_pkg_path.read_text()).get("version", "unknown").replace(".", "_")

    opp_label = "league" if cfg.league else cfg.opponent
    run_name  = f"{cfg.exp_name}__{_version}__{opp_label}__{cfg.seed}__{int(time.time())}"
    log_path  = Path(cfg.log_dir)  / run_name
    ckpt_path = Path(cfg.checkpoint_dir) / run_name
    ckpt_path.mkdir(parents=True, exist_ok=True)

    writer = SummaryWriter(str(log_path))
    writer.add_text("config", str(cfg))
    print(f"\nCrystalFront PPO training")
    if cfg.league:
        print(f"  Mode:       LEAGUE (PFSP, temp={cfg.league_pfsp_temp})")
    else:
        print(f"  Opponent:   {cfg.opponent}")
    print(f"  Envs:       {cfg.num_envs}  (vec_size={cfg.vec_size}, procs={cfg.num_procs})")
    print(f"  Decision interval: {cfg.decision_interval} ticks/decision ({cfg.decision_interval * 100}ms game time)")
    print(f"  Batch size: {cfg.batch_size}  (steps={cfg.num_steps} × envs={cfg.num_envs})")
    print(f"  Minibatch:  {cfg.minibatch_size}  ({cfg.num_minibatches} minibatches × {cfg.update_epochs} epochs)")
    print(f"  Device:     {device}")
    print(f"  Run name:   {run_name}\n")

    # ── league ─────────────────────────────────────────────────────────────────
    league: LeagueManager | None = None
    league_state_path: str = ""
    if cfg.league:
        league_state_path = cfg.league_state or str(ckpt_path / "league_state.json")
        if not os.path.isabs(league_state_path):
            league_state_path = str(Path(league_state_path).resolve())
        league = LeagueManager(
            num_envs=cfg.num_envs,
            pfsp_temperature=cfg.league_pfsp_temp,
            add_interval=cfg.league_add_interval,
            results_dir=cfg.log_dir,
        )
        if os.path.exists(league_state_path):
            print(f"  Resuming league state from {league_state_path}")
            league.load_state(league_state_path)
        print(f"  League opponents: {list(league.state.opponents.keys())}")
        print(f"  League state → {league_state_path}")

    # ── curriculum state ──────────────────────────────────────────────────────
    cur_stage_idx  = cfg.curriculum_stage if cfg.curriculum else -1
    cur_stage      = CURRICULUM[cur_stage_idx] if cfg.curriculum else None
    stage_step_start = 0  # global_step when current stage began
    pending_stage_change = 0  # +1 promote / -1 regress, applied at the next update boundary

    def _resolve_env_params() -> tuple[dict, int, str, dict | None]:
        """Return (config_overrides, max_ticks, opponent, pre_place) for current stage or cfg defaults."""
        if cur_stage is not None:
            ov: dict = {}
            if cur_stage.map_width          > 0: ov["mapWidth"]          = cur_stage.map_width
            if cur_stage.crystal_health     > 0: ov["crystalHealth"]     = cur_stage.crystal_health
            if cur_stage.starting_resources > 0: ov["startingResources"] = cur_stage.starting_resources
            pp = None
            if cur_stage.pre_place_barracks or cur_stage.pre_place_units:
                pp = {"barracks": cur_stage.pre_place_barracks, "units": cur_stage.pre_place_units}
            return ov, cur_stage.max_ticks, cur_stage.opponent, pp
        ov = {}
        if cfg.map_width          > 0: ov["mapWidth"]          = cfg.map_width
        if cfg.crystal_health     > 0: ov["crystalHealth"]     = cfg.crystal_health
        if cfg.starting_resources > 0: ov["startingResources"] = cfg.starting_resources
        return ov, cfg.max_ticks, cfg.opponent, None

    def _build_vec_envs(config_overrides: dict, max_ticks: int, opponent: str, pre_place: dict | None,
                        forcing_scale: float = 0.0) -> list[CrystalFrontVecEnv]:
        _stagger = min(0.4, 15.0 / max(cfg.num_procs - 1, 1))
        return [
            CrystalFrontVecEnv(
                vec_size=cfg.vec_size,
                opponent=opponent,
                save_replay_every=cfg.save_replay_every,
                startup_delay=i * _stagger,
                config_overrides=config_overrides or None,
                max_ticks=max_ticks,
                pre_place=pre_place,
                action_forcing_scale=forcing_scale,
                decision_interval=cfg.decision_interval,
            )
            for i in range(cfg.num_procs)
        ]

    # ── vectorised environments ───────────────────────────────────────────────
    _cfg_overrides, _max_ticks, _opponent, _pre_place = _resolve_env_params()
    if cur_stage:
        print(f"  Curriculum stage: {cur_stage.name}  (map={cur_stage.map_width or 'default'}, "
              f"crystal_hp={cur_stage.crystal_health or 'default'}, opp={cur_stage.opponent})", flush=True)
        writer.add_scalar("curriculum/stage", cur_stage_idx, 0)
    vec_envs = _build_vec_envs(_cfg_overrides, _max_ticks, _opponent, _pre_place,
                               forcing_scale=cfg.action_forcing_scale)

    # ── agent & optimiser ─────────────────────────────────────────────────────
    agent = CrystalFrontAgent(
        entity_d_model=cfg.entity_d_model,
        entity_n_heads=cfg.entity_n_heads,
        entity_n_layers=cfg.entity_n_layers,
        node_d_model=cfg.node_d_model,
        mlp_hidden=cfg.mlp_hidden,
    ).to(device)

    # ── optional checkpoint resume ────────────────────────────────────────────
    # Load weights BEFORE compile so key names are always undecorated.
    # Strip _orig_mod. prefix if checkpoint was saved from a compiled agent.
    start_update = 1
    _ckpt = None
    if cfg.checkpoint:
        _ckpt = torch.load(cfg.checkpoint, map_location=device, weights_only=False)
        sd = _ckpt["agent"]
        if any(k.startswith("_orig_mod.") for k in sd):
            sd = {k[len("_orig_mod."):]: v for k, v in sd.items()}
        agent.load_state_dict(sd)
        start_update = int(_ckpt.get("update", 0)) + 1
        print(f"  Resumed from: {cfg.checkpoint}  (update {_ckpt.get('update','?')}, step {_ckpt.get('global_step',0):,})", flush=True)

    if cfg.compile_agent:
        print("  Compiling agent with torch.compile(reduce-overhead)…", flush=True)
        agent = torch.compile(agent, mode="reduce-overhead", dynamic=False)  # type: ignore[assignment]
        print("  Compilation done (first forward will JIT-compile kernels)\n", flush=True)

    optimizer = optim.Adam(agent.parameters(), lr=cfg.learning_rate, eps=1e-5)

    # ── RND (Option γ) ────────────────────────────────────────────────────────
    rnd_model: RNDModel | None = None
    rnd_optimizer = None
    if cfg.rnd_coef > 0:
        rnd_model = RNDModel(embed_dim=cfg.rnd_embed_dim).to(device)
        rnd_optimizer = optim.Adam(rnd_model.predictor.parameters(), lr=cfg.learning_rate, eps=1e-5)
        if _ckpt is not None and "rnd" in _ckpt:
            rnd_model.load_state_dict(_ckpt["rnd"])
        print(f"  RND enabled: rnd_coef={cfg.rnd_coef}, embed_dim={cfg.rnd_embed_dim}", flush=True)

    if _ckpt is not None and int(_ckpt.get("update", 0)) > 0:
        # Only restore optimizer state from PPO checkpoints (update > 0).
        # BC warmup checkpoints (update=0) use a different optimizer config
        # (lr=1e-3, CE objective) whose Adam momentum fights the PPO gradient.
        optimizer.load_state_dict(_ckpt["optimizer"])

    # ── thread pool ───────────────────────────────────────────────────────────
    # One thread per Node process — much fewer threads than old 1-game-per-proc design.
    executor = ThreadPoolExecutor(max_workers=cfg.num_procs)

    # ── initial reset (parallel) ──────────────────────────────────────────────
    def _do_reset_vec(args: tuple) -> list:
        venv, proc_idx, opts_list = args
        seeds = [int(np.random.randint(0, 2**31)) for _ in range(venv.vec_size)]
        return venv.reset(seeds=seeds, options=opts_list)

    init_opts_list = [[{}] * cfg.vec_size for _ in range(cfg.num_procs)]
    init_results = list(executor.map(
        _do_reset_vec,
        [(vec_envs[i], i, init_opts_list[i]) for i in range(cfg.num_procs)],
    ))
    # Flatten: list of (num_procs × vec_size) (obs, info) tuples
    flat_init = [r for batch in init_results for r in batch]
    obs_list:  list[dict] = [r[0] for r in flat_init]
    info_list: list[dict] = [r[1] for r in flat_init]

    # ── bookkeeping ───────────────────────────────────────────────────────────
    buffer = RolloutBuffer(cfg.num_steps, cfg.num_envs, device)
    num_updates          = cfg.total_timesteps // cfg.batch_size

    if cfg.anneal_lr and _ckpt is not None and (start_update - 1) >= 0.8 * num_updates:
        print(
            f"  ⚠️  WARNING: schedule compression — resumed checkpoint is at update "
            f"{start_update - 1}/{num_updates} ({100 * (start_update - 1) / num_updates:.0f}%) "
            f"of THIS run's anneal schedule. The LR will start near zero (or be clamped to "
            f"zero immediately if update {start_update - 1} >= {num_updates}). "
            f"Increase --total_timesteps to give this run a fresh anneal horizon, or pass "
            f"--no-anneal_lr if that's intended.",
            flush=True,
        )

    global_step          = 0
    _cur_forcing_scale   = cfg.action_forcing_scale  # tracks current live scale for fade
    episode_rewards     = [0.0] * cfg.num_envs
    episode_lengths     = [0]   * cfg.num_envs
    completed_episodes  = 0
    wins_last_window    = 0
    window_episodes     = 0
    WIN_WINDOW          = 100
    combat_wins_window   = 0
    resource_wins_window = 0
    timeout_window       = 0
    loss_window          = 0
    warn_no_pressure_window     = 0
    warn_loss_pos_reward_window = 0
    first_barracks_ticks:      list[int]   = []
    first_combat_ticks:        list[int]   = []
    first_three_combat_ticks:  list[int]   = []
    first_midfield_ticks:      list[int]   = []
    first_enemy_quarter_ticks: list[int]   = []
    first_attack_ticks:        list[int]   = []
    enemy_crystal_dmg_pct_list: list[float] = []
    own_crystal_dmg_pct_list:   list[float] = []
    final_reward_list:          list[float] = []
    terminal_reward_list:       list[float] = []
    raw_shaping_list:           list[float] = []
    entities_discovered_list:   list[int]   = []
    action_counts = np.zeros(ACTION_SPACE_SIZE, dtype=np.int64)

    start_time = time.time()

    # ── main training loop ────────────────────────────────────────────────────
    for update in range(start_update, num_updates + 1):

        if cfg.anneal_lr:
            frac = max(1.0 - (update - 1) / num_updates, 0.0)
            optimizer.param_groups[0]["lr"] = cfg.learning_rate * frac

        # ── action forcing fade schedule ──────────────────────────────────────
        if cfg.action_forcing_scale > 0 and cfg.action_forcing_fade_start > 0:
            ss, fs = cfg.action_forcing_fade_start, cfg.action_forcing_fade_end
            if global_step < ss:
                new_scale = cfg.action_forcing_scale
            elif fs > ss and global_step < fs:
                new_scale = cfg.action_forcing_scale * (1.0 - (global_step - ss) / (fs - ss))
            else:
                new_scale = 0.0
            new_scale = round(new_scale, 4)
            if new_scale != _cur_forcing_scale:
                _cur_forcing_scale = new_scale
                for ve in vec_envs:
                    ve.set_forcing_scale(_cur_forcing_scale)
            writer.add_scalar("training/action_forcing_scale", _cur_forcing_scale, global_step)

        # ── rollout collection ────────────────────────────────────────────────
        for step in range(cfg.num_steps):
            global_step += cfg.num_envs

            # Stack obs and upload to device in one batch
            obs_t = obs_list_to_device(obs_list, device)

            legal_masks_np = np.stack([info_list[i]["legal_mask"] for i in range(cfg.num_envs)])
            legal_t = torch.from_numpy(legal_masks_np).to(device)

            with torch.no_grad(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                actions_t, logprobs_t, _, values_t = agent.get_action_and_value(
                    obs_t, legal_mask=legal_t
                )
                values_t = values_t.squeeze(-1).float()  # keep fp32 for GAE accuracy

            # Only actions need to land on CPU (for env stepping)
            actions_np = actions_t.cpu().numpy()

            # Accumulate action histogram (vectorised)
            action_counts += np.bincount(actions_np.astype(np.int64), minlength=ACTION_SPACE_SIZE)

            # Step all vec envs in parallel — one future per Node process
            # Reshape actions to (num_procs, vec_size)
            actions_by_proc = actions_np.reshape(cfg.num_procs, cfg.vec_size)

            def _step_vec(args: tuple) -> list:
                venv, acts = args
                return venv.step(acts.tolist())

            vec_step_results = list(executor.map(
                _step_vec, zip(vec_envs, actions_by_proc)
            ))
            # Flatten to num_envs results
            step_results = [r for batch in vec_step_results for r in batch]

            next_obs_list  = [None] * cfg.num_envs
            next_info_list = [None] * cfg.num_envs
            rewards_np = np.zeros(cfg.num_envs, dtype=np.float32)
            dones_np   = np.zeros(cfg.num_envs, dtype=np.float32)

            for i, (obs_next, reward, terminated, truncated, info) in enumerate(step_results):
                done = terminated or truncated
                rewards_np[i] = reward
                dones_np[i]   = float(done)
                episode_rewards[i] += reward
                episode_lengths[i] += 1
                next_obs_list[i]  = obs_next
                next_info_list[i] = info

                if done:
                    completed_episodes += 1
                    window_episodes    += 1
                    winner   = info.get("winner")
                    win_type = info.get("winType")
                    won = winner == "headless-blue"
                    if won:
                        wins_last_window += 1
                        if win_type == "resource": resource_wins_window += 1
                        else:                      combat_wins_window   += 1
                    outcome = info.get("episodeOutcome", "")
                    if outcome == "timeout": timeout_window += 1
                    elif outcome == "loss":  loss_window    += 1
                    if info.get("warn_no_pressure"):       warn_no_pressure_window     += 1
                    if info.get("warn_loss_positive_reward"): warn_loss_pos_reward_window += 1

                    fr = info.get("finalReward");      final_reward_list.append(float(fr)) if fr is not None else None
                    tr = info.get("terminalReward");   terminal_reward_list.append(float(tr)) if tr is not None else None
                    rs = info.get("rawShapingReward"); raw_shaping_list.append(float(rs)) if rs is not None else None
                    ecd = info.get("enemyCrystalDamagePct"); enemy_crystal_dmg_pct_list.append(float(ecd)) if ecd is not None else None
                    ocd = info.get("ownCrystalDamagePct");   own_crystal_dmg_pct_list.append(float(ocd)) if ocd is not None else None

                    for attr, lst in [
                        ("firstBarracksTick",          first_barracks_ticks),
                        ("firstCombatUnitTick",        first_combat_ticks),
                        ("firstThreeCombatUnitsTick",  first_three_combat_ticks),
                        ("firstMidfieldCrossTick",     first_midfield_ticks),
                        ("firstEnemyQuarterEntryTick", first_enemy_quarter_ticks),
                        ("firstEnemyCrystalHitTick",   first_attack_ticks),
                    ]:
                        v = info.get(attr, -1)
                        if v is not None and v >= 0: lst.append(int(v))
                    ed = info.get("entitiesDiscovered", 0)
                    if ed is not None: entities_discovered_list.append(int(ed))

                    if league is not None:
                        opp = league.get_env_opponent(i)
                        league.record_result(opp, won)

                    writer.add_scalar("game/episode_reward",       episode_rewards[i], global_step)
                    writer.add_scalar("game/episode_length_ticks", episode_lengths[i], global_step)

                    if window_episodes >= WIN_WINDOW:
                        win_rate = wins_last_window / window_episodes
                        writer.add_scalar("game/win_rate", win_rate, global_step)
                        cbt_rate  = combat_wins_window   / window_episodes
                        tmt_rate  = timeout_window       / window_episodes
                        loss_rate = loss_window          / window_episodes
                        writer.add_scalar("diagnostics/combat_win_rate",   cbt_rate,  global_step)
                        writer.add_scalar("diagnostics/timeout_rate",      tmt_rate,  global_step)
                        writer.add_scalar("diagnostics/loss_rate",         loss_rate, global_step)
                        writer.add_scalar("diagnostics/resource_win_rate", resource_wins_window / window_episodes, global_step)
                        writer.add_scalar("diagnostics/warn_no_pressure",  warn_no_pressure_window / window_episodes, global_step)
                        writer.add_scalar("diagnostics/warn_loss_pos_rew", warn_loss_pos_reward_window / window_episodes, global_step)
                        if final_reward_list:
                            writer.add_scalar("rewards/final_reward_mean",    sum(final_reward_list) / len(final_reward_list), global_step)
                        if terminal_reward_list:
                            writer.add_scalar("rewards/terminal_reward_mean", sum(terminal_reward_list) / len(terminal_reward_list), global_step)
                        if raw_shaping_list:
                            writer.add_scalar("rewards/raw_shaping_mean",     sum(raw_shaping_list) / len(raw_shaping_list), global_step)
                        if enemy_crystal_dmg_pct_list:
                            writer.add_scalar("diagnostics/enemy_crystal_dmg_pct",
                                              sum(enemy_crystal_dmg_pct_list) / len(enemy_crystal_dmg_pct_list), global_step)
                            writer.add_scalar("diagnostics/crystal_hit_rate",
                                              sum(1 for v in enemy_crystal_dmg_pct_list if v > 0) / len(enemy_crystal_dmg_pct_list), global_step)
                        if own_crystal_dmg_pct_list:
                            writer.add_scalar("diagnostics/own_crystal_dmg_pct",
                                              sum(own_crystal_dmg_pct_list) / len(own_crystal_dmg_pct_list), global_step)
                        def _mean(lst): return sum(lst) / len(lst) if lst else None
                        for tag, lst in [
                            ("diagnostics/first_barracks_tick",       first_barracks_ticks),
                            ("diagnostics/first_combat_unit_tick",    first_combat_ticks),
                            ("diagnostics/first_three_combat_tick",   first_three_combat_ticks),
                            ("diagnostics/first_midfield_cross_tick", first_midfield_ticks),
                            ("diagnostics/first_enemy_quarter_tick",  first_enemy_quarter_ticks),
                            ("diagnostics/first_crystal_hit_tick",    first_attack_ticks),
                            ("diagnostics/entities_discovered_per_ep", entities_discovered_list),
                        ]:
                            v = _mean(lst)
                            if v is not None: writer.add_scalar(tag, v, global_step)

                        total_acts = max(action_counts.sum(), 1)
                        pct_atk_mv  = int(100 * (action_counts[18:30].sum() + action_counts[50:58].sum()) / total_acts)
                        pct_atk_tgt = int(100 * (action_counts[37:49].sum() + action_counts[58:66].sum()) / total_acts)
                        pct_bld     = int(100 * action_counts[6:18].sum()  / total_acts)
                        pct_trn     = int(100 * (action_counts[1] + action_counts[2:6].sum()) / total_acts)
                        pct_noop    = int(100 * action_counts[0] / total_acts)
                        pct_wkr_mv  = int(100 * action_counts[66:71].sum() / total_acts)
                        no_pres_pct = int(100 * warn_no_pressure_window / window_episodes)
                        ecd_mean    = int(sum(enemy_crystal_dmg_pct_list) / len(enemy_crystal_dmg_pct_list)) if enemy_crystal_dmg_pct_list else 0
                        ep_ret_mean = int(100 * sum(terminal_reward_list) / len(terminal_reward_list)) if terminal_reward_list else 0
                        print(
                            f"  update={update:5d} | step={global_step:8d} | "
                            f"win_rate={win_rate:.2f} ({wins_last_window}/{window_episodes}) | "
                            f"cbt={cbt_rate:.2f} tmt={tmt_rate:.2f} | "
                            f"ep_len={episode_lengths[i]:4d} | ep_rew={episode_rewards[i]:.2f} ep_ret={ep_ret_mean} | "
                            f"atk_mv={pct_atk_mv}% tgt={pct_atk_tgt}% bld={pct_bld}% trn={pct_trn}% wkr_mv={pct_wkr_mv}% noop={pct_noop}% | "
                            f"crys_dmg={ecd_mean}% no_pres={no_pres_pct}%"
                            + (f" | rnd={rnd_loss_val:.4f}" if rnd_model is not None else ""),
                            flush=True
                        )
                        wins_last_window = 0; window_episodes = 0
                        combat_wins_window = 0; resource_wins_window = 0
                        timeout_window = 0; loss_window = 0
                        warn_no_pressure_window = 0; warn_loss_pos_reward_window = 0
                        first_barracks_ticks.clear(); first_combat_ticks.clear()
                        first_three_combat_ticks.clear(); first_midfield_ticks.clear()
                        first_enemy_quarter_ticks.clear(); first_attack_ticks.clear()
                        enemy_crystal_dmg_pct_list.clear(); own_crystal_dmg_pct_list.clear()
                        final_reward_list.clear(); terminal_reward_list.clear()
                        raw_shaping_list.clear(); entities_discovered_list.clear()
                        action_counts[:] = 0

                        # ── curriculum promotion check ──────────────────────
                        # Stage changes are deferred to the update boundary (see below the
                        # PPO update) so a single rollout buffer never spans two stages.
                        if cur_stage is not None:
                            _stage_steps = global_step - stage_step_start
                            if win_rate >= cur_stage.promotion_threshold:
                                if cur_stage_idx + 1 < len(CURRICULUM):
                                    pending_stage_change = +1
                                else:
                                    print(f"\n  *** CURRICULUM COMPLETE — all stages solved ***\n", flush=True)
                                    cur_stage = None
                            elif _stage_steps > cur_stage.max_steps and cur_stage_idx > 0:
                                pending_stage_change = -1

                    episode_rewards[i] = 0.0
                    episode_lengths[i] = 0
                    # VecRunner autoreset: next_obs_list[i] already contains fresh-episode obs
                    # No explicit env.reset() call needed

            # ── RND intrinsic reward ──────────────────────────────────────────
            if rnd_model is not None:
                with torch.no_grad():
                    global_obs_t = obs_t["global"].float()
                    rnd_model.obs_rms.update(global_obs_t)
                    r_i = rnd_model.intrinsic_reward(global_obs_t).cpu().numpy()
                    rnd_model.rew_rms.update(torch.tensor(r_i))
                    r_i_norm = r_i / (rnd_model.rew_rms.var.item() ** 0.5 + 1e-8)
                    rewards_np = rewards_np + cfg.rnd_coef * r_i_norm.astype(np.float32)

            buffer.add(step, obs_list, legal_masks_np, actions_t, logprobs_t.float(),
                       rewards_np, dones_np, values_t)
            obs_list  = next_obs_list
            info_list = next_info_list

        # ── bootstrap last value & GAE (fully on GPU) ─────────────────────────
        with torch.no_grad(), torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            next_obs_t = obs_list_to_device(obs_list, device)
            next_values = agent.get_value(next_obs_t).squeeze(-1).float()  # (E,)

        flat = buffer.flatten()   # all GPU tensors, no upload
        T, E = cfg.num_steps, cfg.num_envs
        rewards_2d  = flat["rewards"].view(T, E)
        dones_2d    = flat["dones"].view(T, E)
        values_2d   = flat["values"].view(T, E)

        # GAE on GPU — T-step loop over scalar ops on (E,) tensors, very fast
        advantages = torch.zeros_like(values_2d)
        last_gae   = torch.zeros(E, device=device)
        for t in reversed(range(T)):
            next_val = next_values if t == T - 1 else values_2d[t + 1]
            delta    = rewards_2d[t] + cfg.gamma * next_val * (1.0 - dones_2d[t]) - values_2d[t]
            last_gae = delta + cfg.gamma * cfg.gae_lambda * (1.0 - dones_2d[t]) * last_gae
            advantages[t] = last_gae
        returns = advantages + values_2d

        advantages_flat = advantages.view(-1)
        returns_flat    = returns.view(-1)

        # ── PPO update ────────────────────────────────────────────────────────
        B       = cfg.batch_size
        indices = torch.randperm(B, device=device)
        clip_fracs: list[float] = []

        for epoch in range(cfg.update_epochs):
            indices = indices[torch.randperm(B, device=device)]
            for start in range(0, B, cfg.minibatch_size):
                end    = start + cfg.minibatch_size
                mb_idx = indices[start:end]

                # All minibatch data already on device — just slice
                mb_obs = {
                    "global":      flat["globals"][mb_idx],
                    "entities":    flat["entities"][mb_idx],
                    "entity_mask": flat["entity_masks"][mb_idx],
                    "nodes":       flat["nodes"][mb_idx],
                    "node_mask":   flat["node_masks"][mb_idx],
                }
                mb_legal    = flat["legal_masks"][mb_idx]
                mb_actions  = flat["actions"][mb_idx]
                mb_logprobs = flat["logprobs"][mb_idx]
                mb_advs     = advantages_flat[mb_idx]
                mb_returns  = returns_flat[mb_idx]
                mb_values   = flat["values"][mb_idx]

                with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                    _, new_logprobs, entropy, new_values = agent.get_action_and_value(
                        mb_obs, action=mb_actions, legal_mask=mb_legal
                    )
                new_values = new_values.squeeze(-1).float()
                new_logprobs = new_logprobs.float()
                entropy      = entropy.float()

                log_ratio = new_logprobs - mb_logprobs
                ratio     = log_ratio.exp()

                with torch.no_grad():
                    clip_fracs.append(((ratio - 1.0).abs() > cfg.clip_coef).float().mean().item())

                if cfg.norm_adv:
                    mb_advs = (mb_advs - mb_advs.mean()) / (mb_advs.std() + 1e-8)

                pg_loss1 = -mb_advs * ratio
                pg_loss2 = -mb_advs * ratio.clamp(1 - cfg.clip_coef, 1 + cfg.clip_coef)
                pg_loss  = torch.max(pg_loss1, pg_loss2).mean()

                if cfg.clip_vloss:
                    v_loss_unclipped = (new_values - mb_returns) ** 2
                    v_clipped = mb_values + (new_values - mb_values).clamp(-cfg.clip_coef, cfg.clip_coef)
                    v_loss = 0.5 * torch.max(v_loss_unclipped, (v_clipped - mb_returns) ** 2).mean()
                else:
                    v_loss = 0.5 * ((new_values - mb_returns) ** 2).mean()

                entropy_loss = entropy.mean()
                loss = pg_loss - cfg.ent_coef * entropy_loss + cfg.vf_coef * v_loss

                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(agent.parameters(), cfg.max_grad_norm)
                optimizer.step()

        # ── RND predictor update (after PPO epochs) ───────────────────────────
        rnd_loss_val = 0.0
        if rnd_model is not None and rnd_optimizer is not None:
            # Use the full rollout batch (no minibatch split needed for predictor)
            all_global = buffer.globals.reshape(-1, buffer.globals.shape[-1])  # (T*N, GLOBAL_DIM)
            rnd_optimizer.zero_grad()
            rnd_loss = rnd_model.predictor_loss(all_global.float())
            rnd_loss.backward()
            rnd_optimizer.step()
            rnd_loss_val = rnd_loss.item()
            writer.add_scalar("rnd/predictor_loss", rnd_loss_val, global_step)
            # Log mean intrinsic reward this update (before normalisation)
            with torch.no_grad():
                r_i_batch = rnd_model.intrinsic_reward(all_global.float())
                writer.add_scalar("rnd/intrinsic_reward_mean", r_i_batch.mean().item(), global_step)

        # ── logging ───────────────────────────────────────────────────────────
        sps = int(global_step / (time.time() - start_time))
        writer.add_scalar("training/learning_rate",     optimizer.param_groups[0]["lr"], global_step)
        writer.add_scalar("training/steps_per_second",  sps,                             global_step)
        writer.add_scalar("ppo/policy_gradient_loss",   pg_loss.item(),                  global_step)
        writer.add_scalar("ppo/value_function_loss",    v_loss.item(),                   global_step)
        writer.add_scalar("ppo/entropy_bonus",          entropy_loss.item(),             global_step)
        writer.add_scalar("ppo/clip_fraction",          float(np.mean(clip_fracs)),      global_step)
        writer.add_scalar("ppo/approx_kl_divergence",  ((ratio - 1) - log_ratio).mean().item(), global_step)

        total_acts = max(action_counts.sum(), 1)
        writer.add_scalar("actions/pct_train_unit",          action_counts[2:6].sum()   / total_acts, global_step)
        writer.add_scalar("actions/pct_build",               action_counts[6:18].sum()  / total_acts, global_step)
        writer.add_scalar("actions/pct_attack_move",         action_counts[18:30].sum() / total_acts, global_step)
        writer.add_scalar("actions/pct_retreat",             action_counts[30:34].sum() / total_acts, global_step)
        writer.add_scalar("actions/pct_attack_targeted",     (action_counts[37:49].sum() + action_counts[58:66].sum()) / total_acts, global_step)
        writer.add_scalar("actions/pct_hold_position",       action_counts[49]           / total_acts, global_step)
        writer.add_scalar("actions/pct_attack_move_new",     action_counts[50:58].sum()  / total_acts, global_step)
        writer.add_scalar("actions/pct_attack_targeted_new", action_counts[58:66].sum()  / total_acts, global_step)
        writer.add_scalar("actions/pct_assign_workers",      action_counts[34:37].sum()  / total_acts, global_step)
        writer.add_scalar("actions/pct_worker_move",         action_counts[66:71].sum()  / total_acts, global_step)
        writer.add_scalar("actions/pct_idle_combat_atk",     action_counts[71:76].sum()  / total_acts, global_step)
        writer.add_scalar("actions/pct_idle_worker_move",    action_counts[76:81].sum()  / total_acts, global_step)

        # ── checkpoint ────────────────────────────────────────────────────────
        if update % cfg.save_interval == 0:
            path = ckpt_path / f"update_{update:06d}.pt"
            save_dict = {
                "update":      update,
                "global_step": global_step,
                "agent":       agent.state_dict(),
                "optimizer":   optimizer.state_dict(),
                "config":      cfg,
            }
            if rnd_model is not None:
                save_dict["rnd"] = rnd_model.state_dict()
            torch.save(save_dict, path)
            print(f"  [checkpoint] saved → {path}", flush=True)

        # ── league step ───────────────────────────────────────────────────────
        if league is not None:
            latest_ckpt = str(ckpt_path / f"update_{update:06d}.pt")
            league.step_update(update, latest_ckpt)
            league.save_state(league_state_path)
            matrix = league.get_win_rate_matrix()
            for opp_name, stats in matrix.items():
                writer.add_scalar(f"league/win_vs_{opp_name}", stats["win_rate"], global_step)
            matrix_text = "\n".join(
                f"  {n:30s}  {s['win_rate']:.3f}  ({s['wins']}/{s['total']})  [{s['type']}]"
                for n, s in sorted(matrix.items())
            )
            writer.add_text("league/win_rate_matrix", f"update {update}\n{matrix_text}", global_step)

        # ── apply pending curriculum stage change (update boundary) ────────────
        if pending_stage_change != 0:
            cur_stage_idx   += pending_stage_change
            cur_stage        = CURRICULUM[cur_stage_idx]
            stage_step_start = global_step
            if pending_stage_change > 0:
                print(f"\n  *** CURRICULUM PROMOTE → stage {cur_stage.name} "
                      f"(map={cur_stage.map_width or 'default'}, opp={cur_stage.opponent}) ***\n", flush=True)
            else:
                print(f"\n  *** CURRICULUM REGRESS → stage {cur_stage.name} (stuck) ***\n", flush=True)
            writer.add_scalar("curriculum/stage", cur_stage_idx, global_step)
            for ve in vec_envs: ve.close()
            _ov, _mt, _op, _pp = _resolve_env_params()
            vec_envs = _build_vec_envs(_ov, _mt, _op, _pp, forcing_scale=_cur_forcing_scale)
            _init = list(executor.map(_do_reset_vec,
                [(vec_envs[k], k, [[{}]*cfg.vec_size][0]) for k in range(cfg.num_procs)]))
            _flat = [r for batch in _init for r in batch]
            obs_list  = [r[0] for r in _flat]
            info_list = [r[1] for r in _flat]
            episode_rewards = [0.0] * cfg.num_envs
            episode_lengths = [0]   * cfg.num_envs
            pending_stage_change = 0

    # ── final save ───────────────────────────────────────────────────────────
    final_path = ckpt_path / "final.pt"
    torch.save({
        "update":      num_updates,
        "global_step": global_step,
        "agent":       agent.state_dict(),
        "optimizer":   optimizer.state_dict(),
        "config":      cfg,
    }, final_path)
    print(f"\nTraining complete. Final checkpoint: {final_path}")

    writer.close()
    executor.shutdown(wait=False)
    for venv in vec_envs:
        venv.close()


if __name__ == "__main__":
    cfg = tyro.cli(Config)
    train(cfg)
