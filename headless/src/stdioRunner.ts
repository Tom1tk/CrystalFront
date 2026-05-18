#!/usr/bin/env tsx
/**
 * Headless stdio runner — the Node subprocess that the Python PPO trainer drives.
 *
 * Newline-delimited JSON protocol:
 *
 *   Python → Node
 *     { "type": "reset",  "seed": number,  "opponent": "idle|rush|turtle|macro",
 *                         "save_replay": false }
 *     { "type": "step",   "action": number }   ← blue's discrete action index (0–72)
 *     { "type": "close" }
 *
 *   Node → Python
 *     { "type": "ready",       "obs": PlayerObservation, "legalMask": boolean[73] }
 *     { "type": "step_result", "obs": ..., "legalMask": ...,
 *                               "reward": number, "done": boolean,
 *                               "info": { "ticks": number,
 *                                         "winner"?: string, "winType"?: string,
 *                                         "seed"?: number, "replayPath"?: string } }
 *     { "type": "error",       "message": string }
 *
 * Blue  = policy agent (actions controlled by Python).
 * Red   = scripted opponent (controlled here by the chosen bot).
 */

import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirnameHere = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(resolve(__dirnameHere, "../../package.json"), "utf8"));
const GAME_VERSION: string = _pkg.version ?? "unknown";
import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { PlayerSlot, MatchState, MatchEntity } from "../../server/src/match/types.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";
import { indexToAction, legalMask as buildLegalMask } from "./actionIndex.js";
import { IdleBot, RushBot, WeakRushBot, MediumRushBot, PassiveBot, TurtleBot, MacroBot, HeavyBot } from "./bots/index.js";
import { ECONOMY, UNIT_DEFS, BUILDING_DEFS } from "@crystalfront/shared";
import type { Agent, PlayerObservation } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const REPLAYS_DIR = resolve(REPO_ROOT, "replays");

const BLUE_ID        = "headless-blue";
const RED_ID         = "headless-red";
const CRYSTAL_MAX_HP = 1000;
// Shortened for training: forces decisive play and reduces terminal-signal discount.
// The live server still runs to 6000; this constant only applies to the headless runner.
const MAX_TICKS      = 3000;

// ── helpers ──────────────────────────────────────────────────────────────────

let currentOpponentName = "macro";

function makeBot(name?: string): Agent {
  const key = (name ?? "macro").toLowerCase();
  currentOpponentName = key;
  switch (key) {
    case "idle":        return new IdleBot();
    case "rush":        return new RushBot();
    case "rush_weak":   return new WeakRushBot();
    case "rush_medium": return new MediumRushBot();
    case "passive":     return new PassiveBot();
    case "turtle":      return new TurtleBot();
    case "macro":       return new MacroBot();
    case "heavy":       return new HeavyBot();
    default:            return new MacroBot();
  }
}

