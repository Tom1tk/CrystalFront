# Crystal Front — ML Bot Action Plan

**Branch:** `CrystalFront-ML`
**Status:** Active training — Phase 0 curriculum (v0.2.3-ML, IdleBot, PID 671281, fresh start)
**Last updated:** 2026-05-19

---

## Development Diary

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
- Phase 0: `idle` opponent (IdleBot — never attacks, easy first target)
- 60 parallel envs, ent_coef=0.05, gamma=0.995
- Starting from scratch — no checkpoint (reward function incompatible with all prior runs)

**Phase 0 exit criteria (from PPO_AGENT_TRAINING_PHASES.md):**
- Combat win rate ≥ 85%
- First enemy crystal hit rate ≥ 90%
- Timeout rate ≤ 10%
- Episodes with 4+ combat units but 0 crystal damage ≤ 10%

**Early snapshots:**

| update | win_rate | cbt | tmt | crys_dmg | trn% | notes |
|--------|----------|-----|-----|----------|------|-------|
| 24 | 0.00 | 0.00 | 1.00 | 0% | 2% | Baseline (old run flush) — all timeouts, floor reward -120 confirmed |
| 47 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld 1%→4%, noop 94%→91%, no_pres=1% (first episode with 4+ units!) |
| 59 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld 13%, noop 79%, atk_mv 1%, no_pres=11% — build chain firing consistently! Units trained but not attacking yet. |
| ~80 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld 18%, noop 73%, atk_mv 2%, no_pres=22% — army building but not attacking. From TB during print-buffering period. |
| — | — | — | — | — | — | **Final config: num_steps=2048, ent_coef=0.10, total_timesteps=20M, save_interval=25. PID 587601, run crystalfront_ppo__0_2_0-ML__idle__1__1779126770. ~163 updates, ~20 eps/update, ~5.5h est.** |
| 6 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=9%, noop=85%, no_pres=7% |
| 12 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=15%, noop=79%, no_pres=7% |
| 15 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=17%, noop=77%, no_pres=6% |
| 21 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=26%, noop=67%, no_pres=6% — bld rising fast |
| 27 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=24%, noop=70%, no_pres=3% ⚠️ no_pres falling |
| 30 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=24%, noop=70%, no_pres=1% 🔴 near-zero. 60 replays saved. |
| 36 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=17%, noop=77%, no_pres=3% — stabilising |
| 42 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=16%, noop=78%, no_pres=3% |
| 50 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=17%, noop=77%, no_pres=4% — slow recovery |
| 56 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=16%, atk_mv=1%, no_pres=11% 🟡 RECOVERY — first attack moves! 120 replays saved. |
| 59 | 0.00 | 0.00 | 1.00 | 0% | 2% | bld=14%, atk_mv=0%, no_pres=9% — recovery holding, atk_mv flickering |
| — | — | — | — | — | — | **v0.2.1-ML restart. PID 602231, run crystalfront_ppo__0_2_1-ML__idle__1__1779136130, resumed from u75. Fixes: fightingBack→inAttackRange, approaching reward +0.0003, wrong-building penalty -0.003** |
| 6 (v0.2.1) | 0.00 | 0.00 | 1.00 | 0% | 1% | atk_mv=3%, no_pres=23% 🟢 Immediate improvement vs prior run |
| 12 | 0.00 | 0.00 | 1.00 | 0% | 1% | atk_mv=4%, no_pres=22%, bld=10% — stable |
| 15 | 0.00 | 0.00 | 1.00 | 0% | 2% | atk_mv=4%, no_pres=24%, bld=11% |
| 21 | 0.00 | 0.00 | 1.00 | 0% | 1% | atk_mv=5%, tgt=1%, no_pres=29% — tgt attacks emerging |
| 27 | 0.00 | 0.00 | 1.00 | 0% | 2% | atk_mv=5%, tgt=1%, no_pres=30% |
| 30 | 0.00 | 0.00 | 1.00 | 0% | 1% | atk_mv=8%, tgt=1%, no_pres=36% 🔥 Accelerating |
| 36 | 0.01 | 0.00 | 0.99 | 0% | 1% | atk_mv=9%, no_pres=40% — FIRST WIN (resource win, not combat). cbt=0.00. |
| 42 | 0.02 | 0.00 | 0.98 | 0% | 1% | atk_mv=17%, no_pres=61% 🚀 atk_mv surge. But crys_dmg=0% — units attacking but not reaching crystal. Resource wins only. |
| 44 | 0.00 | 0.00 | 1.00 | 0% | 2% | atk_mv=10%, no_pres=47% |
| 50 | 0.00 | 0.00 | 1.00 | 0% | 1% | atk_mv=15%, no_pres=49% |
| 56 | 0.00 | 0.00 | 1.00 | 0% | 1% | atk_mv=22%, no_pres=78% — accelerating hard |
| 59 | 0.00 | 0.00 | 1.00 | 0% | 1% | atk_mv=27%, no_pres=86% |
| 65 | 0.01 | 0.00 | 0.99 | 0% | 1% | atk_mv=30%, no_pres=89% 🔴 CONFIRMED EXPLOITATION. 30% attack-moves, 89% unit episodes, crys_dmg=0% throughout. Approaching reward driving oscillation — units bouncing between targets, never committing. 240 replays. |

