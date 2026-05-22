"""
Behaviour Cloning fine-tuning to re-prime the train_unit action prior.

Loads an existing PPO checkpoint and runs actor-only BC on RushBot
demonstrations collected against a harder opponent, where RushBot naturally
trains multiple combat units. The goal is to re-introduce gradient for the
train_unit action, which PPO suppresses to zero after many updates of the
pure-rush strategy.

Design choices:
- Loads existing agent weights — does NOT train from scratch.
- Actor cross-entropy only — critic is already well-calibrated from PPO.
- Filters to episodes that contain at least one train_unit action, so every
  training example includes the target behaviour.
- Small LR (1e-4) — gentle nudge, not an overwrite.
- Saves with update=0 so train.py creates a fresh PPO optimizer (same rule as
  bc_warmup: never carry BC Adam momentum into PPO).

Usage:
    python -m training.bc_finetune \\
      --checkpoint checkpoints/.../update_000200.pt \\
      --output bc_finetune.pt \\
      --episodes 300 \\
      --epochs 3 \\
      --opponent rush_weak \\
      --map_width 3000 \\
      --crystal_health 300 \\
      --max_ticks 5000
"""

from __future__ import annotations

import os
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
os.environ.setdefault("PYTORCH_TUNABLEOP_ENABLED", "0")

import random
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
import tyro

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from training.env.crystalfront_env import CrystalFrontEnv
from training.ppo.policy import CrystalFrontAgent

# Action indices 2-5 are train_unit (skirmisher variants) per actionIndex.ts
TRAIN_UNIT_INDICES = set(range(2, 6))
NOOP_INDEX = 0


@dataclass
class Config:
    checkpoint:      str   = "bc_warmup.pt"
    output:          str   = "bc_finetune.pt"
    episodes:        int   = 300
    epochs:          int   = 3
    batch_size:      int   = 256
    learning_rate:   float = 1e-4        # small — gentle nudge not an overwrite
    device:          str   = "cuda"
    demo_bot:        str   = "rush"
    opponent:        str   = "rush_weak"
    seed:            int   = 42
    noop_keep_frac:  float = 0.05
    map_width:       int   = 3000
    crystal_health:  int   = 300
    max_ticks:       int   = 5000
    # Must match existing checkpoint's network dims
    entity_d_model:  int   = 64
    entity_n_heads:  int   = 4
    entity_n_layers: int   = 2
    node_d_model:    int   = 32
    mlp_hidden:      int   = 384


def collect_demos(cfg: Config) -> tuple[list, list]:
    """
    Collect RushBot demonstrations, keeping only episodes that contain at
    least one train_unit action. Returns (obs_list, act_list) after noop
    subsampling.
    """
    cfg_ov: dict = {}
    if cfg.map_width      > 0: cfg_ov["mapWidth"]      = cfg.map_width
    if cfg.crystal_health > 0: cfg_ov["crystalHealth"]  = cfg.crystal_health
    env = CrystalFrontEnv(
        opponent=cfg.opponent,
        demo_bot=cfg.demo_bot,
        config_overrides=cfg_ov or None,
        max_ticks=cfg.max_ticks,
    )

    all_obs:  list = []
    all_acts: list = []
    eps_done = 0
    eps_kept = 0

    print(f"Collecting {cfg.episodes} multi-unit episodes ({cfg.demo_bot} vs {cfg.opponent}, "
          f"{cfg.map_width}px/{cfg.crystal_health}HP)…")

    while eps_done < cfg.episodes:
        obs, info = env.reset(seed=random.randint(0, 2**31))
        done = False
        ep_obs:  list = []
        ep_acts: list = []

        while not done:
            demo_action = info.get("demoAction", 0)
            ep_obs.append({k: v.copy() for k, v in obs.items()})
            ep_acts.append(int(demo_action))
            obs, _, terminated, truncated, info = env.step(0)
            done = terminated or truncated

        eps_done += 1

        # Only keep episodes that include at least one train_unit action.
        # These are the episodes that demonstrate the multi-unit behaviour.
        if any(a in TRAIN_UNIT_INDICES for a in ep_acts):
            all_obs.extend(ep_obs)
            all_acts.extend(ep_acts)
            eps_kept += 1

        if eps_done % 50 == 0:
            print(f"  {eps_done}/{cfg.episodes} collected, {eps_kept} kept "
                  f"({100*eps_kept/eps_done:.0f}% have train_unit), "
                  f"{len(all_obs):,} transitions", flush=True)

    env.close()
    print(f"  Total kept transitions: {len(all_obs):,} from {eps_kept} episodes")

    if not all_obs:
        raise RuntimeError("No episodes with train_unit actions found. "
                           "Try a harder opponent or more episodes.")

    acts_arr = np.array(all_acts, dtype=np.int64)

    # Noop subsampling — same as bc_pretrain
    noop_idx   = np.where(acts_arr == NOOP_INDEX)[0]
    nonoop_idx = np.where(acts_arr != NOOP_INDEX)[0]
    keep_noop  = max(1, int(len(noop_idx) * cfg.noop_keep_frac))
    rng        = np.random.default_rng(cfg.seed)
    kept_noop  = rng.choice(noop_idx, size=keep_noop, replace=False)
    keep_idx   = np.sort(np.concatenate([nonoop_idx, kept_noop]))

    obs_out  = [all_obs[i]  for i in keep_idx]
    acts_out = [all_acts[i] for i in keep_idx]

    acts_sub = np.array(acts_out, dtype=np.int64)
    unique, counts = np.unique(acts_sub, return_counts=True)
    top = sorted(zip(counts, unique), reverse=True)[:8]
    print(f"\nTop actions after subsampling ({len(obs_out):,} transitions):")
    for cnt, idx in top:
        label = "train_unit" if idx in TRAIN_UNIT_INDICES else ("noop" if idx == 0 else f"act{idx}")
        print(f"  {label} (idx {idx:3d}): {cnt:6d}  ({100*cnt/len(obs_out):.1f}%)")

    return obs_out, acts_out


