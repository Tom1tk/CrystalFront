# CrystalFront ML Project Review

**Reviewer:** Independent technical audit
**Date:** 2026-05-20
**Branch under review:** `CrystalFront-ML` @ `f9341b7` (v0.2.10-ML)
**Primary source:** `docs/ML_BOT_ACTION_PLAN.md` (1,341 lines), plus full code & training-log inspection
**Scope:** project journey, ML decisions, current state, base-game friction for ML

> **A note before we start.** This review is written knowing that CrystalFront is your first serious ML project, built collaboratively with AI assistance. Read the tone of every section in that light. The criticisms below are *technical* — they are about RL methodology, not about your ability or effort. The volume of working machinery you've assembled here is genuinely impressive for a first project. The fact that the diary catches its own mistakes, names them in plain language, and re-iterates is *exactly* how serious engineers work. You are not stuck because you're a beginner. You are stuck because you are wrestling with one of the **canonical hard problems in reinforcement learning** — the long-horizon credit-assignment problem — using the tools that fail at it. This review will say what those tools are and what the better ones look like. None of this requires a PhD; it requires a different unit of iteration. We'll get to it.

---

## 1. Executive summary

CrystalFront-ML is an ambitious, well-engineered RL project: deterministic engine, headless harness, vectorised PPO, ROCm-tuned training pipeline, 8 scripted bots, replay tooling. The infrastructure is **excellent** — frankly, more polished than many academic RL codebases. Phases 0–3 of the original plan are essentially done; some of Phase 5 is done.

But, **35 days and ~50 versions later, the agent has not yet beaten IdleBot** (an opponent that does literally nothing). The latest run (v0.2.10-ML, currently training) is at update 79 with 95 % noop, 0 % crystal damage, 0 % win rate — the same failure mode as v0.2.3, v0.2.4, v0.2.5, v0.2.6, v0.2.7, v0.2.8, v0.2.9 before it. The "stop-the-line" condition explicitly written into the plan (`Phase 3 training never beats IdleBot`) has been triggered repeatedly without being honoured.

**The infrastructure is healthy. The RL methodology is not.** The dominant failure mode is **shaping-reward whack-a-mole**: every newly-added shaping signal becomes a local optimum the policy exploits, the team patches it, and a new exploit appears. This is a textbook RL trap, and the project keeps walking into it.

The single most impactful change this project could make is **stop adding/tuning reward signals and start using the curriculum + imitation tools already on the shelf**. Specific recommendations are in §7.

---

## 2. What's been built — the praise column

The project has done many things genuinely well. Calling these out because they're load-bearing.

| Area | Verdict | Notes |
|---|---|---|
| **Deterministic engine** | ✅ Strong | `Rng`, `IdGen`, `commandLog`, split engine modules, 500-tick hash test, 391 tests passing. This is the foundation everything depends on; it's solid. |
| **Action-space enumeration** | ✅ Strong | `actionIndex.ts` is a clean stable enumeration with versioned comment history. PPO outputs an integer; one source of truth maps it back. |
| **Headless harness** | ✅ Strong | Two parallel runners (`stdioRunner.ts` for single-game, `stdioVecRunner.ts` for vectorised). JSON-line protocol is simple and robust. |
| **PPO trainer** | ✅ Strong | Faithful CleanRL implementation. GPU rollout buffer + bf16 autocast + GAE on GPU + `torch.compile(reduce-overhead)` are well-chosen optimisations. The v0.2.8 hardware-profiling pass (18 %→98 % GPU utilisation, 122→7 subprocesses) is exactly the right kind of engineering. |
| **Set-transformer policy** | ✅ Reasonable | Permutation-invariant entity encoder is the correct architectural choice for RTS observations. Pre-norm, masked mean pooling, legal-action masking — all standard and correct. |
| **Scripted bot ladder** | ✅ Exceeded plan | 8 bots (IdleBot, PassiveBot, WeakRush, MediumRush, Rush, Turtle, Macro, Heavy) vs 4 planned. PassiveBot was added to bridge the credit-assignment gap. |
| **Replay system** | ✅ Strong | Versioned, server-side paginated, scrub bar fixed, training-replay suppression. Used effectively to diagnose four separate exploits. |
| **Diary discipline** | ✅ Exemplary | `ML_BOT_ACTION_PLAN.md` is one of the better engineering diaries I've read. Decisions, dates, configs, snapshot tables — this is how it should be done. The diary is the strongest signal that the team can self-correct; the issue is the loop on top, not the discipline within it. |
| **Version-bump discipline** | ✅ Good | All 5 `package.json` bumped together (after the v0.1.75 fire); training runs are tagged with the version they were collected under. |
| **Curriculum scaffolding** | ✅ Achieved a win | Phase A (small map, 3 pre-placed skirmishers) and Phase B (pre-placed barracks) both reached `win_rate=1.00`. Proof the architecture and pipeline work. |

These are not minor. A reasonable estimate of the engineering cost so far is 200–400 hours of careful work, most of which is in good shape.

---

## 3. The core problem — diagnostic

> **One sentence:** the team is iterating on reward shaping where it should be iterating on curriculum, and the result is a 50-version, 20M-step-per-run, multi-week effort to defeat the bot that does nothing.

### 3.1 The credit-assignment gap

To win against IdleBot, the policy must execute this chain (numbers re-derived from `gameBalance.ts` — skirmisher speed 3.0 px/tick, barracks buildTime 150 ticks, skirmisher buildTime 100 ticks, crystal HP 1000, skirmisher damage 12, attackCooldown 10):

```
tick    action
   0    start with 50 resources, 4 workers, supply 4/10
   0    train_worker (50→0, builds for 80 ticks)
  ~5    assign starting 4 workers to nodes (gather starts)
  80    new worker appears; resume training cycle
 ~200   accumulate 75 resources, issue build_barracks
 ~350   barracks completes (200 + 150 buildTime)
 ~350   train_skirmisher (50 resources, supplyCost 1)
 ~450   skirmisher unit appears
 ~450   issue attack_move enemy_crystal
 ~450→~2400   skirmisher walks ~5800 px at 3.0/tick
 ~2400  skirmisher in range of crystal
 ~3500  crystal at 0 HP (1000 HP ÷ ~12 dmg every 10 ticks ≈ 850 ticks of attack)
 ~3500  +100 terminal
```

That's ~3,500 ticks from start to terminal reward, across **~10 sequentially-dependent decisions**, most of which are 1-in-81 actions at any given tick. If anything the chain is *longer* than the original review's estimate.

At `gamma = 0.995`, the discount on a +100 terminal at the decision point of `build_barracks` (tick ~200, ~3300 ticks before terminal) is `0.995^3300 ≈ 7 × 10⁻⁸`. The terminal reward is **invisible** from the start of the chain. PPO's value function literally cannot learn the build action's value from the win signal alone.

This is the textbook credit-assignment problem. It is a known-hard problem. The standard solutions are:

1. **Curriculum learning** — start with a short version of the chain (Phases A and B), then add links one at a time.
2. **Behaviour cloning warmup** — supervised pre-training from RushBot demonstrations.
3. **Hindsight experience replay / goal-conditioned RL** — different paradigm; not needed here.
4. **Better dense shaping** — the path the team has chosen.

### 3.2 Why shaping-reward whack-a-mole is dominating

The reward function in `stdioRunner.ts` `computeReward()` is now ~340 lines and contains **20+ distinct signal sources**:

| Class | Signals | Recent history |
|---|---|---|
| Terminal | ±100 | Stable since v0.2.0 |
| Crystal damage | dealt / taken / first-hit / 25 % / 50 % / 90 % milestones | Tuned 5+ times |
| Mining | lifetime-resources delta | Tuned 4+ times |
| Kills | enemy combat / workers (gated on own combat) | Gating added v0.2.9 |
| Unit losses | own workers / own combat | Stable |
| Damage dealt | per HP frac, gated on own combat | v0.2.9 gating |
| Building damage taken | own buildings only | v0.2.3 |
| Reactive defence | distress + retaliation | v0.2.0 |
| Defenseless trickle | tick > 150 & no barracks & no combat | v0.2.1 |
| Wrong-building-first | depot/turret before barracks | v0.2.3 |
| Abandoned-building | construction-frac stalled | v0.2.5 |
| Time penalty | −0.0005/tick | 10×'d v0.2.6 |
| Per-tick building bonus | 3-tier diminishing for barracks/foundry | v0.2.10 (NEW) |
| Build milestones | barracks (time-decayed) / foundry / turret | Tuned 6+ times |
| Combat-unit milestones | diminishing 1.0/0.8/0.6/0.4/0.2 | v0.2.6 |
| Progression milestones | mid-cross / enemy-quarter / crystal-hit | Stable |
| Own-crystal-hit penalty | −0.5 one-time | Stable |
| Scouting | per-entity-id discovery (type-tiered) | v0.2.7 |
| Map visibility | grid coverage fraction | v0.2.3 |
| Cancel penalty | −0.5 per redirected mid-travel unit | v0.2.5 |

Every meaningful run since v0.1.57 has revealed that **one of these signals was the gradient the policy actually followed**, and it wasn't what the team intended:

| Version | What the agent actually learned | Diagnosed |
|---|---|---|
| 0.1.63 | Mine forever (mining reward 25× too strong) | Yes |
| 0.1.66 | Build but never train (build/train probability mass) | Yes |
| 0.1.72 | Build barracks at the wrong x (silently illegal — `chooseBuildPosition` MAP.width bug) | Yes, after 8 versions |
| 0.1.74 | Train one unit and oscillate (V(s) overshoot from +50 first-unit) | Yes |
| 0.2.0 | Hit ep_rew floor due to shaping clamp ±20 saturating | Yes |
| 0.2.2 | Park units at xNorm ≈ 0.46 (midfield attractor: just above the army-idle penalty, just below the midfield milestone) | Yes |
| 0.2.3 | Worker spam (visibility reward) | Yes |
| 0.2.6 | Avoid `attack_move` entirely (cancel penalty over-correction) | Yes |
| 0.2.8 | Worker-swarm exploit (kill/damage rewards farmed by workers) | Yes |
| 0.2.9 | Converged to 99 % noop (terminal too distant, no positive shaping path) | Yes |
| 0.2.10 | Currently 95 % noop at u79 — building bonuses haven't fired yet | In progress |

Each exploit is *novel*. The team is doing very good diagnostic work. But this is the wrong loop to be in. Each new reward fixes the last exploit and opens the door to the next.

### 3.3 Why the curriculum was abandoned prematurely

The single clearest mistake in the project's history:

- **v0.1.65-ML** (Phase A): small map, 3 pre-placed skirmishers, 50-HP crystal. `win_rate=1.00` from update 1. **First positive terminal in training history.**
- **v0.1.67-ML** (Phase B): pre-placed completed barracks. `win_rate=1.00` from update 3. **Build→train→attack chain learned.**
- **v0.1.66-ML, v0.1.68–0.1.75-ML** (Phase C): remove the pre-placed barracks. **Collapsed to 0 % wins, never recovered.**
- **v0.2.0-ML**: full reset, abandon curriculum entirely, start over against IdleBot on the 6000 px / 1000 HP map with all the shaping rewriting begins.

The right move at v0.1.66 was: **don't remove all scaffolding at once**. The literature on curriculum learning is explicit that each step should be incremental. Going from "barracks already exists" to "build barracks yourself on a 6000 px map with 1000 HP crystal" is multiple curriculum steps in one jump.

A measured Phase C would have been:

1. C1: pre-placed barracks, but make it 50 % built and force the agent to wait/assist.
2. C2: pre-placed worker assigned to build-barracks at tick 0; agent need only ratify.
3. C3: 250 starting resources, agent must issue `build_barracks` itself; map 1000 px.
4. C4: 50 starting resources, must train workers first; map 1000 px.
5. C5: map 3000 px.
6. C6: map 6000 px, crystal 1000 HP (full config).

None of this happened. The team jumped straight to C6.

### 3.4 The 50-version pattern

The Development Diary tells a consistent story:

> *Try a change → run 5–20M steps → diagnose failure mode → adjust one to three reward coefficients → repeat.*

This is the wrong unit of iteration. Each iteration is ≈ 2–6 hours of GPU time and many hours of human attention, and almost every iteration produces "same pattern as before, no path to barracks". At ~50 versions, the team has spent on the order of 100+ hours of training time and many more of diagnostic time, with no monotonic improvement on the core task.

**A correct iteration loop for this stage** would be:

1. Pick one curriculum scaffold change.
2. Run for 2M steps (≈ 30 min on current hardware).
3. If `win_rate > 0` against the scaffolded opponent, proceed; otherwise, simplify the scaffold further and retry.

The team has the infrastructure to do this; v0.2.8 hardware optimisations brought SPS up to ~1,375. They are choosing not to.

---

## 4. Specific ML mistakes / misunderstandings

A targeted list, ordered roughly by impact.

### 4.1 Reward magnitude is far larger than terminal

The terminal is ±100, but the achievable per-episode shaping in v0.2.10 is roughly:

| Source | Best-case magnitude | Notes |
|---|---|---|
| Per-tick barracks bonus (3 buildings, tick 500→6000) | +66 | Brand new in v0.2.10 |
| Per-tick foundry bonus (3 buildings, tick 500→6000) | +25 | Brand new in v0.2.10 |
| Milestone one-time rewards | +10 (barr) +2 (fnd) +0.5 (turret) +5 (first-hit) +16 (depth) | ≈ +33 |
| Combat-unit training (5 units, diminishing) | +3.0 | |
| Discovery rewards (full scout) | +6 to +10 | |
| Map visibility (full coverage) | +6 | |
| Mining (full saturation) | +9 | |
| Time penalty | −3 | |
| Floor of "do nothing" | ≈ −5 (time + visibility low) | |

Cumulative best-case shaping: **+150** to **+155**. That's **1.5× the terminal magnitude.** The agent can lose every game and still net positive reward. This is exactly the trap the diary documents at v0.1.60 ("stable losing equilibrium … ep_rew ≈ +1–2 while losing 100% of games") — and the v0.2.10 change *makes it worse* by adding a fresh +91 of per-tick shaping.

**Correct rule:** shaping reward should be *strictly bounded below the terminal magnitude*. The original v0.2.0 attempt to clamp at ±20 was the right *idea*, badly *implemented*: it flattened the gradient inside the band, so the agent couldn't distinguish "somewhat bad" from "catastrophic". A better approach is **per-source caps** (e.g. mining: max +5/ep, visibility: max +2/ep, scouting: max +5/ep) rather than a single end-of-episode clip.

### 4.2 Per-tick "building bonus" is the v0.1.60-trap reborn

v0.2.0 explicitly removed the "standing force trickle" because passive ownership rewards create degenerate strategies ("keep three units alive, do nothing"). v0.2.10 introduces an *identical* signal in a different costume: "keep 3 barracks + 3 foundries built, do nothing, earn ~+91 reward". The diary notes this was added to escape a noop optimum, but the new optimum will be **"build 3 barracks + 3 foundries, train zero units, time out, collect +91 shaping − 100 terminal = −9"**, which is markedly better than the current −95 noop floor. The policy will discover this and lock in.

This is predictable from first principles and the team has been here before. **Strong recommendation: remove the per-tick building bonus before that local optimum forms.** Replace it with a *one-time* bonus per building completion, capped at 1 each.

### 4.3 Discount factor vs episode length

`gamma = 0.995`, episode length 6000 ticks. Effective horizon `1/(1−γ) ≈ 200` ticks. The win signal at tick 2900 is essentially invisible from tick 200. Increasing gamma alone (e.g. to 0.999) helps only marginally and destabilises value estimates.

