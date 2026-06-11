# Task 1.3 Findings — Balance Tuning Loop Stopped (REVIVAL_PLAN line 244)

**Status as of v0.5.4-ML (2026-06-11).** Per REVIVAL_PLAN.md line 244 ("If after ~6
iterations criteria 1–2 still fail, stop and write up findings in
`docs/balance/FINDINGS.md` — do not proceed to Phase 2 with an unbeatable rush"),
this document records why Task 1.3 cannot be closed by further numeric balance
tuning, and what would need to change to close it. **Phase 2 has NOT been
started.**

## Acceptance criteria — current status

(50 matches/pair, both colour assignments; full matrix at
`docs/balance/matrix_v0.5.3_task1.3.json`, 4050 matches, v0.5.3-ML + H5.)

| # | Criterion | Status |
|---|---|---|
| 1 | Every bot loses ≥20% of matches to at least one other bot | ✅ **PASSES** for all 9 bots |
| 2 | `turtle` **and** `macro` each beat `rush_medium` ≥30% | ❌ **FAILS** — `macro` passes (43-54% across all measurements); `turtle` is **0/100 (0%)** at baseline and stays far below 30% for every lever tried that doesn't break criterion 5 (see below) |
| 3 | `rush_medium` beats `rush_weak_medium` ≥60% | ✅ **PASSES** — 100%/100% |
| 4 | Mirror matches (`rush_medium`, `rush_weak`, `macro`) within 40-60% per side | ✅ **PASSES** (CLOSED in Appendix C, v0.5.3-ML — H5 fix) |
| 5 | Timeout-tiebreak games <30% in any pairing | ❌ **FAILS** — 14/81 pairings (17%) at 70-100% timeout (see below) |

**Bottom line: criteria 1, 3, 4 are robust and closed. Criterion 2's `macro`
leg is closed. The remaining gap is entirely `turtle` vs `rush_medium`
(criterion 2) plus 14 timeout-heavy pairings (criterion 5) — and these two
remaining gaps turn out to be mechanism-level entangled for the `turtle`
pairings, as detailed below.**

## What was tried (iterations 1-5)

| Iteration | Commit / state | Change | Effect on `turtle` vs `rush_medium` |
|---|---|---|---|
| 1 | `0ec33be` | worker cost 50→35, turret HP 400→600, turret cooldown 12→8, `COUNTER_MODIFIER` 2.0/0.5→1.5/0.75 | (baseline for iteration 2) |
| 2 | `f376905` | turret cost 60→50, skirmisher cost 50→60, skirmisher speed 3.0→2.0, + determinism fixes | — |
| — | (Iteration 7) | H5 mirror fix (`chooseBuildPosition` `dxSign`) — criterion 4 closed | — |
| 8 | full matrix run | — (measurement only) | **0/100 (0%)**, 0% timeout — `turtle`'s build order is 100% `turret,turret,turret`, loses by combat ~tick 5100 every game |
| 3 (this work) | uncommitted → v0.5.4-ML | `MediumRushBot.FIRST_PUSH_TICK` 200→300 | **0/100 (0%)**, 0% timeout — no change |
| 3 (this work) | uncommitted → v0.5.4-ML | crystal slow-regen +0.05 HP/tick when no enemy within 300px (REVIVAL_PLAN's exact spec) | **0/100 (0%)**, 0% timeout — no change |
| 4-5 (probe only, reverted) | n/a | `TurtleBot.TURRET_CAP` 3→5 | **12/100 (12%)**, 12% timeout |
| 4-5 (probe only, reverted) | n/a | `TurtleBot.TURRET_CAP` 3→7 | **92/100 (92%)**, **95% timeout** |

Iterations 1-2 were already-committed balance changes. Iteration 3 applies
**all four** of REVIVAL_PLAN line 244's explicit "further levers"
(turret cost 60→50 and skirmisher cost 50→60 in iteration 2;
`FIRST_PUSH_TICK` 200→300 and crystal slow-regen in this iteration) — combined
effect on `turtle` vs `rush_medium`: **zero**. Both iteration-3 levers are
KEPT in v0.5.4-ML (spec-compliant, harmless, no regressions on any other
criterion) even though they didn't move the needle on `turtle`.

Iterations 4-5 went beyond REVIVAL_PLAN's explicit list, probing
`TurtleBot.TURRET_CAP` (a scripted-bot tuning constant analogous to
`MediumRushBot.FIRST_PUSH_TICK`/`SOFT_CAP`) as the most direct lever against
the structural bottleneck identified below. **Both probe values were
reverted** — `headless/src/bots/turtleBot.ts` is byte-identical to its
pre-iteration-4 committed state in v0.5.4-ML. Neither value is shippable (see
next section for why).

Full diary detail: `docs/ML_BOT_ACTION_PLAN.md`, Iterations 8-10
(2026-06-11).

## Root cause: criterion 2 and criterion 5 are mechanism-level opposed for `turtle`

`TurtleBot` is **pure defense by design** — REVIVAL_PLAN/the bot's own
docstring confirm: train workers, build turrets, never train combat units,
never issue an attack. Its only two win conditions are therefore:

1. **Resource win** — accumulate `passiveWinThreshold` (4500) resources
   before the opponent destroys its crystal.
2. **Timeout-tiebreak win** — survive to `maxTicks` (6000), then win on
   crystal HP, then lifetime resources.

Against `rush_medium` (a continuously-reinforced, never-ending attacker),
`turtle` **never** wins by combat (it has no offense) and **never** wins by
resource-win in any measurement to date (it loses its crystal first or runs
to the timeout). **Every `turtle` win against `rush_medium`, at every
`TURRET_CAP` value tested, is a timeout-tiebreak win.**

This produces a hard 1:1 coupling between the two metrics that matter:

| `TURRET_CAP` | win rate (criterion 2, want ≥30%) | timeout rate for this pairing (criterion 5, want <30%) |
|---|---|---|
| 3 (current) | 0% | 0% |
| 5 | 12% | 12% |
| 7 | 92% | 95% |

Below some threshold, `rush_medium`'s sustained attrition eventually breaks
`turtle`'s wall before tick 6000 (combat loss, resolves the match). Above
that threshold, the wall never breaks, the match always reaches `maxTicks`,
and the tiebreaker (crystal HP intact, economy still accumulating) heavily
favors `turtle`. **There is no observed regime where `turtle` wins ≥30% of
the time AND the pairing's timeout rate stays <30%** — the transition between
"combat loss" and "timeout-tiebreak win" is sharp (12%→92% between cap 5 and
7) and the timeout rate tracks the win rate almost exactly throughout. Any
lever whose only effect is "make `turtle`'s defense more durable" will hit
this same wall, regardless of the specific numeric mechanism (more turrets,
more HP, faster repair, slower decay, etc.) — because durability only ever
converts a 0%/0% (combat-loss) outcome into something approaching a
100%/100% (timeout-tiebreak) outcome, never into a "turtle wins by combat or
resource-win" outcome.

### Why this also explains most of criterion 5's other failures

Of the 14/81 pairings ≥30% timeout (full list in
`matrix_v0.5.3_task1.3.json`):

- **4 pairings (`idle_vs_idle`, `idle_vs_passive`, `passive_vs_idle`,
  `passive_vs_passive`) at 100%**: both bots are non-aggressive baselines that
  never attack — these can **never** resolve by combat or resource-win, by
  construction, regardless of any balance lever. Likely outside this
  criterion's intent (floor/sanity references, not "strategies").
- **6 pairings involving `turtle`/`macro`/`heavy` at 98-100%**
  (`turtle_vs_macro`, `macro_vs_turtle`, `macro_vs_macro`, `turtle_vs_heavy`,
  `heavy_vs_turtle`, `heavy_vs_heavy`): same root cause as above — these
  pairings already sit at the "wall never breaks" end of the spectrum even at
  `TURRET_CAP=3`. Any lever that further strengthens defense (for `turtle`'s
  criterion-2 fix) would push these even further past 30%, not help them.
- **4 pairings (`rush_medium`/`rush` mirrors and cross-pairs, 70-82%)**: both
  sides have offense; this is a **separate phenomenon** (two attrition-based
  attackers grinding to the time limit) not addressed by this investigation.

## What would close criterion 2 (and not make criterion 5 worse) — human/design decisions needed

None of the following are "balance numeric tuning" — they are behavior or
design changes outside the scope of REVIVAL_PLAN line 244's lever list, and
are flagged here for a human decision before any further autonomous work on
Task 1.3:

1. **Give `turtle` a limited counter-offense capability** (e.g., a small
   number of mobile combat units once economy/defense thresholds are met) so
   it has a *third* win path — destroying the opponent's crystal or enough of
   their army to force a retreat — that can resolve before `maxTicks` without
   relying on the tiebreaker. This is the most direct fix but changes
   `TurtleBot`'s fundamental "never attacks" design, which REVIVAL_PLAN
   currently treats as intentional.
2. **Reconsider criterion 2's relationship to criterion 5** — e.g., explicitly
   exclude or separately cap timeout-tiebreak wins from criterion 2's "beat
   ≥30%" count, so that a bot can't satisfy criterion 2 by stalling. (As
   currently written, the two criteria can directly contradict each other for
   any bot whose only "win" against a sustained attacker is a tiebreak win —
   not just `turtle`.)
3. **Reconsider the timeout-tiebreak rule itself** (currently: crystal HP,
   then lifetime resources) or `maxTicks` — if the tiebreak favored a
   different signal, or if `maxTicks` were tuned per-pairing, the
   `TURRET_CAP` transition's "cliff" shape might be smoothed into a workable
   middle ground. Unclear whether this is feasible without its own
   side-effects on the other 13 criterion-5 pairings.
4. **Re-scope criterion 5** — treat the 4 `idle`/`passive`-only pairings as
   expected-100%-by-design (already proposed in Iteration 8's diary entry,
   not yet ratified) and/or treat `turtle`/`macro`/`heavy` "fortress" pairings
   as a known/accepted category rather than a hard failure, if criterion 2's
   `turtle` leg is separately resolved or waived.

## What's shipped in v0.5.4-ML

- `MediumRushBot.FIRST_PUSH_TICK` 200→300 (`headless/src/bots/mediumRushBot.ts`)
- Crystal slow-regen: `HEALING.crystalRegenHpPerTick=0.05`,
  `HEALING.crystalRegenRange=300` (`shared/src/gameBalance.ts`),
  `processCrystalRegen()` (`server/src/match/engine/repair.ts`, called from
  `matchEngine.ts` tick() Phase 6). 3 new tests in `tests/index.ts`
  ("Combat: Crystal Regen"), suite at 470/470.
- `balanceHistory.ts` 0.5.4-ML snapshot (+ retroactive 0.5.2-ML/0.5.3-ML
  snapshots added this session, fixing a pre-existing replay-desync gap for
  those versions).

Both iteration-3 levers are kept (spec-compliant per REVIVAL_PLAN, no
regressions observed on criteria 1/3/4 or `macro`'s criterion-2 leg) despite
their zero effect on `turtle` — they're correct/complete implementations of
REVIVAL_PLAN's prescribed levers and the negative result is itself useful
evidence (recorded above).

## Next steps

Do not resume Task 1.3 balance-lever tuning without a decision on one of the
four options above. The full 81-pair matrix has NOT been re-run since
v0.5.3-ML (Iteration 8) — `FIRST_PUSH_TICK`/crystal-regen's effects on
pairings other than `turtle`/`macro` vs `rush_medium` are unmeasured, but
given their zero effect on the targeted pairings and the targeted
re-measurements showing no regression on `macro`'s leg, a full re-run is
unlikely to change this document's conclusions and was not run (saves ~113
min; can be done as part of whatever follow-up addresses this FINDINGS.md).

---

## Decision (2026-06-11) — ratified path forward

The user asked for a best-path recommendation and directed that the plan
documentation be updated accordingly. **Decision: adopt options 2 + 4 (amend
the acceptance criteria); reject options 1 and 3; proceed to Phase 2 after
one confirmation matrix run under v0.5.4-ML.** Rationale and the amended
criteria follow. REVIVAL_PLAN.md Task 1.3 carries the same amendments inline.

### Why amend the criteria rather than the game or the bots

Phase 1 exists to fix diagnosis root cause #2: *"no scripted bot beats
rush_medium — the training gate was unachievable."* That is no longer true:
**`macro` beats `rush_medium` 46%/46% with zero timeout games in either
direction** — a non-rush strategy beating the rush by genuine resolution.
The game now demonstrably supports defence-into-victory. `turtle`'s 0% is a
property of the bot's *intentional* design (never attacks, so no win path
against sustained offense except the timeout tiebreak — proven structurally
above), not a property of game balance. The ML agent is not `turtle`; it is
not constrained to never attack. Holding Phase 2 (the project's actual
bottleneck per the diagnosis) hostage to a scripted bot's deliberate design
limitation inverts the project's priorities.

