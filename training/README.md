# Crystal Front — ML Training Pipeline

PPO-based reinforcement learning for Crystal Front RTS.

## Setup

```bash
# From repo root
cd training
pip install -r requirements.txt
```

## Running training

```bash
# From repo root (important — paths are relative to repo root)
python training/ppo/train.py
```

### Common options

```bash
# Start easy: beat the idle bot first (should hit 100% win rate quickly)
python training/ppo/train.py --opponent idle --num_envs 4 --total_timesteps 500000

# Then move up: vs the strongest scripted bot
python training/ppo/train.py --opponent macro --num_envs 8 --total_timesteps 5000000

# Use all cores on the 28-core Xeon
python training/ppo/train.py --opponent macro --num_envs 20 --total_timesteps 10000000

# Resume from a checkpoint (coming in Phase 4)
# python training/ppo/train.py --checkpoint checkpoints/.../update_000050.pt
```

### All options

```
python training/ppo/train.py --help
```

## Monitoring with TensorBoard

```bash
# In a second terminal
tensorboard --logdir runs/
# Then open http://localhost:6006
```

Key charts to watch:
- `charts/win_rate` — fraction of episodes won (goal: reach >90% vs current opponent)
- `charts/episode_reward` — total reward per episode
- `charts/episode_length` — ticks per episode (shorter = more decisive games)
- `losses/entropy` — should stay positive; if it collapses to 0, the policy has stopped exploring

## Watching replays

The trainer saves a replay every `--save_replay_every` episodes (default: 500).
Watch them via the game's Bot Replays menu, or run directly:

```bash
tsx headless/src/cli.ts --blue macro --red idle
# then open the website and click Bot Replays
```

## Progression guide

| Phase | Opponent | Target win rate | Expected steps |
|-------|----------|-----------------|----------------|
| 3a | idle | 100% | ~100k |
| 3b | rush | >90% | ~500k |
| 3c | turtle | >80% | ~1M |
| 3d | macro | >70% | ~3–5M |
| 4  | self (league) | ELO improvement | ongoing |

If win rate stalls below target after 2× the expected steps, check:
1. TensorBoard entropy — should be > 0.5 at start; if it collapses early, increase `--ent_coef`
2. Episode length — if episodes max out at 6000 ticks, the bot isn't finding win conditions
3. Reward breakdown — run a few replays to see what strategy the bot is attempting

## Architecture summary

```
Observation → [SetEncoder(entities)] + [SetEncoder(nodes)] + [global features]
           → 2-layer MLP (256 hidden)
           → Actor head (73 logits, masked) + Critic head (scalar value)
```

See `ppo/policy.py` for details.
See `/root/CRYSTALFRONT_OBS_SPEC.md`, `/root/CRYSTALFRONT_ACTION_SPEC.md`,
and `/root/CRYSTALFRONT_REWARD_SPEC.md` for the full specifications.
