# CrystalFront Revival Plan — implementation guide

**Status:** Ready to implement. Nothing in this plan has been started.
**Source:** Derived from the 2026-06-09 diagnostic report (`/root/fable-crystalfront-diagnosis.md`, outside the repo). This document is self-contained — you do not need the report to execute the plan, but read it if you want the full evidence.
**Audience:** An implementing agent. Follow phases **in order**. Do not skip ahead: each phase de-confounds the next. Training before the game is balanced will rediscover that rush_medium is unbeatable, slowly and expensively.

---

## 0. Read this first — context and ground rules

### What happened to this project

v0.4.0-ML was halted after the agent failed to learn multi-unit play against `rush_medium`. The 2026-06 diagnosis found the halt verdict was confounded by three issues this plan fixes:

1. **A critical bug:** curriculum config overrides (map width, crystal HP, starting resources) are silently **dropped on episode autoreset** in `headless/src/stdioVecRunner.ts`. They only ever applied to the first episode of each env slot. >99% of all historical training ran on the default 6000px/1000HP/50-res config regardless of curriculum stage.
2. **Game balance:** empirically, **no scripted bot beats rush_medium** (macro 0/20, turtle 0/20, heavy 0/20, rush 1/20). Defence is nonviable (turtle loses 20/20). The training gate was unachievable.
3. **MDP formulation:** one decision per 100ms tick over 6000-tick episodes with γ=0.995 means the ±100 terminal reward is mathematically invisible to early-game decisions. Draws and resource wins were both scored −100.

### Hard rules — apply to every task

- **R1 — Version bump.** Any change to training code, reward, or game config requires bumping the version in **all 5** `package.json` files (root, `server/`, `headless/`, `shared/`, `client/`). Current version: `0.4.0-ML`. Use `0.5.0-ML` for this whole plan (bump once, in the first commit of Phase 0; bump patch versions `0.5.x-ML` for subsequent balance/reward iterations).
- **R2 — Rebuild dist.** The training pipeline executes `headless/dist/*.js`, NOT `headless/src/*.ts`. After **every** edit under `headless/src/`, rebuild dist (Task 0.5 creates the script; until then use `npx tsc -p headless/tsconfig.build.json`). An edit that isn't rebuilt silently doesn't run.
- **R3 — Never reorder `ALL_ACTIONS`** in `headless/src/actionIndex.ts`. The shipped ONNX model's output indices depend on this order. Appending is allowed; reordering or removing breaks the production bot.
- **R4 — Do not trust `docs/ML_AGENT.md` §3.1.** Its action-space table documents a layout that does not exist in code (it claims y-zone builds and `set_rally` actions). The source of truth is `headless/src/actionIndex.ts`. Task 0.6 fixes the doc.
- **R5 — Do not trust diary conclusions** in `docs/ML_BOT_ACTION_PLAN.md` about curriculum stages (e.g. "the resource slider worked") — they were observed while bug #1 was active.
- **R6 — Tests must pass** after every task: `npm test` (runs `tsx tests/index.ts`, 461+ tests). After env/training changes also run `python -m training.test_env` (a ~5s end-to-end smoke test).
- **R7 — One task per commit**, message prefixed with the task ID, e.g. `fix(0.1): persist config overrides across autoreset`.
- **R8 — Surgical diffs.** Change only what the task specifies. If you find adjacent problems, note them in the commit body; don't fix them inline.
- **R9 — Do not ship any new ONNX model until Phase 3's eval gates pass.** `models/policy-v0.3.2-ML.onnx` stays the production model throughout Phases 0–2.
- **R10 — Document as you go.** This project's continuity lives in its docs, not in your session. Follow the **Documentation & reflection protocol** below after every task and at every phase boundary. An undocumented task is an unfinished task.
- **R11 — Push after every commit.** `git push origin CrystalFront-ML` immediately after each commit (R7), not just at phase boundaries. On 2026-06-10, `/root/CrystalFront` was `rm -rf`'d while 8 commits sat unpushed since `772540e3`; recovery only worked because Claude Code's file-history backups happened to cover it. Don't rely on that again — local-only history is one accident away from gone.

### Documentation & reflection protocol (R10 — mandatory)

The existing progress docs remain the system of record. Keep them current as follows:

**After every completed task:**
1. **Update the status column** in Appendix B of *this* file (`⬜ todo → ✅ done`, or `⚠️` with a note if partially done / deviated). This table is the live progress tracker.
2. If the task changed any spec that `docs/ML_AGENT.md` documents (observation, action space, reward, curriculum, hyperparameters, training commands, file structure), **update the corresponding ML_AGENT.md section in the same commit**. That file must never drift from the code again.

**After every phase (and after any significant surprise mid-phase):**
3. **Append a dated diary entry** to `docs/ML_BOT_ACTION_PLAN.md` §12 (chronological, oldest first — append at the END of the file). Match the existing entry format: `### YYYY-MM-DD — v0.5.x-ML: <title>`, then: what was done, what was observed (real numbers — win rates, matrix results, test outcomes), what was decided and **why**, and anything that deviated from this plan. Write it so a future agent with zero context can reconstruct your reasoning.
4. **Update the "Current handoff state" section** at the top of `docs/ML_BOT_ACTION_PLAN.md`: where the project is, what is deployable, what's in flight, what to read next. Keep its "Open commitments" table truthful.

**Reflection requirement (not optional):** each phase-boundary diary entry must end with a short **"Reflections"** subsection answering three questions: (a) did the results match this plan's predictions — where didn't they? (b) does any later phase of this plan need adjusting based on what you learned? (c) what would you tell the next agent NOT to waste time on? If the answer to (b) is yes, edit the relevant section of this plan in the same commit and note the change in the diary entry.

