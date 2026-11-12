# CrystalFront — Independent Diagnostic Report

**Author:** Fable (Claude) · **Date:** 2026-06-09
**Scope:** Full project review — game design/balance as a standalone, training infrastructure, and ML methodology — plus a recommended path to restart the project on sound footing.
**Method:** Read the engine, headless harness, training stack, and current docs; ran fresh bot-vs-bot experiments against the live code (results below). I did not rely on prior conclusions in the docs — several of them turn out to be built on broken instrumentation.

---

## TL;DR

The project did not stall because reinforcement learning hit a fundamental wall. It stalled because **three independent layers of defects compounded**, and the post-mortem ("gradient-sign root cause, both options exhausted, halt") was written on top of all three without knowing they existed:

1. **The training infrastructure was silently broken.** The single most important finding: **curriculum config overrides (map size, crystal HP, starting resources) are dropped on every episode autoreset** — they only ever applied to the *first* episode of each environment slot. Virtually all training, across every version since the vectorised runner was introduced, ran on the default 6000px / 1000HP / 50-resource map regardless of what stage the curriculum claimed to be running. Every conclusion drawn from "the resource slider worked", "stage X cleared at Y%", and the design of the wall stage `3a_rm_3k` is unreliable.

2. **The game, as currently balanced, is rush-dominated to a degree that makes the training target unachievable.** I ran a fresh scripted-bot round-robin: **no scripted bot in the repo beats `rush_medium`** — macro, turtle, and heavy all lose 0/20; even the full-strength `rush` manages 1/20. The "medium" opponent the agent was required to beat at ≥30–50% is, empirically, the strongest or second-strongest agent in the game. Defence does not work: turtle (the turret strategy) loses 20/20 to a mid-strength skirmisher rush. This is a *game balance wall*, not an RL wall.

3. **The MDP formulation fights PPO at every step.** One decision per 100 ms tick across 5,000–6,000-tick episodes, with γ=0.995 (credit horizon ≈ 200 ticks), ±100 unnormalised terminal rewards, and draws *and resource wins* both scored as −100. Under this formulation, "noop until the inevitable −100" genuinely is near-optimal against an unbeatable opponent — the policy was behaving correctly given what it was asked to optimise.

**The good news:** the foundations are unusually strong for a solo project — deterministic shared engine, seed+command-log replays, ONNX deploy path with parity tests, eval/diagnostic tooling, disciplined docs. v0.3.2-ML's shipped bot is real and unaffected. The fixes below are mostly cheap, and several previously "impossible" stages will likely become solvable once the environment actually does what the curriculum says it does.

---

## 1. Experiments run for this report

All on current code (`CrystalFront-ML` branch), default map config, 20–60 seeded matches per pairing.

### 1.1 Scripted bot round-robin (20 matches/pair, seeds 1000–1019)

| Matchup | Blue wins | Red wins | Timeouts | Notes |
|---|---|---|---|---|
| macro vs **rush_medium** | 0/20 | 20/20 | 0 | **MacroBot crashed mid-game in 15/20 episodes** (see §2.3) |
| rush vs **rush_medium** | 1/20 | 11/20 | 8 | The strongest rusher barely scratches it |
| turtle vs **rush_medium** | 0/20 | 20/20 | 0 | Turrets fold by ~tick 1870 |
| heavy vs **rush_medium** | 0/20 | 20/20 | 0 | Tech path far too slow |
| rush_medium vs rush_medium | 7/20 | 9/20 | 4 | Mirror is a coin flip with frequent draws |
| rush vs turtle | 20/20 | 0/20 | 0 | Aggression beats defence outright |
| rush vs macro | 20/20 | 0/20 | 0 | |
| macro vs turtle | 2/20 | 2/20 | **16** | Two non-aggressive bots = 80% draws |
| heavy vs turtle | 0/20 | 7/20 | 13 | |

### 1.2 Mirror side-bias check (60 matches/pair, seeds 5000–5059)

| Mirror | Blue | Red | Timeout |
|---|---|---|---|
| rush_medium | 24 | 18 | **18** |
| rush_weak | 23 | 29 | 8 |

