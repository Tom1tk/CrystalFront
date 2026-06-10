# Crystal Front — ML Agent (technical reference)

> ⚠️ **2026-06 diagnosis:** curriculum results recorded before v0.5.0-ML were affected by a
> config-override bug (see `docs/REVIVAL_PLAN.md` §0). Treat stage-clearance history as
> unreliable. The §3 action table below was regenerated from `actionIndex.ts` on 2026-06-09
> and supersedes all previous versions of this section (which documented a non-existent layout).

Reinforcement-learning bot for the Crystal Front RTS. This document is the **technical reference** — architecture, observation/action/reward specs, training commands, and module reference.

For project history, decisions, and the current handoff state, see **`ML_BOT_ACTION_PLAN.md`**.

**Branch:** `CrystalFront-ML`
**Algorithm:** PPO + Behaviour Cloning warmup + curriculum learning
**Current shipped version:** `0.3.2-ML` — `models/policy-v0.3.2-ML.onnx` (u150 checkpoint, ~1.3 MB)
**Code version:** `0.5.2-ML` (revival plan Phase 1 in progress; see `docs/REVIVAL_PLAN.md` and `ML_BOT_ACTION_PLAN.md`)

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Observation specification](#2-observation-specification)
3. [Action space](#3-action-space)
4. [Reward specification](#4-reward-specification)
5. [Curriculum stages](#5-curriculum-stages)
6. [Action-forcing module (v0.4.0-ML)](#6-action-forcing-module-v040-ml)
7. [RND intrinsic motivation module (v0.4.0-ML)](#7-rnd-intrinsic-motivation-module-v040-ml)
8. [Training guide](#8-training-guide)
9. [Evaluation tooling](#9-evaluation-tooling)
10. [TensorBoard reference](#10-tensorboard-reference)
11. [File structure](#11-file-structure)

---

## 1. Architecture overview

```
                    ┌─────────────────────────────┐
                    │     Python (training)       │
                    │  ┌──────────────────────┐   │
                    │  │  PPO trainer         │   │
                    │  │  (CleanRL-style)     │   │
                    │  │  + RND predictor     │   │
                    │  │  + BC warmup         │   │
                    │  └──────────┬───────────┘   │
                    └─────────────┼───────────────┘
                                  │ stdio JSON-line protocol
                                  │ (one Node subprocess per vec_size games)
                    ┌─────────────┼──────────────────┐
                    │             ↓                  │
                    │  headless/src/stdioVecRunner   │
                    │  ┌──────────────────────────┐  │
                    │  │  MatchEngine (pure)      │  │  ← same engine as live game
                    │  │  - deterministic         │  │
                    │  │  - seedable RNG          │  │
                    │  └──────────────────────────┘  │
                    │  + observation builder         │
                    │  + legal-action enumerator     │
                    │    (with optional forcing)     │
                    │  + reward computation          │
                    │  + scripted opponents          │
                    └────────────────────────────────┘

                    ┌────────────────────────────────┐
                    │  Live game (production)        │
                    │  ┌──────────────────────────┐  │
                    │  │  MatchEngine (same code) │  │
                    │  │  + LiveMatchRunner       │  │
                    │  │  + BotPlayer             │  │
                    │  │    (drives any Agent)    │  │
                    │  │  + MlBot                 │  │
                    │  │    - loads ONNX policy   │  │
                    │  │    - xNorm-mirrors RED   │  │
                    │  │    - 1-tick async lag    │  │
                    │  └──────────────────────────┘  │
                    └────────────────────────────────┘
```

**Single source of truth.** `MatchEngine` is shared between training, live play, and replay playback. The reward function lives in `headless/src/reward.ts` (the `computeReward()` function) and is the only place rewards are computed — both runners import from it to prevent drift (regression hardened against in v0.3.0-ML).

**Symmetry handling.** Policy was trained exclusively as BLUE. When `MlBot` plays as RED, the observation is mirrored (`xNorm → 1 − xNorm` on every entity and node) so the policy "sees" itself on the left side. `isRed` is detected once in `MlBot.init()` from `match.players[idx].color`.

**Determinism.** Seeded `Rng` (mulberry32) + monotonic `IdGen` + no `Math.random()` in the engine + a CI determinism test (`same seed × 500 ticks → same state hash`). Replays save only seed + commandLog (~20–50 KB/match).

---

## 2. Observation specification

> Source of truth: `headless/src/observation.ts`. Built once per tick after applying fog-of-war.

### 2.1 Global features — `vec[22]` (GLOBAL_DIM)

| Idx | Name | Range | Notes |
|-----|------|-------|-------|
| 0 | `ownResources` | [0, ∞) / 1000 | Current resource bank, normalised |
| 1 | `ownSupply` | [0, 1] | `supply / maxSupply` |
| 2 | `ownMaxSupply` | int | Absolute supply cap |
| 3 | `oppVisibleSupply` | [0, 1] | Enemy supply fraction; 0 if no enemies visible |
| 4 | `tick` | [0, 1] | `tick / 6000` |
| 5 | `scoreDiff` | (−∞, ∞) | own score − opponent score |
| 6 | `ownCrystalHealthFrac` | [0, 1] | Own crystal hp / maxHp |
| 7 | `oppCrystalHealthFrac` | [0, 1] | Enemy crystal hp / maxHp; 0 if not visible |
| 8 | `ownResourcesWinFrac` | [0, 1] | Held resources / passiveWinThreshold |
| 9 | `oppResourcesWinFrac` | [0, 1] | Same for enemy; 0 if unknown |
| 10 | `ownLifetimeResourcesFrac` | [0, 1] | Mining rate signal |
| 11 | `oppLifetimeResourcesFrac` | [0, 1] | 0 if unknown |
| 12 | `enemyWorkerCount` | [0, ∞) | Visible enemy workers |
| 13 | `enemySkirmisherCount` | [0, ∞) | Visible enemy skirmishers |
| 14 | `enemyBruiserCount` | [0, ∞) | Visible enemy bruisers |
| 15 | `enemyBarracksCount` | [0, ∞) | Visible enemy barracks |
| 16 | `enemyTurretCount` | [0, ∞) | Visible enemy turrets |
| 17 | `enemyForwardUnitFrac` | [0, 1] | Fraction of visible enemy units in own half |
| 18 | `nearestEnemyToCrystalDistNorm` | [0, 1] | Threat geometry |
| 19 | `ownCombatInOwnHalf` | [0, ∞) | Defensive signal |
| 20 | `enemyCombatInOwnHalf` | [0, ∞) | Threat in own half |
| 21 | `totalVisibleEnemyCombat` | [0, ∞) | Total visible combat units |

### 2.2 Entity features — `vec[12]` per entity (up to MAX_E = 64)

| Idx | Name | Range | Notes |
|-----|------|-------|-------|
| 0 | `typeIndex` | [0, 9] | Index into ENTITY_TYPES — passed through learned 16-dim embedding |
| 1 | `owner` | {1, −1} | 1 = mine, −1 = enemy |
| 2 | `xNorm` | [0, 1] | **Mirrored (1 − x) when bot plays RED in MlBot** |
| 3 | `yNorm` | [0, 1] | |
| 4 | `healthFrac` | [0, 1] | health / maxHealth |
| 5 | `constructionFrac` | [0, 1] | Construction progress (buildings); 1 otherwise |
| 6 | `isAttacking` | {0, 1} | |
| 7 | `isMoving` | {0, 1} | |
| 8 | `isGathering` | {0, 1} | |
| 9 | `isBuilding` | {0, 1} | Worker with active build target |
| 10 | `attackCooldownNorm` | [0, 1] | attackCooldown / 25 |
| 11 | `inAttackRange` | {0, 1} | Enemy entity within attack range of own unit |

ENTITY_TYPES index:
```
0: crystal           5: medic
1: worker            6: building_barracks
2: skirmisher        7: building_foundry
3: gunner            8: building_supply_depot
4: bruiser           9: building_turret
```

### 2.3 Node features — `vec[5]` per node (up to MAX_N = 8)

| Idx | Name | Range |
|-----|------|-------|
| 0 | `xNorm` | [0, 1] (mirrored for RED) |
| 1 | `yNorm` | [0, 1] |
| 2 | `remainingFrac` | [0, 1] |
| 3 | `gathererCount` | [0, 3] |
| 4 | `isContested` | {0, 1} |

### 2.4 Padding and masks

Entities and nodes are zero-padded to fixed-length tensors. Two boolean masks accompany them:
- `entity_mask: (MAX_E,)` — True for valid slot, False for padding
- `node_mask: (MAX_N,)` — same convention

The Set-transformer encoders use these masks for both attention (`src_key_padding_mask`) and the final masked-mean pool.

---

## 3. Action space

> **Source of truth: `headless/src/actionIndex.ts`.** ACTION_SPACE_SIZE = 81.
> Tables below generated by `headless/src/printActionTable.ts` — regenerate after any action-space change.

The policy outputs a single integer `a ∈ [0, 80]`. `indexToAction(a)` converts to a structured `MacroAction`; `expandMacroAction()` emits raw engine commands. Illegal actions are masked to −1e9 before sampling.

### 3.1 Action table

> Generated from `headless/src/actionIndex.ts` by `printActionTable.ts` — regenerate after any action-space change.

**Total actions: 81**

| Index | Type | Params |
|---|---|---|
| 0 | noop | no-op |
| 1 | train_worker | train worker |
| 2 | train_unit | train unit  [skirmisher] |
| 3 | train_unit | train unit  [gunner] |
| 4 | train_unit | train unit  [bruiser] |
| 5 | train_unit | train unit  [medic] |
| 6 | build | build barracks  @ near_crystal |
| 7 | build | build barracks  @ mid_base |
| 8 | build | build barracks  @ forward |
| 9 | build | build foundry  @ near_crystal |
| 10 | build | build foundry  @ mid_base |
| 11 | build | build foundry  @ forward |
| 12 | build | build supply_depot  @ near_crystal |
| 13 | build | build supply_depot  @ mid_base |
| 14 | build | build supply_depot  @ forward |
| 15 | build | build turret  @ near_crystal |
| 16 | build | build turret  @ mid_base |
| 17 | build | build turret  @ forward |
| 18 | attack_move | attack_move  [all_combat]  → enemy_crystal |
| 19 | attack_move | attack_move  [all_combat]  → midfield |
| 20 | attack_move | attack_move  [all_combat]  → contested_node |
| 21 | attack_move | attack_move  [skirmishers]  → enemy_crystal |
| 22 | attack_move | attack_move  [skirmishers]  → midfield |
| 23 | attack_move | attack_move  [skirmishers]  → contested_node |
| 24 | attack_move | attack_move  [gunners]  → enemy_crystal |
| 25 | attack_move | attack_move  [gunners]  → midfield |
| 26 | attack_move | attack_move  [gunners]  → contested_node |
| 27 | attack_move | attack_move  [bruisers]  → enemy_crystal |
| 28 | attack_move | attack_move  [bruisers]  → midfield |
| 29 | attack_move | attack_move  [bruisers]  → contested_node |
| 30 | retreat | retreat  [all_combat] |
| 31 | retreat | retreat  [skirmishers] |
| 32 | retreat | retreat  [gunners] |
| 33 | retreat | retreat  [bruisers] |
| 34 | assign_workers | assign_workers  nodeChoice=nearest_safe |
| 35 | assign_workers | assign_workers  nodeChoice=nearest_contested |
| 36 | assign_workers | assign_workers  nodeChoice=richest_visible |
| 37 | attack_targeted | attack_targeted  [all_combat]  target=nearest_threat |
| 38 | attack_targeted | attack_targeted  [all_combat]  target=nearest_enemy |
| 39 | attack_targeted | attack_targeted  [all_combat]  target=focus_weakest |
| 40 | attack_targeted | attack_targeted  [skirmishers]  target=nearest_threat |
| 41 | attack_targeted | attack_targeted  [skirmishers]  target=nearest_enemy |
| 42 | attack_targeted | attack_targeted  [skirmishers]  target=focus_weakest |
| 43 | attack_targeted | attack_targeted  [gunners]  target=nearest_threat |
| 44 | attack_targeted | attack_targeted  [gunners]  target=nearest_enemy |
| 45 | attack_targeted | attack_targeted  [gunners]  target=focus_weakest |
| 46 | attack_targeted | attack_targeted  [bruisers]  target=nearest_threat |
| 47 | attack_targeted | attack_targeted  [bruisers]  target=nearest_enemy |
| 48 | attack_targeted | attack_targeted  [bruisers]  target=focus_weakest |
| 49 | hold_position | hold_position  [all_combat] |
| 50 | attack_move | attack_move  [all_combat]  → enemy_army |
| 51 | attack_move | attack_move  [all_combat]  → defend_crystal |
| 52 | attack_move | attack_move  [skirmishers]  → enemy_army |
| 53 | attack_move | attack_move  [skirmishers]  → defend_crystal |
| 54 | attack_move | attack_move  [gunners]  → enemy_army |
| 55 | attack_move | attack_move  [gunners]  → defend_crystal |
| 56 | attack_move | attack_move  [bruisers]  → enemy_army |
| 57 | attack_move | attack_move  [bruisers]  → defend_crystal |
| 58 | attack_targeted | attack_targeted  [all_combat]  target=targeting_friend |
| 59 | attack_targeted | attack_targeted  [all_combat]  target=spread_fire |
| 60 | attack_targeted | attack_targeted  [skirmishers]  target=targeting_friend |
| 61 | attack_targeted | attack_targeted  [skirmishers]  target=spread_fire |
| 62 | attack_targeted | attack_targeted  [gunners]  target=targeting_friend |
| 63 | attack_targeted | attack_targeted  [gunners]  target=spread_fire |
| 64 | attack_targeted | attack_targeted  [bruisers]  target=targeting_friend |
| 65 | attack_targeted | attack_targeted  [bruisers]  target=spread_fire |
| 66 | attack_move | attack_move  [all_workers]  → enemy_crystal |
| 67 | attack_move | attack_move  [all_workers]  → midfield |
| 68 | attack_move | attack_move  [all_workers]  → contested_node |
| 69 | attack_move | attack_move  [all_workers]  → enemy_army |
| 70 | attack_move | attack_move  [all_workers]  → defend_crystal |
| 71 | attack_move | attack_move  [all_idle_combat]  → enemy_crystal |
| 72 | attack_move | attack_move  [all_idle_combat]  → midfield |
| 73 | attack_move | attack_move  [all_idle_combat]  → contested_node |
| 74 | attack_move | attack_move  [all_idle_combat]  → enemy_army |
| 75 | attack_move | attack_move  [all_idle_combat]  → defend_crystal |
| 76 | attack_move | attack_move  [idle_workers]  → enemy_crystal |
| 77 | attack_move | attack_move  [idle_workers]  → midfield |
| 78 | attack_move | attack_move  [idle_workers]  → contested_node |
| 79 | attack_move | attack_move  [idle_workers]  → enemy_army |
| 80 | attack_move | attack_move  [idle_workers]  → defend_crystal |

### 3.1.1 Range summary

| Range | Type | Notes |
|---|---|---|
| 0 | noop | safety-valve |
| 1 | train_worker | |
| 2–5 | train_unit | skirmisher / gunner / bruiser / medic |
| 6–17 | build | 4 building types × 3 x-zones (near_crystal / mid_base / forward) |
| 18–29 | attack_move | 4 groups × 3 original zones (enemy_crystal / midfield / contested_node) |
| 30–33 | retreat | 4 groups |
| 34–36 | assign_workers | 3 nodeChoices (nearest_safe / nearest_contested / richest_visible) |
| 37–48 | attack_targeted | 4 groups × 3 targetTypes (nearest_threat / nearest_enemy / focus_weakest) |
| 49 | hold_position | all_combat |
| 50–57 | attack_move | 4 groups × 2 new zones (enemy_army / defend_crystal) |
| 58–65 | attack_targeted | 4 groups × 2 new targetTypes (targeting_friend / spread_fire) |
| 66–70 | attack_move | all_workers × 5 zones |
| 71–75 | attack_move | all_idle_combat × 5 zones |
| 76–80 | attack_move | idle_workers × 5 zones |

### 3.2 Sub-field values

- **`group`:** `all_combat`, `skirmishers`, `gunners`, `bruisers`, `all_workers`, `all_idle_combat`, `idle_workers`
- **`targetZone`:** `enemy_crystal`, `midfield`, `contested_node`, `enemy_army`, `defend_crystal`
- **`xZone`:** `near_crystal`, `mid_base`, `forward`
- **`nodeChoice`:** `nearest_safe`, `nearest_contested`, `richest_visible`
- **`workerCount`:** always `all_idle` in the enumeration

### 3.3 Legality rules (`headless/src/legalActions.ts`)

| Action | Legal when |
|--------|-----------|
| `noop` | Always — unless forcing is active and conditions met (§6) |
| `train_worker` | `resources ≥ workerTrainCost` AND supply headroom |
| `train_unit(T)` | `resources ≥ cost[T]` AND supply headroom AND a producing building exists |
| `build(B, …)` | `resources ≥ cost[B]` AND at least one idle worker AND zone valid |
| `attack_move(group, …)` | At least one unit of `group` exists — unless forcing-suppressed (§6) |
| `retreat(group)` | Same as attack_move |
| `assign_workers(…)` | At least one idle worker AND at least one available node |
| `set_rally(…)` | At least one completed building exists |

---

## 4. Reward specification

> **Source of truth: `headless/src/reward.ts` — `computeReward()`.**
> Both runners (`stdioRunner.ts`, `stdioVecRunner.ts`) import this function. Last extended in v0.4.0-ML (units 3, 4 bootstrap shaping).

### 4.1 Per-step components

| Signal | Magnitude | When |
|--------|-----------|------|
| Crystal damage dealt | `+5.0 × delta_healthFrac` | enemy crystal visible (both prev and curr > 0) |
| Crystal damage taken | `−2.0 × delta_healthFrac` | every tick |
| First barracks built | `+10.0` | one-time |
| First combat unit trained | `+5.0` | one-time |
| Second combat unit trained | `+3.0` | one-time (v0.4.0-ML+) |
| Third combat unit trained | `+2.0` | one-time (v0.4.0-ML+) |
| Fourth combat unit trained | `+1.0` | one-time (v0.4.0-ML+) |
| Time penalty | `−0.001` | every tick (−6 over a 6000-tick episode) |

**Max achievable shaping per episode:** ~+26 (crystal dmg full + barracks + 4 unit milestones) − 6 time. Terminal still dominates.

### 4.2 Terminal

```
done && winner == blueId && winType != "resource"  → +100.0
otherwise (loss, draw, timeout, resource-win)      → −100.0
```

**Draw = loss.** Refusing to engage cannot be the optimal strategy. Resource wins are also penalised — the bot is a combat agent, not an accountant.

### 4.3 Why the shape changed (v0.3.0-ML and beyond)

v0.3.0-ML simplified the reward from ~20 components (which had accumulated to ~+150 shaping/ep, masking the terminal) to 6 components capped at ~+14 shaping. v0.4.0-ML added three more one-time milestones (+3, +2, +1 for units 2/3/4) specifically to provide a positive signal for multi-unit play. The extended milestones did **not** rescue rush_medium performance — see `ML_BOT_ACTION_PLAN.md` for the post-mortem.

### 4.4 Milestones struct

```typescript
interface Milestones {
  hasBuiltBarracks: boolean;
  firstBarracksTick: number;
  hasTrainedCombatUnit: boolean;
  firstCombatUnitTick: number;
  hasTrainedSecondCombatUnit: boolean;
  hasTrainedThirdCombatUnit: boolean;
  hasTrainedFourthCombatUnit: boolean;
  firstAttackTick: number;
  minOppCrystalHealthFrac: number;  // diagnostic only
  minOwnCrystalHealthFrac: number;  // diagnostic only
}
```

Reset via `freshMilestones()` at episode start.

---

## 5. Curriculum stages

> Defined in `training/ppo/train.py` `CURRICULUM` list. Auto-promote on `win_rate ≥ threshold` over 100 episodes; auto-regress after `max_steps` if stuck.

| Idx | Stage | Map | Crystal HP | Resources | Opponent | Notes |
|-----|-------|-----|------------|-----------|----------|-------|
| 0 | 0a | 800px | 50HP | 200 | idle | 2 pre-placed skirmishers (Phase A) |
| 1 | 0b | 800px | 50HP | 200 | idle | No scaffolding |
| 2 | 0b5 | 800px | 100HP | 200 | idle | |
| 3 | 0c | 800px | 100HP | 50 | idle | Resource slider step 1 |
| 4 | day5 | 1500px | 200HP | 50 | idle | |
| 5 | 1a | 1500px | 100HP | 50 | idle | |
| 6 | 1b | 1500px | 100HP | 50 | passive | |
| 7 | 2a | 3000px | 300HP | 50 | passive | |
| 8 | 2a5 | 3000px | 300HP | **200** | **rush_weak** | Resource slider for active opponent |
| 9 | 2a6 | 3000px | 300HP | 75 | rush_weak | |
| 10 | 2b | 3000px | 300HP | 50 | rush_weak | |
| 11 | 3a | 6000px | 1000HP | 50 | passive | **Full game map** |
| 12 | 3a5 | 6000px | 1000HP | 200 | rush_medium | |
| 13 | 3a_rwm | 3000px | 300HP | 50 | rush_weak_medium | (used in v0.4.0-ML) |
| 14 | 3a_rm_3k | 3000px | 300HP | 50 | rush_medium + 2 pre-placed skirmishers | **The wall — never cleared** |
| 15 | 3b | 6000px | 1000HP | 50 | rush_medium | Graduation gate |
| 16 | 4 | 6000px | 1000HP | 50 | league | PFSP self-play |

**v0.3.2-ML cleared up to stage 11 (3a).** Stages 12–16 remain ungated. Stage 14 (`3a_rm_3k`) is the trn=0% ceiling — see `ML_BOT_ACTION_PLAN.md` for details.

---

## 6. Action-forcing module (v0.4.0-ML)

> **Default-off.** Specified by `LegalActionsOpts.forcingScale = 0.0`. Setting `> 0` injects a curriculum-style action mask.
> Source: `headless/src/legalActions.ts`, integrated in `headless/src/stdioVecRunner.ts`.

### 6.1 Interface

```typescript
export interface LegalActionsOpts {
  noopStreak?: number;        // ticks since last noop reset
  trainUnitStreak?: number;   // ticks since last train_unit action (Variant β')
  forcingScale?: number;      // 0.0 = off, 1.0 = always force when conditions met
}

getLegalActions(match, playerId, opts?: LegalActionsOpts)
```

### 6.2 Mode A — early barracks forcing

Fires when:
- `noopStreak >= 30`
- no barracks exists yet for this player
- at least one idle worker available
- `resources >= BUILDING_DEFS.barracks.cost`
- `Math.random() < forcingScale`

Effect: `noop` is removed from the legal-action list. The policy must sample some other action; the most economically rational is `build(barracks)`.

### 6.3 Mode B — multi-unit forcing (Variant β')

Fires when:
- `trainUnitStreak >= 50`
- at least one completed barracks exists
- `combatUnits < 3` (note: threshold is `< 3` not `< 2` — fires while pre-placed skirmishers still alive)
- `resources >= 50`
- `Math.random() < forcingScale`

Effect: **both** `noop` and `attack_move(*, *)` are removed. Forces the policy to either train, build, retreat, or move workers — preventing the "attack with 1 unit while ignoring train_unit" failure mode.

### 6.4 Runner integration

`stdioVecRunner.ts` tracks per-slot `noopStreak` and `trainUnitStreak`:

```typescript
slot.noopStreak       = macroAction.type === "noop"       ? slot.noopStreak + 1       : 0;
slot.trainUnitStreak  = macroAction.type === "train_unit" ? 0 : slot.trainUnitStreak + 1;
```

`ACTION_FORCING_SCALE` is read from the `reset_all` protocol message; mid-training fade is supported via a `set_forcing_scale` message (called by the trainer when crossing `--action_forcing_fade_start/--action_forcing_fade_end`).

### 6.5 Why forcing did not break the rush_medium ceiling

Per the v0.4.0-ML post-mortem in `ML_BOT_ACTION_PLAN.md`: forced `train_unit` actions in losing episodes create a negative gradient (`train_unit → −100 terminal`). The policy learned to retreat from any state where forcing could trigger (noop rose to 65–68% before auto-regression). The mechanism worked; the gradient sign was wrong.

---

## 7. RND intrinsic motivation module (v0.4.0-ML)

> **Default-off.** Specified by `train.py --rnd_coef 0.0`. Enabled only when `rnd_coef > 0`.
> Source: `training/ppo/policy.py` — `RNDModel`, `RunningMeanStd`.

### 7.1 Architecture

Two networks operating on the 22-dim global observation:

```
target    = MLP(22 → 64 → 64)   # fixed random weights, requires_grad=False
predictor = MLP(22 → 64 → 64 → 64)   # trained via MSE to match target
```

`RunningMeanStd` (Welford online estimator) normalises both observations and per-step intrinsic rewards.

### 7.2 Intrinsic reward computation

Each step, before the rollout buffer write:

```python
o = obs_rms.normalise(global_obs).clamp(-5.0, 5.0)
with torch.no_grad():
    t = target(o)
p = predictor(o)
r_intrinsic = ((p - t) ** 2).mean(dim=-1)  # (B,)

# Update running stats
obs_rms.update(global_obs)
rew_rms.update(r_intrinsic)

# Normalise and scale
r_norm = r_intrinsic / (rew_rms.var.sqrt() + 1e-8)
rewards = extrinsic_rewards + rnd_coef * r_norm
```

### 7.3 Predictor training

After every PPO update, the predictor is trained for one epoch over the full rollout batch:

```python
loss = ((predictor(obs_norm) - target(obs_norm)) ** 2).mean()
predictor_optimizer.step()
```

### 7.4 Checkpoint persistence

```python
ckpt["rnd"] = rnd_model.state_dict()   # save
rnd_model.load_state_dict(ckpt["rnd"]) # restore
```

### 7.5 Calibration finding

`rnd_coef=0.01` provides only **+0.001/step** (buried by ±100 terminal). Use `rnd_coef=0.5` for **+0.06–0.29/novel step** (~+5–17 per novel-state episode).

### 7.6 RND alone is insufficient

If the policy never visits novel states (p(`train_unit`) ≈ 0), RND never fires. Must be combined with action-forcing (§6) so train_unit is mechanically sampled, then RND rewards the novel multi-unit state reached. Even combined, the net per-episode incentive for "train units then lose" (~−83) vs "noop and lose" (−100) was not enough to flip the gradient sign — see post-mortem.

---

## 8. Training guide

### 8.1 Prerequisites

```bash
pip install -r training/requirements.txt
npm install                            # Node deps for headless
```

### 8.2 Quick smoke test

```bash
python -m training.test_env            # ~5s end-to-end pipeline check
```

### 8.3 BC warmup (mandatory before curriculum)

```bash
python -m training.bc_pretrain \
  --episodes 1000 \
  --output bc_warmup.pt \
  --map_width 0 \
  --crystal_health 0 \
  --noop_keep 0.05
```

BC warmup runs RushBot vs IdleBot on full game config (6000px/1000HP/50 res), subsamples noop to 5% of dataset, trains the actor for 5 epochs with cross-entropy, then pretrains the critic on discounted returns. Output checkpoint includes both actor and critic state, **but not optimizer state** (it would fight PPO).

### 8.4 Standard curriculum training (v0.3.2-ML recipe)

```bash
python -m training.ppo.train \
  --curriculum --curriculum_stage 0 \
  --checkpoint bc_warmup.pt \
  --ent_coef 0.02 \
  --num_envs 20 --vec_size 4 \
  --total_timesteps 20000000
```

Expected throughput: ~1100–1375 SPS on RX 7900 XTX / 12-vCPU container. 20M steps = ~4–5h wall time.

### 8.5 Resume from a specific checkpoint

```bash
python -m training.ppo.train \
  --curriculum --curriculum_stage 11 \
  --checkpoint checkpoints/<run>/update_000150.pt \
  --total_timesteps 10000000
```

The trainer restores actor, critic, RND state, and the update counter (LR schedule continues correctly). Optimizer state is skipped if the checkpoint is from BC (`update=0`).

### 8.6 Option B training — action-masking forcing (v0.4.0-ML, default-off)

```bash
python -m training.ppo.train \
  --curriculum --curriculum_stage 14 \
  --checkpoint <ckpt> \
  --ent_coef 0.05 \
  --action_forcing_scale 1.0 \
  --action_forcing_fade_start 5000000 \
  --action_forcing_fade_end 10000000 \
  --total_timesteps 15000000
```

Fade is linear from `_start` to `_end` in env-step units. `scale=0` after `_end`.

### 8.7 Option γ training — RND (v0.4.0-ML, default-off)

```bash
python -m training.ppo.train \
  --curriculum --curriculum_stage 14 \
  --checkpoint <ckpt> \
  --rnd_coef 0.5 --rnd_embed_dim 64 \
  --action_forcing_scale 1.0 \
  --ent_coef 0.05 \
  --total_timesteps 15000000
```

RND must be combined with forcing — §7.6.

### 8.8 League mode (PFSP self-play, never activated for v0.3.2-ML)

```bash
python -m training.ppo.train --league \
  --league_pfsp_temp 0.5 \
  --league_add_interval 100 \
  --num_envs 20 --total_timesteps 10000000
```

Per third review §7.10 + R11: do **not** activate league mode until stage 3b is cleared.

### 8.9 Key hyperparameters

| Flag | Default | Notes |
|------|---------|-------|
| `--num_envs` | 20 | Parallel simulators. 20 is the sweet spot for 12 vCPUs. |
| `--vec_size` | 4 | Games per Node subprocess. 5 procs × 4 = 20 envs. |
| `--num_steps` | 1536 | Rollout horizon; tuned for 6000-tick episodes. |
| `--num_minibatches` | 6 | 5120 per minibatch with 30720 total. |
| `--update_epochs` | 4 | |
| `--gamma` | 0.995 | Effective horizon ~200 ticks. |
| `--ent_coef` | 0.02 | 0.05 used for v0.4.0-ML forcing/RND runs. |
| `--mlp_hidden` | 384 | Trunk width. |
| `--save_interval` | 50 | Checkpoint every N updates. |
| `--save_replay_every` | 0 | Disable training-replay saves (was polluting browser). |
| `--action_forcing_scale` | 0.0 | Off by default. |
| `--rnd_coef` | 0.0 | Off by default. |

### 8.10 Stop-the-line conditions

- vs IdleBot stage never reaches 100% within 100k steps → pipeline bug.
- vs scripted-bot win rate <60% after 20M steps → reward/action/observation needs rework, not more compute.
- Entropy < 0.3 in first 500k steps → policy collapsed; increase `--ent_coef` or restart.
- noop% rising monotonically above 60% during forcing → forcing is making things worse; halt and re-evaluate.
- ep_len locked at 6000 → agent is drawing; check the draw=−100 penalty wired up.

---

## 9. Evaluation tooling

### 9.1 `training/eval/eval_checkpoint.py`

Loads any `.pt` and plays N deterministic matches vs each scripted bot, prints a win-rate table.

```bash
python -m training.eval.eval_checkpoint \
  --checkpoint checkpoints/<run>/update_NNN.pt \
  --episodes 100 \
  --opponents passive rush_weak rush_weak_medium rush_medium turtle macro
```

Note: `--opponents` is space-separated (tyro convention), not comma-separated.

### 9.2 `training/diagnose_policy.py` (v0.4.0-ML)

Per-episode action histogram. Records `train_unit_count`, `max_noop_streak`, outcome per episode. Output: CSV.

```bash
python -m training.diagnose_policy \
  --checkpoint <ckpt> \
  --opponent rush_medium \
  --episodes 100 \
  --output /tmp/diag.csv
```

This script revealed the v0.4.0-ML rounding artefact: the policy actively trains 9–17 units per episode in eval, even when training logs report `trn=0%` (which is `int(0.3%)` = 0).

### 9.3 ONNX export + parity

```bash
python -m training.export_onnx --checkpoint <ckpt> --output models/policy-vX.onnx
python -m training.test_onnx_parity --checkpoint <ckpt> --onnx_path models/policy-vX.onnx
```

Produces `policy-vX.onnx` (~41 KB) + `policy-vX.onnx.data` (~1.2 MB external tensors). Parity test asserts max logit error <1e-3, max value error <1e-3.

---

## 10. TensorBoard reference

```bash
tensorboard --logdir /root/CrystalFront/runs --bind_all
```

Run names: `crystalfront_ppo__{version}__{opponent}__{seed}__{timestamp}`.

### 10.1 `game/` — agent behaviour

- **`game/win_rate`** — rolling 100-episode win rate. Primary metric.
- **`game/episode_reward`** — full reward (terminal + shaping).
- **`game/episode_terminal_return`** — `±100` only; reveals shaping-hacking when it diverges from `episode_reward`.
- **`game/episode_length_ticks`** — leading indicator. Drops before win_rate moves.

### 10.2 `training/` — process health

- **`training/learning_rate`** — linear anneal from 2.5e-4 to 0. Flat = schedule bug.
- **`training/steps_per_second`** — expect ~1100–1375 with 20 envs. Sudden drop = hanging subprocess.

### 10.3 `ppo/` — algorithm internals

- **`ppo/policy_gradient_loss`** — small negative. Blow-up = LR too high.
- **`ppo/value_function_loss`** — should trend down. Persistent high = reward too sparse.
- **`ppo/entropy_bonus`** — keep > 0.3 in first 500k steps.
- **`ppo/clip_fraction`** — healthy 0.05–0.20. >0.3 = updates too large.
- **`ppo/approx_kl_divergence`** — > 0.02 consistently = unstable.

### 10.4 `rnd/` (v0.4.0-ML, only when `--rnd_coef > 0`)

- **`rnd/predictor_loss`** — MSE of predictor vs target. Decreasing = predictor learning known states.
- **`rnd/intrinsic_reward_mean`** — Per-batch average intrinsic reward. Decays as states become familiar; small spikes when novel states are visited.

### 10.5 `league/` (only when `--league`)

- **`league/win_vs_idle`** etc. — per-opponent rolling win rate.
- **`league/win_rate_matrix`** — full text matrix logged each update.

---

## 11. File structure

```
CrystalFront/
│
├── headless/src/                       # TypeScript headless match runner
│   ├── types.ts                        # Agent interface, MacroAction, PlayerObservation
│   ├── runMatch.ts                     # Single-match entry (no WebSockets)
│   ├── observation.ts                  # Fog-filtered observation builder
│   ├── actionSpace.ts                  # MacroAction → raw engine commands
│   ├── actionIndex.ts                  # Integer ↔ MacroAction mapping (81 actions)
│   ├── legalActions.ts                 # Legal-action enumerator + LegalActionsOpts forcing
│   ├── reward.ts                       # SINGLE SOURCE OF TRUTH for computeReward()
│   ├── stdioRunner.ts                  # Per-game subprocess (older path)
│   ├── stdioVecRunner.ts               # Vectorised subprocess (N games), supports forcing
│   ├── cli.ts                          # Manual match runner + replay saver
│   └── bots/
│       ├── mlBot.ts                    # ✅ SHIPPED — ONNX policy via onnxruntime-node
│       ├── idleBot.ts
│       ├── passiveBot.ts               # Economy only, never attacks
│       ├── rushBot.ts
│       ├── weakRushBot.ts
│       ├── weakMediumRushBot.ts        # Added during v0.3.2-ML ship
│       ├── mediumRushBot.ts
│       ├── turtleBot.ts
│       ├── macroBot.ts
│       └── heavyBot.ts
│
├── headless/dist/                      # Compiled mirrors (loaded by runtime — keep in sync)
│
├── server/src/
│   ├── index.ts                        # Server entry; createBotAgent() factory; mlBotSession pre-load
│   └── match/
│       ├── matchEngine.ts              # Pure engine (no setInterval)
│       ├── liveMatchRunner.ts          # Production tick driver
│       ├── replayRunner.ts             # Replay save/load + analyzeReplay
│       ├── botPlayer.ts                # In-process bot driver
│       └── engine/
│           ├── rng.ts                  # mulberry32 PRNG (seedable)
│           ├── idGen.ts                # Monotonic entity ID counter
│           ├── movement.ts
│           ├── combat.ts
│           ├── gathering.ts
│           ├── repair.ts
│           ├── visibility.ts
│           └── utils.ts
│
├── client/src/components/
│   ├── BotSelectMenu.tsx               # ✅ "Play vs Bot" screen (SCRIPTED + ML sections)
│   ├── ReplayBrowser.tsx               # Filterable, paginated replay index
│   └── …
│
├── shared/src/
│   ├── gameBalance.ts                  # Current balance values
│   └── balanceHistory.ts               # Versioned snapshots — replays use historical values
│
├── models/
│   ├── policy-v0.3.2-ML.onnx           # ✅ SHIPPED (u150) — 81-action policy
│   └── policy-v0.3.2-ML.onnx.data      # External tensors (required alongside .onnx)
│
├── training/
│   ├── env/
│   │   ├── crystalfront_env.py         # Gymnasium wrapper (single game per process)
│   │   └── crystalfront_vec_env.py     # Vectorised wrapper + action_forcing_scale + set_forcing_scale
│   ├── ppo/
│   │   ├── policy.py                   # SetTransformer + CrystalFrontAgent + RNDModel + RunningMeanStd
│   │   ├── train.py                    # PPO loop (curriculum + GPU + forcing + RND fade)
│   │   └── league.py                   # PFSP sampling — not activated for production
│   ├── eval/
│   │   └── eval_checkpoint.py          # Win-rate table generator
│   ├── export_onnx.py                  # PyTorch → ONNX (dynamo exporter, _OnnxWrapper)
│   ├── test_onnx_parity.py             # ONNX vs PyTorch parity check
│   ├── diagnose_policy.py              # NEW v0.4.0-ML — per-episode action histogram CSV
│   ├── bc_pretrain.py                  # Behaviour cloning warmup
│   ├── test_env.py                     # End-to-end smoke test
│   └── requirements.txt
│
├── replays/                            # Saved match replays (gitignored)
├── runs/                               # TensorBoard logs (gitignored)
├── checkpoints/                        # Policy checkpoints (gitignored)
│
└── docs/
    ├── ML_BOT_ACTION_PLAN.md           # Project history + handoff (read first)
    ├── ML_AGENT.md                     # This file (technical reference)
    ├── RELEASE_NOTES_v0.3.2-ML.md      # Shipped release notes
    ├── eval_v0.3.2-ML.txt              # Captured eval output (u150)
    ├── diag_u150_rwm.csv               # Diagnostic CSV (rush_weak_medium)
    └── diag_u150_rm.csv                # Diagnostic CSV (rush_medium)
```

---

## See also

- **`ML_BOT_ACTION_PLAN.md`** — project history, current handoff state, decisions, full development diary (chronological).
- **`RELEASE_NOTES_v0.3.2-ML.md`** — shipped release notes with empirical win-rate table.
- **`CrystalFront_ML_Review.md`** *(root of repo)* — three independent technical reviews; the source of the Option α / β / γ taxonomy.
