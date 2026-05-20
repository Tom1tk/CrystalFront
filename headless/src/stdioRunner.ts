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
const MAX_TICKS      = 6000;

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

import type { MacroAction } from "./types.js";

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ── per-episode milestone state ───────────────────────────────────────────────

interface Milestones {
  hasBuiltBarracks: boolean;
  hasBuiltFoundry: boolean;
  firstFoundryTick: number;
  hasTrainedCombatUnit: boolean;
  hasThreeCombatUnits: boolean;
  hasCombatUnitCrossedMidfield: boolean;
  firstMidfieldCrossTick: number;
  hasEnteredEnemyQuarter: boolean;
  hasDealtCrystalDamage: boolean;
  hasBuiltTurret: boolean;
  hasOwnCrystalTakenHit: boolean;
  firstBarracksTick: number;
  firstCombatUnitTick: number;
  firstThreeCombatUnitsTick: number;
  firstAttackTick: number;
  firstEnemyQuarterEntryTick: number;
  // Reactive behaviour tracking
  hasSeenEnemyCombat: boolean;
  firstEnemyCombatTick: number;
  hasReactiveBarracks: boolean;
  // Crystal damage milestones (tracked via min health seen)
  minOppCrystalHealthFrac: number;
  minOwnCrystalHealthFrac: number;
  dealtDmg25pct: boolean;
  dealtDmg50pct: boolean;
  dealtDmg90pct: boolean;
  // Scouting: one reward per discovered enemy entity id (persists entire episode)
  discoveredEntityIds: Set<string>;
}

function freshMilestones(): Milestones {
  return {
    hasBuiltBarracks: false,
    hasBuiltFoundry: false,
    firstFoundryTick: -1,
    hasTrainedCombatUnit: false,
    hasThreeCombatUnits: false,
    hasCombatUnitCrossedMidfield: false,
    firstMidfieldCrossTick: -1,
    hasEnteredEnemyQuarter: false,
    hasDealtCrystalDamage: false,
    hasBuiltTurret: false,
    hasOwnCrystalTakenHit: false,
    firstBarracksTick: -1,
    firstCombatUnitTick: -1,
    firstThreeCombatUnitsTick: -1,
    firstAttackTick: -1,
    firstEnemyQuarterEntryTick: -1,
    hasSeenEnemyCombat: false,
    firstEnemyCombatTick: -1,
    hasReactiveBarracks: false,
    minOppCrystalHealthFrac: 1.0,
    minOwnCrystalHealthFrac: 1.0,
    dealtDmg25pct: false,
    dealtDmg50pct: false,
    dealtDmg90pct: false,
    discoveredEntityIds: new Set<string>(),
  };
}

let milestones: Milestones = freshMilestones();

// ── cancel penalty (set in handleStep, consumed in computeReward) ─────────────
let tickCancelPenalty = 0;

// ── per-episode shaping accumulator & diagnostic counters ─────────────────────
let episodeShaping        = 0;
let episodeOwnCombatCreated  = 0;
let episodeOwnCombatLost     = 0;
let episodeCombatKilled      = 0;
let episodeEnemyWorkersKilled = 0;
let episodeActionCounts: Record<string, number> = {};
let episodeTotalActions   = 0;
let lastRewardBreakdown   = { terminal: 0, rawShaping: 0, clampedShaping: 0, finalReward: 0 };

