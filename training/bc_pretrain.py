"""
Behaviour Cloning pre-training for CrystalFront.

Runs RushBot (as blue) vs IdleBot (as red) for N episodes using stdioRunner's
demo mode.  At each tick the Node process drives blue with RushBot and returns
the chosen action index alongside the observation.  Python collects these
(obs, action) pairs and trains CrystalFrontAgent with cross-entropy loss.

The resulting bc_warmup.pt is checkpoint-compatible with train.py.

Usage:
    python -m training.bc_pretrain [options]

    --episodes 500    episodes of RushBot demonstrations to collect
    --epochs   3      supervised training epochs over collected data
    --output   bc_warmup.pt
"""

from __future__ import annotations

import os
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
os.environ.setdefault("PYTORCH_TUNABLEOP_ENABLED", "0")

import json
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


@dataclass
class Config:
    episodes:        int   = 1000     # review §4.10 recommends ~1000. WARNING: full game config (map_width=0)
                                     # produces ~3000 ticks/ep → ~3M transitions at 1000 eps → OOM on 24GB.
                                     # Use ≤300 for full game config; 1000 is safe only for 1500px config.
    epochs:          int   = 5
    batch_size:      int   = 256
    learning_rate:   float = 1e-3
    device:          str   = "cuda"
    output:          str   = "bc_warmup.pt"
    demo_bot:        str   = "rush"
    opponent:        str   = "idle"   # comma-separated list for mixed sampling, e.g. "rush_weak,rush_medium,passive"
    seed:            int   = 42
    noop_keep_frac:  float = 0.05    # keep only 5% of noop transitions (subtract redundant noops)
    min_train_actions: int = 0       # filter: only keep episodes with >= N train_unit actions (0 = no filter)
    # Match the target training config so BC observations transfer directly
    map_width:       int   = 1500    # Day 5 config (review §9.5)
    crystal_health:  int   = 200     # Day 5 config
    max_ticks:       int   = 3000    # Day 5 config
    # network dims — must match train.py defaults
    entity_d_model:  int   = 64
    entity_n_heads:  int   = 4
    entity_n_layers: int   = 2
    node_d_model:    int   = 32
    mlp_hidden:      int   = 384


GAMMA = 0.995  # must match train.py

def collect_demonstrations(cfg: Config) -> tuple[list[dict], list[int], list[float]]:
    """
    Run demo_bot as blue against opponent as red.
    Returns (obs_list, act_list, value_targets) where value_targets[i] is the
    discounted return from step i — used to pre-warm the critic so PPO starts
    with meaningful advantages rather than random noise.
    """
    obs_list: list[dict]  = []
    act_list: list[int]   = []
    ret_list: list[float] = []   # discounted return targets for critic pre-training

    # Support comma-separated opponent list for mixed sampling (§A6.2 second review)
    opponents = [o.strip() for o in cfg.opponent.split(",")]
    # Train-action indices 2-5 are train_unit per actionIndex.ts
    TRAIN_UNIT_INDICES = set(range(2, 6))

    cfg_ov: dict = {}
    if cfg.map_width      > 0: cfg_ov["mapWidth"]      = cfg.map_width
    if cfg.crystal_health > 0: cfg_ov["crystalHealth"]  = cfg.crystal_health

    # Build one env per distinct opponent; sample round-robin with env rotation
    envs = {opp: CrystalFrontEnv(opponent=opp, demo_bot=cfg.demo_bot,
                                  config_overrides=cfg_ov or None, max_ticks=cfg.max_ticks)
            for opp in opponents}

    opp_label = cfg.opponent if len(opponents) == 1 else f"mixed({cfg.opponent})"
    filter_label = f", filter≥{cfg.min_train_actions} train_unit" if cfg.min_train_actions > 0 else ""
    print(f"Collecting {cfg.episodes} episodes of {cfg.demo_bot} vs {opp_label}{filter_label}…")
    episodes_done = 0
    episodes_kept = 0

    while episodes_done < cfg.episodes:
        # Rotate through opponents uniformly
        opp = opponents[episodes_done % len(opponents)]
        env = envs[opp]

        obs, info = env.reset(seed=random.randint(0, 2**31))
        done = False
        ep_obs:  list[dict] = []
        ep_acts: list[int]  = []
        ep_rews: list[float] = []

        while not done:
            demo_action = info.get("demoAction", 0)
            ep_obs.append({k: v.copy() for k, v in obs.items()})
            ep_acts.append(int(demo_action))
            obs, reward, terminated, truncated, info = env.step(0)
            ep_rews.append(float(reward))
            done = terminated or truncated

        episodes_done += 1

        # Optional filter: skip episodes that don't contain enough train_unit actions
        if cfg.min_train_actions > 0:
            n_train = sum(1 for a in ep_acts if a in TRAIN_UNIT_INDICES)
            if n_train < cfg.min_train_actions:
                continue

        # Compute discounted returns backwards from episode end
        G = 0.0
        ep_rets: list[float] = [0.0] * len(ep_rews)
        for t in reversed(range(len(ep_rews))):
            G = ep_rews[t] + GAMMA * G
            ep_rets[t] = G

        obs_list.extend(ep_obs)
        act_list.extend(ep_acts)
        ret_list.extend(ep_rets)
        episodes_kept += 1

        if episodes_done % 50 == 0:
            print(f"  collected {episodes_done} episodes, kept {episodes_kept}  "
                  f"({len(obs_list):,} transitions)", flush=True)

    for env in envs.values():
        env.close()
    print(f"  Total transitions: {len(obs_list):,} from {episodes_kept} kept episodes")
    return obs_list, act_list, ret_list