No statistically meaningful side bias at this sample size — good. But **30% of `rush_medium` mirror games end in a draw**, and the reward function scores every draw as −100 for the agent (§4.3).

### 1.3 What these numbers establish

- `rush_medium` sits at or near the top of the game's real strength ladder. The curriculum treated it as a mid-tier stepping stone toward `rush` and league play. The agent was asked to leap from `rush_weak_medium` (beatable, 99% in eval) directly to an opponent that **nothing else in the game beats at all**.
- The game has no working defensive counterplay (§3.1), so "learn to defend the rush, then counterattack" — the implicit lesson of the wall stage — may not be expressible in the current balance at all.
- The `cli.ts` balance harness only supports 5 of the 9 bots (`idle, rush, turtle, macro, heavy`), so the curriculum opponents `rush_weak`, `rush_weak_medium`, `rush_medium` were **never balance-tested against anything** before being used as training gates. I had to write a custom harness to produce the table above.

---

## 2. Critical defects in the training infrastructure

These invalidate or weaken most curriculum-derived conclusions, including the halt verdict.

### 2.1 [CRITICAL] Curriculum config overrides are dropped on autoreset

`headless/src/stdioVecRunner.ts:281` (identical in the compiled `dist/stdioVecRunner.js:223` that training actually executes):

```ts
// Autoreset: immediately start a new episode in this slot
const nextObs = resetSlot(slot, undefined, slot.opponentName, doNextSave, undefined, slot.prePlace);
//                                                            ^^^^^^^^^ configOverrides = undefined
```

`resetSlot` then falls back to `DEFAULT_CONFIG` (6000px map, 1000HP crystal, 50 starting resources). The overrides sent in `reset_all` are a local variable in the message handler and are never stored on the slot. Consequences:

- **Only the first episode per slot per stage** ran with the stage's map width, crystal HP, and starting resources. With 20 envs and hundreds of episodes per stage, >99% of training data came from the default full-size map.
- Stage knobs that *do* persist: opponent, `max_ticks` (module global), and `pre_place` (stored on the slot). So the curriculum effectively was: *default map vs an escalating opponent ladder, with varying episode caps and optional pre-placed scaffolding* — a much cruder curriculum than designed, and one in which the celebrated "resource slider" (2a5→2a6→2b: 200→75→50 starting resources) **never actually moved**. The diary's own observation that "stages day5 through 3a all cleared in exactly 1 evaluation window" is the smoking gun: those stages were nearly identical environments.
- The wall stage `3a_rm_3k` was designed as "rush_medium on a 3000px map, 300HP crystal, 200 starting resources, 2 pre-placed skirmishers". What actually ran was: **rush_medium on the full 6000px map, 1000HP crystal, 50 resources**, with the pre-placed units. A dramatically harder task than intended — against an opponent that already beats everything (§1.1).

> Silver lining: because training, evaluation, and production all (accidentally) used the default map, the shipped v0.3.2-ML bot is self-consistent. Its eval numbers are real.

### 2.2 Observation and action geometry use static constants, not match config

Even in the one episode per slot where overrides *did* apply, the agent's senses were distorted:

- `headless/src/observation.ts:153–154,174–175` — entity/node `xNorm = x / MAP.width` uses the static 6000, not `match.config.mapWidth`. On an 800px stage all positions compress into [0, 0.13].
- `observation.ts:35,100–101` — `crystalMaxHp = ENTITY.crystal.health` (static 1000). On a 50HP curriculum stage, a full-health crystal reads `healthFrac = 0.05`, and the crystal-damage reward (5.0 × delta) scales down by 20×.
- `observation.ts:43,98` — `mid` (own-half/forward features) and `tick/6000` are static.
- `headless/src/actionSpace.ts:248,364–463` — target-zone resolution (`midfield`, `enemy_crystal` fallback, `contested_node` radius test) uses static `MAP.width`; on a small map, "midfield" resolves to x=3000, off the east edge. Notably `actionSpace.ts:295–298` fixes exactly this for build-zone placement, with a comment saying static MAP "must NOT be used here" — the same rule was never applied to the rest of the file or to `observation.ts`.

