"""
Crystal Front PPO Trainer

Based on CleanRL's PPO reference implementation (https://github.com/vwxyzjn/cleanrl).
Adapted for:
  - Structured Dict observations (global + entity set + node set)
  - Legal-action masking
  - Multiple parallel Node.js simulators as the environment backend

Usage examples:
  # Baseline: train vs idle bot first (should converge quickly)
  python training/ppo/train.py --opponent idle --num_envs 4 --total_timesteps 500000

  # Main training run vs strongest scripted bot
  python training/ppo/train.py --opponent macro --num_envs 8 --total_timesteps 5000000

  # Monitor in TensorBoard (run in a second terminal):
  tensorboard --logdir /root/CrystalFront/runs --bind_all

Key hyperparameter guidance:
  num_envs      — increase to use more CPU cores (each env = 1 Node subprocess)
                  28-core Xeon: try num_envs=16 or 20
  num_steps     — rollout length per env; 512 is good for episodes ~1000 ticks
  gamma         — 0.995 works well for long episodes (up to 6000 ticks)
  opponent      — start with 'idle', then 'rush', then 'turtle', then 'macro'
                  Move to the next once win rate > 90% for 200k steps

When to stop:
  Phase 3 done = win rate vs IdleBot at 100% AND visible reward improvement vs macro.
  Phase 4 (league / self-play) begins after Phase 3 is confirmed working.
"""

from __future__ import annotations

import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.tensorboard import SummaryWriter
import tyro

# ── project imports ───────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from training.env.crystalfront_env import (
    CrystalFrontEnv,
    GLOBAL_DIM, ENTITY_DIM, NODE_DIM,
    MAX_ENTITIES, MAX_NODES, ACTION_SPACE_SIZE,
)
from training.ppo.policy import CrystalFrontAgent
from training.ppo.league import LeagueManager, SCRIPTED_BOTS


# ── config ────────────────────────────────────────────────────────────────────

@dataclass
class Config:
    # Experiment identity
    exp_name:  str = "crystalfront_ppo"
    seed:      int = 1
    device:    str = "cpu"   # "cpu" or "cuda" (ROCm: set HIP_VISIBLE_DEVICES and use "cuda")

    # Environment
    num_envs:           int = 4           # parallel Node simulators
    opponent:           str = "macro"     # idle | rush | turtle | macro
    save_replay_every:  int = 500         # save a replay every N episodes per env (0=off)

    # Training duration
    total_timesteps: int = 5_000_000

    # Optimiser
    learning_rate: float = 3e-4
    anneal_lr:     bool  = True           # cosine-anneal LR to 0 by end of training

    # PPO rollout
    num_steps:      int   = 512           # steps per env per rollout
    gamma:          float = 0.995         # high for long episodes (up to 6000 ticks)
    gae_lambda:     float = 0.95

    # PPO update
    update_epochs:    int   = 4
    num_minibatches:  int   = 4
    clip_coef:        float = 0.2
    norm_adv:         bool  = True
    clip_vloss:       bool  = True
    ent_coef:         float = 0.01        # entropy bonus — keep > 0 to encourage exploration
    vf_coef:          float = 0.5
    max_grad_norm:    float = 0.5

    # Network
    entity_d_model:  int = 64
    entity_n_heads:  int = 4
    entity_n_layers: int = 2
    node_d_model:    int = 32
    mlp_hidden:      int = 256

    # Logging & checkpoints
    log_dir:        str = "runs"
    checkpoint_dir: str = "checkpoints"
    save_interval:  int = 50              # save checkpoint every N policy updates

    # Phase 4 — league training (PFSP opponent sampling)
    league:               bool  = False   # enable league mode
    league_pfsp_temp:     float = 0.5     # PFSP temperature: higher = focus on hard opponents
    league_add_interval:  int   = 100     # add current policy as opponent every N updates (0=off)
    league_state:         str   = ""      # path to league state JSON (auto-generated if blank)

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


def obs_to_tensor(obs: dict, device: torch.device) -> dict[str, torch.Tensor]:
    """Convert numpy obs dict → device tensors, adding batch dim."""
    return {
        k: torch.as_tensor(
            v[None] if v.ndim < 2 else v[None],   # add batch dim
            dtype=torch.bool if v.dtype == bool or v.dtype == np.bool_ else torch.float32,
            device=device,
        )
        for k, v in obs.items()
    }