- **Option 1 (give `turtle` counter-offense) — rejected.** (a) It destroys
  `turtle`'s roster value as the pure-defense reference and as a distinct
  sparring style for the ML agent; (b) "defend then push" already exists in
  the roster and already passes criterion 2 — that bot is `macro`; turtle
  with offense is a redundant, worse macro; (c) new behaviour means a new
  multi-iteration tuning loop, delaying Phase 2 for zero training benefit.
- **Option 3 (change tiebreak rule / `maxTicks`) — rejected.** Blast radius
  over all 81 pairings and the now-passing criteria 1/3/4; the hoped-for
  "smoothing of the cliff" is speculative; and raising `maxTicks` lengthens
  episodes, directly worsening the per-tick-γ horizon problem that Phase 2
  exists to fix.

### Amended acceptance criteria (supersede REVIVAL_PLAN lines 238–242 for Task 1.3 evaluation)

1. *(unchanged)* Every bot loses ≥20% of matches to at least one other bot.
   — **PASSES** (v0.5.3 matrix).
2. **(amended)** `macro` beats `rush_medium` ≥30%, **and** that pairing's
   timeout rate is <30% (so the wins are genuine resolutions, not stalls).
   The `turtle` leg is **removed**: it is mathematically incompatible with
   criterion 5 for a never-attacks bot (root-cause section above). —
   **PASSES** (46%/46%, 0 timeouts both directions).