---

### 2026-05-19 — v0.2.3-ML: Reward function overhaul (in progress, not yet launched)

**Training config:** PID 671281, run `crystalfront_ppo__0_2_3-ML__idle__1__1779183745`. Fresh start — no checkpoint (action space 58→66 is incompatible with all prior checkpoints). num_steps=512, num_envs=60, batch_size=30,720, total_timesteps=20M, ent_coef=0.10.

**Changes from v0.2.2-ML:**
- `actionSpace.ts`: `enemy_army` fallback midfield → enemy crystal position (bug fix)
- All 3 anti-passivity penalties removed
- Cross-midfield and enemy-quarter milestone rewards removed (tracking only)
- Removed: /tick in-range and in-range-attacking rewards
- Added: damage-dealt reward — `0.1 × healthFrac_delta` for units/workers, `0.05` for buildings
- Added: own building damage penalty — `−0.04 × healthFrac_delta` (slightly less than dealing to buildings)
- Added: map visibility reward — `visibleAreaFraction × 0.001` per tick (60×6 grid approximation, own unit vision radii)
- Worker kill: +0.15 → +0.20
- Own crystal damage penalty: −0.003 → −0.01 per HP (now symmetric with dealing damage)
- Removed: idle combat units penalty, barracks-idle penalty, reactive barracks reward

**v0.2.3-ML snapshots:**

| update | win_rate | cbt | tmt | ep_rew | atk_mv | noop | crys_dmg | no_pres | notes |
|--------|----------|-----|-----|--------|--------|------|----------|---------|-------|

---

### 2026-05-19 — v0.2.2-ML: Remove approaching reward + idle penalties, fix barracks milestone, add foundry milestone

**Context:** v0.2.1-ML confirmed exploitation of approaching reward (+0.0003/unit/tick). Removed it plus idle_worker_penalty and supply_headroom_waste to eliminate worker spam loop. Barracks milestone changed from time-decaying `1.5×max(0,(600-tick)/600)` to flat +3.0 (time-decay gave 0 reward when barracks built after tick 600). Added foundry milestone +2.0. Reverted to num_steps=512 (same as successful 0.1.xx runs). Resumed from v0.2.1-ML update_000075.

**Training config:** PID 615692, run `crystalfront_ppo__0_2_2-ML__idle__1__1779144843`, num_steps=512, num_envs=60, batch_size=30,720, total_timesteps=20M, ent_coef=0.10, save_interval=25, save_replay_every=10. ~651 updates total (resumed at step 9,216,000, ~351 remaining).

**v0.2.2-ML early snapshots:**

