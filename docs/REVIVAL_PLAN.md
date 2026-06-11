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

> **⚠️ Criteria AMENDED 2026-06-11** (stop clause was invoked; decision ratified per user direction — full rationale in `docs/balance/FINDINGS.md` §Decision). Evaluate Task 1.3 against these amended forms, not the original list above:
> - **Criterion 2 (amended):** `macro` beats `rush_medium` ≥30% with that pairing's timeout rate <30%. The `turtle` leg is **removed** — turtle is pure-defense by design (never attacks); its only possible "win" vs sustained offense is the timeout tiebreak, making the original leg mathematically incompatible with criterion 5 (structural proof in FINDINGS.md). Already passes on the v0.5.3 matrix (46%/46%, 0 timeouts).
> - **Criterion 5 (amended):** <30% timeout in every **rush-family vs non-rush** pairing. Pairings within {idle, passive, turtle, macro, heavy} are excluded by construction (no sustained offense on either side — unsatisfiable as originally written). The 4 rush-family internal attrition pairings (70–82% timeout) are accepted as **known issue KI-1**, revisit at Phase 3 eval if the agent learns to stall.
> - **Task 1.4 corollary:** `passiveWinThreshold` stays 4500 — the >30% resource-win pairings are all turtle-vs-weak/passive, the resource win working as intended; raising the threshold would regress criterion 5.
> - **Options rejected:** giving turtle counter-offense (redundant with `macro`, destroys the pure-defense reference, re-opens tuning) and changing the tiebreak/`maxTicks` (blast radius over passing criteria; longer episodes worsen the Phase 2 γ-horizon problem).

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
| 1.3 | Balance iterations to acceptance criteria | matrix in docs/balance/ | ✅ |
| 1.4 | Resource win is a real win | matrix resource_win rate | ✅ |
| P1 | Phase 1 diary entry (matrices + lever reasoning) | entry in ML_BOT_ACTION_PLAN.md §12 | ✅ |
| 2.1 | decision_interval k=8 in runners/env/trainer | smoke run; ep lengths ÷8 | ✅ |
| 2.2 | Rewards rescaled to ±1; resource/timeout wins count | reward_mean ∈ [−1.3, 1.3] | ✅ |
| 2.3 | γ=0.99, num_steps=256, LR guard | smoke run | ✅ |
| 2.4 | Stage changes at update boundaries | forced-promotion test | ⬜ |
| 2.5 | BC label off-by-one fix | BC accuracy gate | ⬜ |
| P2 | Phase 2 diary entry + ML_AGENT.md §4/§8 in sync | docs match code | ⬜ |
| 3.1 | Re-record BC demos (k=8, expert fixes) | BC sanity gates | ⬜ |
| 3.2 | Curriculum run with running diary | stage log + Reflections in diary | ⬜ |
| 3.3 | Eval gates → ship v0.5.0-ML | eval table vs gates; release notes | ⬜ |

**⚠️ Task 0.5 deviation:** The plan specified `tsc -p headless/tsconfig.build.json` as the build command. This fails because headless/src imports server/ and shared/ via relative paths, violating the rootDir constraint. Used esbuild instead (`npm run build:headless`). Staleness guard and dist rebuild both work correctly with esbuild. The Appendix A command cheat sheet (`npm run build:headless`) remains correct.