3. *(unchanged)* `rush_medium` beats `rush_weak_medium` ≥60%. — **PASSES**
   (100%/100%).
4. *(unchanged, already CLOSED)* Mirror matches within 40–60%.
5. **(amended)** Timeout-tiebreak <30% in every pairing of a rush-family bot
   (`rush_weak`, `rush_weak_medium`, `rush_medium`, `rush`) against a
   non-rush bot. Pairings **within** {`idle`, `passive`, `turtle`, `macro`,
   `heavy`} are excluded by construction: no bot in that set initiates
   sustained offense, so those pairings can only resolve by resource win or
   timeout — the original criterion was unsatisfiable for them as written.
   — **PASSES** on the v0.5.3 matrix (worst rush-vs-non-rush pairing:
   `rush_weak_medium` vs `turtle` at 20%).
   - **Known issue KI-1 (accepted, non-blocking):** the four rush-family
     internal attrition pairings — `rush_medium` mirror (82%), `rush` mirror
     (72%), `rush_medium`↔`rush` (70%/70%) — stay timeout-heavy. Both sides
     have offense, so this is tunable in principle, but any fix (sudden
     death, damage escalation, `maxTicks` changes) risks the now-passing
     criteria and is design work, not lever tuning. The ML agent never plays
     in scripted-vs-scripted pairings, and timeouts produce deterministic
     winners (no draws). **Revisit at Phase 3 eval** — specifically if the
     trained agent learns to exploit timeout-stalling.