def finetune(cfg: Config) -> None:
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    device = torch.device(cfg.device)
    ckpt_path = Path(cfg.checkpoint)
    if not ckpt_path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {ckpt_path}")

    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    print(f"Loaded: {ckpt_path}  (update={ckpt.get('update', '?')}, "
          f"step={ckpt.get('global_step', '?'):,})")

    agent = CrystalFrontAgent(
        entity_d_model=cfg.entity_d_model,
        entity_n_heads=cfg.entity_n_heads,
        entity_n_layers=cfg.entity_n_layers,
        node_d_model=cfg.node_d_model,
        mlp_hidden=cfg.mlp_hidden,
    ).to(device)

    # Strip _orig_mod. prefix if checkpoint was saved from a compiled model
    state = ckpt["agent"]
    if any(k.startswith("_orig_mod.") for k in state):
        state = {k.replace("_orig_mod.", ""): v for k, v in state.items()}
    agent.load_state_dict(state)
    print("Agent weights loaded.")

    obs_list, act_list = collect_demos(cfg)
    N = len(obs_list)

    globals_arr      = np.stack([o["global"]      for o in obs_list])
    entities_arr     = np.stack([o["entities"]    for o in obs_list])
    entity_masks_arr = np.stack([o["entity_mask"] for o in obs_list])
    nodes_arr        = np.stack([o["nodes"]       for o in obs_list])
    node_masks_arr   = np.stack([o["node_mask"]   for o in obs_list])
    actions_arr      = np.array(act_list, dtype=np.int64)

    # Actor-only fine-tuning — critic is already well-calibrated from PPO
    optimizer = optim.Adam(agent.parameters(), lr=cfg.learning_rate)
    criterion = nn.CrossEntropyLoss()
    indices   = np.arange(N)

    print(f"\nActor fine-tuning: {cfg.epochs} epochs, lr={cfg.learning_rate}, {N:,} transitions…")
    for epoch in range(1, cfg.epochs + 1):
        np.random.shuffle(indices)
        total_loss = correct = 0
        n_batches  = 0

        for start in range(0, N, cfg.batch_size):
            end  = min(start + cfg.batch_size, N)
            bidx = indices[start:end]

            mb_obs = {
                "global":      torch.from_numpy(globals_arr[bidx]).to(device),
                "entities":    torch.from_numpy(entities_arr[bidx]).to(device),
                "entity_mask": torch.from_numpy(entity_masks_arr[bidx]).to(device),
                "nodes":       torch.from_numpy(nodes_arr[bidx]).to(device),
                "node_mask":   torch.from_numpy(node_masks_arr[bidx]).to(device),
            }
            mb_actions = torch.from_numpy(actions_arr[bidx]).to(device)

            logits = agent.actor_head(agent._encode(mb_obs))
            loss   = criterion(logits, mb_actions)

            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(agent.parameters(), 1.0)
            optimizer.step()

            total_loss += loss.item()
            n_batches  += 1
            correct    += (logits.argmax(-1) == mb_actions).sum().item()

        avg_loss = total_loss / max(n_batches, 1)
        acc      = 100.0 * correct / N
        print(f"  epoch {epoch}/{cfg.epochs}  loss={avg_loss:.4f}  acc={acc:.1f}%", flush=True)

    # Save with update=0 so train.py creates a fresh PPO optimizer — same rule
    # as bc_warmup: never carry BC Adam momentum into PPO.
    out_path = Path(cfg.output)
    torch.save({
        "update":      0,
        "global_step": 0,
        "agent":       agent.state_dict(),
        "optimizer":   optimizer.state_dict(),
    }, out_path)
    print(f"\nFine-tuned checkpoint saved: {out_path}")
    print("Next step:")
    print(f"  python -m training.ppo.train --curriculum --curriculum_stage 12 "
          f"--checkpoint {out_path} --ent_coef 0.02 --total_timesteps 20000000")


if __name__ == "__main__":
    cfg = tyro.cli(Config)
    finetune(cfg)
