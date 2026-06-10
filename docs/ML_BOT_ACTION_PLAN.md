# Crystal Front — ML Bot Action Plan

**Branch:** `CrystalFront-ML`
**Status:** v0.3.2-ML **SHIPPED** (2026-05-22). v0.4.0-ML **HALTED** (2026-05-23) — Option B action-masking and Option γ RND both failed to break `trn=0%` ceiling.
**Last updated:** 2026-06-09

---

## Current handoff state (2026-06-09) — START HERE

This section is the orientation point for any agent picking up the project. Everything else in this file is either reference (sections 1–11) or chronological development history (section 12).

### Where we are

- **v0.3.2-ML is live in production.** `models/policy-v0.3.2-ML.onnx`. Not changing until v0.5.0-ML eval gates pass (see `docs/REVIVAL_PLAN.md` Task 3.3).
- **Phase 0 of the revival plan is complete** (v0.5.0-ML). The three root causes of the v0.4.0-ML failure were diagnosed and fixed: (1) autoreset config-override bug in `stdioVecRunner.ts`, (2) static MAP constants in observation/geometry code, (3) MacroBot crash. Code base is now trustworthy.
- **Phase 1 (balance) is in progress** (v0.5.1-ML). Tasks 1.1–1.4 complete (engine tiebreaker, iteration 1 balance changes). Balance matrix running; acceptance criteria TBD when matrix completes. Do not start Phase 2 until acceptance criteria pass.
- **Phase 2 (MDP restructure) is next** after Phase 1 acceptance. See `docs/REVIVAL_PLAN.md` §Phase 2.

See `docs/REVIVAL_PLAN.md` for the full implementation plan and Appendix B for task status.

### What's deployable, what's not

| Asset | State | Path |
|-------|-------|------|
| **Production ML bot** | ✅ Live (v0.3.2-ML, u150) | `models/policy-v0.3.2-ML.onnx` (+ `.onnx.data`) |
| Source checkpoint | ✅ Clean | `checkpoints/crystalfront_ppo__0_3_0-ML__idle__1__1779364610/update_000150.pt` |
| v0.4.0-ML checkpoints | ❌ Do not use | Training ran on default config (bug fixed in v0.5.0-ML) |
| Option B / RND code | ⚠️ Default-off, deprecated | See @deprecated comments; do not activate |

### What was learned (2026-06 full diagnosis)

The v0.4.0-ML failures were caused by three compounding bugs, **not** by the "gradient sign" hypothesis recorded in the previous handoff:

1. **Autoreset bug** — `stdioVecRunner.ts` dropped `configOverrides` on every episode autoreset. >99% of all training ran on default 6000px/1000HP/50-res config regardless of curriculum stage. All historical stage-clear rates are meaningless. **FIXED in v0.5.0-ML Task 0.1.**
2. **Game balance** — empirically, no scripted bot beats rush_medium (macro 0/20, turtle 0/20, heavy 0/20, rush 1/20). The training gate was unachievable regardless of algorithm. **To be fixed in Phase 1.**
3. **MDP formulation** — γ=0.995 with 1 decision/tick makes the ±100 terminal invisible to early game decisions. Draws and resource wins both score −100 (noop attractor). **To be fixed in Phase 2.**

The "gradient sign" framing from the previous handoff was not wrong per se — it described a symptom — but the root causes were upstream of the gradient.

### Files an agent should read next

| If you want to | Read |
|----------------|------|
| Full implementation plan with task checklist | `docs/REVIVAL_PLAN.md` |
| Architecture, specs, training commands | `docs/ML_AGENT.md` (§3 regenerated 2026-06-09) |
| Current reward function | `headless/src/reward.ts` |
| Balance numbers | `shared/src/gameBalance.ts` |
| Action enumeration (source of truth) | `headless/src/actionIndex.ts` |
| Historical training arc | Section 12 below |

### Key commands

```bash
npm test                                   # 466+ tests
npm run build:headless                     # rebuild dist (ALWAYS after editing headless/src)
python3 -m training.test_env               # 5s smoke test
python3 -m training.test_config_persistence # config-override regression test
python3 training/balance_report.py --matches 20   # bot matrix (Phase 1)

# Continue training (after Phase 0+1+2 complete)
python3 -m training.ppo.train --curriculum --curriculum_stage 0 \
  --checkpoint bc_warmup_v05.pt --decision_interval 8 \
  --num_envs 20 --vec_size 4 --total_timesteps 20000000
```

### Open commitments

| Commitment | Status |
|------------|--------|
| Ship v0.3.2-ML bot | ✅ Live in production |
| Phase 0: fix infra bugs | ✅ Complete (v0.5.0-ML, 2026-06-09) |
| Phase 1: balance game | 🔄 In progress — Tasks 1.1–1.4 done; matrix running |
| Phase 2: restructure MDP | ⬜ After Phase 1 acceptance criteria pass |
| Phase 3: retrain + ship v0.5.0-ML | ⬜ After Phase 2 |

---

## Table of contents