**Correct fix:** either shorten the episode (smaller map, smaller crystal HP) or use n-step returns / averaged-return baselines designed for long horizons. The team has done the former in Phase A; they should return to it.

### 4.4 Reward-function code duplication between two runners

The reward function exists in identical form in:

- `headless/src/stdioRunner.ts` (lines 158–509, ~340 lines)
- `headless/src/stdioVecRunner.ts` (lines 213–450, ~210 lines, slightly differently arranged)

This invites drift. The diary explicitly notes "Two lines changed in both `stdioRunner.ts` and `stdioVecRunner.ts`" at v0.2.9. That's a warning, not a footnote.

**Recommendation:** extract `computeReward(slot, prev, curr, done, winner, winType)` and `computeTickCancelPenalty()` into a single module (`headless/src/reward.ts`), import from both runners. The non-vec runner is for single-game testing and replay generation; both must agree byte-for-byte.

### 4.5 Action-space mask drift

`actionIndex.ts` enumerates **81 actions** but `legalActions.js` only emits **up to ~70 of them under any conditions**:

- Indices 58–65 (`attack_targeted × {targeting_friend, spread_fire} × 4 groups`): `legalActions.js` never emits any `targeting_friend` or `spread_fire` variant. **These 8 actions are permanently masked illegal.** The policy still wastes a logit on each.
- Indices 71–80 (`attack_move × {all_idle_combat, idle_workers} × 5 zones`): legalActions.js *does* emit these (lines 113–125). OK.
- `actionSpace.js` `resolveAttackTarget('targeting_friend')` at line 276 references an **undefined** variable `playerId` (it's not a parameter). If this code path were ever hit, it would throw. It isn't, because the action is masked illegal — but the bug is latent.

**Recommendation:** either implement `targeting_friend`/`spread_fire` in `legalActions.js` (they're potentially useful) or remove them from `actionIndex.ts`. Pick one. Add a unit test that asserts every action in the index can be produced by `legalActions.js` for *some* state.

### 4.6 `MAX_ENTITIES = 64` saturates routinely

Worker-spam runs (v0.2.2, v0.2.3, v0.2.8) had 100+ own workers + enemy workers + buildings. The observation truncates to the first 64 entities (`crystalfront_vec_env.py:189`). Truncation order is insertion order in `match.entities` (a `Map`), which is *roughly* creation order — so during worker spam, the agent **stops seeing its own buildings and the enemy crystal** once the worker count exceeds ~50.

**Recommendation:** either raise `MAX_ENTITIES` to 128 (cheap; entity encoder is O(N²·d) but N=128 is still trivial on the GPU), or prioritise the entity list (own crystal + buildings first, then enemy crystal + buildings, then combat units, then workers — drop excess workers).

### 4.7 Observation gaps

The 22-dim global vector is reasonable. Three notable omissions:

- **No `tick % production_cooldown` information.** The agent has no way to estimate "when will my next unit appear?".
- **No "is currently building" flag at the player level.** The `isBuilding` per-entity flag exists, but a global "any active build" boolean would help the policy learn build sequences.
- **No representation of `commandedTicks`.** Units have a 5-tick command lock-out after orders; the agent cannot observe this and may issue commands that get silently ignored.

These are small. Not the bottleneck.

### 4.8 `cancel penalty` over-corrects (still)

v0.2.6 diary entry diagnosed this clearly: "the agent's aversion to attack_move is a learned misconception". The v0.2.7 fix added idle-only variants (71–80) so the agent has a no-penalty path. Good in principle. In practice the policy now has to *learn that distinction*, which adds another credit-assignment step.

A simpler design: **only penalise cancels of `attack_targeted` against a still-alive target** (i.e. the unit was actively engaging). Cancelling a generic `attack_move` should be free — it's a re-tasking decision that should be cheap. The current model treats both identically.

### 4.9 IdleBot is harder than expected

IdleBot mines resources and never trains combat. Vs IdleBot the agent must:

- Build barracks, train skirmisher, walk 6000 px to crystal, kill 1000 HP crystal.
- IdleBot has zero defence — there's no fight, just the long walk.

If the agent does *anything* short of this chain, ep ends in timeout. There's no partial credit possible from the terminal signal — it's binary win/loss. This is why every shaping signal becomes load-bearing: there's no terminal gradient for value learning.

**This is the cleanest argument for the curriculum.** The PassiveBot scenario (with pre-built barracks etc.) achieved 100% wins. The team should have **stayed on a scaffolded curriculum until atomic skills were robust**, not jumped to vanilla IdleBot on the full map.

### 4.10 No imitation-learning warmup

The project has 8 scripted bots, each of which plays full matches against itself and reaches end-states. `RushBot` reliably reaches and damages the enemy crystal. The team could trivially:

1. Run `RushBot vs IdleBot` for 1000 episodes.
2. Log (observation, legal_mask, action) tuples.
3. Train the policy network with supervised cross-entropy for ~1 epoch.
4. Hand the warm-started policy to PPO.

A behaviour-cloning warmup of even mediocre data routinely cuts PPO sample complexity by 10–100×. The stop-the-line condition in `ML_BOT_ACTION_PLAN.md §8` even calls this out ("escalate to behaviour-cloning warmup") and the trigger has been met repeatedly. The team has never done it.

**This is the single highest-leverage action available.**

---

## 5. Base-game issues that hurt ML

The plan envisioned the bot as a "balance instrument" — runnable after every balance change. Several things in the base game make training harder than it needs to be.

### 5.1 Map is too large for sample-efficient learning

6000 px wide, units travel ≈ 2.5 px/tick, so a one-way trip is ~2400 ticks. With a 6000-tick episode cap, only ~2.5 round trips fit. Most of the episode is **walking**, which generates no decision signal for the policy.

This is intrinsic to the game design — it's an RTS, the map is supposed to be wide. But it is **dramatically friendlier to learning** if there's a training-only config with `mapWidth=2000, crystalHealth=300`. The team did exactly this in v0.1.65 (Phase A) and got their first wins. They then *reverted to defaults* in v0.2.0 "to reflect the full game" — and have not recovered.

**Recommendation:** keep training on a smaller map. **Distill** to the full map only once the small-map policy is competent (this is the standard transfer-learning approach). The set-transformer architecture is map-size-invariant, so the transfer will largely "just work".

### 5.2 The `commandedTicks` lock-out (smaller than I first thought)

**Correction:** on re-reading the code, `commandedTicks` is set to **1**, not 5 (`matchEngine.ts:388`), and it only blocks **auto-attack target acquisition** (`combat.ts:7–15`) — not explicit movement commands. So the earlier-draft claim that "every command is ignored 80 % of the time" was wrong.

What it *actually* does: after issuing any explicit move order, the unit skips one tick of "look around for nearby enemies and auto-attack them". That's a much smaller effect, and probably benign. There's no need to remove it.

The remaining quibble is that the agent still cannot **see** that a unit was recently commanded — which means a fast follow-up `attack_targeted` could re-issue a near-identical command without the agent knowing the previous one is still mid-flight. If anything, this is a feature of the existing cancel-penalty design (which exists precisely to discourage redundant re-tasking).

**Net:** this is not a real ML blocker. The original section overstated it.

### 5.3 `chooseBuildPosition` is a single point of fragility

The MAP.width bug from v0.1.72 (8 versions of "agent never builds, we don't know why") was caused by hardcoded constants. The fixed version (lines 283–333 of `actionSpace.js`) is better but still:

- Performs 16 attempts at fixed `STEP=80` offsets — no fall-through to a random search if all 16 fail.
- Doesn't validate against the engine's actual `validatePlacement` function (re-implements the rules, which is a drift risk).
- Returns `null` silently — the engine command then no-ops, which is invisible to the policy *and* burns the cancel penalty.

**Recommendation:** when `chooseBuildPosition` returns null, the macro-action should report "illegal" so the legal-action mask reflects reality. Right now the policy can pick "build barracks @ near_crystal", it goes through `expandMacroAction` → empty command list → silent no-op. That's a free-action exploit waiting to happen.

### 5.4 Movement arrival check is O(N²) per tick

`server/src/match/engine/movement.js:22–43` (the v0.2.10 fix for crystal-arrival hitbox) does, for each moving entity, a scan over every other entity to find any large entity at its target position. With N≈80 entities, that's 80×80 = 6,400 distance computations per tick *just for movement*. The training-loop SPS is already CPU-bound; this isn't the bottleneck today but it will be at 200+ entity counts.

**Recommendation:** build the "large entities by position" lookup once per tick (a 10×10 spatial bucket), reuse in both combat and movement.

### 5.5 Passive-win threshold (4500 resources) vs IdleBot

Vs IdleBot, blue might never have enough resources to win economically before IdleBot does (IdleBot mines uninterrupted). This adds an *invisible* termination condition the policy can't reason about. If IdleBot crosses the passive threshold first, blue gets a -100 even though it might have been "playing fine". A cleaner setup against IdleBot is to disable the passive-win condition entirely (the team did this in some 0.1.x versions; it's no longer in DEFAULT_CONFIG).

### 5.6 `targeting_friend` action is broken and silently ineligible

The undefined-variable bug at `actionSpace.js:276` (referencing `playerId` that isn't a parameter) is a latent crash. It's been masked illegal in legalActions.js so it never executes — but the action exists in the enumeration, costs a logit, and would throw if anyone ever made it legal.

### 5.7 Replay format vs config drift

Replays save the version (good) but not the `MatchConfig` used. If a future training run is at smaller-map config, those replays will be misinterpreted by the viewer at full-map config. The "replay version mismatch warning" exists (per diary 2026-05-15) but it's coarse-grained.

---

## 6. Plan vs reality scoreboard

Cross-referenced against `ML_BOT_ACTION_PLAN.md §5`.

| Phase | Plan status | Actual status (2026-05-20) | Comment |
|---|---|---|---|
| **Phase 0** — Engine refactors | ✅ Mostly done | ✅ Tasks 1–5, 9, 10 complete; 6–8 deferred | Foundation is solid. |
| **Phase 1** — Headless + scripted bots | ✅ Complete | ✅ Exceeded (8 bots vs 4) | Done well. |
| **Phase 2** — Specs (obs/action/reward) | ✅ Complete | ⚠️ Specs lag code; reward spec mentions in plan acknowledge "source of truth is the code" | Drift risk; should auto-generate from code. |
| **Phase 3** — Python training harness | ✅ Complete | ✅ Strong, well-optimised | Best part of the project. |
| **Phase 4** — League training | ⚠️ "Curriculum in progress" | ❌ Effectively *broken*: curriculum abandoned at v0.2.0; league code exists but never activated | This is where the project has gotten stuck. |
| **Phase 5** — Replay viewer + balance tools | ⚠️ Partial | ⚠️ Replays + browser work; `eval/balance_report.py` exists per `training/balance_report.py` but no recurring use | Replays *are* the diagnostic engine. Use is good. |
| **Phase 6** — Production bot | ⚠️ Blocked on Phase 4 | ❌ ONNX export not written; "Hard" bot is still scripted MacroBot/RushBot | Correctly waiting on a trained policy. |
| **Phase 7** — Permanent instrument | ❌ Not yet | ❌ Not yet | Correctly deferred. |

**Stop-the-line conditions from `§8`:**

| Condition | Triggered? | Honoured? |
|---|---|---|
| Phase 0 stretches beyond 1 week | No | n/a |
| **Phase 3 training never beats IdleBot** | **YES — repeatedly, for ~30 days** | **NO** |
| Phase 4 win rate plateaus below 60 % after 20 M steps | YES (v0.2.2: 0% after 20M; v0.2.6: 9 % after 20M) | Partially (the team did pause and rewrite reward) |
| Bot exploiting a sim bug | YES (worker-vs-crystal exploit in v0.2.8) | Yes, fixed in combat.ts |

The most important stop-the-line, the IdleBot one, has been triggered and not honoured. That is the single highest-priority item to fix.

---

## 7. Recommendations (ranked by impact)

### 7.1 Stop the line. Adopt a 2-week feature freeze on reward shaping.

Do not change `computeReward()` for 2 weeks. Any change to `stdioRunner.ts` / `stdioVecRunner.ts` reward logic should be reverted, not extended. The current reward function is too complex to reason about; further changes are not net-positive.

### 7.2 Behaviour-cloning warmup

Implement the BC pre-train explicitly listed in the plan's stop-the-line response:

```
1. Run RushBot vs IdleBot for ~500 episodes, log (obs, action) tuples → ~1 GB
2. Train CrystalFrontAgent with cross-entropy loss for 1–3 epochs
3. Save as bc_warmup.pt
4. Start PPO from bc_warmup.pt, ent_coef = 0.02 (low — exploit the prior)
```

Expected: agent reaches the enemy crystal in the *first* PPO update, not the 600th.

Effort: 1–2 days. Risk: low (the pipeline exists). Expected outcome: cuts time-to-first-win from "never" to "an afternoon".

### 7.3 Re-introduce a real curriculum, with **fine-grained steps**

Define `MatchConfig` overrides keyed by phase:

| Phase | Map width | Crystal HP | Starting resources | Pre-placed | Opponent |
|---|---|---|---|---|---|
| 0a | 800 | 50 | 200 | 1 barracks + 2 skirmishers | idle |
| 0b | 800 | 50 | 200 | 1 barracks | idle |
| 0c | 800 | 50 | 50 | none | idle |
| 1a | 1500 | 100 | 50 | none | idle |
| 1b | 1500 | 100 | 50 | none | passive |
| 2a | 3000 | 300 | 50 | none | passive |
| 2b | 3000 | 300 | 50 | none | rush_weak |
| 3a | 6000 | 1000 | 50 | none | passive |
| 3b | 6000 | 1000 | 50 | none | rush_medium |
| 4 | 6000 | 1000 | 50 | none | league |

Promote from one phase to the next on `win_rate ≥ 0.7 over 100 episodes`. Each phase takes minutes to hours, not days. The autonomous loop already in the diary is the right mechanism for this; reactivate it.

### 7.4 Simplify the reward function

Target: ≤ 6 reward components. Suggested set:

| Source | Magnitude | Rationale |
|---|---|---|
| Terminal | ±100 (combat win / any loss) | Dominant signal |
| Crystal damage (delta-based) | +5 × healthFrac_delta_dealt | Continuous reward for the right behaviour |
| Crystal damage taken | −2 × healthFrac_delta_taken | Light, asymmetric |
| Barracks first-build | +10 (one-time) | Bootstrap shaping |
| Combat-unit first-train | +5 (one-time) | Bootstrap shaping |
| Time penalty | −0.001/tick (= −6/ep on full ep) | Mild urgency |

Everything else — mining, visibility, scouting, building bonuses, cancel penalties, defenseless trickle, abandoned-building, wrong-building-first — **delete**. They're each individually defensible and collectively poisonous.

Acceptance criterion: total achievable shaping per episode < 50 (vs current ~150).

### 7.5 Make the curriculum the unit of iteration

A run is a **curriculum traversal**, not a fixed-config 20 M-step blast. The training script should:

1. Load current curriculum stage.
2. Train until `win_rate ≥ promotion_threshold` over `eval_window` episodes.
3. Promote stage, log promotion event, continue.
4. If stage is unsolved after `max_steps_per_stage`, regress to previous stage and lower difficulty.

This converts the existing 50-version reward-tuning loop into a 5-stage promotion loop with built-in regression. The team can then go to bed and find out in the morning which stage the agent is stuck on, not "another 20M steps of −95".

### 7.6 Cap shaping per episode, *not* per tick

Move from "clamp episode shaping ±20" (v0.2.0, broken because flat) to per-component caps:

```ts
const caps = {
  mining:        +5,
  visibility:    +2,
  scouting:     +10,
  building_bonus:+5,   // if you keep it at all
  // ...
};
```

Apply caps inside `computeReward()` by tracking per-episode accumulators and short-circuiting once cap is hit. Preserves marginal gradient inside each band; prevents any single source from dominating.

### 7.7 Make legal actions and the index agree

Add a unit test:

```ts
test("every action index has at least one state where it is legal", () => {
  for (let i = 0; i < ACTION_SPACE_SIZE; i++) {
    // synthesize a state in which action i is intended to be legal,
    // assert getLegalActions returns it
  }
});
```

Then either implement or delete `targeting_friend`/`spread_fire`. Fix the `playerId` bug in `actionSpace.js:276` regardless.

### 7.8 Centralise reward in one module

Extract `headless/src/reward.ts` and import from both runners. Add a snapshot test: same (prev, curr, done) inputs → identical reward. Prevents drift.

### 7.9 Treat episode length as a *tuneable*, not a constant

`MAX_TICKS = 6000` is hardcoded in both runners. It should be a config parameter. Curriculum stage 0a needs 1500 ticks; 3b needs 6000. Different stages, different limits.

### 7.10 Activate the league only after Phase 0 is solved

The league code (`training/ppo/league.py`) is well-built and currently dormant. **Keep it dormant.** League training before atomic-skill mastery is wasted compute — you'd be PFSP-sampling opponents the policy can't beat *any* of. Once the curriculum hits stage 3b, switch to league mode against scripted bots + recent checkpoints.

---

## 8. What "good" looks like, 4–8 weeks from now

If the recommendations above are followed:

| Milestone | Plausible timeline | Acceptance criterion |
|---|---|---|
| BC warmup gives non-trivial baseline policy | 1 week | Policy reaches enemy crystal in > 50 % of vs-IdleBot episodes |
| Curriculum stage 0c (no scaffolding, small map, vs IdleBot) | 2 weeks | `win_rate ≥ 0.85` |
| Curriculum stage 2b (3000 px, vs WeakRush) | 4 weeks | `win_rate ≥ 0.70` |
| Curriculum stage 3a (full map, vs PassiveBot) | 5 weeks | `win_rate ≥ 0.70` |
| Curriculum stage 3b (full map, vs MediumRush) | 6 weeks | `win_rate ≥ 0.50` |
| League activation | 6 weeks | League stable for 20 M steps |
| First human-vs-policy playtest | 7 weeks | Human reports policy is "interesting" |
| ONNX export + live integration | 8 weeks | "Hard" tier in lobby is a trained policy |

These are *plausible*, not guaranteed. The biggest unknown is whether the existing architecture is expressive enough for the full game. The set-transformer + 384-hidden trunk is on the low end for a real RTS — AlphaStar used hundreds of millions of parameters. But that's a question to answer *after* solving Phase 0.

---

## 8.5 Additional issues & gaps not covered above

A second pass over the codebase surfaces a few more things worth recording. None of these is the blocker; they're items to be aware of.

### 8.5.1 Hyperparameter sanity

Current PPO config (training/ppo/train.py):

| Param | Current | Healthy range | Note |
|---|---|---|---|
| `learning_rate` | 3e-4 | 1e-4 – 5e-4 | Fine |
| `gamma` | 0.995 | 0.99–0.999 | OK in absolute terms; *wrong for this horizon* (§4.3) |
| `gae_lambda` | 0.95 | 0.9–0.97 | Fine |
| `clip_coef` | 0.2 | 0.1–0.3 | Fine |
| `ent_coef` | 0.02 (default) / 0.10 (in v0.2.10) | 0.01–0.1 | OK, but 0.10 is high — that's why you see the noise/oscillation |
| `vf_coef` | 0.5 | 0.5 (canonical) | Fine |
| `num_steps` | 1536 | depends on episode | Fine post-v0.2.8 |
| `num_minibatches` | 6 | 4–32 | Fine |
| `update_epochs` | 4 | 3–10 | Fine |
| `max_grad_norm` | 0.5 | 0.5–1.0 | Fine |
| `mlp_hidden` | 384 | 64–1024 | Fine for this scale |

**Beginner read:** none of these are dramatically wrong. The reason training is stuck is not "wrong hyperparameters". Don't sweep these; the problem is upstream.

### 8.5.2 `anneal_lr` over the full horizon

`anneal_lr=True` reduces the LR linearly from `3e-4 → 0` over `total_timesteps`. If you resume from a checkpoint and re-run the full schedule, you get *two* anneals in series. Worth verifying that `update` is restored correctly when resuming (current code: `cfg.checkpoint` loads agent + optimizer but the *anneal* fraction `1 − (update−1)/num_updates` always re-starts at 1.0 because `update` is the loop variable, not loaded). Net effect: LR is too high after every resume.

**Recommendation:** when resuming, also restore `update` (and therefore the LR schedule position) from the checkpoint. The checkpoint already stores `update` (line 676).

### 8.5.3 `torch.compile(reduce-overhead)` + dynamic shapes

The compile mode is set with `dynamic=False`. The observation tensors are padded to `MAX_ENTITIES=64`, so shapes are static — that's fine. But the *legal mask* shape is fixed to 81, so OK. **Watch out** when you next expand the action space: a shape change will silently recompile (slow first batch).

### 8.5.4 The `episode_reward` printed in logs is misleading

In `train.py` line 480 the printed `ep_rew` is the running sum *of the policy's reward signal*, which includes all shaping. The diary tracks this number as if it were "fitness". It's not — it's "how well the policy hacked the reward function". A `ep_rew=−95` with no wins is a clearer signal of failure than the diary acknowledges. Consider printing **two** numbers:

```
ep_rew = -95.2    (with shaping)
ep_ret =  -100    (terminal only)
```

So you can see at a glance whether learning progress shows up in the *true* objective.

### 8.5.5 Win-rate window is per-env, not stratified

`WIN_WINDOW=100`: 100 episodes from the most recently completed env. Across 20 envs at different opponents, this can skew. Fine vs IdleBot only; relevant when league or `combat_medium` (mixed opponents) is active.

### 8.5.6 Action histograms are *all-action*, not legal-conditioned

`action_counts` (line 380) tracks raw policy outputs. A 95 % noop reading might be "policy can't think of anything", *or* it might be "only noop and a few illegal actions were available". Add a parallel histogram of `legal_action_counts` to disambiguate.

### 8.5.7 Replay-saving cadence vs vec env

`save_replay_every=10` interacts with vec_size=4 in non-obvious ways: each of the 5 procs has its own counter, so 5 replays save per `every` cycle. With many parallel envs, the disk fills fast. The current setting of 10 + 5 procs → ~50 replays per 10 episodes per env. Worth tracking.

### 8.5.8 `lifetimeResources` is unbounded

`ownLifetimeResourcesFrac` is normalised by `passiveWinThreshold * 2 = 9000`. In a 6000-tick episode of full mining you can exceed this; observation clamps at 1.0. After clamp, the agent is blind to additional mining — fine. But the *reward* (line 181) uses raw `delta * (threshold*2)` which is also clamped via the obs normalisation. Net: mining reward saturates at ≈ 0.000001 × 9000 = 0.009 per episode. Tiny. Probably *too* tiny to be useful; consider removing entirely.

### 8.5.9 Mirror-symmetry of the policy is implicit, not enforced

The policy plays both blue and red (D5 in the plan). Observations are mirrored when playing red — but in the codebase I don't see explicit mirroring. The bot color is hardcoded `BLUE_ID` in the stdio runner; red is the scripted opponent. **The policy never trains as red.** This is fine for vs-scripted-bots evaluation but breaks the assumption when you eventually want self-play (which is what the league setup expects). Worth being explicit.

### 8.5.10 `tunableop_results0.csv` is in the repo

This file is the ROCm TunableOp tuning cache. It's machine-specific and changes constantly. Should be in `.gitignore`. Currently shows as modified in `git status`.

### 8.5.11 Two committed-but-uncompiled changes in `git status`

You have uncommitted modifications to many `.js` files and three new untracked `.d.ts` bot files (mediumRushBot, passiveBot, weakRushBot). The `.js` files in `headless/src/` look like compiled output of TypeScript that should be in `dist/`. This is a chronic problem — `c0fb7d4` ("remove accidentally committed compiled JS artefacts from server/src") fixed it server-side but the headless side still ships `.js` artefacts. **Recommendation:** add `headless/src/**/*.js` and `headless/src/**/*.d.ts` to `.gitignore`, move compiled output to `headless/dist/`, fix the imports.

### 8.5.12 Headless-harness tests exist but have key gaps

**Correction:** the original draft missed that `tests/index.ts` does include a "Headless" block (lines ~1395–1525) covering:

- Action-index round-tripping (all 81 actions index↔action stable).
- `getLegalActions` validity (every emitted action has a valid index).
- `legalMask` covers all legal actions.
- `expandMacroAction` produces *at least one* successful command per action category.
- `buildObservation` returns sane shapes and entity owners.

What's still missing — and what would have caught the historical bugs:

- **Mirror symmetry**: `buildObservation` for blue vs red on a mirrored state should produce mirrored outputs. Not asserted; almost certainly broken (see §4.5 below for evidence — most coord math uses hardcoded `MAP.width` rather than `match.config.mapWidth`).
- **Every-variant validity**: the current test passes as long as *one* variant succeeds; if `build_barracks @ near_crystal` fails silently but `build_barracks @ mid_base` succeeds, the test reports OK. The historical `chooseBuildPosition` `MAP.width` bug *did* leave some zones working, which is precisely why the test passed during the 8-version regression.
- **Reward determinism**: `computeReward(prev, curr, done, winner, winType)` is a pure function (modulo the milestone-state side effect). Should have a snapshot test on a canned trajectory so changes to it can be reviewed against a numeric diff.
- **MatchConfig override sanity**: any test using `MatchConfig.mapWidth = 1000` would currently break, exposing all the hardcoded `MAP.width` references in `observation.js`/`actionSpace.js`/`legalActions.js`. None of the tests do this.

The lesson here is subtle: the team *has* a test framework, *did* write tests for the headless layer, and *still* missed the bug that ate 8 versions of training. The tests asserted weaker properties than the code needed. **Beware tests that exist but don't fail when the code is broken.**

### 8.5.13 No automated regression on policy quality

There is no script that does: "load checkpoint X, play 100 deterministic matches against each scripted bot, print win rates". This should exist; it's the only objective measure of policy quality. The `training/balance_report.py` exists but is for balance, not policy eval. Add `training/eval/eval_checkpoint.py`.

### 8.5.14 **MAJOR FINDING — `MAP.width` is still hardcoded across the headless layer**

The v0.1.72 bug ("`chooseBuildPosition` used `MAP.width` instead of `match.config.mapWidth` → 8 versions of silent build failures") was fixed *only inside* `chooseBuildPosition`. The same hardcoded constant is **still used in 15 other places** across `headless/src/`:

```
headless/src/observation.js
  L32   const mid = MAP.width / 2;
  L46   const ownCrystalX = ownCrystal?.x ?? (isBlue ? 100 : MAP.width - 100);
  L51   /MAP.width                              ← distance normaliser in nearestEnemyToCrystalDistNorm
  L117  xNorm: e.x / MAP.width                  ← entity x-normalisation (every entity, every tick)
  L134  const midX = MAP.width / 2;
  L137  xNorm: node.x / MAP.width               ← resource-node x-normalisation
  L141  Math.abs(node.x - midX) < MAP.width * 0.3   ← isContested check

headless/src/actionSpace.js
  L253  const mid = MAP.width / 2;              ← resolveAttackTarget midfield
  L337  const mid = MAP.width / 2;              ← resolveTargetZone setup
  L344  isBlue ? MAP.width - 100 : 100          ← enemy_crystal fallback
  L347  return { x: mid, y: MAP.height / 2 };   ← "midfield" zone
  L353  Math.abs(node.x - mid) < MAP.width * 0.35 ← contested_node filter
  L375  enemy_army fallback to enemy crystal
  L381  ownCrystal default fallback
  L408  findNode mid
  L415  contested filter

headless/src/legalActions.js
  L16   const mid = MAP.width / 2;
```

**Why this matters:** the team's curriculum-recovery plan (re-enabling Phase A small-map training, as recommended in §7.3) **will not work** until these are fixed. On a `mapWidth=1000` config:

- `xNorm = e.x / 6000` for a unit at x=500 (midfield in the small map) reports `0.083` to the policy — the policy reads this as "still in own corner". The set-transformer never sees `xNorm > 0.17` because nothing on the 1000-px map can have `e.x > 1000`.
- `resolveTargetZone("midfield")` returns `{x: 3000}`, which is *outside the 1000-px map*. The engine then clamps moves to `mapWidth - radius = 990`, so the agent's "midfield" attack effectively becomes "right corner of the small map" — i.e. attack the enemy crystal. Whether that helps or hurts depends on the curriculum stage but it definitely isn't what the policy thinks it asked for.
- `isContested` triggers on `|node.x - 3000| < 1800`, so on a 1000-px map *every* node passes the check. The "contested-node" zone collapses.
- `legalActions.js:16 const mid = 3000;` — fortunately only used in `assign_workers` filtering, which still picks an existing node; effect is mild but the bug is real.

This is exactly the *same class* of bug that ate v0.1.68–v0.1.75-ML. **The lesson didn't generalise.** It was patched in one function rather than the underlying anti-pattern (using `MAP.width` anywhere outside live-game UI rendering).

**Fix:** introduce a `MatchContext` helper at the top of every headless function that pulls `mapWidth` and `mapHeight` from `match.config`, never from `MAP`. Or: rename `MAP` to `LIVE_MAP_CONSTANTS` and ban it from `headless/src/` via an ESLint rule (`no-restricted-imports`). Cheap and would catch every regression.

This is item #1 on the "before the curriculum can resume" checklist.

### 8.5.15 Documentation drift in scripted bots

`headless/src/bots/passiveBot.js` opens with: *"Purpose: provide positive terminals (+30) to bootstrap the value head."* The +30 terminal was removed in v0.2.0 (now ±100). Comments lie. Not a blocker; an indicator of drift.

Several other bots have similar stale-comment risk. Worth a sweep.

### 8.5.16 Live "Hard" tier is **MacroBot**, not RushBot

`server/src/index.ts:452–454`: easy→IdleBot, medium→RushBot, hard→MacroBot. The plan's diary at one point said hard=RushBot. Whichever is "harder" in practice is empirical, but this is worth pinning down once the trained policy is ready to take over the "hard" slot. (Don't ship a trained policy that loses to MacroBot.)

---

## 8.6 Recurring patterns — what we've done repeatedly that has caused ongoing mistakes

Reading the diary end-to-end, the same 10 patterns appear over and over. Naming them is the first step to breaking them. Each is paired with a one-line rule for the next 6 months.

### Pattern P1 — *Adding signal instead of removing it*

Every diary entry that diagnoses a failure ends with **"so I added X reward / X penalty / X action variant"**. Almost none end with **"so I removed X"** or **"so I reduced X"**. Across 50 versions: the action space grew from 37 → 81 (+119 %), and the reward function grew from ~6 components to ~20+. Each addition individually defensible; collectively the system has *too many free parameters* for the team to reason about.

**Rule R1 — Default to subtraction.** If a fix can be achieved by *removing* a signal or *reducing* a magnitude, do that first. Only add when the gap can't be closed by deletion.

### Pattern P2 — *Treating the full run as the unit of iteration*

The diary shows 50 versions, each ≈ 5 M–20 M steps, each consuming hours of GPU time and at least one focused human session. That's the natural cycle of a published RL paper, not of a hobbyist trying to learn. The vast majority of changes could have been validated in **1–2 M steps** (a 15-minute run) before committing 20 M steps of compute.

**Rule R2 — Until a change reliably moves a metric in 15 minutes, don't run it for 5 hours.** Establish a *smoke test* config (small map, short episodes, 1 M steps) and run every change through it first. If the metric doesn't budge in the smoke test, the bigger run won't fix it.

### Pattern P3 — *Pendulum thinking instead of gradient thinking*

Repeated motion: "full config doesn't work, switch to scaffolded → scaffolded works (good!) → switch back to full config → broken again → return to even more scaffolded → ...". The team kept flipping between **two extreme presets** rather than designing a gradient between them. v0.1.66 was the textbook case (Phase B → no scaffolding at all).

**Rule R3 — Curriculum is a slider, not a switch.** When a scaffolded version works, the next step is to take **one** scaffold away, not all of them. If you can't enumerate intermediate stages, you don't yet understand the curriculum.

### Pattern P4 — *Diagnosis-after-burn, not pre-flight*

Bugs were typically discovered by replay analysis *after* 5–20 M steps of failed training. The `chooseBuildPosition` MAP.width bug went undetected for 8 versions because *no version was pre-flight-tested* against a manual smoke trajectory ("on this exact seed, with this exact config, the agent should successfully build a barracks at tick 200"). The diary repeatedly reads "Killed at update 235 after replay analysis confirmed the failure mode" — a confirmation that came at update 235, not update 5.

**Rule R4 — Every config change comes with a one-trajectory pre-flight.** Before running 5 hours, manually play the first 1000 ticks of one seed and check the obvious things: do builds succeed? Do units move toward the right target? Are observations sensible? This is 5 minutes of work that saves 5 hours.

### Pattern P5 — *Tuning multiple things in one version bump*

v0.2.4 changed *five* things in one version: removed shaping clamp, raised barracks milestone, added 5 worker-movement actions, changed action space size 66→71, restarted from scratch. When it failed, no one could tell which of the 5 changes broke (or kept-broken) the run. Half the diary entries have this structure.

**Rule R5 — One change per version.** Even if it feels slow. If the run improves, you know why. If it regresses, you know why. Compound changes destroy the diagnostic signal — and diagnostics are the most valuable artefact you produce.

### Pattern P6 — *Conflating "metrics improving" with "agent learning the right thing"*

Several diary entries read like "ep_rew is rising — progress!" followed two pages later by "but we discovered the agent is just exploiting visibility reward". The training-loop `ep_rew` includes shaping; it is *not* a measure of policy quality. The team kept anchoring on it anyway.

**Rule R6 — Separate evaluation from training metrics.** Always log two numbers: (a) `ep_rew` with shaping, (b) terminal-only `ep_ret`. The number that matters is (b). When (a) and (b) diverge, that's the signal of shaping-hacking. The codebase doesn't expose (b) clearly today; fixing that is a one-line change in `computeReward()` (write `info.terminalReturn` separately) and would have caught at least three exploits earlier.

### Pattern P7 — *Patching the symptom function, not the anti-pattern*

The v0.1.72 fix patched `chooseBuildPosition` but did not generalise to the other 15+ uses of hardcoded `MAP.width`. The v0.2.6 worker-attack fix changed `combat.ts` but did not surface "any other hardcoded assumption that workers behave like combat units" (turns out: yes, the worker-vs-crystal damage chain). Each fix is local; the underlying anti-pattern persists.

**Rule R7 — When you fix a bug, search the rest of the codebase for the same shape.** `grep` for the pattern. Add an ESLint rule or a test. If the bug ever recurs in a different file, the codebase is asking you to abstract it.

### Pattern P8 — *Ignoring your own written stop-the-line rules*

`ML_BOT_ACTION_PLAN.md §8` literally says: "Phase 3 training never beats `IdleBot`. Pipeline is broken, not a tuning problem. Don't move forward." This condition has been met for ~30 days. The team kept tuning anyway.

**Rule R8 — When a stop-the-line condition triggers, *stop*.** Write down in big letters why, on what date, with what evidence. Schedule the post-mortem before the next training run. The plan you wrote in calm hours is wiser than the plan you'll improvise mid-run.

### Pattern P9 — *Duplicating runtime code instead of extracting a module*

`stdioRunner.ts` and `stdioVecRunner.ts` carry near-identical reward functions (~340 lines and ~210 lines respectively). The diary even calls out "Two lines changed in both `stdioRunner.ts` and `stdioVecRunner.ts`" at v0.2.9 — and treats this as a footnote rather than as a flashing red light. (The project's own `LLM_GUIDE.md` rule #1 is literally **"Don't Copy-Paste — Extract After 2nd Use"**, which is being violated here.)

**Rule R9 — Reward logic lives in one file.** Extract `headless/src/reward.ts` now, not "later when there's time".

### Pattern P10 — *Believing the AI assistant's plausible-looking patch without an independent check*

This one is inferred from pattern, not stated in the diary. Many fixes have the structure: "AI suggested adding penalty X" → "added penalty X" → "X became the next exploit". Plausible-looking RL fixes are the AI's weakest output mode (see §9.4 for why). The team kept accepting them.

**Rule R10 — On any RL change, ask the AI two questions before accepting: (a) "what is the cheapest way the agent could exploit this?" and (b) "what change *removes* a signal instead?"** If the assistant can't answer (a) convincingly, don't apply the change. If (b) is plausible, prefer it.

### Summary — the meta-pattern

All 10 patterns share a common root: **the team has been treating the project as a series of fixes to the latest failure, rather than as a series of investments in faster, cheaper iteration**. Each individual fix looks rational. The aggregate is 50 versions, 30 days, zero IdleBot wins.

The cure is not more cleverness. It is process changes that *force* fast iteration: smaller runs, single-change versions, pre-flight checks, stop-the-line discipline, eval-vs-training separation. None of these are technically hard. They are habits.

If only one rule is adopted: **R2 (smoke test before full run)**. It alone will compress the next month's progress into the next week.

---

## 9. Beginner-focused guidance and support

This section is written specifically for the project owner, recognising this is your first ML project and that you've been using AI assistance to build it. None of what's below is criticism; it's the field guide that the AI you're using probably hasn't given you.

### 9.1 What you should feel good about

Genuinely. List for the record:

- You shipped a working deterministic game engine that hashes consistently across runs. Most ML projects *never* get this far; they fight non-determinism for weeks.
- You built a JSON-line subprocess protocol from scratch that drives 20 parallel games from Python. This is the kind of glue that a lot of professional teams spend a sprint on.
- You read your training logs. Most beginners stare at TensorBoard and don't know what to look for. You spotted the worker-swarm exploit *from replay analysis*. That's a senior-engineer skill.
- You keep a real engineering diary. Most beginners don't, and they don't learn from their mistakes because they can't reconstruct them. Your diary will be the most valuable artifact of this project even if you never ship the bot.
- You bumped versions, tagged runs, and saved checkpoints by version. This is hygiene most people don't develop until their second or third ML project.

The list of things you've gotten right is much longer than the list of things you've gotten wrong. The reason this review is mostly about the wrong things is that the right things don't need help.

### 9.2 The deep ML concept that's biting you

If you take one mental model away, take this one:

> **Reinforcement learning agents only learn from gradients. A gradient only exists when there is *variation in reward* between similar trajectories.**

In your vs-IdleBot setup, almost every trajectory ends in `-100 terminal`. The only variation is in the shaping reward — so the agent learns to maximise shaping, not to win. You can add more shaping (what you've been doing), but every shaping signal you add is also a gradient the agent can exploit. The "right" amount of shaping is enough to *bridge* to the terminal — not enough to *replace* it.

The standard trick to create real variation in the terminal is **make the task easy enough that the agent occasionally wins by accident**. That's literally what curriculum learning is for. Once you have wins (even rare ones), PPO can amplify the actions that led to them. Without wins, PPO can only amplify whatever shaping it can find.

### 9.3 What "good" RL iteration cycles look like for a beginner

The cycle you've been doing:

1. Think hard about what reward signal might help.
2. Code it up.
3. Run 20M steps (hours-to-a-day).
4. Watch it fail.
5. Diagnose.
6. Go to step 1.

This is the **most expensive possible iteration loop**. Each cycle is half a day to a day of clock time.

The cycle you want:

1. Pick the *simplest possible task* the agent could solve. (Hint: pre-placed barracks + 3 skirmishers vs 50 HP crystal on 500 px map — i.e., Phase A.)
2. Train for **15 minutes**. (Not 20M steps. Whatever fits in 15 minutes — 1–2M steps.)
3. If `win_rate > 0`, ratchet difficulty up by one notch. If not, *make it easier*.
4. Loop, ratcheting up.

This cycle gets you 30–40 iterations per day instead of 1–2. Each iteration teaches you something. The whole *project* moves on the same calendar.

This is the reason the BC-warmup and curriculum recommendations are repeated throughout this review. They're not about being clever. They're about getting your iteration time down from "tomorrow" to "15 minutes".

### 9.4 Specific advice for AI-assisted coding on an RL project

A few patterns to watch for, because AI assistance has specific failure modes on RL projects:

- **AI will happily add more reward components.** They're easy to write and they feel productive. They are usually the wrong fix. When the assistant proposes "let me add a reward for X", ask: *would the literature recommend this, or would it recommend reducing the task instead?*
- **AI is good at TypeScript and Python plumbing. It is bad at RL strategy.** Trust it for "wire up a vectorised env"; distrust it for "what should we do to escape this local optimum?"
- **Hyperparameter tuning is a trap when the algorithm is fine.** If an assistant suggests tuning `gamma` or `ent_coef` to fix a 0-win-rate run, that's almost always wrong. The hyperparameters in `train.py` are fine. The problem is upstream.
- **Cargo-culting from CleanRL / Spinning Up.** Your code looks like CleanRL because CleanRL is a sensible template. Good. But CleanRL was designed for *short-horizon Gym envs*. Your environment is 100× longer-horizon than anything CleanRL tests on. The fact that you can't just point CleanRL at this and have it work is not a bug in your code.
- **"It's just one more reward tweak" is a sunk-cost story.** If you've made N reward tweaks and none helped, the (N+1)th probably won't either. The hardest thing in this project right now is *not* writing another v0.2.11 reward fix; it's putting the reward function down and going back to curriculum.

### 9.5 A 1-week plan you could actually follow

If you do nothing else from this review, try this:

**Day 1: Reset and observe.**
- Branch off, do not delete anything.
- Revert `computeReward()` to a minimal version: terminal ±100, crystal damage ±0.01/HP, time penalty −0.0005/tick. That's it. Delete everything else.
- Run vs IdleBot for 1M steps. Expect 0 wins. Confirm the floor: `ep_rew ≈ -103`. Good — that's the baseline.

**Day 2: Phase A reproduction.**
- Re-enable Phase A scaffolding from v0.1.65: 3 pre-placed skirmishers, map 500 px, crystal 50 HP, starting resources 200, MAX_TICKS 3000.
- Run vs IdleBot for 1M steps with the minimal reward.
- Expect win_rate → 1.0 within 50 updates. (Same as v0.1.65.) Confirms the pipeline still works.
- Save the checkpoint as `phase_A.pt`.

**Day 3: Phase B reproduction.**
- Remove the pre-placed skirmishers; keep the pre-placed completed barracks.
- Resume from `phase_A.pt`.
- Run for 1M steps.
- Expect win_rate → 1.0 within 100 updates. Save as `phase_B.pt`.

**Day 4: BC warmup.**
- Write `training/bc_pretrain.py`: load 500 episodes of RushBot vs IdleBot, train CrystalFrontAgent with cross-entropy on (obs, action) tuples for 3 epochs. Save as `bc_warmup.pt`.
- Spot-check: load `bc_warmup.pt`, play 100 matches vs IdleBot using greedy action selection. Expect a non-trivial win rate (≥ 30 %).

**Day 5: Phase C, the breakthrough you've been chasing.**
- Resume from `bc_warmup.pt`.
- Use Phase B's *medium* config: map 1500 px, crystal 200 HP, starting resources 50, MAX_TICKS 3000, no scaffolding.
- Run for 2–5M steps.
- Goal: `win_rate ≥ 0.5` vs IdleBot. **This is the breakthrough the project has been trying to reach for a month.**

**Day 6: Promote to passive_bot.**
- Same config, opponent changes from IdleBot to PassiveBot.
- Run for 2M steps. Goal: `win_rate ≥ 0.5`.

**Day 7: Reflect.**
- If you reached day 5 successfully, you have a working baseline policy. The rest of the project (bigger maps, league, ONNX) is mechanical from here.
- If you got stuck on a particular day, the *day itself* tells you what's wrong. (E.g. stuck on day 2 = the codebase has regressed since v0.1.65 and you need to find the bug. Stuck on day 4 = BC implementation issue. Stuck on day 5 = the credit-assignment gap really is the blocker, and you need to add a finer curriculum step.)

This is the unit of progress that should replace the v0.2.X reward iteration cycle.

### 9.6 Concepts to read up on (~3–5 hours of reading)

The minimum you need to be dangerous with PPO + RTS:

- **CleanRL PPO walkthrough** (already in your `§10`): https://docs.cleanrl.dev/rl-algorithms/ppo/ — read with code open.
- **"Reward shaping considered harmful"-style talks**: search for John Schulman's lectures on credit assignment, or Spinning Up's *"Tricks of the Trade"*.
- **Curriculum Learning**: Bengio et al., 2009, "Curriculum Learning" — the original paper is 6 pages and very readable.
- **Behaviour cloning warmup**: read the relevant section of the AlphaStar paper (the SC2 work) — they used 970 K replays of human games as a BC prior.
- **Sutton & Barto, Chapter 13** (Policy Gradient Methods). Not the whole book — just chapter 13. It's the chapter that makes PPO make sense rather than feel like magic.
- **Andy Jones' "Debugging RL"** blog post (https://andyljones.com/posts/rl-debugging.html). Specifically the checklist of "is your env broken? is your reward broken? is your network broken?" — apply each item to your project; you'll find at least one match.

That's a one-weekend reading list. After it, the rest of this review will read differently.

### 9.7 What's missing from your `ML_BOT_ACTION_PLAN.md`

The plan as written is **excellent** — among the best engineering plans I've seen for a hobby project. Two gaps worth noting for your next planning iteration:

1. **No section on `evaluation`.** "What does success look like, exactly?" — the milestones in §1 are too coarse. Add: "vs IdleBot ≥ 90 % wins in 100 eval episodes" and similar, per phase. That's the contract; everything else is implementation.

2. **No section on `iteration cadence`.** How fast should you be moving? When should you regress vs push forward? Without this, you implicitly defaulted to "run until completion every time" — which is the iteration loop that's hurt you most.

---

## 10. Final summary — what to do tomorrow morning

If you read nothing else in this review, read this.

**Do, in order:**

1. **Fix the `MAP.width` hardcoding in `headless/src/` (§8.5.14).** This is the blocker that will silently break the curriculum the moment you resume small-map training. 30 minutes of work; absolutely necessary.
2. **Extract `headless/src/reward.ts` and import from both runners (§4.4).** Stops drift. 1 hour.
3. **Add a `terminalReturn` log line distinct from `ep_rew` (rule R6).** One line in `computeReward()`. Lets you see at a glance whether shaping-hacking is happening.
4. **Stop running 20 M-step training jobs.** Reduce to 1–2 M-step "smoke tests" first (rule R2).
5. **Resurrect the Phase A configuration; reproduce v0.1.65's 100 % win rate.** If you can't, fix until you can. Without this baseline you have no platform.
6. **Strip `computeReward()` down to ≤ 6 components, all small. Cap each (§7.4).**
7. **Build the BC-warmup script (§7.2). Use it.**
8. **Write a curriculum traversal script that promotes on `win_rate ≥ 0.7`, regresses on stuck (§7.5).**
9. **Add a checkpoint-evaluation script** (`training/eval/eval_checkpoint.py`) that loads a checkpoint and plays 100 deterministic matches vs each scripted bot.

**Don't:**

- Add new reward components. Subtract them (R1).
- Move to the 6000 px map until the 1500 px / 3000 px stages are solved.
- Activate the league.
- Tune PPO hyperparameters. They're fine (§8.5.1).
- Add new actions to the action space (it's already large; 8 indices are permanently dead per §4.5).
- Run another full 20 M-step blind blast against IdleBot.
- Accept any AI-suggested "let's add a reward for X" patch without first asking "what's the cheapest way the agent could exploit this?" (R10).

**Spend your next 2 weeks on:**

1. Hardcoded-constant cleanup + reward extraction + terminal-return logging (1 day).
2. Phase A reproduction + BC warmup (3–4 days).
3. Curriculum traversal — fine-grained, automated, regressing-on-stuck (5–7 days).

That's the recipe. The infrastructure you have is excellent; the methodology needs to change. Once it does, this project will move faster in the next month than it has in the last three.

The 10 rules in §8.6 are worth more than this whole review. Print them, tape them above the keyboard, refer to them every time you're about to start a 20 M-step run.

You have done genuinely good work here. The path to a working bot is shorter than it feels right now. Keep going.

— *End of review.*

---
---
---

# CrystalFront ML Project — Second Review

**Reviewer:** Independent technical audit (continuation)
**Date:** 2026-05-21 (one day after original review)
**Branch under review:** `CrystalFront-ML` (v0.3.0-ML → working changes for v0.3.2-ML)
**Primary source:** training logs from this session + `docs/ML_BOT_ACTION_PLAN.md` v0.3.1 diary + code state at end of session
**Scope:** evaluation of the work done in the 24 hours since the original review; analysis of what the original review's recommendations produced; course correction for what remains

> **Framing.** The first review prescribed a methodology: stop tuning rewards, build BC warmup, run a fine-grained curriculum, gate on win-rate. The team executed that methodology in one focused session. Most of it worked — astonishingly well in places. One piece of it has hit a structural wall the original review did not anticipate. This second review documents what happened, names what the original review got right, names what it got wrong or underestimated, and gives a corrected path forward. **The tone is the same as the first review.** Direct, technical, willing to admit where the prescriptions need amendment.

---

## A1. Executive summary (continuation)

**What worked, decisively.** The original review's recommendations §7.2 (BC warmup), §7.3 (fine-grained curriculum), §7.5 (curriculum as unit of iteration), §7.8 (centralised reward module), and §8.5.14 (MAP.width hardcoding fix) were implemented in sequence. The result: starting from a fresh BC checkpoint (1000 episodes RushBot vs IdleBot on full game config), a single curriculum traversal cleared **13 consecutive stages in ~5 million training steps** — going from `0a` (small map, scaffolded) to `3a` (full 6000 px map, vs PassiveBot, 100 % wins). Most stages cleared in a *single 100-episode evaluation window* on the first measurement after entering the stage. This is the methodology working as advertised; the agent went from "cannot beat IdleBot in 30 days" to "beats PassiveBot on the full map at 100 %" in roughly six hours of wall time.

**What didn't work.** The transition from `3a` (passive, 6000 px) to `3a5/3b` (rush_medium, 6000 px) — a transition the original review's curriculum table treats as a single step — does not solve. Despite five distinct intervention attempts (one new scaffolded intermediate, a smaller-map intermediate, BC fine-tuning on multi-unit demonstrations, a second-unit milestone reward, and combinations of the above), the policy will not learn to train more than one combat unit, and rush_medium reliably intercepts a single skirmisher before it reaches the enemy crystal. **`trn=0 %`** has been the policy's stable equilibrium across every intervention.

**The deep insight.** The original review's curriculum implicitly assumed that the value gradient from "trained 1 unit → won" would extend naturally to "trained 2 units → won" when the task got harder. That assumption is broken by a specific dynamic the review did not name: **once PPO has reinforced a single-unit rush strategy across 200+ updates of "this worked", the policy assigns near-zero probability to the train action, and bootstrap shaping rewards cannot bootstrap an action that is never sampled**. This is the canonical exploration-exploitation failure mode of policy gradient methods — the original review's §3.1 named the credit-assignment gap, but did not anticipate that the credit-assignment problem would have a *second instance* one curriculum step deeper.

**What this means going forward.** Two-thirds of the original review's prescription was correct and produced exactly the predicted result. One-third — specifically the assumption that the curriculum could carry the policy from rush_weak through rush_medium without further intervention — has been falsified by experiment. The corrected path is laid out in §A6 below; it involves a small reward addition (already implemented, showing early signs of working), a more careful BC dataset, and a re-think of the *opponent ladder* rather than the *config ladder*.

---

## A2. The stage progression — what the curriculum actually did

| Stage | Map | Crystal | Opp | Scaffold | Result | Updates from prior |
|-------|-----|---------|-----|----------|--------|--------------------|
| 0a | 800 | 50 | idle | 2 skirm | 87 % @ u11 | from BC |
| 0b | 800 | 50 | idle | (barr only) | 83 % @ u52 | +41 |
| 0b5 | 800 | 50 | idle | none | 71 % @ u90 | +38 |
| 0c | 800 | 50 | idle | none, 50 res | 78 % @ u97 | +7 |
| day5 | 1500 | 200 | idle | none | 96 % @ u103 | +6 |
| 1a | 1500 | 100 | idle | none | 100 % @ u109 | +6 |
| 1b | 1500 | 100 | passive | none | 99 % @ u116 | +7 |
| 2a | 3000 | 300 | passive | none | 100 % @ u125 | +9 |
| 2a5 | 3000 | 300 | rush_weak | 200 res | 75 % @ u134 | +9 |
| 2a6 | 3000 | 300 | rush_weak | 75 res | 91 % @ u143 | +9 |
| 2b | 3000 | 300 | rush_weak | 50 res | 93 % @ u152 | +9 |
| 3a | 6000 | 1000 | passive | none | 100 % @ u160 | +8 |
| **3a5** | **6000** | **1000** | **rush_medium** | **none** | **0 % × 4 windows** | **stuck** |

Notable about this table:

- **The promotion velocity from `day5` onwards is extraordinary.** Eight stages cleared in 57 updates (~1.8M steps). When the curriculum design is right, the agent generalises across map size, crystal HP, and passive opponent variations almost instantly. **The original review's §7.5 prediction that "each phase takes minutes to hours, not days" is empirically correct.**
- **The resource-slider concept (added by the team mid-session) is validated.** The `2a5/2a6/2b` triple (200 → 75 → 50 starting resources vs rush_weak) cleared cleanly; without those intermediates, prior runs had stalled at the rush_weak transition. This is **a refinement to the original review's curriculum table that should be folded in permanently**.
- **`wkr_mv` (worker-move-to-enemy-crystal) attractor never appeared** across the entire 5M-step traversal. The original review's §3 worry about worker-borne value-function exploitation, after the MAP.width fix and the resource-slider design, was avoided. This is a real change vs the pre-review codebase; both the bug fix and the curriculum design contributed.
- **`trn` (train-additional-unit fraction) is 0 % at every stage**, including the wins. The policy is winning every solved stage with exactly one self-trained skirmisher and a rush. This is the key diagnostic — see §A3 below.

The stuck point is precisely at **3a5**: full game map, full crystal HP, vs rush_medium. The wins disappear and stay gone.

---

## A3. The `trn=0 %` bottleneck — a diagnosis the original review missed

This section is the heart of the second review.

### A3.1 The phenomenon

Across every solved curriculum stage (0a through 3a), the action histogram shows:

```
atk_mv: 25-45 %      tgt: 0 %      bld: 0-1 %
trn:    0 %          wkr_mv: 0 %    noop: 50-75 %
```

`trn` rounds to 0 % at every measured update. The policy *does* train a single combat unit per episode (you can see `crys_dmg` rising, which requires a unit to exist), but the *fraction of action samples that are `train_unit`* is below the rounding threshold (< 0.5 %). One training event per episode out of ~2000 actions per episode is 0.05 % — which rounds to 0 %.

This is **fine for stages where one unit is sufficient to win** (passive opponents, weak rush, anything where the rush race is winnable with a single skirmisher on the agent's home turf advantage). It is **catastrophic against rush_medium on the full map**, because rush_medium sends 3 skirmishers and a single agent unit cannot survive the 1v3 transit fight.

### A3.2 Why the original review's prescription cannot reach `trn > 0 %`

The original review prescribed (§7.4) a 6-component reward function in which the only signal for unit training is `+5 (one-time) Combat-unit first-train | Bootstrap shaping`. The rationale was sound: bootstrap shaping should be sufficient to discover the *first* training event. It was. The review's implicit (and never-stated) assumption was that PPO's policy improvement would then *generalise* the value of training units, such that "more units = better" emerges automatically when the task requires it.

That generalisation does not happen here, for a reason worth naming:

> **The policy gradient for action `a` at state `s` is proportional to `π(a | s) × (R - V(s))`. When `π(a | s) ≈ 0` for a long enough stretch of updates, the gradient itself is approximately zero — even if R would be large were `a` sampled. The action becomes unreachable from inside policy gradient methods alone.**

This is a textbook failure mode of policy-gradient RL (it's why papers reach for KL constraints, intrinsic motivation, or imitation priors). The original review's §3.1 named the credit-assignment gap in the *temporal* axis (terminal too far from start); it did not name the *probabilistic* gap (action probability too low to sample). They are sibling failure modes; the project has now hit both.

### A3.3 Why pre-placed-unit scaffolds *do not* fix it

This is the subtler finding. The team's instinct (correctly drawing from review §7.3, Rule R3) was to add intermediate stages with pre-placed combat units, on the theory that this would create a graceful descent from "scaffolded win" to "self-trained win". This produced a measurable but unhelpful pattern:

| Stage attempt | Window 1 | Window 2 | Window 3 | `trn` |
|---------------|----------|----------|----------|-------|
| 3a2 (1 pre-placed skirm) | 0 % | 0 % | 0 % | 0 % |
| 3a1 (2 pre-placed skirm) | 4 % | 2 % | 1 % | 0 % |
| 3a_rm_3k (3000 px, 2 pre-placed) | 22 % | 6 % | 2 % | 0 % |

The pattern is consistent across all three: **a brief gradient seed in window 1, then monotonic decay to ~0–2 % wins**. This is not noise; it has now been replicated five times. The explanation is mechanical:

1. With pre-placed units, an episode where the pre-placed units happen to break through gets `terminal = +100`. PPO credits this win to *whatever the policy was doing during the episode* — which is `atk_mv` commands, not `train_unit`.
2. PPO updates increase the probability of `atk_mv` and decrease the probability of everything else, including `train_unit` (already near zero).
3. The pre-placed units are *constant across all episodes in the stage*, so once the policy fully exploits the "rush the pre-placed units" strategy, the marginal gradient flattens.
4. As the opponent's intercept logic responds to the (now stereotyped) rush, win rate decays.
5. With `trn` still 0 %, the policy never observes a successful "trained 2nd unit → won" episode, so the train-action probability is never reinforced.

**The scaffold paradox:** pre-placed units provide a *win-rate signal* (briefly) but not the *behavioural signal* the team intended. Scaffolds that don't require the agent to train a unit cannot teach the agent to train a unit. This was not obvious before the experiment; it is now.

### A3.4 Why BC fine-tuning on multi-unit demos also did not fix it

The team correctly inferred from the above that the policy needs an *external* prior nudge to keep `train_unit` sampled. Their approach (review §7.2-style BC fine-tuning, on 300 RushBot-vs-rush_weak episodes filtered to those containing `train_unit` actions, at `lr=1e-4`, actor-only, 3 epochs) was sensible. The BC fine-tune itself was clean:

- 300/300 demonstration episodes had `train_unit` actions (100 %)
- 309,688 transitions before noop subsampling → 30,036 after
- Final BC accuracy: 58.6 %; `train_unit` was 5.5 % of the kept actions
- Saved with `update=0` to force a fresh PPO optimizer (correctly applying the earlier lesson from BC v4)

But the *PPO behaviour after BC fine-tune* was unexpected:

- The fine-tuned policy lost much of its rush competence: `3a_rw` (rush_weak on full map), which had previously cleared at 89-91 % in **one** window, now needed **5 windows** to recover (20 % → 21 % → 14 % → 29 % → 48 % → 79 %).
- `atk_mv` dropped from 41 % to 15 % immediately after the fine-tune; `noop` rose from 57 % to 83 %. Rush behaviour was partially overwritten.
- On reaching the actual stuck stage (`3a_rm_3k` again), `trn` was still 0 % in the first window. The decay pattern 21 % → 3 % → 2 % was identical to the no-BC-fine-tune attempt.

Two diagnoses:

1. **Distribution shift between BC demos (3000 px / 300 HP) and PPO target (6000 px / 1000 HP).** Same problem the BC v3 → v4 transition uncovered. The xNorm and node positions differ; the policy doesn't generalise across the shift even though the action space is the same.
2. **Small-data BC fine-tune is a bigger surgical-instrument than the team expected.** 30k transitions at `lr=1e-4` was *enough* to perturb the policy's atk_mv probabilities, but *not enough* to install a stable train_unit prior. The fine-tune existed in a regime where it could damage but not repair.

The right BC fine-tune is probably ≥1000 episodes, on the *full* game config, with an even smaller learning rate (e.g. `1e-5`) — or no BC fine-tune at all (see §A6).

### A3.5 What the +3 second-unit milestone reward actually shows

At the end of the session, the team added a `+3 one-time second combat unit trained` milestone — labelled, by the team's own analysis, as a violation of the original review's 6-component target (this makes it 7 components) but justified as **the same class of intervention** (bootstrap shaping for an action whose discovery PPO cannot achieve alone). The review notes:

- Maximum achievable shaping per episode rose from ~20 to ~23, well under the original review's acceptance criterion of "< 50".
- The reward only fires once per episode and only when the agent has already trained a unit; it cannot be re-exploited within an episode.
- It does not create a new attractor of the v0.2.X variety (e.g., "build 3 barracks, do nothing"); it credits *only* a discrete event.

The current training run, after this change, shows the very first non-zero `trn` reading the project has ever recorded on `3a_rm_3k`:

```
u269: win=3% trn=0%
u282: win=2% trn=1%   ← first non-zero
```

This is *one update* of *one percent*. It is far too early to claim the reward "works". But it is the only signal in the entire session that suggests the train action is even being explored at this stage. **Recommendation: let this run for 2-4 more checkpoints (≈30 more updates) before declaring it failed or successful.** The original review's Rule R2 (smoke-test before full-run) should apply: 30 updates is a smoke test; 200 would be a full run.

If `trn` climbs to ≥ 3 % over the next ~30 updates with win-rate following, the +3 milestone is doing its job and should remain in the reward function. If `trn` does not climb, the milestone should be removed (Rule R1) and the next intervention should be tried.

---

## A4. What the original review got right (and what to keep)

To be specific about which prescriptions were validated by experiment:

| Original recommendation | Status after experiment |
|-------------------------|------------------------|
| §7.1 Stop reward-tuning shaping fire | ✅ Honoured. The 6-component reward held throughout the curriculum traversal until the very end (see §A5 for the one amendment). |
| §7.2 BC warmup | ✅ Essential. The 0a stage with BC weights cleared at 87 % in 11 updates; without BC, prior runs had needed 5-10 M steps to find even a single win against IdleBot. |
| §7.3 Fine-grained curriculum | ✅ Validated. The 11 fine-grained stages from 0a through 3a all cleared. **Add** the resource-slider sub-stages (2a5/2a6/2b) to the canonical table — they are not optional. |
| §7.4 Reward simplification | ✅ Done. `headless/src/reward.ts` is now 7 components (the original 6 plus the second-unit milestone). Total achievable shaping ~23 / episode. |
| §7.5 Curriculum as unit of iteration | ✅ Implemented. Auto-promotion, auto-regression on stuck, single curriculum script driving the whole traversal. This is how the project should run for the next year. |
| §7.7 Action-index unit test | ⚠️ Not yet done. Still recommended; the `targeting_friend` / `playerId` bug at `actionSpace.js:274` was fixed mid-session but no test exists to prevent regression. |
| §7.8 Centralise reward module | ✅ Done. `reward.ts` is the single source; both runners import it. |
| §7.9 Episode length as tuneable | ✅ Done. `max_ticks` is curriculum-stage-keyed. |
| §7.10 Activate league only after Phase 0 | ✅ Honoured. League is still dormant. **Caveat:** the team is now under pressure to activate it as an escape from the 3a5 stall (see §A6 for why this is premature). |
| §8.5.14 MAP.width hardcoding | ✅ Fixed. observation.js, actionSpace.js, legalActions.js all now read from `match.config.mapWidth`. |
| Rule R3 (curriculum is a slider) | ✅ Internalised. The team added 2a5, 2a6, 3a_rw, 3a_rm_3k all in pursuit of R3. |
| Rule R2 (smoke test before full run) | ⚠️ **Partially applied.** The curriculum traversal acts as a built-in smoke test for the curriculum design, but several individual interventions (BC fine-tune in particular) were applied without a 30-update smoke test first. |
| Rule R8 (stop-the-line on stuck) | ✅ **Decisively applied.** When 3a5 stalled at 0 % wins for 4 windows, the team stopped the run rather than letting it grind. This is the rule the team had been violating before; honouring it here is significant. |

**Net: the original review's prescription is overwhelmingly validated.** The methodology shift it called for has occurred and produced exactly the result it predicted. The team is no longer reward-tuning; they are curriculum-iterating, BC-warming, and stop-the-line-honouring. That is a real change.

---

## A5. What the original review got wrong or underestimated

In the same spirit of specificity:

### A5.1 The curriculum table's 2b → 3b jump changes two variables simultaneously

The original review's §7.3 table goes:

```
2b: 3000 px, rush_weak, 50 res, no scaffold
3a: 6000 px, passive,   50 res, no scaffold      ← changes 2 vars (map + opp)
3b: 6000 px, rush_medium, 50 res, no scaffold    ← changes 1 var (opp)
```

The team noticed this mid-session — Rule R3 says "one variable at a time", and the review's own table breaks R3 at the 2b → 3a transition. The team added `3a_rw` (rush_weak on 6000 px, 200 res) as a bridge stage, which cleared at 91 % in one window. **The original curriculum table should be amended to include `3a_rw` as a permanent stage** before any rush_medium attempts.

### A5.2 The implicit "1 unit is sufficient" assumption

The original review's strategic chain (§3.1) ends with "skirmisher rushes crystal, attacks, ~210 ticks of damage, wins". This is correct against IdleBot. It is *not* correct against rush_medium, where rush_medium's 3 skirmishers will arrive at the agent's crystal in approximately the time it takes the agent's single skirmisher to cross the map. The review never made the **opponent-conditional** claim "1 unit is sufficient for opponent X but not opponent Y", and the curriculum design tacitly assumed otherwise.

A more honest statement: **the minimum-unit count for each opponent on the full map is approximately**:

| Opponent | Min units to win | Why |
|----------|------------------|-----|
| IdleBot | 1 | opponent does nothing |
| PassiveBot | 1 | opponent builds but does not attack |
| RushWeak | 1 (on 3000 px) / 1-2 (on 6000 px) | opponent sends ~1-2 weak units, late |
| RushMedium | 2-3 | opponent sends 3 skirmishers, mobilises fast |
| Rush / Macro / Heavy | ≥3 | full economy + multi-front |

The curriculum should be designed around *unit-count progression*, not just config knobs. The team's `3a1` (2 pre-placed skirmishers) was an instinctive groping toward this insight, but as §A3.3 showed, pre-placement is the wrong implementation — what's needed is **a stage where 1 unit is insufficient AND the agent can win by training a 2nd unit**, which is a far stricter constraint.

### A5.3 The "bootstrap shaping" framing has a gap

The original review (§7.4) classifies the `+5 first combat unit trained` as "Bootstrap shaping". The implicit logic: PPO can't easily discover this action chain, so we give it a one-time crumb to make the discovery happen. **But the framing is incomplete: bootstrap shaping only works if the policy occasionally samples the bootstrapped action.** In §A3.2, we saw that after 200+ PPO updates of single-unit success, the second-unit train action probability falls below the rounding threshold. At that point, the bootstrap reward never fires, regardless of how large it is.

A more honest formulation:

> **Bootstrap shaping rewards must be paired with a mechanism that *keeps the action sampled* until the reward catches.** Mechanisms include: (a) BC priors that include the action in their demonstration data; (b) entropy regularisation tuned high enough at the relevant stage; (c) curriculum stages where the action is mechanically necessary; (d) intrinsic motivation / count-based exploration; (e) population-based methods with explicit diversity.

The team has implemented (a) and (c) partially. (b) is forbidden by review §9.4 (and was for good reason). (d) and (e) are not in the toolkit. **This is the gap the second review identifies most concretely.**

### A5.4 The review's hyperparameter warning is correct *but creates a corner*

Review §9.4 says: *"If an assistant suggests tuning `gamma` or `ent_coef` to fix a 0-win-rate run, that's almost always wrong."* This is empirically a good rule for the project's historical failure mode (the v0.2.X reward whack-a-mole). However, applied universally, it leaves the team with no exploration knob at all when the genuine problem is "action `a` is unsampled". The review needs a refinement: **ent_coef tuning is the wrong fix when the upstream cause is poor reward design; it is a legitimate consideration when the upstream cause is a verified exploration failure.** The diagnostic to distinguish the two is whether the action histograms show *zero* probability mass on an action that *demonstrably wins when taken*. If you can't tell, default to the review's prohibition; if you can demonstrate it (with logged probabilities, not just histograms), the prohibition shouldn't bind.

The team did not raise `ent_coef` in this session despite a recommendation to consider it. That was the right call given the review's framing. But the framing itself should be refined.

---

## A6. Course correction — what to do next

Concrete, ordered, scoped.

### A6.1 Let the +3 second-unit milestone finish its smoke test

PID 807331 (as of session end) is mid-run on `3a_rm_3k` with the new reward. `trn` just emerged at 1 % at u282. **Do not intervene for the next 30-50 updates.** If `trn` reaches ≥ 3 % and win-rate ≥ 15 % over that window, the milestone is working and the stage is unblocking. If it doesn't, kill the run and proceed to A6.2.

Cost: ~30 minutes of compute. Decisive evidence either way.

### A6.2 If the milestone doesn't catch — collect a *full-config* BC dataset that includes multi-unit RushBot demos

The earlier BC fine-tune (§A3.4) had two problems: too little data (300 episodes) and wrong config (3000 px / 300 HP, mismatched to the 6000 px / 1000 HP target). The fix is:

- **1000 episodes** of RushBot vs (mixture: 40 % rush_weak, 40 % rush_medium, 20 % passive) on **full game config** (6000 px / 1000 HP / 50 res).
- Filter to episodes containing ≥ 2 `train_unit` actions (this is the multi-unit signal the original BC v5 lacked).
- Use this as a **fresh BC warmup**, not a fine-tune. Run from `bc_warmup_multi.pt` through the entire curriculum from `0a`.
- This will re-clear the curriculum but with a multi-unit-friendly prior baked in. Expected total cost: ~6 hours (similar to the first run).

Why "fresh BC warmup, not fine-tune": the BC fine-tune attempt corrupted the rush behaviour because the policy had specialised. Starting fresh avoids the catastrophic forgetting risk and lets the curriculum naturally re-acquire rush skills with the multi-unit prior already present.

### A6.3 If §A6.2 also fails — restructure the curriculum around *opponent ladder*, not *config ladder*

The current curriculum varies map size and crystal HP heavily. It does *not* vary opponent strength gradually — it jumps from rush_weak (1-2 unit attacker) to rush_medium (3-unit attacker) in one step. Introduce a `rush_weak_medium` opponent (or scale rush_medium's unit count down to 2 for an intermediate stage). This is an engine-level change but a small one: `headless/src/bots/RushMediumBot.ts` (or equivalent) has a constant for max-attackers; expose it.

This implements §A5.2 directly: build the curriculum around the *unit-count requirement*, not around the *map-size/HP knobs*.

### A6.4 Don't activate the league yet

The temptation will be strong: "we're stuck on rush_medium, the league has easier opponents, let it sort itself out via PFSP". This is the original review §7.10 trap restated: PFSP weights matchups by recent win-rate, but a policy that is `trn=0%` cannot learn the multi-unit behaviour from PFSP alone. The league assumes you have a policy that *can* learn from any matchup. The current policy *cannot* learn from rush_medium matchups, by §A3.2. The league would burn compute on matchups the policy can't profit from.

**Rule R11 (new) — Don't escape a stuck curriculum stage by activating the league.** League is for *late*-stage robustness, not *mid*-stage progress. If the curriculum can't get there, the league can't get there.

### A6.5 Refresh `docs/ML_BOT_ACTION_PLAN.md` with the lessons from this session

Specifically, the diary should record:

- The scaffold paradox (§A3.3): pre-placed units teach rushing, not training.
- The decay-pattern diagnostic (§A3.3 table): when wins emerge in window 1 and decay through windows 2-4, the wins are luck not learning. This is a fingerprint to recognise in any future stuck stage.
- The BC fine-tune lesson (§A3.4): small-data BC fine-tune can damage more than it repairs. Use full BC warmup or none.
- The exploration-probabilistic credit-assignment gap (§A3.2): bootstrap shaping requires the action to be sampled.

The diary was already strong before this review; these are additions, not corrections.

### A6.6 Don't add more reward components

The +3 second-unit milestone is a borderline call (it is, technically, an exception to the original review's "6 components" target, justified as the same class as the existing first-unit milestone). **It is the only such exception that should be made.** A `+1 third unit` would be a clear violation. The review's Rule R1 (default to subtraction) still binds. If the second-unit milestone doesn't work, *remove* it before trying anything else.

---

## A7. Updated rules

Adding to the original review's 10 rules:

### Rule R11 — Don't escape a stuck curriculum stage by activating the league
The league is for late-stage robustness against varied opponents, not for mid-curriculum recovery. If atomic skills aren't there, PFSP cannot install them.

### Rule R12 — Pre-placed-unit scaffolds are not behavioural scaffolds
A stage with pre-placed combat units teaches *rushing with pre-placed units*, not *training units*. To teach training, the stage must be one where the agent *cannot win without training*. Use pre-placement to gate the value function (Phase A → Phase B), not to scaffold downstream behaviours.

### Rule R13 — The decay-pattern is a fingerprint
When win-rate emerges in window 1 of a new stage and decays through windows 2-4 (without recovery), **the wins are luck not learning**. The policy is sampling a behaviour stochastically that occasionally wins; PPO is reinforcing the wrong action; the gradient is going nowhere. Recognise the fingerprint within 4 windows; do not let it grind for 200 updates.

### Rule R14 — Bootstrap shaping requires the action to be sampled
Before adding a `+N one-time` reward for action `a`, verify that the current policy samples `a` at least 0.1 % of the time at the target stage. If not, the reward is invisible. Either (i) install a BC prior that samples `a`, or (ii) construct a curriculum stage where `a` is mechanically required, or (iii) add no reward at all.

### Rule R15 — BC fine-tune is a heavy instrument, not a fine instrument
Small-data BC fine-tunes (a few hundred episodes, low LR, few epochs) routinely degrade as much as they repair. If you need to revise a policy's behaviour via BC, do it as a full BC re-warmup from a substantial dataset on the target config, not as a delta on top of a specialised policy.

---

## A8. What "good" looks like, 8-12 weeks from now (revised)

The original review (§8) gave a 4-8 week milestone projection. After this session's evidence, the projection should be revised. The agent has reached **full-map beat-passive** in 5M training steps — a milestone the original review estimated would take 2 weeks (per its §8 table: "stage 3a — 4 weeks — win_rate ≥ 0.7"). That is **two weeks ahead of the original schedule** for the parts the curriculum could solve.

The stage `3b` ("full map vs rush_medium") was estimated at 6 weeks. Empirically, it is harder than that estimate because of the `trn=0%` bottleneck. Revised estimate: **2-4 more weeks** if the second-unit milestone or the multi-unit BC re-warmup works; **uncertain** if neither works.

Beyond `3b`:

- **League activation**: should follow stage 3b within 1-2 weeks. The league code is ready; the policy is the gate.
- **Self-play**: not strictly necessary for the project's stated goals (beating scripted bots), but valuable for robustness. The review's §A1 note that "the policy never trains as red" stands; this should be addressed *before* league activation, not after.
- **ONNX export and `MlBot` integration**: still mechanical work, ~1 week once a strong checkpoint exists.

**Honest summary:** the project is **3-4 weeks** from a deployed bot that beats most scripted opponents on most maps, *if* the `trn=0%` bottleneck is unblocked by A6.1 or A6.2. If neither unblocks it, the project may need an architectural revisit (e.g., hierarchical action space where "macro-build" and "micro-tactics" are separated) — but that is speculation and not yet warranted by evidence.

---

## A9. Final summary — what to do tomorrow morning (revised)

If you read nothing else in this second review, read this.

**Do, in order:**

1. **Let the +3 second-unit milestone run for 30-50 more updates** (PID 807331 as of session end). The very-first `trn=1%` reading at u282 is too early to interpret. Decisive evidence in ~30 minutes of compute.
2. **If `trn` climbs to ≥ 3 % and wins follow → keep going through 3a1/3a2/3a5/3b.** Document the trn% trajectory; this is the breakthrough moment if it comes.
3. **If `trn` stays at 0-1 % through u320 → kill the run.** Remove the second-unit milestone (back to 6 components). Proceed to step 4.
4. **Collect a 1000-episode mixed-opponent BC dataset on full game config** (§A6.2). Save as `bc_warmup_multi.pt`. This is a 1-2 hour collection.
5. **Re-run the full curriculum from `bc_warmup_multi.pt`**, starting at stage `0a`. Expected total compute: ~6 hours. Watch `trn%` at every stage; if it stays > 1 % at 3a_rw, the multi-unit prior is preserved and rush_medium should be reachable.
6. **If §A6.2 fails too → introduce a `rush_weak_medium` opponent** with 2 attackers, between rush_weak and rush_medium. Implementation: ~2 hours.

**Don't:**

- Activate the league as an escape route from stuck curriculum (R11).
- Add a `+1 third unit` reward, or any other reward beyond the second-unit milestone (R1).
- Raise `ent_coef` (original review §9.4 still binds; the corner-case carve-out in §A5.4 is a future refinement, not a license).
- Run the BC fine-tune attempt again as currently implemented; either go to full re-warmup or do nothing (R15).
- Take the early decay (window 1 → 2) on any new stage as "just noise". It's the diagnostic fingerprint of luck-not-learning (R13).
- Move on from `3a_rm_3k` analysis without writing the lessons into `ML_BOT_ACTION_PLAN.md` (R8).

**Spend your next 2 weeks on:**

1. Resolving the `trn=0 %` bottleneck via §A6.1 → §A6.2 → §A6.3 in that order (1 week, mostly compute).
2. Once `3a5/3b` clears, activating the league against scripted bots and recent checkpoints (3 days).
3. ONNX export + MlBot integration for a deployable artifact (2 days).

That is the recipe. **You are closer than you think.** The agent reached *full-map beat-passive* in one focused session — a milestone that 35 days of pre-review work could not achieve. The remaining gap (`3b`) is narrow; it is one specific failure mode (action-probability collapse), with two specific countermeasures (multi-unit BC warmup, mechanically-required-multi-unit stage), at least one of which is highly likely to work.

**The original review's prescription was right; this review's job is just to fill in the one gap it didn't anticipate.**

— *End of second review.*

---
---
---

# CrystalFront ML Project — Third Review

**Reviewer:** Independent technical audit (second continuation)
**Date:** 2026-05-21 (same calendar day as second review, ~6 hours later)
**Branch under review:** `CrystalFront-ML` (v0.3.2-ML working state)
**Primary source:** session training logs since second review + code state at session end
**Scope:** evaluation of the second review's §A6 prescribed path (now fully exhausted); concrete architectural options for the remaining `trn=0%` bottleneck; pragmatic assessment of whether the project's stated goal is achievable with the current approach

> **Framing.** The second review (written this morning) prescribed a three-step recovery for the `trn=0%` bottleneck: §A6.1 (let +3 milestone smoke-test), §A6.2 (mixed-opponent BC re-warmup), §A6.3 (introduce intermediate opponent). The team executed all three in the six hours after that review was written. **All three failed.** This third review documents the failure modes (which themselves are diagnostically valuable), names what the second review got wrong or underestimated, and presents the actually-remaining options — pragmatic and architectural. The tone remains the same. We have now had three reviews of this project; each has been less optimistic than the last about a "clever shortcut" working. The honest message in this one is more sober: **the agent has hit its natural ceiling against scripted opponents under the current architecture, and the path forward is either (a) accept the current capability and ship it, or (b) commit to a real architectural change**.

---

## B1. Executive summary (continuation²)

**What was attempted since the second review (in order):**

1. **§A6.1 (let +3 milestone smoke-test):** Ran 25 more updates on `3a_rm_3k`. Recorded the first non-zero `trn` reading in the project's history (`trn=1%` at u282, then u295, then u307). It did not climb to ≥3%. **Smoke-test gate honoured: FAIL.**
2. **§A6.2 (mixed-opponent BC re-warmup):** First attempt at 1000 episodes **crashed the container with OOM** (3M transitions × 5 obs arrays ≈ 15-20 GB before PyTorch even loaded). After reboot, retried at 300 episodes. Collection succeeded — but the resulting `bc_warmup_multi.pt` produced **noop attractor on every PPO stage it was tested on**: 0b5 (small map, no scaffold) collapsed to noop=99% / 0% wins for 4 consecutive windows, and 3a_rw (full map, rush_weak, previously trivial) also collapsed to noop=99% / 0% wins. **Hard FAIL.**
3. **§A6.3 (introduce intermediate opponent `rush_weak_medium`):** Implemented WeakMediumRushBot (6-skirmisher cap, first push tick 300, push interval 50 — exactly halfway between WeakRushBot and MediumRushBot). Wired into both runners, both index files, the curriculum, and the Python env. Restarted from `u200` (known-good checkpoint) at the new stage. The bot is well-calibrated: produces 10-37% wins (vs 0-2% on `rush_medium`) with `wkr_mv=0%`. **But `trn=0%` persists** across 8 windows. The win-rate trends are noisy but ultimately *declining* (the policy is refining a single-skirmisher rush rather than discovering multi-unit play).
4. **Bonus: `+3 milestone + 3a_rwm` combination** (not in the second review's prescribed path, but a natural "one more thing" the second review's §A5.3 logic suggested might work in a richer gradient context): re-added the milestone, resumed from u350 on `3a_rwm`. Three windows in: 42% → 19% → 23% wins, `trn=0%` throughout. **No emergence whatsoever**, in contrast to the brief `trn=1%` flicker on `3a_rm_3k` earlier. **FAIL.**

**The deep insight (this time, named honestly):** The `trn=0%` bottleneck is not a calibration problem, a reward problem, a curriculum-step problem, or a BC-data problem. Each of those framings was tried; each failed. The actual problem is upstream of all four: **the policy's action-probability distribution has collapsed to a manifold that excludes `train_unit` entirely, and no scalar reward signal can resurrect an action with `p < 0.001`**. This is the textbook diagnosis of *catastrophic exploration collapse*, and it is a property of vanilla policy-gradient methods (PPO included) when the reward landscape has long-horizon credit-assignment gaps and the optimizer has been allowed to specialise for many updates.

**The path forward.** Two options, both honest:

(A) **Ship what we have.** The agent reliably beats IdleBot (100%), PassiveBot (99-100%), WeakRushBot (89-93% on full map). It wins ~24% vs `rush_weak_medium` (the new intermediate opponent), and ~10% vs `rush_medium`. For a deployable opponent against human players of varying skill, this is a credible bot — it is not "world-class against scripted rush" but it is meaningfully harder than IdleBot. **The PR-equivalent: "Beats all opponents in the easy tier; intermediate vs medium-tier; loses to rush+macro."** That is a shippable artefact.

(B) **Commit to a real architectural change.** Not a reward addition, not another curriculum step, not another BC iteration — a structural shift. Concrete options in §B5 below. The honest cost: 1-3 more weeks of work, none of it guaranteed to work, all of it diverging from the original review's prescribed methodology.

**Recommendation in one line:** Take option (A) — ship a v0.3.2-ML release labelled honestly ("beats easy and weak-rush opponents; struggles against medium-rush and above"). If a stretch goal remains to beat rush_medium, **fund that work as a separate research-effort with explicit acceptance of 3-6 weeks of compute and code investment**.

---

## B2. The full attempt log (this session)

For the diary, in case the team wants to reproduce these failures rather than re-discover them:

| Attempt | Action | Duration | Result | Lesson |
|---------|--------|----------|--------|--------|
| 1 | +3 milestone smoke-test on 3a_rm_3k | 25 updates | trn peaks at 1%, never reaches gate of 3% | Bootstrap shaping can produce trace emergence but cannot self-amplify when p(a) is tiny |
| 2a | 1000-ep mixed-opponent BC | OOM crash | Container freeze, reboot | **24GB+1GB swap caps BC collection at ~500 eps for full game config** |
| 2b | 300-ep mixed-opponent BC | ~25 min collection, ~5 min train | Saved successfully; train_unit=9.2% in dataset; critic MSE 111 | Memory-safe at 300 eps; but… |
| 2c | PPO from bc_warmup_multi.pt at 0a | 47 updates on 0b5 | 0b5 noop=99% for 4 windows | **Multi-opponent BC includes losing episodes → V(s) crashes → noop attractor** |
| 2d | PPO from bc_warmup_multi.pt at 3a_rw | 18 updates | noop=99%, 0% wins | Same failure as 2c. bc_warmup_multi is contaminated by losing demos. |
| 3a | Add rush_weak_medium bot + wire into curriculum | ~30 min coding | Clean implementation | New bot is calibrated correctly (verified empirically in step 3b) |
| 3b | PPO from u200 at 3a_rw → 3a_rwm | 8 windows on 3a_rwm | Win-rate oscillates 10-37%, avg ~24%; trn=0% throughout | rush_weak_medium is a good intermediate opponent but does not unblock trn=0% |
| 4 | Re-add +3 milestone, restart at 3a_rwm from u350 | 3 windows | 42%→19%→23%, trn=0% throughout | The richer gradient context (24% wins vs 2%) was not enough to cross the p(train_unit) floor |

Eight distinct attempts. Zero positive movements on `trn%`. The diagnosis is consistent across all of them.

---

## B3. New diagnostic findings (things we now know that we didn't know yesterday)

### B3.1 Mixed-opponent BC datasets create noop attractors via critic crash

This is the most important new finding. The second review §A6.2 prescribed: *"1000 episodes of RushBot vs (mixture: 40% rush_weak, 40% rush_medium, 20% passive)… Use this as a fresh BC warmup."* The implicit assumption: more diverse demonstrations → richer prior → more train_unit signal in the policy.

What happened: the critic pretraining log showed `Critic targets: min=-100.0  mean=3.6  max=100.0`. The original BC v5 (vs IdleBot, all wins) would have had `mean ≈ +95`. The new mean of 3.6 is because **RushBot itself loses ~50% of the time against rush_medium**, so half the demonstrations end in `terminal=-100`. The critic was trained to predict V(s₀) ≈ 3.6 — *which is not enough advantage to drive any meaningful action distribution shift in PPO*. The first update produces near-zero gradients across all actions; the policy entropy collapses into the most uniform action (noop, since legal_action_mask makes noop always available). Three updates later, the policy is at noop=99%.

**The deeper rule:** *BC datasets used to warm-start PPO must have predominantly winning demonstrations*, because the critic learns V(s) from those returns, and PPO's advantage estimates depend on the critic. If the critic predicts negative or low V(s₀), the *log* probabilities of all actions get equalised toward the legal-action mean (which favours noop), and the policy collapses.

**Rule R16 (new) — BC datasets for PPO warmup must have ≥80% winning episodes.** If you want multi-unit demonstrations, find an opponent the demonstrator beats consistently AND that requires multi-unit play to beat. Otherwise the critic crashes PPO into noop.

### B3.2 Pre-placed unit scaffolds reinforce single-unit rush, not multi-unit play

The second review §A3.3 named the "scaffold paradox" partially (pre-placed units give wins, but the wins are credited to atk_mv not train_unit). This session confirmed it definitively across three pre-placed-unit attempts (3a1, 3a2, 3a_rm_3k all with 2 pre-placed skirmishers): **every winning episode in those stages used the pre-placed units to win; none required the agent to train an additional unit.** The training data the policy sees in those stages is "rush with what you start with → sometimes win", so PPO reinforces atk_mv and *suppresses* train_unit further (because train_unit takes time during which the rush is being executed by the pre-placed units, costing the time-penalty and lowering advantage).

**Pre-placed-unit scaffolds actively make trn=0% worse, not better.** They are anti-helpful for the specific bottleneck the team has been trying to break.

**Rule R17 (new) — A scaffold that gives the agent free wins also robs the agent of the gradient signal for the underlying skill.** Use scaffolds to teach *value-function shape* (Phase A: "wins exist and look like this"), not to teach *behavioural skills*. The skill must be acquired in a stage where it is mechanically necessary.

### B3.3 The opponent ladder works through rush_weak but breaks at rush_medium

Empirically demonstrated across this session:

| Opponent (full 6000px map) | Reliable win-rate | Notes |
|----------------------------|-------------------|-------|
| IdleBot | 100% | Trivially solvable |
| PassiveBot | 99-100% | Trivially solvable |
| WeakRushBot | 89-93% | Reliably solvable |
| **WeakMediumRushBot (new)** | **~24% (10-37% range)** | **Borderline — policy oscillates** |
| MediumRushBot | ~10% on small map; ~0-2% on full map | Unsolvable with current policy |
| Rush, Macro, Heavy | Not tested | Presumed worse |

The "natural ceiling" of the single-skirmisher rush strategy on the full map is somewhere between WeakRushBot and WeakMediumRushBot. The team's curriculum design from §7.3 of the original review treats rush_medium as "the next step after rush_weak" but **empirically there is a discontinuity there that no scaffolding has bridged**. The new WeakMediumRushBot fills part of this gap (it is genuinely intermediate in difficulty) but it does not solve the problem.

### B3.4 Bootstrap shaping has a hard floor: p(a) ≈ 0.5% (rounded to 0% in logs)

The second review §A5.3 conjectured: *"Bootstrap shaping rewards must be paired with a mechanism that keeps the action sampled until the reward catches."* This session empirically confirmed this with two data points:

- **+3 reward on `3a_rm_3k` (2-3% wins, weak gradient context):** `trn` rose to 1% briefly (u282, u295, u307), never reached 3%. Marginally above the floor; couldn't compound.
- **+3 reward on `3a_rwm` (10-37% wins, decent gradient context):** `trn` stayed at 0% across all 3 windows tested. **The reward never fired.**

The second test was the key one: even with a 10x stronger gradient context than where the reward had previously shown a trace effect, the train_unit action could not be sampled enough times for the +3 milestone to be earned. *The probability floor is real, and it is below the resolution of our histogram logging.* For all practical purposes, after ~200 updates of PPO with the single-rush strategy reinforced, `train_unit` is dead.

**Rule R18 (new) — `p(a) ≈ 0` is functionally identical to `a` being masked illegal.** No scalar reward addition can resurrect a dead action. The mechanisms that *can* are: (i) restoring the prior via fresh BC (must use winning-episode-dominant data per R16), (ii) restoring via mechanical forcing (action-masking that requires the action under certain states), (iii) restoring via intrinsic motivation (count-based exploration, RND, etc.), or (iv) restarting training entirely.

---

## B4. What the second review got wrong or underestimated

The second review was honest about its uncertainties; this section quantifies which of those uncertainties turned out which way.

### B4.1 §A6.2 (mixed-opponent BC) — the failure mode wasn't anticipated

The second review treated §A6.2 as the most principled remaining fix ("the cleanest BC fine-tune is probably ≥1000 episodes, on the *full* game config, with an even smaller learning rate"). It did not anticipate the **critic-V(s)-crash failure mode** described in §B3.1 above. In retrospect, the warning signs were present: BC v3 (in the pre-review history) crashed PPO via random critic; BC v4 was fixed by critic pretraining on demo returns; the second review correctly noted "*always pretrain the critic on discounted returns from demonstrations*" (§v0.3.1 diary) — but did not connect the dots that the critic would learn whatever value the demos contain, including the value of *losing*.

The fix in §B3.1 / R16 is to require ≥80% winning episodes in any BC dataset used to warm PPO. This is a direct contradiction of the second review's "diverse opponents" prescription — turns out diversity in opponents created diversity in episode outcomes, which created the V(s) crash.

### B4.2 §A6.3 (intermediate opponent) — calibrated correctly, doesn't fix the trn=0% problem

The second review §A6.3 was confident: *"Adding a `rush_weak_medium` opponent (or scale rush_medium's unit count down to 2 for an intermediate stage). This is an engine-level change but a small one… This implements §A5.2 directly: build the curriculum around the *unit-count requirement*, not around the *map-size/HP knobs*."*

The implementation worked: WeakMediumRushBot is a genuine intermediate (10-37% wins vs rush_weak's 89-93% and rush_medium's 0-2%). **But the policy still does not train multi-unit.** It refines the single-skirmisher rush until 10-25% of episodes win (the upper tail of the rush distribution), and stays there.

The second review's implicit assumption — that an opponent which *requires* 2 units to beat reliably would force the policy to discover 2-unit play — was empirically false. **The policy is content with 24% wins on an opponent it should be able to beat at 50%+ if it would train a second unit.** This is the strongest empirical evidence yet that vanilla PPO cannot bridge this gap regardless of opponent calibration.

### B4.3 The decay-pattern fingerprint (Rule R13) is partly right, partly wrong

The second review identified the decay pattern (22%→6%→2% across 3 windows) as a diagnostic for "wins are luck not learning." On `3a_rm_3k` that was true. **On `3a_rwm`, the pattern is different: oscillation around a stable mean (10-37%, no monotonic decay) over 8 windows.** This is what "wins are skill but skill is capped" looks like — the policy is fully exploiting the single-rush strategy and the variance is sampling noise from the game's stochastic seeds.

**Refinement of R13:** Three windows of decay = luck without learning. Oscillation around a stable mean for 5+ windows = skill at a fixed ceiling (no further learning possible without a structural change).

### B4.4 The §A8 timeline projection ("3-4 weeks if §A6.1 or §A6.2 catches") was right but the conditional was wrong

The second review's revised timeline said: *"3-4 weeks if the `trn=0%` bottleneck is unblocked by §A6.1 or §A6.2."* §A6.1 and §A6.2 did not unblock it. §A6.3 didn't either. The timeline therefore inherits the §A8 fallback clause: *"uncertain if neither works."* This is now the operative scenario. The third review's job is to make that uncertainty *less* uncertain.

---

## B5. The architectural revisit, made concrete

The second review §A8 said: *"If neither unblocks it, the project may need an architectural revisit (e.g., hierarchical action space) — but that is speculation and not yet warranted by evidence."* The evidence is now in. Concrete options, with honest cost/risk assessment:

### B5.1 Option α: Hierarchical action space (macro + micro)

**Idea:** Split the policy into two heads. The "macro" head decides every ~100 ticks among: `expand_economy`, `build_barracks`, `train_units_until_N`, `attack_with_all`, `defend_at_home`. The "micro" head receives the macro decision plus the current observation and outputs the current-tick primitive action.

**Why this addresses `trn=0%`:** The macro head's `train_units_until_N` action is sampled as a *single discrete choice*, not as a per-tick `train_unit` action. PPO's gradient on the macro head can reinforce "train_units_until_2" vs "train_units_until_1" even if the per-tick action sequence is identical.

**Cost:** Substantial. Requires restructuring the policy network (1-2 weeks), reformulating the action space (1 week), re-doing BC and curriculum from scratch (1-2 weeks). Total: 3-5 weeks.

**Risk:** Hierarchical RL is notoriously finicky. Many published hierarchical methods don't beat well-tuned flat PPO. Could absorb 5 weeks and produce no improvement.

### B5.2 Option β: Targeted action-masking (mechanically force exploration)

**Idea:** Modify the legal-action mask such that when (a) the agent has a barracks, (b) the agent has resources ≥ unit_cost, (c) the agent has < 2 combat units, and (d) the policy's chosen action is `noop` for ≥ N consecutive ticks, **force the next action to be `train_unit`**. This is not exploration — it's compulsory action injection at a specific state.

**Why this addresses `trn=0%`:** Once a few episodes contain forced `train_unit` actions, the resulting unit's presence in the state will be a learnable signal. The policy will *see* the consequences (the second unit fights, sometimes wins) and the credit-assignment chain will form normally. After the policy has internalised the value of 2 units, the forcing can be removed.

**Cost:** Small. ~1-2 days to implement in `legalActions.js` and verify. ~1 week of training to see if it converges with the forcing on, then another week to fade it out.

**Risk:** Low. This is essentially "scripted exploration" — the worst case is the agent learns nothing useful and we remove it. It does technically violate the original review's §9.4 / "don't tune hyperparameters" rule, but the spirit of that rule was "don't tweak `ent_coef` reflexively", not "never inject targeted exploration". Targeted action-masking is a different mechanism.

**Note:** This is the *first* option I'd actually try, of all six in this section. Cheapest, least invasive, addresses the specific bottleneck directly.

### B5.3 Option γ: Intrinsic motivation (RND / count-based curiosity)

**Idea:** Add an intrinsic reward proportional to the novelty of (state, action) pairs. The agent gets bonus reward for visiting under-sampled action-state combinations, which forces exploration of `train_unit` even when the extrinsic reward is zero.

**Why this addresses `trn=0%`:** The first time `train_unit` is sampled, the (state, train_unit) tuple is novel → high intrinsic reward → reinforces the action. Subsequent samples have lower novelty but the action has been bootstrapped.

**Cost:** Medium. ~3-4 days to integrate RND (Random Network Distillation) into the existing PPO trainer. Adds compute overhead.

**Risk:** Medium-high. Intrinsic motivation methods can sabotage extrinsic reward learning ("reward shaping with extra steps"). Tuning the intrinsic/extrinsic balance is its own optimization problem. The original review's anti-shaping rules (R1, R10) apply doubly.

### B5.4 Option δ: Self-play

**Idea:** Train the policy against itself (or recent self-copies) instead of scripted bots. The league code (`training/ppo/league.py`) is already present and dormant.

**Why this *might* address `trn=0%`:** Self-play creates an opponent that exactly matches the policy's current skill. If the policy is a single-skirmisher rush, the opponent is also a single-skirmisher rush — the games tend to be ties or won by whichever side has the better random seed. This is a different optimisation landscape: there is no "natural ceiling" set by a scripted opponent's behavior, and the gradient signal pushes toward whatever differentiates the players (which *might* include training a second unit).

**Why this *probably* won't address `trn=0%`:** If both sides have `p(train_unit) ≈ 0`, neither side will train units, and the games will remain 1v1 rushes forever. Self-play doesn't add exploration; it changes the opponent distribution.

**Cost:** Low to integrate (league code exists), high in compute (PFSP training is slow).

**Risk:** Medium. Original review §7.10 says league is for "late-stage robustness, not mid-stage progress" — this is mid-stage, so the review prohibits it. Second review's Rule R11 reinforces.

**Verdict:** Not recommended.

### B5.5 Option ε: Train fresh from scratch, no BC, on the rush_weak_medium opponent only

**Idea:** Skip BC entirely (no warmup). Skip the small-map curriculum entirely. Start PPO fresh against WeakMediumRushBot on the full 6000px map. Run for 20M steps with `ent_coef=0.05` (slightly above the default 0.02 to encourage exploration). The hypothesis: without the "single-unit rush works" prior burned in by BC + early-curriculum stages, the policy might discover multi-unit play organically.

**Why this *might* address `trn=0%`:** A fresh policy has roughly uniform action probabilities. `p(train_unit)` is at the natural floor (~1/action_count). PPO will then shape the distribution from a neutral start, with `train_unit` as a viable candidate.

**Why this *probably* won't address `trn=0%`:** Without BC, the credit-assignment gap from the original review §3.1 re-asserts. The agent will likely converge to noop (the pre-BC failure mode that dominated the first 30 days of the project). This was exactly what BC was introduced to fix.

**Cost:** Low. ~5 minutes to launch. ~6 hours of training.

**Risk:** Medium. May produce nothing. May produce a worse agent than we have now.

**Verdict:** Cheap enough to try as a sanity check, not as a recommendation.

### B5.6 Option ζ: Accept the ceiling and ship

**Idea:** Stop trying to beat rush_medium. The agent's current capability is:

- IdleBot: 100% wins
- PassiveBot: 99-100% wins
- WeakRushBot (all configs): 89-93% wins
- WeakMediumRushBot: ~24% wins
- MediumRushBot: ~10% wins
- Rush/Macro/Heavy: untested, presumed worse

For a game with player-vs-bot mode, this is a credible bot ladder. **Frame the limitation as a feature**: the bot has an "easy/medium" tier (idle/passive/weak_rush) where it dominates, an "expert" tier (medium_rush) where it competes, and a "champion" tier (rush/macro/heavy) where it loses. This is a natural difficulty progression for players to climb against.

**Cost:** Days, not weeks. ONNX export, MlBot integration, integration tests, release notes.

**Risk:** None on the technical side. The risk is purely product/PR: if the team's stated success criterion was "beat all scripted bots ≥ 70%", this option fails that criterion. But that criterion is *arbitrary*, and the project has been chasing it for 35 days. **A v0.3.2-ML release with an honest capability description is a defensible product outcome.**

**Verdict:** Recommended.

---

## B6. Pragmatic recommendations (ranked)

1. **Ship the current capability as v0.3.2-ML.** See §B5.6. ETA: 3-5 days.
2. **If a "beat rush_medium" stretch goal must be funded, try Option β (targeted action-masking) first.** It is the cheapest of the architectural options, addresses the specific bottleneck (`p(train_unit)≈0`), and the worst case is a 2-week investment that produces no improvement.
3. **If Option β doesn't work, escalate to Option α (hierarchical action space).** Budget 4-6 weeks. Recognise that this is real research, not engineering.
4. **Do not** activate the league (still §7.10, still §A6.4).
5. **Do not** add a `+1 third-unit` reward, or any other shaping component.
6. **Do not** retry mixed-opponent BC. The V(s) crash mechanism is now understood (B3.1) and is intrinsic to the approach.
7. **Do not** retry pre-placed-unit scaffolds for stages where the goal is to teach training. Use scaffolds only for value-function shaping (Phase A).
8. **Do** investigate, before any architectural option, whether the current 24%-winning episodes on 3a_rwm contain any train_unit actions at all (a debug script that loads u350 and runs 100 deterministic episodes, recording per-episode action histograms). If they do, the path is to amplify that minority behaviour. If they don't, the architectural option is unavoidable.

---

## B7. New rules

Extending the second review's R11-R15:

### Rule R16 — BC datasets for PPO warmup must have ≥80% winning episodes
Otherwise the critic learns V(s) ≈ low/negative, and PPO collapses to noop within ~10 updates. The original BC v5 worked because RushBot beats IdleBot 100%. The multi-opponent BC failed because RushBot beats rush_medium ~50%. The fix is opponent selection, not data quantity.

### Rule R17 — Scaffolds teach value-function shape, not behavioural skills
A pre-placed unit gives the agent free wins; PPO credits those wins to whatever the policy *did* during the episode, not to the action that *would have been* needed without the scaffold. To teach a behaviour, the stage must require that behaviour mechanically.

### Rule R18 — `p(a) < 0.5%` is functionally identical to `a` being masked illegal
No scalar reward can resurrect a dead action. The only mechanisms that work are: BC restoration (R16-compliant), mechanical forcing (Option β-style), or intrinsic motivation. Adding more shaping is a category error.

### Rule R19 — Oscillation around a stable mean for 5+ windows = ceiling, not learning
This refines R13. Three-window monotonic decay = luck-not-learning. Five-window stable oscillation = the policy has fully exploited the available strategy and the variance is environmental noise. **Recognise the ceiling as a structural property and stop trying to climb past it with calibration alone.**

### Rule R20 — When three reviews tell you "the prescribed path is exhausted," they're telling you the *prescribed path* is exhausted, not "you need more iterations of the prescribed path"
The second review prescribed §A6.1 → §A6.2 → §A6.3. The team executed all three honestly. The third review's job is to acknowledge that the prescribed path's premise (curriculum + BC + reward calibration suffice) was wrong for the specific bottleneck at hand. The honest answer is *architectural change or accept the limit*, not "try harder versions of what already failed."

---

## B8. Revised timeline and shipping target

Updating the second review's §A8 with the evidence in hand:

| Milestone | Original review estimate | Second review revised | Third review revised |
|-----------|--------------------------|----------------------|----------------------|
| Beat IdleBot at 90 %+ | 1 week | done (this session) | done |
| Beat PassiveBot at 70 %+ | 2 weeks | done (this session) | done |
| Beat WeakRushBot at 50 %+ | 4 weeks | done (this session) | done |
| Beat MediumRushBot at 50 %+ | 6 weeks | "3-4 weeks if §A6 catches; otherwise architectural" | **4-6 weeks of architectural work; or accept and ship** |
| Beat full league at 60 %+ | beyond 6 weeks | beyond 8 weeks | **only after rush_medium is solved** |
| ONNX export + MlBot integration | beyond 6 weeks | 1 week after rush_medium | **could ship now** with current capability |
| Honest deployable bot | not in original plan | not in second review | **3-5 days from now** |

**The shipping target the third review recommends: v0.3.2-ML, deployable, honest about its tier (easy/medium dominance, intermediate vs `rush_weak_medium`, struggles above).** The project does not have to wait for rush_medium to be solved.

---

## B9. Final summary — what to do tomorrow morning (third revision)

If you read nothing else in this third review, read this.

**The honest position:** Three reviews in, four interventions tested honestly, every one of them has shown the same thing — *the `trn=0%` bottleneck is structural, not tunable*. The first review prescribed methodology; that worked through stage 3a (passive on full map). The second review prescribed three escape routes; all three failed (one via a memory crash that surprised everyone, two via deeper failure modes the second review didn't anticipate). The third review's recommendation is the one nobody wanted to hear: **stop trying to fix `trn=0%` with the current PPO+curriculum+reward toolkit. It cannot be fixed by those tools.**

**Do, in order:**

1. **Run the diagnostic** (§B6.8): load the u350 checkpoint, run 100 deterministic episodes on 3a_rwm, record per-episode train_unit count, bucket by win/loss. ~30 minutes of compute. If wins use multi-unit ≥ 5% of the time, there is gradient signal that can be amplified by Option β (targeted action-masking). If wins use only 1 unit, Option β is mandatory.
2. **Decide between B5.6 (ship) and B5.2 (Option β)**. The decision is a product question, not a technical one. The technical answer is: the agent is at its ceiling against scripted opponents under the current architecture.
3. **If shipping (recommended)**: ONNX export, MlBot integration, release notes labelling tiers honestly, v0.3.2-ML release. 3-5 days.
4. **If Option β (action-masking)**: implement in `legalActions.js` — when (resources ≥ 50) AND (barracks count ≥ 1) AND (own combat units < 2) AND (last 30 actions were all noop), mask noop illegal. Train from u200 for 5M steps. Smoke-test gate: `trn ≥ 1 %` within 30 updates. If gate passes, fade out the forcing over the next 5M steps. If gate fails, ship per B5.6.

**Don't:**

- Add more reward components (R1, R18). The +3 milestone has been tried in two contexts and produced no useful signal; removing it permanently is correct.
- Re-attempt mixed-opponent BC (R16). The failure mode is now understood and is structural.
- Re-attempt pre-placed-unit scaffolds for teaching training behaviour (R17). They make trn=0% worse, not better.
- Activate the league (R11). Still applies.
- Raise `ent_coef` (original §9.4, second review §A6.4). Targeted action-masking (Option β) is the legitimate exploration intervention; entropy bombing is not.
- Treat this third review as a "try one more thing" doc. It is a "decide between two paths" doc.

**Spend your next week on:**

- Day 1 (~half day): Diagnostic from step 1 above. Decision point.
- Days 2-5 (option ship): ONNX export, MlBot integration, release. Done.
- Days 2-10 (option β): Implement action-masking, train, evaluate. Hard gate at day 7: if no improvement, ship per B5.6.

**Spend your next month on (post-ship):**

- Player feedback on the deployed bot. Real human-vs-bot data is more valuable than another iteration of scripted-bot training.
- Self-play exploration (with the league code) only after a v0.3.2 baseline is shipped.
- ONLY if a strong product reason emerges for beating rush_medium: the hierarchical architecture in B5.1.

---

**The closing thought.** The team has built something genuinely impressive in this codebase. The infrastructure is excellent. The first review's methodology recommendations worked decisively for the parts they were designed for. The second review's escape-route recommendations failed honestly, in a way that taught us new things. The third review's conclusion is that the project's *technical* problem is solved — the agent is a working bot — and the *aspirational* problem (beat rush_medium with vanilla PPO + curriculum) is either an architectural research project or a goalpost that should be moved.

You shipped a bot today. Take the win.

— *End of third review.*