| update | win_rate | cbt | tmt | ep_rew | atk_mv | noop | crys_dmg | no_pres | notes |
|--------|----------|-----|-----|--------|--------|------|----------|---------|-------|
| 24 | 0.00 | 0.00 | 1.00 | -101.10 | 36% | 53% | 0% | 28% | First update logged. All timeouts, no wins. |
| 47 | 0.00 | 0.00 | 1.00 | -108.55 | 31% | 56% | 0% | 71% | no_pres rising rapidly — same pattern as v0.2.1 emerging |
| 59 | 0.00 | 0.00 | 1.00 | -99.87 | 41% | 45% | 0% | 94% | 🔴 no_pres=94%. Units being trained but not reaching crystal. |
| 83 | 0.00 | 0.00 | 1.00 | -101.45 | 45% | 37% | 0% | 99% | 🔴🔴 no_pres=99%. 13% through run. Midfield-attractor pattern confirmed. |
| 106 | 0.00 | 0.00 | 1.00 | -102.74 | 47% | 33% | 0% | 99% | atk_mv still climbing, noop falling, no recovery in crys_dmg |
| 118 | 0.00 | 0.00 | 1.00 | -101.45 | 52% | 25% | 0% | 99% | atk_mv=52%: agent spamming attack_move, never reaching crystal |
| 141 | 0.00 | 0.00 | 1.00 | -102.32 | 52% | 28% | 0% | 99% | No change |
| 165 | 0.00 | 0.00 | 1.00 | -99.26 | 54% | 28% | 0% | 100% | no_pres hits 100% |
| 176 | 0.00 | 0.00 | 1.00 | -94.34 | 59% | 24% | 0% | 100% | ep_rew improving slightly (milestone rewards accumulating), crys_dmg still 0% |
| 200 | 0.00 | 0.00 | 1.00 | -95.52 | 57% | 26% | 0% | 100% | Stable at bad local optimum |
| 223 | 0.00 | 0.00 | 1.00 | -100.22 | 58% | 25% | 0% | 100% | 34% through run. no_pres=100%, crys_dmg=0%. No recovery in sight. |
| 235 | 0.00 | 0.00 | 1.00 | -98.87 | 55% | 29% | 0% | 100% | No change |
| 258 | 0.00 | 0.00 | 1.00 | -98.37 | 58% | 26% | 0% | 100% | 40% through run. Fully stuck. |
| 282 | 0.00 | 0.00 | 1.00 | -94.95 | 62% | 22% | 0% | 100% | atk_mv climbing toward 62% |
| 293 | 0.00 | 0.00 | 1.00 | -92.42 | 60% | 23% | 0% | 100% | ep_rew improves slightly but crys_dmg still 0% |
| 317 | 0.00 | 0.00 | 1.00 | -96.13 | 62% | 22% | 0% | 100% | No change |
| 340 | 0.00 | 0.00 | 1.00 | -96.06 | 62% | 22% | 0% | 100% | No change |
| 352 | 0.00 | 0.00 | 1.00 | -95.62 | 62% | 23% | 0% | 100% | 54% through run. Fully converged to bad local optimum. |
| 375 | 0.00 | 0.00 | 1.00 | -94.54 | 61% | 22% | 0% | 100% | Flat |
| 399 | 0.00 | 0.00 | 1.00 | -95.99 | 62% | 21% | 0% | 100% | 61% through run. No change. |
| 411 | 0.00 | 0.00 | 1.00 | -94.83 | 63% | 21% | 0% | 100% | Flat |
| 434 | 0.00 | 0.00 | 1.00 | -94.74 | 61% | 22% | 0% | 100% | Flat |
| 458 | 0.00 | 0.00 | 1.00 | -95.26 | 62% | 21% | 0% | 100% | Flat |
| 469 | 0.00 | 0.00 | 1.00 | -96.55 | 63% | 21% | 0% | 100% | Flat |
| 493 | 0.00 | 0.00 | 1.00 | -95.78 | 61% | 22% | 0% | 100% | 76% through run. Completely stuck. |
| 516 | 0.00 | 0.00 | 1.00 | -96.32 | 63% | 21% | 0% | 100% | Flat |
| 528 | 0.00 | 0.00 | 1.00 | -95.54 | 63% | 20% | 0% | 100% | 81% through run. No change. |
| 551 | 0.00 | 0.00 | 1.00 | -95.73 | 64% | 20% | 0% | 100% | Flat |
| 575 | 0.00 | 0.00 | 1.00 | -94.29 | 64% | 20% | 0% | 100% | Flat |
| 586 | 0.00 | 0.00 | 1.00 | -93.97 | 63% | 21% | 0% | 100% | Flat |
| 610 | 0.00 | 0.00 | 1.00 | -96.76 | 63% | 21% | 0% | 100% | Flat |
| 633 | 0.00 | 0.00 | 1.00 | -95.22 | 64% | 20% | 0% | 100% | 97% through run. Final stretch — zero change across entire run. |
| 645 | 0.00 | 0.00 | 1.00 | -95.82 | 64% | 20% | 0% | 100% | Final logged update. Run ended at step 19,800,000. |

**Phase 0 verdict: FAILED**

| Criterion | Target | Final | Result |
|-----------|--------|-------|--------|
| cbt (combat win rate) | ≥ 0.85 | 0.00 | ❌ |
| crys_dmg | > 0% | 0% | ❌ |
| tmt (timeout rate) | ≤ 0.10 | 1.00 | ❌ |
| no_pres | ≤ 0.10 | 100% | ❌ |

**Post-mortem:**

The run completed all 651 updates (20M steps) without a single episode of crystal damage, no combat wins, and a 100% timeout rate. The policy converged fully to a bad local optimum by update 165 and never recovered.

**Trajectory summary:**

| Phase | Updates | no_pres | atk_mv | ep_rew | Description |
|-------|---------|---------|--------|--------|-------------|
| Early | u24–u59 | 28%→94% | 36%→41% | -101 | Rapid no_pres rise, exploring |
| Convergence | u83–u165 | 99%→100% | 45%→54% | -102→-99 | Locks into bad local optimum |
| Plateau | u165–u645 | 100% | 54%→64% | ~-95 | Fully stuck for 480 updates |

**Root cause (confirmed):**

Two interacting problems created an unescapable local optimum:

1. **`attack_move enemy_army` falls back to midfield.** When no enemy combat units are visible, `resolveTargetZone("enemy_army")` returns `{ x: mid, y: MAP.height/2 }`. Against IdleBot (which trains ZERO combat units ever), this means every `enemy_army` attack_move resolves to the exact centre of the map. The agent learned to use this action heavily.

2. **`hasForwardUnit` threshold xNorm > 0.45 creates a midfield attractor.** The anti-passivity army-idle penalty fires when `ownCombat >= 3` and no unit has `xNorm > 0.45`. A unit parked at xNorm ≈ 0.46–0.49 satisfies this check (avoiding the -0.002/tick penalty) but falls short of the midfield milestone threshold (xNorm > 0.50) and of the enemy quarter milestone (xNorm > 0.75). Forward progression milestones (+3 midfield, +3 enemy quarter, +5 crystal hit) were NEVER triggered in the entire 20M step run.

Result: the agent settled into building barracks/foundry, training a few units, moving them to xNorm ≈ 0.45, and looping. ep_rew stabilised at ~-95 = -100 terminal + ~+9 milestone shaping - ~-4 anti-passivity. This was the local optimum.

**Fixes required for v0.2.3-ML:**

1. **`actionSpace.ts`: Change `enemy_army` fallback from midfield → enemy_crystal.**
   `return { x: mid, y: MAP.height / 2 }` → `return { x: isBlue ? MAP.width - 100 : 100, y: MAP.height / 2 }`
   This removes the midfield attractor for this action.

2. **`stdioRunner.ts`: Raise `hasForwardUnit` threshold from xNorm > 0.45 → xNorm > 0.65.**
   Forces units to enter the enemy quarter before the army-idle penalty is relieved. Eliminates the stable parking spot between 0.45 and 0.5.

**Final checkpoint:** `checkpoints/crystalfront_ppo__0_2_2-ML__idle__1__1779144843/final.pt`

A running log of meaningful milestones, decisions, and pivots. Most recent first.

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
- ⚠️ No speed selector or jump-to-event in replay viewer

**Phase 2 — Specs (complete):**
- ✅ `docs/CRYSTALFRONT_OBS_SPEC.md`, `docs/CRYSTALFRONT_ACTION_SPEC.md`, `docs/CRYSTALFRONT_REWARD_SPEC.md`
- ✅ 391 passing tests (added determinism test)
- ⚠️ Reward spec may lag behind stdioRunner.ts (source of truth)

**Phase 3 — Python training harness (complete):**
- ✅ `training/env/crystalfront_env.py` (Gymnasium wrapper, 60 parallel Node sims)
- ✅ `training/ppo/train.py` (CleanRL-style PPO, TensorBoard, action histograms, checkpoint save/load)
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
- ✅ 8 scripted bots (IdleBot, RushBot, TurtleBot, MacroBot, HeavyBot, WeakRushBot, MediumRushBot, PassiveBot)
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

**Status (2026-05-18): ✅ Complete**
- ✅ `docs/CRYSTALFRONT_OBS_SPEC.md`, `docs/CRYSTALFRONT_ACTION_SPEC.md`, `docs/CRYSTALFRONT_REWARD_SPEC.md`
- ✅ 391 tests passing (added determinism test)
- ⚠️ Reward spec may lag stdioRunner.ts — source of truth is the code

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

**Status (2026-05-18): ✅ Complete**
- ✅ `training/env/crystalfront_env.py` — Gymnasium wrapper, 60 parallel Node sims
- ✅ `training/ppo/train.py` — CleanRL PPO, TensorBoard, action histograms, checkpoint save/load, `--save_replay_every`
- ✅ `training/ppo/policy.py` — Set-transformer over entity list, global concat, legal-action masking
- ✅ GPU training working (ROCm/CUDA)
- ✅ 0% win rate plateau broken — Phase A win_rate=1.00 (v0.1.65-ML), Phase B win_rate=1.00 (v0.1.67-ML)
- 🔄 Phase C (full build chain) oscillating 37-77% win rate — see diary for diagnosis

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

**Status (2026-05-18): ⚠️ Infrastructure half-done — blocked on Phase 4**
- ✅ `BotPlayer` in-process driver (`server/src/match/botPlayer.ts`) — takes any `Agent`, calls `.tick()` each game tick
- ✅ Difficulty selector in lobby UI (easy/medium/hard) wired into `START_SOLO_TEST`
- ✅ Easy/Medium/Hard currently serve scripted bots (IdleBot / MacroBot / RushBot)
- ❌ `training/eval/export_onnx.py` — not written
- ❌ ONNX policy loader in Node (`onnxruntime-node`) not implemented
- ❌ Trained policy cannot yet serve as the hard bot; all difficulty tiers are scripted

**What remains:** Once Phase C converges (stable >70% vs passive_bot), ONNX export + Node loader is ~2 days. Not worth starting until a policy worth shipping exists.

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
