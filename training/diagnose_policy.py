"""
Diagnostic: per-episode action histogram for a trained checkpoint.

Records for each episode:
  - outcome (win/loss/timeout)
  - train_unit actions taken (indices 2-5)
  - train_worker actions taken (index 1)
  - noop actions taken (index 0)
  - maximum consecutive noop streak
  - episode length (ticks)

Purpose: determine whether the current policy ever trains a second combat unit
in winning games. This is the G1' gate before Option B action-masking work.

  If wins with >=2 train_unit actions / total wins >= 5%:
      gradient signal exists — action-masking amplifies it.
  If wins with >=2 train_unit actions / total wins < 5%:
      forcing is mandatory, not just an amplifier.
  If train_unit_count == 0 across all 100 episodes:
      action is completely dead — consider escalating to intrinsic motivation.

Usage:
    python -m training.diagnose_policy \\
        --checkpoint checkpoints/.../update_000150.pt \\
        --opponent rush_weak_medium \\
        --episodes 100 \\
        --output /tmp/diag_u150_rwm.csv
"""

from __future__ import annotations

import csv
import os
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
os.environ.setdefault("PYTORCH_TUNABLEOP_ENABLED", "0")

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import tyro

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from training.env.crystalfront_env import CrystalFrontEnv
from training.ppo.policy import CrystalFrontAgent
from training.env.crystalfront_vec_env import ACTION_SPACE_SIZE

# Action index ranges (from headless/src/actionIndex.ts)
IDX_NOOP         = 0
IDX_TRAIN_WORKER = 1
IDX_TRAIN_UNIT_START = 2   # skirmisher
IDX_TRAIN_UNIT_END   = 5   # medic (inclusive)


@dataclass
class Config:
    checkpoint: str   = ""
    opponent:   str   = "rush_weak_medium"
    episodes:   int   = 100
    output:     str   = "/tmp/diag_u150_rwm.csv"
    device:     str   = "cuda"
    seed:       int   = 0
    map_width:      int = 0
    crystal_health: int = 0
    max_ticks:      int = 6000
    entity_d_model:  int = 64
    entity_n_heads:  int = 4
    entity_n_layers: int = 2
    node_d_model:    int = 32
    mlp_hidden:      int = 384


def run(cfg: Config) -> None:
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
        print("No checkpoint — random policy.")
    agent.eval()

    cfg_ov: dict = {}
    if cfg.map_width      > 0: cfg_ov["mapWidth"]      = cfg.map_width
    if cfg.crystal_health > 0: cfg_ov["crystalHealth"] = cfg.crystal_health

    env = CrystalFrontEnv(opponent=cfg.opponent, config_overrides=cfg_ov or None,
                          max_ticks=cfg.max_ticks)

    rows: list[dict] = []

    print(f"\nRunning {cfg.episodes} episodes vs {cfg.opponent} …")
    for ep in range(cfg.episodes):
        obs, info = env.reset(seed=cfg.seed * 1000 + ep)
        done = False

        train_unit_count  = 0
        train_worker_count = 0
        noop_count        = 0
        noop_streak       = 0
        max_noop_streak   = 0

        while not done:
            legal_mask = info["legal_mask"]
            obs_t  = {k: torch.from_numpy(v).unsqueeze(0).to(device) for k, v in obs.items()}
            legal_t = torch.from_numpy(legal_mask).unsqueeze(0).to(device)
            with torch.no_grad():
                hidden = agent._encode(obs_t)
                logits = agent.actor_head(hidden).squeeze(0)
                logits = logits.masked_fill(~legal_t.squeeze(0), -1e9)
                action = int(logits.argmax().item())

            if action == IDX_NOOP:
                noop_count  += 1
                noop_streak += 1
                max_noop_streak = max(max_noop_streak, noop_streak)
            else:
                noop_streak = 0

            if IDX_TRAIN_UNIT_START <= action <= IDX_TRAIN_UNIT_END:
                train_unit_count += 1
            elif action == IDX_TRAIN_WORKER:
                train_worker_count += 1

            obs, _reward, terminated, truncated, info = env.step(action)
            done = terminated or truncated

        winner   = info.get("winner", "")
        win_type = info.get("winType", "")
        won = winner == "headless-blue" and win_type != "resource"
        outcome = "win" if won else ("timeout" if info.get("ticks", 0) >= cfg.max_ticks else "loss")

        rows.append({
            "episode":           ep,
            "outcome":           outcome,
            "train_unit_count":  train_unit_count,
            "train_worker_count": train_worker_count,
            "noop_count":        noop_count,
            "max_noop_streak":   max_noop_streak,
            "ticks":             info.get("ticks", 0),
        })

        if (ep + 1) % 10 == 0:
            done_rows = rows
            w = sum(1 for r in done_rows if r["outcome"] == "win")
            print(f"  ep {ep+1:3d}/{cfg.episodes}: {w}/{ep+1} wins so far, "
                  f"last trn_u={train_unit_count}, noop_max={max_noop_streak}", flush=True)

    env.close()

    # Write CSV
    out = Path(cfg.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nCSV written to {out}")

    # Summary
    wins    = [r for r in rows if r["outcome"] == "win"]
    losses  = [r for r in rows if r["outcome"] != "win"]
    total   = len(rows)
    n_wins  = len(wins)

    print(f"\n{'='*60}")
    print(f"SUMMARY: {cfg.opponent}, {total} episodes")
    print(f"  Wins:       {n_wins}/{total}  ({100*n_wins/max(total,1):.1f}%)")
    print(f"  Losses:     {len(losses)}/{total}")

    def stat(label: str, key: str, subset: list[dict]) -> None:
        if not subset:
            print(f"  {label:<40} n/a")
            return
        vals = [r[key] for r in subset]
        print(f"  {label:<40} mean={np.mean(vals):.2f}  max={max(vals)}  "
              f"any>0={sum(1 for v in vals if v>0)}/{len(vals)}")

    print(f"\n  --- train_unit_count ---")
    stat("  wins:", "train_unit_count", wins)
    stat("  losses:", "train_unit_count", losses)
    stat("  all:", "train_unit_count", rows)

    print(f"\n  --- max_noop_streak ---")
    stat("  wins:", "max_noop_streak", wins)
    stat("  losses:", "max_noop_streak", losses)
    stat("  all:", "max_noop_streak", rows)

    wins_with_multi = sum(1 for r in wins if r["train_unit_count"] >= 2)
    print(f"\n  Wins with >=2 train_unit: {wins_with_multi}/{n_wins} "
          f"({100*wins_with_multi/max(n_wins,1):.1f}% of wins)")

    all_zero = all(r["train_unit_count"] == 0 for r in rows)
    print(f"\n  DIAGNOSIS:", end=" ")
    if all_zero:
        print("train_unit NEVER taken — action is dead. "
              "Action-masking is mandatory; consider intrinsic motivation fallback.")
    elif wins_with_multi / max(n_wins, 1) >= 0.05:
        print(f"Multi-unit signal present ({wins_with_multi}/{n_wins} wins have >=2 trn). "
              "Action-masking can AMPLIFY existing gradient.")
    else:
        print(f"Multi-unit signal weak ({wins_with_multi}/{n_wins} wins have >=2 trn). "
              "Action-masking is MANDATORY (not just an amplifier). Expect larger forcing windows.")


if __name__ == "__main__":
    run(tyro.cli(Config))