Net effect: curriculum stages didn't just fail to apply (§2.1) — when they did apply, they presented geometrically scrambled observations and broken movement-zone semantics. **Any future curriculum that varies map size requires fixing both layers first.**

### 2.3 MacroBot crashes at runtime when its barracks is destroyed

`headless/src/bots/macroBot.ts:49–50` references `this.barracksZoneIdx`, `this.barracksYZones`, `this.barracksYZone` — none of which are declared. They are remnants of the removed y-zone build system. `tsx` strips types without type-checking, so this only explodes at runtime, on the first tick after a barracks dies:

```
TypeError: Cannot read properties of undefined (reading 'length')
```

In my round-robin, MacroBot **crashed in 15 of 20 games against rush_medium**. In the vectorised trainer an exception in `redBot.step` propagates to the message handler and returns an error to Python, killing the training run — a likely contributor to the "sudden SPS drop = hanging subprocess" lore in ML_AGENT.md §10.2. It also means `npx tsc` over headless would fail today; the manual src→dist mirror (§2.5) hid this.

### 2.4 BC demonstration pipeline records a weakened, time-shifted expert

Two defects in the behaviour-cloning data path:

- **Expert serialisation:** scripted bots return *multiple* macro-actions per tick (e.g. MediumRushBot may assign workers + train worker + build + train unit + push in one tick), but demo mode executes and records only `botActions[0]` (`headless/src/stdioRunner.ts:198–202`). The BC prior was cloned from a lobotomised RushBot that does one thing per tick — and that same 1-action-per-tick constraint binds the trained policy forever (§4.6).
- **Label off-by-one:** `training/bc_pretrain.py:115–121` pairs `info["demoAction"]` (the action executed at step *t*) with the *next* observation (state *t+1*). Every BC label is shifted one tick late, and the first state of each episode is labelled noop unconditionally. At 10Hz this is survivable (states change slowly), which is why BC still "worked", but it caps demo quality.

### 2.5 Process risk: manual dist mirror + docs that no longer match the code