function computeReward(
  prev: PlayerObservation,
  curr: PlayerObservation,
  done: boolean,
  winner: string | null,
  winType: string | null
): number {
  let r = 0;

  // ── Order cancel penalty (computed in handleStep, consumed here) ──────────
  r += tickCancelPenalty;
  tickCancelPenalty = 0;

  // ── Crystal damage dealt / taken ──────────────────────────────────────────
  if (prev.global.oppCrystalHealthFrac > 0) {
    const delta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (delta > 0) r += 0.01 * delta * CRYSTAL_MAX_HP;
  }
  const ownDelta = prev.global.ownCrystalHealthFrac - curr.global.ownCrystalHealthFrac;
  if (ownDelta > 0) r -= 0.01 * ownDelta * CRYSTAL_MAX_HP;

  // ── Mining (lifetime resources) ───────────────────────────────────────────
  const miningDelta = curr.global.ownLifetimeResourcesFrac - prev.global.ownLifetimeResourcesFrac;
  if (miningDelta > 0) r += 0.000001 * miningDelta * (ECONOMY.passiveWinThreshold * 2);

  // ── Kill / death signals ──────────────────────────────────────────────────
  const enemyWorkersPrev = prev.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersCurr = curr.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersKilled = Math.max(0, enemyWorkersPrev - enemyWorkersCurr);

  // Own combat count needed here to gate rewards on combat units being present.
  // Workers can fight but generate no kill/damage rewards — that incentive belongs to combat units.
  const ownCombatPrevCount = prev.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
  const ownCombatCurrCount = curr.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;

  const oppSupplyDelta = prev.global.oppVisibleSupply - curr.global.oppVisibleSupply;
  const combatKillDelta = Math.max(0, oppSupplyDelta - enemyWorkersKilled);
  if (ownCombatCurrCount > 0) {
    if (combatKillDelta    > 0) r += 0.3  * combatKillDelta;
    if (enemyWorkersKilled > 0) r += 0.2  * enemyWorkersKilled;
  }

  const ownWorkersPrev = prev.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersCurr = curr.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersLost = Math.max(0, ownWorkersPrev - ownWorkersCurr);
  if (ownWorkersLost > 0) r -= 0.1 * ownWorkersLost;

  // Own combat unit lost
  const ownCombatUnitsLost = Math.max(0, ownCombatPrevCount - ownCombatCurrCount);
  if (ownCombatUnitsLost > 0) r -= 0.15 * ownCombatUnitsLost;

  // ── Damage-dealt reward ───────────────────────────────────────────────────
  // Fires only when actual HP damage lands AND own combat units are present.
  // Workers can fight but don't generate this reward — prevents worker-swarm exploit.
  // Buildings rewarded at half rate. Coefficient per full healthFrac reduction:
  //   units/workers: 0.1 — buildings: 0.05
  if (ownCombatCurrCount > 0) {
    const prevEnemyHealth = new Map<string, number>();
    for (const e of prev.entities) {
      if (e.owner === -1) prevEnemyHealth.set(e.id, e.healthFrac);
    }
    for (const e of curr.entities) {
      if (e.owner !== -1 || e.typeIndex === 0) continue;
      const prevHP = prevEnemyHealth.get(e.id);
      if (prevHP === undefined) continue;
      const delta = prevHP - e.healthFrac;
      if (delta <= 0) continue;
      r += (e.typeIndex >= 6 ? 0.05 : 0.1) * delta;
    }
  }

  // ── Own building damage taken penalty ────────────────────────────────────
  // Slightly less than the damage-dealt rate for enemy buildings (0.05).
  // Crystal excluded — has its own signal above.
  const prevOwnBuildingHealth = new Map<string, number>();
  for (const e of prev.entities) {
    if (e.owner === 1 && e.typeIndex >= 6 && e.typeIndex <= 9) prevOwnBuildingHealth.set(e.id, e.healthFrac);
  }
  for (const e of curr.entities) {
    if (e.owner !== 1 || e.typeIndex < 6 || e.typeIndex > 9) continue;
    const prevHP = prevOwnBuildingHealth.get(e.id);
    if (prevHP === undefined) continue;
    const delta = prevHP - e.healthFrac;
    if (delta > 0) r -= 0.04 * delta;
  }

  // ── Combat unit behaviour ─────────────────────────────────────────────────
  const ownCombat = ownCombatCurrCount;

  // ── Enemy-threat reactive signals ─────────────────────────────────────────
  const enemyCombat = curr.entities.filter(e => e.owner === -1 && e.typeIndex >= 2 && e.typeIndex <= 5).length;

  if (enemyCombat > 0 && ownCombat === 0) {
    r -= 0.001 * enemyCombat;
  }

  const armyGap = enemyCombat - ownCombat;
  if (armyGap > 2) {
    r -= 0.0003 * (armyGap - 2);
  }

  // ── Distress + retaliation ────────────────────────────────────────────────
  const enemyInOwnHalf = curr.global.enemyCombatInOwnHalf > 0;
  const underAttack = ownDelta > 0 || ownWorkersLost > 0 || enemyInOwnHalf;
  if (underAttack) {
    // Requires inAttackRange: unit must be positioned to deal damage, not merely chasing.
    const fightingBack = curr.entities.filter(
      e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 5 && e.inAttackRange && e.isAttacking
    ).length;
    if (fightingBack > 0) {
      r += 0.006 * fightingBack;
    } else {
      r -= 0.003;
    }
  }

  // ── Defenseless trickle ───────────────────────────────────────────────────
  if (curr.tick > 150 && !milestones.hasBuiltBarracks && ownCombat === 0) {
    r -= 0.002;
  }

  // ── Wrong-building-first penalty ──────────────────────────────────────────
  // Penalise building depots or turrets before any barracks exists.
  // Creates gradient toward barracks as the first build priority.
  if (!milestones.hasBuiltBarracks && ownCombat === 0 && curr.tick > 200) {
    const hasNonBarracks = curr.entities.some(
      e => e.owner === 1 && (e.typeIndex === 8 || e.typeIndex === 9)
    );
    if (hasNonBarracks) r -= 0.003;
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

  // ── Time penalty ─────────────────────────────────────────────────────────
  r -= 0.0005;

  // ── Per-tick building bonuses (diminishing returns, cap at 3) ────────────
  // Each completed building adds a per-tick bonus; additional buildings add less.
  // 4th+ building of a type adds nothing. Incentivises 3 of each without hoarding.
  // Barracks:  1st +0.005, 2nd +0.004, 3rd +0.003  → max +0.012/tick (~+68 per ep)
  // Foundry:   1st +0.002, 2nd +0.0015, 3rd +0.001 → max +0.0045/tick (~+26 per ep)
  {
    const barracksBonuses = [0.005, 0.004, 0.003];
    const barracksCount = curr.entities.filter(e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1).length;
    for (let i = 0; i < Math.min(barracksCount, 3); i++) r += barracksBonuses[i];
  }
  {
    const foundryBonuses = [0.002, 0.0015, 0.001];
    const foundryCount = curr.entities.filter(e => e.owner === 1 && e.typeIndex === 7 && e.constructionFrac >= 1).length;
    for (let i = 0; i < Math.min(foundryCount, 3); i++) r += foundryBonuses[i];
  }

  // ── One-time milestone bonuses ────────────────────────────────────────────

  if (!milestones.hasBuiltBarracks) {
    const hadBarracks = prev.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const hasBarracks = curr.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    if (!hadBarracks && hasBarracks) {
      // 10.0 base reward, linearly scaled by how early it was built.
      // Factor = 1.0 at tick 0, decays to floor 0.01 at tick ≥ 2000.
      // Tick 500 → ×0.75 = 7.5,  tick 1000 → ×0.5 = 5.0,  tick 2000+ → ×0.01 = 0.1
      const barracksTimeFactor = Math.max(0.01, 1.0 - curr.tick / 2000);
      r += 10.0 * barracksTimeFactor;
      milestones.hasBuiltBarracks = true;
      milestones.firstBarracksTick = curr.tick;
    }
  }

  if (!milestones.hasBuiltFoundry) {
    const hadFoundry = prev.entities.some(e => e.owner === 1 && e.typeIndex === 7);
    const hasFoundry = curr.entities.some(e => e.owner === 1 && e.typeIndex === 7);
    if (!hadFoundry && hasFoundry) {
      r += 2.0;
      milestones.hasBuiltFoundry = true;
      milestones.firstFoundryTick = curr.tick;
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

  // Diminishing reward per combat unit trained: +1.0, +0.8, +0.6, +0.4, +0.2, then 0
  // episodeOwnCombatCreated holds count from prior ticks (updated in diagnostic section below)
  {
    const newUnits = Math.max(0, ownCombatCurrCount - ownCombatPrevCount);
    if (newUnits > 0) {
      const rewards = [1.0, 0.8, 0.6, 0.4, 0.2];
      for (let i = 0; i < newUnits; i++) {
        const idx = episodeOwnCombatCreated + i;
        if (idx < rewards.length) r += rewards[idx];
      }
      if (!milestones.hasTrainedCombatUnit) {
        milestones.hasTrainedCombatUnit = true;
        milestones.firstCombatUnitTick = curr.tick;
      }
      if (!milestones.hasThreeCombatUnits && episodeOwnCombatCreated + newUnits >= 3) {
        milestones.hasThreeCombatUnits = true;
        milestones.firstThreeCombatUnitsTick = curr.tick;
      }
    }
  }

  if (milestones.hasTrainedCombatUnit && !milestones.hasCombatUnitCrossedMidfield) {
    const crossedMid = curr.entities.some(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4 && e.xNorm > 0.5);
    if (crossedMid) {
      milestones.hasCombatUnitCrossedMidfield = true;
      milestones.firstMidfieldCrossTick = curr.tick;
    }
  }

  // First combat unit enters enemy quarter (xNorm > 0.75)
  if (!milestones.hasEnteredEnemyQuarter) {
    const inEnemyQuarter = curr.entities.some(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4 && e.xNorm > 0.75);
    if (inEnemyQuarter) {
      milestones.hasEnteredEnemyQuarter = true;
      milestones.firstEnemyQuarterEntryTick = curr.tick;
    }
  }

  if (!milestones.hasDealtCrystalDamage && prev.global.oppCrystalHealthFrac > 0) {
    const dmgDelta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (dmgDelta > 0) {
      r += 5.0;
      milestones.hasDealtCrystalDamage = true;
      milestones.firstAttackTick = curr.tick;
    }
  }

  // ── Crystal damage depth milestones ──────────────────────────────────────
  if (curr.global.oppCrystalHealthFrac > 0 &&
      curr.global.oppCrystalHealthFrac < milestones.minOppCrystalHealthFrac) {
    milestones.minOppCrystalHealthFrac = curr.global.oppCrystalHealthFrac;
  }
  if (curr.global.ownCrystalHealthFrac < milestones.minOwnCrystalHealthFrac) {
    milestones.minOwnCrystalHealthFrac = curr.global.ownCrystalHealthFrac;
  }
  if (!milestones.dealtDmg25pct && milestones.minOppCrystalHealthFrac <= 0.75) {
    r += 3.0;
    milestones.dealtDmg25pct = true;
  }
  if (!milestones.dealtDmg50pct && milestones.minOppCrystalHealthFrac <= 0.5) {
    r += 5.0;
    milestones.dealtDmg50pct = true;
  }
  if (!milestones.dealtDmg90pct && milestones.minOppCrystalHealthFrac <= 0.1) {
    r += 8.0;
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

  // ── Scouting / fog-of-war discovery reward ────────────────────────────────
  for (const e of curr.entities) {
    if (e.owner !== -1) continue;
    if (milestones.discoveredEntityIds.has(e.id)) continue;
    milestones.discoveredEntityIds.add(e.id);
    if (e.typeIndex === 0) {
      r += 2.0;
    } else if (e.typeIndex === 1) {
      r += 0.15;
    } else if (e.typeIndex >= 2 && e.typeIndex <= 5) {
      r += 0.4;
    } else if (e.typeIndex === 6 || e.typeIndex === 7) {
      r += 1.0;
    } else if (e.typeIndex === 8 || e.typeIndex === 9) {
      r += 0.5;
    }
  }

  // (anti-passivity penalties removed — they created exploitable attractors)

  // ── Map visibility reward ─────────────────────────────────────────────────
  // Reward proportional to fraction of map currently visible.
  // Uses a 60×6 grid (100px cells). Vision radii match game config per unit type.
  // Incentivises spreading units horizontally without a fixed positional attractor.
  {
    const GRID_COLS = 60, GRID_ROWS = 6;
    const MAP_W = 6000, MAP_H = 600;
    const CELL_W = MAP_W / GRID_COLS, CELL_H = MAP_H / GRID_ROWS;
    const VISION: Record<number, number> = {
      0: 150, 1: 225, 2: 300, 3: 270, 4: 195, 5: 210,
      6: 180, 7: 180, 8: 150, 9: 225,
    };
    const grid = new Uint8Array(GRID_COLS * GRID_ROWS);
    for (const e of curr.entities) {
      if (e.owner !== 1) continue;
      const vr = VISION[e.typeIndex] ?? 200;
      const vrSq = vr * vr;
      const ex = e.xNorm * MAP_W;
      const ey = e.yNorm * MAP_H;
      for (let row = 0; row < GRID_ROWS; row++) {
        for (let col = 0; col < GRID_COLS; col++) {
          if (grid[row * GRID_COLS + col]) continue;
          const dx = (col + 0.5) * CELL_W - ex;
          const dy = (row + 0.5) * CELL_H - ey;
          if (dx * dx + dy * dy <= vrSq) grid[row * GRID_COLS + col] = 1;
        }
      }
    }
    let visCount = 0;
    for (let i = 0; i < grid.length; i++) visCount += grid[i];
    r += (visCount / (GRID_COLS * GRID_ROWS)) * 0.001;
  }

  // ── Episode diagnostic tracking ───────────────────────────────────────────
  if (combatKillDelta > 0)       episodeCombatKilled       += combatKillDelta;
  if (enemyWorkersKilled > 0)    episodeEnemyWorkersKilled += enemyWorkersKilled;
  if (ownCombatUnitsLost > 0)    episodeOwnCombatLost      += ownCombatUnitsLost;
  const ownCombatUnitsCreated = Math.max(0, ownCombatCurrCount - ownCombatPrevCount);
  if (ownCombatUnitsCreated > 0) episodeOwnCombatCreated   += ownCombatUnitsCreated;

  // Accumulate shaping for the end-of-episode clamp
  episodeShaping += r;

  // ── Terminal rewards ──────────────────────────────────────────────────────
  if (done) {
    const terminal = (winner === BLUE_ID && winType !== "resource") ? 100.0 : -100.0;

    const totalShaping = episodeShaping;
    lastRewardBreakdown = { terminal, rawShaping: totalShaping, clampedShaping: totalShaping, finalReward: terminal + totalShaping };

    return r + terminal;
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

// ── Cancel penalty helpers ────────────────────────────────────────────────────

function cancelOrderState(e: import("../../server/src/match/types.js").MatchEntity, m: import("../../server/src/match/types.js").MatchState): "idle" | "mining" | "committed" {
  if (!e.moveTarget && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId) return "idle";
  if (e.gatheringNodeId && !e.moveTarget) return "mining";
  // Attack target no longer exists (killed) → idle
  if (e.attackTargetId && !m.entities.has(e.attackTargetId)) return "idle";
  return "committed";
}

function isTargetedByEnemy(entityId: string, m: import("../../server/src/match/types.js").MatchState): boolean {
  for (const e of m.entities.values()) {
    if (e.ownerId === BLUE_ID) continue;
    if (e.attackTargetId === entityId) return true;
  }
  return false;
}

function cancelAffectedUnits(action: import("./types.js").MacroAction, m: import("../../server/src/match/types.js").MatchState): import("../../server/src/match/types.js").MatchEntity[] {
  const own = [...m.entities.values()].filter(e => e.ownerId === BLUE_ID);
  const isCombat = (e: import("../../server/src/match/types.js").MatchEntity) =>
    ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type);

  switch (action.type) {
    case "attack_move":
    case "retreat":
    case "attack_targeted":
    case "hold_position": {
      const g = action.group ?? "all_combat";
      return own.filter(e => {
        if (g === "all_workers") return e.type === "worker";
        if (g === "all_combat")  return isCombat(e);
        if (g === "skirmishers") return e.type === "skirmisher";
        if (g === "gunners")     return e.type === "gunner";
        if (g === "bruisers")    return e.type === "bruiser";
        return false;
      });
    }
    case "assign_workers":
      return own.filter(e => e.type === "worker" && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId);
    case "build": {
      const builder = own.find(e => e.type === "worker" && !e.buildTargetId);
      return builder ? [builder] : [];
    }
    default:
      return [];
  }
}

function computeTickCancelPenalty(
  action: import("./types.js").MacroAction,
  m: import("../../server/src/match/types.js").MatchState,
  prevObs: PlayerObservation
): number {
  const PENALTY = 0.5;

  // Crystal actively under attack = HP dropped since last tick
  const ownCrystal = [...m.entities.values()].find(e => e.type === "crystal" && e.ownerId === BLUE_ID);
  const crystalUnderAttack = ownCrystal != null && ownCrystal.maxHealth > 0
    && (ownCrystal.health / ownCrystal.maxHealth) < prevObs.global.ownCrystalHealthFrac - 0.0001;

  let penalty = 0;
  for (const unit of cancelAffectedUnits(action, m)) {
    const state = cancelOrderState(unit, m);
    if (state === "idle" || state === "mining") continue;   // free
    if (crystalUnderAttack) continue;                       // all units free when crystal hit
    if (isTargetedByEnemy(unit.id, m)) continue;           // this unit is targeted → free
    penalty -= PENALTY;
  }
  return penalty;
}

function handleReset(seed?: number, opponent?: string, doSave = false): void {
  milestones = freshMilestones();
  episodeShaping         = 0;
  tickCancelPenalty      = 0;
  episodeOwnCombatCreated  = 0;
  episodeOwnCombatLost     = 0;
  episodeCombatKilled      = 0;
  episodeEnemyWorkersKilled = 0;
  episodeActionCounts    = {};
  episodeTotalActions    = 0;
  engine   = new MatchEngine();
  saveReplay = doSave;

  const effectiveSeed = (seed != null && isFinite(seed)) ? seed : Math.floor(Math.random() * 0xffffffff);

  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: BLUE_ID, username: "Blue", color: "blue", score: 0 },
    { playerId: RED_ID,  username: "Red",  color: "red",  score: 0 },
  ];

  match = engine.createMatch("headless", players, DEFAULT_CONFIG, effectiveSeed);
  engine.startMatch(match.id);

  redBot = makeBot(opponent);
  redBot.init(RED_ID, match);

  commandLog = [];
  const obs  = buildObservation(match, BLUE_ID);
  const legal = getLegalActions(match, BLUE_ID);
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
  episodeTotalActions++;
  episodeActionCounts[macroAction.type] = (episodeActionCounts[macroAction.type] ?? 0) + 1;

  // Cancel penalty: check committed orders BEFORE commands are applied
  tickCancelPenalty = computeTickCancelPenalty(macroAction, match, prevBlueObs);

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

  const legal = getLegalActions(match, BLUE_ID);
  const info: Record<string, unknown> = { ticks: match.tick };

  if (done) {
    info.winner  = winner;
    info.winType = winType;
    info.seed    = match.seed;
    info.opponentType = currentOpponentName;

    // Episode outcome
    const isCombatWin = winner === BLUE_ID && winType !== "resource";
    info.episodeOutcome = isCombatWin ? "combat_win"
      : winner === BLUE_ID ? "resource_win"
      : winner !== null    ? "loss"
      : "timeout";

    // Reward breakdown
    info.terminalReward       = lastRewardBreakdown.terminal;
    info.rawShapingReward     = lastRewardBreakdown.rawShaping;
    info.clampedShapingReward = lastRewardBreakdown.clampedShaping;
    info.finalReward          = lastRewardBreakdown.finalReward;

    // Milestone ticks
    info.firstBarracksTick          = milestones.firstBarracksTick;
    info.firstCombatUnitTick        = milestones.firstCombatUnitTick;
    info.firstThreeCombatUnitsTick  = milestones.firstThreeCombatUnitsTick;
    info.firstMidfieldCrossTick     = milestones.firstMidfieldCrossTick;
    info.firstEnemyQuarterEntryTick = milestones.firstEnemyQuarterEntryTick;
    info.firstEnemyCrystalHitTick   = milestones.firstAttackTick;
    info.entitiesDiscovered         = milestones.discoveredEntityIds.size;

    // Crystal damage
    info.enemyCrystalDamagePct = Math.round((1 - milestones.minOppCrystalHealthFrac) * 1000) / 10;
    info.ownCrystalDamagePct   = Math.round((1 - milestones.minOwnCrystalHealthFrac) * 1000) / 10;

    // Unit counts
    info.ownCombatCreated   = episodeOwnCombatCreated;
    info.ownCombatLost      = episodeOwnCombatLost;
    info.enemyCombatKilled  = episodeCombatKilled;
    info.enemyWorkersKilled = episodeEnemyWorkersKilled;

    // Action rates
    const tot = episodeTotalActions || 1;
    info.noopRate         = (episodeActionCounts["noop"]           ?? 0) / tot;
    info.trainUnitRate    = (episodeActionCounts["train_unit"]      ?? 0) / tot;
    info.attackMoveRate   = (episodeActionCounts["attack_move"]     ?? 0) / tot;
    info.attackTargetRate = (episodeActionCounts["attack_targeted"] ?? 0) / tot;
    info.retreatRate      = (episodeActionCounts["retreat"]         ?? 0) / tot;
    info.holdPosRate      = (episodeActionCounts["hold_position"]   ?? 0) / tot;

    // Diagnostic warnings
    if (episodeOwnCombatCreated >= 4 && milestones.minOppCrystalHealthFrac >= 1.0) {
      info.warn_no_pressure = true;
    }
    if (!isCombatWin && lastRewardBreakdown.finalReward > 0) {
      info.warn_loss_positive_reward = true;
    }

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
