# CrystalFront RL Training — User's Guide (Task 3.2 curriculum run)

A beginner-friendly guide to launching, monitoring, and finishing the 20M-decision
PPO curriculum run yourself. Everything here was verified against the code at
commit `0889b6a` (v0.5.11-ML). Project plan: `/root/CrystalFront/docs/REVIVAL_PLAN.md` §Task 3.2.

---

## 1. The 5-minute mental model

- **The agent** is a small neural network. Every 8 game ticks (`decision_interval 8`)
  it looks at the game state (an "observation") and picks one of ~80 macro actions
  (train unit, build, attack-move, etc.).
- **PPO** (the RL algorithm) improves it by trial and error: play many games in
  parallel, score each step with a **reward** (≈ +1 for a win, −1 for a loss, tiny
  shaping bonuses in between), then nudge the network toward actions that led to
  higher reward. One "update" = collect a batch of experience → adjust weights → repeat.
- **The curriculum** is a ladder of 20 stages (`0a → 0b → … → 4`), starting with
  tiny maps vs an idle opponent and ending with self-play ("league"). The agent is
  **promoted** to the next stage when its win rate over the last 100 episodes
  crosses that stage's threshold (0.50–0.85 depending on stage), and can be
  **regressed** if stuck.
- **The warm start**: instead of starting from random weights, we load
  `bc_warmup_v05.pt` — a network pre-trained to imitate the scripted RushBot.
  It already beats `idle` 10/10, so early stages should clear fast.
- **Budget**: 20M decisions total. The stages' worst-case budgets sum to ~22.75M,
  so if many stages run to their caps the run ends *inside* a late stage. That's
  the cap working as intended, not a crash. Expect roughly **a week** on this GPU.

Key vocabulary: **decision/step** = one agent action (8 game ticks). **episode** =
one full game. **update** = one PPO weight-update cycle (here 20 envs × 256 steps
= 5120 decisions per update; 20M total ≈ 3900 updates).

---

## 2. Pre-launch checklist (one-time)

All commands run from `/root/CrystalFront`. **Use `python3`, not `python`** (no
`python` alias on this machine).

```bash
cd /root/CrystalFront
git log --oneline -1        # expect 0889b6a fix(3.2-preflight): ...
ls -la bc_warmup_v05.pt     # the BC warm-start checkpoint must exist
npm test                    # 470 engine tests, all green
python3 -m training.test_env  # 5-second end-to-end pipeline smoke
```

If all four look good, you're clear to launch.

---

## 3. Launching the run

```bash
cd /root/CrystalFront
nohup python3 -m training.ppo.train \
  --curriculum --curriculum_stage 0 \
  --checkpoint bc_warmup_v05.pt \
  --decision_interval 8 \
  --num_envs 20 --vec_size 4 \
  --total_timesteps 20000000 \
  > train_task32.log 2>&1 &
```

- `nohup … &` keeps it running after you close the terminal; all console output
  goes to `train_task32.log`.
- Watch live output with: `tail -f train_task32.log`
- Check it's alive: `ps aux | grep training.ppo.train`
- Stop it (if you must): `pkill -f training.ppo.train` — progress up to the last
  saved checkpoint survives (see §7).

**First things to verify in the log (first ~10 minutes):**

1. The startup banner shows version `0_5_11-ML`, your run name, and the stage
   `0a` definition.
2. A line `Realised config (stage 0a): {...}` appears — the numbers must match
   the stage definition printed above it. (This is a deliberate safety check.)
3. Stage `0a` promotes almost immediately (it's a near-free win by design — the
   pre-placed units kill the 50 HP crystal on their own). The *real* first test
   is stages `0b`/`0b5`/`0c`, where the agent must act for itself.

Outputs land in two folders (named `crystalfront_ppo__0_5_11-ML__<opponent>__1__<timestamp>`):

- `runs/<run_name>/` — TensorBoard data
- `checkpoints/<run_name>/` — model snapshots (`update_000050.pt`, …, `final.pt`),
  saved every 50 updates

---

## 4. Monitoring with TensorBoard