- The runner prefers `headless/dist/*.js` when present, and dist is kept in sync *by hand*. Today `observation.js` (dist 05-20) and `observation.ts` (src 05-16) already differ in mtime ordering, and src MacroBot is uncompilable. Any future fix applied to src but not dist silently doesn't run.
- **ML_AGENT.md §3.1 documents an action space that does not exist.** It claims build = indices 6–41 (4 types × 3 x-zones × 3 y-zones), attack_move = 42–53, `set_rally` actions, etc. The actual `actionIndex.ts` has build = 6–17 (no y-zones), attack_move = 18–29 + 50–57, attack_targeted = 37–48/58–65, hold_position = 49 — actions the doc never mentions. A future agent following the handoff doc would mis-derive every action index. (The histogram index ranges in `train.py:695–700` are correct against the code; the doc is the one that's wrong.)
- Minor but real: action indices 31–33 (`retreat` for skirmishers/gunners/bruisers subgroups) are never emitted by `legalActions.ts:150–152` (only `all_combat` retreat is ever legal) — three permanently dead actions.

---

## 3. The game as a standalone

CrystalFront is a coherent, working RTS — deterministic engine, fog of war, RPS counters, two win conditions, replays. Its problems are balance and incentive-structure problems, all very fixable, and all directly responsible for parts of the ML failure.

### 3.1 Rush dominance: there is no defender's advantage

The empirical matrix (§1.1) shows a strict aggression ladder: `rush` ≥ `rush_medium` > everything defensive or economic. The unit math explains why:

- **Turrets are paper.** Turret: 400HP, 1.5 dps, range 150, cost 60. Seven skirmishers (8.4 collective dps) kill a turret in ~48 ticks while the turret kills less than one skirmisher (80 ticks/kill). Turtle loses 20/20 to rush_medium by ~tick 1870.
- **Tech is slower than the rush clock.** MediumRushBot's first push leaves at tick 200 and arrives ~tick 600 on the full map. The foundry path (100 res + 200 build ticks, then 100 res + 150 ticks per bruiser) cannot field a counter-composition in time from 50 starting resources and ~1 res/tick of early income. Heavy loses 0/20, dead by tick ~1890.
- **The crystal is inert.** It has no attack, no armour, no regen — there is no "home field" mechanic at all. The map is a flat 6000×600 corridor with no chokes or high ground, so defenders get zero positional advantage either.
- **Skirmisher is the best unit per cost for aggression**: cheapest (50, tied with worker), fastest (15 px/tick), and its hard counter (bruiser, 0.5×/2.0×) is gated behind the slowest tech path and is too slow (9 px/tick) to catch raiders.

**This is the actual wall the RL agent hit.** "Learn to beat rush_medium" presupposes that *some* defensive or counter-attacking strategy beats rush_medium. As far as the evidence shows, none does. An RL agent can sometimes find strategies scripted bots miss — but asking it to do so as a routine curriculum stage, with a 50% promotion gate, was not a calibrated target.

### 3.2 Hard counters are too hard

`COUNTER_MODIFIER` uses 2.0/0.5 — a 4× effective-dps swing. Skirmishers shred gunners 5:1 by time-to-kill (this single fact eliminates MacroBot, whose first army unit is always a gunner). Binary counters make composition the *only* decision that matters, flatten micro, and amplify rush dominance (mass-produce the cheap unit, win before counters exist). Conventional RTS tuning is closer to 1.25–1.5×. Recommend 1.5/0.75 as a starting point and re-running the matrix.

### 3.3 Draws are frequent and the game has no tiebreaker

macro vs turtle: 80% draws. rush_medium mirror: 30% draws. The game simply stops at the tick cap with `winner = null`. For players this is anticlimactic; for training it forced the team to define draw = −100 (§4.3), which poisoned the reward signal. Add a timeout tiebreaker in the *engine* (e.g. higher remaining crystal HP%, then total resources gathered) so a 6000-tick game always produces a winner — then the ML terminal can simply mirror the game's own verdict.

### 3.4 The passive (resource) win condition exists but is treated as a bug

`passiveWinThreshold: 4500` is reachable (sustained map income ≈1.8/tick at node-regen equilibrium → ~2500 ticks of total map control). Yet `reward.ts:131` scores the agent's **own resource victory as −100**. Either the win condition is a real, legitimate strategy (then reward it as a win, and let the bot become the balance instrument that tells you whether it's overpowered), or it shouldn't be in the game. Punishing the agent for winning by the game's own rules is precisely the kind of "incorrectly placed penalty" the project's own design rules warn against.

### 3.5 Economy notes

- **Worker (50) costs the same as a skirmisher (50)** with double the build speed disadvantage reversed — every early-game resource spent on economy is a 1:1 trade against immediate military. This is one of the levers that makes rushing strictly dominant; conventionally workers cost ~50–60% of the cheapest combat unit.
- Safe nodes (100 capacity, 0.2/tick regen, drained at up to 1/tick) deplete in ~2 minutes and then throttle to regen rate. Income collapses to ~0.2/tick/node regardless of worker count — extra workers past 1/node are nearly worthless after the opening, which the agent can't easily perceive (node `remainingFrac` is visible, but the income-equilibrium concept is subtle).
- Fog leak: once *any* enemy entity is visible, the observation exposes the enemy's exact bank, supply, and lifetime resources (`observation.ts:21–27,38–41`). A human player can't see that. Fine for a training crutch, but it undermines goal #1 (bot as balance instrument mirroring player constraints) and D4's spirit.

### 3.6 Map geometry

6000×600 (10:1) is a one-dimensional corridor: a single strategic axis, ~390 ticks of pure walking per attack wave, no flanks, no expansions to contest beyond the centre nodes. It bounds the strategy space the bot could ever discover (goal: "emergent strategy") and makes episodes long mostly via travel time. Not urgent, but when balance is revisited, consider 3:1–5:1 aspect or chokes — it would help both the game and the RL horizon.

---

## 4. ML methodology issues

### 4.1 Decision granularity vs discount horizon — the core formulation error

The agent takes **one macro-action per 100ms engine tick** (`stdioVecRunner.ts` steps the engine once per action). Episodes run 2,000–6,000 ticks. With γ=0.995:

- 0.995^138 ≈ 0.5 → credit half-life ≈ 138 ticks (~14 game-seconds)
- 0.995^600 ≈ 0.05 → a rush arriving 600 ticks after your build decision is 95% invisible to it
- 0.995^3400 ≈ 4×10⁻⁸ → the terminal of an average rush_medium loss (≈3,400 ticks) contributes *nothing* directly to opening decisions

With GAE λ=0.95, within-rollout credit decays as (γλ)^t — half-life ≈ **13 ticks**. Everything beyond that must flow through the learned value function bootstrapping across thousands of steps. The diary identified this ("PPO alone cannot solve a task where the win signal is 3000+ ticks away") but treated it with BC + shaping instead of fixing the MDP. The standard fix is cheap and was never tried:

**Act every k ticks (frame skip / sticky macro-actions), k ≈ 8–10.** Macro-actions already persist in the engine (attack-move keeps moving, workers keep gathering, queues keep producing) — the per-tick decision rate adds almost nothing but noise and 8× more credit-assignment distance. At k=8: 6,000 ticks → 750 decisions; γ=0.99 then gives a half-life of ~69 *decisions* ≈ 550 ticks of game time, and (γλ)^t in-rollout credit spans ~17 decisions ≈ 136 ticks. The terminal becomes learnable. Bonus: 8× more games per wall-clock hour at identical SPS, and the 1-action-per-tick APM gap vs scripted bots (§4.6) narrows in relative terms.

### 4.2 Reward scale breaks PPO's tuning assumptions

±100 terminals (plus ~±26 shaping) flow unnormalised into a **shared-trunk** actor-critic with `vf_coef=0.5`, `max_grad_norm=0.5`, and value clipping at `clip_coef=0.2`. PPO's defaults assume rewards of order ±1:

- Value targets of ±100 produce value-loss gradients that dwarf the policy gradient inside the shared trunk; global grad-norm clipping at 0.5 then rescales the *combined* gradient, so the policy-gradient component is crushed to a sliver of each update.
- Value clipping at 0.2 per update against targets of magnitude 100 makes the critic glacially slow to track outcome changes — exactly the "noisy critic → noisy advantages → BC prior overwritten" failure the diary fought (their critic-pretraining fix treated the symptom).

Fix: terminal ±1, shaping components scaled to ≲0.25 total, time penalty −1e-5/decision — or keep magnitudes and add return normalisation. Either way, never ±100 raw into clipped PPO.

### 4.3 Terminal design: draw = loss = resource-win = −100

`reward.ts:131`: anything other than a combat win is −100. So:

- Surviving 6,000 ticks against rush_medium (a *draw* against an opponent that beats everything) = same return as dying at tick 600. The agent is told that its best realistically-achievable outcome is worthless — at which point minimising effort (noop) is rational. **The "noop attractor" the project battled for weeks is substantially a designed-in property of this terminal.**
- Winning by resources = −100 (§3.4). A whole strategic pathway — one the game design doc explicitly added for "economist vs militarist" texture — is forbidden to the learner.

