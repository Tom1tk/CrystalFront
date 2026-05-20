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
    episodes:        int   = 500
    epochs:          int   = 3
    batch_size:      int   = 256
    learning_rate:   float = 1e-3
    device:          str   = "cuda"
    output:          str   = "bc_warmup.pt"
    demo_bot:        str   = "rush"    # blue player is driven by this scripted bot
    opponent:        str   = "idle"    # red player
    seed:            int   = 42
    # network dims — must match train.py defaults
    entity_d_model:  int   = 64
    entity_n_heads:  int   = 4
    entity_n_layers: int   = 2
    node_d_model:    int   = 32
    mlp_hidden:      int   = 384


def collect_demonstrations(cfg: Config) -> tuple[list[dict], list[int]]:
    """
    Run demo_bot as blue against opponent as red.
    The Node process drives blue internally and returns info['demoAction']
    at every tick — the macro-action index RushBot actually chose.
    """
    obs_list: list[dict] = []
    act_list: list[int]  = []

    # CrystalFrontEnv wraps a single stdioRunner process.
    # We pass demo_bot via options so the Node runner activates demo mode.
    env = CrystalFrontEnv(opponent=cfg.opponent, demo_bot=cfg.demo_bot)

    print(f"Collecting {cfg.episodes} episodes of {cfg.demo_bot} demonstrations vs {cfg.opponent}…")
    episodes_done = 0

    while episodes_done < cfg.episodes:
        obs, info = env.reset(seed=random.randint(0, 2**31))
        done = False
        while not done:
            # In demo mode the Node ignores the action we send.
            # We send 0 (noop) as a placeholder; the bot's choice is in info.
            demo_action = info.get("demoAction", 0)
            obs_list.append({k: v.copy() for k, v in obs.items()})
            act_list.append(int(demo_action))
            obs, _reward, terminated, truncated, info = env.step(0)
            done = terminated or truncated

        episodes_done += 1
        if episodes_done % 50 == 0:
            print(f"  collected {episodes_done}/{cfg.episodes} episodes  "
                  f"({len(obs_list):,} transitions)", flush=True)

    env.close()
    print(f"  Total transitions: {len(obs_list):,}")
    return obs_list, act_list


def train_bc(cfg: Config) -> None:
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    device = torch.device(cfg.device)

    obs_list, act_list = collect_demonstrations(cfg)
    N = len(obs_list)

    globals_arr      = np.stack([o["global"]      for o in obs_list])
    entities_arr     = np.stack([o["entities"]    for o in obs_list])
    entity_masks_arr = np.stack([o["entity_mask"] for o in obs_list])
    nodes_arr        = np.stack([o["nodes"]       for o in obs_list])
    node_masks_arr   = np.stack([o["node_mask"]   for o in obs_list])
    actions_arr      = np.array(act_list, dtype=np.int64)

    # Log action distribution to sanity-check we got real bot behaviour
    unique, counts = np.unique(actions_arr, return_counts=True)
    top = sorted(zip(counts, unique), reverse=True)[:8]
    print(f"\nTop demo actions (index: count):")
    for cnt, idx in top:
        print(f"  action {idx:3d}: {cnt:6d}  ({100*cnt/N:.1f}%)")

    agent = CrystalFrontAgent(
        entity_d_model=cfg.entity_d_model,
        entity_n_heads=cfg.entity_n_heads,
        entity_n_layers=cfg.entity_n_layers,
        node_d_model=cfg.node_d_model,
        mlp_hidden=cfg.mlp_hidden,
    ).to(device)

    optimizer = optim.Adam(agent.parameters(), lr=cfg.learning_rate)
    criterion = nn.CrossEntropyLoss()

    print(f"\nTraining BC for {cfg.epochs} epochs over {N:,} transitions…")
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

            logits = agent.actor_head(agent._encode(mb_obs))  # (B, ACTION_SPACE_SIZE)
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