```bash
cd /root/CrystalFront
tensorboard --logdir runs --bind_all
```

Then open `http://<this-machine's-IP>:6006` in your browser. Charts update as the
run writes data; use the smoothing slider (top-left, ~0.9) because raw RL curves
are very noisy — **trends matter, single points don't**.

### The charts that matter, in priority order

| Chart | What it means | What healthy looks like |
|---|---|---|
| `game/win_rate` | Win rate over the last 100 episodes (this drives promotions) | Climbs toward the stage's threshold, then **drops after each promotion** (new stage is harder — that sawtooth is normal and good) |
| `curriculum/stage` | Which stage you're on (0=0a … 20=4) | A staircase going up over days. Flat for a long time = stuck (see §6) |
| `game/episode_reward` | Total reward per episode | Roughly −1 (losses) trending toward +1 (wins); should stay within about ±1.3 |
| `ppo/entropy_bonus` | How "random/exploratory" the policy still is | Decays slowly from ~1–3. **Below 0.3 early in the run = collapse alarm** (§6) |
| `game/episode_length_ticks` | Game length | Wins get faster as the agent improves |
| `diagnostics/timeout_rate` | Fraction of games hitting the tick limit | Should fall as the agent learns to actually win |
| `ppo/approx_kl_divergence` | How big each policy update is | Small and stable (~0.01–0.05). Sustained spikes = unstable learning |
| `ppo/value_function_loss` | How well the critic predicts outcomes | Noisy but trending down within a stage |
| `training/steps_per_second` | Throughput | Roughly constant; a collapse means an infrastructure problem |
| `actions/pct_*` | What the agent actually does (build/train/attack/…) | A mix. One action ≈100% of everything = degenerate policy |

Useful secondary charts: `diagnostics/enemy_crystal_dmg_pct` (is it even attacking?),
`rewards/final_reward_mean`, `training/learning_rate` (linear decay to 0 by design).
In stage 4, `league/win_vs_*` charts appear (self-play win rates).

### One metric that is console-only: noop%

The fraction of "do nothing" actions is printed in the log, not TensorBoard:

```bash
grep -o "noop=[0-9]*%" train_task32.log | tail -20
```

Each 100-episode window also prints a one-line report in the log with win rate,
action mix, and episode stats — skimming those lines once or twice a day is the
single best low-effort habit.

---

## 5. What the log lines mean

- `*** CURRICULUM PROMOTE → stage 0b (...) ***` — threshold reached; environments
  rebuild with the new stage config. Followed shortly by a fresh
  `Realised config (stage 0b): {...}` line — **check it matches**.
- `*** CURRICULUM REGRESS → stage ... (stuck) ***` — win rate stayed too low for
  the whole stage budget; it dropped back a stage. Occasional regressions are OK;
  ping-ponging forever is not (§6).
- `[checkpoint] saved → checkpoints/.../update_000050.pt` — snapshot, every 50 updates.
- `⚠️  WARNING: opponent bot crashed Nx during episode ...` — **stop-the-line** (§6).

---

## 6. Stop-the-line conditions (halt and investigate; don't keep burning GPU)

These are the five conditions from the plan. If one fires: note the update number,
stage, and what you saw (for the diary, §8), stop the run if indicated, and
investigate (or ask me) **before** restarting.

1. **Not ~100% vs `idle` within the first ~100k decisions** (stages 0b–1a) →
   something is broken in the pipeline, not the agent. Stop.
2. **`ppo/entropy_bonus` < 0.3 within the first 500k decisions** → the policy
   collapsed to one behavior too early. Stop; the standard remedy is restarting
   with `--ent_coef 0.05` (more exploration pressure).
3. **noop% climbing monotonically past 60% on any stage** → the stage offers no
   learning gradient (doing nothing looks as good as acting). Check that stage's
   realised config and how its opponent behaves before blaming the agent.
4. **`Realised config` print ≠ stage definition** → environment-config regression.
   Stop immediately; nothing learned under a wrong config counts.
5. **Any `botCrashCount` warning** → the scripted opponent crashed mid-game, which
   invalidates that episode's difficulty. Stop; the bot needs fixing.

