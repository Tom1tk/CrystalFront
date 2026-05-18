# Crystal Front — ML Bot Action Plan

**Branch:** `CrystalFront-ML`
**Status:** Active training — Phase C curriculum (0.1.75-ML, full build chain vs passive_bot)
**Last updated:** 2026-05-18

---

## Development Diary

A running log of meaningful milestones, decisions, and pivots. Most recent first.

---

### 2026-05-18 — v0.1.75-ML: Phase C v8 — locking in the winning policy

**Status:** Running (PID 522611, `/tmp/train_v75.log`)

**Strategy:** Resume from the Phase C v7 `update_000010.pt` checkpoint (the peak policy: win_rate=86%, bld=17%, trn=1%) with `ent_coef=0.03`. The high-entropy v7 run discovered and then lost the winning strategy every ~12 updates due to value-function lag. Low entropy should lock the policy in place once it finds the chain.

**Also fixed in this version:**
- All 4 `package.json` files now bumped together (previous versions only bumped root — client/server/shared were stuck at 0.1.56-ML, live site showed wrong version)
- Training runs now started with `--save_replay_every 0` — no more broken 1000px map replays polluting the replay browser
- Site deployed and verified at 0.1.75-ML

---

### 2026-05-18 — v0.1.74-ML: Phase C v7 — first_combat_unit +50, barracks-idle ×5

**Problem:** v6 reached win_rate=0.82 at update 7 but collapsed to 0.01 by update 35. Root cause: policy gradient for `bld` actions (25% of episode, +2.5 immediate reward) overwhelmed gradient for `trn` (1% of episode, +10 delayed ~100 ticks). Expected value of "build + train" was only marginally better than "build only".

