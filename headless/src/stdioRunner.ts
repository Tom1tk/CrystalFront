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

  const oppSupplyDelta = prev.global.oppVisibleSupply - curr.global.oppVisibleSupply;
  const combatKillDelta = Math.max(0, oppSupplyDelta - enemyWorkersKilled);
  if (combatKillDelta    > 0) r += 0.3  * combatKillDelta;
  if (enemyWorkersKilled > 0) r += 0.2  * enemyWorkersKilled;

  const ownWorkersPrev = prev.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersCurr = curr.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersLost = Math.max(0, ownWorkersPrev - ownWorkersCurr);
  if (ownWorkersLost > 0) r -= 0.1 * ownWorkersLost;

  // Own combat unit lost
  const ownCombatPrevCount = prev.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
  const ownCombatCurrCount = curr.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
  const ownCombatUnitsLost = Math.max(0, ownCombatPrevCount - ownCombatCurrCount);
  if (ownCombatUnitsLost > 0) r -= 0.15 * ownCombatUnitsLost;

  // ── Damage-dealt reward ───────────────────────────────────────────────────
  // Fires only when actual HP damage lands. Excludes crystal (has its own signal).
  // Buildings rewarded at half rate. Coefficient per full healthFrac reduction:
  //   units/workers: 0.1 — buildings: 0.05
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
  r -= 0.00005;

  // ── One-time milestone bonuses ────────────────────────────────────────────

  if (!milestones.hasBuiltBarracks) {
    const hadBarracks = prev.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const hasBarracks = curr.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    if (!hadBarracks && hasBarracks) {
      r += 5.0;
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

  if (!milestones.hasTrainedCombatUnit) {
    if (ownCombatCurrCount > ownCombatPrevCount) {
      r += 2.0;
      milestones.hasTrainedCombatUnit = true;
      milestones.firstCombatUnitTick = curr.tick;
    }
  }

  // First time army reaches 3 units
  if (!milestones.hasThreeCombatUnits && ownCombat >= 3) {
    r += 2.0;
    milestones.hasThreeCombatUnits = true;
    milestones.firstThreeCombatUnitsTick = curr.tick;
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

function handleReset(seed?: number, opponent?: string, doSave = false): void {
  milestones = freshMilestones();
  episodeShaping         = 0;
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