def train_bc(cfg: Config) -> None:
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    device = torch.device(cfg.device)

    obs_list, act_list, ret_list = collect_demonstrations(cfg)
    N = len(obs_list)

    actions_arr_full = np.array(act_list, dtype=np.int64)

    # Subsample noop transitions for actor training only.
    noop_indices    = np.where(actions_arr_full == 0)[0]
    nonoop_indices  = np.where(actions_arr_full != 0)[0]
    keep_noop = max(1, int(len(noop_indices) * cfg.noop_keep_frac))
    rng = np.random.default_rng(cfg.seed)
    kept_noop = rng.choice(noop_indices, size=keep_noop, replace=False)
    keep_idx = np.sort(np.concatenate([nonoop_indices, kept_noop]))

    obs_actor  = [obs_list[i] for i in keep_idx]
    act_actor  = [act_list[i] for i in keep_idx]
    N = len(obs_actor)
    print(f"  After noop subsampling: {N:,} transitions "
          f"({len(nonoop_indices):,} non-noop + {keep_noop:,} noop)")

    globals_arr      = np.stack([o["global"]      for o in obs_list])
    entities_arr     = np.stack([o["entities"]    for o in obs_list])
    entity_masks_arr = np.stack([o["entity_mask"] for o in obs_list])
    nodes_arr        = np.stack([o["nodes"]       for o in obs_list])
    node_masks_arr   = np.stack([o["node_mask"]   for o in obs_list])
    actions_arr      = np.array(act_list, dtype=np.int64)

    # Log action distribution (subsampled)
    actions_arr = np.array(act_actor, dtype=np.int64)
    unique, counts = np.unique(actions_arr, return_counts=True)
    top = sorted(zip(counts, unique), reverse=True)[:8]
    print(f"\nTop demo actions after subsampling:")
    for cnt, idx in top:
        print(f"  action {idx:3d}: {cnt:6d}  ({100*cnt/N:.1f}%)")

    globals_arr      = np.stack([o["global"]      for o in obs_actor])
    entities_arr     = np.stack([o["entities"]    for o in obs_actor])
    entity_masks_arr = np.stack([o["entity_mask"] for o in obs_actor])
    nodes_arr        = np.stack([o["nodes"]       for o in obs_actor])
    node_masks_arr   = np.stack([o["node_mask"]   for o in obs_actor])

    # Full dataset for critic (all transitions, no noop filtering needed)
    Nv = len(obs_list)
    globals_v      = np.stack([o["global"]      for o in obs_list])
    entities_v     = np.stack([o["entities"]    for o in obs_list])
    emasks_v       = np.stack([o["entity_mask"] for o in obs_list])
    nodes_v        = np.stack([o["nodes"]       for o in obs_list])
    nmasks_v       = np.stack([o["node_mask"]   for o in obs_list])
    returns_arr    = np.array(ret_list, dtype=np.float32)
    print(f"  Critic targets: min={returns_arr.min():.1f}  mean={returns_arr.mean():.1f}  max={returns_arr.max():.1f}")

    agent = CrystalFrontAgent(
        entity_d_model=cfg.entity_d_model,
        entity_n_heads=cfg.entity_n_heads,
        entity_n_layers=cfg.entity_n_layers,
        node_d_model=cfg.node_d_model,
        mlp_hidden=cfg.mlp_hidden,
    ).to(device)

    optimizer = optim.Adam(agent.parameters(), lr=cfg.learning_rate)
    criterion = nn.CrossEntropyLoss()

    # ── Phase 1: actor training (subsampled, noop-balanced) ───────────────────
    print(f"\nActor BC training: {cfg.epochs} epochs over {N:,} transitions…")
    indices = np.arange(N)

    for epoch in range(1, cfg.epochs + 1):
        np.random.shuffle(indices)
        total_loss = 0.0
        n_batches  = 0
        correct    = 0

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
        print(f"  actor epoch {epoch}/{cfg.epochs}  loss={avg_loss:.4f}  acc={acc:.1f}%", flush=True)

    # ── Phase 2: critic pretraining on discounted returns (full dataset) ──────
    # PPO's advantages = R + γV(s') - V(s). If V starts random, advantages are
    # garbage and 10 updates of noisy gradients wipe out the BC actor prior.
    # Pretraining V on the demo returns gives PPO meaningful advantages from
    # update 1, preserving the actor prior.
    critic_opt = optim.Adam(agent.critic_head.parameters(), lr=cfg.learning_rate)
    mse = nn.MSELoss()

    print(f"\nCritic pretraining: 3 epochs over {Nv:,} full transitions…")
    v_indices = np.arange(Nv)
    for epoch in range(1, 4):
        np.random.shuffle(v_indices)
        total_vloss = 0.0
        n_vbatches  = 0
        for start in range(0, Nv, cfg.batch_size):
            end  = min(start + cfg.batch_size, Nv)
            bidx = v_indices[start:end]
            mb_obs = {
                "global":      torch.from_numpy(globals_v[bidx]).to(device),
                "entities":    torch.from_numpy(entities_v[bidx]).to(device),
                "entity_mask": torch.from_numpy(emasks_v[bidx]).to(device),
                "nodes":       torch.from_numpy(nodes_v[bidx]).to(device),
                "node_mask":   torch.from_numpy(nmasks_v[bidx]).to(device),
            }
            mb_rets = torch.from_numpy(returns_arr[bidx]).to(device)
            with torch.no_grad():
                hidden = agent._encode(mb_obs)
            value = agent.critic_head(hidden).squeeze(-1)
            vloss = mse(value, mb_rets)
            critic_opt.zero_grad()
            vloss.backward()
            nn.utils.clip_grad_norm_(agent.critic_head.parameters(), 1.0)
            critic_opt.step()
            total_vloss += vloss.item()
            n_vbatches  += 1
        print(f"  critic epoch {epoch}/3  mse={total_vloss/max(n_vbatches,1):.4f}", flush=True)

    out_path = Path(cfg.output)
    torch.save({
        "update":      0,
        "global_step": 0,
        "agent":       agent.state_dict(),
        "optimizer":   optimizer.state_dict(),
        "config":      cfg,
    }, out_path)
    print(f"\nBC warmup saved to: {out_path}")
    print("Suggested next step:")
    print("  python -m training.eval.eval_checkpoint --checkpoint bc_warmup.pt --episodes 50")
    print("  python -m training.ppo.train --curriculum True --checkpoint bc_warmup.pt --ent_coef 0.02")


if __name__ == "__main__":
    cfg = tyro.cli(Config)
    train_bc(cfg)