def stack_obs(obs_list: list[dict]) -> dict[str, np.ndarray]:
    """Stack a list of single-env obs dicts into a batched numpy dict."""
    return {k: np.stack([o[k] for o in obs_list]) for k in obs_list[0]}


def batch_obs_to_tensor(obs_batch: dict[str, np.ndarray], device: torch.device) -> dict[str, torch.Tensor]:
    """Convert batched numpy obs dict → device tensors."""
    return {
        k: torch.as_tensor(
            v,
            dtype=torch.bool if v.dtype == bool or v.dtype == np.bool_ else torch.float32,
            device=device,
        )
        for k, v in obs_batch.items()
    }


# ── rollout buffer ────────────────────────────────────────────────────────────

class RolloutBuffer:
    """Stores one rollout (num_steps × num_envs transitions) as numpy arrays."""

    def __init__(self, num_steps: int, num_envs: int):
        self.T = num_steps
        self.E = num_envs
        self.pos = 0

        self.globals      = np.zeros((num_steps, num_envs, GLOBAL_DIM),           dtype=np.float32)
        self.entities     = np.zeros((num_steps, num_envs, MAX_ENTITIES, ENTITY_DIM), dtype=np.float32)
        self.entity_masks = np.zeros((num_steps, num_envs, MAX_ENTITIES),          dtype=bool)
        self.nodes        = np.zeros((num_steps, num_envs, MAX_NODES, NODE_DIM),  dtype=np.float32)
        self.node_masks   = np.zeros((num_steps, num_envs, MAX_NODES),            dtype=bool)
        self.legal_masks  = np.zeros((num_steps, num_envs, ACTION_SPACE_SIZE),    dtype=bool)

        self.actions   = np.zeros((num_steps, num_envs), dtype=np.int64)
        self.logprobs  = np.zeros((num_steps, num_envs), dtype=np.float32)
        self.rewards   = np.zeros((num_steps, num_envs), dtype=np.float32)
        self.dones     = np.zeros((num_steps, num_envs), dtype=np.float32)
        self.values    = np.zeros((num_steps, num_envs), dtype=np.float32)

    def add(
        self,
        step: int,
        env_obs: list[dict],       # list of obs, one per env
        legal_masks: np.ndarray,   # (num_envs, 73)
        actions: np.ndarray,       # (num_envs,)
        logprobs: np.ndarray,      # (num_envs,)
        rewards: np.ndarray,       # (num_envs,)
        dones: np.ndarray,         # (num_envs,)
        values: np.ndarray,        # (num_envs,)
    ) -> None:
        for i, obs in enumerate(env_obs):
            self.globals[step, i]      = obs["global"]
            self.entities[step, i]     = obs["entities"]
            self.entity_masks[step, i] = obs["entity_mask"]
            self.nodes[step, i]        = obs["nodes"]
            self.node_masks[step, i]   = obs["node_mask"]
        self.legal_masks[step] = legal_masks
        self.actions[step]     = actions
        self.logprobs[step]    = logprobs
        self.rewards[step]     = rewards
        self.dones[step]       = dones
        self.values[step]      = values

    def flatten(self) -> dict[str, np.ndarray]:
        """Flatten (T, E, ...) → (T*E, ...) for minibatch sampling."""
        B = self.T * self.E
        return {
            "globals":      self.globals.reshape(B, GLOBAL_DIM),
            "entities":     self.entities.reshape(B, MAX_ENTITIES, ENTITY_DIM),
            "entity_masks": self.entity_masks.reshape(B, MAX_ENTITIES),
            "nodes":        self.nodes.reshape(B, MAX_NODES, NODE_DIM),
            "node_masks":   self.node_masks.reshape(B, MAX_NODES),
            "legal_masks":  self.legal_masks.reshape(B, ACTION_SPACE_SIZE),
            "actions":      self.actions.reshape(B),
            "logprobs":     self.logprobs.reshape(B),
            "rewards":      self.rewards.reshape(B),
            "dones":        self.dones.reshape(B),
            "values":       self.values.reshape(B),
        }


# ── training ──────────────────────────────────────────────────────────────────