// Phase C: restrict build actions to barracks only during training.
// bld has 12 variants (4 buildings × 3 zones) vs train's 4 variants.
// Without restriction the agent drowns train actions in bld probability mass.
// Remove this filter in Phase D when the agent needs to learn full build menu.
import type { MacroAction } from "./types.js";
function phaseLegal(legal: MacroAction[]): MacroAction[] {
  return legal.filter(a => a.type !== "build" || a.buildingType === "barracks");
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ── per-episode milestone state ───────────────────────────────────────────────

interface Milestones {
  hasBuiltBarracks: boolean;
  hasTrainedCombatUnit: boolean;
  hasCombatUnitCrossedMidfield: boolean;
  hasDealtCrystalDamage: boolean;
  hasBuiltTurret: boolean;
  hasOwnCrystalTakenHit: boolean;
  firstBarracksTick: number;
  firstCombatUnitTick: number;
  firstAttackTick: number;
  // Reactive behaviour tracking
  hasSeenEnemyCombat: boolean;
  firstEnemyCombatTick: number;
  hasReactiveBarracks: boolean;   // built barracks within 400 ticks of seeing enemy combat
  // Crystal damage milestones (tracked via min opp crystal health seen)
  minOppCrystalHealthFrac: number;
  dealtDmg25pct: boolean;
  dealtDmg50pct: boolean;
  dealtDmg90pct: boolean;
  // Scouting: one reward per discovered enemy entity id (persists entire episode)
  discoveredEntityIds: Set<string>;
}

function freshMilestones(): Milestones {
  return {
    hasBuiltBarracks: false,
    hasTrainedCombatUnit: false,
    hasCombatUnitCrossedMidfield: false,
    hasDealtCrystalDamage: false,
    hasBuiltTurret: false,
    hasOwnCrystalTakenHit: false,
    firstBarracksTick: -1,
    firstCombatUnitTick: -1,
    firstAttackTick: -1,
    hasSeenEnemyCombat: false,
    firstEnemyCombatTick: -1,
    hasReactiveBarracks: false,
    minOppCrystalHealthFrac: 1.0,
    dealtDmg25pct: false,
    dealtDmg50pct: false,
    dealtDmg90pct: false,
    discoveredEntityIds: new Set<string>(),
  };
}

let milestones: Milestones = freshMilestones();

function computeReward(
  prev: PlayerObservation,
  curr: PlayerObservation,
  done: boolean,
  winner: string | null,
  winType: string | null
): number {
  let r = 0;

  // ── Crystal damage dealt / taken ──────────────────────────────────────────
  // Raised 0.0008 → 0.005 so crystal pressure dominates economy shaping.
  if (prev.global.oppCrystalHealthFrac > 0) {
    const delta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (delta > 0) r += 0.005 * delta * CRYSTAL_MAX_HP;
  }
  const ownDelta = prev.global.ownCrystalHealthFrac - curr.global.ownCrystalHealthFrac;
  if (ownDelta > 0) r -= 0.002 * ownDelta * CRYSTAL_MAX_HP;

  // ── Mining (lifetime resources) ───────────────────────────────────────────
  // Near-zeroed: at 0.000025 this gave +150/episode for gathering, completely
  // dominating all combat signals. Reduced 25× to avoid poisoning the gradient.
  const miningDelta = curr.global.ownLifetimeResourcesFrac - prev.global.ownLifetimeResourcesFrac;
  if (miningDelta > 0) r += 0.000001 * miningDelta * (ECONOMY.passiveWinThreshold * 2);

  // ── Gathering reward ──────────────────────────────────────────────────────
  // Halved from 0.0005.
  const gatheringWorkers = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex === 1 && e.isGathering
  ).length;
  r += 0.00025 * gatheringWorkers;

  // ── Supply advantage ──────────────────────────────────────────────────────
  // Halved from 0.0001.
  r += 0.00005 * (curr.global.ownSupply - curr.global.oppVisibleSupply);

  // ── Kill / death signals ──────────────────────────────────────────────────
  const enemyWorkersPrev = prev.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersCurr = curr.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersKilled = Math.max(0, enemyWorkersPrev - enemyWorkersCurr);

  const oppSupplyDelta = prev.global.oppVisibleSupply - curr.global.oppVisibleSupply;
  const combatKillDelta = Math.max(0, oppSupplyDelta - enemyWorkersKilled);
  if (combatKillDelta    > 0) r += 0.3  * combatKillDelta;
  if (enemyWorkersKilled > 0) r += 0.15 * enemyWorkersKilled;

  const ownWorkersPrev = prev.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersCurr = curr.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersLost = Math.max(0, ownWorkersPrev - ownWorkersCurr);
  if (ownWorkersLost > 0) r -= 0.1 * ownWorkersLost;

  // ── Combat engagement reward (B8) ────────────────────────────────────────
  // Reward units that are in weapon range of an enemy AND attacking — not just
  // any unit with attackTargetId set (which can be set without being in range).
  const unitsInRangeAndAttacking = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 5 && e.inAttackRange && e.isAttacking
  ).length;
  if (unitsInRangeAndAttacking > 0) r += 0.001 * unitsInRangeAndAttacking;

  // ── Combat unit behaviour ─────────────────────────────────────────────────
  const ownCombat = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4
  ).length;

  // Standing force: 10× boosted so training units is clearly better than not training.
  // Math: at gamma=0.995, idle unit gives net +0.005-0.001=+0.004/tick discounted
  // value ≈ +0.8 over a full episode — outweighs any opportunity cost of training.
  r += 0.005 * Math.min(ownCombat, 5);

  // Idle combat unit penalty: units clustering at barracks.
  const idleCombatUnits = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4 && !e.isAttacking && !e.isMoving
  ).length;
  if (idleCombatUnits > 0) r -= 0.001 * idleCombatUnits;

  // ── Weapon-range-proximity reward (B1 — replaces forward_pressure) ────────
  // Reward per own combat unit that has a visible enemy within its weapon range.
  // This rewards *being in position to fight*, not just map position.
  // Result: policy learns to move toward enemies rather than to static map zones.
  const unitsInRange = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4 && e.inAttackRange
  ).length;
  if (unitsInRange > 0) r += 0.002 * unitsInRange;

  // ── Enemy-threat reactive signals ─────────────────────────────────────────
  const enemyCombat = curr.entities.filter(e => e.owner === -1 && e.typeIndex >= 2 && e.typeIndex <= 5).length;

  if (enemyCombat > 0) {
    if (ownCombat > 0) {
      r += 0.0005 * Math.min(ownCombat, enemyCombat);
    } else {
      r -= 0.001 * enemyCombat;
    }
  }

  // Outgunned penalty (B2): keep the army-gap penalty but remove the exposed-units
  // term that conflicted with the proximity reward and caused oscillation.
  const armyGap = enemyCombat - ownCombat;
  if (armyGap > 2) {
    r -= 0.0003 * (armyGap - 2);
  }

  // ── Distress + retaliation (B3) ───────────────────────────────────────────
  // Fires when: crystal is hit, workers are dying, OR enemy combat is in our half.
  // This means the agent gets a gradient to respond BEFORE the crystal is hit,
  // as soon as visible threats cross midfield.
  const enemyInOwnHalf = curr.global.enemyCombatInOwnHalf > 0;
  const underAttack = ownDelta > 0 || ownWorkersLost > 0 || enemyInOwnHalf;
  if (underAttack) {
    const fightingBack = curr.entities.filter(
      e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 5 && e.isAttacking
    ).length;
    if (fightingBack > 0) {
      r += 0.006 * fightingBack;
    } else {
      r -= 0.003;  // threats visible, nothing fighting back
    }
  }

  // ── Survival reward (B6) ──────────────────────────────────────────────────
  // Fires whenever enemy combat is visible (not gated to tick > 1500).
  // Earlier trigger means the gradient exists during the rush's opening phase,
  // not just after the game is already decided.
  if (enemyCombat > 0) {
    r += 0.001 * curr.global.ownCrystalHealthFrac;
  }

  // ── Worker behaviour ──────────────────────────────────────────────────────
  const idleWorkers = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex === 1 && !e.isGathering
  ).length;
  if (idleWorkers > 0) r -= 0.003 * idleWorkers;

  // ── Defenseless trickle (B5) ──────────────────────────────────────────────
  // After tick 150, the agent should have the basic economy to start a barracks.
  // If it still has no barracks and no combat units, charge a small per-tick
  // penalty — creates a gradient toward proactive military build without
  // requiring the agent to see the enemy first.
  if (curr.tick > 150 && !milestones.hasBuiltBarracks && ownCombat === 0) {
    r -= 0.002;
  }

  // ── Abandoned-building penalty ────────────────────────────────────────────
  const prevBuildFracById = new Map(prev.entities
    .filter(e => e.owner === 1 && e.typeIndex >= 6 && e.typeIndex <= 9)
    .map(e => [e.id, e.constructionFrac])
  );
  for (const e of curr.entities) {
    if (e.owner !== 1 || e.typeIndex < 6 || e.typeIndex > 9) continue;
    if (e.constructionFrac <= 0 || e.constructionFrac >= 1) continue;
    const prevFrac = prevBuildFracById.get(e.id);
    if (prevFrac !== undefined && e.constructionFrac <= prevFrac) {
      r -= 0.002;
    }
  }

  // ── Supply depot headroom penalty ─────────────────────────────────────────
  const completedDepots = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex === 8 && e.constructionFrac >= 1
  ).length;
  if (completedDepots > 0) {
    const usedSupply = curr.global.ownSupply * curr.global.ownMaxSupply;
    const headroom = curr.global.ownMaxSupply - usedSupply;
    if (headroom > 1) r -= 0.001 * (headroom - 1);
  }

  // ── Time penalty ─────────────────────────────────────────────────────────
  r -= 0.00005;

  // ── One-time milestone bonuses ────────────────────────────────────────────

  if (!milestones.hasBuiltBarracks) {
    // Fire on BUILD START (when the entity first appears), not on completion.
    // At gamma=0.995 the discounted value of a tick-0 bonus is 1.0×; at tick 200 it's 0.37×.
    // Previously fired at completion (~150 ticks later), making the discounted value ~50× smaller.
    const hadBarracks = prev.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const hasBarracks = curr.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    if (!hadBarracks && hasBarracks) {
      const earlyBonus = 2.0 * Math.max(0, (600 - curr.tick) / 600);
      r += 0.5 + earlyBonus;
      milestones.hasBuiltBarracks = true;
      milestones.firstBarracksTick = curr.tick;
    }
  }

  if (!milestones.hasBuiltTurret) {
    const hadTurret = prev.entities.some(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1);
    const hasTurret = curr.entities.some(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1);
    if (!hadTurret && hasTurret) {
      r += 0.5;
      milestones.hasBuiltTurret = true;
    }
  }

  // Barracks-idle trickle: once a barracks is complete and no combat units exist yet,
  // penalise every tick. Boosted 0.003→0.015 to create stronger pressure to train.
  // Fires only on COMPLETED barracks so the agent can't escape it by cancelling construction.
  if (milestones.hasBuiltBarracks && !milestones.hasTrainedCombatUnit && ownCombat === 0) {
    const completedBarracks = curr.entities.some(
      e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1
    );
    if (completedBarracks) r -= 0.015;
  }

  if (!milestones.hasTrainedCombatUnit) {
    const combatPrev = prev.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
    const combatCurr = curr.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
    if (combatCurr > combatPrev) {
      // 5× boost: discounted value at tick 100 ≈ +30.5 — must dominate bld's +2.5 gradient.
      // Expected value of train chain: +2.5 (bld) + 30.5 (first unit) = +33 vs bld-only = +1.9.
      r += 50.0;
      milestones.hasTrainedCombatUnit = true;
      milestones.firstCombatUnitTick = curr.tick;
    }
  }

  if (milestones.hasTrainedCombatUnit && !milestones.hasCombatUnitCrossedMidfield) {
    const crossedMid = curr.entities.some(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4 && e.xNorm > 0.5);
    if (crossedMid) {
      r += 3.0;
      milestones.hasCombatUnitCrossedMidfield = true;
    }
  }

  if (!milestones.hasDealtCrystalDamage && prev.global.oppCrystalHealthFrac > 0) {
    const dmgDelta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (dmgDelta > 0) {
      // Raised 1.0 → 3.0: first crystal hit has never been seen; make it unmissable.
      r += 3.0;
      milestones.hasDealtCrystalDamage = true;
      milestones.firstAttackTick = curr.tick;
    }
  }

  // ── Crystal damage depth milestones ──────────────────────────────────────
  // Track minimum enemy crystal health seen; fire irreversible bonuses at thresholds.
  // Guard: oppCrystalHealthFrac is 0 when the enemy crystal is not yet visible (fog of war).
  // Only update the minimum when the crystal is actually visible.
  if (curr.global.oppCrystalHealthFrac > 0 &&
      curr.global.oppCrystalHealthFrac < milestones.minOppCrystalHealthFrac) {
    milestones.minOppCrystalHealthFrac = curr.global.oppCrystalHealthFrac;
  }
  if (!milestones.dealtDmg25pct && milestones.minOppCrystalHealthFrac <= 0.75) {
    r += 1.0;
    milestones.dealtDmg25pct = true;
  }
  if (!milestones.dealtDmg50pct && milestones.minOppCrystalHealthFrac <= 0.5) {
    r += 2.0;
    milestones.dealtDmg50pct = true;
  }
  if (!milestones.dealtDmg90pct && milestones.minOppCrystalHealthFrac <= 0.1) {
    r += 5.0;
    milestones.dealtDmg90pct = true;
  }

  if (!milestones.hasOwnCrystalTakenHit && curr.global.ownCrystalHealthFrac <= 0.95) {
    r -= 0.5;
    milestones.hasOwnCrystalTakenHit = true;
  }

  if (!milestones.hasSeenEnemyCombat && enemyCombat > 0) {
    milestones.hasSeenEnemyCombat = true;
    milestones.firstEnemyCombatTick = curr.tick;
  }

  // Reactive barracks: bonus for building barracks near the time of first seeing enemy.
  if (!milestones.hasReactiveBarracks && milestones.hasBuiltBarracks && milestones.hasSeenEnemyCombat) {
    const lag = milestones.firstBarracksTick - milestones.firstEnemyCombatTick;
    if (lag >= -400 && lag <= 200) {
      r += 1.5;
      milestones.hasReactiveBarracks = true;
    }
  }

  // ── Scouting / fog-of-war discovery reward ────────────────────────────────
  for (const e of curr.entities) {
    if (e.owner !== -1) continue;
    if (milestones.discoveredEntityIds.has(e.id)) continue;
    milestones.discoveredEntityIds.add(e.id);
    if (e.typeIndex === 0) {
      r += 2.0;  // enemy crystal
    } else if (e.typeIndex === 1) {
      r += 0.15; // enemy worker
    } else if (e.typeIndex >= 2 && e.typeIndex <= 5) {
      r += 0.4;  // enemy combat unit
    } else if (e.typeIndex === 6 || e.typeIndex === 7) {
      r += 1.0;  // enemy barracks/foundry
    } else if (e.typeIndex === 8 || e.typeIndex === 9) {
      r += 0.5;  // enemy depot/turret
    }
  }

  // ── Scout positioning reward ──────────────────────────────────────────────
  const forwardScouts = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex === 2 && e.xNorm > 0.65
  ).length;
  if (forwardScouts > 0) r += 0.0004 * Math.min(forwardScouts, 2);

  // ── Terminal rewards ──────────────────────────────────────────────────────
  // Tripled to ±30 so the win/loss signal dominates all intermediate shaping.
  // Resource win stays at +3.0 (vs combat win +30) — economy path viable but
  // no longer rational when combat is available.
  if (done) {
    if (winner !== null) {
      if (winner === BLUE_ID) {
        // Economy win is treated the same as a loss — agent must fight to earn reward.
        r += winType === "resource" ? -30.0 : 30.0;
      } else {
        r += -30.0;
      }
    } else {
      r -= 30.0; // timeout / draw
    }
  }

  return r;
}