Fix (after §3.3's engine tiebreaker): win +1 (any win type), loss −1, and the timeout case disappears because the engine always names a winner. If a graded signal is wanted, add ±0.25 × (crystal HP% differential) at termination — a potential-style term that gives "almost won" > "got crushed".

### 4.4 Truncation is conflated with termination

`crystalfront_vec_env.py:200` returns `truncated=False` always; the tick-cap end is treated as a true terminal (`done=1`), so GAE zeroes the bootstrap. Combined with −100 for timeouts this is "consistent", but once draws stop being −100 (§4.3, removed by the tiebreaker) any remaining truncation must bootstrap `V(s_T)` or values near the cap will be biased.

### 4.5 The curriculum gate was never calibrated — and the post-mortem inherits that

The wall stage demanded ≥30–50% vs rush_medium. §1.1 shows no scripted agent achieves >5% in the current balance, and §2.1 shows the stage's intended scaffolding (smaller map, weaker crystal, 200 resources) never loaded. The halt verdict — *"gradient-sign root cause: train_unit correlates with −100; both exploration-side options exhausted"* — is **directionally reasonable but unproven**, because:

- the experiments ran in an environment whose difficulty knobs were inert (§2.1);
- "no winning multi-unit trajectories exist" was true partly because *no winning trajectories of any kind* exist vs this opponent under current balance (§3.1);
- and with γ=0.995 at per-tick decisions, even a correctly-signed gradient from a +100 win couldn't reach the train_unit decisions that caused it (§4.1).

The correct statement is: *the agent was asked to climb a cliff that the game's balance makes near-vertical, using a credit-assignment rope ~200 ticks long, in a harness that silently swapped the cliff for a taller one.* None of Option B/γ's machinery (masking, RND) addresses any of those three things, so their failure is uninformative about the fallback options. Do not invest 3–5 weeks in Option α (hierarchical policy) on the current evidence.

### 4.6 APM asymmetry

Scripted bots emit **arrays** of macro-actions per tick (`stdioVecRunner.ts:204–211`); the policy emits exactly one. At rush-defence moments the opponent assigns workers, trains, builds, and pushes simultaneously while the agent does one of those. Options: (a) restrict scripted bots to one action/tick (cleanest comparison, weakens them), or (b) keep the asymmetry but adopt frame-skip so one decision per 0.8s vs the bot's 4-actions-per-0.1s at least isn't compounded by per-tick dithering. Long-term, multi-head action output (type + args) fixes this properly.

### 4.7 Smaller items

- **Forcing uses `Math.random()`** (`legalActions.ts:62,74`) — the only nondeterminism in an otherwise seeded pipeline; would break replay/determinism tests if forcing were ever on outside training.
- **RND deviations from the reference design:** intrinsic reward computed on the *current* obs rather than next-state; added to extrinsic rewards into a single value head with episodic dones (canonical RND uses a separate non-episodic value head). Also moot now, but if RND ever returns, fix these.
- **LR-anneal warp on resume:** `num_updates = total_timesteps // batch_size` is recomputed per run, while `start_update` resumes from the checkpoint — resuming with a smaller `total_timesteps` than the original run silently compresses (or could invert) the schedule.
- **Mid-rollout stage swaps:** curriculum promotion rebuilds envs *inside* rollout collection; the buffer then mixes transitions from two different stages with no done flag at the boundary, corrupting GAE across the seam for that update. Promote between updates instead.
- **Observation gaps:** no `enemyGunnerCount`/`enemyMedicCount` globals (worker/skirm/bruiser only); `oppCrystalHealthFrac=0` is ambiguous between "not visible" and "destroyed". Minor, since the entity list carries the info.
- **`getLegalActions` doesn't check placement feasibility** — `build` is legal whenever resources + an idle worker exist; the actual placement can fail silently (`processCommand` result ignored), giving the agent legal-but-no-op actions. Low impact, worth an `info` counter.

---

## 5. What survives from the previous work

Worth saying clearly, because plenty does:

| Asset / conclusion | Verdict |
|---|---|
| Deterministic shared `MatchEngine`, seeded RNG, determinism CI test | ✅ Excellent foundation — keep |
| Replay = seed + command log, replay browser | ✅ Keep |
| ONNX export + parity test + `MlBot` production path | ✅ Keep; v0.3.2-ML ship is real and self-consistent |
| `diagnose_policy.py`, eval harness, TensorBoard diagnostics | ✅ Keep (the `trn=0%` rounding-artefact catch was good debugging) |
| BC insight: pretrain the critic, don't carry BC optimizer state into PPO | ✅ Real, transferable lesson |
| "One variable at a time" curriculum discipline | ✅ Right principle — it just never actually executed (§2.1) |
| "Resource slider solved 2b" | ❌ Unreliable — the slider was disconnected (§2.1) |
| "Gradient-sign root cause; masking/RND exhausted; halt" | ⚠️ Unproven — confounded by §2.1, §3.1, §4.1. Re-test after fixes |
| "Do not attempt v0.4.0 again without new architecture" | ❌ Premature — fix env + game + MDP first; architecture was never the binding constraint |

---

## 6. Recommended path forward

Ordered so that each phase de-confounds the next. Do not skip ahead: training before the game is balanced will re-discover that rush_medium is unbeatable, slowly and expensively.

### Phase 0 — Repair the instrument (1–2 days)

1. **Fix the autoreset bug**: persist `configOverrides` on the slot in `stdioVecRunner.ts` (and the stdioRunner if affected) and pass them through `resetSlot` on autoreset.
2. **Add a regression test** that runs 3 consecutive episodes with `mapWidth=800` and asserts (e.g. via max node x position, or by echoing `match.config` in `info` at each reset) that episodes 2–3 still use the override. This class of bug must never recur silently.
3. **Make geometry config-aware**: replace every static `MAP.width`/`MAP.height`/`ENTITY.crystal.health`/`/6000` in `observation.ts`, `legalActions.ts`, and the remaining sites in `actionSpace.ts` with `match.config` values (the pattern at `actionSpace.ts:295–298` is the template).
4. **Fix MacroBot** (declare/remove the y-zone fields), wrap opponent `step()` in try/catch in the runners (log + treat as `[]`), and run `tsc --noEmit` over headless in CI.
5. **Kill the manual dist mirror**: build `dist/` from `src/` with a single `npm run build:headless` invoked by the training launcher, or run `tsx` everywhere. Two hand-synced copies of the reward/legality code is how silent drift happens.
6. **Fix the docs**: regenerate ML_AGENT.md §3.1 from `ALL_ACTIONS` programmatically (a 10-line script can print the table) so it can't drift again.
7. Replace `Math.random()` in forcing with the match RNG (or delete the forcing module — see Phase 2).

### Phase 1 — Balance the game, using bots as the instrument (3–5 days)

This is goal #1 of the whole project ("the bot as a balance microscope") — it just needs to start with scripted bots.

1. Extend `cli.ts`/`balance_report.py` to all 9 bots and add the full round-robin (≥50 seeds/pair) as a one-command report. Optionally a CI "balance gate".
2. Tune toward explicit acceptance criteria, re-running the matrix after each change:
   - every bot loses to at least one other bot (no strictly dominant strategy);
   - `turtle` and `macro` each beat `rush_medium` ≥30% (defence is *possible*);
   - mirror matches ≈ 50/50 ± noise;
   - draw rate <10% in any pairing (after the engine tiebreaker below).
3. Concrete levers, in expected order of impact:
   - **Timeout tiebreaker in the engine** (most crystal HP% remaining wins; resources as second key) — kills the draw problem for game and training alike (§3.3);
   - **turret buff** (e.g. 400→600HP, 1.5→2.5 dps) and/or crystal slow-regen or light attack — create a real defender's advantage (§3.1);
   - **counter multipliers 2.0/0.5 → 1.5/0.75** (§3.2);
   - **worker cost 50 → 35** so economy isn't a 1:1 sacrifice of military (§3.5);
   - rush pacing: `FIRST_PUSH_TICK`/unit build times if the above aren't enough.
4. Decide the passive-win question (§3.4): keep it and treat it as a win everywhere, or remove it. No half-state.

### Phase 2 — Restructure the MDP (2–3 days of code, then re-train)

1. **Frame skip k=8** (one decision per 8 engine ticks; opponent bots act every tick as now, or every tick unchanged). Expose `k` as a config; keep observations at decision boundaries.
2. **Reward rescale**: terminal ±1 (any win type counts as the engine's winner per Phase 1 tiebreaker), shaping milestones at +0.10/+0.05/…, crystal-damage deltas ±0.05/±0.02, time penalty ~−1e-5/decision. Delete the resource-win penalty.
3. **Proper truncation**: plumb `truncated` through the runner and bootstrap `V(s_T)` (mostly moot once the tiebreaker exists, but correct it anyway).
4. γ=0.99, λ=0.95 at decision granularity; revisit `num_steps` (750-decision episodes no longer need 1536-step rollouts — 256 is plenty and speeds updates).
5. Promote/regress the curriculum only at update boundaries.
6. Retire the forcing + RND code paths (keep the flags, default-off, or delete; they were symptom treatments).
7. Re-record BC demos with the off-by-one fixed and, ideally, the expert's full action list serialised across the k-tick window (the frame-skip window gives the demo bot k ticks of actions to spread out — neatly solving §2.4's serialisation loss too).

### Phase 3 — Re-run BC + curriculum, honestly this time (≈1 week of runs)

- The existing 17-stage table is a fine starting point **now that the knobs will actually work** — but simplify: with frame-skip + sane rewards + a beatable rush_medium, many micro-stages (0b5, 0c, day5…) likely collapse into a handful.
- Add the previously-proposed `3a_def` defensive stage if needed — note it requires opponent-side pre-placement, which `performPreSetup` doesn't support yet (it only sets up BLUE).
- Gate league/self-play exactly as before: only after the scripted ladder is cleared.
- Stop-the-line conditions from ML_AGENT.md §8.10 remain good; add one: **any stage whose intended config differs from `DEFAULT_CONFIG` must log the realised config per episode** (trust, but verify).

### Phase 4 — Only if the wall reappears

If, with a balanced game, working curriculum, and a learnable horizon, the agent *still* can't learn multi-unit play — then the hierarchical-policy idea (Option α) becomes worth its 3–5 weeks. My expectation is it won't be needed: the three fixes attack the actual binding constraints, and the agent already demonstrated it trains 9–17 units/episode when the value landscape permits.

---

## 7. Quick-wins checklist

| # | Fix | File | Effort |
|---|---|---|---|
| 1 | Pass `configOverrides` through autoreset | `headless/src/stdioVecRunner.ts:281` | 10 min |
| 2 | Regression test for #1 | new test | 1 h |
| 3 | Config-aware `xNorm`/`crystalMaxHp`/`mid`/`tick` | `observation.ts`, `actionSpace.ts`, `legalActions.ts` | 2–3 h |
| 4 | Fix MacroBot undeclared fields + try/catch around bot `step()` | `bots/macroBot.ts`, runners | 1 h |
| 5 | Single-command headless build; drop manual dist sync | `package.json` | 1 h |
| 6 | Engine timeout tiebreaker (no more draws) | `matchEngine.ts` | 2 h |
| 7 | Terminal ±1; resource win = win; shaping ÷100 | `headless/src/reward.ts` | 1 h |
| 8 | Frame skip k=8 | runners + env + config | 0.5–1 day |
| 9 | Extend balance harness to all 9 bots; run full matrix | `cli.ts`, `balance_report.py` | 2 h |
| 10 | Regenerate ML_AGENT.md action table from code | script | 1 h |
| 11 | BC label off-by-one | `bc_pretrain.py` / `stdioRunner.ts` | 1 h |
| 12 | `tsc --noEmit` in CI for headless | CI config | 30 min |

---

## Appendix — severity-ranked findings index

| Severity | Finding | Section |
|---|---|---|
| 🔴 Critical | Curriculum overrides dropped on autoreset; >99% of training on default config | §2.1 |
| 🔴 Critical | Game balance: rush strictly dominant; wall opponent unbeatable by any bot; defence nonviable | §3.1, §1.1 |
| 🔴 Critical | Per-tick decisions + γ=0.995 → terminal unlearnable over episode horizon | §4.1 |
| 🟠 High | Draw and resource-win scored −100 (noop attractor designed in; legit win punished) | §4.3, §3.4 |
| 🟠 High | ±100 unnormalised rewards vs PPO clip/grad-norm assumptions | §4.2 |
| 🟠 High | Static map constants in observation/zone geometry | §2.2 |
| 🟠 High | MacroBot runtime crash (15/20 games), kills training subprocess | §2.3 |
| 🟡 Medium | ML_AGENT.md action table documents a nonexistent action space | §2.5 |
| 🟡 Medium | Counter multipliers 2.0/0.5 too extreme | §3.2 |
| 🟡 Medium | No engine tiebreaker; high draw rates | §3.3 |
| 🟡 Medium | APM asymmetry (multi-action bots vs 1-action policy) | §4.6 |
| 🟡 Medium | BC expert serialised to 1 action/tick + label off-by-one | §2.4 |
| 🟢 Low | Truncation≠termination, mid-rollout stage swaps, LR-anneal on resume, `Math.random` in forcing, dead retreat actions, fog econ leak, missing gunner count | §4.4, §4.7, §3.5 |