def train(cfg: Config) -> None:
    set_seed(cfg.seed)
    device = torch.device(cfg.device)

    opp_label = "league" if cfg.league else cfg.opponent
    run_name = f"{cfg.exp_name}__{opp_label}__{cfg.seed}__{int(time.time())}"
    log_path  = Path(cfg.log_dir) / run_name
    ckpt_path = Path(cfg.checkpoint_dir) / run_name
    ckpt_path.mkdir(parents=True, exist_ok=True)

    writer = SummaryWriter(str(log_path))
    writer.add_text("config", str(cfg))
    print(f"\nCrystalFront PPO training")
    if cfg.league:
        print(f"  Mode:       LEAGUE (PFSP, temp={cfg.league_pfsp_temp})")
    else:
        print(f"  Opponent:   {cfg.opponent}")
    print(f"  Envs:       {cfg.num_envs}")
    print(f"  Batch size: {cfg.batch_size}  (steps={cfg.num_steps} × envs={cfg.num_envs})")
    print(f"  Device:     {device}")
    print(f"  Run name:   {run_name}\n")

    # ── league ─────────────────────────────────────────────────────────────────
    league: LeagueManager | None = None
    league_state_path: str = ""
    if cfg.league:
        league_state_path = cfg.league_state
        if not league_state_path:
            league_state_path = str(ckpt_path / "league_state.json")
        elif not os.path.isabs(league_state_path):
            league_state_path = str(Path(league_state_path).resolve())

        league = LeagueManager(
            num_envs=cfg.num_envs,
            pfsp_temperature=cfg.league_pfsp_temp,
            add_interval=cfg.league_add_interval,
            results_dir=cfg.log_dir,
        )
        # Resume from previous league state if it exists
        if os.path.exists(league_state_path):
            print(f"  Resuming league state from {league_state_path}")
            league.load_state(league_state_path)
        print(f"  League opponents: {list(league.state.opponents.keys())}")
        print(f"  League state will be saved to: {league_state_path}")

    # ── environments ─────────────────────────────────────────────────────────
    envs = [
        CrystalFrontEnv(
            opponent=cfg.opponent,
            save_replay_every=cfg.save_replay_every,
        )
        for _ in range(cfg.num_envs)
    ]

    # ── agent & optimiser ─────────────────────────────────────────────────────
    agent = CrystalFrontAgent(
        entity_d_model=cfg.entity_d_model,
        entity_n_heads=cfg.entity_n_heads,
        entity_n_layers=cfg.entity_n_layers,
        node_d_model=cfg.node_d_model,
        mlp_hidden=cfg.mlp_hidden,
    ).to(device)

    optimizer = optim.Adam(agent.parameters(), lr=cfg.learning_rate, eps=1e-5)

    # ── initial reset ─────────────────────────────────────────────────────────
    obs_list: list[dict]   = []
    info_list: list[dict]  = []
    for i, env in enumerate(envs):
        opts = {}
        if league is not None:
            # Sample initial opponent for this env
            opp = league.assign_env_opponent(i)
            opts["opponent"] = opp
        obs, info = env.reset(seed=cfg.seed, options=opts if opts else None)
        obs_list.append(obs)
        info_list.append(info)

    # ── bookkeeping ───────────────────────────────────────────────────────────
    buffer = RolloutBuffer(cfg.num_steps, cfg.num_envs)
    num_updates         = cfg.total_timesteps // cfg.batch_size
    global_step         = 0
    episode_rewards     = [0.0] * cfg.num_envs
    episode_lengths     = [0]   * cfg.num_envs
    completed_episodes  = 0
    wins_last_window    = 0
    window_episodes     = 0
    WIN_WINDOW          = 100   # log win-rate over last N episodes

    start_time = time.time()

    # ── main training loop ────────────────────────────────────────────────────
    for update in range(1, num_updates + 1):

        # LR annealing (cosine schedule)
        if cfg.anneal_lr:
            frac = 1.0 - (update - 1) / num_updates
            optimizer.param_groups[0]["lr"] = cfg.learning_rate * frac

        # ── rollout collection ────────────────────────────────────────────────
        for step in range(cfg.num_steps):
            global_step += cfg.num_envs

            # Batch current observations
            obs_batch = stack_obs(obs_list)
            obs_t = batch_obs_to_tensor(obs_batch, device)

            legal_masks_np = np.stack([info_list[i]["legal_mask"] for i in range(cfg.num_envs)])
            legal_t = torch.as_tensor(legal_masks_np, dtype=torch.bool, device=device)

            with torch.no_grad():
                actions_t, logprobs_t, _, values_t = agent.get_action_and_value(
                    obs_t, legal_mask=legal_t
                )
                values_np = values_t.squeeze(-1).cpu().numpy()

            actions_np  = actions_t.cpu().numpy()
            logprobs_np = logprobs_t.cpu().numpy()

            # Step each environment
            next_obs_list: list[dict]  = []
            next_info_list: list[dict] = []
            rewards_np = np.zeros(cfg.num_envs, dtype=np.float32)
            dones_np   = np.zeros(cfg.num_envs, dtype=np.float32)

            for i, env in enumerate(envs):
                obs_next, reward, terminated, truncated, info = env.step(int(actions_np[i]))
                done = terminated or truncated
                rewards_np[i] = reward
                dones_np[i]   = float(done)
                episode_rewards[i] += reward
                episode_lengths[i] += 1

                if done:
                    completed_episodes += 1
                    window_episodes    += 1
                    winner = info.get("winner")
                    won = winner == "headless-blue"
                    if won:
                        wins_last_window += 1

                    # League: record per-opponent result
                    if league is not None:
                        opp = league.get_env_opponent(i)
                        league.record_result(opp, won)

                    writer.add_scalar("charts/episode_reward", episode_rewards[i], global_step)
                    writer.add_scalar("charts/episode_length", episode_lengths[i], global_step)
                    if window_episodes >= WIN_WINDOW:
                        win_rate = wins_last_window / window_episodes
                        writer.add_scalar("charts/win_rate", win_rate, global_step)
                        print(
                            f"  update={update:5d} | step={global_step:8d} | "
                            f"win_rate={win_rate:.2f} ({wins_last_window}/{window_episodes}) | "
                            f"ep_len={episode_lengths[i]:4d} | "
                            f"ep_rew={episode_rewards[i]:.2f}"
                        )
                        wins_last_window = 0
                        window_episodes  = 0

                    episode_rewards[i] = 0.0
                    episode_lengths[i] = 0

                    # Reset this env — sample a new opponent if in league mode
                    opts = {}
                    if league is not None:
                        opp = league.assign_env_opponent(i)
                        opts["opponent"] = opp
                    obs_next, info = env.reset(options=opts if opts else None)

                next_obs_list.append(obs_next)
                next_info_list.append(info)

            buffer.add(step, obs_list, legal_masks_np, actions_np, logprobs_np,
                       rewards_np, dones_np, values_np)
            obs_list  = next_obs_list
            info_list = next_info_list

        # ── bootstrap last value with GAE ────────────────────────────────────
        with torch.no_grad():
            next_obs_batch = stack_obs(obs_list)
            next_obs_t = batch_obs_to_tensor(next_obs_batch, device)
            next_values = agent.get_value(next_obs_t).squeeze(-1).cpu().numpy()

        flat = buffer.flatten()
        T, E = cfg.num_steps, cfg.num_envs
        rewards_2d = flat["rewards"].reshape(T, E)
        dones_2d   = flat["dones"].reshape(T, E)
        values_2d  = flat["values"].reshape(T, E)

        advantages_2d = np.zeros_like(rewards_2d)
        last_gae      = np.zeros(E)
        for t in reversed(range(T)):
            next_val  = next_values if t == T - 1 else values_2d[t + 1]
            next_done = dones_2d[t] if t == T - 1 else dones_2d[t]
            delta = rewards_2d[t] + cfg.gamma * next_val * (1.0 - next_done) - values_2d[t]
            last_gae = delta + cfg.gamma * cfg.gae_lambda * (1.0 - dones_2d[t]) * last_gae
            advantages_2d[t] = last_gae
        returns_2d = advantages_2d + values_2d

        advantages_flat = advantages_2d.flatten()
        returns_flat    = returns_2d.flatten()

        # ── PPO update ────────────────────────────────────────────────────────
        B = cfg.batch_size
        indices = np.arange(B)
        clip_fracs = []

        for epoch in range(cfg.update_epochs):
            np.random.shuffle(indices)
            for start in range(0, B, cfg.minibatch_size):
                end = start + cfg.minibatch_size
                mb_idx = indices[start:end]

                mb_obs = {
                    "global":      torch.as_tensor(flat["globals"][mb_idx],      device=device),
                    "entities":    torch.as_tensor(flat["entities"][mb_idx],     device=device),
                    "entity_mask": torch.as_tensor(flat["entity_masks"][mb_idx], dtype=torch.bool, device=device),
                    "nodes":       torch.as_tensor(flat["nodes"][mb_idx],        device=device),
                    "node_mask":   torch.as_tensor(flat["node_masks"][mb_idx],   dtype=torch.bool, device=device),
                }
                mb_legal = torch.as_tensor(flat["legal_masks"][mb_idx], dtype=torch.bool, device=device)
                mb_actions  = torch.as_tensor(flat["actions"][mb_idx],   device=device)
                mb_logprobs = torch.as_tensor(flat["logprobs"][mb_idx],  device=device)
                mb_advs     = torch.as_tensor(advantages_flat[mb_idx],   device=device)
                mb_returns  = torch.as_tensor(returns_flat[mb_idx],      device=device)
                mb_values   = torch.as_tensor(flat["values"][mb_idx],    device=device)

                _, new_logprobs, entropy, new_values = agent.get_action_and_value(
                    mb_obs, action=mb_actions, legal_mask=mb_legal
                )
                new_values = new_values.squeeze(-1)
                log_ratio  = new_logprobs - mb_logprobs
                ratio      = log_ratio.exp()

                with torch.no_grad():
                    clip_fracs.append(((ratio - 1.0).abs() > cfg.clip_coef).float().mean().item())

                if cfg.norm_adv:
                    mb_advs = (mb_advs - mb_advs.mean()) / (mb_advs.std() + 1e-8)

                # Policy loss (PPO clip)
                pg_loss1 = -mb_advs * ratio
                pg_loss2 = -mb_advs * ratio.clamp(1 - cfg.clip_coef, 1 + cfg.clip_coef)
                pg_loss  = torch.max(pg_loss1, pg_loss2).mean()

                # Value loss
                if cfg.clip_vloss:
                    v_loss_unclipped = (new_values - mb_returns) ** 2
                    v_clipped = mb_values + (new_values - mb_values).clamp(-cfg.clip_coef, cfg.clip_coef)
                    v_loss_clipped = (v_clipped - mb_returns) ** 2
                    v_loss = 0.5 * torch.max(v_loss_unclipped, v_loss_clipped).mean()
                else:
                    v_loss = 0.5 * ((new_values - mb_returns) ** 2).mean()

                entropy_loss = entropy.mean()
                loss = pg_loss - cfg.ent_coef * entropy_loss + cfg.vf_coef * v_loss

                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(agent.parameters(), cfg.max_grad_norm)
                optimizer.step()

        # ── logging ───────────────────────────────────────────────────────────
        sps = int(global_step / (time.time() - start_time))
        writer.add_scalar("charts/learning_rate",       optimizer.param_groups[0]["lr"],            global_step)
        writer.add_scalar("charts/sps",                 sps,                                        global_step)
        writer.add_scalar("losses/policy_loss",         pg_loss.item(),                             global_step)
        writer.add_scalar("losses/value_loss",          v_loss.item(),                              global_step)
        writer.add_scalar("losses/entropy",             entropy_loss.item(),                        global_step)
        writer.add_scalar("losses/clip_frac",           np.mean(clip_fracs),                        global_step)
        writer.add_scalar("losses/approx_kl",           ((ratio - 1) - log_ratio).mean().item(),    global_step)

        # ── checkpoint ────────────────────────────────────────────────────────
        if update % cfg.save_interval == 0:
            path = ckpt_path / f"update_{update:06d}.pt"
            torch.save({
                "update":       update,
                "global_step":  global_step,
                "agent":        agent.state_dict(),
                "optimizer":    optimizer.state_dict(),
                "config":       cfg,
            }, path)
            print(f"  [checkpoint] saved → {path}")

        # ── league step ───────────────────────────────────────────────────────
        if league is not None:
            # Register the latest checkpoint with the league
            latest_ckpt = str(ckpt_path / f"update_{update:06d}.pt")
            league.step_update(update, latest_ckpt)
            # Save league state
            league.save_state(league_state_path)
            # Log win-rate matrix to TensorBoard
            matrix = league.get_win_rate_matrix()
            for opp_name, stats in matrix.items():
                writer.add_scalar(f"league/win_rate_{opp_name}", stats["win_rate"], global_step)
            # Also write matrix as text (viewable in TensorBoard text tab)
            matrix_text = "\n".join(
                f"  {n:30s}  {s['win_rate']:.3f}  ({s['wins']}/{s['total']})  [{s['type']}]"
                for n, s in sorted(matrix.items())
            )
            writer.add_text("league/win_rate_matrix", f"update {update}\n{matrix_text}", global_step)

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
    for env in envs:
        env.close()


if __name__ == "__main__":
    cfg = tyro.cli(Config)
    train(cfg)