Quick daily scan for 4 and 5:

```bash
grep -E "Realised config|WARNING: opponent bot crashed" train_task32.log
```

**Not** stop-the-line: noisy win-rate dips, post-promotion win-rate drops, a single
stage regression, the run ending before stage 4's budget is exhausted (that's the
20M cap).

---

## 7. Decisions you'll actually face

- **"It's been stuck on one stage for a day."** Stuck-ness is measured against the
  stage's `max_steps` budget (0.5M–5M decisions depending on stage); the regression
  logic handles it automatically. Only worry if it ping-pongs between the same two
  stages repeatedly — that's a sign the difficulty step between them is too big.
  Note it and ask.
- **"The run died / I had to stop it. How do I resume?"** Resume from the latest
  snapshot, **and you must pass the stage index yourself** (checkpoints store
  weights and step count, but not the curriculum stage):

  ```bash
  ls -t checkpoints/<run_name>/          # find newest update_XXXXXX.pt
  grep "CURRICULUM PROMOTE" train_task32.log | tail -1   # what stage was it on?
  ```

  Stage indices, in order: `0a`=0, `0b`=1, `0b5`=2, `0c`=3, `day5`=4, `1a`=5,
  `1b`=6, `2a`=7, `2a5`=8, `2a6`=9, `2b`=10, `3a`=11, `3a_rw`=12, `3a_rwm`=13,
  `3a_rm`=14, `3a_rm_3k`=15, `3a1`=16, `3a2`=17, `3a5`=18, `3b`=19, `4`=20.

  Then relaunch the §3 command with `--checkpoint checkpoints/<run_name>/update_XXXXXX.pt`
  and `--curriculum_stage <index>` instead of the BC checkpoint and stage 0.
  (A new run-name folder is created; point TensorBoard at `runs/` and it shows both.)
- **"Which checkpoint is 'the' result?"** `final.pt` from the completed run is the
  Task 3.3 candidate. But any `update_XXXXXX.pt` can be evaluated (see §9) — if a
  mid-run snapshot evaluates better than the final one, that's a legitimate pick.

---

## 8. Keep the diary (project rule R10)

Training history gets lost fastest, so the project requires a running diary in
`/root/CrystalFront/docs/ML_BOT_ACTION_PLAN.md` §12 (continue from Iteration 20).
Minimum entries — a few honest lines each:

- **Every promotion/regression**: stage name, update number, global step, win rate
  (the log's promote line + the preceding window-report line have all of it).
- **Every stop-the-line event**: what fired and what you saw, written down
  *before* attempting a fix.
- **At run end**: a short "Reflections" comparing how stages actually went vs
  expectations.

You can jot raw notes anywhere and ask me to format/commit them properly.

---

## 9. After the run: evaluation (Task 3.3 preview)

When training finishes (`Training complete. Final checkpoint: ...` in the log),
the candidate is judged by win rates over 100 fresh games per opponent:

```bash
python3 -m training.eval.eval_checkpoint \
  --checkpoint checkpoints/<run_name>/final.pt \
  --episodes 100 --decision_interval 8
```

Ship gates for v0.5.0-ML: ≥95% vs `idle`/`passive`; ≥70% vs `rush_weak`/
`rush_weak_medium`/`macro`; ≥40% vs `rush_medium`; no regression vs the old
v0.3.2-ML table (`docs/eval_v0.3.2-ML.txt`). Don't worry about the ship mechanics
yet — run the eval, bring me the table, and we'll take it from there.

---

## 10. Cheat sheet

```bash
cd /root/CrystalFront
tail -f train_task32.log                          # live log
grep "CURRICULUM" train_task32.log                # stage history
grep -E "Realised config|bot crashed" train_task32.log   # stop-the-line scan
grep -o "noop=[0-9]*%" train_task32.log | tail    # noop trend
tensorboard --logdir runs --bind_all              # dashboard on :6006
ps aux | grep training.ppo.train                  # is it running?
pkill -f training.ppo.train                       # stop it
```