**Task 1.3, criterion 4 RESOLVED (v0.5.3-ML, 2026-06-10):** rush_medium mirror matches originally measured 73/27 (22-8-0 over 30 seeds), outside the 40-60% target. Root cause: `chooseBuildPosition`'s 16-attempt fallback offset (`headless/src/actionSpace.ts`) was unmirrored (H5). The `dxSign = isBlue ? 1 : -1` fix is now **landed** (v0.5.3-ML). All three mirror pairings measure within 40-60%: rush_medium 47% (100 fresh seeds 31-130; pooled seeds 1-130 = 43.8%), rush_weak 56.7% (30 seeds), macro 46.7% (30 seeds). **Criterion 4 PASSES.** Task 1.3 remains 🔄 — it's a separate, larger task (the 9-bot criteria-1/2/3/5 matrix, Task 1.1's harness re-run under v0.5.3-ML with H5 applied). See `docs/ML_BOT_ACTION_PLAN.md`, 2026-06-10 Iteration 7 entry, and Appendix C (now **CLOSED**) for full details.

**Task 1.3, full matrix run (v0.5.3-ML, 2026-06-11, Iteration 8):** ran the full 9-bot/50-match acceptance matrix (`docs/balance/matrix_v0.5.3_task1.3.json`, 4050 matches). Criteria 1 and 3 **PASS**. Criterion 2 **FAILS**: `macro` beats `rush_medium` 46%/46% (passes), but `turtle` is 0/100 vs `rush_medium` (turtle has zero offense — pure turret-wall bot, loses by combat ~tick 5100 every game). Criterion 5 **FAILS**: 14/81 pairings ≥30% timeout (4 are `idle`/`passive`-only pairings that can never resolve by design; 10 are "real" pairings including the `rush_medium`/`rush` mirrors at 70-82% and `turtle`/`macro`/`heavy` cross-pairs at 98-100%, likely the same root cause as criterion 2's `turtle` failure). Iteration 3 of the tuning loop is now in progress — see `docs/ML_BOT_ACTION_PLAN.md` Iteration 8 for full detail and next-lever plan (`MediumRushBot.FIRST_PUSH_TICK 200→300`, next in the plan's ordered lever list).

**Task 1.3, line 244 stop clause invoked (v0.5.4-ML, 2026-06-11, Iterations 9-10): TUNING LOOP STOPPED, `docs/balance/FINDINGS.md` written.** Applied the remaining two of REVIVAL_PLAN's 4 explicit "further levers" (`FIRST_PUSH_TICK` 200→300, crystal slow-regen +0.05 HP/tick within 300px) — combined with iteration 2's turret/skirmisher cost changes, **all 4 listed levers are now applied with a measured combined effect of exactly zero** on `turtle` vs `rush_medium` (still 0/100). A further probe (`TurtleBot.TURRET_CAP` 3→5→7, not in REVIVAL_PLAN's list, reverted before commit) found that `turtle`'s only win path vs `rush_medium` is the timeout-tiebreak — win rate and criterion-5 timeout rate for this pairing move together 1:1 (0%/0% → 12%/12% → 92%/95%), so **no value can satisfy criterion 2 (≥30% wins) without violating criterion 5 (<30% timeout) on the same pairing**. This is iteration 5 of ~6, with the explicit lever list exhausted and a clean structural proof that further numeric tuning cannot close criterion 2's `turtle` leg. Per line 244, **stopping here — Phase 2 NOT started**. Both iteration-3 levers (`FIRST_PUSH_TICK`, crystal regen) are kept (spec-compliant, no regressions). See `docs/balance/FINDINGS.md` for the full root-cause analysis and the human/design decisions needed to proceed, and `docs/ML_BOT_ACTION_PLAN.md` Iterations 9-10 for full detail.

**Task 1.3, decision ratified (2026-06-11): acceptance criteria AMENDED, path to Phase 2 unblocked.** Per user direction ("advise on the best path, update plan documentation accordingly"), FINDINGS.md options 2+4 were adopted and options 1/3 rejected — full rationale in `docs/balance/FINDINGS.md` §Decision, amended criteria text in the Task 1.3 amendment block above (criterion 2 drops the `turtle` leg, criterion 5 is scoped to rush-vs-non-rush pairings with KI-1 accepted for rush-internal attrition; `passiveWinThreshold` stays 4500). Under the amended criteria the v0.5.3 matrix **passes everything** — the remaining gate is one **confirmation matrix run under v0.5.4-ML** (the v0.5.3 matrix predates `FIRST_PUSH_TICK`=300/crystal-regen; both measured at zero effect on targeted pairings, so a pass is expected). Next agent: follow the 6-step handoff checklist at the end of FINDINGS.md §Decision — confirmation matrix → Phase 1 exit (line 250) → Phase 2 Task 2.1. No code changed in this decision commit (docs only, no version bump).

**Task 1.3/Phase 1 EXIT (v0.5.4-ML, 2026-06-11, Iteration 12):** ran the confirmation matrix (`docs/balance/matrix_v0.5.4_task1.3_confirm.json`, 4050 matches, 50/pair). **All 5 amended criteria PASS**: criterion 1 (every bot loses ≥20% to ≥1 other) ✅; criterion 2 amended (`macro` vs `rush_medium` 48% combined, 0% timeout) ✅; criterion 3 (`rush_medium` vs `rush_weak_medium` 100%) ✅; criterion 4 (mirrors: rush_medium 46%, rush_weak 40%, macro 48% — all in 40-60%) ✅; criterion 5 amended (worst rush-family-vs-non-rush timeout = 20%, heavy-vs-rush) ✅. KI-1 (rush-internal attrition, 68-84% timeout) and the Task 1.4 corollary (`passiveWinThreshold` stays 4500, turtle resource-win 82-86% vs idle/passive/rush_weak/rush_weak_medium) both confirmed unchanged from v0.5.3. Notable finding: v0.5.3's full matrix had `macro` mirror at 66% (outside the criterion-4 band, never previously flagged because criteria 2/5 already failed); v0.5.4 lands at 48% — both macro-mirror values are 100% timeout-tiebreak-resolved, and the swing is attributable to the crystal-regen change (Iteration 9) shifting the HP%-differential distribution at tick 6000. `npm test` 470/470. **Phase 1 exit criteria (line 256) all satisfied**: matrix archived in `docs/balance/`, engine tests green, `0.5.4-ML` balance snapshot already recorded (Iteration 9-10), R10 diary entry written (Iteration 12), draft release notes drafted there. No version bump (R1 n/a — docs/matrix-archive only). Full before/after table and draft release notes in `docs/ML_BOT_ACTION_PLAN.md` Iteration 12. **Phase 2 Task 2.1 (frame skip) is next.**

**Task 2.1 DONE (v0.5.5-ML, 2026-06-11, Iteration 13):** implemented frame skip (`decision_interval`, default k=8) across all four files: `headless/src/stdioVecRunner.ts` (`stepSlot()` now loops k ticks per decision — blue macro-action applied once, red bot acts every tick, `computeReward()` accumulated per tick with `prevBlueObs` updated each tick for exact crystal-delta/milestone semantics, `break` on `done`), `training/env/crystalfront_vec_env.py` (`decision_interval` constructor param, sent in `reset_all`), `training/ppo/train.py` (`Config.decision_interval: int = 8`, run-banner line, all 20 `CURRICULUM` `max_steps` values divided by 4), and `headless/src/stdioRunner.ts` BC path (same k-tick loop; demo mode now applies the scripted blue bot's **full** action list every tick — fixing the "lobotomised expert" defect — and records `demoAction` as the first non-noop action issued anywhere in the window, else noop). `npm run build:headless` clean, `npm test` 470/470, `python -m training.test_env` passes (k=1 default unchanged). Verified the k=1↔k=8 reward-accumulation equivalence directly: vs `idle` (seed 42, max_ticks 6000), k=1 gives 6000 decisions/6000 ticks and k=8 gives 750 decisions/6000 ticks, with **identical** total reward (−106.0) in both — confirming per-tick accumulation preserves exact semantics. BC-path k=8 verified separately: tick deltas are 8 per decision (4 on the final partial window when `done` fires mid-window), and `demoAction` is non-zero far more often (69/403 ≈ 17%) than the old single-tick k=1 sampling (15/1001 ≈ 1.5%), consistent with the "lobotomised expert" fix. 1k-decision smoke training run (`--total_timesteps 20000 --num_envs 4 --vec_size 2 --decision_interval 8 --opponent idle`, CPU, no-compile) completed cleanly. Version bumped to `0.5.5-ML` across all 5 `package.json` (R1); no `BALANCE_HISTORY` entry needed — Task 2.1 makes zero engine/replay-affecting changes, and `DEFAULT_CONFIG`'s tracked fields already equal the `0.5.4-ML` snapshot, so a `0.5.5-ML` replay falls back to `DEFAULT_CONFIG` with identical values. **Phase 2 Task 2.2 (reward rescale) is next.**

**Task 2.2 DONE (v0.5.6-ML, 2026-06-11, Iteration 14):** rescaled every constant in `headless/src/reward.ts` by ÷100 per the table in this section — crystal damage dealt/taken `±5.0/±2.0 × Δfrac` → `±0.05/±0.02 × Δfrac`; first barracks `+10.0` → `+0.10`; combat-unit milestones 1-4 `+5/+3/+2/+1` → `+0.05/+0.03/+0.02/+0.01`; time penalty `−0.001`/tick → `−0.00001`/tick; terminal `±100.0` → `±1.0`. The terminal line's `winType !== "resource"` clause was deleted — `terminalReturn = (winner === blueId) ? 1.0 : -1.0`, with `winner === null` falling into the `-1.0` branch as a defensive fallback only (the Phase 1 timeout tiebreaker guarantees a winner). Updated the file's header-comment magnitude list to match. `headless/src/reward.ts` is the sole source of truth imported by both runners, so `stdioRunner.ts`/`stdioVecRunner.ts` needed no changes — their `warn_loss_positive_reward`/`warn_no_pressure` checks are sign-based (`> 0`), not magnitude-based, so they're scale-invariant. One incidental fix in `training/ppo/train.py`: the console diagnostic `ep_ret_mean` was `int(mean(terminal_reward_list))`, which truncated to 0 for nearly all windows once terminal rewards shrank from ±100 to ±1.0 — rescaled to `int(100 * mean(...))` so it stays on the same display scale (±100) as before. `docs/ML_AGENT.md` §4 (4.1 table, 4.2 terminal block, 4.3 history) updated to match, with a new v0.5.6-ML note. `npm run build:headless` clean, `npm test` 470/470, `python -m training.test_env` SMOKE TEST PASSED (10-step total reward = −0.0001 = 10 × −0.00001, confirming the new time penalty). Smoke training run (`--total_timesteps 20000 --num_envs 4 --vec_size 2 --decision_interval 8 --opponent idle`, CPU, no-compile, fresh random policy, 24 episodes, all 6000-tick timeouts): `game/episode_reward` = −1.06 to −0.96 (terminal −1.0 + shaping ≈ −0.06, i.e. just the new time penalty over 6000 ticks — no other shaping fired for this random policy) — well within the [−1.3, +1.3] target (would have been ≈ −106 under the old constants). `rewards/final_reward_mean` itself requires `WIN_WINDOW=100` episodes to log and wasn't reached in this short smoke run, but `game/episode_reward` is the same per-episode quantity (`finalReward = terminalReturn + episodeShaping`) and conclusively confirms the rescale. Version bumped to `0.5.6-ML` across all 5 `package.json` (R1); no `BALANCE_HISTORY` entry needed (engine/replay-affecting fields unchanged — only the RL reward signal changed). **Phase 2 Task 2.3 (PPO hyperparameters for the new MDP) is next.**

**Task 2.3 DONE (v0.5.7-ML, 2026-06-11, Iteration 15):** updated `training/ppo/train.py` `Config` defaults per the table in this section: `gamma: 0.995 → 0.99`, `num_steps: 1536 → 256`, `num_minibatches: 6 → 4` (minibatch stays 1280 with the default 20 envs × 256 steps = batch_size 5120 / 4). Updated the inline comments on these three fields to explain the new values (k=8 half-life, episode-length, and the 20×256/4 minibatch arithmetic). `gae_lambda`, `ent_coef`, `learning_rate`, and clip params left unchanged per the plan. Added the LR-anneal `max(..., 0.0)` clamp (`frac = max(1.0 - (update - 1) / num_updates, 0.0)`) so resuming past a run's `num_updates` can no longer drive the learning rate negative. Added the schedule-compression guard: right after `num_updates` is computed, if `cfg.anneal_lr` and a checkpoint was loaded and `(start_update - 1) >= 0.8 * num_updates`, print a loud `⚠️  WARNING` naming the resumed update, the new run's `num_updates`, the percentage, and suggesting either a larger `--total_timesteps` or `--no-anneal_lr`. Smoke-verified both branches: (1) fresh `--total_timesteps 20000 --num_envs 4` run (no checkpoint) — banner correctly shows `Batch size: 1024 (steps=256 × envs=4)` / `Minibatch: 256 (4 minibatches × 4 epochs)`, completed cleanly, checkpoint saved at `update=19`; (2) resumed that checkpoint with `--total_timesteps 20480` (`num_updates=20`) — warning fires (`update 19/20, 95%`), one update runs with `frac=0.05`; (3) resumed the same checkpoint with `--total_timesteps 15360` (`num_updates=15`, i.e. `start_update-1=19 > num_updates`) — warning fires (`update 19/15, 127%`), the now-empty `range(20, 16)` update loop completes without error (no negative-LR crash). `npm test` 470/470 (no TS files touched; ran for regression safety per R6). No `BALANCE_HISTORY` entry needed (PPO hyperparameters only, no engine/reward/replay change). Version bumped to `0.5.7-ML` (R1). **Phase 2 Task 2.4 (curriculum promotion at update boundaries) is next.**

---

## Appendix C — Criterion 4 (mirror-match bias): investigation guide [CLOSED, 2026-06-10, v0.5.3-ML]

**RESOLVED.** C.3 #8 (100 fresh seeds, H5 applied) landed at 47% — squarely in the 40-60% band, and pooling with the original seeds 1-30 (43.8% over 130) confirms it. **H7 does not exist**: the "67/33 red" result that motivated H6/H7 (C.1 #16) was sampling noise from a 30-seed sample (p≈0.049 under a fair game, per the Iteration 6 audit). **H5 alone fixes criterion 4** for all three mirror pairings (rush_medium 47%, rush_weak 56.7%, macro 46.7%). The `dxSign = isBlue ? 1 : -1` fix is landed in `actionSpace.ts` (v0.5.3-ML). C.3 #9 (spawn-determinization) was **not needed**. See C.1 #22 and C.4 for details. The history below (C.1 #1-21, C.2, C.3 #1-7) is preserved as the investigation record.

**The problem (historical).** In a rush_medium-vs-rush_medium mirror match, blue (slot 0, left side) won 73% (22-8-0 over 30 seeds, stable across seeds). A 50/50-symmetric game should give ~40–60%. The bias appeared **structural and deterministic**: it survived different seeds, and two principled symmetry fixes changed nothing. This appendix recorded what was ruled out and what to try next, so future work started where the last session stopped instead of repeating it.

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

13. **Initial match state is perfectly mirror-symmetric** — experiment C.3 #4 run 2026-06-10, via `headless/src/_initStateAudit.ts`. `createMatch`'s output (before any ticks) was checked against its own `mirrorState()`: every blue entity (crystal at `(100,300)`, 3 workers) has an exact mirror-image red entity (same type, `x' = mapW - x`, `y' = y`), and all 13 resource nodes (4 blue-safe, 4 red-safe, 5 contested) are exact mirror pairs. Rules out an initial-condition asymmetry as a contributor — `mirror(initial_state) == initial_state` (with colors swapped), as required for the Case-B mirror argument to apply.

14. **Engine-tick mirror-invariance (`tick(mirror(s)) ≈ mirror(tick(s))`) is clean except a bounded ≤0.5px movement noise floor (H4, CONFIRMED)** — experiment C.3 #4 run 2026-06-10, via the new `server/src/match/engine/mirror.ts` (`mirrorState`/`deepCloneMatchState`/`diffStates`) and `headless/src/mirrorAudit.ts`. Ran a full 6000-tick rush_medium mirror match (seed=1) and checked the property at every tick. **Zero** violations in economy/resourceNodes/combat/gathering/construction/repair/result for the entire match. The only violations are "movement" position diffs on a handful of skirmishers, first appearing at tick 1341 (562 occurrences total at `eps=1e-6`, e.g. `entity e32.x: 3009.1416... vs 3009.1052...`, a ~0.036px gap). Root cause: the soft-collision-resolution loop (`movement.ts`, lines ~72-107) iterates neighbor cells via `for(ddx=-1..1) for(ddy=-1..1)`; because `floor((mapW-x)/cellSize) = 119 - floor(x/cellSize)` for non-boundary `x` (mapW=6000, cellSize=50), this neighbor-cell iteration order **effectively reverses under x-mirroring**. When an entity has ≥2 collision partners in different x-neighbor cells within the same pass, the order their pushes are applied differs between `tick(mirror(s))` and `mirror(tick(s))`, producing a small but real (non-FP-noise-scale) positional difference that decays within 1-2 ticks as units separate. Swept `eps ∈ {1e-6, 0.05, 0.5}` via `headless/src/_mirrorAudit2.ts`: diffs grow slowly (up to ~0.37px by tick 1584) but **zero diffs anywhere in the 6000-tick match at `eps=0.5`**, and it never produces a single combat/gathering/construction/result-level diff. Bounded, sub-threshold (collision radii 10-30px, gather range 60px, attack ranges 150-300px) — confirmed H4-class noise floor, does not cascade, does not explain the 73/27 bias.

15. **`chooseBuildPosition` mirror-equivariance violations are 100% explained by H5, and the `dxSign = isBlue ? 1 : -1` fix makes it exactly equivariant** — experiment C.3 #4 run 2026-06-10, via `headless/src/_buildPosAudit.ts`. Against the same 6000-tick mirror match, checked `chooseBuildPosition("blue"/"red", xZone, yZone, ·)` for all 9 `xZone × yZone` combinations at every tick, comparing `chooseBuildPosition(color, ..., mirrorState(s))` against `mirror(chooseBuildPosition(otherColor(color), ..., s))`. **Before the fix:** violations in 5/9 zone combos (`near_crystal/{top,middle,bottom}`, `mid_base/middle`, `forward/middle`), starting as early as **tick 0** (the band-center for `near_crystal` is already blocked by starting workers) — every violation traces to the unmirrored fallback `dx`. **After applying the C.1 #12 `dxSign=isBlue?1:-1` patch:** **0 violations across all 9 combos over the full 6000-tick match** — `chooseBuildPosition` is now provably exactly mirror-equivariant (up to `eps=1e-6`).

16. **H5 fix re-confirmed at the 30-seed matrix level — still 10-20-0 (red 67%) — which PROVES H6 exists and narrows it to the bot-decision layer** — experiment C.3 #4 run 2026-06-10, via `headless/src/_matrixAudit.ts`. With the `dxSign=isBlue?1:-1` patch applied, re-ran the 30-seed rush_medium-mirror matrix: **10-20-0 (blue 33%, red 67%)**, byte-identical to the 2026-06-10 probe in C.1 #12. Combined with #14 and #15 (engine tick AND `chooseBuildPosition` are now BOTH proven mirror-equivariant up to a 0.5px noise floor, with the H5 fix applied), this **upgrades H6 from a hypothesis to a proven conclusion**: at least one more asymmetry exists, and — by elimination — it lives **outside `tick()` and outside `chooseBuildPosition`'s coordinate math**. The remaining candidates are the bot-DECISION layer: `MediumRushBot.step()` (`headless/src/bots/mediumRushBot.ts`) and/or the `buildObservation()` features (`headless/src/observation.ts`) and/or `resolveTargetZone`/`resolveAttackTarget`/`findNode` (`actionSpace.ts`) — functions that choose **when/whether/what** to act on, not **where** a building goes. None of these are covered by the property tests in #14/#15. Per C.3 #4's own instruction, **the H5 fix was reverted** (left at the documented baseline, no `isBlue` term) — landing it alone would regress criterion 4 from 73/27-blue to 67/33-red, and C.4 requires landing all asymmetries together with one matrix re-run. See H7 below.

17. **Direct cross-color decision-function audit (`resolveTargetZone`/`findNode`) — 4 violation classes found, but 3/4 trace to RNG state divergence (#18) and the 4th is a dead-code bug** — experiment C.3 #7 (first pass) run 2026-06-10, via `headless/src/_directSymmetryAudit.ts`. For a real 6000-tick rush_medium mirror match (seed=1), checked `f("blue", s, ·) ≈ mirrorPos(f("red", s, ·))` at every tick for `resolveTargetZone` (all 5 zones, `s` = the live match state, no `mirrorState` involved) and `findNode` (all 3 `nodeChoice`s, using each side's own crystal — an exactly-mirrored stationary point per C.1 #13 — as `nearEntity`). Results: **`resolveTargetZone/enemy_army`** and **`resolveTargetZone/defend_crystal`** first violate at **tick 430** (red has visible combat units near blue's side; blue has none visible to red yet — a real state asymmetry, not a function bug); **`findNode/nearest_safe`** first violates at **tick 2128** (blue and red pick non-mirror-paired safe nodes, downstream of diverged `remaining`/`gathererSlots` after ~2000 ticks of asymmetric gathering); **`findNode/richest_visible`** violates from **tick 0** (see #19 — confirmed dead-code bug, but unreachable). Neither `enemy_army`/`defend_crystal` zones nor `nodeChoice="nearest_contested"/"richest_visible"` are ever used by `MediumRushBot` (C.1 #8); only `resolveTargetZone("enemy_crystal",·)` and `findNode("nearest_safe",·)` are on its decision path, and `enemy_crystal` had **zero** violations over the full 6000 ticks. See #18 for why the `enemy_army`/`defend_crystal`/`nearest_safe` violations are NOT reliable evidence of an `f`-level bug.

18. **Root cause of the underlying state-level divergence (first appears tick 53): `spawnOutside` draws from independent per-slot RNG streams, a known/accepted source of single-tick noise (mirror.ts:106-107) that compounds over a match** — experiment C.3 #7 (second pass) run 2026-06-10, via `headless/src/_stateDivergenceAudit.ts` (own-side scalar features — `ownResources`, `ownLifetimeResourcesFrac`, entity-type counts, raw bot action JSON — compared blue vs red every tick; both sides start from the exact mirror-symmetric C.1 #13 state, so these *should* be identical with no mirroring needed) and `headless/src/_gatherTrace.ts` (per-tick worker/gatherer-slot/node trace). Found: **first divergence at tick 53** (`ownResources`: blue=39 vs red=40, growing thereafter — 5947/6000 ticks diverge). Traced to: at tick ~20 both sides' 4th worker (first `train_worker` completion) spawns via `spawnOutside()` (`server/src/match/matchEngine.ts:1492-1500`), which draws an isotropic random angle from `match.rng[playerIdx]` — `rng[0]` (blue, seed `s`) and `rng[1]` (red, seed `s^0x9e3779b9`) are independently-seeded streams, so the two new workers' spawn offsets are **not mirror images** of each other (seed=1: blue's new worker `e23` spawns 207.7px from its assigned gather node `e11`; red's `e22` spawns 157.8px from its mirror-paired node `e15`). (Units note: the tick-53 gap is blue=39 vs red=40 in raw resources, equivalently 0.039 vs 0.040 in the normalized `ownResources` observation feature — the diary entry uses the normalized form.) Red's worker reaches its 2nd gather node ~29 ticks after assignment; blue's still hasn't arrived 38+ ticks after assignment. Net effect: red gathers from 2 nodes (~1.32 resources/tick) while blue still gathers from 1 (~0.99/tick) for an extended stretch — this is the entire tick-53 `ownResources` gap, and very plausibly the root state-level cause of the tick-430 and tick-2128 violations in #17. **This is exactly the "non-biasing" `spawnOutside` divergence already documented in `mirror.ts:106-107`** (per-seed it's symmetric noise with no inherent direction — for a different seed the head-start could go to blue instead) — so it is **unlikely by itself to be the consistent 73/27 bias**, but it means: (a) `_stateDivergenceAudit`'s "first divergence tick" and `_directSymmetryAudit`'s cross-color comparisons **cannot cleanly separate "f has a bug" from "f is correctly answering a different (already-diverged) question for blue vs red"**; (b) any future frozen-state test for H7 must hold the *world state* fixed and only vary *color*, not compare blue's-real-state to red's-real-state.

19. **`findNode("richest_visible", ...)` has no side filter — confirmed bug, but unreachable (do not fix as part of H5+H7)** — `headless/src/actionSpace.ts:469-471`: `availableNodes.sort((a,b) => b.remaining - a.remaining)[0]` has no `isBlue`/`mid` filter at all, unlike `nearest_safe`/`nearest_contested`. At tick 0 all nodes tie on `remaining`, so the stable sort returns the **same node id** for both blue's and red's calls (#17). Real bug, but `nodeChoice="richest_visible"` is never produced by `MediumRushBot` (or any bot exercising criterion 4's mirror matchups, per C.1 #8) — low priority, track separately from the H5+H7 landing.

20. **The originally-specced "full stateful lockstep" variant of C.3 #7 is methodologically INVALID for `findNode`/`MediumRushBot.init` (and likely `resolveTargetZone`'s `defend_crystal`/`enemy_army` branches) — abandoned, do not build it.** `mirrorState(s)` swaps `players[0]↔players[1]` (hence `economy`/`rng`) but leaves entity `ownerId`s unchanged while mirroring their positions. `findNode(match, playerId, ...)` and `MediumRushBot.init(playerId, match)` both derive `isBlue` via `match.players.findIndex(p=>p?.playerId===playerId)?.color==="blue"`. Worked example: drive `m=mirrorState(s)` with the SAME string ids as `s` — `playerId="headless-blue"` now sits at `m.players[1]` (slots swapped), and `m.players[1].color==="blue"` → `isBlue=true` → `nearest_safe`/`safeNodes` filter `n.x<mid` (m's left half). But `ownerId="headless-blue"`'s entities (mirrored from `s`'s left half, where `players[0]` always lives per `createMap`'s fixed `blueCrystal`/`redCrystal` assignment, C.1 #13) are now at `x>mid` (m's right half). So in `m`, `isBlue`'s side-filter and `"headless-blue"`'s actual entity-side are **anti-correlated** — a mismatch that produces "violations" against `mirror(action(·,s,"headless-red"))` for **correct** code, not just buggy code. This is the SAME root cause as the already-documented "frozen single-color `mirrorState`" invalidity in H7/C.2, generalized: it's not "frozen vs lockstep" that matters, it's that `mirrorState` decouples `playerId/.color ↔ entity-position-side`, which any `match.players`-lookup-based `isBlue` implicitly assumes is fixed. `chooseBuildPosition` (C.1 #15) is **unaffected**, because it takes `isBlue` as a direct caller-supplied boolean (no `match.players` lookup) and only consults `match.entities` for position-based blocking, which mirrors correctly (reflection is an isometry, so `dist(mirror(a),mirror(b))=dist(a,b)`) — that's why its `mirrorState`-based audit (C.1 #15) was valid. **Conclusion: `_directSymmetryAudit.ts` (#17, cross-color/same-state/no-`mirrorState`) is the correct — and now COMPLETE — form of C.3 #7 for `resolveTargetZone`/`findNode`. The "full lockstep" variant described in the prior C.3 #7 writeup is abandoned.**

21. **`getLegalActions` is side-blind; `expandMacroAction`'s unit-selection logic is order-coupled and already constrained by #10** — audited 2026-06-10. `headless/src/legalActions.ts` declares `isBlue` (line 31) but never uses it, and contains no positional or slot-indexed logic at all (no `.x`/`mid`/`mapWidth`/`players[0|1]` reads) — legality is computed symmetrically. The engine's per-seed RNG has exactly **two** gameplay consumers, both `spawnOutside` (`matchEngine.ts:463` worker-train, `:1157` unit-spawn); the only other seed consumer is the timeout tiebreaker's `match.seed % 2` coin flip (`matchEngine.ts:~1062`), which never fires in kill-decided matches. `expandMacroAction`'s remaining unaudited logic is unit SELECTION (`idleWorkers.slice(0, count)` in `assign_workers`, per-unit nearest-target claiming in `attack_move`): the distance math is mirror-invariant (isometry), and the array-order/id tie-breaking is exactly what C.3 #1 proved outcome-invariant (byte-identical under creation-order swap). Neither is a plausible H7 host.

22. **C.3 #8 result: H7 does not exist — H5 alone resolves criterion 4 for all three mirror pairings. RESOLVED, 2026-06-10, v0.5.3-ML.** Re-applied the H5 fix (`dxSign = isBlue ? 1 : -1`, `actionSpace.ts:336`), parameterized `_matrixAudit.ts` with a `[startSeed endSeed botName]` argv interface, and ran the rush_medium mirror matrix on **100 fresh seeds (31-130)**: **47-53-0 (blue 47.0%)** — squarely inside 40-60%. Pooling with the original seeds 1-30 (which reproduced the documented 10-20-0 byte-identically, confirming the same fix): **57-73-0 over 130 seeds = 43.8% blue**, also inside 40-60%. Per the C.3 #8 decision rule, this means **H7 never existed** — the post-H5 10-20-0/30-seed result (C.1 #16) that "proved" H6/H7 was the p≈0.049 sampling-noise artifact flagged in the Iteration 6 audit (C.2 H7 caveat). Re-measured the other two mirror pairings with H5 applied (30 seeds each, `_matrixAudit.ts` extended to support `rush_weak`/`macro` bot selection): **rush_weak 17-13-0 (56.7% blue)**, **macro 14-16-0 (46.7% blue)** — both inside 40-60%. **Landed H5**: `npm test` 467/467 passing both before and after the fix (the fix only changes `chooseBuildPosition`'s fallback-offset sign, not its shape), `npm run build:headless` rebuilt `dist`, all 5 `package.json` bumped `0.5.2-ML` → `0.5.3-ML` (R1 — balance-affecting engine fix used by every bot's `build` macro-action). C.3 #9 (spawn-determinization) is **not needed**. Criterion 4 PASSES; this appendix is closed.

### C.2 — Live hypotheses, in priority order

Identified by code inspection 2026-06-10. **Update 2026-06-10: experiments C.3 #1 and #2 ruled out H1/H3 and downgraded H2 to a minor contributor** (see C.1 #10, #11). The dominant ~75/25 skew is geometric and survives elimination of both id/order-coupling AND grid binning. Remaining suspects:

- ~~**H1 — Sequential collision resolution**~~ — RULED OUT via C.3 #1: pair-resolution order is id-coupled, and outcomes are invariant to id assignment.
- **H2 — Spatial-grid binning** — MINOR, NOT DOMINANT via C.3 #2: collapsing to a single cell gave 23-7-0 (vs 22-8-0), only 3/30 seeds flipped. Real but small; does not explain the bulk of the skew.
- ~~**H3 — Map-insertion iteration order**~~ — RULED OUT via C.3 #1 (same experiment swaps Map-insertion order).
- ~~**H4 — Floating-point mirror asymmetry**~~ — CONFIRMED MINOR/NOISE-FLOOR via C.3 #4 (see C.1 #14): a real, ≤0.5px bounded movement-position drift caused by collision-resolution iteration order reversing under x-mirroring. Never cascades to combat/gathering/construction/result over a full 6000-tick match. Does not explain the 73/27 bias.
- ✅ **H5 — `chooseBuildPosition` fallback-offset `dx` unmirrored. LANDED (v0.5.3-ML).** The `dxSign = isBlue ? 1 : -1` fix (`actionSpace.ts:336`) was property-test-proven exactly mirror-equivariant (C.1 #15: 0/9 zone-combo violations over a full 6000-tick match, vs violations in 5/9 combos before the fix, including at tick 0) and is now landed. All other `isBlue ? ... : ...` branches and static map constants in `actionSpace.ts`/`observation.ts`/`gameBalance.ts` were swept and check out as symmetric.
- ~~**H6 — Multiple compensating asymmetries**~~ — RETRACTED (C.1 #22). C.1 #16's "10-20-0, still 67% red after H5" was a 30-seed sample that's only p≈0.049 under a fair game (Iteration 6 audit). C.3 #8 (100 fresh seeds + pooled 130) landed at 43.8-47% — H6 was never real; the apparent post-H5 skew was sampling noise.
- ~~**H7 — Bot-decision-layer asymmetry**~~ — RESOLVED AS NON-EXISTENT (C.1 #22, C.3 #8). All audited functions (`tick()` C.1 #14, `chooseBuildPosition` C.1 #15, `resolveTargetZone`/`findNode` C.1 #17, `getLegalActions`/`expandMacroAction` C.1 #21) were correctly clean — there was nothing left to find because H6 (the premise for H7) was a statistical artifact. H5 alone resolves criterion 4 for all three mirror pairings. C.3 #9 (spawn-determinization) was not needed.

### C.3 — Decisive experiments (cheapest first)

Each is standalone; run the same 30-seed rush_medium-mirror protocol after each (`headless` harness, seeds 1–30; baseline to beat: blue 22-8-0).

1. ✅ **Creation-order swap — DONE 2026-06-10.** Result: blue kept 73% with byte-identical per-seed outcomes. Bias is geometric, not order-coupled. See C.1 #10.
2. ✅ **Single-cell grid — DONE 2026-06-10.** Result: 23-7-0 (vs 22-8-0 baseline), only 3/30 seeds flipped. H2 is a minor contributor, not the dominant cause. See C.1 #11.
3. ✅ **Absolute-x asymmetry sweep — DONE 2026-06-10.** Found `chooseBuildPosition`'s unmirrored fallback `dx` (H5, large effect: naive mirror-fix → 10-20-0, blue 33%/red 67%, ~40-pt swing but overshoots past 50/50 in the *opposite* direction). Swept all other `isBlue ? : ` branches, static map constants, edge-clamps — all check out symmetric. See C.1 #12, H5/H6.
4. ✅ **Mirror-invariance property test — DONE 2026-06-10.** Built `server/src/match/engine/mirror.ts` (`mirrorState`/`deepCloneMatchState`/`diffStates`, Case-B: x-reflect + swap player slots 0/1 incl. economy/rng, ids/ownerId/idGen/seed/tick untouched) plus three audit scripts (`headless/src/mirrorAudit.ts`, `_mirrorAudit2.ts`, `_buildPosAudit.ts`, `_initStateAudit.ts`, `_matrixAudit.ts`). Results: (a) `tick(mirror(s))≈mirror(tick(s))` clean for a full 6000-tick match except a bounded ≤0.5px movement noise floor (C.1 #14, confirms/closes H4); (b) `chooseBuildPosition` violations are 100% explained by H5 and the `dxSign=isBlue?1:-1` fix makes it exactly equivariant (C.1 #15); (c) initial state is perfectly mirror-symmetric (C.1 #13); (d) re-running the 30-seed matrix WITH the H5 fix still gives 10-20-0/red-67% (C.1 #16) — **proves H6** and narrows it to the bot-decision layer (new H7). Net: H5 fix is ready-but-blocked; one more asymmetry remains, outside `tick()` and `chooseBuildPosition`.
5. **Buffered collision pushes (~1 h, low priority / likely skip).** H1 ruled out; would only address the small H2 seed-flip noise (C.1 #11). Not worth doing unless #4 specifically implicates Gauss-Seidel ordering.
6. ✅ **Tick-divergence trace — DONE 2026-06-10.** `headless/src/_stateDivergenceAudit.ts`: first own-side scalar divergence at tick 53 (`ownResources`), root-caused via `headless/src/_gatherTrace.ts`. See C.1 #18. Did not by itself surface H7 (the cause is the already-accepted `spawnOutside` RNG-stream noise, not a new asymmetry) — superseded by #7.
7. ✅⚠️ **Bot-decision-layer mirror-equivariance test — DONE for `resolveTargetZone`/`findNode` (C.1 #17, the valid form, now complete); the originally-specced "full lockstep" variant is INVALID and abandoned (C.1 #20); H7 still open in `MediumRushBot.step()`/`buildObservation()`'s per-entity features — next step.** `_directSymmetryAudit.ts` (cross-color, same live state `s`, no `mirrorState`) checked `f("blue",s)≈mirrorPos(f("red",s))` for `resolveTargetZone`/`findNode` and is the methodologically-sound form of this test — it has run to completion (C.1 #17): on-path functions (`enemy_crystal`/`nearest_safe`) clean pre-tick-2128, off-path violations explained by RNG divergence (#18) or dead code (#19). The "two bot instances + `mirrorState`-linked trajectory `m`" design originally specced here was re-examined and found **invalid**: `mirrorState`'s slot-swap decouples `playerId/.color` from `ownerId`'s actual entity-side, breaking `findNode`'s and `MediumRushBot.init`'s `match.players`-lookup-based `isBlue` (C.1 #20 has the worked example) — **do not build it**. **Remaining H7 search surface**: `MediumRushBot.step()`'s own `xNorm`/`safeNodes`/`workerTarget` logic and `buildObservation()`'s per-entity/per-node features — neither has been checked by any audit. ~~Proposed next test: ticks-0-52 per-entity audit~~ — **superseded by #8/#9 (2026-06-10 audit)**: the 0-52 window cannot see combat-era decision asymmetries (`attack_move` starts at tick ≥ 200), and the much cheaper #8 must run first anyway, since H7's *existence* is itself statistically unconfirmed (see the H7 caveat in C.2).

8. ✅ **Fresh-seed replication of the post-H5 matrix — DONE 2026-06-10, RESOLVED.** Applied H5, parameterized `_matrixAudit.ts`'s seed range, ran rush_medium mirror on 100 fresh seeds (31-130): **47-53-0 (47.0% blue)** — inside 40-60%. Pooled with seeds 1-30 (10-20-0): **57-73-0 over 130 (43.8% blue)** — also inside 40-60%. **Decision: no H7.** H5 landed; rush_weak (56.7%/30 seeds) and macro (46.7%/30 seeds) mirrors also re-measured inside 40-60%. See C.1 #22.

9. ~~**Symmetric-by-construction mirror match (spawn determinization)**~~ — **NOT NEEDED.** #8 came back inside the band, so per the decision rule this experiment is skipped entirely.

**On the H5 fix itself:** the fix (`dxSign = isBlue ? 1 : -1`, applied+reverted during C.3 #4) is algebraically and property-test-proven correct (C.1 #15) — do not re-derive it. It is **ready to land together with the H7 fix** once #7 is done; landing it alone reproduces the known overshoot (10-20-0, red 67%, C.1 #16).

### C.4 — Exit condition & process

- ✅ **CLOSED 2026-06-10 (v0.5.3-ML).** Criterion 4 passes: rush_medium 47.0% (100 fresh seeds 31-130, pooled 1-130 = 43.8%), rush_weak 56.7% (30 seeds), macro 46.7% (30 seeds) — all within 40-60%. H5 (`dxSign = isBlue ? 1 : -1` in `chooseBuildPosition`'s fallback, `actionSpace.ts:336`) is the complete fix; H6/H7 were never real (C.1 #22). `npm test` 467/467. v0.5.3-ML. Next: Task 1.3's full criteria-1/2/3/5 matrix (separate, larger task — Task 1.1's 9-bot harness re-run with H5 applied), then Phase 2.
- Criterion 4 passes when all three mirror pairings (rush_medium, rush_weak, macro) land in 40–60% over ≥30 seeds. Re-measure **all three**, not just rush_medium — a fix for H1/H2 affects every matchup.
- Any engine fix here follows the standard rules: R1 version bump, R2 rebuild, R7 one-commit-per-task (`fix(1.3): …`), R10 diary entry, and re-run the full criteria 1/2/3/5 matrix afterwards — collision/grid changes can shift *all* balance numbers, not just mirrors.
- If experiments 1–3 all leave 73/27 untouched, do **not** keep guessing: go straight to the invariance test (#4). Three null results would mean the mental model is wrong somewhere, and only the property test localises bugs you haven't hypothesised.
- **Status 2026-06-10 (post C.3 #4):** `tick()` and `chooseBuildPosition` are both proven mirror-equivariant (mod a 0.5px noise floor); H5's fix is ready but blocked. Next step is C.3 #7 (bot-decision-layer test) to find H7, then land H5+H7 together with one 30-seed-per-pairing matrix re-run across rush_medium/rush_weak/macro.
- **Status 2026-06-10 (post C.3 #7 first pass):** Built and ran `_directSymmetryAudit.ts` (cross-color, live-trajectory `resolveTargetZone`/`findNode` equivariance) and `_stateDivergenceAudit.ts`+`_gatherTrace.ts` (own-side scalar first-divergence trace, root-caused to `spawnOutside`'s per-slot RNG streams — C.1 #17-#19). H7 is **still open**; the only `MediumRushBot`-reachable check (`enemy_crystal`/`nearest_safe`, mostly) came back clean or explainable by RNG noise, and a dead-but-unreachable bug was found in `findNode("richest_visible",...)`. The full stateful-lockstep test (C.3 #7's original spec, detailed above) remains unbuilt and is the next step. H5 fix remains ready-but-blocked; no fix landed this session.
- **Status 2026-06-10 (post C.3 #7 — methodology finalized, H7 still open):** Re-examined the "full stateful lockstep" test from the line above and found it **methodologically invalid** (C.1 #20) — `mirrorState` decouples `playerId/.color` from `ownerId`'s actual entity-side, which `findNode`'s/`MediumRushBot.init`'s `match.players`-lookup-based `isBlue` assumes is fixed; `chooseBuildPosition` (C.1 #15) was unaffected only because it takes `isBlue` directly and uses position-only (mirror-correct) blocking checks. `_directSymmetryAudit.ts` (C.1 #17, cross-color/same-state/no-`mirrorState`) is therefore the correct *and complete* form of C.3 #7 for `resolveTargetZone`/`findNode` — both clean on-path. **H7 remains open**; the untested surface narrows to `MediumRushBot.step()`'s own `xNorm`-based logic and `buildObservation()`'s per-entity/per-node features. Proposed test: a per-entity/per-node extension of `_stateDivergenceAudit.ts` restricted to ticks 0-52 (the pre-RNG-divergence window, C.1 #18) — not yet built. H5 fix remains ready-but-blocked; no fix landed this session. **This is a good checkpoint to sync with the user** before investing in new test infrastructure: the originally-specced "obvious next step" turned out to be a dead end, and the proposed replacement is a new, not-yet-validated design.
- **Path forward (2026-06-10, post-audit — CURRENT PLAN):** An independent audit of the C.3 #4-#7 iterations confirmed all findings but exposed one unexamined assumption: H7's *existence* was inferred from a 30-seed result that is only p ≈ 0.049 under a fair game (see the H7 caveat in C.2). The revised, strictly-ordered plan:
  1. **C.3 #8 first** (100 fresh seeds, H5 applied, ~30 min). If 40–60%: there is no H7 — land H5, re-measure all three mirror pairings + criteria 1/2/3/5, close this appendix.
  2. **C.3 #9 only if #8 confirms the skew** (~1–2 h). Either outcome is decisive: it clears the bot layer or makes H7 directly traceable at any tick.
  3. **Timebox: if H7 is still not localized after #9, STOP.** Criterion 4 is already user-deferred (Appendix B, Task 1.3 note). Land whatever #8/#9 proved (H5 at minimum, if supported), document, and mitigate at the eval layer instead: run all ML-bot evaluations **side-balanced** (half the matches as slot 0/left, half as slot 1/right), which neutralizes any residual side bias for training/eval purposes at near-zero cost. Then return to the mainline plan: fresh criteria-1/2/3/5 matrix under v0.5.2-ML, then Phase 2.
  - **Gate-design note for all future criterion-4 measurements:** at n=30 seeds, a *perfectly fair* game lands outside the 40–60% band ~20% of the time (binomial). Use n ≥ 100 for any pass/fail decision on criterion 4, or treat 30-seed results as screening only.
