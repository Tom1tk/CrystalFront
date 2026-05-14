# Crystal Front — ML Agent

A reinforcement learning bot for Crystal Front RTS. Trains via self-play and league competition, ships as an in-game opponent, and acts as a permanent balance analysis instrument.

**Branch:** `CrystalFront-ML`  
**Algorithm:** PPO (Proximal Policy Optimisation)  
**Current phase:** Phase 3 — Python training pipeline ✅

---

## Table of contents

1. [Goals](#1-goals)
2. [Architecture overview](#2-architecture-overview)
3. [Design decisions](#3-design-decisions)
4. [Implementation phases](#4-implementation-phases)
5. [Observation specification](#5-observation-specification)
6. [Action space](#6-action-space)
7. [Reward specification](#7-reward-specification)
8. [Training guide](#8-training-guide)
9. [File structure](#9-file-structure)
10. [Risks and mitigations](#10-risks-and-mitigations)
11. [Resources](#11-resources)

---

## 1. Goals

Three parallel objectives, all pursued through the same work:

**1. Balance instrument.**  
A policy trained to play well becomes a microscope on the game's design. Run it after every balance change to discover dominant strategies, dead map regions, broken unit counters, and economic exploits before human players do.

**2. Player opponent.**  
A shippable AI opponent with multiple difficulty tiers (easy / medium / hard), so players can experience the game without a human opponent. Difficulty maps to training checkpoint age: older checkpoints for easy, newest for hard.

**3. Learning project.**  
Hands-on education in reinforcement learning — PPO, reward shaping, self-play, training pipelines, replay analysis — built from scratch and understood end-to-end. The goal is genuine understanding, not just running someone else's black box.

---

## 2. Architecture overview

```
                    ┌─────────────────────────────┐
                    │     Python (training)       │
                    │  ┌──────────────────────┐   │
                    │  │  PPO trainer         │   │
                    │  │  (CleanRL-style)     │   │
                    │  │        ↑             │   │
                    │  │  rewards/obs         │   │
                    │  │        ↓             │   │
                    │  │  Env wrapper         │   │
                    │  │  (N parallel sims)   │   │
                    │  └──────────┬───────────┘   │
                    └─────────────┼───────────────┘
                                  │ stdio JSON-line protocol
                                  │ (one Node subprocess per sim)
                    ┌─────────────┼──────────────────┐
                    │             ↓                  │
                    │  headless/src/stdioRunner.ts   │
                    │  ┌──────────────────────────┐  │
                    │  │  MatchEngine (pure)      │  │  ← same engine as live game
                    │  │  - deterministic         │  │
                    │  │  - seedable RNG          │  │
                    │  │  - step(commands) → state│  │
                    │  └──────────────────────────┘  │
                    │  + observation builder         │
                    │  + legal-action enumerator     │
                    │  + reward computation          │
                    │  + scripted opponents          │
                    └────────────────────────────────┘

                    ┌────────────────────────────────┐
                    │  Live game (production)        │
                    │  ┌──────────────────────────┐  │
                    │  │  MatchEngine (same code) │  │
                    │  │  + LiveMatchRunner       │  │
                    │  │    (setInterval driver)  │  │
                    │  │  + BotPlayer             │  │
                    │  │    (in-process agent)    │  │
                    │  │    - loads ONNX policy   │  │
                    │  │    - picks difficulty    │  │
                    │  └──────────────────────────┘  │
                    └────────────────────────────────┘

                    ┌────────────────────────────────┐
                    │  Replay viewer                 │
                    │  ┌──────────────────────────┐  │
                    │  │  seed + command log      │  │
                    │  │       ↓                  │  │
                    │  │  MatchEngine in playback │  │
                    │  │       ↓                  │  │
                    │  │  Existing client render  │  │
                    │  └──────────────────────────┘  │
                    └────────────────────────────────┘
```

**Key principle:** The `MatchEngine` is the single source of truth, shared between the live game, the headless training harness, and the replay viewer. They differ only in what drives the tick loop and who decides actions each tick.

---

## 3. Design decisions

These ten decisions are the foundation of the project. Any major deviation requires explicit reconsideration.

### D1 — Bot brain location

**Decision: Both — Python for training, Node.js in-process for live play.**

Python has the ML ecosystem (PyTorch, CleanRL, TensorBoard); Node has the game engine already. Training runs in Python subprocesses; the shipped bot loads a compiled ONNX policy and runs in-process alongside the game server, adding no network latency.

### D2 — Action granularity

**Decision: Hierarchical macro-actions (~73 total, with sub-options per action).**

Raw pixel/command actions require enormous compute for an RTS — the space is too large for PPO to explore efficiently. Macro-actions collapse "attack all units toward the left side of midfield" into a single index. Sub-options (which group, which zone, which building type, etc.) give the agent strategic breadth while keeping the total action space tractable. See [§6](#6-action-space) for the full enumeration.

### D3 — Training opponents

**Decision: League — scripted bots first, then self-play with checkpoints.**

Scripted bots provide stable baselines and predictable difficulty ramps. Self-play alone suffers from cycles (the agent forgets how to beat strategies it used to beat). The league mixes current policy, historical checkpoints, and scripted bots, with sampling weighted toward close-skill matchups.

### D4 — Fog of war during training

**Decision: Fog of war only — same constraints as a real player.**

Training with full map vision would produce a bot that behaves differently from the shipped product. Fog is a core part of the game's strategy; the agent must learn to scout, infer opponent actions, and play under uncertainty. This reduces sample efficiency but produces genuine strategic behaviour.

### D5 — One bot or two

**Decision: One bot, plays both sides.**

The map is symmetric. The observation is mirrored left-to-right when the agent plays as red, so it always "thinks" it is blue. This doubles the training signal per match at zero cost. Difficulty tiers are implemented as older (easier) vs newer (harder) checkpoints of the same single model.

### D6 — Observation format

**Decision: Entity-list (set-based), no vision model.**

The game state is described as a variable-length list of entities, each encoded as a feature vector. No image rendering or CNN. This is:
- Efficient — no wasted compute on blank map space
- Natural — entity count varies as units are built and die
- Fog-compatible — fog is applied by filtering the list before it reaches the agent
- Permutation-invariant — a set-transformer encoder handles variable ordering

### D7 — Reward signal

**Decision: Shaped rewards, starting simple and expanding iteratively.**

Per-tick signals (crystal damage, mining rate, army advantage, time penalty) guide early learning. Terminal rewards (+10/-10 for combat win/loss, +5/-5 for resource win/loss) dominate the signal once the bot starts reaching end states. Reward weights are treated as tunable parameters — expect several iterations before the bot stops finding degenerate strategies.

### D8 — Hardware

**Decision: CPU-first on the 28-core Xeon; GPU (ROCm) deferred.**

The 28-core Intel Xeon E5-2680 v4 is well-suited for running many parallel Node simulations. With 20 concurrent environments, expect ~800–1000 macro-actions per second. The AMD RX 7900 XTX requires ROCm setup that adds complexity; defer GPU use until the CPU pipeline is proven and becomes the bottleneck.

### D9 — Algorithm

**Decision: PPO (Proximal Policy Optimisation), CleanRL implementation.**

PPO is the industry standard for game AI at this scale (OpenAI Five, AlphaStar foundation). It's stable, well-documented, and has excellent learning resources. CleanRL's single-file reference implementation is specifically recommended — it's readable, correct, and good for understanding the algorithm from first principles.

### D10 — Success criteria

**Four milestones in order:**
1. Bot beats all scripted bots >90% of the time
2. Bot provides a genuine challenge to a human player at hard difficulty
3. Bot discovers at least one strategy or exploit the developer did not anticipate
4. Bot becomes a permanent development instrument — re-run after every balance change

---

## 4. Implementation phases

### Phase 0 — Engine refactors ✅ Complete

**Goal:** Make the engine deterministic, time-independent, and modular. No behaviour change to the live game.

| Task | Status |
|------|--------|
| Seedable `Rng` class (mulberry32) | ✅ `server/src/match/engine/rng.ts` |
| Monotonic `IdGen` class | ✅ `server/src/match/engine/idGen.ts` |
| Replace all `Math.random()` / `randomUUID()` | ✅ |
| Extract tick loop → `LiveMatchRunner` | ✅ `server/src/match/liveMatchRunner.ts` |
| `MatchEngine` is now pure: no `setInterval` | ✅ |
| `match.commandLog` — append-only per-command log | ✅ |
| Fix resource node symmetry (`CONTESTED_NODE_OFFSETS`) | ✅ |
| Remove legacy aliases in `gameBalance.ts` | ✅ |
| Determinism test (same seed → identical state hash) | ✅ |

**Definition of done:** ✅ All tests pass, live game unaffected, two runs with the same seed produce identical states.

---

### Phase 1 — Headless runner + scripted bots ✅ Complete

**Goal:** Run full matches outside of WebSockets. Deliver scripted bot opponents and a replay system.

| Task | Status |
|------|--------|
| `headless/` workspace | ✅ |
| `runMatch(agentBlue, agentRed, options)` | ✅ `headless/src/runMatch.ts` |
| `Agent` interface (init / step) | ✅ `headless/src/types.ts` |
| Observation builder (fog-filtered) | ✅ `headless/src/observation.ts` |
| Action space / macro-action expander | ✅ `headless/src/actionSpace.ts` |
| Legal-action enumerator | ✅ `headless/src/legalActions.ts` |
| `IdleBot` — gathers only | ✅ |
| `RushBot` — early barracks, mass skirmisher | ✅ |
| `TurtleBot` — supply depots + turrets + gunners | ✅ |
| `MacroBot` — economy expansion + mixed army | ✅ |
| CLI: `tsx headless/src/cli.ts --blue rush --red idle` | ✅ |
| Replay save format (seed + commandLog) | ✅ |
| Replay browser UI (Bot Replays menu) | ✅ |
| Replay viewer (real-time playback in client) | ✅ |
| `BotPlayer` in live game (START_SOLO_TEST) | ✅ |
| Passive win condition (hold ≥5000 resources = win) | ✅ |

**Definition of done:** ✅ CLI runs a match in <5 seconds. All 4 scripted bots play full matches without crashing. Replays save to disk and play back in the browser. "vs Bot" works in the live UI.

---

### Phase 2 — Observation, action, and reward specifications ✅ Complete

**Goal:** Lock down the exact interface between game and agent. Everything downstream depends on this contract.

| Task | Status |
|------|--------|
| Observation spec (12 global + 11 entity + 5 node features) | ✅ This document §5 |
| Action space spec (73 actions, stable integer index) | ✅ This document §6 |
| Reward spec (5 per-tick signals + 5 terminal outcomes) | ✅ This document §7 |
| `headless/src/actionIndex.ts` — action ↔ integer mapping | ✅ |
| `legalMask()` — boolean[73] for PPO action masking | ✅ |
| Unit tests: every action category → valid commands | ✅ 385 tests passing |
| Crystal health + lifetime resources in observation | ✅ |

**Definition of done:** ✅ Three specs are complete and reflected in code. All 73 actions are tested. Legal mask correctly zeros illegal actions.

---

### Phase 3 — Python training pipeline ✅ Complete

**Goal:** A working PPO training loop with parallel Node simulators.

| Task | Status |
|------|--------|
| `headless/src/stdioRunner.ts` — Node subprocess | ✅ |
| JSON-line protocol (RESET / STEP / CLOSE) | ✅ |
| Reward computation in Node (state deltas → scalar) | ✅ |
| `training/env/crystalfront_env.py` — Gymnasium wrapper | ✅ |
| `training/ppo/policy.py` — SetTransformer + PPO agent | ✅ |
| `training/ppo/train.py` — CleanRL-style training loop | ✅ |
| Legal-action masking in policy network | ✅ |
| TensorBoard logging | ✅ |
| Checkpoint saving | ✅ |
| End-to-end smoke test | ✅ |

**Definition of done:** ✅ `python training/ppo/train.py --opponent idle` runs without error. Policy forward pass and PPO update verified. See [§8](#8-training-guide) to start training.

---

### Phase 4 — League training + checkpoints 🔲 Not started

**Goal:** Real training campaign with league-based opponent sampling.

**Tasks:**
- `training/ppo/league.py` — manages pool of opponents (scripted + historical checkpoints)
- Checkpoint sampling with Prioritised Fictitious Self-Play (PFSP) weighting
- Win-rate matrix logged every E episodes
- First serious training campaign (target: 10M environment steps)

**Definition of done:** Win rate vs each scripted bot >90%. Win-rate matrix evolves sensibly. At least one human playtest against the latest checkpoint that feels genuinely challenging.

---

### Phase 5 — Replay tools + balance analysis 🔲 Not started

**Goal:** Turn the trained bot into a balance instrument.

**Tasks:**
- Replay index (metadata: seed, outcome, win type, unit counts, build orders)
- Replay browser filtering/sorting (length, winner, win type, dominant unit)
- Balance report generator: run 10,000 matches, output win rates by side/comp/strategy
- Auto-flagging: fastest games, lopsided games, unusual win conditions
- Comparison reports: "before vs after this balance change"

---

### Phase 6 — Production bot integration 🔲 Not started

**Goal:** Trained policy ships in the live game as a player option.

**Tasks:**
- ONNX export from PyTorch (`training/eval/export_onnx.py`)
- ONNX runtime in Node (`onnxruntime-node`) — `BotPlayer` loads `.onnx` file
- Three difficulty tiers: early / mid / late training checkpoints
- "Play vs Bot" lobby UI with difficulty selector
- In-process driver: bot commands enter via `processCommand`, no WebSocket needed

---

### Phase 7 — Permanent instrument (ongoing)

This is the steady-state the previous phases build toward. After every meaningful change to `gameBalance.ts` or the action space:

1. Re-run a training campaign (can be short — fine-tune from previous checkpoint)
2. Generate a fresh balance report
3. Compare against previous reports — did a dominant strategy emerge? Did anything break?
4. Watch a sample of replays from outlier games
5. If something is off, adjust balance or design, repeat

---

## 5. Observation specification

> **Version 1.0** — locked for initial training run. Changes require a version bump.

The observation fed to the agent each tick has three parts. Fog-of-war is applied before building the observation: the agent only sees entities its own units have vision on.

### 5.1 Global features — `vec[12]`

| Index | Name | Range | Notes |
|-------|------|--------|-------|
| 0 | `ownResources` | [0, ∞) norm /1000 | Current bank / 1000 |
| 1 | `ownSupply` | [0, 1] | supply / maxSupply |
| 2 | `ownMaxSupply` | int | Absolute max supply |
| 3 | `oppVisibleSupply` | [0, 1] | Enemy supply fraction; 0 if no enemies visible |
| 4 | `tick` | [0, 1] | tick / 6000 |
| 5 | `scoreDiff` | (−∞, ∞) | own score − opponent score |
| 6 | `ownCrystalHealthFrac` | [0, 1] | Own crystal hp / 1000 |
| 7 | `oppCrystalHealthFrac` | [0, 1] | Enemy crystal hp / 1000; 0 if not visible |
| 8 | `ownResourcesWinFrac` | [0, 1] | Held resources / passiveWinThreshold |
| 9 | `oppResourcesWinFrac` | [0, 1] | Enemy held resources / threshold; 0 if not visible |
| 10 | `ownLifetimeResourcesFrac` | [0, 1] | Total mined / (threshold × 2) — mining rate signal |
| 11 | `oppLifetimeResourcesFrac` | [0, 1] | 0 if unknown |

### 5.2 Entity features — `vec[11]` per entity (up to 64)

| Index | Name | Range | Notes |
|-------|------|--------|-------|
| 0 | `typeIndex` | [0, 9] | Index into ENTITY_TYPES (see below) |
| 1 | `owner` | {1, −1} | 1 = mine, −1 = enemy |
| 2 | `xNorm` | [0, 1] | x / mapWidth |
| 3 | `yNorm` | [0, 1] | y / mapHeight |
| 4 | `healthFrac` | [0, 1] | health / maxHealth |
| 5 | `constructionFrac` | [0, 1] | construction progress (buildings); 1 otherwise |
| 6 | `isAttacking` | {0, 1} | Has active attack target |
| 7 | `isMoving` | {0, 1} | Has move target |
| 8 | `isGathering` | {0, 1} | Assigned to resource node |
| 9 | `isBuilding` | {0, 1} | Worker with active build target |
| 10 | `attackCooldownNorm` | [0, 1] | attackCooldown / 25 |

**ENTITY_TYPES index mapping:**
```
0: crystal           5: medic
1: worker            6: building_barracks
2: skirmisher        7: building_foundry
3: gunner            8: building_supply_depot
4: bruiser           9: building_turret
```

In the policy network, `typeIndex` is passed through a learned 16-dimensional embedding before being concatenated with the other features (total entity input dim: 26).

### 5.3 Node features — `vec[5]` per node (up to 8)

| Index | Name | Range |
|-------|------|--------|
| 0 | `xNorm` | [0, 1] |
| 1 | `yNorm` | [0, 1] |
| 2 | `remainingFrac` | [0, 1] |
| 3 | `gathererCount` | [0, 3] |
| 4 | `isContested` | {0, 1} |

---

## 6. Action space

> **Version 1.0** — 73 actions total. Integer indices are stable and must not be reordered without a version bump.

Actions are **hierarchical macro-actions**. The PPO policy outputs a single integer `a ∈ [0, 72]`. `indexToAction()` converts it to a structured `MacroAction`; `expandMacroAction()` converts that to raw engine commands. Illegal actions are masked to −∞ before sampling — the agent can never select an action it cannot execute.

### Full action table

| Range | Type | Sub-options | Count |
|-------|------|-------------|-------|
| 0 | `noop` | — | 1 |
| 1 | `train_worker` | — | 1 |
| 2–5 | `train_unit` | skirmisher / gunner / bruiser / medic | 4 |
| 6–41 | `build` | 4 building types × 3 x-zones × 3 y-zones | 36 |
| 42–53 | `attack_move` | 4 groups × 3 target zones | 12 |
| 54–57 | `retreat` | 4 groups | 4 |
| 58–69 | `assign_workers` | 3 node choices × 4 counts | 12 |
| 70–72 | `set_rally` | 3 target zones | 3 |
| **Total** | | | **73** |

### Sub-field values

**`group`:** `all_combat` · `skirmishers` · `gunners` · `bruisers`

**`targetZone`:** `enemy_crystal` · `midfield` · `contested_node`

**`xZone`** (within player's build half): `near_crystal` · `mid_base` · `forward`

**`yZone`:** `top` · `middle` · `bottom`

**`nodeChoice`:** `nearest_safe` · `nearest_contested` · `richest_visible`

**`workerCount`:** `1` · `2` · `3` · `all_idle`

### Legality rules

| Action | Legal when |
|--------|-----------|
| `noop` | Always |
| `train_worker` | `resources ≥ 25` AND `supply + 1 ≤ maxSupply` |
| `train_unit(T)` | `resources ≥ cost[T]` AND supply headroom AND building that produces T exists |
| `build(B, ...)` | `resources ≥ cost[B]` AND at least one idle worker |
| `attack_move(group, ...)` | At least one unit of that group type exists |
| `retreat(group)` | Same as attack_move |
| `assign_workers(...)` | At least one idle worker AND at least one available node |
| `set_rally(...)` | At least one completed building exists |

---

## 7. Reward specification

> **Version 1.0** — starting values. Expect retuning after observing early training behaviour.

Rewards are computed in `headless/src/stdioRunner.ts` by comparing consecutive observations. The Node simulation computes the scalar reward and passes it to Python alongside each observation.

### 7.1 Per-tick rewards

| Signal | Weight | Notes |
|--------|--------|-------|
| Damage dealt to enemy crystal | `+0.001 × damage` | Only when enemy crystal was visible last tick |
| Damage taken to own crystal | `−0.001 × damage` | Always applied |
| Resources mined this tick | `+0.0001 × amount` | Via lifetime resources delta |
| Army supply advantage | `+0.0005 × (ownArmy − oppVisibleArmy)` | Encourages building a larger visible force |
| Time penalty | `−0.00005` per tick | Discourages stalling |

Per-tick magnitudes are intentionally small (order 10⁻⁴ to 10⁻³) — terminal rewards dominate the signal.

### 7.2 Terminal rewards

| Outcome | Reward |
|---------|--------|
| Win — crystal destruction | `+10.0` |
| Loss — crystal destruction | `−10.0` |
| Win — resource accumulation | `+5.0` |
| Loss — resource accumulation | `−5.0` |
| Draw (6000 ticks elapsed) | `0.0` |

Combat win is weighted higher than resource win to encourage military play alongside economic development, rather than pure turtling.

### 7.3 Win conditions

There are two ways to win:
- **Combat win:** destroy the enemy crystal
- **Resource win:** hold ≥ 5,000 resources at the same time (defined in `ECONOMY.passiveWinThreshold`)

The resource win threshold is intentionally tunable. It creates a second strategic pathway — aggressive players push for the crystal; economic players turtle and stockpile.

### 7.4 Tuning guidance

| Observed behaviour | Likely cause | Adjustment |
|-------------------|--------------|-----------|
| Gathers forever, never attacks | Mining reward too high vs terminal | Reduce `+0.0001` weight |
| Suicides units into crystal | Terminal reward dominates too early | Reduce terminal magnitude |
| Retreats endlessly | Time penalty too weak | Increase to `−0.0001` |
| Policy diverges | Rewards too large | Scale all down by ×0.1 |
| Games always hit 6000 ticks | Stalemate; terminal too small or time penalty too small | Increase terminal |

---

## 8. Training guide

### Prerequisites

```bash
# Install Python dependencies (from repo root)
pip install -r training/requirements.txt
```

The Node dependencies are already installed via the main `npm install`.

### Quick start

```bash
# Verify the pipeline works first (should take ~5 seconds)
python3 training/test_env.py

# Start training vs the idle bot (easiest — confirms pipeline is working)
python3 training/ppo/train.py --opponent idle --num_envs 4 --total_timesteps 500000

# Monitor in TensorBoard (run in a second terminal)
tensorboard --logdir runs/
```

### Recommended training progression

| Stage | Command | Target | Expected steps |
|-------|---------|--------|----------------|
| Sanity check | `--opponent idle --num_envs 4` | 100% win rate | ~100k |
| Phase 3b | `--opponent rush --num_envs 8` | >90% win rate | ~500k |
| Phase 3c | `--opponent turtle --num_envs 8` | >80% win rate | ~1M |
| Phase 3d | `--opponent macro --num_envs 8` | >70% win rate | ~3–5M |
| Phase 4 | Self-play league | ELO improvement | Ongoing |

Move to the next stage once win rate stays above the target for at least 200k consecutive steps.

### Scaling to more CPU cores

The 28-core Xeon can comfortably run 16–20 parallel simulators:

```bash
python3 training/ppo/train.py --opponent macro --num_envs 20 --total_timesteps 10000000
```

Each `num_envs` instance spawns one Node.js subprocess. The Node processes run truly in parallel (separate OS processes); Python steps them sequentially within each rollout.

### All options

```bash
python3 training/ppo/train.py --help
```

Key hyperparameters:
- `--num_steps 512` — rollout length per env (decrease for faster feedback, increase for more stable gradients)
- `--gamma 0.995` — discount; high values suit long episodes (up to 6000 ticks)
- `--ent_coef 0.01` — entropy bonus; increase if the policy stops exploring early
- `--save_interval 50` — checkpoint every N policy updates

### Stop-the-line conditions

Pause and diagnose if any of these occur:

- **Training vs IdleBot never reaches 100% win rate** — the pipeline has a bug, not a tuning problem. Don't proceed.
- **Win rate vs scripted bots stalls <60% after 20M steps** — action space, reward, or observation needs rework. Don't throw more compute at it.
- **Entropy collapses to 0 within the first 100k steps** — policy collapsed; increase `--ent_coef` or reduce `--learning_rate`.
- **Bot found a strategy that exploits a simulation bug** — fix the bug; retrain from scratch. Don't keep the exploiting checkpoint.

---

## 9. File structure

```
CrystalFront/
│
├── headless/src/                       # TypeScript headless match runner
│   ├── types.ts                        # Agent interface, MacroAction, PlayerObservation
│   ├── runMatch.ts                     # Single-match entry point (no WebSockets)
│   ├── observation.ts                  # Fog-filtered observation builder
│   ├── actionSpace.ts                  # MacroAction → raw engine commands
│   ├── actionIndex.ts                  # Integer ↔ MacroAction mapping (PPO interface)
│   ├── legalActions.ts                 # Legal-action enumerator + mask
│   ├── stdioRunner.ts                  # Node subprocess for Python ↔ Node protocol
│   ├── cli.ts                          # Manual match runner + replay saver
│   └── bots/
│       ├── idleBot.ts                  # Gathers resources, nothing else
│       ├── rushBot.ts                  # Early barracks, mass-skirmisher push
│       ├── turtleBot.ts                # Supply depots + turrets + gunner army
│       └── macroBot.ts                 # Economy + foundry tech + mixed army
│
├── server/src/match/                   # Game simulation
│   ├── matchEngine.ts                  # Authoritative engine (pure, no setInterval)
│   ├── liveMatchRunner.ts              # setInterval driver for production server
│   ├── replayRunner.ts                 # Replay playback at real-time speed
│   ├── botPlayer.ts                    # In-process bot driver for live game
│   └── engine/
│       ├── rng.ts                      # Seedable mulberry32 PRNG
│       └── idGen.ts                    # Monotonic entity ID counter
│
├── training/                           # Python PPO training pipeline
│   ├── env/
│   │   └── crystalfront_env.py         # Gymnasium wrapper
│   ├── ppo/
│   │   ├── policy.py                   # SetTransformer + CrystalFrontAgent
│   │   └── train.py                    # PPO training loop
│   ├── test_env.py                     # End-to-end smoke test
│   └── requirements.txt
│
├── replays/                            # Saved match replays (gitignored)
├── runs/                               # TensorBoard logs (gitignored)
├── checkpoints/                        # Policy checkpoints (gitignored)
│
└── docs/
    └── ML_AGENT.md                     # This document
```

---

## 10. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| **Reward hacking** — bot finds degenerate strategies (mine forever, suicide units, etc.) | Start with sparse rewards. Watch replays of outlier games. Add shaped pieces only after observing baseline behaviour. |
| **Training instability** — PPO diverges, win rates collapse | Use CleanRL reference hyperparameters. Don't tune until baseline is reproducible. Save checkpoints often to roll back. |
| **Game design churn** — balance changes invalidate trained policy | Treat training as cheap and re-runnable. Don't over-invest in any single checkpoint before balance is stable. |
| **GPU/ROCm complexity** | Defer. CPU-only training on the 28-core Xeon is sufficient for the game's strategic depth. Revisit only if training step becomes the bottleneck. |
| **Action space too large** | Current space is 73 actions — small enough. Resist expanding until baseline works. Keep the spec versioned. |
| **Determinism drift** | Caught by existing CI test: same seed × 500 ticks → identical state hash. Any `Math.random()` regression fails immediately. |
| **Episode length** | Max 6000 ticks = ~10 min real-time = ~2–5 seconds of headless compute. Time penalty in reward discourages reaching the limit. |

---

## 11. Resources

Materials specifically relevant to this project's architecture:

- **CleanRL PPO** — [github.com/vwxyzjn/cleanrl](https://github.com/vwxyzjn/cleanrl)  
  Read the single-file `ppo.py` implementation before modifying `training/ppo/train.py`. The training loop here is a direct adaptation.

- **Set Transformer** — [arxiv.org/abs/1810.00825](https://arxiv.org/abs/1810.00825)  
  The encoder used in `training/ppo/policy.py`. Explains the permutation-invariant pooling mechanism.

- **OpenAI Five blog posts** — overview of how a real multi-agent game AI was built. Useful for vocabulary and scale intuition, though the problem setting is much larger.

- **AlphaStar (Nature paper)** — the architecture Crystal Front's design roughly models: set-transformer over entities, auto-regressive action head, league training. Worth reading once the baseline is working.

- **Hugging Face Deep RL course** — free, well-paced, covers PPO with practical examples. Good companion while working through the training code.

- **PettingZoo docs** — multi-agent Gymnasium variant; relevant if self-play is eventually formalised into a two-agent environment.
