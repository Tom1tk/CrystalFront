#!/usr/bin/env node
/**
 * Vectorised stdio runner — runs N CrystalFront matches concurrently in a single
 * Node process. The Python PPO trainer drives it the same way as stdioRunner.ts,
 * but each step/reset message carries arrays of length N.
 *
 * Protocol (newline-delimited JSON):
 *
 *   Python → Node
 *     { "type": "reset_all",
 *       "seeds": number[],
 *       "opponents": string[],
 *       "save_replays": boolean[] }
 *
 *     { "type": "step",
 *       "actions": number[] }          ← one discrete action index per slot
 *
 *     { "type": "close" }
 *
 *   Node → Python
 *     { "type": "ready",
 *       "slots": [{ obs, legalMask }, ...] }
 *
 *     { "type": "step_result",
 *       "slots": [{
 *           obs, legalMask,
 *           reward: number,
 *           done: boolean,
 *           info: object           ← full episode info on done, {} otherwise
 *       }, ...] }
 *
 *     { "type": "error", "message": string }
 *
 * On done: the slot is IMMEDIATELY autoreset. The returned obs/legalMask is
 * from the FRESH episode. The full final-episode info is returned in info{}.
 * Python does NOT need to send a separate reset_all after a done step.
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
import type { MatchState, MatchEntity } from "../../server/src/match/types.js";
import type { PlayerSlot } from "../../server/src/match/types.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";
import { indexToAction, legalMask as buildLegalMask } from "./actionIndex.js";
import { IdleBot, RushBot, WeakRushBot, MediumRushBot, PassiveBot, TurtleBot, MacroBot, HeavyBot } from "./bots/index.js";
import { ECONOMY } from "@crystalfront/shared";
import type { Agent, PlayerObservation, MacroAction } from "./types.js";

const REPO_ROOT   = resolve(__dirnameHere, "..", "..");
const REPLAYS_DIR = resolve(REPO_ROOT, "replays");

const BLUE_ID        = "headless-blue";
const RED_ID         = "headless-red";
const CRYSTAL_MAX_HP = 1000;
const MAX_TICKS      = 6000;

// ── per-slot state ────────────────────────────────────────────────────────────

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
  hasSeenEnemyCombat: boolean;
  firstEnemyCombatTick: number;
  hasReactiveBarracks: boolean;
  minOppCrystalHealthFrac: number;
  minOwnCrystalHealthFrac: number;
  dealtDmg25pct: boolean;
  dealtDmg50pct: boolean;
  dealtDmg90pct: boolean;
  discoveredEntityIds: Set<string>;
}

interface SlotState {
  engine: MatchEngine;
  match: MatchState | null;
  redBot: Agent | null;
  prevBlueObs: PlayerObservation | null;
  opponentName: string;
  saveReplay: boolean;
  saveReplayEvery: number;
  episodeCount: number;
  commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }>;
  milestones: Milestones;
  tickCancelPenalty: number;
  episodeShaping: number;
  episodeOwnCombatCreated: number;
  episodeOwnCombatLost: number;
  episodeCombatKilled: number;
  episodeEnemyWorkersKilled: number;
  episodeActionCounts: Record<string, number>;
  episodeTotalActions: number;
  lastRewardBreakdown: { terminal: number; rawShaping: number; clampedShaping: number; finalReward: number };
}

function freshMilestones(): Milestones {
  return {
    hasBuiltBarracks: false, hasBuiltFoundry: false, firstFoundryTick: -1,
    hasTrainedCombatUnit: false, hasThreeCombatUnits: false,
    hasCombatUnitCrossedMidfield: false, firstMidfieldCrossTick: -1,
    hasEnteredEnemyQuarter: false, hasDealtCrystalDamage: false, hasBuiltTurret: false,
    hasOwnCrystalTakenHit: false, firstBarracksTick: -1, firstCombatUnitTick: -1,
    firstThreeCombatUnitsTick: -1, firstAttackTick: -1, firstEnemyQuarterEntryTick: -1,
    hasSeenEnemyCombat: false, firstEnemyCombatTick: -1, hasReactiveBarracks: false,
    minOppCrystalHealthFrac: 1.0, minOwnCrystalHealthFrac: 1.0,
    dealtDmg25pct: false, dealtDmg50pct: false, dealtDmg90pct: false,
    discoveredEntityIds: new Set<string>(),
  };
}

function makeBot(name: string): Agent {
  switch (name.toLowerCase()) {
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

// ── cancel penalty helpers ────────────────────────────────────────────────────

function cancelOrderState(e: MatchEntity, m: MatchState): "idle" | "mining" | "committed" {
  if (!e.moveTarget && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId) return "idle";
  if (e.gatheringNodeId && !e.moveTarget) return "mining";
  if (e.attackTargetId && !m.entities.has(e.attackTargetId)) return "idle";
  return "committed";
}

function isTargetedByEnemy(entityId: string, m: MatchState): boolean {
  for (const e of m.entities.values()) {
    if (e.ownerId === BLUE_ID) continue;
    if (e.attackTargetId === entityId) return true;
  }
  return false;
}

function cancelAffectedUnits(action: MacroAction, m: MatchState): MatchEntity[] {
  const own = [...m.entities.values()].filter(e => e.ownerId === BLUE_ID);
  const isCombat = (e: MatchEntity) => ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type);
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

function computeTickCancelPenalty(action: MacroAction, m: MatchState, prevObs: PlayerObservation): number {
  const PENALTY = 0.5;
  const ownCrystal = [...m.entities.values()].find(e => e.type === "crystal" && e.ownerId === BLUE_ID);
  const crystalUnderAttack = ownCrystal != null && ownCrystal.maxHealth > 0
    && (ownCrystal.health / ownCrystal.maxHealth) < prevObs.global.ownCrystalHealthFrac - 0.0001;
  let penalty = 0;
  for (const unit of cancelAffectedUnits(action, m)) {
    const state = cancelOrderState(unit, m);
    if (state === "idle" || state === "mining") continue;
    if (crystalUnderAttack) continue;
    if (isTargetedByEnemy(unit.id, m)) continue;
    penalty -= PENALTY;
  }
  return penalty;
}

// ── reward computation ────────────────────────────────────────────────────────

function computeReward(
  slot: SlotState,
  prev: PlayerObservation,
  curr: PlayerObservation,
  done: boolean,
  winner: string | null,
  winType: string | null
): number {
  let r = 0;
  const { milestones } = slot;

  r += slot.tickCancelPenalty;
  slot.tickCancelPenalty = 0;

  if (prev.global.oppCrystalHealthFrac > 0) {
    const delta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (delta > 0) r += 0.01 * delta * CRYSTAL_MAX_HP;
  }
  const ownDelta = prev.global.ownCrystalHealthFrac - curr.global.ownCrystalHealthFrac;
  if (ownDelta > 0) r -= 0.01 * ownDelta * CRYSTAL_MAX_HP;

  const miningDelta = curr.global.ownLifetimeResourcesFrac - prev.global.ownLifetimeResourcesFrac;
  if (miningDelta > 0) r += 0.000001 * miningDelta * (ECONOMY.passiveWinThreshold * 2);

  const enemyWorkersPrev = prev.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersCurr = curr.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersKilled = Math.max(0, enemyWorkersPrev - enemyWorkersCurr);
  const oppSupplyDelta = prev.global.oppVisibleSupply - curr.global.oppVisibleSupply;
  const combatKillDelta = Math.max(0, oppSupplyDelta - enemyWorkersKilled);
  if (combatKillDelta    > 0) r += 0.3 * combatKillDelta;
  if (enemyWorkersKilled > 0) r += 0.2 * enemyWorkersKilled;

  const ownWorkersPrev = prev.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersCurr = curr.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersLost = Math.max(0, ownWorkersPrev - ownWorkersCurr);
  if (ownWorkersLost > 0) r -= 0.1 * ownWorkersLost;

  const ownCombatPrevCount = prev.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
  const ownCombatCurrCount = curr.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
  const ownCombatUnitsLost = Math.max(0, ownCombatPrevCount - ownCombatCurrCount);
  if (ownCombatUnitsLost > 0) r -= 0.15 * ownCombatUnitsLost;

  const prevEnemyHealth = new Map<string, number>();
  for (const e of prev.entities) if (e.owner === -1) prevEnemyHealth.set(e.id, e.healthFrac);
  for (const e of curr.entities) {
    if (e.owner !== -1 || e.typeIndex === 0) continue;
    const prevHP = prevEnemyHealth.get(e.id);
    if (prevHP === undefined) continue;
    const delta = prevHP - e.healthFrac;
    if (delta <= 0) continue;
    r += (e.typeIndex >= 6 ? 0.05 : 0.1) * delta;
  }

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

  const ownCombat = ownCombatCurrCount;
  const enemyCombat = curr.entities.filter(e => e.owner === -1 && e.typeIndex >= 2 && e.typeIndex <= 5).length;

  if (enemyCombat > 0 && ownCombat === 0) r -= 0.001 * enemyCombat;
  const armyGap = enemyCombat - ownCombat;
  if (armyGap > 2) r -= 0.0003 * (armyGap - 2);

  const enemyInOwnHalf = curr.global.enemyCombatInOwnHalf > 0;
  const underAttack = ownDelta > 0 || ownWorkersLost > 0 || enemyInOwnHalf;
  if (underAttack) {
    const fightingBack = curr.entities.filter(
      e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 5 && e.inAttackRange && e.isAttacking
    ).length;
    if (fightingBack > 0) r += 0.006 * fightingBack;
    else r -= 0.003;
  }

  if (curr.tick > 150 && !milestones.hasBuiltBarracks && ownCombat === 0) r -= 0.002;
  if (!milestones.hasBuiltBarracks && ownCombat === 0 && curr.tick > 200) {
    const hasNonBarracks = curr.entities.some(e => e.owner === 1 && (e.typeIndex === 8 || e.typeIndex === 9));
    if (hasNonBarracks) r -= 0.003;
  }

  const prevBuildFracById = new Map(prev.entities
    .filter(e => e.owner === 1 && e.typeIndex >= 6 && e.typeIndex <= 9)
    .map(e => [e.id, e.constructionFrac])
  );
  for (const e of curr.entities) {
    if (e.owner !== 1 || e.typeIndex < 6 || e.typeIndex > 9) continue;
    if (e.constructionFrac <= 0 || e.constructionFrac >= 1) continue;
    const prevFrac = prevBuildFracById.get(e.id);
    if (prevFrac !== undefined && e.constructionFrac <= prevFrac) r -= 0.002;
  }

  r -= 0.0005;

  if (!milestones.hasBuiltBarracks) {
    const hadBarracks = prev.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const hasBarracks = curr.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    if (!hadBarracks && hasBarracks) {
      r += 5.0; milestones.hasBuiltBarracks = true; milestones.firstBarracksTick = curr.tick;
    }
  }
  if (!milestones.hasBuiltFoundry) {
    const hadFoundry = prev.entities.some(e => e.owner === 1 && e.typeIndex === 7);
    const hasFoundry = curr.entities.some(e => e.owner === 1 && e.typeIndex === 7);
    if (!hadFoundry && hasFoundry) {
      r += 2.0; milestones.hasBuiltFoundry = true; milestones.firstFoundryTick = curr.tick;
    }
  }
  if (!milestones.hasBuiltTurret) {
    const hadTurret = prev.entities.some(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1);
    const hasTurret = curr.entities.some(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1);
    if (!hadTurret && hasTurret) { r += 0.5; milestones.hasBuiltTurret = true; }
  }

  {
    const newUnits = Math.max(0, ownCombatCurrCount - ownCombatPrevCount);
    if (newUnits > 0) {
      const rewards = [1.0, 0.8, 0.6, 0.4, 0.2];
      for (let i = 0; i < newUnits; i++) {
        const idx = slot.episodeOwnCombatCreated + i;
        if (idx < rewards.length) r += rewards[idx];
      }
      if (!milestones.hasTrainedCombatUnit) {
        milestones.hasTrainedCombatUnit = true; milestones.firstCombatUnitTick = curr.tick;
      }
      if (!milestones.hasThreeCombatUnits && slot.episodeOwnCombatCreated + newUnits >= 3) {
        milestones.hasThreeCombatUnits = true; milestones.firstThreeCombatUnitsTick = curr.tick;
      }
    }
  }

  if (milestones.hasTrainedCombatUnit && !milestones.hasCombatUnitCrossedMidfield) {
    const crossedMid = curr.entities.some(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4 && e.xNorm > 0.5);
    if (crossedMid) { milestones.hasCombatUnitCrossedMidfield = true; milestones.firstMidfieldCrossTick = curr.tick; }
  }
  if (!milestones.hasEnteredEnemyQuarter) {
    const inEnemyQuarter = curr.entities.some(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4 && e.xNorm > 0.75);
    if (inEnemyQuarter) { milestones.hasEnteredEnemyQuarter = true; milestones.firstEnemyQuarterEntryTick = curr.tick; }
  }
  if (!milestones.hasDealtCrystalDamage && prev.global.oppCrystalHealthFrac > 0) {
    const dmgDelta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (dmgDelta > 0) { r += 5.0; milestones.hasDealtCrystalDamage = true; milestones.firstAttackTick = curr.tick; }
  }

  if (curr.global.oppCrystalHealthFrac > 0 && curr.global.oppCrystalHealthFrac < milestones.minOppCrystalHealthFrac)
    milestones.minOppCrystalHealthFrac = curr.global.oppCrystalHealthFrac;
  if (curr.global.ownCrystalHealthFrac < milestones.minOwnCrystalHealthFrac)
    milestones.minOwnCrystalHealthFrac = curr.global.ownCrystalHealthFrac;
  if (!milestones.dealtDmg25pct && milestones.minOppCrystalHealthFrac <= 0.75) { r += 3.0; milestones.dealtDmg25pct = true; }
  if (!milestones.dealtDmg50pct && milestones.minOppCrystalHealthFrac <= 0.5)  { r += 5.0; milestones.dealtDmg50pct = true; }
  if (!milestones.dealtDmg90pct && milestones.minOppCrystalHealthFrac <= 0.1)  { r += 8.0; milestones.dealtDmg90pct = true; }
  if (!milestones.hasOwnCrystalTakenHit && curr.global.ownCrystalHealthFrac <= 0.95) {
    r -= 0.5; milestones.hasOwnCrystalTakenHit = true;
  }
  if (!milestones.hasSeenEnemyCombat && enemyCombat > 0) {
    milestones.hasSeenEnemyCombat = true; milestones.firstEnemyCombatTick = curr.tick;
  }

  for (const e of curr.entities) {
    if (e.owner !== -1) continue;
    if (milestones.discoveredEntityIds.has(e.id)) continue;
    milestones.discoveredEntityIds.add(e.id);
    if      (e.typeIndex === 0)                          r += 2.0;
    else if (e.typeIndex === 1)                          r += 0.15;
    else if (e.typeIndex >= 2 && e.typeIndex <= 5)       r += 0.4;
    else if (e.typeIndex === 6 || e.typeIndex === 7)     r += 1.0;
    else if (e.typeIndex === 8 || e.typeIndex === 9)     r += 0.5;
  }

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
      const ex = e.xNorm * MAP_W, ey = e.yNorm * MAP_H;
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

  if (combatKillDelta > 0)       slot.episodeCombatKilled       += combatKillDelta;
  if (enemyWorkersKilled > 0)    slot.episodeEnemyWorkersKilled += enemyWorkersKilled;
  if (ownCombatUnitsLost > 0)    slot.episodeOwnCombatLost      += ownCombatUnitsLost;
  const ownCombatUnitsCreated = Math.max(0, ownCombatCurrCount - ownCombatPrevCount);
  if (ownCombatUnitsCreated > 0) slot.episodeOwnCombatCreated   += ownCombatUnitsCreated;

  slot.episodeShaping += r;

  if (done) {
    const terminal = (winner === BLUE_ID && winType !== "resource") ? 100.0 : -100.0;
    const totalShaping = slot.episodeShaping;
    slot.lastRewardBreakdown = { terminal, rawShaping: totalShaping, clampedShaping: totalShaping, finalReward: terminal + totalShaping };
    return r + terminal;
  }
  return r;
}

// ── slot lifecycle ────────────────────────────────────────────────────────────

function resetSlot(slot: SlotState, seed: number | undefined, opponent: string, doSave: boolean): PlayerObservation {
  slot.milestones          = freshMilestones();
  slot.episodeShaping      = 0;
  slot.tickCancelPenalty   = 0;
  slot.episodeOwnCombatCreated  = 0;
  slot.episodeOwnCombatLost     = 0;
  slot.episodeCombatKilled      = 0;
  slot.episodeEnemyWorkersKilled = 0;
  slot.episodeActionCounts = {};
  slot.episodeTotalActions = 0;
  slot.opponentName        = opponent.toLowerCase();
  slot.saveReplay          = doSave;
  slot.commandLog          = [];
  slot.engine              = new MatchEngine();

  const effectiveSeed = (seed != null && isFinite(seed)) ? seed : Math.floor(Math.random() * 0xffffffff);
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: BLUE_ID, username: "Blue", color: "blue", score: 0 },
    { playerId: RED_ID,  username: "Red",  color: "red",  score: 0 },
  ];
  slot.match  = slot.engine.createMatch("headless", players, DEFAULT_CONFIG, effectiveSeed);
  slot.engine.startMatch(slot.match.id);
  slot.redBot = makeBot(opponent);
  slot.redBot.init(RED_ID, slot.match);

  const obs = buildObservation(slot.match, BLUE_ID);
  slot.prevBlueObs = obs;
  return obs;
}

function stepSlot(slot: SlotState, actionIdx: number): {
  obs: PlayerObservation;
  legalMask: boolean[];
  reward: number;
  done: boolean;
  info: Record<string, unknown>;
} {
  const { engine, match, redBot, prevBlueObs } = slot;
  if (!engine || !match || !redBot || !prevBlueObs) {
    throw new Error("Slot not initialized");
  }

  const macroAction = indexToAction(actionIdx);
  slot.episodeTotalActions++;
  slot.episodeActionCounts[macroAction.type] = (slot.episodeActionCounts[macroAction.type] ?? 0) + 1;

  slot.tickCancelPenalty = computeTickCancelPenalty(macroAction, match, prevBlueObs);

  const blueCmds = expandMacroAction(macroAction, match, BLUE_ID);
  for (const cmd of blueCmds) {
    const result = engine.processCommand(match.id, BLUE_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);
    if (result.success) slot.commandLog.push({ tick: match.tick, playerId: BLUE_ID, command: cmd as Record<string, unknown> });
  }

  const redObs   = buildObservation(match, RED_ID);
  const redLegal = getLegalActions(match, RED_ID);
  const redActions = redBot.step(redObs, redLegal);
  for (const ra of redActions) {
    const redCmds = expandMacroAction(ra, match, RED_ID);
    for (const cmd of redCmds) {
      const result = engine.processCommand(match.id, RED_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);
      if (result.success) slot.commandLog.push({ tick: match.tick, playerId: RED_ID, command: cmd as Record<string, unknown> });
    }
  }

  engine.tick(match.id);

  const done    = match.phase !== "playing" || match.tick >= MAX_TICKS;
  const winner  = match.result?.winner ?? null;
  const winType = (match.result?.winType ?? null) as string | null;

  const blueObs = buildObservation(match, BLUE_ID);
  const reward  = computeReward(slot, prevBlueObs, blueObs, done, winner, winType);
  slot.prevBlueObs = blueObs;

  const info: Record<string, unknown> = {};

  if (done) {
    info.winner      = winner;
    info.winType     = winType;
    info.seed        = match.seed;
    info.opponentType = slot.opponentName;

    const isCombatWin = winner === BLUE_ID && winType !== "resource";
    info.episodeOutcome = isCombatWin ? "combat_win"
      : winner === BLUE_ID ? "resource_win"
      : winner !== null    ? "loss"
      : "timeout";

    info.terminalReward       = slot.lastRewardBreakdown.terminal;
    info.rawShapingReward     = slot.lastRewardBreakdown.rawShaping;
    info.clampedShapingReward = slot.lastRewardBreakdown.clampedShaping;
    info.finalReward          = slot.lastRewardBreakdown.finalReward;

    info.firstBarracksTick          = slot.milestones.firstBarracksTick;
    info.firstCombatUnitTick        = slot.milestones.firstCombatUnitTick;
    info.firstThreeCombatUnitsTick  = slot.milestones.firstThreeCombatUnitsTick;
    info.firstMidfieldCrossTick     = slot.milestones.firstMidfieldCrossTick;
    info.firstEnemyQuarterEntryTick = slot.milestones.firstEnemyQuarterEntryTick;
    info.firstEnemyCrystalHitTick   = slot.milestones.firstAttackTick;
    info.entitiesDiscovered         = slot.milestones.discoveredEntityIds.size;
    info.enemyCrystalDamagePct      = Math.round((1 - slot.milestones.minOppCrystalHealthFrac) * 1000) / 10;
    info.ownCrystalDamagePct        = Math.round((1 - slot.milestones.minOwnCrystalHealthFrac) * 1000) / 10;
    info.ownCombatCreated           = slot.episodeOwnCombatCreated;
    info.ownCombatLost              = slot.episodeOwnCombatLost;
    info.enemyCombatKilled          = slot.episodeCombatKilled;
    info.enemyWorkersKilled         = slot.episodeEnemyWorkersKilled;

    const tot = slot.episodeTotalActions || 1;
    info.noopRate         = (slot.episodeActionCounts["noop"]           ?? 0) / tot;
    info.trainUnitRate    = (slot.episodeActionCounts["train_unit"]      ?? 0) / tot;
    info.attackMoveRate   = (slot.episodeActionCounts["attack_move"]     ?? 0) / tot;
    info.attackTargetRate = (slot.episodeActionCounts["attack_targeted"] ?? 0) / tot;
    info.retreatRate      = (slot.episodeActionCounts["retreat"]         ?? 0) / tot;
    info.holdPosRate      = (slot.episodeActionCounts["hold_position"]   ?? 0) / tot;

    if (slot.episodeOwnCombatCreated >= 4 && slot.milestones.minOppCrystalHealthFrac >= 1.0) info.warn_no_pressure = true;
    if (!isCombatWin && slot.lastRewardBreakdown.finalReward > 0) info.warn_loss_positive_reward = true;

    if (slot.saveReplay) {
      const ts = Date.now();
      if (!existsSync(REPLAYS_DIR)) mkdirSync(REPLAYS_DIR, { recursive: true });
      const path = resolve(REPLAYS_DIR, `${ts}-${match.seed}.json`);
      writeFileSync(path, JSON.stringify({
        version: GAME_VERSION, seed: match.seed,
        blue: "ppo_agent", red: slot.opponentName,
        bluePlayerId: BLUE_ID, redPlayerId: RED_ID,
        outcome: { winner, winType, ticks: match.tick },
        commandLog: slot.commandLog, timestamp: ts,
      }));
      info.replayPath = path;
    }

    engine.destroyMatch(match.id);
    slot.match  = null;
    slot.redBot = null;

    // Autoreset: immediately start a new episode in this slot
    slot.episodeCount++;
    const doNextSave = slot.saveReplayEvery > 0 && slot.episodeCount % slot.saveReplayEvery === 0;
    const nextObs    = resetSlot(slot, undefined, slot.opponentName, doNextSave);
    const nextLegal  = getLegalActions(slot.match!, BLUE_ID);
    return { obs: nextObs, legalMask: buildLegalMask(nextLegal), reward, done, info };
  }

  const legal = getLegalActions(match, BLUE_ID);
  return { obs: blueObs, legalMask: buildLegalMask(legal), reward, done, info };
}

// ── main ──────────────────────────────────────────────────────────────────────

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let slots: SlotState[] = [];

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    switch (msg.type) {
      case "reset_all": {
        const n           = (msg.seeds as number[]).length;
        const seeds       = msg.seeds       as number[];
        const opponents   = msg.opponents   as string[];
        const saveReplays = msg.save_replays as boolean[];
        const saveEvery   = (msg.save_replay_every as number) ?? 0;

        slots = [];
        const readySlots: { obs: PlayerObservation; legalMask: boolean[] }[] = [];
        for (let i = 0; i < n; i++) {
          const slot: SlotState = {
            engine: new MatchEngine(),
            match: null, redBot: null, prevBlueObs: null,
            opponentName: opponents[i],
            saveReplay: saveReplays[i],
            saveReplayEvery: saveEvery,
            episodeCount: i,     // stagger replay saves across slots
            commandLog: [],
            milestones: freshMilestones(),
            tickCancelPenalty: 0,
            episodeShaping: 0,
            episodeOwnCombatCreated: 0, episodeOwnCombatLost: 0,
            episodeCombatKilled: 0, episodeEnemyWorkersKilled: 0,
            episodeActionCounts: {}, episodeTotalActions: 0,
            lastRewardBreakdown: { terminal: 0, rawShaping: 0, clampedShaping: 0, finalReward: 0 },
          };
          const obs = resetSlot(slot, seeds[i], opponents[i], saveReplays[i]);
          slots.push(slot);
          const legal = getLegalActions(slot.match!, BLUE_ID);
          readySlots.push({ obs, legalMask: buildLegalMask(legal) });
        }
        send({ type: "ready", slots: readySlots });
        break;
      }

      case "step": {
        const actions = msg.actions as number[];
        if (actions.length !== slots.length) {
          send({ type: "error", message: `Expected ${slots.length} actions, got ${actions.length}` });
          return;
        }
        const resultSlots = slots.map((slot, i) => stepSlot(slot, actions[i]));
        send({ type: "step_result", slots: resultSlots });
        break;
      }

      case "close":
        process.exit(0);
        break;

      default:
        send({ type: "error", message: `Unknown message type: ${msg.type}` });
    }
  } catch (e) {
    send({ type: "error", message: `Error: ${(e as Error).message}` });
  }
});

rl.on("close", () => process.exit(0));