// ── match state ──────────────────────────────────────────────────────────────

let engine: MatchEngine | null = null;
let match: MatchState | null = null;
let redBot: Agent | null = null;
let prevBlueObs: PlayerObservation | null = null;
let saveReplay = false;
let commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }> = [];

function handleReset(seed?: number, opponent?: string, doSave = false): void {
  milestones = freshMilestones();
  engine   = new MatchEngine();
  saveReplay = doSave;

  const effectiveSeed = (seed != null && isFinite(seed)) ? seed : Math.floor(Math.random() * 0xffffffff);

  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: BLUE_ID, username: "Blue", color: "blue", score: 0 },
    { playerId: RED_ID,  username: "Red",  color: "red",  score: 0 },
  ];

  // Training overrides — not used in the live game.
  // Phase C (vs passive_bot, full build chain, intermediate map):
  //   No pre-placed units or buildings. Agent must discover the full chain:
  //   build_barracks (150 ticks) → train_skirmisher (80 ticks) → attack_move → win.
  //   mapWidth=1000, crystalHealth=100. gamma^323≈0.20 → terminal +6.0 at tick 0.
  //   startingResources=500: prevents resource starvation after building spree.
  //   With 200, agent could spend all 200 on buildings in first 3 ticks, leaving
  //   resources=0 when barracks completes → train_skirmisher illegal (costs 50).
  const TRAINING_CONFIG = {
    ...DEFAULT_CONFIG,
    startingResources:     500,
    passiveWinThreshold:   999999,
    startingMaxSupply:      15,
    mapWidth:               1000,
    mapHeight:              600,
    crystalHealth:           100,
  };
  match = engine.createMatch("headless", players, TRAINING_CONFIG, effectiveSeed);
  engine.startMatch(match.id);

  redBot = makeBot(opponent);
  redBot.init(RED_ID, match);

  commandLog = [];
  const obs  = buildObservation(match, BLUE_ID);
  const legal = phaseLegal(getLegalActions(match, BLUE_ID));
  prevBlueObs = obs;

  send({ type: "ready", obs, legalMask: buildLegalMask(legal) });
}

