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
import type { PlayerSlot, MatchState } from "../../server/src/match/types.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";
import { indexToAction, legalMask as buildLegalMask } from "./actionIndex.js";
import { IdleBot, RushBot, TurtleBot, MacroBot, HeavyBot } from "./bots/index.js";
import { ECONOMY } from "@crystalfront/shared";
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
    case "idle":   return new IdleBot();
    case "rush":   return new RushBot();
    case "turtle": return new TurtleBot();
    case "macro":  return new MacroBot();
    case "heavy":  return new HeavyBot();
    default:       return new MacroBot();
  }
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function computeReward(
  prev: PlayerObservation,
  curr: PlayerObservation,
  done: boolean,
  winner: string | null,
  winType: string | null
): number {
  let r = 0;

  // Crystal damage dealt (only when enemy crystal was previously visible)
  if (prev.global.oppCrystalHealthFrac > 0) {
    const delta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (delta > 0) r += 0.001 * delta * CRYSTAL_MAX_HP;
  }
  // Crystal damage taken
  const ownDelta = prev.global.ownCrystalHealthFrac - curr.global.ownCrystalHealthFrac;
  if (ownDelta > 0) r -= 0.001 * ownDelta * CRYSTAL_MAX_HP;

  // Mining reward — uses lifetime resource delta (spending doesn't subtract)
  const miningDelta = curr.global.ownLifetimeResourcesFrac - prev.global.ownLifetimeResourcesFrac;
  if (miningDelta > 0) r += 0.0001 * miningDelta * (ECONOMY.passiveWinThreshold * 2);

  // Army supply advantage: raw supply difference
  r += 0.0005 * (curr.global.ownSupply - curr.global.oppVisibleSupply);

  // ── Kill / death signals ──────────────────────────────────────────────────

  // Separate enemy worker kills from enemy combat kills — different reward tiers
  // creates bodyguard incentive: combat units more valuable to kill than workers
  const enemyWorkersPrev = prev.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersCurr = curr.entities.filter(e => e.owner === -1 && e.typeIndex === 1).length;
  const enemyWorkersKilled = Math.max(0, enemyWorkersPrev - enemyWorkersCurr);

  const oppSupplyDelta = prev.global.oppVisibleSupply - curr.global.oppVisibleSupply;
  const combatKillDelta = Math.max(0, oppSupplyDelta - enemyWorkersKilled);
  if (combatKillDelta   > 0) r += 0.5  * combatKillDelta;    // combat unit kill
  if (enemyWorkersKilled > 0) r += 0.2  * enemyWorkersKilled; // worker kill (less — bodyguard)

  // Own worker death penalty — stronger than combat unit loss
  const ownWorkersPrev = prev.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersCurr = curr.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
  const ownWorkersLost = Math.max(0, ownWorkersPrev - ownWorkersCurr);
  if (ownWorkersLost > 0) r -= 0.8 * ownWorkersLost;

  // ── Worker behaviour ──────────────────────────────────────────────────────

  // Reward workers actively gathering — incentivises assigning them to nodes
  const gatheringWorkers = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex === 1 && e.isGathering
  ).length;
  r += 0.0003 * gatheringWorkers;

  // Idle worker penalty — workers doing absolutely nothing
  const idleWorkers = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex === 1 && !e.isGathering && !e.isBuilding && !e.isMoving
  ).length;
  if (idleWorkers > 0) r -= 0.0005 * idleWorkers;

  // ── Supply depot penalty ──────────────────────────────────────────────────
  // Penalise having supply headroom > 1 while completed depots exist.
  // Building a depot before you need it wastes resources and worker time.
  // Penalty only fires when headroom is well above cap — not a blanket "no depots" rule.
  const completedDepots = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex === 8 && e.constructionFrac >= 1
  ).length;
  if (completedDepots > 0) {
    const headroom = curr.global.ownMaxSupply - curr.global.ownSupply;
    if (headroom > 1) r -= 0.005 * (headroom - 1);
  }

  // ── Forward pressure ──────────────────────────────────────────────────────
  // Crystal damage reward requires fog-of-war on the enemy crystal first.
  // Without this, the agent never pushes forward and never finds the signal.
  const forwardCombat = curr.entities.filter(
    e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 5 && e.xNorm > 0.5
  ).length;
  r += 0.0005 * forwardCombat;

  // Time penalty — mild stall discouragement
  r -= 0.00005;

  // Terminal rewards
  if (done) {
    if (winner !== null) {
      r += winner === BLUE_ID ? 10.0 : -10.0;
    } else {
      // Timeout draw — treated identically to a loss. The agent must engage or die trying.
      r -= 10.0;
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