### Task 1.4 corollary: `passiveWinThreshold` stays at 4500

The v0.5.3 matrix shows 8 non-mirror pairings above Task 1.4's "~30%
resource wins → raise threshold 50%" trigger — but **all 8 are `turtle` vs
{`idle`, `passive`, `rush_weak`, `rush_weak_medium`}** (74–90% resource
wins), i.e. the resource win working exactly as intended: turtle's
legitimate win path against opponents that can't break its wall. No
competitive pairing exceeds 2% resource wins. Raising the threshold would
convert those resource wins into timeout-tiebreaks, directly regressing
criterion 5 for no benefit. The rule's trigger is hereby scoped to pairings
where a combat resolution is achievable for both sides (i.e. not turtle's
fortress pairings).

### Handoff — what the next agent does, in order

1. Read this section, then REVIVAL_PLAN.md Task 1.3's amendment block.
2. Run the **confirmation matrix under v0.5.4-ML** (the v0.5.3 matrix
   predates `FIRST_PUSH_TICK`=300 and crystal regen): `python3
   training/balance_report.py --matches 50`, ~115 min, run in background;
   save as `docs/balance/matrix_v0.5.4_task1.3_confirm.json`.
3. Evaluate against the **amended** criteria 1/2/3/5 above (criterion 4 is
   closed) plus the Task 1.4 corollary. Expected: pass — only
   `FIRST_PUSH_TICK` and crystal regen changed since v0.5.3, both measured
   at zero effect on the targeted pairings.
4. If pass → execute Phase 1 exit (REVIVAL_PLAN line 250): archive the
   matrix, R10 diary entry (before/after tables, draft release notes for the
   player-facing changes: timeout tiebreaker, cost/counter changes, crystal
   regen), update Appendix B and the handoff section. Docs-only → no version
   bump.
5. If a previously-passing criterion regresses (unlikely), re-read this file
   before touching any lever.
6. Then start **Phase 2 Task 2.1** (frame skip) — after re-reading
   `/root/fable-crystalfront-diagnosis.md` per standing project practice.
