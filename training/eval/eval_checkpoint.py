"""
Checkpoint evaluator — load a trained policy, play N deterministic matches vs
each scripted bot, and print a win-rate table.

Usage:
    python -m training.eval.eval_checkpoint --checkpoint checkpoints/.../update_000300.pt
    python -m training.eval.eval_checkpoint --checkpoint bc_warmup.pt --episodes 50

Output:
    opponent       wins/total   win_rate   avg_ticks   crystal_dmg%
    idle            90/100       90.0%       3241        89.3
    passive         62/100       62.0%       4812        61.2
    ...
"""

from __future__ import annotations

import os
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
os.environ.setdefault("PYTORCH_TUNABLEOP_ENABLED", "0")

import sys
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import tyro

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from training.env.crystalfront_env import CrystalFrontEnv
from training.ppo.policy import CrystalFrontAgent
from training.env.crystalfront_vec_env import ACTION_SPACE_SIZE


@dataclass
class Config:
    checkpoint:    str        = ""
    episodes:      int        = 100
    opponents:     list[str]  = field(default_factory=lambda: [
        "idle", "passive", "rush_weak", "rush_weak_medium", "rush_medium", "rush", "turtle", "macro",
    ])
    device:        str        = "cuda"
    seed:          int        = 0
    deterministic: bool       = True    # greedy action selection (argmax)
    # Map/env config overrides (0 = game default)
    map_width:      int       = 0
    crystal_health: int       = 0
    max_ticks:      int       = 6000
    decision_interval: int    = 8   # frame skip (Phase 2 Task 2.1) — must match the policy's training MDP
    # Override network dims if needed (defaults match train.py)
    entity_d_model:  int = 64
    entity_n_heads:  int = 4
    entity_n_layers: int = 2
    node_d_model:    int = 32
    mlp_hidden:      int = 384


def eval_vs_opponent(
    agent: CrystalFrontAgent,
    opponent: str,
    episodes: int,
    device: torch.device,
    seed_offset: int,
    deterministic: bool,
    config_overrides: dict | None = None,
    max_ticks: int = 6000,
    decision_interval: int = 8,
) -> dict:
    env = CrystalFrontEnv(opponent=opponent,
                          config_overrides=config_overrides or None,
                          max_ticks=max_ticks,
                          decision_interval=decision_interval)
    wins       = 0
    total_ticks: list[int]   = []
    crys_dmg:   list[float]  = []

    for ep in range(episodes):
        obs, info = env.reset(seed=seed_offset + ep)
        done = False
        while not done:
            legal_mask = info["legal_mask"]
            obs_t = {
                k: torch.from_numpy(v).unsqueeze(0).to(device)
                for k, v in obs.items()
            }
            legal_t = torch.from_numpy(legal_mask).unsqueeze(0).to(device)
            with torch.no_grad():
                if deterministic:
                    hidden = agent._encode(obs_t)
                    logits = agent.actor_head(hidden).squeeze(0)
                    logits = logits.masked_fill(~legal_t.squeeze(0), -1e9)
                    action = int(logits.argmax().item())
                else:
                    action, _, _, _ = agent.get_action_and_value(obs_t, legal_mask=legal_t)
                    action = int(action.item())
            obs, _reward, terminated, truncated, info = env.step(action)
            done = terminated or truncated

        winner   = info.get("winner", "")
        win_type = info.get("winType", "")
        won = winner == "headless-blue" and win_type != "resource"
        if won:
            wins += 1
        total_ticks.append(info.get("ticks", 0))
        crys_dmg.append(float(info.get("enemyCrystalDamagePct", 0.0)))

    env.close()
    return {
        "opponent":    opponent,
        "wins":        wins,
        "total":       episodes,
        "win_rate":    wins / episodes,
        "avg_ticks":   int(np.mean(total_ticks)),
        "crys_dmg":    float(np.mean(crys_dmg)),
    }


def main(cfg: Config) -> None:
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    device = torch.device(cfg.device)

    agent = CrystalFrontAgent(
        entity_d_model=cfg.entity_d_model,
        entity_n_heads=cfg.entity_n_heads,
        entity_n_layers=cfg.entity_n_layers,
        node_d_model=cfg.node_d_model,
        mlp_hidden=cfg.mlp_hidden,
    ).to(device)

    if cfg.checkpoint:
        ckpt = torch.load(cfg.checkpoint, map_location=device, weights_only=False)
        state = ckpt["agent"]
        if any(k.startswith("_orig_mod.") for k in state):
            state = {k.replace("_orig_mod.", ""): v for k, v in state.items()}
        agent.load_state_dict(state)
        update = ckpt.get("update", "?")
        step   = ckpt.get("global_step", 0)
        print(f"Loaded: {cfg.checkpoint}  (update={update}, step={step:,})")
    else:
        print("No checkpoint provided — evaluating random policy.")

    agent.eval()

    print(f"\n{'opponent':<16} {'wins/total':<14} {'win_rate':>8}   {'avg_ticks':>9}   {'crys_dmg%':>9}")
    print("-" * 65)

    cfg_ov: dict = {}
    if cfg.map_width      > 0: cfg_ov["mapWidth"]     = cfg.map_width
    if cfg.crystal_health > 0: cfg_ov["crystalHealth"] = cfg.crystal_health

    results = []
    for opp in cfg.opponents:
        r = eval_vs_opponent(
            agent=agent,
            opponent=opp,
            episodes=cfg.episodes,
            device=device,
            seed_offset=cfg.seed * 1000,
            deterministic=cfg.deterministic,
            config_overrides=cfg_ov or None,
            max_ticks=cfg.max_ticks,
            decision_interval=cfg.decision_interval,
        )
        results.append(r)
        print(
            f"  {r['opponent']:<14} {r['wins']}/{r['total']:<10}  "
            f"{r['win_rate']*100:>6.1f}%   {r['avg_ticks']:>9d}   {r['crys_dmg']:>8.1f}%",
            flush=True,
        )

    print()
    overall_wins  = sum(r["wins"]  for r in results)
    overall_total = sum(r["total"] for r in results)
    print(f"  {'OVERALL':<14} {overall_wins}/{overall_total:<10}  {100*overall_wins/max(overall_total,1):>6.1f}%")


if __name__ == "__main__":
    cfg = tyro.cli(Config)
    main(cfg)