**Changes:**
- `hasTrainedCombatUnit` milestone: +10 → **+50** (discounted at gamma^100 ≈ +30.5, vs bld's +2.5)
- Barracks-idle trickle penalty: -0.003/tick → **-0.015/tick**
- Expected value: build+train = +33, build-without-train = +1.9 (a 17× gap)

**Results:** win_rate oscillated 20–86% over 63 updates in 12-update cycles. Pattern: agent discovers train→attack (trn=1%, ep_rew=106), V(s) updates high, future A(train) becomes negative, trn falls to 0%, V(s) corrects, cycle repeats. Never converged. Best checkpoint at update 10 (win_rate=86%) used as seed for v8.

---

### 2026-05-18 — v0.1.73-ML: Phase C v6 — CRITICAL BUG FIX: build zone

**Root cause of all Phase C failures identified:**

`chooseBuildPosition()` in `headless/src/actionSpace.ts` used `MAP.width` (hardcoded 6000) instead of `match.config.mapWidth` (1000 for training). This placed buildings at:
- `near_crystal` → x=180: overlaps spawn workers → "Overlaps existing entity"
- `mid_base` → x=600: outside 200px blue build zone → "Outside your build zone"
- `forward` → x=960: outside build zone AND near red crystal → "Outside your build zone"

**Every single barracks build attempt silently failed in ALL Phase C runs (v1–v5).** bld=60-75% looked like the agent was building — it was issuing 15,000+ build commands per update that all returned empty. trn=0% was a direct consequence: the barracks never existed.

Additional bugs fixed in the same function:
- Blocking check tested only buildings; added workers + crystal entity overlap
- No-build radius around own crystal wasn't checked; added `PLACEMENT.crystalNoBuildRadius` check  
- Zone end hardcoded to `mapW × 0.2`; set minimum to 280px so the valid strip (x=180-280 on 1000px map) is reachable
- Attempts increased 8 → 16

**Verified:** All 3 barracks zones now succeed on 1000px map, barracks completes at tick ~250, `train_skirmisher` legal with 425 resources.

**Results:** win_rate=0.82 at update 7 (trn=1%, atk_mv=22%). But still collapsed to 0.01 by update 35 — same bld-dominance problem as before, now just a reward problem not a build problem.

---

### 2026-05-18 — v0.1.72-ML: Phase C v5 — barracks-only builds (wrong diagnosis)

**Hypothesis:** 12 bld variants (barracks/foundry/depot/turret × 3 zones) vs 4 train variants → bld gets 3× probability mass regardless of reward. Restricted build legal mask to barracks only (3 variants).

Added `phaseLegal()` filter in `stdioRunner.ts` that removes `build` actions except `build_barracks`. This also ensured bld probability never exceeded 3/10 of actions.

**Results:** bld=62-69%, trn=0% throughout. **Build zone bug was still present — all barracks builds were still silently failing.** The filter was correct but masked the real problem.

---

### 2026-05-18 — v0.1.70-ML / v0.1.71-ML: Phase C v3/v4 — resource starvation fix

**Another diagnosis:** With `startingResources=200`, the agent could build 3 buildings in the first 3 ticks (barracks=75, depot=50, foundry=100 = 225 > 200), drain all resources, pull all workers to build sites (no gathering), leaving resources=0 when barracks completes → `train_skirmisher` (costs 50) **ILLEGAL**.

**Fix (v0.1.71):** `startingResources: 200 → 500`. Even after a 3-building spree, 275 resources remain when barracks completes. Also from scratch with `ent_coef=0.10` (was 0.04).

**Results (v71):** win_rate=0.75 at update 8 (trn=1%!) — resources fix helped briefly. Then collapsed. Build zone bug was still silently failing ~2/3 of builds (only mid_base and forward worked by chance on some maps, but both still silently failing due to MAP.width bug).

---

### 2026-05-18 — v0.1.68-ML / v0.1.69-ML: Phase C v1/v2 — reward fixes for build→train gap

**Problem (Phase C v1):** Resume from Phase B v2 checkpoint → immediately bld=70%, trn=0%. Same collapse as Phase B v1. Build zone bug active, but also:
- Phase B v2 checkpoint had trn=1% (pre-placed barracks always present). When Phase C removed the barracks, train_unit masked for 150 ticks → logit pushed toward zero
- ent_coef=0.04 too low to recover

**v0.1.69 changes:**
- Barracks-idle trickle: -0.003/tick when barracks complete + no combat units
- `hasTrainedCombatUnit`: +5 → +10

**Results:** Still collapsed. Build zone bug meant the trickle penalty never fired (no barracks ever completed).

---

### 2026-05-18 — v0.1.67-ML: Phase B v2 — pre-placed barracks ✅ 100% win rate

**Problem (Phase B v1):** Removing pre-placed skirmishers AND requiring barracks build was too large a jump. Agent converged to bld=78%, trn=0%, win_rate→0.04 within 4 updates.

**Fix:** Pre-place a **completed barracks** at (250, 300) in `stdioRunner.ts`. Agent only needs to discover `train_skirmisher → attack_move`. Build chain comes in Phase C.

**Results:** win_rate=1.00 from update 3. ep_len declined 574→389 as policy tightened. atk_mv=43%, tgt=14%, bld=2%, trn=1%. Saved checkpoint at update_000010. 

---

### 2026-05-18 — v0.1.66-ML: Phase B v1 — full chain attempt (failed)

**Removed all scaffolding** (no pre-placed skirmishers, no pre-placed barracks). Agent must build barracks + train + attack from scratch.

**Results:** Loaded from Phase A (0.1.65-ML) checkpoint. bld=73-79%, trn=0%, win_rate collapsed 0.40→0.04 in 4 updates. Root causes: (1) build zone bug — barracks builds all failing; (2) Phase A policy had atk_mv=40% but no combat units to move; (3) ent_coef=0.04 too low to explore new behaviors.

---

### 2026-05-18 — v0.1.65-ML: Phase A ✅ First wins in training history

**Curriculum Phase A:** Injected 3 pre-placed skirmishers for blue at match start. Removed build+train credit chain entirely. Agent only needs to learn `attack_move → win`.

| Config | Value |
|---|---|
| mapWidth | 500 (crystal 250px away, travel time ~125 ticks) |
| crystalHealth | 50 (destroyed in ~25 ticks) |
| startingResources | 200 (barracks affordable) |
| Pre-placed skirmishers | 3 (autoAttackEnabled=true) |
| MAX_TICKS | 3000 |

**Results:** win_rate=1.00 from update 1 — first positive terminals in the entire training history. ep_len=84-142 ticks. atk_mv=40%, tgt=17%, bld=27%, trn=2%. Phase A checkpoint saved (update_000005). Used as Phase B seed.

---

### 2026-05-18 — v0.1.62–v0.1.64: Diagnosing trn=1% and mining domination

**v0.1.62 — startingResources fix:** At startingResources=50, `build_barracks` (costs 75) was **illegal at tick 0**. Only `train_worker` (50) was legal. So "trn=1%" was 100% worker training, not skirmisher training. Fixed to 200.

**v0.1.63–64 — mining reward poisoning:** `miningDelta × 0.000025` accumulated to **+150/episode** for full gathering, completely dominating all combat signals. Agent learned to mine, not fight. Cut to 0.000001 (25×). 

Also discovered: `attack_move` only selects combat units via `getUnitGroup("all_combat")`. Workers assigned to gathering nodes never walk toward the enemy crystal regardless of map width. Map-width reduction (v0.1.63: 6000→2000→500px) was irrelevant for workers.

**Final diagnosis:** Workers can't attack via macro actions. Need pre-placed combat units (Phase A).

---

### 2026-05-18 — matchEngine.ts split + determinism test

`matchEngine.ts` extracted from 1953 lines into:
- `engine/visibility.ts` — `computeVisibility()`
- `engine/movement.ts` — `processMovement()`
- `engine/combat.ts` — `processCombat()`
- `engine/gathering.ts` — `processGathering()`
- `engine/repair.ts` — `processRepairAndHealing()`
- `engine/utils.ts` — pure helpers (`dist`, `buildSpatialGrid`, etc.)

Determinism test added: same seed × 500 ticks → identical state hash. All 391 tests passing.

---

### 2026-05-17 — Replay browser + scrub bar improvements

**Server-side pagination:** Replay browser rewritten to send `page/pageSize/sort/asc/winner/winType/bot/flags/starred` to `/api/replays`. Was fetching all 500+ replays on every render. Now defaults to 30/page.

**Scrub bar fix:** Previously used `replayBufferSize` as the max — scrub bar only filled in as the replay downloaded. Fixed to use `replayTotalTicks - 1` as the constant max. Seeking beyond the buffered portion clamps to `Math.min(target, bufferSize - 1)`.

**Economy win reward:** Changed from `+winType === "resource" ? 0 : +30` to `winType === "resource" ? -30 : +30` — economy wins now score same as losses, removing the second local minimum.

---

### 2026-05-17 — v0.1.60-ML: Breaking the 0% win-rate plateau

**Problem identified (Review 3):** After ~60M cumulative combat-training steps across v0.1.56–v0.1.59, the agent reached a stable *losing* equilibrium: intermediate shaping rewards summed to ~+12/ep, terminal loss is −10, net ep_rew ≈ +1–2 while losing 100% of games. PPO had no gradient pulling it off this optimum because the value head had never seen a +10 terminal signal. The discount at gamma=0.995 over a 1800-tick episode rendered the terminal ~1000× weaker than the barracks milestone at the decision point.

**Root cause:** No opponent weak enough to generate winning trajectories. Every training phase from v0.1.57 onwards was against `rush_medium` or earlier, bots the current policy cannot beat even by luck.

**Changes implemented (v0.1.60-ML):**

| Change | Before | After |
|---|---|---|
| Opponent | `rush_medium` | `passive_bot` (economy only, never attacks) |
| Terminal reward | ±10 | **±30** (combat), +3 (resource) |
| Crystal damage shaping | ×0.0008/HP | **×0.005/HP** (×6.25) |
| First-hit milestone | +1.0 | **+3.0** |
| Damage depth milestones | none | **+1/+2/+5** at 25/50/90% enemy crystal |
| Economy shaping | baseline | **halved** (gathering, mining, supply, standing force) |
| MAX_TICKS (training) | 6000 | **3000** |
| ent_coef | 0.02 | **0.08** (re-exploration phase) |
| New bot | — | `PassiveBot` added to headless/src/bots/ |

**Key bug caught:** `oppCrystalHealthFrac = 0` when enemy crystal is not visible (fog of war). New depth-milestone code fired all three thresholds (25/50/90%) on tick 1, giving +8 of spurious reward. Fixed with `if (curr.global.oppCrystalHealthFrac > 0)` guard before updating `minOppCrystalHealthFrac`.

**Training:** PID 417005, `/tmp/train_v60.log`, resumed from v0.1.59 final checkpoint. 20M steps vs passive_bot. Autonomous loop set to advance curriculum (passive → weak_rush → medium_rush) gated on win_rate thresholds (>60%, >40%).

**Success criterion:** First `win_rate > 0` in the log. If not seen in 5M steps vs passive_bot, escalate to behaviour-cloning warmup.

---

### 2026-05-17 — v0.1.59-ML: Gamma + milestone-timing fix

**Changes:** gamma 0.99 → 0.995 (doubles effective horizon, ~100→~200 ticks). Barracks milestone fires on **build start** (entity appears) instead of completion — brings the +0.5–2.5 reward 150 ticks closer to the actual decision. Resumed from v0.1.58 checkpoint.

**Results:** 651 updates, 20M steps. ep_rew moved positive (+0.5 to +2.0 typical, was negative in v0.1.58). ep_len locked at ~1800 throughout. **0% win rate**. Two outlier episodes (ep_rew 8.30 and 5.41, ep_len 2000+) showed occasional better survival but did not reproduce as a trend. The gamma fix worked mechanically but couldn't overcome the fundamental missing-win-trajectory problem.

---

### 2026-05-17 — React error #185 fixed

React "Maximum update depth exceeded" (error #185) traced to all `useCallback` hooks in `App.tsx` depending on `[ws]` — the entire WebSocket context object, which is a new plain object literal on every 10 Hz render. Fixed by using stable method references (`[ws.createLobby]`, `[ws.sendGameCommand]`, etc.). Also fixed `setHoverPos` in `GameShell.tsx` creating unnecessary new objects on every mouse move.

---

### 2026-05-16 — v0.1.58-ML: Skirmisher→turret counter fix + rush_medium phase 2

**Analysis of v0.1.57 Phase 1:** Agent won 100% vs idle/turtle in mixed curriculum (67% of games were free wins). Achieved 3% win rate vs rush_weak — combat was irrelevant to the gradient. Fixed by switching to 100% rush_medium.

**Changes:** Skirmisher→turret counter multiplier corrected from 1.0× to 2.0× (turrets now use "gunner" counter as defenders, matching existing logic). This prevents turret-spam as a hard counter to skirmisher rushes, forcing the agent to use actual combat units.

**Results:** Agent initially tried attacking (week 1), then decided it was "not worth it" and reverted to turtling. 0% win rate throughout. The attack-then-retreat pattern confirmed the credit-assignment problem more than action-space issues.

---

### 2026-05-15 — v0.1.57-ML: Major system overhaul (CRYSTALFRONT_REVIEW_2.md)

**Diagnostic from replay review:** Agent was never actually fighting. Root causes identified:
- `attack_move` command emitted `move` not `attack` — units never auto-acquired targets
- `retreat` set `autoAttackEnabled = false` — retreating units couldn't fire even if enemies walked into range
- `commandedTicks = 5` after every move — units were effectively paralysed during oscillating attack/retreat sequences
- Action space had no way to issue real `{type: "attack", targetEntityId}` commands

**Changes:** Full action space rebuild (37→58 actions): added `attack_targeted×12`, `hold_position×1`, new `attack_move` zones (`enemy_army`, `defend_crystal`). Engine bugs fixed (retreat keeps auto-attack, commandedTicks 1→1). Observation expanded (GLOBAL_DIM 18→22, ENTITY_DIM 11→12). New curriculum bots: `WeakRushBot`, `MediumRushBot`. Reward overhaul: forward_pressure replaced by weapon-range-proximity; defenseless trickle; survival fires earlier.

**Results (Phase 1, combat_weak):** Turret-spam defence emerged — agent learned 1 barracks + depot chain kept 4-skirmisher rushes out. Win rate ~72% but via economy abuse (67% were idle/turtle games). Combat vs rush_weak: 3%.

---

### 2026-05-14 — Planning document finalised

Original ML_BOT_ACTION_PLAN.md written. 6-phase plan: Phase 0 (engine refactors) → Phase 1 (headless + scripted bots) → Phase 2 (obs/action/reward specs) → Phase 3 (Python harness) → Phase 4 (league training) → Phase 5 (replay tools) → Phase 6 (production ONNX integration).

---

### 2026-05-14 — Phases 0–3 implemented

**Phase 0 — Engine refactors (partial):**
- ✅ `Rng` class (mulberry32, seedable) — `server/src/match/engine/rng.ts`
- ✅ `IdGen` class (monotonic counter) — `server/src/match/engine/idGen.ts`
- ✅ `LiveMatchRunner` split from `MatchEngine` — `server/src/match/liveMatchRunner.ts`
- ✅ `commandLog` added to match state (replay system foundation)
- ✅ `replayRunner.ts` for server-side replay playback
- ⚠️ `matchEngine.ts` still ~1953 lines (engine/combat.ts etc. not yet extracted)
- ⚠️ One `randomUUID()` call remains in matchEngine.ts (IdGen not fully plumbed everywhere)
- ❌ Determinism test not added to CI (seed→hash equality assertion)
- ❌ Legacy aliases in `gameBalance.ts` not removed
- ❌ Duplicate type definitions (`BuildingDef`/`UnitDef`) not resolved

**Phase 1 — Headless + scripted bots (complete + exceeded):**
- ✅ `headless/` workspace, `runMatch.ts`, CLI tool
- ✅ `observation.ts`, `actionSpace.ts`, `legalActions.ts`, `actionIndex.ts`
- ✅ `IdleBot`, `RushBot`, `TurtleBot`, `MacroBot`, `HeavyBot`
- ✅ `WeakRushBot`, `MediumRushBot`, `PassiveBot` (added during training campaign)
- ✅ `BotPlayer` in-process driver (live game plays vs scripted bot)
- ✅ Difficulty selector in lobby UI (easy/medium/hard)
- ✅ Replay saving (seed + command log → JSON)
- ⚠️ Replay viewer in client is basic — no scrub/pause controls beyond play speed

**Phase 2 — Specs (complete):**
- ✅ `/root/CRYSTALFRONT_OBS_SPEC.md`
- ✅ `/root/CRYSTALFRONT_ACTION_SPEC.md`
- ✅ `/root/CRYSTALFRONT_REWARD_SPEC.md`
- ✅ 388 passing tests covering action space, observation, legal masks, win conditions

**Phase 3 — Python training harness (complete):**
- ✅ `training/env/crystalfront_env.py` (Gymnasium wrapper, 60 parallel Node sims)
- ✅ `training/ppo/train.py` (CleanRL-style PPO, TensorBoard, milestone tracking)
- ✅ `training/ppo/policy.py` (Set-transformer, entity attention, global concat, legal-action masking)
- ✅ ROCm/CUDA GPU training confirmed working

---

## 1. Project goals

Three parallel objectives, all pursued through the same work:

1. **Balance instrument.** A bot trained to play well becomes a microscope on the game's design. Run it after every balance change; let it discover dominant strategies, dead map regions, broken counters, and exploits before real players do.
2. **Player opponent.** A shippable AI opponent with multiple difficulty tiers (easy / medium / hard), so playtesters and future players can experience the game without needing a human opponent.
3. **Learning project.** Personal hands-on education in machine learning. PPO, RL fundamentals, training pipelines, replay analysis — built from scratch, understood end-to-end.

No external deadline. Quality and learning matter more than speed.

---

## 2. Decisions made (the foundation)

The following ten decisions are fixed for this project. Any major deviation requires explicit reconsideration.

| # | Decision | Choice |
|---|---|---|
| D1 | Bot brain location | **Both**: Python for training, Node (in-process) for live play |
| D2 | Action granularity | **Hierarchical macro-actions** — ~20–30 top-level, each with sub-action trees for variance |
| D3 | Training opponents | **League** — start vs scripted bots, expand to self-play + checkpoints, iterate indefinitely |
| D4 | Vision during training | **Fog of war** — same constraints as a real player |
| D5 | Symmetry | **One bot plays both sides** — observation mirrored when playing red |
| D6 | Observation format | **Entity list** (set-based), no vision/image model |
| D7 | Reward signal | **Shaped rewards**, starting simple, expanding iteratively |
| D8 | Hardware | **CPU-first** (28-core Xeon E5-2680 v4); GPU (ROCm) deferred until needed |
| D9 | Algorithm | **PPO** (CleanRL implementation) |
| D10 | Success criteria | 4 sequential milestones: beat scripted → challenge human → emergent strategy → permanent dev tool |

### Game-design additions (from planning conversation)

- **Resource node symmetry fix** — current placement is slightly asymmetric; must be perfectly mirrored before training begins.
- **Passive win condition** — accumulate X total resources (start at ~10,000, tune via playtest) to win. Adds a second strategic pathway (economist vs militarist) and a second reward signal for the bot.
- **Replay system** — every training run stored as seed + command log (~20–50KB/match). Browse, filter, and replay in real-time using the existing game client.

---

## 3. Architecture overview

```
                                ┌─────────────────────────────┐
                                │     Python (training)       │
                                │  ┌──────────────────────┐   │
                                │  │  PPO trainer         │   │
                                │  │  (CleanRL)           │   │
                                │  │       ↑              │   │
                                │  │       │ rewards      │   │
                                │  │       │ observations │   │
                                │  │       ↓              │   │
                                │  │  Env orchestrator    │   │
                                │  │  (N parallel sims)   │   │
                                │  └──────────┬───────────┘   │
                                └─────────────┼───────────────┘
                                              │ stdio JSON
                                              │ (one per parallel sim)
                                ┌─────────────┼──────────────────┐
                                │             ↓                  │
                                │  Node headless match runner    │
                                │  ┌──────────────────────────┐  │
                                │  │  MatchEngine (pure)      │  │  ← shared with live game
                                │  │  - deterministic         │  │
                                │  │  - seedable RNG          │  │
                                │  │  - step(commands) → state│  │
                                │  └──────────────────────────┘  │
                                │  + observation builder         │
                                │  + legal-action enumerator     │
                                │  + replay logger               │
                                └────────────────────────────────┘

                                ┌────────────────────────────────┐
                                │     Live game (production)     │
                                │  ┌──────────────────────────┐  │
                                │  │  MatchEngine             │  │  ← same code
                                │  │  + LiveMatchRunner       │  │
                                │  │    (setInterval driver)  │  │
                                │  │  + BotPlayer             │  │
                                │  │    (in-process agent)    │  │
                                │  │    - loads ONNX policy   │  │
                                │  │    - picks difficulty    │  │
                                │  └──────────────────────────┘  │
                                └────────────────────────────────┘

                                ┌────────────────────────────────┐
                                │       Replay viewer            │
                                │  ┌──────────────────────────┐  │
                                │  │  Replay loader           │  │
                                │  │  (reads seed + cmd log)  │  │
                                │  │       ↓                  │  │
                                │  │  MatchEngine in playback │  │
                                │  │       ↓                  │  │
                                │  │  Existing client renderer│  │
                                │  └──────────────────────────┘  │
                                └────────────────────────────────┘
```

**Key insight:** the `MatchEngine` is the single source of truth, shared between the live game, the headless training harness, and the replay viewer. They differ only in *what drives the tick loop* and *who decides actions each tick*.

---

## 4. Proposed repo structure (after implementation)

```
CrystalFront/
├── client/                     # existing — minor changes for replay viewer
├── server/                     # existing — refactored, no behaviour change to live game
│   └── src/
│       └── match/
│           ├── matchEngine.ts          # split into multiple files (see Phase 0)
│           ├── engine/
│           │   ├── rng.ts              # NEW: seedable mulberry32 PRNG
│           │   ├── idGen.ts            # NEW: monotonic counter ID generator
│           │   ├── movement.ts         # extracted from matchEngine
│           │   ├── combat.ts           # extracted
│           │   ├── gathering.ts        # extracted
│           │   ├── construction.ts     # extracted
│           │   ├── commands/           # one file per command type
│           │   └── visibility.ts       # extracted (fog of war)
│           ├── liveMatchRunner.ts      # NEW: setInterval-based wall-clock driver
│           ├── replayLogger.ts         # NEW: command-log capture
│           └── replayLoader.ts         # NEW: replay playback
├── shared/                     # existing
├── headless/                   # NEW
│   └── src/
│       ├── runMatch.ts                 # single-match entry point
│       ├── stdioProtocol.ts            # JSON message protocol with Python
│       ├── observation.ts              # entity-list builder + fog filter
│       ├── actionSpace.ts              # hierarchical action enumeration
│       ├── legalActions.ts             # legal-action masking
│       └── scriptedBots/
│           ├── idleBot.ts
│           ├── rushBot.ts
│           ├── turtleBot.ts
│           └── macroBot.ts
├── training/                   # NEW (Python)
│   ├── env/
│   │   ├── crystalfront_env.py         # Gymnasium / PettingZoo wrapper
│   │   └── subprocess_pool.py          # N parallel Node sims
│   ├── ppo/
│   │   ├── train.py                    # main training loop
│   │   ├── policy.py                   # set-transformer network
│   │   ├── rollout.py                  # rollout buffer
│   │   └── league.py                   # league management
│   ├── eval/
│   │   ├── eval_vs_scripted.py         # milestone 1 check
│   │   ├── balance_report.py           # mass simulation for design insights
│   │   └── export_onnx.py              # save trained policy for Node
│   ├── requirements.txt
│   └── README.md
├── replays/                    # NEW (gitignored — runtime data)
│   ├── index.sqlite                    # metadata: seed, outcome, length, comp
│   └── data/                           # binary command logs
├── docs/
│   ├── ML_BOT_ACTION_PLAN.md           # this file
│   ├── observation_spec.md             # what the bot sees, exactly
│   ├── action_space.md                 # full action tree definition
│   └── reward_spec.md                  # current reward shaping
└── ...
```

---

## 5. Implementation phases

Each phase has a clear definition of done. Don't move to the next phase until the current one is complete and verified. Phases 0–2 are mandatory; later phases are valuable but optional depending on how far you take the project.

> **Current status legend:** ✅ Done · ⚠️ Partial · ❌ Not started · 🔄 In progress

### Phase 0 — Engine refactors (foundation)

**Goal:** make the engine deterministic, time-independent, and modular. No new features, no behaviour change to the live game.

**Tasks:**
1. Add `Rng` class (`server/src/match/engine/rng.ts`) — mulberry32, accepts seed, exposes `random()` and `int(min,max)`. Add to `MatchState`.
2. Add `IdGen` class (`server/src/match/engine/idGen.ts`) — monotonic counter. Replace all `randomUUID()` calls in match logic.
3. Replace `Math.random()` in `spawnOutside` (line 1912) with `match.rng.random()`.
4. Extract `setInterval` loop from `MatchEngine.startTickLoop` into a new `LiveMatchRunner` class. `MatchEngine` becomes pure: only `step()`, `subStep()`, `processCommand()`, etc.
5. Split `matchEngine.ts` (1956 lines) into:
   - `matchEngine.ts` — lifecycle and orchestration (<300 lines)
   - `engine/movement.ts`, `engine/combat.ts`, `engine/gathering.ts`, `engine/construction.ts`, `engine/visibility.ts`, `engine/repair.ts`
   - `engine/commands/*.ts` — one file per command type, replacing the giant if-chain in `processCommand`
6. Fix O(n) lookups: replace `Array.from(match.entities.values()).find(e => e.id === id ...)` with `match.entities.get(id)` + auth check (sites: lines 366, 408, 444, 537, 774, 868, 892, 927).
7. Remove duplicate type definitions: pick one home for `BuildingDef`/`UnitDef` (recommend `shared/src/gameBalance.ts`), delete shadows in `server/src/match/types.ts`.
8. Remove legacy aliases in `gameBalance.ts` (lines 327–352) — single rename pass through codebase.
9. Add `match.commandLog: Array<{tick, playerId, command}>` — appended to in `processCommand` whenever a command succeeds. This is the foundation of the replay system.
10. Fix resource node symmetry: ensure `mirrorBlueToRed()` is actually applied to all blue safe nodes during map creation. Verify red nodes are pixel-perfect mirrors.

**Definition of done:**
- All existing tests pass.
- A new test confirms: `seed1 → run 1000 ticks → state hash` equals the same run repeated. (Determinism.)
- `npm run build` clean.
- Live game plays identically to before — no visible regressions.

**Estimated effort:** 2–3 days of focused work.

**Status (2026-05-17):**
- ✅ Tasks 1–4 (Rng, IdGen, LiveMatchRunner split, commandLog)
- ✅ Task 9 (commandLog in match state)
- ✅ Task 10 (resource node symmetry — was already correct)
- ⚠️ Task 5 (matchEngine still ~1953 lines; only rng/idGen extracted to engine/)
- ⚠️ Task 6 (some O(n) lookups fixed, not all)
- ❌ Task 7 (duplicate types not resolved)
- ❌ Task 8 (legacy aliases not removed)
- ❌ Determinism CI test not added

**Outstanding from Phase 0:** The engine works correctly for training (determinism via Rng is done, the key blocker). Remaining tasks are code-quality cleanup that can be done any time without blocking training. Recommend deferring until a competent policy is locked in.

---

### Phase 1 — Headless match runner + scripted bots

**Goal:** run full matches outside of WebSockets, with scripted opponents. **This phase alone delivers the "play vs bot for testing" feature** and may be enough for early playtests.

**Tasks:**
1. Create `headless/` workspace, add to root `package.json` workspaces.
2. Build `headless/src/runMatch.ts` — accepts `{ seed, agentA, agentB, maxTicks }`, returns `{ winner, ticks, finalState, commandLog }`. Uses `MatchEngine` directly, no WebSockets.
3. Define `Agent` interface:
   ```ts
   interface Agent {
     init(playerId: string, match: MatchState): void;
     step(observation: PlayerObservation, legalActions: LegalAction[]): MacroAction[];
   }
   ```
4. Build observation builder (`headless/src/observation.ts`) — applies fog-of-war filter, outputs entity list + global features.
5. Build action space (`headless/src/actionSpace.ts`) — hierarchical macro-action definitions. Each action knows how to expand to raw `ClientCommand`s.
6. Build legal-action enumerator (`headless/src/legalActions.ts`) — given a state and player, returns the list of currently valid macro-actions. Reuses existing validation functions.
7. Implement 4 scripted bots:
   - `IdleBot` — gathers resources, nothing else. Baseline.
   - `RushBot` — early barracks, mass-skirmisher attack-move.
   - `TurtleBot` — supply depots, turrets, gunner army, defensive.
   - `MacroBot` — economy expansion, foundry tech, mixed army.
8. CLI tool: `npx tsx headless/src/cli.ts --seed 42 --blue rush --red turtle --output replay.json`
9. Add replay-file format spec (`docs/replay_format.md`) — JSON with `{ version, seed, config, commandLog }`.
10. Integrate scripted bot into live game: replace inert `isBot: true` session in `server/src/index.ts:377` with an actual bot player driver. Add difficulty selector to lobby UI: "vs Easy Bot" / "vs Medium Bot" / "vs Hard Bot" (initially all map to different scripted bots; later, "Hard" becomes the trained policy).

**Definition of done:**
- `headless/src/cli.ts` runs a match in <5 seconds.
- All 4 scripted bots can play full matches without crashing.
- Replays save to disk and can be loaded back into the live game's client for visual playback.
- A player can join a "vs Bot" game in the live UI and play against any scripted bot.

**Estimated effort:** 1 week.

**Status (2026-05-17): ✅ Complete (exceeded plan)**
- ✅ All tasks 1–9 done
- ✅ 8 scripted bots (IdleBot, RushBot, TurtleBot, MacroBot, HeavyBot, WeakRushBot, MediumRushBot, PassiveBot)
- ✅ Replay saving (seed + command log → JSON, ~20–50 KB/match as planned)
- ✅ BotPlayer in-process driver wired into live server; difficulty selector in lobby UI
- ✅ `cli.ts` runs in <1 second
- ⚠️ Replay playback in client exists but controls are basic (play/pause, no scrubbing to specific tick, no "jump to event")

---

### Phase 2 — Observation, action, and reward specifications

**Goal:** lock down the exact interface between game and bot. This is the contract; everything downstream depends on it.

**Tasks:**
1. Write `docs/observation_spec.md` — every field the bot sees, with shapes and ranges. Examples:
   ```
   global_features: vec[12]
     - own_resources / 1000          ∈ [0, 10]
     - own_supply / max_supply       ∈ [0, 1]
     - opp_visible_supply_estimate / max_supply  ∈ [0, 1]
     - tick / 6000                   ∈ [0, 1]
     - score_diff                    ∈ [-3, 3]
     - ... etc

   entity_list: variable-length list of vec[24] per entity
     - type one-hot (10 dims: crystal, worker, skirmisher, gunner, bruiser, medic, barracks, foundry, supply_depot, turret)
     - owner (1 = mine, -1 = enemy, 0 = neutral)
     - x_norm, y_norm                ∈ [0, 1]
     - health / max_health           ∈ [0, 1]
     - attack_cooldown_norm
     - is_attacking, is_moving, is_gathering, is_building (binary flags)
     - construction_progress / 100   (buildings only)
     - ... etc

   node_list: variable-length list of vec[6] per visible node
     - x_norm, y_norm
     - remaining / capacity
     - gatherer_count / 3
     - is_contested (binary)
     - ...
   ```
2. Write `docs/action_space.md` — complete hierarchical action tree. Example:
   ```
   NOOP

   TRAIN_WORKER

   TRAIN_UNIT(unit_type ∈ {skirmisher, gunner, bruiser, medic})
     → auto-routes to nearest valid production building

   BUILD(building_type, x_zone, y_zone, intent)
     building_type ∈ {barracks, foundry, supply_depot, turret}
     x_zone ∈ {near_crystal, mid_base, forward}      # 3 distance bands
     y_zone ∈ {top, middle, bottom}                  # 3 lane positions
     intent ∈ {near_node, near_building, freestanding, blocking_lane}
     → 4 × 3 × 3 × 4 = 144 build sub-actions

   ATTACK_MOVE_GROUP(group, target_zone)
     group ∈ {all_combat, skirmishers, gunners, bruisers, mixed_army}
     target_zone ∈ {enemy_crystal, enemy_visible_threat, midfield_top, midfield_mid, midfield_bot, contested_node_nearest}

   RETREAT_GROUP(group) → toward own crystal

   ASSIGN_WORKERS(node_choice, count)
     node_choice ∈ {nearest_safe, nearest_contested, richest_visible}
     count ∈ {1, 2, 3, all_idle}

   SET_RALLY(building_zone, target_zone)

   TOGGLE_AUTO_ATTACK(group)
   ```
   Total enumerated actions: ~250–400. Manageable for PPO.
3. Write `docs/reward_spec.md` — initial reward shaping:
   ```
   Per-tick rewards (sum each tick into agent's score):
     +0.0010 × damage_dealt_to_enemy_crystal
     -0.0010 × damage_taken_to_own_crystal
     +0.0001 × resources_mined_this_tick
     +0.0005 × (own_supply - opp_supply)  # army advantage
     -0.00005 (time penalty per tick — discourages stalling)
   Terminal rewards:
     +10.0  for win (crystal kill)
     -10.0  for loss
     +5.0   for resource-victory win   # passive win condition
     -5.0   for resource-victory loss
   ```
   These are *starting points*. Expect to retune after observing behaviour.
4. Implement observation builder and action enumerator against the specs.
5. Write unit tests: every action in the action space, when emitted on a valid state, produces a successful `processCommand` result.

**Definition of done:**
- Three markdown specs are complete and reviewable.
- Code matches the specs.
- All 250–400 actions are individually unit-tested for "emits valid commands on a representative state."

**Estimated effort:** 4–5 days.

**Status (2026-05-17): ✅ Complete**
- ✅ `/root/CRYSTALFRONT_OBS_SPEC.md` — observation spec (GLOBAL_DIM=22, ENTITY_DIM=12)
- ✅ `/root/CRYSTALFRONT_ACTION_SPEC.md` — action space spec (58 discrete actions)
- ✅ `/root/CRYSTALFRONT_REWARD_SPEC.md` — reward shaping spec (now v0.1.60-ML version)
- ✅ 388 tests passing, covering legal actions, observations, win conditions

---

### Phase 3 — Python training harness

**Goal:** a working PPO training loop with parallel Node simulators.

**Tasks:**
1. Set up `training/` Python project (pyproject.toml, requirements: `torch`, `gymnasium`, `pettingzoo`, `numpy`, `tensorboard`, `tyro` or `click` for CLI).
2. Build `training/env/subprocess_pool.py` — manages N Node subprocesses, each running `headless/src/runMatch.ts` in "stepper mode" (reads commands from stdin, writes observations to stdout).
3. Implement JSON-line protocol on the Node side (`headless/src/stdioProtocol.ts`):
   - `RESET { seed }` → `OBSERVATION { state, legal_actions }`
   - `STEP { actions: [blueAction, redAction] }` → `OBSERVATION { state, legal_actions, reward, done }`
4. Wrap as Gymnasium env (`training/env/crystalfront_env.py`).
5. Build PPO trainer (`training/ppo/train.py`) based on CleanRL `ppo.py` template.
6. Build policy network (`training/ppo/policy.py`):
   - Set-transformer over entity list (2–4 attention layers)
   - Concatenate pooled entity embedding with global features
   - Hierarchical action head: first pick top-level action, then sub-actions conditioned on it
   - Use legal-action masking to zero out invalid options before softmax
7. Train against `RushBot` first (single fixed opponent) to confirm the pipeline works end-to-end.
8. Add TensorBoard logging: win rate, episode length, reward components, entropy.

**Definition of done:**
- `python training/ppo/train.py --opponent rush --steps 1M` runs without error.
- Win rate vs `IdleBot` reaches 100% within reasonable training time (sanity check — beating an opponent that does nothing should be trivial).
- TensorBoard shows reward curves that aren't obviously broken (not collapsing, not flat).

**Estimated effort:** 2 weeks. This is the hardest phase if you've never done RL before.

**Status (2026-05-17): ✅ Complete**
- ✅ `training/env/crystalfront_env.py` — Gymnasium wrapper, 60 parallel Node sims
- ✅ `training/ppo/train.py` — CleanRL PPO with TensorBoard, milestone logging, action histograms
- ✅ `training/ppo/policy.py` — Set-transformer over entity list, global concat, legal-action masking
- ✅ GPU training working (ROCm/CUDA)
- ✅ Win rate vs IdleBot reached ~100% early in training (pre-v0.1.56)
- ✅ 60M+ steps of training completed across v0.1.43→v0.1.60
- ⚠️ Currently stuck at 0% win rate vs combat opponents (the ongoing ML challenge — see diary)

---

### Phase 4 — League training + checkpoints

**Goal:** real training campaign, with the league system from D3.

**Tasks:**
1. Implement `training/ppo/league.py` — manages a pool of opponents:
   - Scripted bots (always present, low sampling weight once policy is competent)
   - Last N policy checkpoints (sampled with priority on closest-skill match)
2. Checkpoint saving: every K updates, save the policy and add to the league pool.
3. Sampling strategy: for each rollout, pick opponent with prioritised-fictitious-self-play (PFSP) weighting.
4. Win-rate matrix logging: every E episodes, log current policy's win rate vs every opponent in the league.
5. Run the first serious training campaign (target: 10M environment steps, ~1 week wall time on CPU).

**Definition of done:**
- Win rate vs each scripted bot is >90% (Milestone 1 achieved).
- TensorBoard shows the win-rate matrix evolving sensibly over time.
- At least one human playtest where you (the developer) play vs the latest checkpoint and find it challenging.

**Estimated effort:** 1 week setup + indefinite training time.

**Status (2026-05-18): ⚠️ Curriculum in progress — three scaffolded phases complete**

**Curriculum ladder (as of v0.1.75-ML):**

| Phase | Version | Scaffold | Map | Crystal | Opponent | Win rate |
|---|---|---|---|---|---|---|
| A | 0.1.65-ML | 3 pre-placed skirmishers | 500px | 50HP | idle_bot | **1.00 ✅** |
| B v2 | 0.1.67-ML | Pre-placed barracks | 1000px | 100HP | passive_bot | **1.00 ✅** |
| C v8 | 0.1.75-ML | None (full chain) | 1000px | 100HP | passive_bot | 🔄 Running |
| D | planned | None | 6000px | 1000HP | passive_bot | not started |

- ✅ `training/ppo/league.py` — PFSP opponent sampling, win-rate matrix, checkpoint pool
- ✅ League mode in `train.py` (`--league` flag)
- ✅ Checkpoint saved every N updates (configurable), full pool management
- ✅ Action histogram logging: `atk_mv/tgt/bld/trn` percentages per update
- ❌ Never activated in production — curriculum approach used instead
- ❌ Human playtest vs trained policy (live bot still uses scripted bots only)
- ❌ Phase D (full game) not started; blocked on Phase C convergence

**Key wins achieved:**
- First ever positive terminal in training history: v0.1.65-ML Phase A, win_rate=1.00 from update 1
- Full build→train→attack chain discovered at 82%+ win_rate in v0.1.73 (build zone bug fixed)
- Critical bug found and fixed: `chooseBuildPosition()` used hardcoded MAP.width=6000 regardless of training map size — every Phase C build command silently failed for ~8 training versions

**Immediate blockers for Phase D:**
1. Phase C (full chain, 1000px map) must achieve stable >70% win rate
2. `phaseLegal()` filter (barracks-only builds) must be removed
3. Map widened from 1000px → 6000px with crystal 1000HP (discount + terminal signal recalibration needed)

---

### Phase 5 — Replay viewer + balance analysis tools

**Goal:** turn the bot from a black box into an instrument.

**Tasks:**
1. Build replay viewer in the existing client:
   - New route `/replay/:id`
   - Loads replay JSON, runs `MatchEngine` in playback mode at real-time speed
   - Same renderer as live games
   - Playback controls: pause, play, 2×, 4×, jump to tick, "next event"
2. Replay index DB (`replays/index.sqlite`): metadata per match (seed, ticks, winner, ending type, unit counts, build orders).
3. Replay browser UI: filter/sort by:
   - Match length (find the 10-second surprise!)
   - Winning side
   - Win type (crystal vs passive resource)
   - Dominant unit type used
   - Specific build orders (e.g. "matches where red built turret first")
4. Balance report generator (`training/eval/balance_report.py`):
   - Run 10,000 matches at current checkpoint
   - Output: win rates by side, average game length, frequency of each unit type, frequency of each building, average resources at game end, passive-win frequency
   - Compare against baseline reports (so you can see what changed after a balance tweak)
5. Auto-flagging: highlight outliers in the replay index — fastest games, longest games, lopsided games, unusual win conditions.

**Definition of done:**
- You can browse a folder of 10,000 replays, sort by length, click the shortest one, and watch it play out at real-time speed.
- After a balance change to `gameBalance.ts`, you can run a balance report and get a side-by-side comparison.

**Estimated effort:** 1 week.

**Status (2026-05-18): ⚠️ Partial**
- ✅ Replays save to disk as JSON (seed + command log, one file per match in `replays/`)
- ✅ Replay playback in client (route `/replays`, loads and plays back)
- ✅ **Scrub bar represents full game length** (was: only buffered portion; fixed to use `replayTotalTicks`)
- ✅ **Server-side pagination** for replay browser (30/page default; sends filter/sort/page params to `/api/replays` endpoint)
- ✅ Filters: winner, win type, bot name (debounced), starred flag
- ✅ Training replays now suppressed: `--save_replay_every 0` flag on all training runs
- ❌ `replays/index.sqlite` metadata database (still raw JSON files)
- ❌ Filter by unit composition or build order (would need SQLite index)
- ❌ `training/eval/` directory does not exist; no balance report generator
- ❌ Jump-to-event controls; speed selector
- ❌ Auto-flagging (outlier detection on fastest/longest/lopsided games)

**Priority:** Deferred until Phase 4 (training campaign) produces a policy worth analysing at scale. Balance reports are most valuable after the policy stops changing.

---

### Phase 6 — Production bot integration

**Goal:** trained bot shipped as a player option in the live game.

**Tasks:**
1. ONNX export from PyTorch (`training/eval/export_onnx.py`).
2. ONNX runtime in Node (`onnxruntime-node`) — `BotPlayer` class loads a `.onnx` file and produces commands.
3. Difficulty tier system: ship 3 policy snapshots (early, mid, late training checkpoints) as "easy / medium / hard."
4. Lobby UI: "Play vs Bot" with difficulty selector.
5. In-process driver: `BotPlayer` plugs into `MatchEngine` without going through WebSocket — bot's commands enter via the same `processCommand` interface as a remote player.

**Definition of done:**
- A player can start the game, click "vs Hard Bot", and play a full match.
- Bot responds within a tick (no perceptible lag).
- Bot bundle size doesn't bloat the client (policy lives server-side).

**Estimated effort:** 3–4 days.

**Status (2026-05-17): ⚠️ Infrastructure half-done**
- ✅ `BotPlayer` in-process driver (`server/src/match/botPlayer.ts`) — takes any `Agent`, calls `.tick()` each game tick
- ✅ Difficulty selector in lobby UI (easy/medium/hard) wired into `START_SOLO_TEST`
- ✅ Easy/Medium/Hard currently serve scripted bots (IdleBot / MacroBot / RushBot)
- ❌ `training/eval/export_onnx.py` — ONNX export script not written
- ❌ ONNX policy loader in Node (`onnxruntime-node`) not implemented
- ❌ Trained policy cannot yet be used as the hard bot; difficulty tiers are still all-scripted

**What remains:** Once a competent policy exists (~Phase 4 done), ONNX export + a small Node loader wires directly into the existing `BotPlayer`. Estimated 2–3 days when ready.

---

### Phase 7 — Permanent instrument (ongoing)

This isn't a phase with a definition of done — it's the steady-state you arrive at. After every meaningful change to `gameBalance.ts`, `matchEngine.ts`, or the action space:
1. Re-run a training campaign (could be short — fine-tune from previous checkpoint).
2. Generate a fresh balance report.
3. Compare against previous reports. Did something break? Did a new dominant strategy emerge?
4. Watch a sample of replays. Anything surprising?
5. If something is off, adjust balance or design, repeat.

This is the loop that justifies the entire project. Milestones 3 and 4 from D10 are met inside this loop.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Reward hacking — bot finds degenerate strategies (mine forever, suicide units, etc.) | Start with sparse rewards, add shaped pieces gradually. Watch replays of outlier games to spot exploits early. |
| Training instability — PPO diverges, win rates collapse | Use CleanRL's reference hyperparameters; don't tune until baseline is reproducible. Save checkpoints often so you can roll back. |
| Game-design churn invalidates trained policy | Treat training as cheap and re-runnable. Don't over-invest in any single checkpoint until balance is locked. |
| GPU passthrough to LXC is a fight | Don't fight it. CPU-only training is fine for this scale. Revisit only if learning step becomes the bottleneck. |
| Action space too large, training too slow | Start with a reduced action space (~50 actions), expand once baseline works. Keep the action-space spec versioned. |
| Determinism bugs (small floating-point drift between runs) | Test determinism in CI: run the same seed twice, hash the final state, assert equal. Catch drift the moment it appears. |
| Scope creep — features piling up before any training happens | Phases 0–2 are mandatory and unambiguously valuable. Resist the urge to start Phase 3 before then. |

---

## 7. Estimated timeline (assuming part-time work)

These are *rough* — adjust to your actual pace. The total is generous; this is a learning project, not a sprint.

| Phase | Effort | Cumulative wall-time at, say, 5 hrs/week |
|---|---|---|
| Phase 0 — engine refactors | 2–3 days | ~2 weeks |
| Phase 1 — headless + scripted bots | 1 week | ~4 weeks |
| Phase 2 — specs (obs, action, reward) | 4–5 days | ~6 weeks |
| Phase 3 — Python training pipeline | 2 weeks | ~10 weeks |
| Phase 4 — league training | 1 week setup + open training | ~12 weeks (training runs in background) |
| Phase 5 — replay tools + balance analysis | 1 week | ~14 weeks |
| Phase 6 — production bot | 3–4 days | ~15 weeks |
| Phase 7 — ongoing | Forever | Forever |

If at the end of Phase 1 you already have what you need (scripted bots are challenging enough for playtesting), **stop and ship**. Phases 3–6 are the ML payoff but they're not required for the playtest goal.

---

## 8. Stop-the-line conditions

Pause and reassess if any of these happen:

- **Phase 0 stretches beyond 1 week.** Something is wrong with the refactor approach; back up and simplify.
- **Phase 3 training never beats `IdleBot`.** Pipeline is broken, not a tuning problem. Don't move forward.
- **Phase 4 win rate vs scripted bots plateaus below 60% after 20M steps.** Action space, reward, or observation needs rework — don't throw more compute at it.
- **Bot's "interesting" behaviour turns out to be exploiting a simulation bug** (e.g. dealing damage through walls, infinite resource glitch). Fix the bug; don't let the bot keep the win.

---

## 9. Open questions to revisit

These don't block starting work, but they'll need decisions later:

- **Exact action sub-tree contents** — the trees in §5 Phase 2 are a starting sketch. Refine before coding.
- **Passive win threshold** — start at 10,000, but tune via human playtests *before* the bot starts training against it.
- **Episode length cap** — what's the maximum tick count for a training match? (Recommend 6000 ticks = 10 min real-time = ~6 seconds compute.)
- **How many sub-tiers of "Hard"?** — just one, or several? (e.g. "Hard / Master / Expert" with progressively newer checkpoints.)
- **Replay retention policy** — keep all replays forever? Just the interesting ones? Prune by date?
- **What does "live game" version-compatibility mean?** — if `gameBalance.ts` changes, older replays may not play back identically. Add a `version` field to replay format; warn on mismatch.
- **Is there a future for asymmetric features** (e.g. different starting positions, terrain variations)? — keep the door open in observation format but don't implement yet.

---

## 10. Resources to learn from

A short curated list of materials that will serve this project specifically (not a generic ML reading list):

- **CleanRL PPO** — https://github.com/vwxyzjn/cleanrl — single-file PPO implementation, read it cover-to-cover before writing your own.
- **OpenAI Five blog posts** — overview of how a real multi-agent RTS-like bot was built. Skim for vocabulary.
- **OpenAI hide-and-seek paper** (which you've already cited) — useful for inspiration but their environment differs substantially from yours.
- **AlphaStar Nature paper** — the architecture (set-transformer + auto-regressive action head + league training) is what we're roughly modelling.
- **PettingZoo docs** — the multi-agent Gym variant; useful if you decide to formalise the env that way.
- **Hugging Face Deep RL course** — free, well-paced, covers PPO with practical examples.

---

## 11. Immediate next step

Begin **Phase 0, Task 1**: add `Rng` class and plumb it through `MatchState`. Verify with a "run the same seed twice, hash final state, assert equal" test.

Everything downstream depends on this.

---

*End of plan. Live document — update as decisions evolve.*