**On any stop-the-line event or abandoned approach:** write the diary entry *immediately*, before attempting fixes — failed attempts are the most valuable history this project has (the diary's existing post-mortems are the model to follow).

### Key file map

| File | Role |
|---|---|
| `headless/src/stdioVecRunner.ts` | Vectorised training runner (N games per Node proc) — **has the critical bug** |
| `headless/src/stdioRunner.ts` | Single-game runner (used for BC demo collection) |
| `headless/src/observation.ts` | Fog-filtered observation builder |
| `headless/src/actionIndex.ts` | Integer ↔ MacroAction mapping (81 actions) — source of truth |
| `headless/src/actionSpace.ts` | MacroAction → engine commands; zone geometry |
| `headless/src/legalActions.ts` | Legal-action enumerator |
| `headless/src/reward.ts` | `computeReward()` — single source of truth for rewards |
| `headless/src/bots/*.ts` | Scripted opponents |
| `server/src/match/matchEngine.ts` | Pure deterministic engine (shared with live game) |
| `server/src/match/types.ts` | `MatchConfig`, `DEFAULT_CONFIG` |
| `shared/src/gameBalance.ts` | All balance numbers |
| `shared/src/balanceHistory.ts` | Versioned balance snapshots (replays depend on these) |
| `training/env/crystalfront_vec_env.py` | Python vec-env wrapper |
| `training/ppo/train.py` | PPO trainer + `CURRICULUM` table |
| `training/bc_pretrain.py` | Behaviour-cloning warmup |
| `training/eval/eval_checkpoint.py` | Win-rate eval |
| `headless/src/cli.ts` + `training/balance_report.py` | Scripted-bot balance tooling |

---

## Phase 0 — Repair the instrument (est. 1–2 days)

Goal: the training environment does what its configuration says, crashes never kill runs silently, and the docs match the code.

### Task 0.1 — Persist config overrides across autoreset 🔴 CRITICAL

**File:** `headless/src/stdioVecRunner.ts`

The bug: in `stepSlot()`'s `done` branch, the autoreset call is:

```ts
const nextObs = resetSlot(slot, undefined, slot.opponentName, doNextSave, undefined, slot.prePlace);
//                                                            ^^^^^^^^^ configOverrides lost
```

`resetSlot` then falls back to `DEFAULT_CONFIG`. Fix:

1. Add a field to the `SlotState` interface: `cfgOverrides?: Partial<import("../../server/src/match/types.js").MatchConfig>;`
2. In the `reset_all` handler, when constructing each slot object, store the parsed overrides: `cfgOverrides: cfgOverrides,` (the local variable already exists there).
3. Change the autoreset call to pass `slot.cfgOverrides` as the fifth argument.
4. Rebuild dist (R2).

Also confirm (read-only, no change expected): `headless/src/stdioRunner.ts` has no autoreset path — the Python single-game env (`training/env/crystalfront_env.py`) re-sends `config_overrides` in every explicit `reset` message, so it is not affected. State your confirmation in the commit body.

**Verify:** Task 0.2's regression test (write it in the same sitting).

### Task 0.2 — Regression test for config persistence

Never let this class of bug recur silently.

1. **Echo the realised config.** In `stdioVecRunner.ts`, have `resetSlot` capture the `matchCfg` it actually used, and expose `{ mapWidth, crystalHealth, startingResources }`:
   - in each slot of the `ready` response (new field `config`), and
   - in the `info` object on `done` steps (new field `nextEpisodeConfig`, describing the freshly autoreset episode).
2. **Python test:** create `training/test_config_persistence.py`:
   - Build a `CrystalFrontVecEnv(vec_size=2, opponent="idle", config_overrides={"mapWidth": 800, "crystalHealth": 50, "startingResources": 200}, max_ticks=60)`.
   - `reset()`, then step with action `0` (noop) until each slot has completed **two** episodes (max_ticks=60 makes this fast — episodes end by timeout).
   - Assert the `ready` configs AND every `nextEpisodeConfig` equal the overrides. Exit non-zero on failure.
   - (You will need to surface the new fields through `crystalfront_vec_env.py` — pass them through in the `info` dict; the `ready` config can be added to the reset return's info dict.)
3. Add the test to your routine: run it whenever the runner changes.

**Verify:** test fails if you temporarily revert Task 0.1 (try it once to prove the test bites), passes with the fix.

### Task 0.3 — Make observation/zone geometry config-aware

The observation builder and parts of the zone geometry use the **static live-game constants** instead of the match's configured dimensions, so curriculum maps produce distorted features.

**File: `headless/src/observation.ts`** — at the top of `buildObservation`, derive once:

```ts
const mapW = match.config?.mapWidth  ?? MAP.width;
const mapH = match.config?.mapHeight ?? MAP.height;
```

Then replace every use of `MAP.width`/`MAP.height` in this file with `mapW`/`mapH`. There are ~10 sites: the `mid` for half-of-map features, the crystal-position fallbacks, `nearestEnemyToCrystalDistNorm` (divides by `MAP.width`), entity `xNorm`/`yNorm`, node `xNorm`/`yNorm`, and the node `isContested` test.

Also fix crystal health normalisation: `crystalMaxHp = ENTITY.crystal.health` (static 1000) is wrong on curriculum stages with overridden crystal HP. The entities carry their own `maxHealth` — use it:

```ts
ownCrystalHealthFrac: ownCrystal && ownCrystal.maxHealth > 0 ? ownCrystal.health / ownCrystal.maxHealth : 0,
oppCrystalHealthFrac: oppCrystal && oppCrystal.maxHealth > 0 ? oppCrystal.health / oppCrystal.maxHealth : 0,
```

Leave `tick: match.tick / 6000` as-is (an acceptable fixed normaliser; changing it would shift the shipped model's input distribution).

**File: `headless/src/actionSpace.ts`** — the pattern at lines ~295–298 (`const mapW = match.config?.mapWidth ?? MAP.width;` with the comment "MAP.width must NOT be used here") is the template. Apply it to the remaining static uses in this file: the `mid` at ~line 248, and the target-zone resolution block at ~lines 364–463 (`enemy_crystal` fallback positions, `midfield`, the `contested_node` radius test `Math.abs(node.x - mid) < MAP.width * 0.35`, and the node-choice filter at ~line 463). Check each enclosing function receives `match`; they do.

**File: `headless/src/legalActions.ts`** — line ~31 declares `const mid = MAP.width / 2;` which is **unused**. Delete it (it's exactly the pattern this task eliminates).

⚠️ **Compatibility note:** on the default 6000×600 map these changes are numerically identical to before, so the shipped v0.3.2-ML model is unaffected. Confirm by running `npx tsx headless/src/verifyMlBot.ts` (or the mlBotSmokeTest in `headless/dist/`) if present, plus `npm test`.

**Verify:** `npm test` passes; extend `training/test_config_persistence.py` with one more assertion: with `mapWidth=800`, after a few steps the max entity `xNorm` across slots exceeds 0.5 (entities span the small map's full width; before this fix everything sat below ~0.14).

### Task 0.4 — Fix MacroBot crash + crash-proof the runners

**Bug:** `headless/src/bots/macroBot.ts` lines ~47–52 reference `this.barracksZoneIdx`, `this.barracksYZones`, `this.barracksYZone` — none are declared (remnants of the removed y-zone build system). The bot throws `TypeError` at runtime the first tick after its barracks is destroyed (this happened in 15/20 games vs rush_medium) and the exception kills the whole training subprocess.

1. **Delete the dead block** (the `if (barracksCount < this.prevBarracksCount) {...}` body and the now-unused `prevBarracksCount` field + its `init` reset + the assignment after the block). The "adaptive y-zone" feature is meaningless since y-zones no longer exist in the action space. Do not try to "restore" it.
2. **Defensive wrapper:** in both `stdioVecRunner.ts` and `stdioRunner.ts`, wrap each scripted-bot `step()` call (red bot; and blue demo bot in stdioRunner) in try/catch. On exception: log once to stderr with the bot name, treat the result as `[]`, and increment a per-episode counter surfaced as `info.botCrashCount` on done. A crashed opponent must never kill a training run again — but it must be *visible*, so also have `training/ppo/train.py` print a warning if any episode reports `botCrashCount > 0` (a crashing opponent invalidates that episode's difficulty).
3. **Type-check gate:** run `npx tsc --noEmit -p headless/tsconfig.json`. Fix the MacroBot errors. If *other pre-existing* errors surface, do **not** fix them in this task — list them in the commit body.

**Verify:** this script must complete without crashes — run a macro vs rush_medium match headlessly:

```bash
cd /root/CrystalFront && npx tsx -e "
import { runMatch } from './headless/src/runMatch.js';
import { MacroBot, MediumRushBot } from './headless/src/bots/index.js';
for (let i = 0; i < 5; i++) {
  const r = runMatch(new MacroBot(), new MediumRushBot(), { seed: 1000 + i });
  console.log(i, r.winner, r.winType, r.ticks);
}"
```

(Before the fix, this crashes on most seeds.)

### Task 0.5 — Single-command dist build + freshness guard

The src→dist mirror is currently maintained **by hand**, which is how stale/divergent compiled code happens.

1. Add to the **root** `package.json` scripts: `"build:headless": "tsc -p headless/tsconfig.build.json"`. First inspect `headless/tsconfig.build.json`; if it doesn't emit to `headless/dist`, adjust the script to use `headless/tsconfig.json` (which sets `outDir: ./dist`). Run it; confirm `headless/dist/*.js` regenerates and `npm test` + `python -m training.test_env` still pass.
2. **Freshness guard:** in `training/env/crystalfront_vec_env.py` `_ensure_proc()` (and the equivalent in `crystalfront_env.py`), before choosing the compiled JS path: compute the newest mtime of `headless/src/**/*.ts` and compare to the runner JS mtime. If the JS is older, **raise** `RuntimeError("headless/dist is stale — run: npm run build:headless")`. Fail loud, not silent.

**Verify:** `touch headless/src/reward.ts` then `python -m training.test_env` → must raise the stale error. Rebuild → passes.

### Task 0.6 — Regenerate the action-space documentation from code

1. Create `headless/src/printActionTable.ts`: import `ALL_ACTIONS` from `actionIndex.js`, print a markdown table of `index | type | params` (one row per action, 0–80), plus a summary table of contiguous ranges per type.
2. Run it (`npx tsx headless/src/printActionTable.ts`) and **replace** `docs/ML_AGENT.md` §3 ("Action space") tables with the generated output, noting at the top: *"Generated from `actionIndex.ts` by `printActionTable.ts` — regenerate after any action-space change."*
3. While in `ML_AGENT.md`: add a banner under the title: *"⚠ 2026-06 diagnosis: curriculum results recorded before v0.5.0-ML were affected by a config-override bug (see `docs/REVIVAL_PLAN.md` §0). Treat stage-clearance history as unreliable."*

**Verify:** spot-check 5 indices in the new table against `actionIndex.ts` (e.g. 6 = `build barracks near_crystal`, 18 = `attack_move all_combat enemy_crystal`, 49 = `hold_position`, 66 = `attack_move all_workers enemy_crystal`, 80 = last `idle_workers` zone).

### Task 0.7 — Deprecation notes (no code changes)

The action-forcing (`legalActions.ts` `LegalActionsOpts`) and RND (`training/ppo/policy.py` `RNDModel`) modules are default-off symptom treatments. Do **not** delete them in this plan (deletion risk > benefit), and do **not** use them. Add a one-line `@deprecated — see docs/REVIVAL_PLAN.md` comment on `LegalActionsOpts` and `RNDModel`. Note: forcing internally uses `Math.random()`, the only nondeterminism in the pipeline — one more reason it stays off.

**Phase 0 exit criteria:** Tasks 0.1–0.6 committed; `npm test` green; `python -m training.test_env` green; `training/test_config_persistence.py` green; version `0.5.0-ML` everywhere; **R10 done** — diary entry in `ML_BOT_ACTION_PLAN.md` (include: which historical conclusions are now confirmed invalid given the bugs you just fixed), handoff section updated, Appendix B statuses current.

---

## Phase 1 — Balance the game, with bots as the instrument (est. 3–5 days)

Goal: defence becomes viable, no strategy is strictly dominant, draws disappear. **Do not start Phase 2 until the acceptance matrix below passes.**

### Task 1.1 — Extend the balance harness to all 9 bots

1. `headless/src/cli.ts` `makeBot()` currently supports only `idle, rush, turtle, macro, heavy`. Add `passive`, `rush_weak` (WeakRushBot), `rush_weak_medium` (WeakMediumRushBot), `rush_medium` (MediumRushBot) — mirror the `makeBot` in `stdioVecRunner.ts`.
2. `training/balance_report.py`: extend `SCRIPTED_BOTS` to all 9 names.
3. Add a convenience script (root `package.json`): `"balance:matrix": "python3 training/balance_report.py --matches 50"` (adjust to however the script is invoked in this environment — it shells out to `cli.ts` via tsx).
4. Run the full matrix once at 20 matches/pair to establish the **baseline**. Save the JSON output as `docs/balance/matrix_baseline_v0.5.0.json` (create the folder).

**Verify:** baseline numbers should roughly match the diagnosis measurements: rush_medium ≥95% vs macro/turtle/heavy; rush ≥95% vs turtle/macro; macro-vs-turtle draw rate ≥60%.

### Task 1.2 — Engine timeout tiebreaker (kill the draws)

Currently a game that reaches the tick cap just stops with `winner = null`. Add a deterministic tiebreak **in the engine** so every capped game produces a winner — this fixes the game UX *and* removes the need for a "draw" reward case.

1. `server/src/match/types.ts`: add `maxTicks: number;` to `MatchConfig` and `maxTicks: 6000` to `DEFAULT_CONFIG`. (Decision, flag in release notes: live multiplayer matches now also end at 6000 ticks ≈ 10 min with a tiebreak winner. This is desirable — currently live games can run forever.)
2. `server/src/match/matchEngine.ts`, in `tick()`, after the existing win checks, while `phase === "playing"`:
   ```
   if (match.config.maxTicks > 0 && match.tick >= match.config.maxTicks) → resolve tiebreak
   ```
   Tiebreak order: (a) higher crystal `health / maxHealth`; (b) higher `economy.lifetimeResources`; (c) player slot 0 (blue) — make (c) explicit and deterministic. Set `match.result = { winner, winType: "timeout" }`, mark the match finished the same way the resource-win path does (~line 1037–1042 — follow that pattern exactly, including the `matchEndCallback`).
3. The headless runners keep their existing `match.tick >= MAX_TICKS` done-check as a belt-and-braces fallback, but now the engine will have set a result first. Ensure runner `MAX_TICKS` is passed into `config.maxTicks` via the config overrides (`stdioVecRunner` `reset_all` handler: merge `{ maxTicks: MAX_TICKS }` into the overrides).
4. Add engine tests in `server/src/match/matchEngine.test.ts`: capped match with unequal crystal HP → HP winner; equal HP, unequal lifetime resources → resource winner; fully equal → blue.
5. Reward interaction: `headless/src/reward.ts` currently gives +100 only when `winType !== "resource"`. A `"timeout"` tiebreak win already passes that check — no change needed *yet* (Phase 2 rewrites the terminal anyway). Just confirm with one assertion in the existing reward tests if any, else note it.

**Verify:** `npm test` green; re-run macro-vs-turtle 20 matches → draw count 0.

### Task 1.3 — Balance tuning loop

This is iterative. Apply **iteration 1** below, re-run the matrix, evaluate against the acceptance criteria, and continue adjusting one lever at a time. Record every iteration's matrix JSON in `docs/balance/`.

⚠️ Before touching `shared/src/gameBalance.ts`, read `shared/src/balanceHistory.ts` and follow its snapshot pattern — replays depend on historical balance values being preserved per version. Each balance iteration = patch version bump (R1).

**Iteration 1 (apply together, then measure):**

| Lever | Current | New | Rationale |
|---|---|---|---|
| `BUILDING_DEFS.turret.health` | 400 | **600** | Turrets die to 7 skirmishers in ~48 ticks; defence must hold |
| `BUILDING_DEFS.turret.attackCooldown` | 12 | **8** | dps 1.5 → 2.25 |
| `COUNTER_MODIFIER` all `2.0` / `0.5` entries | 2.0 / 0.5 | **1.5 / 0.75** | 4× swing makes fights binary and rush dominant |
| `UNIT_DEFS.worker.cost` + `ECONOMY.workerTrainCost` | 50 | **35** | Economy shouldn't be a 1:1 sacrifice of military. These two values **must stay equal** (see the comment in gameBalance.ts) |

**Acceptance criteria (50 matches/pair, both colour assignments where asymmetric):**

1. Every bot loses ≥20% of matches to at least one other bot (no strictly dominant strategy).
2. `turtle` **and** `macro` each beat `rush_medium` ≥30%.
3. `rush_medium` still beats `rush_weak_medium` ≥60% (the ladder must stay ordered — don't nerf rush into irrelevance).
4. Mirror matches (`rush_medium`, `rush_weak`, `macro`) within 40–60% per side.
5. Timeout-tiebreak games <30% in any pairing (most games should resolve by combat).

**Further levers if iteration 1 falls short** (one at a time, in this order): `MediumRushBot.FIRST_PUSH_TICK` 200→300; turret cost 60→50; crystal slow-regen (e.g. +0.05 HP/tick when no enemy within 300px — engine change, add tests); skirmisher cost 50→60. If after ~6 iterations criteria 1–2 still fail, stop and write up findings in `docs/balance/FINDINGS.md` — do not proceed to Phase 2 with an unbeatable rush.

### Task 1.4 — Resource (passive) win: make it a real win everywhere

Decision (recommended in the diagnosis; implement unless the user has said otherwise): the passive win **stays** in the game and is treated as a legitimate win **everywhere**, including by the ML reward (done in Phase 2, Task 2.2). No game-side change needed in this task beyond confirming the matrix tracks `resource_win` counts (balance_report already flags them). If resource wins exceed ~30% in any non-mirror pairing during Phase 1 tuning, raise `ECONOMY.passiveWinThreshold` (currently 4500) by 50% and re-measure.

**Phase 1 exit criteria:** acceptance matrix passes; matrices archived in `docs/balance/`; engine tests green; balance snapshot recorded; version bumped; **R10 done** — diary entry (include the before/after matrix tables and the reasoning behind each balance lever you ended up using), handoff section + Appendix B updated. If balance work changed player-facing behaviour (tiebreaker, costs, counters), also note it in a draft release-notes section in the diary entry for later use.

---

## Phase 2 — Restructure the MDP (est. 2–3 days code, before any long training)

Goal: make the learning problem solvable by PPO. Three changes: decisions every k ticks, rewards of order ±1, and curriculum mechanics that don't corrupt rollouts.

### Task 2.1 — Frame skip (decision interval k)

The agent currently decides every engine tick (100ms). Make it decide every `k` ticks (default **8**), holding macro-actions in between. Macro-actions already persist in the engine (move orders continue, queues produce), so this is purely a stepping change.

**`headless/src/stdioVecRunner.ts`:**
1. Module-level `let DECISION_INTERVAL = 1;` read from `reset_all` (`msg.decision_interval`), like `MAX_TICKS`.
2. In `stepSlot()`: apply the blue macro-action once (as now), then loop `for (let t = 0; t < DECISION_INTERVAL; t++)`:
   - red bot observes + acts **every tick** (unchanged behaviour for scripted bots);
   - `engine.tick(match.id)`;
   - build the new blue observation, call `computeReward(prevBlueObs, blueObs, …)` **per tick**, accumulate the reward sum, update `slot.prevBlueObs = blueObs` each tick (this keeps the crystal-delta and milestone semantics exact);
   - compute `done` per tick; `break` immediately when done.
   Return the accumulated reward and the final observation/legal mask.
3. Keep noop/trainUnit streak updates as-is (they're per decision; forcing is deprecated anyway).

**`training/env/crystalfront_vec_env.py`:** constructor param `decision_interval: int = 1`, sent in `reset_all`.

**`training/ppo/train.py`:** config flag `decision_interval: int = 8`, passed to env construction. Note in the run banner.

⚠️ **Semantics shift:** `global_step` now counts *decisions*, each worth k ticks of game time. The `CURRICULUM` `max_steps` budgets and `total_timesteps` are therefore worth 8× more game experience. Divide every `max_steps` in `CURRICULUM` by 4 (not 8 — keep slack) and say so in the commit.

**`headless/src/stdioRunner.ts` (BC path):** same `decision_interval` support, with one difference — in demo mode, the scripted **blue** bot also observes and acts every tick *with its full action list* (apply **all** its returned actions, not just `[0]` — this fixes the "lobotomised expert" defect), and the recorded `demoAction` for the window is the first non-noop macro-action the bot issued anywhere in the window (else 0/noop), converted via `actionToIndex`. The observation paired with that label is the one from the **start** of the window.

**Verify:** `python -m training.test_env` passes; a 1k-decision training smoke run (`--total_timesteps 20000 --num_envs 4 --vec_size 2 --decision_interval 8 --opponent idle`) completes; logged `game/episode_length_ticks`-equivalent episode lengths in *decisions* are ≈ old tick lengths ÷ 8.

### Task 2.2 — Reward rescale and terminal redesign

Rewrite the constants in `headless/src/reward.ts` (structure stays identical):

| Component | Old | New |
|---|---|---|
| Terminal win (any `winType`, **including** `"resource"` and `"timeout"`) | +100 (combat only) | **+1.0** |
| Terminal loss | −100 | **−1.0** |
| Crystal damage dealt | +5.0 × Δfrac | **+0.05 × Δfrac** |
| Crystal damage taken | −2.0 × Δfrac | **−0.02 × Δfrac** |
| First barracks | +10 | **+0.10** |
| Combat units 1–4 | +5/+3/+2/+1 | **+0.05/+0.03/+0.02/+0.01** |
| Time penalty per tick | −0.001 | **−0.00001** |

Specifically: the terminal line becomes `terminalReturn = (winner === blueId) ? 1.0 : -1.0;` — **delete the `winType !== "resource"` clause**. With the Phase 1 tiebreaker, a timeout always has a winner, so there is no separate draw case (keep `winner === null` → −1.0 as a defensive fallback only).

Max shaping per episode ≈ +0.26 vs terminal ±1.0 — terminal dominates but "almost won" beats "got crushed". Update the file's header comment and `docs/ML_AGENT.md` §4 to match. Version bump (R1). Rebuild dist (R2).

**Verify:** `npm test`; then one smoke training run and check TensorBoard `rewards/final_reward_mean` is in [−1.3, +1.3].

### Task 2.3 — PPO hyperparameters for the new MDP

In `training/ppo/train.py` `Config` defaults:

- `gamma: 0.995 → 0.99` (at k=8, half-life ≈ 69 decisions ≈ 550 ticks of game time)
- `num_steps: 1536 → 256` (episodes are now ≤750 decisions; long rollouts no longer needed; faster updates)
- `num_minibatches: 6 → 4` (keep minibatch ≈ 1280 with 20 envs × 256 steps)
- Leave `gae_lambda=0.95`, `ent_coef=0.02`, `learning_rate`, clip params unchanged — they're correct for ±1 rewards.
- LR-anneal guard: `frac = max(1.0 - (update - 1) / num_updates, 0.0)` and print a loud warning when resuming a checkpoint whose `update` ≥ 80% of the *current* run's `num_updates` (schedule compression trap).

### Task 2.4 — Curriculum promotion at update boundaries

Currently `train.py` rebuilds the vec envs **inside** rollout collection when a stage promotes/regresses, splicing two different stages into one rollout buffer with no episode boundary — corrupting GAE for that update.

Fix: in the win-window check, instead of rebuilding immediately, set `pending_stage_change = +1 | -1`. After the PPO update for the current rollout completes, apply the change: rebuild envs, reset, update `cur_stage`, log. Delete the in-loop rebuild blocks.

**Verify:** run a short curriculum training from stage 0 with a low threshold to force a promotion; confirm the promote log line appears *between* update logs, and training continues without error.

### Task 2.5 — BC label alignment

In `training/bc_pretrain.py`, the demo label is read from the *previous* step's info, pairing action a_t with observation s_{t+1}. Restructure the collection loop so each appended `(obs, action)` pair is the observation **before** the step and the `demoAction` returned **by** that step:

```python
while not done:
    ep_obs.append({k: v.copy() for k, v in obs.items()})
    obs, reward, terminated, truncated, info = env.step(0)
    ep_acts.append(int(info.get("demoAction", 0)))
    ep_rews.append(float(reward))
    done = terminated or truncated
```

(Requires `stdioRunner.ts` to include `demoAction` in **every** step info, which it already does in demo mode.) Keep the noop-subsample and critic-return logic unchanged.

**Phase 2 exit criteria:** all tasks committed; smoke runs green; `training/test_config_persistence.py` still green (the runner changed — re-run it); version bumped; **no long training launched yet**; **R10 done** — diary entry, `ML_AGENT.md` §4 (reward) and §8 (training guide/hyperparameters) updated to the new MDP in the same commits that changed them, handoff section + Appendix B updated.

---

## Phase 3 — Retrain, honestly this time (est. ~1 week of runs)

### Task 3.1 — Re-record BC demos

```bash
python -m training.bc_pretrain \
  --episodes 1000 \
  --output bc_warmup_v05.pt \
  --noop_keep 0.05
```

Use default (full-game) config and `decision_interval 8` (add the flag to bc_pretrain's env construction if Task 2.1 didn't already). Demo bot: RushBot vs IdleBot as before. Sanity gates before proceeding: BC top-1 accuracy ≥55%; greedy BC policy beats `idle` in ≥3/10 eval matches (use `eval_checkpoint.py`). If not, inspect the recorded action distribution (should be ≪90% noop after subsampling) before debugging deeper.

### Task 3.2 — Curriculum run

```bash
python -m training.ppo.train \
  --curriculum --curriculum_stage 0 \
  --checkpoint bc_warmup_v05.pt \
  --decision_interval 8 \
  --num_envs 20 --vec_size 4 \
  --total_timesteps 20000000
```

Notes for this run:

- The existing 17-stage `CURRICULUM` table is the starting point, **now that its knobs actually work**. Expect the early micro-stages (0b5, 0c, day5) to clear much faster than history suggests — or to behave differently than the diary claims (R5). Trust the new logs only.
- Log the **realised config**: at every stage entry, print one episode's `nextEpisodeConfig` (from Task 0.2) next to the stage definition. They must match. If they ever diverge, stop the line.
- Stage `3a_rm_3k` (the old wall) should be re-attempted **only after** Phase 1's acceptance criteria passed — by then rush_medium is beatable-in-principle and the stage runs at its intended 3000px/300HP config for the first time ever.
- If a defensive stage is needed, note: pre-placement currently only supports the BLUE side (`performPreSetup` in `stdioVecRunner.ts`). Building an opponent-side pre-place (e.g. "passive opponent with 5 skirmishers parked mid-map") is a small, separate task — design it like `performPreSetup` but for `RED_ID`, gated by a `pre_place_red` message field.

**Stop-the-line conditions** (halt and investigate, don't push compute):

- vs `idle` not at ~100% within 100k decisions → pipeline bug.
- Entropy < 0.3 in the first 500k decisions → collapse; raise `ent_coef` to 0.05 or restart.
- `noop%` rising monotonically past 60% on any stage → the stage gradient is wrong; check the stage's realised config and the bot matrix for that opponent before blaming the policy.
- Realised episode config ≠ stage config → Task 0.1/0.2 regression; fix before anything else.
- Any `botCrashCount > 0` warnings → opponent bug; fix the bot.

**Documentation cadence for training runs (R10):** training is where history gets lost fastest. Keep a running diary entry in `ML_BOT_ACTION_PLAN.md` §12 for the curriculum run, updated at minimum (a) at every stage promotion/regression — stage name, update number, step count, win rate, action-mix percentages (the existing diary's stage-log tables are the format to copy); (b) at every stop-the-line event, *before* attempting the fix; (c) at run end, with a Reflections subsection comparing the realised stage progression against both this plan's expectations and the (unreliable) historical diary claims — this comparison is the first honest curriculum data the project will ever have, so record it carefully.

### Task 3.3 — Eval gates and (only then) shipping

A candidate checkpoint may ship as `v0.5.0-ML` when, via `eval_checkpoint.py` over 100 episodes/opponent at `decision_interval 8`:

- ≥95% vs `idle`, `passive`;
- ≥70% vs `rush_weak`, `rush_weak_medium`, `macro`;
- ≥40% vs `rush_medium` (the old wall — now calibrated to be possible);
- no regression below v0.3.2-ML's table on any opponent it already beat (`docs/eval_v0.3.2-ML.txt`).

Ship process: `export_onnx` → `test_onnx_parity` → verify `MlBot` works at the new decision cadence (the live `BotPlayer` drives the agent per tick — it must now hold each ONNX decision for k ticks; check `headless/src/bots/mlBot.ts` and `server/src/match/botPlayer.ts`, and add an internal tick counter to `MlBot` so it only runs inference every k-th call). Then follow `docs`/memory deploy flow, version bump, release notes.

**On ship (R10):** write `docs/RELEASE_NOTES_v0.5.0-ML.md` (follow the v0.3.2 file's structure, including the empirical win-rate table and honest known-limitations section); final diary entry with the full eval table; rewrite the "Current handoff state" section of `ML_BOT_ACTION_PLAN.md` from scratch to describe the post-revival state; mark every Appendix B row in this plan ✅ (or ⚠️ with explanation) so this document closes out as a faithful record of what was actually done versus planned.

---

## Phase 4 — Escalation criteria (do not pre-build)

Only if, **with** Phase 0–2 fixes in place and Phase 1 acceptance passed, the agent still cannot exceed ~10% vs `rush_medium` after ≥20M decisions including a dedicated defensive stage: then consider the hierarchical-policy design (Option α in `docs/ML_BOT_ACTION_PLAN.md`). Expectation: it will not be needed — the agent already trains 9–17 units/episode when the value landscape permits; the binding constraints were the environment, the balance, and the horizon, all fixed above.

---

## Appendix A — Command cheat sheet

```bash
npm test                                   # 461+ engine/server tests
npx tsc --noEmit -p headless/tsconfig.json # type-check headless
npm run build:headless                     # rebuild dist (Task 0.5) — ALWAYS after editing headless/src
python -m training.test_env                # 5s end-to-end pipeline smoke
python -m training.test_config_persistence # config-override regression test (Task 0.2)
python3 training/balance_report.py --matches 50          # full bot matrix (Task 1.1)
python -m training.eval.eval_checkpoint --checkpoint <ckpt> --episodes 100
tensorboard --logdir runs --bind_all
```

## Appendix B — Task checklist & live status tracker

**This table is the live progress record (R10).** Update the Status cell in the same commit that completes (or abandons) each task: `⬜` todo · `🔄` in progress · `✅` done · `⚠️` done-with-deviation (add a footnote below the table explaining what changed and why).

| Task | One-line summary | Verified by | Status |
|---|---|---|---|
| 0.1 | Persist configOverrides across autoreset | 0.2 test | ✅ |
| 0.2 | Config echo + regression test | test bites on revert | ✅ |
| 0.3 | Config-aware geometry in observation/actionSpace/legalActions | npm test + xNorm assertion | ✅ |
| 0.4 | MacroBot fix + try/catch bot steps + botCrashCount | 5-match macro vs rush_medium script | ✅ |
| 0.5 | build:headless script + dist staleness guard | touch-file test | ⚠️ |
| 0.6 | Action table regenerated from code | spot-check 5 indices | ✅ |
| 0.7 | Deprecation comments on forcing/RND | n/a | ✅ |
| P0 | Phase 0 diary entry + handoff update (R10) | entry in ML_BOT_ACTION_PLAN.md §12 | ✅ |
| 1.1 | 9-bot balance harness + baseline matrix | baseline ≈ diagnosis numbers | ✅ |
| 1.2 | Engine timeout tiebreaker (maxTicks in config) | engine tests; 0 draws macro-vs-turtle | ✅ |
| 1.3 | Balance iterations to acceptance criteria | matrix in docs/balance/ | 🔄 |
| 1.4 | Resource win is a real win | matrix resource_win rate | ✅ |
| P1 | Phase 1 diary entry (matrices + lever reasoning) | entry in ML_BOT_ACTION_PLAN.md §12 | 🔄 |
| 2.1 | decision_interval k=8 in runners/env/trainer | smoke run; ep lengths ÷8 | ⬜ |
| 2.2 | Rewards rescaled to ±1; resource/timeout wins count | reward_mean ∈ [−1.3, 1.3] | ⬜ |
| 2.3 | γ=0.99, num_steps=256, LR guard | smoke run | ⬜ |
| 2.4 | Stage changes at update boundaries | forced-promotion test | ⬜ |
| 2.5 | BC label off-by-one fix | BC accuracy gate | ⬜ |
| P2 | Phase 2 diary entry + ML_AGENT.md §4/§8 in sync | docs match code | ⬜ |
| 3.1 | Re-record BC demos (k=8, expert fixes) | BC sanity gates | ⬜ |
| 3.2 | Curriculum run with running diary | stage log + Reflections in diary | ⬜ |
| 3.3 | Eval gates → ship v0.5.0-ML | eval table vs gates; release notes | ⬜ |

**⚠️ Task 0.5 deviation:** The plan specified `tsc -p headless/tsconfig.build.json` as the build command. This fails because headless/src imports server/ and shared/ via relative paths, violating the rootDir constraint. Used esbuild instead (`npm run build:headless`). Staleness guard and dist rebuild both work correctly with esbuild. The Appendix A command cheat sheet (`npm run build:headless`) remains correct.

**Task 1.3, criterion 4 deferred (v0.5.2-ML):** rush_medium mirror matches measured 73/27 (22-8-0 over 30 seeds), outside the 40-60% target. Two independent symmetry fixes — numeric entity-id comparison and per-player RNG streams (both in `3b4852f`) — were verified correct but produced byte-identical aggregate results, proving the bias is deterministic rather than RNG/ordering-driven. Root cause unknown. Per user decision, criterion 4 is deferred as a documented known limitation; Task 1.3 remains 🔄 pending a fresh matrix for criteria 1/2/3/5 under v0.5.2-ML. See `docs/ML_BOT_ACTION_PLAN.md`, 2026-06-10 entry, for full details. **Investigation guidance: see Appendix C below.**

---

## Appendix C — Criterion 4 (mirror-match bias): investigation guide

**The problem.** In a rush_medium-vs-rush_medium mirror match, blue (slot 0, left side) wins 73% (22-8-0 over 30 seeds, stable across seeds). A 50/50-symmetric game should give ~40–60%. The bias is **structural and deterministic**: it survives different seeds, and two principled symmetry fixes changed nothing. Someone — engine or harness — systematically favours slot 0 / the left side / low entity ids. This appendix records what is already ruled out and what to try next, so future work starts where the last session stopped instead of repeating it.

### C.1 — Ruled out (do NOT re-investigate)

All verified as of v0.5.2-ML (commits `b6604d4`…`164bf4f`); details in the `ML_BOT_ACTION_PLAN.md` 2026-06-10 entry:

1. **Bot action order** — alternates per tick (`headless/src/runMatch.ts`). Fixed; no effect on the 73/27.
2. **Gathering slot contention** — tick-parity tie-break (`engine/gathering.ts`). Fixed; no effect.
3. **Timeout-tiebreaker slot-0 bias** — now a seeded coin flip (`matchEngine.ts`). Fixed; and the biased mirror matches were not timeouts anyway.
4. **Lexicographic entity-id comparison** (`"e10" < "e9"`) — `entityIdNum()` fix in `engine/utils.ts`/`movement.ts`. Fixed; aggregate result byte-identical before/after.
5. **Shared RNG stream cross-contamination** — per-player streams (`rng: [Rng, Rng]`, seeds `s` and `s ^ 0x9e3779b9`). Fixed; aggregate result byte-identical before/after.
6. **Target-acquisition ties in `combat.ts`** — instrumented count was 0/0/0 over a full seed=1 match. Not a factor.
7. **Map-constant asymmetry** — audited 2026-06-10: `SPAWN` (crystals at x=100 / W−100, worker offsets mirror exactly), `SAFE_NODE_OFFSETS` (red side auto-mirrored, same dy), `CONTESTED_NODE_OFFSETS` (±dx pairs, shared dy), `BUILD_ZONES` (0.2 / 0.8). All horizontally symmetric in `shared/src/gameBalance.ts` + `server/src/match/map.ts`.
8. **MediumRushBot side-dependence** — the bot's only coordinate logic is `isBlue ? n.xNorm < 0.5 : n.xNorm > 0.5` for safe-node selection; correctly mirrored.
9. **Immediate-damage first-strike** — combat damage is buffered in `damageLog` and applied after the attack loop; attack order within a tick cannot grant a first-strike kill.
10. **Entity creation/processing order (H1/H3 below)** — experiment C.3 #1 run 2026-06-10: swapping `createMatch` so red's crystal/workers are created first (red gets the low ids and earlier Map slots) produced **byte-identical** outcomes to baseline across all 30 seeds (same winners, tick counts, final entity counts; fresh baseline at `88a2188` re-confirmed blue 22-8-0). The bias is invariant to id assignment and Map-insertion order — it is **geometric (left/right side)**. Note: `server/src/match/matchEngine.js` is a stale committed artifact that tsx never executes (`.js` import specifiers resolve to `.ts` sources); don't let it mislead you.
11. **Spatial-grid binning, mostly (H2)** — experiment C.3 #2 run 2026-06-10: set `SIMULATION.spatialCellSize` to 6100 (≥ `mapWidth`=6000), collapsing collision-pair discovery to a plain double loop with zero floor-based binning. Result: **23-7-0** (vs baseline 22-8-0) — only 3/30 seeds flipped (5, 17, 26) and the ~75/25 skew persists almost unchanged. Floor-based grid binning is a **minor contributor** (perturbs a handful of borderline seeds) but **not the dominant cause**. Methodology note: `shared/src` edits (e.g. `gameBalance.ts`) require `npm run build:shared` before they're live for `tsx` — the workspace symlink resolves `@crystalfront/shared` to the gitignored `shared/dist`, not `shared/src` (R2 applies here too).
12. **`chooseBuildPosition` fallback-offset asymmetry found, but a naive mirror-fix overshoots (H5)** — experiment C.3 #3 run 2026-06-10. In `headless/src/actionSpace.ts`'s `chooseBuildPosition` (the only call site: `actionSpace.ts:46`, used by every bot's `build` macro-action for barracks/turret/depot/foundry), the `xZone` band selection (`near_crystal`/`mid_base`/`forward`) IS correctly `isBlue`-mirrored. But the 16-attempt fallback search (`actionSpace.ts:336`, used whenever the preferred spot is blocked — routine once buildings/units accumulate) computes `dx = (attempt % 4) * STEP * (attempt % 2 === 0 ? 1 : -1)` with **no `isBlue` term**. Since blue's build zone is `[0, 1200]` (own crystal near x=100, "increasing x" = toward the front) and red's is `[4800, 6000]` (own crystal near x=5900, "increasing x" = toward own crystal — the *opposite* relative direction), the same raw `dx` sequence produces **non-mirrored** fallback positions for the two colors (e.g. attempt 1: blue retreats toward its own crystal, red advances toward the front). Patching this to `dxSign = isBlue ? 1 : -1` makes `chooseBuildPosition` exactly mirror-symmetric (verified: `mirror(blue_cx(attempt)) == red_cx(attempt)` for all 16 attempts). **Result of the symmetric-patch experiment: 10-20-0 (blue 33%, red 67%)** — fully reproducible (re-ran seed 1 twice, byte-identical, entity counts 18v19 vs baseline 26v10). This is a ~40-point swing — by far the largest effect found in this investigation — but it **overshoots past 40-60% and flips direction** rather than landing near 50/50. See H6 below for what this implies.

### C.2 — Live hypotheses, in priority order

Identified by code inspection 2026-06-10. **Update 2026-06-10: experiments C.3 #1 and #2 ruled out H1/H3 and downgraded H2 to a minor contributor** (see C.1 #10, #11). The dominant ~75/25 skew is geometric and survives elimination of both id/order-coupling AND grid binning. Remaining suspects:

- ~~**H1 — Sequential collision resolution**~~ — RULED OUT via C.3 #1: pair-resolution order is id-coupled, and outcomes are invariant to id assignment.
- **H2 — Spatial-grid binning** — MINOR, NOT DOMINANT via C.3 #2: collapsing to a single cell gave 23-7-0 (vs 22-8-0), only 3/30 seeds flipped. Real but small; does not explain the bulk of the skew.
- ~~**H3 — Map-insertion iteration order**~~ — RULED OUT via C.3 #1 (same experiment swaps Map-insertion order).
- **H4 — Floating-point mirror asymmetry** (`x − v` vs `(W−x) + v` round differently). Real, but FP noise should average out over 30 seeds rather than produce a stable ~75/25 — treat as noise floor, not as the cause. (Could explain the H2 seed-flips, though — borderline ticks nudged across a threshold by the changed FP path.)
- **H5 — Unaudited left/right-asymmetric code.** CONFIRMED as a major lever via C.1 #12: `chooseBuildPosition`'s fallback-offset `dx` is unmirrored, and naively mirroring it swings the win rate ~40 points (blue 73% → red 67%). All other `isBlue ? ... : ...` branches and static map constants were swept and check out as symmetric (see C.1 #12's "other candidates" — observation.ts, actionSpace.ts xZone bands, movement edge-clamps, buildingValidation.ts, combat/gathering/repair/visibility all use relative `dist()`). H5 is **real but evidently not the only asymmetry** — see H6.
- **H6 — Multiple compensating asymmetries (NEW, leading hypothesis).** The naive `chooseBuildPosition` mirror-fix didn't land near 50/50, it *overshot to the opposite side* (red 67%). A single isolated bug, once fixed, should move the result toward 50/50 and stop — overshoot-and-flip is the signature of **fixing one asymmetry that was partially cancelling against at least one other, still-undiscovered asymmetry that favors red**. The original 73/27-blue is therefore plausibly the *net* of ≥2 opposing biases (e.g. H5 favoring blue by a lot, something else favoring red by a bit less). This reframes the problem: one-at-a-time "find an asymmetry, flip it, re-measure 30 seeds" is now a whack-a-mole search with overshoot risk on each move. The mirror-invariance property test (C.3, was #4 now #5) is the right tool here because it enumerates *all* asymmetries in one pass instead of finding them one swing at a time.

### C.3 — Decisive experiments (cheapest first)

Each is standalone; run the same 30-seed rush_medium-mirror protocol after each (`headless` harness, seeds 1–30; baseline to beat: blue 22-8-0).

1. ✅ **Creation-order swap — DONE 2026-06-10.** Result: blue kept 73% with byte-identical per-seed outcomes. Bias is geometric, not order-coupled. See C.1 #10.
2. ✅ **Single-cell grid — DONE 2026-06-10.** Result: 23-7-0 (vs 22-8-0 baseline), only 3/30 seeds flipped. H2 is a minor contributor, not the dominant cause. See C.1 #11.
3. ✅ **Absolute-x asymmetry sweep — DONE 2026-06-10.** Found `chooseBuildPosition`'s unmirrored fallback `dx` (H5, large effect: naive mirror-fix → 10-20-0, blue 33%/red 67%, ~40-pt swing but overshoots past 50/50 in the *opposite* direction). Swept all other `isBlue ? : ` branches, static map constants, edge-clamps — all check out symmetric. See C.1 #12, H5/H6.
4. **Mirror-invariance property test (half a day, NOW THE TOP PRIORITY — see H6).** Because the H5 fix overshot to red-favored rather than landing near 50/50, there is evidence of **≥2 compensating asymmetries**, not one. Write `mirrorState(match)`: flip all `x → mapWidth − x`, swap player slots/ownership, remap ids symmetrically (id-remap can likely be skipped — C.1 #10 proved id assignment doesn't matter). Property: `tick(mirror(s)) ≈ mirror(tick(s))` (epsilon for FP, H4). Drive it from states sampled out of a real mirror match (including post-build-fallback states, since H5 lives in action *selection*, not the engine tick — the harness/headless layer needs its own mirror-invariance check, e.g. `chooseBuildPosition(blue, ...)` mirrored == `chooseBuildPosition(red, ...)` for the same mirrored match state) and assert per system (movement / combat / gathering / construction / **action-space build placement**) — the first system that violates the invariant *is* a culprit; **keep going after the first hit**, since H6 implies there are more. This becomes a permanent regression test for criterion 4 and for any future engine change.
5. **Buffered collision pushes (~1 h, low priority / likely skip).** H1 ruled out; would only address the small H2 seed-flip noise (C.1 #11). Not worth doing unless #4 specifically implicates Gauss-Seidel ordering.
6. **Tick-divergence trace (fallback).** Per tick, compare blue's state against red's mirrored state (unit count, total HP, resources, Σ|x − (W−x′)|); log the first tick the divergence exceeds FP noise, then bisect into that tick's system calls. More labour than #4 for less reusable output — only if #4 is impractical.

**On the H5 fix itself:** do not land the `dxSign = isBlue ? 1 : -1` patch as-is — it was a probe that overshot to red-favored (10-20-0). A real fix should come out of the #4 property test (which will reveal the *other* asymmetry/asymmetries too), so all of them can be fixed and verified together with one balance-matrix re-run, rather than landing partial fixes that individually make criterion 4 worse.

### C.4 — Exit condition & process

- Criterion 4 passes when all three mirror pairings (rush_medium, rush_weak, macro) land in 40–60% over ≥30 seeds. Re-measure **all three**, not just rush_medium — a fix for H1/H2 affects every matchup.
- Any engine fix here follows the standard rules: R1 version bump, R2 rebuild, R7 one-commit-per-task (`fix(1.3): …`), R10 diary entry, and re-run the full criteria 1/2/3/5 matrix afterwards — collision/grid changes can shift *all* balance numbers, not just mirrors.
- If experiments 1–3 all leave 73/27 untouched, do **not** keep guessing: go straight to the invariance test (#4). Three null results would mean the mental model is wrong somewhere, and only the property test localises bugs you haven't hypothesised.
