/**
 * Balance snapshots for each game version.
 *
 * When replaying a saved match, the engine uses the snapshot for that
 * replay's version instead of the current live values.  This ensures
 * old replays remain accurate even after balance patches.
 *
 * Add a new entry here whenever a balance-affecting value changes.
 * Keys must match the version strings in package.json / replay files.
 */
export const BALANCE_HISTORY = {
    // ── 0.1.75-ML ──────────────────────────────────────────────────────────
    // Phase C v8: resume from 0.1.74 update_000010 (peak policy: win_rate=86%, trn=1%).
    // ent_coef 0.10→0.03: low entropy locks in the discovered build→train→attack policy
    // and prevents oscillation from V(s) lag (policy drifted back to bld=40-50% each cycle).
    "0.1.75-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.74-ML ──────────────────────────────────────────────────────────
    // Phase C v7: first_combat_unit +50, barracks-idle -0.015. Oscillated 20-86%.
    // V(s) lag: high V after wins made A(train)<0, trn→0% every 12 updates.
    // Best policy at update 10 (86% win, trn=1%) used as Phase C v8 seed.
    "0.1.74-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.73-ML ──────────────────────────────────────────────────────────
    // Phase C v6: build zone bug fixed. Reached 82% win_rate at update 7 then collapsed.
    // bld gradient (25% freq, +2.5 immediate) dominated trn (1% freq, +10 delayed).
    "0.1.73-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.72-ML ──────────────────────────────────────────────────────────
    // Phase C v5: all builds used MAP.width=6000 for positions — all silently failed.
    "0.1.72-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.71-ML ──────────────────────────────────────────────────────────
    // Phase C v4: startingResources=500. Brief win_rate=0.75 at update 8 then collapse.
    // trn peaked at 1% (update 8) then fell to 0%. Resources fixed but bld ratio wrong.
    "0.1.71-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.70-ML ──────────────────────────────────────────────────────────
    // Phase C v3: from scratch, ent_coef=0.10, startingResources=200. Same collapse.
    // trn=0%: train_skirmisher was ILLEGAL when barracks completed (resources=0).
    "0.1.70-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.69-ML ──────────────────────────────────────────────────────────
    // Phase C v2: barracks-idle penalty + first_combat_unit +10.0. Still collapsed.
    // Root cause: ent_coef=0.04 + Phase B checkpoint = trn=0% throughout.
    "0.1.69-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.68-ML ──────────────────────────────────────────────────────────
    // Phase C v1: full build chain, no scaffold. Collapsed same way as 0.1.66.
    // bld=70%, trn=0%, win_rate=0.44→collapse. Missing barracks→train bridge.
    "0.1.68-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.67-ML ──────────────────────────────────────────────────────────
    // Phase B v2: pre-placed barracks (fully built). Removes build credit chain.
    // Agent must discover train_skirmisher → attack_move to win.
    // mapWidth=1000, crystalHealth=100, passive_bot. ent_coef=0.04.
    // Resumes from Phase A checkpoint (0.1.65-ML update 5, 100% win rate).
    "0.1.67-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.66-ML ──────────────────────────────────────────────────────────
    // Phase B v1: removed pre-placed skirmishers, build chain now required.
    // Collapsed to bld=78%, trn=0%, win_rate→0.04 — build→train credit gap too large.
    "0.1.66-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.65-ML ──────────────────────────────────────────────────────────
    // Phase A v2: pre-place 3 skirmishers for blue at match start (stdioRunner.ts).
    // Removes build+train credit chain entirely. Agent learns attack_move → win.
    // Episode reward: win=+62, lose with idle skirmishers=+14 → gap=+48.
    // Win at tick ~70 (skirmisher auto-attacks crystal 160px away), gamma^70=0.70,
    // terminal +21 at tick 0. mapWidth=500, crystalHealth=50, idle_bot.
    // Phase B: remove pre-placed skirmishers, mapWidth=6000, crystalHealth=1000, passive_bot.
    "0.1.65-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.64-ML ──────────────────────────────────────────────────────────
    // Phase A curriculum: mapWidth 6000→500, crystalHealth 1000→50 (TRAINING_CONFIG).
    // At full 6000px map, gamma^2468≈4.5e-6 made terminal invisible at decision point.
    // At 500px map + 50HP crystal: workers arrive at tick ~147, win at tick ~175,
    // gamma^175≈0.42 → terminal contributes +12.5 at tick 0 (clearly positive gradient).
    // Also: mining reward cut 25× (0.000025→0.000001) — previously +150/episode for
    // pure gathering dominated all combat signals. Agent's atk_mv=25-43% already wins.
    "0.1.64-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.63-ML ──────────────────────────────────────────────────────────
    // Curriculum Phase A: mapWidth 6000→3500 (TRAINING_CONFIG only). Workers at
    // 1.7px/tick reach enemy crystal in ~1912 ticks on 3500px map — the agent's
    // existing atk_mv=25-34% worker-attack strategy already wins on this map vs
    // idle_bot (no skirmisher defenders). Generates first +30 terminals to anchor
    // value head. Opponent: idle_bot (workers only, no barracks/combat units).
    // After win_rate>60%, advance Phase B: revert mapWidth to 6000 + passive_bot
    // (skirmisher defenders now require actual combat units to beat).
    "0.1.63-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.62-ML ──────────────────────────────────────────────────────────
    // ROOT CAUSE FIX: startingResources 50→200 (training only). At 50 resources,
    // `build barracks` (75) is illegal at tick 0; the ONLY legal train action was
    // `train_worker` (50), so trn=1% was 100% worker training, never reaching
    // train_unit. At 200, barracks is affordable from tick 0 → build barracks is
    // in legal mask immediately → after ~100 ticks barracks completes → train_unit
    // becomes legal. passiveWinThreshold 4500→999999 (training) prevents economy
    // wins ending 3000-tick episodes before trained units can be used.
    // startingMaxSupply 10→15: supports 12 units before depot needed.
    "0.1.62-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500, // live game unchanged; training uses 999999
    },
    // ── 0.1.61-ML ──────────────────────────────────────────────────────────
    // Root-cause fix for trn=0% collapse: standing_force 0.0005→0.005/tick (10×),
    // cap raised 3→5 units. first_combat_unit milestone 0.5→5.0. midfield-crossing
    // 0.5→3.0. Discounted value of training 1 idle skirmisher at tick 200 now
    // ≈+2.1 at decision point (was +0.085) — gradient clearly positive for training.
    // Fresh start from random weights vs passive_bot.
    "0.1.61-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.60-ML ──────────────────────────────────────────────────────────
    // Curriculum: passive_bot (builds workers + barracks + 2 skirmishers, never attacks).
    // Reward overhaul: crystal-damage shaping ×6.25 (0.0008→0.005), gathering/mining/
    // supply-advantage/standing-force all halved. First-crystal-hit milestone +1.0→+3.0.
    // Crystal-damage depth milestones: +1/+2/+5 at 25/50/90% damage. Terminal ±10→±30.
    // MAX_TICKS 6000→3000 (training only). ent_coef raised to 0.08 during passive phase.
    // Goal: generate first positive terminal (+30) to anchor value head.
    "0.1.60-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.59-ML ──────────────────────────────────────────────────────────
    // Reward: barracks milestone fires on BUILD START (entity appears) not
    // completion — brings reward 150 ticks closer to the decision point.
    // Training: gamma 0.99→0.995 doubles effective horizon (~100→~200 ticks),
    // making the time-decayed barracks bonus ~20× more influential at the
    // time of the build decision. Resumed from v0.1.58 final checkpoint.
    "0.1.59-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.58-ML ──────────────────────────────────────────────────────────
    // Balance: skirmisher → turret damage multiplier 1.0→2.0 (turret now uses
    // gunner counter table as defender — matches existing turret-as-gunner logic
    // for attacking). Prevents turret-spam from being a hard counter to skirmisher
    // rushes; forces the agent to use combat units for defense.
    // Training phase 2: rush_medium only, resumed from v0.1.57 checkpoint.
    "0.1.58-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.57-ML ──────────────────────────────────────────────────────────
    // Action space 37→58: attack_targeted×12, hold_position×1, new attack_move
    // zones×8 (enemy_army, defend_crystal). Obs GLOBAL_DIM 18→22 (+4 threat
    // geometry). ENTITY_DIM 11→12 (+inAttackRange). Engine: retreat keeps
    // auto-attack; commandedTicks 5→1. Reward: forward_pressure replaced by
    // weapon-range-proximity; barracks milestone time-decayed; defenseless trickle
    // -0.002/tick after tick 150; survival fires on any enemy combat visible;
    // resource win +2.5→+1.0. Curriculum: rush_weak+rush_medium. Phase 1: combat_weak.
    "0.1.57-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.56-ML ──────────────────────────────────────────────────────────
    // Survival reward: +0.003×crystalHealthFrac/tick when enemy combat visible
    // past tick 1500. ent_coef 0.02→0.08 for more exploration. Combat-only
    // training (rush+macro) resumed from v0.1.54 checkpoint. 30M steps.
    "0.1.56-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.55-ML ──────────────────────────────────────────────────────────
    // Resource win halved (+2.5). Idle combat unit penalty -0.001/tick.
    // Depth-scaled forward pressure reward (0→+0.0004 at crystal). Army
    // advantage commit (+0.001/forward unit when winning ≥3). Outgunned retreat
    // incentive (penalise forward units when losing ≥3). Combat-only training.
    "0.1.55-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.54-ML ──────────────────────────────────────────────────────────
    // Standing combat force +0.001/tick×min(units,3). Distress+retaliation:
    // +0.008/attacking unit when under attack, −0.004 if taking hits with no
    // defense. Crystal damage penalty 4×. Discovery rewards 2−4× higher.
    // Scout positioning +0.0004/tick per forward skirmisher (xNorm>0.65, cap 2).
    // RushBot push interval 15→25 ticks.
    "0.1.54-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.53-ML ──────────────────────────────────────────────────────────
    // Enemy-conditioned reactive rewards: per-tick reward for having own combat
    // when enemy combat visible (+0.0005×matched units), penalty for being
    // defenceless (-0.001×threat), outgunned penalty (-0.0003×gap>2), reactive
    // barracks milestone (+1.5 for building barracks in response to visible threat).
    "0.1.53-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.52-ML ──────────────────────────────────────────────────────────
    // Idle penalty 6× (-0.003/tick, same as v0.1.48 but isBuilding no longer
    // exempts). Gathering reward 5× (+0.0005/tick). Discounted cost of one
    // excess worker is now ~0.3, making 40 excess workers cost ~12 — enough
    // to overcome the +5 passive win terminal and deter excess training.
    "0.1.52-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.51-ML ──────────────────────────────────────────────────────────
    // CRITICAL FIX: isBuilding exemption removed from idle penalty. Gathering
    // is now the only productive worker state. Ends the depot/turret build-loop
    // exploit that persisted through v0.1.50.
    "0.1.51-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.50-ML ──────────────────────────────────────────────────────────
    // Reward: gathering bonus +0.0001/worker, kill rewards +3×, crystal dmg
    // +60%, abandoned-building penalty -0.002/tick stalled, combat engagement
    // +0.0002/attacking unit, scouting fog-of-war discovery rewards.
    "0.1.50-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.49-ML ──────────────────────────────────────────────────────────
    // Major overhaul: action space 73→37 (removed set_rally/noop/yZone/count
    // variants); reward shape: terminal dominates, one-time milestone bonuses,
    // combat win +10 vs resource win +5; 6 enemy composition features added to
    // observation; passiveWinThreshold 3000→4500; ent_coef 0.05→0.02; gamma
    // 0.995→0.99; mixed-opponent curriculum (--opponent random).
    "0.1.49-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 4500,
    },
    // ── 0.1.48-ML ──────────────────────────────────────────────────────────
    // Reward overhaul v2: removed forward-pressure reward (gameable); gathering
    // bonus removed; idle-worker penalty raised 6× (−0.003).  RushBot rewritten
    // to place one worker per node and double-barracks skirmisher spam.
    "0.1.48-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 3000,
    },
    // ── 0.1.43-ML ──────────────────────────────────────────────────────────
    // Initial ML branch balance.  Workers cheap/fast; skirmisher hits harder;
    // passive win threshold lower.
    "0.1.43-ML": {
        workerCost: 25,
        workerSpeed: 2.0,
        skirmisherSpeed: 2.5,
        skirmisherDamage: 15,
        passiveWinThreshold: 2500,
    },
    // ── 0.1.47-ML ──────────────────────────────────────────────────────────
    // Agent v2 clean start. Draw/timeout penalty carried forward from 0.1.46.
    "0.1.47-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 3000,
    },
    // ── 0.1.46-ML ──────────────────────────────────────────────────────────
    // Draw/timeout penalised identically to a loss (-10). Agent v2 fresh start.
    "0.1.46-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 3000,
    },
    // ── 0.1.45-ML ──────────────────────────────────────────────────────────
    // Reward-signal patch only (same unit stats as 0.1.44-ML).
    // Forward pressure reward, worker kill/death split, depot headroom penalty.
    "0.1.45-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 3000,
    },
    // ── 0.1.44-ML ──────────────────────────────────────────────────────────
    // Worker cost doubled to discourage idle-spam strategy.
    // Workers 15% slower, skirmishers 20% faster / 20% less damage (raiders).
    // Passive win threshold raised.
    "0.1.44-ML": {
        workerCost: 50,
        workerSpeed: 1.7,
        skirmisherSpeed: 3.0,
        skirmisherDamage: 12,
        passiveWinThreshold: 3000,
    },
};
/** Look up the balance snapshot for a given version string, or undefined if not registered. */
export function getBalanceForVersion(version) {
    return BALANCE_HISTORY[version];
}