1. [Project goals](#1-project-goals)
2. [Decisions made (the foundation)](#2-decisions-made-the-foundation)
3. [Architecture overview](#3-architecture-overview)
4. [Proposed repo structure](#4-proposed-repo-structure-after-implementation)
5. [Implementation phases](#5-implementation-phases)
6. [Risks & mitigations](#6-risks--mitigations)
7. [Estimated timeline](#7-estimated-timeline-assuming-part-time-work)
8. [Stop-the-line conditions](#8-stop-the-line-conditions)
9. [Open questions to revisit](#9-open-questions-to-revisit)
10. [Resources to learn from](#10-resources-to-learn-from)
11. [Immediate next step (historical)](#11-immediate-next-step-historical)
12. [Development diary — chronological](#12-development-diary--chronological-oldest-first)

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

**Status (2026-05-18): ✅ Mostly complete**
- ✅ Tasks 1–4, 9, 10 (Rng, IdGen, LiveMatchRunner, commandLog, node symmetry)
- ✅ Task 5: matchEngine.ts split into engine/{combat,gathering,movement,repair,utils,visibility}.ts
- ✅ Determinism test added: same seed × 500 ticks → identical state hash (391 tests passing)
- ✅ randomUUID() removed — IdGen used throughout match lifecycle
- ⚠️ Task 6 (O(n) lookups — partially addressed, not fully audited)
- ❌ Task 7 (duplicate types — low priority)
- ❌ Task 8 (legacy aliases — low priority)

**Outstanding:** Only cleanup tasks remain. Engine is fit for training.

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

**Status (2026-05-18): ✅ Complete + exceeded plan**
- ✅ All tasks 1–9 done
- ✅ 8 scripted bots (IdleBot, RushBot, TurtleBot, MacroBot, HeavyBot, WeakRushBot, MediumRushBot, PassiveBot) + WeakMediumRushBot added during shipping work (9 total)
- ✅ Replay saving (seed + command log → JSON, ~20–50 KB/match as planned)
- ✅ BotPlayer in-process driver wired into live server; difficulty selector in lobby UI
- ✅ Server-side replay pagination (30/page; was fetching all replays on every render)
- ✅ Scrub bar fixed to represent full game length (not just buffered portion)
- ✅ Training replays suppressed by default (`--save_replay_every 0`)
- ⚠️ No speed selector or jump-to-event controls

---

### Phase 2 — Observation, action, and reward specifications

**Goal:** lock down the exact interface between game and bot. This is the contract; everything downstream depends on it.

**Tasks:**
1. Write `docs/observation_spec.md` — every field the bot sees, with shapes and ranges.
2. Write `docs/action_space.md` — complete hierarchical action tree.
3. Write `docs/reward_spec.md` — initial reward shaping.
4. Implement observation builder and action enumerator against the specs.
5. Write unit tests: every action in the action space, when emitted on a valid state, produces a successful `processCommand` result.

**Definition of done:**
- Three markdown specs are complete and reviewable.
- Code matches the specs.
- All ~80 actions are individually unit-tested for "emits valid commands on a representative state."

**Estimated effort:** 4–5 days.

**Status (2026-05-18): ✅ Complete**
- ✅ `docs/CRYSTALFRONT_OBS_SPEC.md`, `docs/CRYSTALFRONT_ACTION_SPEC.md`, `docs/CRYSTALFRONT_REWARD_SPEC.md`
- ✅ 391 tests passing (added determinism test)
- ⚠️ Reward spec may lag the canonical `headless/src/reward.ts` — that file is the source of truth as of v0.3.0-ML.

---

### Phase 3 — Python training harness

**Goal:** a working PPO training loop with parallel Node simulators.

**Tasks:**
1. Set up `training/` Python project.
2. Build `training/env/subprocess_pool.py` — manages N Node subprocesses.
3. Implement JSON-line protocol on the Node side.
4. Wrap as Gymnasium env.
5. Build PPO trainer.
6. Build policy network (set-transformer over entity list).
7. Train against `RushBot` first.
8. Add TensorBoard logging.

**Definition of done:**
- `python training/ppo/train.py --opponent rush --steps 1M` runs without error.
- Win rate vs `IdleBot` reaches 100% within reasonable training time.
- TensorBoard shows reward curves that aren't obviously broken.

**Estimated effort:** 2 weeks.

**Status (2026-05-18): ✅ Complete**
- ✅ `training/env/crystalfront_env.py` — Gymnasium wrapper, 60 parallel Node sims
- ✅ `training/env/crystalfront_vec_env.py` — vectorised, N games per process (v0.2.8-ML)
- ✅ `training/ppo/train.py` — CleanRL PPO, TensorBoard, action histograms, checkpoint save/load, GPU/ROCm
- ✅ `training/ppo/policy.py` — Set-transformer over entity list, global concat, legal-action masking; RND module (v0.4.0-ML, default-off)
- ✅ `training/bc_pretrain.py` — Behaviour Cloning warmup (v0.3.0-ML+)
- ✅ `training/diagnose_policy.py` — per-episode action histogram diagnostic (v0.4.0-ML)
- ✅ 0% win rate plateau broken — Phase A win_rate=1.00 (v0.1.65-ML), Phase B win_rate=1.00 (v0.1.67-ML)
- ✅ Full BC + 13-stage curriculum delivered v0.3.2-ML production model

---

### Phase 4 — League training + checkpoints

**Goal:** real training campaign, with the league system from D3.

**Tasks:**
1. Implement `training/ppo/league.py` — PFSP-weighted opponent sampling.
2. Checkpoint saving every K updates.
3. Sampling strategy.
4. Win-rate matrix logging.
5. Run the first serious training campaign.

**Definition of done:**
- Win rate vs each scripted bot is >90% (Milestone 1 achieved).
- TensorBoard shows the win-rate matrix evolving sensibly over time.
- At least one human playtest where you (the developer) play vs the latest checkpoint and find it challenging.

**Estimated effort:** 1 week setup + indefinite training time.

**Status (2026-05-22): ⚠️ Partial — never activated in production**
- ✅ `training/ppo/league.py` — PFSP opponent sampling, win-rate matrix, checkpoint pool
- ✅ League mode in `train.py` (`--league` flag)
- ✅ Checkpoint saved every N updates (configurable)
- ✅ 13-stage curriculum (the real driver of v0.3.2-ML)
- ❌ League mode never activated — curriculum approach used instead (per third review §7.10 + R11: league only after 3b is solved; 3b never solved)
- ✅ Human playtest vs trained policy — happened with v0.3.2-ML on 2026-05-22

---

### Phase 5 — Replay viewer + balance analysis tools

**Status (2026-05-18): ⚠️ Partial**
- ✅ Replays save to disk as JSON (seed + command log)
- ✅ Replay playback in client (route `/replays`)
- ✅ Scrub bar represents full game length
- ✅ Server-side pagination
- ✅ Filters: winner, win type, bot name, starred flag
- ✅ Training replays suppressed by default
- ❌ `replays/index.sqlite` metadata database
- ❌ Filter by unit composition or build order
- ❌ Balance report generator
- ❌ Jump-to-event controls; speed selector
- ❌ Auto-flagging (outlier detection)

**Priority:** Deferred. Balance reports are most valuable after the policy stops changing.

---

### Phase 6 — Production bot integration

**Goal:** trained bot shipped as a player option in the live game.

**Status (2026-05-22): ✅ Complete — v0.3.2-ML shipped**

- ✅ `BotPlayer` in-process driver (`server/src/match/botPlayer.ts`)
- ✅ `MlBot` class (`headless/src/bots/mlBot.ts`) — ONNX policy via `onnxruntime-node`
- ✅ ONNX export pipeline (`training/export_onnx.py`)
- ✅ Model at `models/policy-v0.3.2-ML.onnx` + `.onnx.data`
- ✅ Server pre-loads ONNX session at startup (`mlBotSession` singleton)
- ✅ `BotSelectMenu.tsx` — dedicated "Play vs Bot" screen with SCRIPTED / ML sections
- ✅ All matches (PvP + vs-bot) saved as replays with both player usernames
- ✅ Replay playback shows actual gameplay (UUID playerId bugs fixed)
- ✅ 443+ tests passing at ship

See diary entry "v0.3.2-ML — SHIPPED" in section 12 for full implementation notes.

---

### Phase 7 — Permanent instrument (ongoing)

This isn't a phase with a definition of done — it's the steady-state you arrive at. After every meaningful change to `gameBalance.ts`, `matchEngine.ts`, or the action space:
1. Re-run a training campaign.
2. Generate a fresh balance report.
3. Compare against previous reports.
4. Watch a sample of replays.
5. Adjust balance or design, repeat.

This is the loop that justifies the entire project. Milestones 3 and 4 from D10 are met inside this loop.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Reward hacking — bot finds degenerate strategies (mine forever, suicide units, etc.) | Start with sparse rewards, add shaped pieces gradually. Watch replays of outlier games to spot exploits early. |
| Training instability — PPO diverges, win rates collapse | Use CleanRL's reference hyperparameters; don't tune until baseline is reproducible. Save checkpoints often so you can roll back. |
| Game-design churn invalidates trained policy | Treat training as cheap and re-runnable. Don't over-invest in any single checkpoint until balance is locked. |
| GPU passthrough to LXC is a fight | Don't fight it. CPU-only training is fine for this scale. Revisit only if learning step becomes the bottleneck. (GPU later worked; see v0.2.8 entry.) |
| Action space too large, training too slow | Start with a reduced action space (~50 actions), expand once baseline works. Keep the action-space spec versioned. |
| Determinism bugs (small floating-point drift between runs) | Test determinism in CI: run the same seed twice, hash the final state, assert equal. Catch drift the moment it appears. |
| Scope creep — features piling up before any training happens | Phases 0–2 are mandatory and unambiguously valuable. Resist the urge to start Phase 3 before then. |
| **Local optima that compound** (added 2026-05-23) | The `trn=0%` ceiling for v0.4.0-ML was not a tooling problem — it was a **gradient sign** problem. Adding mechanics (action-masking, intrinsic rewards) on top of a misaligned gradient does not fix the alignment. Future architectural work must change *which trajectories produce wins*, not how trajectories are sampled. |

---

## 7. Estimated timeline (assuming part-time work)

These are *rough* — adjust to your actual pace. The total is generous; this is a learning project, not a sprint.

| Phase | Effort | Cumulative wall-time at, say, 5 hrs/week |
|---|---|---|
| Phase 0 — engine refactors | 2–3 days | ~2 weeks |
| Phase 1 — headless + scripted bots | 1 week | ~4 weeks |
| Phase 2 — specs (obs, action, reward) | 4–5 days | ~6 weeks |
| Phase 3 — Python training pipeline | 2 weeks | ~10 weeks |
| Phase 4 — league training | 1 week setup + open training | ~12 weeks |
| Phase 5 — replay tools + balance analysis | 1 week | ~14 weeks |
| Phase 6 — production bot | 3–4 days | ~15 weeks |
| Phase 7 — ongoing | Forever | Forever |

---

## 8. Stop-the-line conditions

Pause and reassess if any of these happen:

- **Phase 0 stretches beyond 1 week.** Something is wrong with the refactor approach; back up and simplify.
- **Phase 3 training never beats `IdleBot`.** Pipeline is broken, not a tuning problem. Don't move forward.
- **Phase 4 win rate vs scripted bots plateaus below 60% after 20M steps.** Action space, reward, or observation needs rework — don't throw more compute at it.
- **Bot's "interesting" behaviour turns out to be exploiting a simulation bug** (e.g. dealing damage through walls, infinite resource glitch). Fix the bug; don't let the bot keep the win.
- **(2026-05-23 update) An architectural change runs for >2× its planned budget without breaking through.** Both Option B (action-masking) and Option γ (RND) hit this. The lesson: when you find yourself adding the third or fourth tweak to a failing approach, the approach itself is wrong.

---

## 9. Open questions to revisit

These don't block starting work, but they'll need decisions later:

- **Exact action sub-tree contents** — the trees in §5 Phase 2 are a starting sketch. Refine before coding.
- **Passive win threshold** — start at 10,000, but tune via human playtests *before* the bot starts training against it.
- **Episode length cap** — what's the maximum tick count for a training match? (Recommend 6000 ticks = 10 min real-time = ~6 seconds compute.)
- **How many sub-tiers of "Hard"?** — just one, or several?
- **Replay retention policy** — keep all replays forever? Just the interesting ones? Prune by date?
- **What does "live game" version-compatibility mean?** — if `gameBalance.ts` changes, older replays may not play back identically. Add a `version` field to replay format; warn on mismatch. (Versioned balance history added during v0.3.2-ML ship.)
- **Is there a future for asymmetric features** (e.g. different starting positions, terrain variations)? — keep the door open in observation format but don't implement yet.
- **(2026-05-23) What replaces Option B/γ for v0.4.0-ML?** — Option α (hierarchical), curriculum redesign that builds positive train_unit gradient first, or accept the v0.3.2-ML ceiling. Awaiting decision.

---

## 10. Resources to learn from

A short curated list of materials that will serve this project specifically:

- **CleanRL PPO** — https://github.com/vwxyzjn/cleanrl — single-file PPO implementation, read it cover-to-cover before writing your own.
- **OpenAI Five blog posts** — overview of how a real multi-agent RTS-like bot was built. Skim for vocabulary.
- **OpenAI hide-and-seek paper** — useful for inspiration but their environment differs substantially from yours.
- **AlphaStar Nature paper** — the architecture (set-transformer + auto-regressive action head + league training) is what we're roughly modelling.
- **PettingZoo docs** — the multi-agent Gym variant.
- **Hugging Face Deep RL course** — free, well-paced, covers PPO with practical examples.
- **Random Network Distillation (Burda et al., 2018)** — https://arxiv.org/abs/1810.12894 — the basis of the Option γ implementation. Useful even though it didn't work here.
- **CrystalFront_ML_Review.md** — three independent technical reviews of the project. The third review (§B5) is the source of the Option α/β/γ taxonomy.

---

## 11. Immediate next step (historical)

> *Original text from 2026-05-14, preserved for context.* Begin **Phase 0, Task 1**: add `Rng` class and plumb it through `MatchState`. Verify with a "run the same seed twice, hash final state, assert equal" test. Everything downstream depends on this.

**Current next step (2026-05-23):** See `Current handoff state` at the top of this document.

---

## 12. Development diary — chronological (oldest first)

A running log of meaningful milestones, decisions, and pivots. Read top-to-bottom for the full arc.

---

### 2026-05-14 — Planning document finalised

Original ML_BOT_ACTION_PLAN.md written. 6-phase plan: Phase 0 (engine refactors) → Phase 1 (headless + scripted bots) → Phase 2 (obs/action/reward specs) → Phase 3 (Python harness) → Phase 4 (league training) → Phase 5 (replay tools) → Phase 6 (production ONNX integration).

---

### 2026-05-14 — Phases 0–3 implemented (status as of 2026-05-18)

**Phase 0 — Engine refactors:**
- ✅ `Rng` class (mulberry32, seedable) — `server/src/match/engine/rng.ts`
- ✅ `IdGen` class (monotonic counter) — `server/src/match/engine/idGen.ts`
- ✅ `LiveMatchRunner` split from `MatchEngine` — `server/src/match/liveMatchRunner.ts`
- ✅ `commandLog` added to match state (replay system foundation)
- ✅ `replayRunner.ts` for server-side replay playback
- ✅ `matchEngine.ts` split: engine/combat.ts, gathering.ts, movement.ts, repair.ts, utils.ts, visibility.ts
- ✅ Determinism test added: same seed × 500 ticks → identical state hash (391 tests passing)
- ✅ `randomUUID()` removed — IdGen used throughout
- ❌ Legacy aliases in `gameBalance.ts` not removed (low priority)
- ❌ Duplicate type definitions not resolved (low priority)

**Phase 1 — Headless + scripted bots (complete + exceeded):**
- ✅ `headless/` workspace, `runMatch.ts`, CLI tool
- ✅ `observation.ts`, `actionSpace.ts`, `legalActions.ts`, `actionIndex.ts`
- ✅ `IdleBot`, `RushBot`, `TurtleBot`, `MacroBot`, `HeavyBot`, `WeakRushBot`, `MediumRushBot`, `PassiveBot`
- ✅ `BotPlayer` in-process driver; difficulty selector in lobby UI
- ✅ Replay saving (seed + command log → JSON)
- ✅ Server-side pagination in replay browser (30/page, filter/sort to `/api/replays`)
- ✅ Scrub bar fixed to show full game length
- ✅ Training replays suppressed (`--save_replay_every 0`)

**Phase 2 — Specs (complete):**
- ✅ `docs/CRYSTALFRONT_OBS_SPEC.md`, `docs/CRYSTALFRONT_ACTION_SPEC.md`, `docs/CRYSTALFRONT_REWARD_SPEC.md`
- ✅ 391 passing tests (added determinism test)

**Phase 3 — Python training harness (complete):**
- ✅ `training/env/crystalfront_env.py` (Gymnasium wrapper, 60 parallel Node sims)
- ✅ `training/ppo/train.py` (CleanRL-style PPO, TensorBoard, action histograms, checkpoint save/load)
- ✅ `training/ppo/policy.py` (Set-transformer, entity attention, global concat, legal-action masking)
- ✅ ROCm/CUDA GPU training confirmed working

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

### 2026-05-16 — v0.1.58-ML: Skirmisher→turret counter fix + rush_medium phase 2

**Analysis of v0.1.57 Phase 1:** Agent won 100% vs idle/turtle in mixed curriculum (67% of games were free wins). Achieved 3% win rate vs rush_weak — combat was irrelevant to the gradient. Fixed by switching to 100% rush_medium.

**Changes:** Skirmisher→turret counter multiplier corrected from 1.0× to 2.0× (turrets now use "gunner" counter as defenders, matching existing logic). This prevents turret-spam as a hard counter to skirmisher rushes, forcing the agent to use actual combat units.

**Results:** Agent initially tried attacking (week 1), then decided it was "not worth it" and reverted to turtling. 0% win rate throughout. The attack-then-retreat pattern confirmed the credit-assignment problem more than action-space issues.

---

### 2026-05-17 — React error #185 fixed

React "Maximum update depth exceeded" (error #185) traced to all `useCallback` hooks in `App.tsx` depending on `[ws]` — the entire WebSocket context object, which is a new plain object literal on every 10 Hz render. Fixed by using stable method references (`[ws.createLobby]`, `[ws.sendGameCommand]`, etc.). Also fixed `setHoverPos` in `GameShell.tsx` creating unnecessary new objects on every mouse move.

---

### 2026-05-17 — v0.1.59-ML: Gamma + milestone-timing fix

**Changes:** gamma 0.99 → 0.995 (doubles effective horizon, ~100→~200 ticks). Barracks milestone fires on **build start** (entity appears) instead of completion — brings the +0.5–2.5 reward 150 ticks closer to the actual decision. Resumed from v0.1.58 checkpoint.

**Results:** 651 updates, 20M steps. ep_rew moved positive (+0.5 to +2.0 typical, was negative in v0.1.58). ep_len locked at ~1800 throughout. **0% win rate**. Two outlier episodes (ep_rew 8.30 and 5.41, ep_len 2000+) showed occasional better survival but did not reproduce as a trend. The gamma fix worked mechanically but couldn't overcome the fundamental missing-win-trajectory problem.

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

**Training:** PID 417005, `/tmp/train_v60.log`, resumed from v0.1.59 final checkpoint. 20M steps vs passive_bot.

**Success criterion:** First `win_rate > 0` in the log. If not seen in 5M steps vs passive_bot, escalate to behaviour-cloning warmup.

---

### 2026-05-17 — Replay browser + scrub bar improvements

**Server-side pagination:** Replay browser rewritten to send `page/pageSize/sort/asc/winner/winType/bot/flags/starred` to `/api/replays`. Was fetching all 500+ replays on every render. Now defaults to 30/page.

**Scrub bar fix:** Previously used `replayBufferSize` as the max — scrub bar only filled in as the replay downloaded. Fixed to use `replayTotalTicks - 1` as the constant max. Seeking beyond the buffered portion clamps to `Math.min(target, bufferSize - 1)`.

**Economy win reward:** Changed from `+winType === "resource" ? 0 : +30` to `winType === "resource" ? -30 : +30` — economy wins now score same as losses, removing the second local minimum.

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

### 2026-05-18 — v0.1.62–v0.1.64: Diagnosing trn=1% and mining domination

**v0.1.62 — startingResources fix:** At startingResources=50, `build_barracks` (costs 75) was **illegal at tick 0**. Only `train_worker` (50) was legal. So "trn=1%" was 100% worker training, not skirmisher training. Fixed to 200.

**v0.1.63–64 — mining reward poisoning:** `miningDelta × 0.000025` accumulated to **+150/episode** for full gathering, completely dominating all combat signals. Agent learned to mine, not fight. Cut to 0.000001 (25×).

Also discovered: `attack_move` only selects combat units via `getUnitGroup("all_combat")`. Workers assigned to gathering nodes never walk toward the enemy crystal regardless of map width. Map-width reduction (v0.1.63: 6000→2000→500px) was irrelevant for workers.

**Final diagnosis:** Workers can't attack via macro actions. Need pre-placed combat units (Phase A).

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

### 2026-05-18 — v0.1.66-ML: Phase B v1 — full chain attempt (failed)

**Removed all scaffolding** (no pre-placed skirmishers, no pre-placed barracks). Agent must build barracks + train + attack from scratch.

**Results:** Loaded from Phase A (0.1.65-ML) checkpoint. bld=73-79%, trn=0%, win_rate collapsed 0.40→0.04 in 4 updates. Root causes: (1) build zone bug — barracks builds all failing; (2) Phase A policy had atk_mv=40% but no combat units to move; (3) ent_coef=0.04 too low to explore new behaviors.

---

### 2026-05-18 — v0.1.67-ML: Phase B v2 — pre-placed barracks ✅ 100% win rate

**Problem (Phase B v1):** Removing pre-placed skirmishers AND requiring barracks build was too large a jump. Agent converged to bld=78%, trn=0%, win_rate→0.04 within 4 updates.

**Fix:** Pre-place a **completed barracks** at (250, 300) in `stdioRunner.ts`. Agent only needs to discover `train_skirmisher → attack_move`. Build chain comes in Phase C.

**Results:** win_rate=1.00 from update 3. ep_len declined 574→389 as policy tightened. atk_mv=43%, tgt=14%, bld=2%, trn=1%. Saved checkpoint at update_000010.

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

### 2026-05-18 — v0.1.70-ML / v0.1.71-ML: Phase C v3/v4 — resource starvation fix

**Another diagnosis:** With `startingResources=200`, the agent could build 3 buildings in the first 3 ticks (barracks=75, depot=50, foundry=100 = 225 > 200), drain all resources, pull all workers to build sites (no gathering), leaving resources=0 when barracks completes → `train_skirmisher` (costs 50) **ILLEGAL**.

**Fix (v0.1.71):** `startingResources: 200 → 500`. Even after a 3-building spree, 275 resources remain when barracks completes. Also from scratch with `ent_coef=0.10` (was 0.04).

**Results (v71):** win_rate=0.75 at update 8 (trn=1%!) — resources fix helped briefly. Then collapsed. Build zone bug was still silently failing ~2/3 of builds.

---

### 2026-05-18 — v0.1.72-ML: Phase C v5 — barracks-only builds (wrong diagnosis)

**Hypothesis:** 12 bld variants (barracks/foundry/depot/turret × 3 zones) vs 4 train variants → bld gets 3× probability mass regardless of reward. Restricted build legal mask to barracks only (3 variants).

Added `phaseLegal()` filter in `stdioRunner.ts` that removes `build` actions except `build_barracks`. This also ensured bld probability never exceeded 3/10 of actions.

**Results:** bld=62-69%, trn=0% throughout. **Build zone bug was still present — all barracks builds were still silently failing.** The filter was correct but masked the real problem.

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

### 2026-05-18 — v0.1.74-ML: Phase C v7 — first_combat_unit +50, barracks-idle ×5

**Problem:** v6 reached win_rate=0.82 at update 7 but collapsed to 0.01 by update 35. Root cause: policy gradient for `bld` actions (25% of episode, +2.5 immediate reward) overwhelmed gradient for `trn` (1% of episode, +10 delayed ~100 ticks). Expected value of "build + train" was only marginally better than "build only".

**Changes:**
- `hasTrainedCombatUnit` milestone: +10 → **+50** (discounted at gamma^100 ≈ +30.5, vs bld's +2.5)
- Barracks-idle trickle penalty: -0.003/tick → **-0.015/tick**
- Expected value: build+train = +33, build-without-train = +1.9 (a 17× gap)

**Results:** win_rate oscillated 20–86% over 63 updates in 12-update cycles. Pattern: agent discovers train→attack (trn=1%, ep_rew=106), V(s) updates high, future A(train) becomes negative, trn falls to 0%, V(s) corrects, cycle repeats. Never converged. Best checkpoint at update 10 (win_rate=86%) used as seed for v8.

---

### 2026-05-18 — v0.1.75-ML: Phase C v8 — locking in the winning policy

**Status:** Running (PID 522611, `/tmp/train_v75.log`)

**Strategy:** Resume from the Phase C v7 `update_000010.pt` checkpoint (the peak policy: win_rate=86%, bld=17%, trn=1%) with `ent_coef=0.03`. The high-entropy v7 run discovered and then lost the winning strategy every ~12 updates due to value-function lag. Low entropy should lock the policy in place once it finds the chain.

**Also fixed in this version:**
- All 4 `package.json` files now bumped together (previous versions only bumped root — client/server/shared were stuck at 0.1.56-ML, live site showed wrong version)
- Training runs now started with `--save_replay_every 0` — no more broken 1000px map replays polluting the replay browser
- Site deployed and verified at 0.1.75-ML

---

### 2026-05-18 — v0.1.75-ML: Phase C v8 — oscillation analysis + passive_bot diagnosis

**Training status (PID 522611, `/tmp/train_v75.log`):**
```
update=  8 | win_rate=0.77 | ep_len=3000 | ep_rew= 31 | bld=34% trn=0%
update= 15 | win_rate=0.37 | ep_len=3000 | ep_rew= 35 | bld=51% trn=0%
update= 21 | win_rate=0.67 | ep_len=1185 | ep_rew=104 | bld=37% trn=0%
```
Same ~12-update oscillation cycle as v74. ent_coef=0.03 did not stop the V(s) lag cycle.

**Passive_bot geometry diagnosis:** Ran a test match — passive_bot DOES build a barracks at (900, 380) and trains 2 skirmishers with autoAttackEnabled=true. However, the skirmishers sit at (871, 359) and (866, 391), offset in y from the blue workers' approach vector (y≈300). Workers walking at y=300 toward the crystal at (900, 300) may slip past the skirmishers (60–90px offset in y) without triggering auto-attack. This partly explains wins with trn=0%.

**Root of oscillation (V(s) lag):** Policy at peak had A(train_unit) > 0, wins at 86%. After PPO update, V(s) rises to ~106. Next batch: A(train_unit) = R_train_onward − V(s) ≈ 40 − 106 = **−66** (negative). Policy pushes away from train_unit. trn→0%, win rate drops. V(s) corrects to ~35. A(train_unit) becomes positive again. Cycle repeats every ~12 updates.

**Next steps to break the cycle:**
1. Fix passive_bot skirmisher positioning to block the y=250–350 worker corridor
2. Reduce `hasTrainedCombatUnit` back to +15 — the +50 spike is causing V(s) overshoot
3. Per-unit reward instead of one-shot: +2.0 every time a NEW combat unit appears (capped 5/ep)

---

### 2026-05-18 — v0.2.0-ML: Major reset — course-corrected reward function, Phase 0 begins

**Version bump rationale:** Fresh start to reflect the complete reward function overhaul. Previous versions (0.1.x-ML) used fundamentally broken reward shaping — a +50 first_combat_unit spike that caused V(s) oscillation, passive army-ownership trickles that rewarded doing nothing, and ±30 terminal rewards that could be offset by accumulated shaping. All now corrected.

**Key reward function changes (vs 0.1.75-ML):**
- Terminal rewards: ±30 → **±100** (combat win / all losses)
- Shaping clamp: none → **clamp(total_shaping, −20, +20)** at episode end
- `first_combat_unit` milestone: +50 → **+2** (was causing V(s) overshoot)
- Standing force trickle (+0.005×army): **removed** (passive ownership reward)
- Crystal damage per HP: +0.005 → **+0.01** (doubled)
- Own crystal damage penalty: −0.002 → **−0.003**
- Barracks-idle trickle: −0.015 → **−0.003** (was too punitive before barracks economy)
- New milestones: army reaches 3 units (+2.0), enemy quarter entry (+3.0)
- Crystal depth milestones: +1/+2/+5 → **+3/+5/+8**
- First crystal hit: +3 → **+5**
- Removed passive signals: gathering workers trickle, supply advantage, survival reward, friendly-vs-enemy presence, forward scout trickle
- Added 3 anti-passivity penalties (army idle with advantage, no crystal pressure, late-game no-damage)

**Game config reverted to full defaults:**
- Map: 6000×600px (was 1000px training map)
- Crystal HP: 1000 (was 100)
- Max ticks: 6000 (was 3000)
- Starting resources: 50 (was 500)
- passiveWinThreshold: 4500 (was 999999)

**Training setup:**
- PID: 554458, log: `/tmp/train_v76.log`
- Phase 0: `idle` opponent
- 60 parallel envs, ent_coef=0.05, gamma=0.995
- Starting from scratch — no checkpoint (reward function incompatible with all prior runs)

This run plus v0.2.1 produced the first wins via resource accumulation (u36–u42 ep_rew slowly improving) but exposed the approaching-reward exploit which dominated late-run behaviour.

---

### 2026-05-19 — v0.2.2-ML: Remove approaching reward + idle penalties, fix barracks milestone, add foundry milestone

**Context:** v0.2.1-ML confirmed exploitation of approaching reward (+0.0003/unit/tick). Removed it plus idle_worker_penalty and supply_headroom_waste to eliminate worker spam loop. Barracks milestone changed from time-decaying `1.5×max(0,(600-tick)/600)` to flat +3.0 (time-decay gave 0 reward when barracks built after tick 600). Added foundry milestone +2.0. Reverted to num_steps=512 (same as successful 0.1.xx runs). Resumed from v0.2.1-ML update_000075.

**Training config:** PID 615692, run `crystalfront_ppo__0_2_2-ML__idle__1__1779144843`. ~651 updates total.

**Phase 0 verdict: FAILED**

| Criterion | Target | Final | Result |
|-----------|--------|-------|--------|
| cbt | ≥ 0.85 | 0.00 | ❌ |
| crys_dmg | > 0% | 0% | ❌ |
| tmt | ≤ 0.10 | 1.00 | ❌ |
| no_pres | ≤ 0.10 | 100% | ❌ |

**Post-mortem:** The run completed all 651 updates (20M steps) without a single episode of crystal damage, no combat wins, and a 100% timeout rate. The policy converged fully to a bad local optimum by update 165 and never recovered.

**Root cause (confirmed):**

Two interacting problems created an unescapable local optimum:

1. **`attack_move enemy_army` falls back to midfield.** When no enemy combat units are visible, `resolveTargetZone("enemy_army")` returns `{ x: mid, y: MAP.height/2 }`. Against IdleBot, this means every `enemy_army` attack_move resolves to the exact centre of the map. The agent learned to use this action heavily.

2. **`hasForwardUnit` threshold xNorm > 0.45 creates a midfield attractor.** The anti-passivity army-idle penalty fires when `ownCombat >= 3` and no unit has `xNorm > 0.45`. A unit parked at xNorm ≈ 0.46–0.49 satisfies this check (avoiding the -0.002/tick penalty) but falls short of the midfield milestone threshold (xNorm > 0.50) and of the enemy quarter milestone (xNorm > 0.75). Forward progression milestones (+3 midfield, +3 enemy quarter, +5 crystal hit) were NEVER triggered in the entire 20M step run.

Result: ep_rew stabilised at ~-95 = -100 terminal + ~+9 milestone shaping - ~-4 anti-passivity.

**Fixes carried forward to v0.2.3-ML:**

1. `actionSpace.ts`: Change `enemy_army` fallback from midfield → enemy_crystal.
2. `stdioRunner.ts`: Raise `hasForwardUnit` threshold from xNorm > 0.45 → xNorm > 0.65.

---

### 2026-05-19 — v0.2.3-ML: STOPPED at u235 — worker spam exploitation

**Training config:** PID 676184, run `crystalfront_ppo__0_2_3-ML__idle__1__1779184406`. Fresh start. Killed at update 235/651 after replay analysis confirmed the failure mode.

**Changes from v0.2.2-ML (all carried forward to v0.2.4):**
- `actionSpace.ts`: `enemy_army` fallback midfield → enemy crystal position
- All 3 anti-passivity penalties removed
- Cross-midfield and enemy-quarter milestone rewards removed (tracking only)
- Added: damage-dealt reward — `0.1 × healthFrac_delta` for units/workers, `0.05` for buildings
- Added: own building damage penalty — `−0.04 × healthFrac_delta`
- Added: map visibility reward — `visibleAreaFraction × 0.001` per tick
- Worker kill: +0.15 → +0.20; own crystal damage: −0.003 → −0.01 per HP
- Action space: 58 → 66 (targeting_friend, spread_fire × 4 groups)

**Failure analysis:** ep_rew pinned at exactly −120.00 for all 235 updates. Replay analysis showed every episode: 127–168 `train_worker`, 56–65 `build:supply_depot`, 2–4 `build:turret`, zero barracks, zero combat units.

Root cause:
1. **attack_move is gated on combat units** — `legalActions.ts` only adds attack_move to the legal mask when `combatUnits.length > 0`. Since the agent never trained a combat unit, ALL attack actions were permanently illegal.
2. **Wrong-building-first + defenseless penalties hit the shaping clamp floor** — building depots before barracks costs −0.003/tick (−18/ep), no-barracks defenseless costs −0.002/tick (−11/ep) = −29/ep raw. The ±20 clamp flattened this to −20 regardless of how many depots were built, removing all marginal gradient.
3. **Map visibility reward** was incidentally boosting the worker spam.

---

### 2026-05-19 — v0.2.4-ML: Remove shaping clamp, barracks +5, worker movement actions

**Training config:** PID 681602, run `crystalfront_ppo__0_2_4-ML__idle__1__1779193049`. Fresh start — action space 66→71 incompatible.

**Changes from v0.2.3-ML:**
- Shaping clamp (±20) fully removed — agent now feels full magnitude of all decisions in both directions. Terminal (±100) still dominates.
- Barracks milestone: +3.0 → +5.0
- Added: worker movement actions — `attack_move × all_workers × 5 zones` (indices 66–70). Workers can now be explicitly sent to enemy_crystal, midfield, contested_node, enemy_army, defend_crystal.
- Action space: 66 → 71

**Result:** Plateau at ~-95 ep_rew. Zone oscillation exploit fully converged. Workers bouncing between x=300/3000/5900 every 2-3 ticks for entire episode.

---

### 2026-05-20 — v0.2.6-ML: Block worker→crystal/building attack, 10× time penalty, diminishing unit rewards

**Training config:** PID 692048, run `crystalfront_ppo__0_2_6-ML__idle__1__1779229732`. Fresh start. num_steps=512, num_envs=60, total_timesteps=20M, ent_coef=0.10.

**Changes from v0.2.5-ML:**
- Engine fix (`combat.ts`): workers cannot auto-attack crystals or buildings. Can still fight enemy workers and retaliate against combat units.
- Time penalty: −0.00005/tick → **−0.0005/tick** (10×)
- Combat unit training reward: replaced +2.0 (first unit) + +2.0 (3 units) with diminishing per-unit: **+1.0, +0.8, +0.6, +0.4, +0.2**, then 0

**Phase 0 verdict: FAILED — but best run yet, actively improving at completion**

| Criterion | Target | Final | Result |
|-----------|--------|-------|--------|
| cbt | ≥ 0.85 | 0.09 | ❌ |
| crys_dmg consistently >0% | yes | ✅ from u317 | ✅ |
| tmt | ≤ 0.10 | 0.91 | ❌ |
| no_pres | ≤ 0.10 | 0.90 | ❌ |

**What worked:**
- Cancel penalty eliminated worker oscillation immediately (wkr_mv=0% from u47)
- Worker crystal attack blocked — all crys_dmg now from combat units
- Genuine barracks→combat unit→crystal damage chain discovered by u317
- Final trend: crys_dmg 2%→9%, win_rate 3%→9%, no_pres 100%→88% — all improving at termination

**What held it back:** atk_mv=0% throughout entire run — agent never used explicit attack_move commands. The cancel penalty trained the agent to NOT issue attack_move, even though a single uncommitted attack_move on idle units has zero cancel cost.

---

### 2026-05-20 — v0.2.8-ML: Training pipeline optimisation — all report recommendations implemented

**Context:** Following completion of the v0.2.7-ML run, an independent hardware profiling pass identified that the training loop was CPU-bound on a single Python thread while the GPU (RX 7900 XTX) sat at 18% utilisation.

**Hardware reality (measured):**
- Container has 12 vCPUs (not 28 as documented — host limits the cgroup)
- GPU at 18% busy, 4/24 GB VRAM used during v0.2.7-ML
- Python trainer pegged at 100% on one core; 122 Node processes fighting for 12 vCPUs
- Rollout had 1,536 GPU→CPU syncs per rollout

**Changes implemented (commit a0d5d07):**

*Infrastructure:*
- **`headless/src/stdioVecRunner.ts`** (new): N games per Node process with autoreset. Uses pre-compiled `headless/dist/stdioVecRunner.js` — no tsx overhead at runtime.
- **`training/env/crystalfront_vec_env.py`** (new): Python wrapper around the vec runner. One `CrystalFrontVecEnv(vec_size=4)` runs 4 games via one Node process.
- Subprocess count: 122 → 7 (5 vec procs × 4 games + server + tensorboard)

*GPU utilisation:*
- **GPU rollout buffer**: `RolloutBuffer` now holds all tensors on device.
- **No per-tick GPU sync**: `logprobs_t` and `values_t` stored directly on device.
- **GAE on GPU**: T-step loop over `(E,)` GPU tensors.
- **bf16 autocast**: policy inference and PPO update wrapped in `torch.autocast(dtype=bfloat16)`.
- **`torch.compile(reduce-overhead)`**: reduces kernel-launch overhead.

*CPU/Python overhead:*
- **`orjson`** for JSON encode/decode.
- **`np.bincount`** for action histograms.
- ROCm env vars: `PYTORCH_TUNABLEOP_ENABLED=1`, `MIOPEN_FIND_MODE=FAST`, `HSA_OVERRIDE_GFX_VERSION=11.0.0`.

*Hyperparameters:*
- `num_envs`: 60 → **20** (right-sized for 12 vCPUs)
- `num_steps`: 512 → **1536** (better GAE horizon over 6000-tick episodes)
- `num_minibatches`: 4 → **6**
- `mlp_hidden`: 256 → **384**
- Batch size preserved: 30,720

**Observed before/after:**
| Metric | v0.2.7-ML | v0.2.8-ML | Change |
|--------|-----------|-----------|--------|
| GPU busy | 18% | 98% | +80pp |
| Node procs | 122 | 7 | −94% |

---

### 2026-05-20 — v0.2.10-ML: Reward overhaul — worker exploit removal + building incentives

**Versions covered:** v0.2.8-ML (pipeline), v0.2.9-ML (exploit fix), v0.2.10-ML (building rewards)

**Context:** After the pipeline optimisation (v0.2.8), three successive reward problems were discovered and fixed through replay analysis. v0.2.9 and v0.2.10 address the root cause of the agent never building a barracks.

#### Problem 1 — Worker-swarm exploit (diagnosed in v0.2.8-ML)

Replay analysis revealed the agent was training 100+ workers, spamming them at the enemy base with `toggle_auto_attack`, and farming continuous kill/damage rewards from worker-vs-worker fights. This generated 50–100+ shaping reward per episode, completely dominating the one-time +5 barracks milestone.

**Fix (v0.2.9-ML):** Gated all kill/damage rewards on `ownCombatCurrCount > 0`. Workers can still fight but generate zero kill/damage reward unless at least one own combat unit is on the field.

#### Problem 2 — Noop local optimum (diagnosed in v0.2.9-ML)

After removing the worker-swarm exploit, the agent converged to 99% noop by update 79. Replay analysis showed it was doing almost nothing.

Root cause: the −100 terminal is a fixed unavoidable cost for an agent that hasn't learned to win. With V(s) ≈ −100 everywhere, the policy optimises shaping only — and the shaping optimum with kill/damage blocked is "do nothing".

**Fix (v0.2.10-ML):** Added per-tick bonuses for completed barracks and foundry buildings with diminishing returns capping at 3 of each:
```
Barracks: 1st +0.005/tick, 2nd +0.004/tick, 3rd +0.003/tick (cap)
Foundry:  1st +0.002/tick, 2nd +0.0015/tick, 3rd +0.001/tick (cap)
```

Max combined: +0.0165/tick → ~+94 per episode for 3× barracks + 3× foundry from tick ~300.

#### Engine fix — movement.ts + combat.ts (v0.2.8-ML)

Workers sent to `attack_move enemy_crystal` were permanently "committed" (never idle) because they all targeted the crystal's center point (single pixel) and collision resolution prevented any from reaching within 1px. Fixed in two places:

- `movement.ts`: Units complete movement when within attack range of any crystal/building at their target position.
- `combat.ts`: Attack chase now clears `moveTarget` when unit is already in attack range.

---

### 2026-05-20 — v0.3.0-ML: Independent technical review + methodology overhaul

**Status:** Infrastructure changes complete, training not started.

An independent technical review of the full project history identified the root cause of 35+ days without beating IdleBot: shaping-reward whack-a-mole combined with premature abandonment of the curriculum. Key findings:

- The credit-assignment gap is the core problem. At gamma=0.995, the +100 win terminal is discounted to ~7×10⁻⁸ by the time the agent decides to build barracks. PPO literally cannot see the win signal from the build decision.
- The reward function grew to 20+ components totalling ~150 max shaping per episode — 1.5× the terminal magnitude. The agent can lose every game and net positive reward.
- The per-tick building bonus added in v0.2.10 is the same "standing force trickle" trap that was removed in v0.2.0, just in different clothing.
- MAP.width was hardcoded in 15+ places in headless/src/ — any small-map curriculum config would silently break observations and actions.
- The reward function was duplicated between stdioRunner.ts and stdioVecRunner.ts, causing silent drift.

**Changes made (v0.3.0-ML):**

1. **MAP.width fix** — All MAP.width/height hardcodes in observation.js, actionSpace.js, legalActions.js replaced with match.config.mapWidth/mapHeight. Small-map curriculum stages now work correctly.

2. **Reward extraction + simplification** — Created `headless/src/reward.ts` as single source of truth. Reward simplified to exactly 6 components:
   - Terminal: ±100
   - Crystal damage dealt: +5 × healthFrac_delta
   - Crystal damage taken: -2 × healthFrac_delta
   - First barracks built: +10 (one-time)
   - First combat unit trained: +5 (one-time)
   - Time penalty: -0.001/tick
   - Max achievable shaping ≈ +14 (well below ±100 terminal)

3. **LR schedule bug fix** — Checkpoint resume now restores the update counter so the LR anneal schedule continues from the correct position.

4. **MatchConfig pass-through** — mapWidth, crystalHealth, startingResources, max_ticks are now configurable via CLI and passed through to the Node engine.

5. **Curriculum stages** — 8-stage curriculum (0c → 4) defined in train.py. Stages auto-promote on win_rate ≥ threshold and auto-regress when stuck.

6. **ep_ret logging** — The console print now shows both ep_rew (with shaping) and ep_ret (terminal-only), making shaping-hacking immediately visible.

7. **bc_pretrain.py** — Behaviour cloning script. Run ~500 episodes of rush-weighted random play, train policy with cross-entropy for 3 epochs, save bc_warmup.pt.

8. **eval_checkpoint.py** — Checkpoint evaluator. Loads any .pt file and plays N deterministic matches vs each scripted bot.

---

### 2026-05-21 — v0.3.1-ML: Behaviour cloning + curriculum training — first wins on real game map

**Status:** Curriculum reached stage 3b (full 6000px map vs MediumRush). BC being retrained on full game config. Restarting.

#### Methodology

The fundamental insight: **PPO alone cannot solve a task where the win signal is 3000+ ticks away from the first decision.** At gamma=0.995, the terminal reward is discounted to near-zero by the time the early build decisions are made. Shaping rewards don't fix this — they just create new exploits. The correct approach is:

1. **Behaviour cloning (BC) warmup** — pre-train the policy on expert demonstrations to start PPO from a state where wins are already occurring.
2. **Fine-grained curriculum** — start from a task so easy that the BC policy wins immediately, then remove one scaffold at a time until reaching full difficulty.

The critical design rule for both: **one variable at a time.**

#### BC warmup — iterations and lessons

**BC v1 (failed — data quality):** Trained on "rush-weighted random" policy. The data was 95% noop, training achieved 95% accuracy, greedy policy got 0% wins.

**BC v2 (failed — wrong map config):** Switched to real RushBot demo mode. Added 5% noop subsampling. Achieved 63-70% accuracy. Still 0% greedy wins. Root cause: training data was on default 6000px map but PPO ran on 1500px stages.

**BC v3 (partial fix — correct map, missing critic):** Retrained on 1500px/200HP map. 70.4% accuracy. 0% greedy wins, but PPO from BC immediately collapsed to noop=99% within 10 updates. Root cause: **the critic head starts randomly initialised**. Noisy value estimates → noisy advantages → policy gradient overwrites the BC actor prior within ~10 PPO updates.

**BC v4 (working):** Added two additional fixes on top of v3:
1. **Critic pretraining** — after actor BC training, train the critic head with MSE on discounted returns from the demonstration episodes.
2. **Don't load BC optimizer state into PPO** — BC trains at lr=1e-3 with cross-entropy objective. Loading that Adam momentum into PPO (lr=3e-4, RL objective) caused the first PPO gradient steps to fight the BC momentum.

With these fixes: PPO from BC achieved **6% wins at update 10** on Day 5 config — the first wins ever from an unscaffolded start.

**BC v5 (current, full game config):** Retraining on **default full game config (6000px/1000HP/50 resources)** to maximise generalization across all curriculum stages.

**BC design rules learned:**
- Use real bot demonstrations (not weighted random sampling)
- Subsample noop transitions to ~50% of dataset (5% noop keep rate)
- Train on the same map config as the target PPO stage, OR use the full game config for generalization
- Always pretrain the critic on discounted returns from demonstrations
- Never restore the BC optimizer state into PPO — create a fresh Adam optimizer

#### Curriculum design — progressive scaffolding

**Final working curriculum (v0.3.1):**

| Stage | Map | Crystal HP | Start resources | Opponent | Threshold |
|-------|-----|-----------|-----------------|----------|-----------|
| day5 | 1500px | 200HP | 50 | idle | 50% |
| 1a | 1500px | 100HP | 50 | idle | 70% |
| 1b | 1500px | 100HP | 50 | passive | 70% |
| 2a | 3000px | 300HP | 50 | passive | 70% |
| 2a5 | 3000px | 300HP | **200** | **rush_weak** | 50% |
| 2a6 | 3000px | 300HP | **75** | rush_weak | 50% |
| 2b | 3000px | 300HP | 50 | rush_weak | 50% |
| 3a | **6000px** | **1000HP** | 50 | passive | 70% |
| 3a5 | 6000px | 1000HP | **200** | **rush_medium** | 50% |
| 3b | 6000px | 1000HP | 50 | rush_medium | 50% |
| 4 | 6000px | 1000HP | 50 | league | 60% |

**Key insight — the resource slider for active opponents:** Passive opponents can be beaten with a pure rush. The first time an active opponent (rush_weak) was introduced, the policy converged to "send workers toward enemy crystal" because the value function had learned "units near enemy crystal = high value" from passive stages, but without combat units there was nothing useful to do there.

The fix: introduce the active opponent with enough starting resources (200) that the agent can build barracks and train a skirmisher **before the opponent's units arrive**. This teaches the agent that building+training beats rushing with workers. Then progressively reduce starting resources: 200 → 75 → 50, each step forcing the agent to gather slightly more before building.

#### Training progress

**Run 1 (day5 breakthrough):** Starting from BC v4 warmup, `ent_coef=0.02`, stage `day5`:
- Update 10: **6% wins** — first wins from unscaffolded start
- Update 19: **65% wins** → promoted to 1a
- Update 28: **71% wins** on 1a → promoted to 1b
- Update 35: **96% wins** on 1b (vs passive) → promoted to 2a
- Update 44: **90% wins** on 2a → promoted to 2b

Stages day5→2a cleared in ~1.35M steps. 2b (rush_weak/50 resources) failed at 5-20%.

**2b solution (resource slider):** Adding 2a5 (rush_weak/200 resources) and 2a6 (rush_weak/75 resources) as intermediates:
- 2a5: cleared at 55-93% wins with `bld=5-6%` emerging
- 2a6: cleared at 65% wins
- **2b: cleared at 69% wins** — first time beating rush_weak with full resource chain

After 2b, the curriculum accelerated through:
- 3a (6000px/passive): **100% wins**
- 3b (6000px/rush_medium): entered, same bottleneck as 2b (trn=0%, crys_dmg=3-7%)

**Total stages cleared in ~3M steps (from BC warmup):** day5, 1a, 1b, 2a, 2a5, 2a6, 2b, 3a — first time on real game map.

#### Key failure modes encountered and fixes

**Noop attractor (every stage transition):** Policy converges to noop whenever the task becomes too hard. Fix: smaller steps in the curriculum, sufficient BC prior.

**Worker-move attractor:** Value function sends workers toward the crystal (useless) when scaffolding is removed. Fix: don't use pre-placed unit scaffolding; use the resource slider.

**trn=0% against active opponents:** Policy learns "rush attack" and never trains defensive combat units. Fix: introduce opponent with starting_resources=200.

**BC prior collapse after 10 PPO updates:** Random critic → noisy advantages → actor prior overwritten by noise. Fix: pretrain critic on demonstration returns.

**BC optimizer fighting PPO:** Adam momentum from BC loaded into PPO causes gradient fights. Fix: skip optimizer state restore for BC checkpoints.

---

### 2026-05-21 — v0.3.2-ML: Full curriculum run — BC v5 + 0a→0b direct chain

**Status (as of ~4.9M steps):** Stage 3a5 (full-size map, rush_medium/200 resources). 13 stages cleared.

#### Key change from v0.3.1: 0a→0b direct chain

The 0a5 intermediate stage (single pre-placed skirmisher) was removed. The review's curriculum design goes 0a (Phase A: 2 pre-placed skirmishers) → 0b (Phase B: no scaffolding) directly, with 0b inheriting 0a's full value function.

Previous attempts with 0a5 failed: the single skirmisher couldn't beat IdleBot workers in a damage race, and the value function received contradictory signals about whether units near the enemy crystal were good or bad. Removing 0a5 gave 0b a clean value function.

#### Training run — full stage log

PID 791519, started from BC v5 warmup (1000 episodes, full game config).

| Stage | Map | Opponent | Win% (at promote) | Update | Steps |
|-------|-----|----------|-------------------|--------|-------|
| 0a | 800px | idle | 87% | u11 | 312k |
| 0b | 800px | idle | 83% | u52 | 1.57M |
| 0b5 | 800px | idle | 71% | u90 | 2.76M |
| 0c | 800px | idle | 78% | u97 | 2.95M |
| day5 | 1500px | idle | 96% | u103 | 3.16M |
| 1a | 1500px | idle | 100% | u109 | 3.34M |
| 1b | 1500px | passive | 99% | u116 | 3.55M |
| 2a | 3000px | passive | 100% | u125 | 3.82M |
| 2a5 | 3000px | rush_weak | 75% | u134 | 4.09M |
| 2a6 | 3000px | rush_weak | 91% | u143 | 4.37M |
| 2b | 3000px | rush_weak | 93% | u152 | 4.64M |
| 3a | full | passive | 100% | u160 | 4.90M |
| **3a5** | full | **rush_medium** | — | — | — |

**Notable observations:**
- `wkr_mv=0%` at every single stage — the wkr_mv attractor never formed.
- `trn=0%` persists throughout — the agent never trains additional combat units. It wins via pure first-skirmisher rush.
- Stages day5 through 3a all cleared in exactly 1 evaluation window (first measurement after entering stage).
- `atk_mv` climbed from 12% to 45% over the run. `noop` dropped from 86% to 53%.

**Open question:** `trn=0%` bottleneck against rush_medium on full map. The agent has never needed to train a second unit. Stage 3a5 and 3b are the first tests where a single skirmisher may not be sufficient.

---

### 2026-05-22 — v0.3.2-ML: SHIPPED — ML bot live in production

**Status:** ✅ Deployed and verified. First live human vs ML bot game played successfully (commit `da072a9`).

#### What was shipped

The Option A ship plan was completed in full:

- **Checkpoint:** `update_000150.pt` (not u200 as planned — u200 was degraded by 40 updates of 0% rush_medium stall during a failed 3a curriculum attempt after the training run in the section above)
- **ONNX export:** `training/export_onnx.py` using the dynamo exporter. Produces two files: `policy-v0.3.2-ML.onnx` + `policy-v0.3.2-ML.onnx.data` (~1.3 MB total). The `_OnnxWrapper` module flattens the forward signature to `(g, e, em, n, nm) -> (logits, value)` so ONNX can trace it.
- **MlBot TypeScript:** `headless/src/bots/mlBot.ts` — implements `Agent` interface, loads ONNX via `onnxruntime-node`. Async inference with 1-tick lag pattern (return `lastAction` immediately, update on `.then()`).
- **Server integration:** `MlBot.create()` called once at server startup; `createBotAgent()` factory function routes bot name strings to instances.
- **Client:** `BotSelectMenu.tsx` — separate screen (not inline panel) with MACHINE LEARNING and SCRIPTED sections. Accessible from main menu via "Play vs Bot" button.
- **Replays:** All matches (PvP and vs-bot) now saved with both player usernames and outcome.

**Empirical win-rates (100 deterministic episodes, full 6000px map, u150 checkpoint):**

| Opponent | Win rate |
|----------|----------|
| idle | 100% |
| passive | 100% |
| rush_weak | 86% |
| rush_weak_medium | 99% |
| rush_medium | 0% |
| rush | 1% |
| turtle | 0% |
| macro | 99% |

Intended tier: **easy/medium** — beats passive and weak-rush reliably, loses to full-strength rush and turtle.

#### Critical bugs found and fixed during implementation

**1. xNorm mirroring (ML bot doing nothing)**

Policy was trained exclusively as BLUE (left side, low xNorm). When the bot plays RED in a live match, the xNorm coordinates are flipped. Without mirroring, the policy receives an observation that looks like it is playing from the wrong side of the map and makes no coherent actions.

Fix in `headless/src/bots/mlBot.ts::_buildFeeds()`:
```typescript
const mx = this.isRed ? (x: number) => 1 - x : (x: number) => x;
entityArr[base + 2] = mx(e.xNorm ?? 0);   // index 2: xNorm
nodeArr[base + 0]   = mx(nd.xNorm ?? 0);  // index 0: xNorm
```

`isRed` is detected in `init()` by looking up the player's color in `match.players`. The `.ts` file is what `tsx` loads at runtime — initially the fix was only applied to the compiled `.js` dist file, which was used by the verification script but not the live server. Both files must stay in sync.

**2. Replay playback showing no gameplay (bluePlayerId field typo)**

`saveReplay()` in `server/src/index.ts` called `bluePlayer?.playerId` and `redPlayer?.playerId`. The `Player` interface only has `.id`, not `.playerId`. The field was always `undefined`, so the fallback `"headless-blue"` / `"headless-red"` always fired. The replay runner then created a match with those literal IDs, but the `commandLog` stored real UUID playerIds — every `processCommand` call was silently rejected.

Fix: `bluePlayer?.id` / `redPlayer?.id`.

**3. Replay playback showing no gameplay (ReplayMeta interface missing fields)**

`bluePlayerId` and `redPlayerId` were stored in the JSON on disk correctly, but `getReplay()` constructed its return object field-by-field from the parsed JSON. Fields not declared in the `ReplayMeta` interface were dropped on return.

Fix: added `bluePlayerId?: string` and `redPlayerId?: string` to `ReplayMeta`, `listReplays()`, and `getReplay()`.

**4. START_BOT_GAME blank screen**

`GameShell` only renders when `ws.lobbyState` is populated. The `START_BOT_GAME` handler was sending `MATCH_START` without first sending a `LOBBY_STATE` message.

Fix: added `broadcastLobbyState(ws, code)` before `sendWS(ws, { type: MATCH_START ... })`.

#### Verification

12 new round-trip tests added to `tests/index.ts` covering:
- `saveReplay()` → `listReplays()` → `getReplay()` round-trip with UUID playerIds preserved
- `commandLog` playerIds match stored `bluePlayerId`/`redPlayerId`
- `outcome.winner` preserved as color string ("blue"/"red"), not username

All 443 tests passing at ship.

---

### 2026-05-22 — v0.4.0-ML Option B: action-masking forcing — attempted and exhausted

**Status:** Implemented and exhausted. All forcing variants (Mode A, Mode B, Variant β', threshold tuning) produced the same regression at 3a_rm_3k.

#### Pre-flight diagnostic (§2.3)

`training/diagnose_policy.py` written and run on u150 against rush_weak_medium and rush_medium. The diagnostic recorded per-episode action histograms (train_unit count, max_noop_streak, outcome).

| Opponent | Win rate | train_unit/ep mean | train_unit/ep max | max_noop_streak mean |
|----------|----------|---------------------|--------------------|----------------------|
| rush_weak_medium | 99% | 9.4 | 13 | 400 ticks (max 662) |
| rush_medium | 0% | 13.2 | 17 | 337 ticks (max 440) |

**Key finding:** `trn=0%` in training logs is a rounding artefact — `int(0.3%) = 0`. The policy actively trains 9–17 units per episode in eval. The problem is timing and noop streak overhead, not train_unit frequency.

CSVs saved to `docs/diag_u150_rwm.csv` and `docs/diag_u150_rm.csv`.

#### Implementation (§2.4)

`headless/src/legalActions.ts` extended with `LegalActionsOpts`:

```typescript
export interface LegalActionsOpts {
  noopStreak?: number;
  trainUnitStreak?: number;  // Variant β' trigger
  forcingScale?: number;     // 0.0 = off, 1.0 = always force when conditions met
}
```

Two forcing modes:
- **Mode A** (noop_streak trigger): `noopStreak >= 30 && !anyBarracks && idleWorker && resources >= barracks.cost` → suppress noop. Forces the bot to build a barracks early in the opening.
- **Mode B (Variant β')** (trainUnitStreak trigger): `trainUnitStreak >= 50 && completedBarracks >= 1 && combatUnits < 3 && resources >= 50` → suppress noop AND attack_move. Forces the bot to train a third unit while two pre-placed skirmishers are still alive.

`stdioVecRunner.ts` tracks both streak counters per slot, reads `ACTION_FORCING_SCALE` from the `reset_all` protocol message, and supports mid-training fade via `set_forcing_scale`. `crystalfront_vec_env.py` plumbs the scalar through to the runner. `train.py` gains `--action_forcing_scale`, `--action_forcing_fade_start`, `--action_forcing_fade_end` flags with linear fade schedule.

8 forcing logic tests added (461 total tests passing).

#### Smoke test result (§2.5)

| Update | Stage | Win rate | noop% | trn% | Notes |
|--------|-------|----------|-------|------|-------|
| 160 | 3a_rwm | 90% | 54% | 0% | Forcing active; promoted immediately |
| 171 | 3a_rm_3k | **25%** | **44%** | 0% | Gate PASSED — noop dropped 10pp |
| 183 | 3a_rm_3k | 1% | 53% | 0% | Regression — pre-placed advantage wore off |
| 195 | 3a_rm_3k | 0% | 53% | 0% | Stall |

G3' gate (win_rate ≥ 20%) PASSED at u171, then regression. Diagnosed: Mode B fires only after pre-placed skirmishers die (the `combatUnits < 2` check); by then the barracks isn't built yet. Mode A added to force early barracks build.

#### Iteration log

Six configurations attempted; all produced the same 0-6% steady-state at 3a_rm_3k:

| Variant | Change | Result |
|---------|--------|--------|
| noop_streak ≥ 30, combatUnits < 2 | Original spec | Streak rarely reaches 30 (attack_move resets it). 0% wins. |
| trainUnitStreak ≥ 200, combatUnits < 2 | Variant β': different streak counter | Fires too rarely. 0% wins. |
| trainUnitStreak ≥ 200, combatUnits < 3 | Threshold raised so it fires while 2 pre-placed units alive | trn=1% appears briefly. 1-3% wins. |
| trainUnitStreak ≥ 200 + suppress attack_move | Mode B Variant β'' | trn=1% stable. 1-3% wins, no upward trend. |
| Extended rewards (+2 unit 3, +1 unit 4) | Provide positive shaping to counteract forced-training negative gradient | ep_rew improves -97 → -84. Win rate still 1-3%. |
| trainUnitStreak ≥ 50 (from u300) | Reduced threshold 4× + restart from later checkpoint | trn=1% durable across 50+ updates. **noop stabilises 43-45%.** Win rate 1-3%. |

#### Root cause analysis (catastrophic forgetting)

After 90 updates of training at 3a_rm_3k under various forcing configurations, the u350 checkpoint can no longer beat **passive**. Forcing-induced episodes ending in -100 terminal trained the policy that even basic build-and-attack play correlates with losing. The action-masking approach is exhausted.

**v0.3.2-ML (u150 ship checkpoint) is unaffected.** The forcing code path is gated by `forcingScale > 0`; the production model and its eval results pre-date all v0.4.0-ML training.

---

### 2026-05-23 — v0.4.0-ML Option γ: RND intrinsic motivation — implemented, ran, failed, halted

**Status:** Implemented as the §2.9 escalation from the failed Option B attempt. One full 15M-step training run completed. Decision gate technically passed at u312 (15% win rate) but did not sustain — collapsed to 0-2% with noop rising to 68%.

Commits: `d2f3c58` (RND implementation), `c783d54` (calibration findings).

#### Implementation

`training/ppo/policy.py` — added `RunningMeanStd` (Welford online estimator for obs/reward normalisation) and `RNDModel`:

```python
class RNDModel(nn.Module):
    def __init__(self, obs_dim: int = 22, embed_dim: int = 64):
        self.obs_rms = RunningMeanStd(shape=(obs_dim,))
        self.rew_rms = RunningMeanStd(shape=())
        # Target: fixed random weights, 2-layer
        self.target = _mlp(obs_dim, embed_dim, embed_dim)
        for p in self.target.parameters():
            p.requires_grad_(False)
            nn.init.orthogonal_(p) if p.dim() >= 2 else nn.init.zeros_(p)
        # Predictor: trained, 3-layer
        self.predictor = _mlp(obs_dim, embed_dim, embed_dim, embed_dim)

    def intrinsic_reward(self, global_obs):
        o = self._norm_obs(global_obs)
        with torch.no_grad():
            t = self.target(o)
        p = self.predictor(o)
        return ((p - t) ** 2).mean(dim=-1)  # (B,)
```

`training/ppo/train.py`:
- CLI flags: `--rnd_coef 0.0`, `--rnd_embed_dim 64`
- Per-step intrinsic reward added to rewards before buffer write
- Separate optimizer for predictor; trained after PPO epochs on full rollout batch
- RND state dict saved/restored in checkpoints under `"rnd"` key
- Logging: `rnd/predictor_loss`, `rnd/intrinsic_reward_mean`, `rnd=X.XXXX` in print line

#### Calibration findings

- `rnd_coef=0.01` provides only **+0.001/step** — completely buried by ±100 terminal.
- `rnd_coef=0.5` provides **+0.06–0.29/novel step** (~+5–17 per episode if 50–100 novel states visited). Meaningful but still small relative to terminal.
- **RND alone fails.** Policy never visits novel states (p(train_unit) ≈ 0 due to forcing requirement), so the intrinsic reward never fires. Must combine RND with Variant β' forcing: forcing mechanically samples train_unit → reaches novel multi-unit state → RND rewards that state.

#### Run config

PID 101428, log `/tmp/train_v040_rnd05.log`:
- `rnd_coef=0.5, action_forcing_scale=1.0, ent_coef=0.05`
- Curriculum stage 14 (3a_rm_3k)
- Checkpoint: u150
- `total_timesteps=15M` (~10M new env steps from u150)

#### Decision gate result (auto-regression at ~u300)

| Update | Stage | Win rate | noop | RND loss | Outcome |
|--------|-------|----------|------|----------|---------|
| u300 | 3a_rwm (regress) | 92% | 56% | 0.064 | Healthy on weaker opponent |
| u312 | 3a_rm_3k (re-entry) | **15%** | 47% | 0.043 | **Gate PASSED (≥10%)** |
| u324 | 3a_rm_3k | 0% | 52% | 0.047 | Regression |
| u336 | 3a_rm_3k | 0% | 51% | 0.037 | Stall |
| u347 | 3a_rm_3k | 1% | 51% | 0.036 | Stall |
| u355 | 3a_rm_3k | 0% | **62%** | 0.027 | **noop rising** |
| u363 | 3a_rm_3k | 0% | 65% | 0.021 | noop rising |
| u394 | 3a_rm_3k | 0% | 68% | 0.012 | noop peaked |
| u431 | 3a_rm_3k | 1% | 64% | 0.010 | Auto-regress to 3a_rwm |
| u440–u483 | 3a_rwm | 10–28% | 64–68% | 0.04 | Stuck on weaker stage |

Training ended at u483 with budget exhausted, still on 3a_rwm.

#### Failure mode

The damning signal: **noop rose monotonically from 47% (u312) to 68% (u394)** at 3a_rm_3k. The policy responded to forcing pressure not by training more units, but by retreating to states where forcing conditions can't trigger.

The brief 15% at u312 was likely two pre-placed skirmishers still alive (no learned behaviour change). When they died, no replacement units → no crystal pressure → loss. The intrinsic reward decayed to 0.01 (background noise) as the predictor learned the high-noop equilibrium states.

#### Why RND didn't rescue this

- Forcing was supposed to mechanically visit novel states.
- RND was supposed to reward those states enough to pull the policy toward them.
- Net per-episode incentive for "train units then lose": `−100 (terminal) + 11 (unit milestones) + ~6 (RND novelty) = −83`
- Per-episode for "noop and lose": `−100 (terminal) + 0 (no milestones) + 0 (familiar states, RND ~0) = −100`
- 17-point advantage for trying. **Not enough** — the gradient noise from a 17-point delta in a ±100 terminal regime is dwarfed by the persistent negative signal from `train_unit → lose`.

The problem is **gradient sign**, not exploration. No amount of intrinsic reward can correct a policy that has correctly learned `train_unit` correlates with losing in this matchup. The correction must come from winning trajectories — which neither forcing nor RND produces.

---

### 2026-05-23 — v0.4.0-ML attempt halted + documentation update

After Option B and Option γ both failed against rush_medium, the user decided to halt v0.4.0-ML research and document the state for handoff. This entry.

**What was halted:**
- No further training runs of any kind.
- v0.4.0-ML code remains merged on `CrystalFront-ML` but all entry points default-off (`forcingScale=0`, `rnd_coef=0`).
- v0.3.2-ML (u150) remains the production model.

**Documentation updates this session:**
- `docs/ML_BOT_ACTION_PLAN.md` — reorganised chronologically + handoff section at top (this update).
- `docs/ML_AGENT.md` — rewritten as pure technical reference with v0.4.0-ML modules (RND, action-forcing) documented; current reward spec from `headless/src/reward.ts`.
- `docs/SHIPPING_AND_V040_PLAN.md` — deleted. Its forward-looking content (§2.9 fallbacks, commands, file refs) consolidated into this document's handoff section and into `ML_AGENT.md`. Its Option A/B/γ historical narrative is now in the diary entries above. The file was a snapshot of an active plan; with the plan halted and outcomes documented inline, it became duplicate.
- `memory/project_v040_rnd.md` — terminal outcome recorded.

**Decisions outstanding for the next session:**
1. **Option α (hierarchical)** — separate "what to train" policy via imitation learning. Estimated 3–5 weeks, no guarantee of success. Closest to addressing root cause.
2. **Curriculum redesign** — start training in a regime where multi-unit play causes wins (e.g., scripted opponent that *requires* 3 defending units to beat). Build positive `train_unit` gradient first; then transfer to rush_medium.
3. **Accept v0.3.2-ML ceiling** — ship as-is. The bot beats passive/weak-rush reliably; the rush_medium loss is a known limitation documented in release notes.

The fallback options are documented in the **Current handoff state** section at the top of this file. The third-review architectural taxonomy (Option α / β / γ) is in `CrystalFront_ML_Review.md` at the repo root.

---

*End of diary. The next entry should be either an architectural decision (Option α / redesign / accept) or a clean rebase to start fresh on v0.4.0-ML.*

---

### 2026-06-09 — v0.5.0-ML Phase 0: Repair the instrument

**What was done:**

Phase 0 of the revival plan (`docs/REVIVAL_PLAN.md`) was executed in full. Seven tasks completed on branch `CrystalFront-ML`, all in separate commits per R7.

| Task | What | Commits |
|---|---|---|
| 0.1+v | Persist cfgOverrides across autoreset; bump to v0.5.0-ML | `4ff901b` |
| 0.2 | Config-persistence regression test | `4ff901b` |
| 0.3 | Config-aware observation/actionSpace/legalActions | `efad5cc` |
| 0.4 | MacroBot crash fix + try/catch wrapper | `508494f` |
| 0.5 | build:headless script + dist staleness guard | `d63ada9` |
| 0.6 | Action table regenerated from code; ML_AGENT.md §3 rewritten | `e357843` |
| 0.7 | Deprecation comments on LegalActionsOpts/RNDModel | `2a99765` |

**What was observed:**

- `test_config_persistence.py`: PASS — overrides persisted across 120 steps, 2 episodes/slot. xNorm on 800px map reached >0.5 after Task 0.3 (was <0.14 before).
- `npm test`: 461/0 throughout all tasks.
- `test_env.py`: PASS.
- MacroBot: 5/5 matches vs rush_medium completed without crashes (all losses, expected pre-balance).
- Staleness guard: correctly raised RuntimeError after touching legalActions.ts; cleared after rebuild.

**What was decided and why:**

- The "gradient sign" root cause from the previous handoff was a symptom. The actual root causes were: autoreset bug (explains why curriculum config was never applied), game balance (explains why the gate was impossible), and MDP formulation (explains why even correctly-configured training couldn't learn). These were all independent of gradient-sign.
- All three fixes are in the code now. The environment can be trusted for the first time.
- `docs/ML_AGENT.md` §3.1 was wrong — it documented y-zones and set_rally that don't exist in actionIndex.ts. Replaced with generated table. Previous diary conclusions about specific curriculum stages (e.g. "the resource slider worked") are unreliable because the stage config was never applied on autoreset.

**Historical conclusions now invalidated:**

- All curriculum stage-clear percentages in the diary (sections 12, entries before 2026-06-09) — they were measured with the autoreset config bug active, meaning every episode after the first per slot ran on 6000px/1000HP/50-res regardless of stage.
- The "resource slider worked" observation from v0.3.1-ML — the resource override may have applied to the first episode per slot but not subsequent ones.
- Option B/γ failure analysis — these approaches ran on the wrong config. They might or might not have worked on correct config; we will never know.

---

### Reflections — Phase 0

**(a) Did results match the plan's predictions?**

Yes. All 7 tasks completed as specified. The xNorm test (a soft check in test_config_persistence.py) confirmed that Task 0.3 made observations config-aware — entities reached xNorm>0.5 on the 800px test map after the fix. MacroBot crashes were confirmed to be caused by the undeclared `barracksYZones` fields as predicted. No surprises.

**(b) Does any later phase need adjusting?**

No changes needed to Phases 1–3 based on Phase 0 findings. The esbuild-based `build:headless` script works correctly but uses a different invocation than the plan's tsconfig.build.json suggestion — `tsconfig.build.json` fails due to rootDir cross-package constraints. This was documented in Task 0.5's commit. The plan's command cheat sheet at Appendix A still says `npm run build:headless` which is correct.

**(c) What would you tell the next agent NOT to waste time on?**

- Do not try `tsc -p headless/tsconfig.build.json` — it fails on rootDir constraints because headless imports from server/ and shared/ via relative paths. Use `npm run build:headless` (esbuild) instead.
- Do not trust historical curriculum clear rates — see invalidated conclusions above.
- Do not activate the RND or action-forcing modules — they're marked @deprecated and were not tested post-bugfix.
- Phase 1 balance work MUST precede training. Even with Phase 0 fixes, training against rush_medium will still fail until turtle/macro can beat it (acceptance criterion 2 in REVIVAL_PLAN.md §1.3).

---

### 2026-06-09 — v0.5.1-ML Phase 1: Balance the game

**What was done:**

Phase 1 of the revival plan (`docs/REVIVAL_PLAN.md`) executed on branch `CrystalFront-ML`. Tasks 1.1–1.4 completed, plus two undocumented bugs found and fixed.

| Task | What | Commits |
|---|---|---|
| 1.1 | 9-bot balance harness (`SCRIPTED_BOTS` expanded); `balance:matrix` npm script | `[prior session]` |
| 1.2 | Engine timeout tiebreaker (maxTicks in MatchConfig; deterministic crystal HP → lifetimeResources → slot 0) | `3bdf097` |
| 1.2b | `runMatch.ts` bug: maxTicks not forwarded to match config → tiebreaker never fired from CLI | `865d32b` |
| 1.3 | Iteration 1 balance: worker cost 50→35, turret HP 400→600, cooldown 12→8, COUNTER_MODIFIER 2.0/0.5→1.5/0.75 | `0ec33be` |
| 1.4 | Timeout win tracking in `balance_report.py` flags | `9591324` |

**Bugs found (not in plan):**

1. **`runMatch.ts` missing maxTicks wiring** — The engine tiebreaker (`Phase 3.6` in `matchEngine.ts`) fires correctly when `match.config.maxTicks` is set. But `runMatch.ts` constructed the match with `DEFAULT_CONFIG` (no maxTicks), then used a local variable to cap the loop. The tiebreaker never fired from the CLI path; games hit the tick cap and returned `winner=null` (draw). Fixed by `const matchConfig = { ...config, maxTicks }` before `createMatch()`. The unit tests passed because they set maxTicks directly in the config; only the CLI/balance_report path was broken.

**Iteration 1 balance rationale:**

| Lever | Before | After | Why |
|---|---|---|---|
| Worker cost | 50 | 35 | Economy shouldn't be a 1:1 sacrifice of military. Cheaper workers let turtle/macro build economy while still able to train units. |
| Turret HP | 400 | 600 | Turrets died to 7 skirmishers in ~48 ticks. Defence must hold long enough to matter. |
| Turret attack cooldown | 12 | 8 | DPS 1.5 → 2.25. Turret must be worth building; otherwise turtle never wins. |
| COUNTER_MODIFIER | 2.0 / 0.5 | 1.5 / 0.75 | 4× swing (2.0 vs 0.5) made fights binary. Counter-favoured units instawin. Softer multipliers preserve the RPS flavour without making unit composition hopeless when wrong. |

**Balance matrix (iteration 1, 20 matches/pair):**

*(Matrix pending — running as of this writing. Will be committed to `docs/balance/matrix_iter1_v0.5.1.json` and summarised here.)*

**Acceptance criteria check:**

*(To be updated when matrix completes.)*

**Draft release notes (player-facing changes in v0.5.1-ML):**

- Workers are cheaper (50 → 35). Growing your economy is now less of a hard trade-off against military production.
- Turrets are significantly stronger (HP 400→600, DPS +50%). Defensive builds are more viable.
- Combat counters are softer (ratio 2.0/0.5 → 1.5/0.75). Mixed compositions fight more evenly.
- Matches that reach the tick limit now always have a winner (higher crystal HP wins; equal HP → higher total resources gathered → blue wins). No more draws.

---

### Reflections — Phase 1

**(a) Did results match the plan's predictions?**

Partially. The balance changes themselves were straightforward. The unexpected finding was the `runMatch.ts` bug: the engine tiebreaker (Task 1.2) required a second fix in `runMatch.ts` because the config path was disconnected. Unit tests passed because they constructed matches with the config directly; only the CLI/balance_report path was broken. This is a common "integration gap" — unit tests bypass the integration layer.

**(b) Does any later phase need adjusting?**

No changes needed to Phases 2–3 based on Phase 1 findings. The balance may require further iterations (Task 1.3 is iterative); see acceptance criteria.

**(c) What would you tell the next agent NOT to waste time on?**

- Do not run a balance matrix before confirming the tiebreaker works end-to-end via CLI (`python3 training/balance_report.py --matches 5 --blue macro --red turtle` — check that `win_rate > 0` and `timeout` flags are ≤ half of matches rather than 100%).
- The runMatch.ts fix is committed. Don't revert it or "simplify" it away — the `matchConfig = { ...config, maxTicks }` line is load-bearing.
- If balance criteria still fail after iteration 1, try `MediumRushBot.FIRST_PUSH_TICK 200→300` before touching crystal regen (engine change, requires tests).

---

### 2026-06-10 — v0.5.2-ML Phase 1: Iteration 2 (engine determinism fixes + balance tuning)

**What was done:**

Continuing Task 1.3 (balance tuning loop) from the 2026-06-09 entry. Three commits on `CrystalFront-ML`:

| Commit | What |
|---|---|
| `b6604d4` | Fix pre-existing broken test: "Counter Damage Multipliers" still asserted the old 2.0x ratio after `0ec33be` changed `COUNTER_MODIFIER.skirmisher.gunner` to 1.5. `npm test` was red at HEAD before this fix, unrelated to this session's work. |
| `3b4852f` | Five engine determinism fixes (see below). |
| `f376905` | Iteration 2 balance changes (see table below). |

**Engine determinism fixes (`3b4852f`):**

These were investigated as "deep archaeology" into the rush_medium mirror-match bias (criterion 4: Blue WR 0.73, 22-8-0 over 30 seeds). All five are independently-correct fixes for real (if previously latent) determinism/symmetry bugs, regardless of their effect on criterion 4:

1. **Action-order alternation** (`headless/src/runMatch.ts`, carried from the 2026-06-09 session) — bot actions for player 0/1 now alternate which acts first per tick, instead of player 0 always acting first.
2. **Gathering tick-parity tie-break** (`server/src/match/engine/gathering.ts`, carried from the 2026-06-09 session) — resource-node gather-slot contention now alternates by tick parity instead of always favouring the lower entity id.
3. **Seeded-coinflip tiebreaker** (`server/src/match/matchEngine.ts`, carried from the 2026-06-09 session; `types.ts` `result.winType` union widened to include `"timeout"`) — the Phase 3.6 timeout tiebreaker's final fallback (fully equal crystal HP and lifetimeResources) now picks the winner via `match.seed % 2` instead of always slot 0 (blue). A fixed "slot 0 wins" rule gave blue ~90-100% WR in mirror matches that time out, which is the common case for symmetric bots.
4. **ID-comparison fix** (`server/src/match/engine/utils.ts` new `entityIdNum()`, used in `movement.ts`'s collision-pair dedup) — entity ids like `"e10"` sort lexicographically before `"e9"`, so the old `other.id <= entity.id` check broke symmetric collision-pair ordering once the id counter passed 9. Now compares numeric suffixes.
5. **Per-player RNG streams** (`types.ts` `rng: Rng` → `rng: [Rng, Rng]`; `matchEngine.ts` `createMatch`/`resetMatch`/`train_worker`/`processConstruction`) — spawn-position randomization for one player's units no longer consumes from a shared RNG stream whose draw order depends on the other player's entity-Map insertion order. Each player slot now has its own seeded stream (`seed` and `seed ^ 0x9e3779b9`).

**Iteration 2 balance changes (`f376905`):**

| Lever | Before | After | Why |
|---|---|---|---|
| `UNIT_DEFS.skirmisher.cost` | 50 | **60** | Rush needs more resources to mass; gives defenders more time to build up. |
| `UNIT_DEFS.skirmisher.speed` | 3.0 | **2.0** | Slower raiders give defenders more reaction time. |
| `BUILDING_DEFS.turret.cost` | 60 | **50** | Cheaper turrets help defenders build up faster. |
| `BUILDING_DEFS.turret.attackCooldown` | 8 | **6** | dps 1.5 → 2.25 → 3.0 (was 12 before iteration 1); defence needs to hold. |

**What was observed:**

- 30-seed batch of `rush_medium` vs `rush_medium` mirror matches (criterion 4) before AND after fixes #4-5: **identical** aggregate result, Blue WR 0.73 (22-8-0). Both fixes are individually correct and address real symmetry bugs, but neither moved the aggregate win rate by even one match.
- Target-acquisition tie investigation in `combat.ts` (temporarily instrumented, then fully reverted — no diff vs HEAD): for seed=1, the number of ties in the nearest-target selection loop was **0/0/0** across the whole match. Ruled out as a contributing factor.
- `npm test`: 466/0 after `b6604d4` in isolation, and again after `3b4852f` and `f376905` stacked on top.

**What was decided and why:**

- Two independent, principled symmetry fixes (#4 and #5 above) producing byte-identical aggregate outcomes over 30 seeds means the rush_medium mirror bias is **deterministic**, not an artifact of RNG draw order, entity-id comparison ordering, or action-processing order. Something else — currently unknown — gives one mirrored copy of `rush_medium` a structural ~70/30 edge over its identical twin.
- Per the user's explicit choice (of a 3-way tradeoff: decisive-margin tiebreaker / continue archaeology / commit-and-defer), **criterion 4 is deferred** as a documented known limitation. The 5 determinism fixes are committed regardless, because each is independently correct (real latent bugs, just not THE bug behind criterion 4).
- Further root-cause work on criterion 4 should NOT repeat the RNG-stream or id-comparison angles — both are now fixed and proven not to be the cause. A more promising untried angle: a full tick-by-tick state-divergence trace between the two mirrored players from t=0, looking for the first tick at which their derived state differs despite symmetric initial conditions and inputs.

**Acceptance criteria check (iteration 2, vs the 2026-06-09 iteration-1 entry):**

| # | Criterion | Status |
|---|---|---|
| 1 | Every bot loses ≥20% to at least one other | not yet retested under v0.5.2-ML |
| 2 | turtle AND macro each beat rush_medium ≥30% | not yet retested under v0.5.2-ML |
| 3 | rush_medium beats rush_weak_medium ≥60% | not yet retested under v0.5.2-ML |
| 4 | Mirror matches (rush_medium/rush_weak/macro) within 40-60% per side | **DEFERRED** — rush_medium mirror measured 73/27 (22-8-0/30 seeds) both before and after the 5 determinism fixes; root cause unknown, see above |
| 5 | Timeout-tiebreak games <30% per pairing | not yet retested under v0.5.2-ML |

Criteria 1, 2, 3, 5 need a fresh 20-match matrix under v0.5.2-ML (iteration-2 levers) before they can be marked. This is the next session's first task.

**Draft release notes (v0.5.2-ML, additive to the 2026-06-09 draft):**

- Skirmishers cost more (50→60) and move slower (3.0→2.0 px/substep) — rushes are slower to mass and easier to react to.
- Turrets are cheaper (60→50) but fire faster (cooldown 8→6, dps 2.25→3.0) — defensive turtling is cheaper to set up and hits harder.
- Matches that reach the tick limit with fully-tied crystal HP and resources now resolve via a seeded coin flip (`match.seed % 2`) instead of always favouring blue.

---

### Reflections — Phase 1, addendum (iteration 2)

**(c) What would you tell the next agent NOT to waste time on?** *(addendum to the 2026-06-09 entry)*

- Don't re-investigate RNG draw order or entity-id lexicographic comparison for the rush_medium mirror bias — both are fixed in `3b4852f` and proven to have zero effect on the aggregate 73/27 split.
- Don't re-run the target-acquisition tie count in `combat.ts` — confirmed 0/0/0 for seed=1; not the cause.
- Criterion 4 is a known limitation as of v0.5.2-ML. Don't block the rest of Phase 1 (criteria 1/2/3/5, full matrix) on resolving it.

---

### 2026-06-10 — v0.5.2-ML Phase 1: Iteration 3 (mirror-invariance property-test infrastructure, Appendix C experiment 4)

**What was done:**

Continuing Task 1.3's criterion-4 investigation (Appendix C). Built the mirror-invariance property test (`server/src/match/engine/mirror.ts`: `mirrorState`, `deepCloneMatchState`, `diffStates`/`MirrorDiff` — Case-B mirror: x-reflect all positions/moveTargets/rallyPoints/resourceNodes and swap player slots 0/1 including `economy`/`rng`; entity ids/`ownerId`/`idGen`/`seed`/`tick` untouched), plus four audit scripts (`headless/src/mirrorAudit.ts`, `_mirrorAudit2.ts`, `_buildPosAudit.ts`, `_initStateAudit.ts`, `_matrixAudit.ts`) and a permanent regression test added to `tests/index.ts` (1500-tick `tick(mirror(s)) ≈ mirror(tick(s))` check at `eps=0.5`, asserted on every `npm test` run going forward). Exported `chooseBuildPosition` from `headless/src/actionSpace.ts` (was module-private) so it could be audited directly — this is the only source change, and it's a no-op (export visibility only).

**What was observed:**

- Initial state is perfectly mirror-symmetric (C.1 #13) — rules out an initial-condition asymmetry.
- `tick()` itself is mirror-invariant for a full 6000-tick match except a bounded ≤0.5px movement-position drift (H4, C.1 #14), root-caused to the soft-collision-resolution loop's neighbour-cell iteration order reversing under x-mirroring. Confirmed via an eps sweep {1e-6, 0.05, 0.5}: zero diffs anywhere at eps=0.5, never cascades to combat/gathering/construction/result. **H4 closed as confirmed-minor/noise-floor.**
- `chooseBuildPosition`'s 16-attempt fallback `dx` is unmirrored (H5, previously found in C.1 #12); the `dxSign = isBlue ? 1 : -1` fix is now property-test-proven exactly correct — 0/9 zone-combo violations over 6000 ticks (vs violations in 5/9 combos, including at tick 0, before the fix) (C.1 #15).
- Re-ran the 30-seed rush_medium-mirror matrix WITH the H5 fix applied: **10-20-0 (blue 33%, red 67%)** — byte-identical to the earlier C.1 #12 probe (C.1 #16). Since `tick()` and `chooseBuildPosition` are now BOTH proven mirror-equivariant (mod the 0.5px H4 noise floor) and the matrix is *still* skewed, **H6 ("≥1 more asymmetry exists") is upgraded from hypothesis to proven fact**, by elimination.
- `npm test`: 467/0 (the new mirror-invariance test is the +1).

**What was decided and why:**

- The H5 fix (`dxSign = isBlue ? 1 : -1`) was applied during the experiment, verified property-clean, then **reverted** — per C.4, landing it alone would *regress* criterion 4 from 73/27-blue to 67/33-red. `actionSpace.ts`'s only remaining diff is the `export` keyword (zero behaviour change). `headless/dist` was rebuilt (`npm run build:headless`) to clear the staleness guard for the new/changed `headless/src/*.ts` files — `headless/dist` is gitignored/untracked, so nothing to commit there.
- No version bump (R1 doesn't apply — no training/reward/config/balance change landed; this is test infrastructure + a no-op export + docs).
- New leading hypothesis **H7**: the remaining asymmetry lives in the bot-DECISION layer (`MediumRushBot.step()`, `buildObservation()`, or `resolveTargetZone`/`resolveAttackTarget`/`findNode` in `actionSpace.ts`) — code that decides *when/whether/what* to act, not *where*. These look symmetric by inspection but are untested by the new property tests. **C.3 #7** (next step) extends the harness to two bots run in lockstep from t=0 — one driving `s`, one driving `mirrorState(s)` — asserting `action(mirror-bot, mirrorState(s)) ≈ mirror(action(other-color-bot, s))` at every tick, to localise the first action-level divergence. Once H7 is found, land H5+H7 together with one 30-seed-per-pairing matrix re-run across rush_medium/rush_weak/macro (C.4).

**What would you tell the next agent NOT to waste time on?**

- Don't re-derive the H5 fix (`dxSign = isBlue ? 1 : -1` in `actionSpace.ts`'s `chooseBuildPosition` fallback) — it's correct and property-test-proven (C.1 #15), just blocked on H7.
- Don't re-run the engine-tick or `chooseBuildPosition` mirror-equivariance audits — both are now permanently covered (`tests/index.ts` for tick-level; `_buildPosAudit.ts` available for ad-hoc re-checks if `actionSpace.ts` changes).
- Don't chase H4 (collision-resolution iteration-order noise) further — confirmed bounded ≤0.5px, never cascades, closed.

---

### 2026-06-10 — v0.5.2-ML Phase 1: Iteration 4 (C.3 #7 first pass: bot-decision-layer audit, H7 still open)

**What was done:**

Continuing the H7 search (bot-decision layer asymmetry, C.3 #7). Built three diagnostic scripts:

- `headless/src/_directSymmetryAudit.ts`: on a real rush_medium mirror match (no `mirrorState` involved), checks at every tick whether `resolveTargetZone(zone, "blue", match, ids) ≈ mirrorPos(resolveTargetZone(zone, "red", match, ids))` for all 5 zones, and `findNode(match, playerId, choice, ownCrystal) ≈ mirrorPos(...)` for all 3 node choices.
- `headless/src/_stateDivergenceAudit.ts`: tracks own-side scalar observation features (resources, supply, type counts, action JSON) for blue vs red every tick — these should be IDENTICAL while no asymmetry has acted, since both start from C.1 #13's mirror-symmetric init. Reports the first tick of divergence.
- `headless/src/_gatherTrace.ts`: per-tick trace of worker counts/positions/gather-node assignments/`accumulatedGather`, used to root-cause the divergence found above.

Exported `resolveTargetZone` and `findNode` from `headless/src/actionSpace.ts` (no-op visibility changes, same pattern as the prior `chooseBuildPosition` export) so they could be audited directly.

**What was observed:**

- `_stateDivergenceAudit.ts` (seed=1, 6000 ticks): first divergence at **tick 53** — `ownResources` blue=0.039 vs red=0.04, `ownLifetimeResourcesFrac` blue=0.00267 vs red=0.00278, growing through tick 62 (blue=0.048 vs red=0.052). 5947/6000 ticks diverge thereafter.
- `_gatherTrace.ts` traced tick 53 to `spawnOutside`'s per-player-slot RNG streams (`match.rng[0]`/`match.rng[1]`, independent by design, `types.ts:83-86`): each side's 4th worker spawns at a non-mirror-paired position relative to its assigned gather node. At tick 21 (seed=1), blue's 4th worker (e23) is 207.7px from node e11; red's 4th worker (e22) is only 157.8px from node e15. Red arrives and starts gathering (`accumulatedGather` growing) by tick 50; blue is still 109px away at tick 50 and hasn't arrived by tick 60. This produces an early ~1.32 res/tick (red) vs ~0.99 res/tick (blue) gather-rate gap — exactly the tick-53 divergence.
- `_directSymmetryAudit.ts` (seed=1, 6000 ticks, eps=1e-6): 4 violation classes —
  - `resolveTargetZone/enemy_army` and `resolveTargetZone/defend_crystal`: first violate at tick 430.
  - `findNode/nearest_safe`: first violates at tick 2128.
  - `findNode/richest_visible`: violates from **tick 0** — confirmed dead-code bug, its impl at `actionSpace.ts:469-471` has NO `isBlue` side filter (unlike `nearest_safe`/`nearest_contested`).
  - `resolveTargetZone/enemy_crystal` and `findNode/nearest_safe` — **MediumRushBot's actual decision path** — had **zero** violations before tick 2128.
- MediumRushBot only ever calls `findNode("nearest_safe",...)` (via `assign_workers`, every 20 ticks) and `resolveTargetZone("enemy_crystal",...)` (via `attack_move`); it never exercises `enemy_army`/`defend_crystal`/`midfield`/`contested_node` zones, `nearest_contested`/`richest_visible` node choices, or `attack_targeted`.

**What was decided and why:**

- **H7 downgraded** from "leading hypothesis" to "still open — first-pass audits did not find it" (C.2). The on-path functions (`enemy_crystal`/`nearest_safe`) were clean for >2000 ticks; the off-path violations are most plausibly DOWNSTREAM of the tick-53 RNG-driven state divergence rather than independent function bugs — once blue's and red's worlds have diverged at the entity-position level, `findNode`/`resolveTargetZone`'s `isBlue ? ... : ...` filters can correctly return *different, non-mirror-paired* answers for genuinely different inputs, which is not itself a bug.
- **Rejected** a "frozen single-color `mirrorState`" test (`f("blue", mirrorState(s)) ≈ mirrorPos(f("blue", s))`) as a way to test `findNode`/`resolveTargetZone` in isolation: their `isBlue ? n.x<mid : n.x>mid` filters are *intentionally* side-asymmetric (blue searches its own/left half), so mirroring the world while holding color fixed turns "search my own half" into "search the other color's half" — this test would fail even for CORRECT code. Structurally invalid, not just impractical.
- `findNode("richest_visible",...)`'s missing side-filter (C.1 #19) is real but **unreachable** by MediumRushBot — tracked separately from the H5+H7 landing.
- The `spawnOutside`-RNG divergence (C.1 #18) is "non-biasing" *per-seed* (already documented in `mirror.ts:106-107` as expected noise for the single-tick round-trip property), so it's unlikely to **be** H7 (which must be a systematic, color-correlated bias to explain a 67/33 skew across 30 seeds) — but it does mean state-divergence-based comparisons (#17/#18) can't cleanly separate "function has a bug" from "function correctly answers an already-diverged question". The full **stateful lockstep test** (C.3 item 7 as originally specced — two bot instances driving `s` and `m=mirrorState(s)` independently from t=0, asserting `action(bot, m, "headless-blue") ≈ mirror(action(bot, s, "headless-red"))` every tick) remains the correct next test and was **not** built this iteration — it's the explicit next step.
- No version bump (R1 doesn't apply — diagnostic scripts + docs only). `headless/dist` rebuild not required: the 2 new exports are additive/no-op (same pattern as `chooseBuildPosition`) and the 3 new scripts are standalone, run via `tsx`, not part of any built/imported pipeline. `npm test`: 467/0 (unchanged).

**What would you tell the next agent NOT to waste time on?**

- Don't re-run `_directSymmetryAudit.ts`/`_stateDivergenceAudit.ts`/`_gatherTrace.ts` as-is expecting to find H7 directly — they've already been run (seed=1, 6000 ticks) and their findings are recorded above and in C.1 #17-18. They're useful as building blocks/reference for the lockstep test, not as the final test themselves.
- Don't try a frozen single-color `mirrorState` test for `findNode`/`resolveTargetZone` — proven structurally invalid for these specific filter-based functions (see above).
- Don't treat the `_directSymmetryAudit.ts` tick-430/tick-2128 violations as independent H7 leads without first ruling out the tick-53 RNG divergence (#18) as their cause — they're very likely downstream.
- `richest_visible`'s missing side-filter (C.1 #19) is confirmed but dead-code (MediumRushBot never selects it) — don't prioritize fixing it as part of H5+H7.
