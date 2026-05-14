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
```

### Phase 4 — League training (PFSP)

```bash
# League mode: PFSP opponent sampling across all 4 scripted bots
python training/ppo/train.py --league --num_envs 8 --total_timesteps 10000000

# Customise PFSP temperature (higher = focus on hard opponents)
python training/ppo/train.py --league --league_pfsp_temp 1.0 --num_envs 8

# Control when checkpoints enter the league pool
python training/ppo/train.py --league --league_add_interval 50 --num_envs 8

# Resume training with previous league state
python training/ppo/train.py --league --league_state checkpoints/.../league_state.json
```

League mode works by:
1. **PFSP sampling** — opponents are sampled with priority ∝ (1 − win_rate)^{temp}. Harder opponents (lower win rate) are picked more often, creating a natural curriculum.
2. **Win-rate matrix** — per-opponent win rates logged to TensorBoard (`league/win_rate_*` scalars + `league/win_rate_matrix` text).
3. **Checkpoint opponents** — every `--league_add_interval` updates, the current policy is added to the league pool (inactive until ONNX export in Phase 6).
4. **League state** — saved automatically to `<checkpoint_dir>/<run_name>/league_state.json`. Contains opponent registry, win counts, and PFSP parameters.

The non-league `--opponent` mode still works as before (Phase 3).

### All options

```
python training/ppo/train.py --help
```

## Monitoring with TensorBoard

```bash
# In a second terminal
tensorboard --logdir /root/CrystalFront/runs --bind_all
# Then open http://localhost:6006
```

Key charts to watch:
- `charts/win_rate` — fraction of episodes won (goal: reach >90% vs current opponent)
- `charts/episode_reward` — total reward per episode
- `charts/episode_length` — ticks per episode (shorter = more decisive games)
- `losses/entropy` — should stay positive; if it collapses to 0, the policy has stopped exploring
- `league/win_rate_idle` etc. — per-opponent win rates (league mode only)
- `league/win_rate_matrix` — full win-rate matrix text (league mode only)

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
| 4  | league (PFSP) | >90% vs all 4 bots | ~10M |

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
See `/root/CrystalFront/docs/ML_AGENT.md` for the full ML specification.
