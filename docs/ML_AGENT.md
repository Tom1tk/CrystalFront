# Crystal Front — ML Agent

A reinforcement learning bot for Crystal Front RTS. Trains via PPO + curriculum learning + behaviour cloning, ships as an in-game opponent, and acts as a permanent balance analysis instrument.

**Branch:** `CrystalFront-ML`  
**Algorithm:** PPO (Proximal Policy Optimisation) + Behaviour Cloning warmup  
**Current phase:** Phase 6 — Production integration ✅ (v0.3.2-ML shipped 2026-05-22)  
**Current version:** `0.3.2-ML`  
**Shipped model:** `models/policy-v0.3.2-ML.onnx` (checkpoint u150, ~1.3 MB)

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
9. [TensorBoard reference](#9-tensorboard-reference)
10. [File structure](#10-file-structure)
11. [Risks and mitigations](#11-risks-and-mitigations)
12. [Resources](#12-resources)

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

Per-tick signals (crystal damage, mining rate, army advantage, worker behaviour, forward pressure, time penalty) guide early learning. Terminal rewards (+10/−10 for win/loss/draw) dominate the signal once the agent starts reaching end states. Reward weights are treated as tunable parameters — expect several iterations before the agent stops finding degenerate strategies. See [§7](#7-reward-specification) for the current full specification and version history.

### D8 — Hardware

**Decision: AMD RX 7900 XTX GPU via ROCm, with 20 parallel CPU simulators.**

The GPU (ROCm/HIP) handles the neural network forward passes and PPO updates. 20 parallel Node.js simulation subprocesses feed it observations via ThreadPoolExecutor stepping. Expected throughput: ~1100–1200 steps per second. The 28-core Xeon handles the simulation load; the GPU handles the ML load. ROCm requires `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1` for flash attention — set automatically at train startup.

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
| `TurtleBot` — turrets + resource accumulation win | ✅ |
| `MacroBot` — economy expansion + gunner/bruiser/medic army | ✅ |
| `HeavyBot` — slow bruiser/medic/gunner army, steamrolls late | ✅ |
| CLI: `tsx headless/src/cli.ts --blue rush --red idle` | ✅ |
| Replay save format (seed + commandLog) | ✅ |
| Replay browser UI (Bot Replays menu) | ✅ |
| Replay viewer (real-time playback in client) | ✅ |
| `BotPlayer` in live game (START_SOLO_TEST) | ✅ |
| Passive win condition (hold ≥2500 resources = win) | ✅ |

**Definition of done:** ✅ CLI runs a match in <5 seconds. All 5 scripted bots play full matches without crashing. Replays save to disk and play back in the browser. "vs Bot" works in the live UI.

---

### Phase 2 — Observation, action, and reward specifications ✅ Complete

**Goal:** Lock down the exact interface between game and agent. Everything downstream depends on this contract.

| Task | Status |
|------|--------|
| Observation spec (12 global + 11 entity + 5 node features) | ✅ This document §5 |
| Action space spec (73 actions, stable integer index) | ✅ This document §6 |
| Reward spec (per-tick signals + terminal outcomes) | ✅ This document §7 |
| `headless/src/actionIndex.ts` — action ↔ integer mapping | ✅ |
| `legalMask()` — boolean[73] for PPO action masking | ✅ |
| Unit tests: every action category → valid commands | ✅ 388 tests passing |
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
| GPU support via ROCm (AMD RX 7900 XTX) | ✅ |
| Parallel env stepping with `ThreadPoolExecutor` | ✅ |
| Startup stagger (0.5s × env index) to prevent RAM spike | ✅ |
| `--checkpoint` flag for curriculum / resume | ✅ |
| End-to-end smoke test | ✅ |

**Definition of done:** ✅ `python training/ppo/train.py --opponent idle` runs without error. GPU detected and used. ~1100–1200 SPS with 20 envs.

---

### Phase 4 — League training + checkpoints ✅ Complete

**Goal:** Real training campaign with league-based opponent sampling using Prioritised Fictitious Self-Play (PFSP).

| Task | Status |
|------|--------|
| `training/ppo/league.py` — LeagueManager with PFSP sampling | ✅ |
| PFSP opponent sampling: priority ∝ (1 − win_rate)^{temp} | ✅ |
| Per-opponent win-rate matrix logged to TensorBoard | ✅ |
| Checkpoint opponents registered in league pool | ✅ |
| League state save/load (resumable training) | ✅ |
| Per-reset opponent override in env (`options["opponent"]`) | ✅ |
| `--league` flag in `train.py` with PFSP config options | ✅ |

**How it works (PFSP):**

Prioritised Fictitious Self-Play samples opponents with probability
proportional to `(1 − win_rate)^temperature`.  Opponents the agent
struggles against are picked more often, creating an automatic
curriculum.  A minimum-priority floor (0.01) ensures every active
opponent gets some play.

The league pool starts with all five scripted bots (`idle`, `rush`,
`turtle`, `macro`, `heavy`).  Historical policy checkpoints are added to
the pool as *inactive* entries — they activate in Phase 6 (ONNX export)
so the agent can play against past versions of itself.

**Usage:**

```bash
# League mode: PFSP sampling across all scripted bots
python3 training/ppo/train.py --league --num_envs 20 --total_timesteps 10000000

# Customise PFSP temperature (higher = more focus on hard opponents)
python3 training/ppo/train.py --league --league_pfsp_temp 1.0 --num_envs 20

# Control checkpoint registration interval
python3 training/ppo/train.py --league --league_add_interval 50 --num_envs 20

# Resume training from previous league state
python3 training/ppo/train.py --league --league_state checkpoints/.../league_state.json
```

**Key config options:**

| Option | Default | Purpose |
|--------|---------|---------|
| `--league` | `False` | Enable league mode |
| `--league_pfsp_temp` | `0.5` | PFSP temperature (higher = focus on hard opponents) |
| `--league_add_interval` | `100` | Add current policy as opponent every N updates (0 = off) |
| `--league_state` | auto-generated | Path to league state JSON for resume |

**TensorBoard charts (league mode):**

| Chart | Content |
|-------|---------|
| `league/win_vs_idle` | Win rate vs IdleBot |
| `league/win_vs_rush` | Win rate vs RushBot |
| `league/win_vs_turtle` | Win rate vs TurtleBot |
| `league/win_vs_macro` | Win rate vs MacroBot |
| `league/win_vs_heavy` | Win rate vs HeavyBot |
| `league/win_rate_matrix` | Full matrix text (update number + all win rates) |

**Definition of done:** ✅ PFSP sampling produces correct distribution.  Win-rate matrix logged per update.  League state round-trips through JSON correctly.

---

### Phase 5 — Replay tools + balance analysis ✅ Complete

**Goal:** Turn replays into a permanent balance analysis instrument with enriched metadata, filtering, auto-flagging, and batch match reporting.

| Task | Status |
|------|--------|
| Replay index with enriched metadata (unit counts, buildings, build orders) | ✅ `server/src/match/replayRunner.ts` |
| Replay browser filtering/sorting (winner, win type, bot search, flags, pagination) | ✅ `client/src/components/ReplayBrowser.tsx` |
| Balance report generator (batch match runner + win-rate matrix + build orders) | ✅ `training/balance_report.py` |
| Auto-flagging: fast, lopsided, resource_win, scrappy | ✅ flags array in `ReplayMeta` |
| Comparison reports: "before vs after this balance change" | ✅ `--compare` mode |
| Versioned balance history (`shared/src/balanceHistory.ts`) | ✅ |
| Replay playback controls: pause, 1×/4×/8× forward, 1×/4×/8× reverse | ✅ |
| Client-side frame buffering for smooth seek/rewind | ✅ |

**── Enriched replay metadata**

`analyzeReplay()` in `replayRunner.ts` performs a single pass over each
replay's `commandLog` and extracts:

| Field | Source | Example |
|-------|--------|---------|
| `winType` | `outcome.winType` | `"combat"`, `"resource"`, `"timeout"` |
| `blueUnits` / `redUnits` | `train_unit` + `train_worker` commands | `{ skirmisher: 6, worker: 4 }` |
| `blueBuildings` / `redBuildings` | `build` commands | `{ barracks: 1, supply_depot: 2 }` |
| `buildOrderBlue` / `buildOrderRed` | First 6 `build` commands, in order | `["supply_depot", "barracks"]` |
| `firstCombatTick` | First tick any combat unit was trained | `454` |
| `flags` | Auto-calculated | `["lopsided", "scrappy"]` |

**── Auto-flagging rules**

| Flag | Condition | Badge |
|------|-----------|-------|
| `fast` | Game ended ≤ 600 ticks | ⚡ Fast |
| `lopsided` | Unit count disparity ≥ 6 | ⚔ Lopsided |
| `resource_win` | Win by resource accumulation | 💰 Econ Win |
| `scrappy` | Total combat units trained across both sides ≥ 20 | 💥 Scrappy |

**── Versioned balance history**

Every replay stores its game version string. When a replay is watched,
`replayRunner.ts` calls `getBalanceForVersion()` from `balanceHistory.ts`
to look up the unit stats that were active when the game was recorded —
worker cost, speeds, damage, passive win threshold. This ensures old
replays play back accurately after balance changes. `BALANCE_HISTORY` in
`shared/src/balanceHistory.ts` is the authoritative registry; add a new
entry whenever a balance-affecting value changes.

**── Replay playback controls**

The replay viewer has a full playback bar centred below the scoreboard:

| Control | Behaviour |
|---------|-----------|
| `◀◀◀ 8×` / `◀◀ 4×` / `◀ 1×` | Reverse through buffered frames at that speed; server pauses |
| `⏸` | Pause — freeze on current frame |
| `▶ 1×` / `▶▶ 4×` / `▶▶▶ 8×` | Forward play; server speeds up to match |
| `✕ STOP` | Return to replay browser |
| `● LIVE` indicator | Lit amber when at the live edge of the buffer |

All incoming `game_state` frames are buffered client-side. Reverse always
works on already-received frames. Forward speeds send a `replay_speed`
message to the server so frames arrive faster.

**Definition of done:** ✅ Enriched metadata served at `/api/replays`.  Replay browser has working filters, sort, pagination, flag filter.  Balance report generator runs end-to-end.  Versioned balance history registry implemented.  Playback controls working with all speeds.  388 tests passing.

---

### Phase 5+ — Bot overhaul + reward calibration ✅ Complete

**Goal:** Make scripted opponents realistic, varied, and strategically distinct — improving training data quality and the live-game experience simultaneously.

| Task | Status |
|------|--------|
| Engine: combat units spawn with `autoAttackEnabled = true` | ✅ |
| Engine: build positions jitter to avoid same-coordinate overlaps | ✅ |
| Balance: contested nodes 300 cap, safe nodes 100 cap | ✅ |
| Balance: worker cost 50 (was 25), worker speed 1.7 (was 2.0) | ✅ |
| Balance: skirmisher speed 3.0 (was 2.5), damage 12 (was 15) | ✅ |
| Balance: passive win threshold 3000 resources, regen 0.2/tick | ✅ |
| `TurtleBot` redesign: resource-accumulation strategy, 7 workers, turrets only | ✅ |
| `MacroBot` redesign: gunners + bruisers + medics, per-group retreat at 30% health | ✅ |
| `RushBot`: randomised barracks y-zone per game | ✅ |
| `HeavyBot`: foundry-first, 8+ unit push threshold, retreat at 35% | ✅ |
| All bots: depot only when near supply cap | ✅ |
| `training/ppo/league.py`: `heavy` bot added to league pool | ✅ |

**Scripted bot overview:**

| Bot | Strategy | Win condition | Pushes at | Retreats |
|-----|----------|--------------|-----------|---------|
| Idle | Safe node gathering only | Combat (rarely) | Never | No |
| Rush | Fast barracks → skirmisher flood | Combat | 3+ skirmishers | No |
| Turtle | 7 workers, 3 turrets, accumulate resources | **Resource** (3000 held) | Never | No |
| Macro | Economy + gunners/bruisers/medics | Combat | 4+ units | Yes (30% avg health) |
| Heavy | Slow foundry build → 8+ bruisers/medics/gunners | Combat | 8+ units | Yes (35% avg heavy health) |

**Definition of done:** ✅ All 5 bots produce decisive outcomes against idle. Auto-attack fires by default. 388 tests passing.

---

### Phase 5++ — Reward overhaul + training optimisation ✅ Complete

**Goal:** Fix observed agent misbehaviours through reward signal redesign. Start fresh agent training from a clean slate.

| Task | Status |
|------|--------|
| Reward: forward pressure signal (+0.0005 per combat unit past midfield) | ✅ |
| Reward: worker kill/death split (combat vs worker, different rates) | ✅ |
| Reward: gathering reward (+0.0003 per actively-gathering worker/tick) | ✅ |
| Reward: idle worker penalty (−0.0005 per idle worker/tick) | ✅ |
| Reward: depot headroom penalty (−0.005 × headroom surplus) | ✅ |
| Reward: draw/timeout penalty = −10.0 (same as loss) | ✅ |
| TensorBoard: renamed all metrics to human-readable group/name format | ✅ |
| GPU: ROCm flash attention enabled at startup | ✅ |
| Training: `ThreadPoolExecutor` parallel env stepping (~2× SPS vs sequential) | ✅ |
| Training: 0.5s startup stagger per env to prevent RAM spike | ✅ |
| Training: `--checkpoint` flag for curriculum learning / resume | ✅ |
| Agent v2: fresh training run from scratch with all reward changes | ✅ |

**Why these changes were made:**

- **Not attacking:** The agent was farming resources and drawing. The enemy crystal is hidden behind fog-of-war until units push forward, so the crystal damage reward was never being triggered — the agent had no incentive to advance. Forward pressure reward gives a small continuous signal for having units past the halfway point, bootstrapping the fog-reveal chain.

- **Too many supply depots:** The idle worker penalty caused the agent to assign workers to building tasks to avoid the penalty — building excessive depots kept workers in `isBuilding` state (exempt from the penalty). Fixed with a headroom-based depot penalty: if you have completed depots but your supply isn't near the cap, you're penalised per excess headroom. Building depots only when you actually need them is now rewarded by penalty-absence.

- **Worker bodyguard incentive:** Separated enemy kills into combat kills (+0.5/supply) vs worker kills (+0.2 each). Combat kills being 2.5× more rewarding means the agent learns to intercept units attacking workers rather than ignoring the threat.

- **Draw exploitation:** The previous reward gave ~0 for draws (only per-tick signal accumulated). With a 6000-tick timeout game, turtling and drawing was nearly free. Draw is now penalised identically to a loss (−10.0) — there is no "safe" outcome for the agent that isn't win or try.

**Definition of done:** ✅ Agent v2 training run started (`crystalfront_ppo__idle__1__1778855546`). All reward changes in `stdioRunner.ts`. 388 tests passing.

---

### Phase 6 — Production bot integration ✅ Complete (v0.3.2-ML)

**Goal:** Trained policy ships in the live game as a player option.

| Task | Status |
|------|--------|
| ONNX export pipeline (`training/export_onnx.py`) | ✅ |
| ONNX runtime in Node (`onnxruntime-node`) | ✅ `headless/src/bots/mlBot.ts` |
| Model file (`models/policy-v0.3.2-ML.onnx` + `.onnx.data`) | ✅ ~1.3 MB |
| Server pre-loads ONNX session at startup | ✅ `mlBotSession` singleton in `server/src/index.ts` |
| `createBotAgent()` factory routing bot name → Agent instance | ✅ |
| `BotSelectMenu.tsx` — separate "Play vs Bot" screen | ✅ SCRIPTED / ML sections |
| xNorm mirroring when bot plays as RED | ✅ `mx = isRed ? (x => 1-x) : (x => x)` |
| All matches (PvP + vs-bot) saved as replays | ✅ with both player usernames |
| Replay playback shows actual gameplay | ✅ bluePlayerId/redPlayerId UUID fix |
| 443 tests passing | ✅ |

**Shipped capability (u150 checkpoint, 100 deterministic games per opponent):**

| Opponent | Win rate |
|----------|----------|
| idle | 100% |
| passive | 100% |
| rush_weak | 86% |
| rush_weak_medium | 99% |
| macro | 99% |
| rush_medium | 0% |
| rush | 1% |
| turtle | 0% |

**Key design note — async inference:** `BotPlayer.tick()` is synchronous. `MlBot.step()` returns the cached `lastAction` immediately and fires `session.run().then(result => { this.lastAction = ... })` in the background. The 1-tick action lag is imperceptible at the game's tick rate.

**Key design note — xNorm mirroring:** The policy was trained exclusively as BLUE (left side, xNorm near 0 = own crystal). When the bot plays RED, the observation must be mirrored by flipping `1 - xNorm` on all entity and node positions before feeding the policy. `isRed` is detected in `init()` by reading `match.players[idx].color`.

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

> **Version 0.3.2-ML** — reflects the shipped policy. Source of truth: `headless/src/observation.ts` and `headless/src/bots/mlBot.ts`.

The observation fed to the agent each tick has three parts. Fog-of-war is applied before building the observation: the agent only sees entities its own units have vision on.

### 5.1 Global features — `vec[22]`

| Index | Name | Range | Notes |
|-------|------|--------|-------|
| 0 | `ownResources` | [0, ∞) norm /1000 | Current bank / 1000 |
| 1 | `ownSupply` | [0, 1] | supply / maxSupply |
| 2 | `ownMaxSupply` | int | Absolute max supply |
| 3 | `oppVisibleSupply` | [0, 1] | Enemy supply fraction; 0 if no enemies visible |
| 4 | `tick` | [0, 1] | tick / 6000 |
| 5 | `scoreDiff` | (−∞, ∞) | own score − opponent score |
| 6 | `ownCrystalHealthFrac` | [0, 1] | Own crystal hp / maxHp |
| 7 | `oppCrystalHealthFrac` | [0, 1] | Enemy crystal hp / maxHp; 0 if not visible |
| 8 | `ownResourcesWinFrac` | [0, 1] | Held resources / passiveWinThreshold |
| 9 | `oppResourcesWinFrac` | [0, 1] | Enemy held resources / threshold; 0 if not visible |
| 10 | `ownLifetimeResourcesFrac` | [0, 1] | Total mined / (threshold × 2) — mining rate signal |
| 11 | `oppLifetimeResourcesFrac` | [0, 1] | 0 if unknown |
| 12 | `enemyWorkerCount` | [0, ∞) | Visible enemy workers |
| 13 | `enemySkirmisherCount` | [0, ∞) | Visible enemy skirmishers |
| 14 | `enemyBruiserCount` | [0, ∞) | Visible enemy bruisers |
| 15 | `enemyBarracksCount` | [0, ∞) | Visible enemy barracks |
| 16 | `enemyTurretCount` | [0, ∞) | Visible enemy turrets |
| 17 | `enemyForwardUnitFrac` | [0, 1] | Fraction of visible enemy units in own half |
| 18 | `nearestEnemyToCrystalDistNorm` | [0, 1] | Normalised distance of nearest enemy to own crystal |
| 19 | `ownCombatInOwnHalf` | [0, ∞) | Own combat units in own half (defensive signal) |
| 20 | `enemyCombatInOwnHalf` | [0, ∞) | Visible enemy combat units in own half |
| 21 | `totalVisibleEnemyCombat` | [0, ∞) | Total visible enemy combat units |

### 5.2 Entity features — `vec[12]` per entity (up to 64)

| Index | Name | Range | Notes |
|-------|------|--------|-------|
| 0 | `typeIndex` | [0, 9] | Index into ENTITY_TYPES (see below) |
| 1 | `owner` | {1, −1} | 1 = mine, −1 = enemy |
| 2 | `xNorm` | [0, 1] | x / mapWidth — **mirrored (1−x) when bot plays RED** |
| 3 | `yNorm` | [0, 1] | y / mapHeight |
| 4 | `healthFrac` | [0, 1] | health / maxHealth |
| 5 | `constructionFrac` | [0, 1] | construction progress (buildings); 1 otherwise |
| 6 | `isAttacking` | {0, 1} | Has active attack target |
| 7 | `isMoving` | {0, 1} | Has move target |
| 8 | `isGathering` | {0, 1} | Assigned to resource node |
| 9 | `isBuilding` | {0, 1} | Worker with active build target |
| 10 | `attackCooldownNorm` | [0, 1] | attackCooldown / 25 |
| 11 | `inAttackRange` | {0, 1} | Enemy entity within attack range of own unit |

**ENTITY_TYPES index mapping:**
```
0: crystal           5: medic
1: worker            6: building_barracks
2: skirmisher        7: building_foundry
3: gunner            8: building_supply_depot
4: bruiser           9: building_turret
```

In the policy network, `typeIndex` is passed through a learned embedding before concatenation.

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

> **Version 0.3.2-ML** — 81 actions total. See `headless/src/actionIndex.ts` for the canonical integer mapping.

Actions are **hierarchical macro-actions**. The PPO policy outputs a single integer `a ∈ [0, 80]`. `indexToAction()` converts it to a structured `MacroAction`; `expandMacroAction()` converts that to raw engine commands. Illegal actions are masked to −∞ before sampling — the agent can never select an action it cannot execute.

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
| 71–75 | `attack_move` | all_idle_combat × 5 zones | 5 |
| 76–80 | `attack_move` | idle_workers × 5 zones | 5 |
| **Total** | | | **81** |

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

> **Current version: 0.1.47-ML.** See version history below.

Rewards are computed in `headless/src/stdioRunner.ts` by comparing consecutive observations. The Node simulation computes the scalar reward and passes it to Python alongside each observation.

### 7.1 Per-tick rewards

| Signal | Formula | Purpose |
|--------|---------|---------|
| Crystal damage dealt | `+0.001 × damage` (only when enemy crystal was visible last tick) | Primary win signal; fog-gated to require scouting first |
| Crystal damage taken | `−0.001 × damage` | Penalise getting hit |
| Mining | `+0.0001 × miningDelta × (passiveWinThreshold × 2)` | Reward gathering via lifetime resources delta (spending doesn't reduce it) |
| Army supply advantage | `+0.0005 × (ownSupply − oppVisibleSupply)` | Encourage fielding a larger visible force |
| Combat unit kill | `+0.5 × supply points removed` | Enemy skirmisher/gunner/bruiser/medic killed |
| Enemy worker kill | `+0.2 per worker` | Less than combat kill — creates bodyguard incentive |
| Own worker lost | `−0.8 per worker` | Workers are economically critical; losing them is punished more than killing them is rewarded |
| Gathering workers | `+0.0003 per gathering worker` | Reward assigning workers to nodes rather than leaving them idle |
| Idle workers | `−0.0005 per idle worker` | Workers doing nothing cost a small per-tick drain |
| Depot headroom | `−0.005 × (headroom − 1)` when completed depots exist and headroom > 1 | Prevents building depots far ahead of supply cap |
| Forward pressure | `+0.0005 per combat unit with xNorm > 0.5` | Bootstraps fog-reveal chain; agent must push past midfield to see the enemy crystal |
| Time penalty | `−0.00005 per tick` | Mild stall discouragement |

Per-tick magnitudes are intentionally small (order 10⁻⁴ to 10⁻³) — terminal rewards dominate the signal.

### 7.2 Terminal rewards

| Outcome | Reward | Notes |
|---------|--------|-------|
| Win (any condition) | `+10.0` | Combat win or resource win — both equally valued |
| Loss (any condition) | `−10.0` | |
| Draw (6000 ticks, no winner) | `−10.0` | Same as loss — the agent must engage or die trying |

**Draw = loss** is a deliberate design choice. A draw is the agent refusing to interact with the game. Turtling until timeout must be the worst possible strategy, not a safe fallback.

### 7.3 Win conditions

- **Combat win:** destroy the enemy crystal
- **Resource win:** hold ≥ 3,000 resources simultaneously (`ECONOMY.passiveWinThreshold`)

### 7.4 Reward version history

| Version | Key changes |
|---------|-------------|
| 0.1.43-ML | Initial reward: crystal damage, mining, army advantage, unit kill, time penalty |
| 0.1.44-ML | Balance patch (worker cost/speed, skirmisher stats) — reward unchanged |
| 0.1.45-ML | Added: forward pressure, worker kill/death split, gathering reward, idle penalty, depot headroom penalty |
| 0.1.46-ML | Draw penalty introduced (−10.0 = same as loss) |
| 0.1.47-ML | Agent v2 fresh start — all 0.1.46 rewards carried forward |

### 7.5 Tuning guidance

| Observed behaviour | Likely cause | Adjustment |
|-------------------|--------------|-----------|
| Gathers forever, never attacks | Mining reward too high or forward pressure too low | Increase forward pressure weight or reduce mining weight |
| Builds endless supply depots | Depot headroom penalty too weak | Increase penalty multiplier |
| Leaves workers idle | Idle penalty too weak or gathering reward too low | Increase idle penalty / gathering reward |
| Never attacks even with army built | Forward pressure too weak | Increase +0.0005 weight |
| Suicides units into crystal | Terminal reward dominates too early in training | Lower terminal or increase per-tick shaping |
| Games always hit 6000 ticks (draws) | Draw penalty not felt yet, or agent is still early in training | Wait; if persistent, increase draw penalty magnitude |
| Loses workers recklessly | Own worker death penalty too low | Increase from −0.8 |
| Policy diverges | Rewards too large | Scale all per-tick signals down ×0.1 |

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
tensorboard --logdir /root/CrystalFront/runs --bind_all
```

### Current training command (agent v2)

```bash
python3 training/ppo/train.py \
  --opponent idle \
  --num_envs 20 \
  --total_timesteps 3000000 \
  --ent_coef 0.05
```

Expected throughput: ~1100–1200 SPS. At 3M steps this takes roughly 45–60 minutes wall-clock.

### Recommended training progression

| Stage | Command | Target | Expected steps |
|-------|---------|--------|----------------|
| Sanity check | `--opponent idle --num_envs 4` | 100% win rate | ~100k |
| vs Rush | `--opponent rush --num_envs 20 --checkpoint <idle_final.pt>` | >90% win rate | ~1M |
| vs Turtle | `--opponent turtle --num_envs 20 --checkpoint <rush_final.pt>` | >80% win rate | ~2M |
| vs Macro | `--opponent macro --num_envs 20 --checkpoint <turtle_final.pt>` | >70% win rate | ~5M |
| vs Heavy | `--opponent heavy --num_envs 20 --checkpoint <macro_final.pt>` | >70% win rate | ~3M |
| League | `--league --num_envs 20 --checkpoint <heavy_final.pt>` | >90% vs all bots | ~10M |

Move to the next stage once win rate stays above the target for at least 200k consecutive steps. Use `--checkpoint` to carry knowledge forward — don't start each stage from scratch.

### Resume from checkpoint

```bash
# Continue training from a specific update checkpoint
python3 training/ppo/train.py \
  --opponent rush \
  --num_envs 20 \
  --checkpoint checkpoints/<run_name>/update_000150.pt
```

### League training

```bash
# Start a league training campaign
python3 training/ppo/train.py --league --num_envs 20 --total_timesteps 10000000

# Resume from a previous league state
python3 training/ppo/train.py \
  --league \
  --league_state checkpoints/.../league_state.json \
  --num_envs 20
```

### Generating balance reports

```bash
# Run 100 matches per bot-pair and print JSON report
python3 training/balance_report.py --matches 100

# Compare before/after a balance change
python3 training/balance_report.py --matches 500 --out baseline.json
# … edit shared/src/gameBalance.ts, rebuild, deploy …
python3 training/balance_report.py --matches 500 --out after.json
python3 training/balance_report.py --compare "baseline.json after.json"
```

### Key hyperparameters

| Flag | Default | Notes |
|------|---------|-------|
| `--num_envs` | 20 | Parallel simulators. 20 is the sweet spot for this hardware. |
| `--num_steps` | 512 | Rollout length per env. Decrease for faster feedback, increase for more stable gradients. |
| `--gamma` | 0.995 | Discount factor. High values suit long episodes (up to 6000 ticks). |
| `--ent_coef` | 0.01 | Entropy bonus. Use 0.05 to prevent early policy collapse. |
| `--save_interval` | 50 | Checkpoint every N policy updates. |
| `--save_replay_every` | 10 | Save a training replay every N episodes. |

### Stop-the-line conditions

Pause and diagnose if any of these occur:

- **Training vs IdleBot never reaches 100% win rate** — the pipeline has a bug, not a tuning problem. Don't proceed.
- **Win rate vs scripted bots stalls <60% after 20M steps** — action space, reward, or observation needs rework. Don't throw more compute at it.
- **Entropy collapses to 0 within the first 100k steps** — policy collapsed; increase `--ent_coef` or reduce `--learning_rate`.
- **Episode length stays at 6000 throughout** — agent is still drawing; the draw penalty should resolve this within 500k steps if reward is correct.
- **Bot found a strategy that exploits a simulation bug** — fix the bug; retrain from scratch. Don't keep the exploiting checkpoint.

---

## 9. TensorBoard reference

Launch TensorBoard:
```bash
tensorboard --logdir /root/CrystalFront/runs --bind_all
```

TensorBoard run names follow the format: `crystalfront_ppo__{opponent}__{seed}__{timestamp}`

To compare runs: open the TensorBoard UI, select which runs to include in the left-hand panel. Deselect all old runs and keep only the current one unless you want explicit before/after comparison.

---

### `game/` — what the agent is actually doing in-game

These are the metrics that tell you whether the agent is learning to *play the game well*. Check these first.

**`game/win_rate`**  
Fraction of the last 100 completed games the agent won (rolling window). This is the number you care most about. Should climb over time. If it plateaus around 50% the agent has found a local optimum. If it collapses after a peak, entropy has probably dropped too low and the policy has overfit to a brittle strategy. Target: >90% vs idle before moving to the next stage.

**`game/episode_reward`**  
Total reward accumulated over one complete game — all the small per-tick signals summed, plus the terminal ±10. A game where the agent wins quickly scores higher than a late win, because the time penalty (−0.00005/tick) chips away. Useful for tracking quality of wins, not just whether they happened. A clean win in 1000 ticks will score noticeably higher than a grinding win at 5800 ticks.

**`game/episode_length_ticks`**  
How many ticks the game lasted, out of a maximum of 6000. This is a leading indicator — it moves before win_rate does. High values (near 6000) mean draws or very late wins; the agent is stalling. Should trend downward as the agent learns to close out games decisively. If this stays at 6000 for thousands of updates, the agent is still drawing — check that the draw penalty is wired up correctly.

---

### `training/` — training process health

These confirm the training loop is running correctly. They don't tell you about game quality, just whether the machinery is healthy.

**`training/learning_rate`**  
How large each weight update step is. We use a linear decay schedule — starts at ~2.5×10⁻⁴ and shrinks toward zero by the end of the total timestep budget. A flat line here means the schedule isn't running (check `--total_timesteps`). Not something you'd normally diagnose problems with — just confirms the schedule.

**`training/steps_per_second`**  
How many environment steps are processed per second across all envs. With 20 envs on this hardware, expect ~1100–1200. If it drops significantly below that, something is bottlenecking — typically the Node subprocesses (simulation latency) rather than the GPU. A sudden drop mid-run can indicate a hanging subprocess.

---

### `ppo/` — algorithm internals

These describe the PPO algorithm's own health. They don't directly tell you if the agent is playing well, but they tell you if the learning process itself is stable or broken.

**`ppo/policy_gradient_loss`**  
How much the policy (the action probability distribution) changed this update. Should fluctuate around a small negative number. If it trends strongly negative or blows up in magnitude, updates are too aggressive — lower `--learning_rate`. If it's exactly zero every update, something is wrong with the gradient flow.

**`ppo/value_function_loss`**  
How wrong the agent's *predictions of future reward* were. The agent has two outputs: what action to take (policy) and how good the current position is (value). This loss measures the value prediction error. Should decrease over time as the agent gets better at evaluating positions. If it stays high throughout training, the agent cannot model the game well enough to estimate outcomes — this is a signal that the reward is too sparse or noisy.

**`ppo/entropy_bonus`**  
How random and exploratory the policy currently is. High entropy means the agent is trying many different actions. Low entropy means it's very confident (possibly overconfident — locked onto a single strategy). We pay `--ent_coef 0.05` to keep this elevated and prevent premature collapse. If entropy drops to near zero in the first 500k steps, the agent has committed to a strategy before it has seen enough of the game — the previous v1 agent did exactly this, locking onto idle-farming and never recovering. Watch this closely early in training. As long as it stays above ~0.5, exploration is healthy.

**`ppo/clip_fraction`**  
How often PPO's clipping mechanism intervened during updates. PPO limits how far the policy can shift per update; when the proposed update is larger than the clip threshold, the clip fires. Healthy range is roughly 0.05–0.20. Consistently above 0.3 means updates are too large and the policy is thrashing — lower `--learning_rate`. Consistently near zero means the learning rate is too conservative and updates are tiny. A rising clip fraction combined with falling win rate usually means the policy is destabilising.

**`ppo/approx_kl_divergence`**  
A statistical measure of how different the new policy is from the old one after an update — roughly, "how much did this update change what the agent would do in any given situation?". Values consistently above ~0.02 would indicate unstable updates. Tracks closely with clip fraction; they usually move together. Useful mainly as a double-check on clip fraction.

---

### `league/` — per-opponent win rates (league mode only)

Only populated when running with `--league`. One chart per opponent in the pool.

**`league/win_vs_idle`**, **`league/win_vs_rush`**, etc.  
Win rate against that specific opponent over recent games. Tells you which bots the agent has mastered and which it's still struggling against. In PFSP mode, opponents with lower win rates get sampled more often — so you'd expect these to roughly equalise over time as the agent improves everywhere. If one bot's win rate is stuck near zero for millions of steps, that matchup has a fundamental problem (reward doesn't provide enough signal, or the scripted bot exploits a bug).

---

## 10. File structure

```
CrystalFront/
│
├── headless/src/                       # TypeScript headless match runner
│   ├── types.ts                        # Agent interface, MacroAction, PlayerObservation
│   ├── runMatch.ts                     # Single-match entry point (no WebSockets)
│   ├── observation.ts                  # Fog-filtered observation builder
│   ├── actionSpace.ts                  # MacroAction → raw engine commands
│   ├── actionIndex.ts                  # Integer ↔ MacroAction mapping (81 actions)
│   ├── legalActions.ts                 # Legal-action enumerator + mask
│   ├── reward.ts                       # Reward computation (single source of truth)
│   ├── stdioRunner.ts                  # Node subprocess: reward computation + protocol
│   ├── stdioVecRunner.ts               # Vectorised runner (N games per process)
│   ├── cli.ts                          # Manual match runner + replay saver
│   └── bots/
│       ├── mlBot.ts                    # ✅ SHIPPED — ONNX policy via onnxruntime-node
│       ├── idleBot.ts                  # Gathers resources, nothing else
│       ├── passiveBot.ts               # Economy only, never attacks
│       ├── rushBot.ts                  # Early barracks, mass-skirmisher push
│       ├── weakRushBot.ts              # Slower rush, fewer units
│       ├── weakMediumRushBot.ts        # Intermediate between weak and medium rush
│       ├── mediumRushBot.ts            # Timed push with 3+ skirmishers
│       ├── turtleBot.ts                # 7 workers + 3 turrets + resource accumulation win
│       ├── macroBot.ts                 # Economy + foundry tech + mixed army
│       └── heavyBot.ts                 # Slow foundry build → heavy bruiser/medic push
│
├── server/src/
│   ├── index.ts                        # Server entry; createBotAgent() factory; mlBotSession
│   └── match/
│       ├── matchEngine.ts              # Authoritative engine (pure, no setInterval)
│       ├── liveMatchRunner.ts          # setInterval driver for production server
│       ├── replayRunner.ts             # Replay save/load + versioned balance + metadata
│       ├── botPlayer.ts                # In-process bot driver for live game
│       └── engine/
│           ├── rng.ts                  # Seedable mulberry32 PRNG
│           └── idGen.ts                # Monotonic entity ID counter
│
├── client/src/
│   └── components/
│       ├── BotSelectMenu.tsx           # ✅ SHIPPED — "Play vs Bot" screen (SCRIPTED + ML)
│       ├── ReplayBrowser.tsx           # Replay browser with pagination + filters
│       └── ...
│
├── shared/src/
│   ├── gameBalance.ts                  # Live balance values (worker cost, speeds, etc.)
│   └── balanceHistory.ts              # Versioned balance snapshots for replay accuracy
│
├── models/                             # Exported ONNX policies (gitignored — large files)
│   ├── policy-v0.3.2-ML.onnx          # ✅ SHIPPED — 81-action policy (u150 checkpoint)
│   └── policy-v0.3.2-ML.onnx.data    # External data tensor file (required alongside .onnx)
│
├── training/                           # Python PPO training pipeline
│   ├── env/
│   │   ├── crystalfront_env.py         # Gymnasium wrapper (single game per process)
│   │   └── crystalfront_vec_env.py     # Vectorised wrapper (N games per process)
│   ├── ppo/
│   │   ├── policy.py                   # SetTransformer + CrystalFrontAgent
│   │   ├── train.py                    # PPO training loop (curriculum + GPU)
│   │   └── league.py                   # LeagueManager + PFSP sampling
│   ├── eval/
│   │   └── eval_checkpoint.py          # Load .pt, run N games vs each bot, print win table
│   ├── export_onnx.py                  # ✅ PyTorch → ONNX export (_OnnxWrapper + dynamo)
│   ├── bc_pretrain.py                  # Behaviour cloning warmup from bot demonstrations
│   ├── test_env.py                     # End-to-end smoke test
│   └── requirements.txt
│
├── replays/                            # Saved match replays (gitignored)
├── runs/                               # TensorBoard logs (gitignored)
├── checkpoints/                        # Policy checkpoints (gitignored)
│
└── docs/
    ├── ML_AGENT.md                     # This document
    ├── ML_BOT_ACTION_PLAN.md           # Training diary + phase status
    ├── SHIPPING_AND_V040_PLAN.md       # v0.3.2 ship plan (complete) + v0.4.0 roadmap
    └── eval_v0.3.2-ML.txt              # Captured win-rate evaluation output
```

---

## 11. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| **Reward hacking** — bot finds degenerate strategies (mine forever, build endless depots, draw by turtling) | Watch replays of outlier games. The draw penalty eliminates the "safe draw" fallback. Add shaped penalties for any new exploit observed. |
| **Entropy collapse** — policy locks onto one strategy too early, stops exploring | Use `--ent_coef 0.05`. Watch `ppo/entropy_bonus` — if it drops below 0.3 in first 500k steps, something is wrong. Start fresh rather than trying to rescue a collapsed policy (agent v1 lesson). |
| **Training instability** — PPO diverges, win rates collapse after peaking | Use CleanRL reference hyperparameters. Don't tune until baseline is reproducible. Save checkpoints often. `ppo/clip_fraction` above 0.3 is the early warning. |
| **Game design churn** — balance changes invalidate trained policy | Treat training as cheap and re-runnable. The versioned balance history ensures old replays still play correctly even after patches. Don't over-invest in any single checkpoint before balance is stable. |
| **Action space too large** | Current space is 73 actions — small enough for PPO. Resist expanding until baseline works. Keep the spec versioned. |
| **Determinism drift** | Caught by CI test: same seed × 500 ticks → identical state hash. Any `Math.random()` regression fails immediately. |
| **RAM spike on startup** | 20 tsx processes compiling TypeScript simultaneously caused host reboots. Fixed with 0.5s startup stagger per env (`startup_delay = i * 0.5`). Do not remove this. |

---

## 12. Resources

Materials specifically relevant to this project's architecture:

- **CleanRL PPO** — [github.com/vwxyzjn/cleanrl](https://github.com/vwxyzjn/cleanrl)  
  Read the single-file `ppo.py` implementation before modifying `training/ppo/train.py`. The training loop here is a direct adaptation.

- **Set Transformer** — [arxiv.org/abs/1810.00825](https://arxiv.org/abs/1810.00825)  
  The encoder used in `training/ppo/policy.py`. Explains the permutation-invariant pooling mechanism.

- **OpenAI Five blog posts** — overview of how a real multi-agent game AI was built. Useful for vocabulary and scale intuition, though the problem setting is much larger.

- **AlphaStar (Nature paper)** — the architecture Crystal Front's design roughly models: set-transformer over entities, auto-regressive action head, league training. Worth reading once the baseline is working.

- **Hugging Face Deep RL course** — free, well-paced, covers PPO with practical examples. Good companion while working through the training code.

- **PettingZoo docs** — multi-agent Gymnasium variant; relevant if self-play is eventually formalised into a two-agent environment.