function handleStep(actionIdx: number): void {
  if (!engine || !match || !redBot || !prevBlueObs) {
    send({ type: "error", message: "Not initialized — send 'reset' first" });
    return;
  }
  if (match.phase !== "playing") {
    send({ type: "error", message: "Match is not playing" });
    return;
  }

  // Apply blue's action
  const macroAction = indexToAction(actionIdx);
  const blueCmds = expandMacroAction(macroAction, match, BLUE_ID);
  for (const cmd of blueCmds) {
    const result = engine.processCommand(match.id, BLUE_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);
    if (result.success) {
      commandLog.push({ tick: match.tick, playerId: BLUE_ID, command: cmd as Record<string, unknown> });
    }
  }

  // Apply red scripted bot
  const redObs   = buildObservation(match, RED_ID);
  const redLegal = getLegalActions(match, RED_ID);
  const redActions = redBot.step(redObs, redLegal);
  for (const ra of redActions) {
    const redCmds = expandMacroAction(ra, match, RED_ID);
    for (const cmd of redCmds) {
      const result = engine.processCommand(match.id, RED_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);
      if (result.success) {
        commandLog.push({ tick: match.tick, playerId: RED_ID, command: cmd as Record<string, unknown> });
      }
    }
  }

  // Advance simulation
  engine.tick(match.id);

  const done   = match.phase !== "playing" || match.tick >= MAX_TICKS;
  const winner = match.result?.winner ?? null;
  const winType = (match.result?.winType ?? null) as string | null;

  const blueObs = buildObservation(match, BLUE_ID);
  const reward  = computeReward(prevBlueObs, blueObs, done, winner, winType);
  prevBlueObs   = blueObs;

  const legal = phaseLegal(getLegalActions(match, BLUE_ID));
  const info: Record<string, unknown> = { ticks: match.tick };

  if (done) {
    info.winner  = winner;
    info.winType = winType;
    info.seed    = match.seed;
    info.firstBarracksTick   = milestones.firstBarracksTick;
    info.firstCombatUnitTick = milestones.firstCombatUnitTick;
    info.firstAttackTick     = milestones.firstAttackTick;
    info.entitiesDiscovered  = milestones.discoveredEntityIds.size;

    // Optionally save replay
    if (saveReplay) {
      const ts = Date.now();
      if (!existsSync(REPLAYS_DIR)) mkdirSync(REPLAYS_DIR, { recursive: true });
      const path = resolve(REPLAYS_DIR, `${ts}-${match.seed}.json`);
      const payload = {
        version:      GAME_VERSION,
        seed:         match.seed,
        blue:         "ppo_agent",
        red:          currentOpponentName,
        bluePlayerId: BLUE_ID,
        redPlayerId:  RED_ID,
        outcome:      { winner, winType, ticks: match.tick },
        commandLog,
        timestamp:    ts,
      };
      writeFileSync(path, JSON.stringify(payload));
      info.replayPath = path;
    }

    engine.destroyMatch(match.id);
    match   = null;
    redBot  = null;
  }

  send({ type: "step_result", obs: blueObs, legalMask: buildLegalMask(legal), reward, done, info });
}

// ── main loop ─────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    switch (msg.type) {
      case "reset":
        handleReset(msg.seed, msg.opponent, msg.save_replay === true);
        break;
      case "step":
        handleStep(msg.action as number);
        break;
      case "close":
        process.exit(0);
        break;
      default:
        send({ type: "error", message: `Unknown message type: ${msg.type}` });
    }
  } catch (e) {
    send({ type: "error", message: `Parse error: ${(e as Error).message}` });
  }
});

rl.on("close", () => process.exit(0));
