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
import { indexToAction, actionToIndex, legalMask as buildLegalMask } from "./actionIndex.js";
import { IdleBot, RushBot, WeakRushBot, MediumRushBot, PassiveBot, TurtleBot, MacroBot, HeavyBot } from "./bots/index.js";
import { UNIT_DEFS, BUILDING_DEFS } from "@crystalfront/shared";
import type { Agent, PlayerObservation } from "./types.js";
import { type Milestones, freshMilestones, computeReward } from "./reward.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, "..", "..");
const REPLAYS_DIR = resolve(REPO_ROOT, "replays");

const BLUE_ID        = "headless-blue";
const RED_ID         = "headless-red";
let MAX_TICKS        = 6000;

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

interface PrePlace { barracks: boolean; units: string[] }

function performPreSetup(m: MatchState, eng: MatchEngine, pre: PrePlace): void {
  if (!pre.barracks && pre.units.length === 0) return;
  const pidx = m.players.findIndex(p => p?.playerId === BLUE_ID);
  const econ = m.economy[pidx];
  if (!econ) return;

  // Grant enough resources and supply for the setup
  econ.resources = 9999;
  econ.maxSupply = Math.max(econ.maxSupply, 10 + pre.units.length * 2);

  // Build barracks — reuse existing action expansion so position logic is correct
  const buildCmds = expandMacroAction({ type: "build", buildingType: "barracks", xZone: "near_crystal" } as MacroAction, m, BLUE_ID);
  for (const cmd of buildCmds) eng.processCommand(m.id, BLUE_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);

  // Tick until barracks complete (buildTime ≈ 150 ticks)
  for (let t = 0; t < 300 && m.phase === "playing"; t++) {
    const done = [...m.entities.values()].find(e =>
      e.ownerId === BLUE_ID && e.type === "building" && e.buildingType === "barracks" && e.constructionProgress >= 100
    );
    if (done) break;
    eng.tick(m.id);
  }

  // Train each requested unit type one at a time
  for (const unitType of pre.units) {
    econ.resources = 9999;
    const trainCmds = expandMacroAction({ type: "train_unit", unitType } as MacroAction, m, BLUE_ID);
    for (const cmd of trainCmds) eng.processCommand(m.id, BLUE_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);

    const prevCount = [...m.entities.values()].filter(e => e.ownerId === BLUE_ID && e.type === unitType).length;
    for (let t = 0; t < 150 && m.phase === "playing"; t++) {
      const currCount = [...m.entities.values()].filter(e => e.ownerId === BLUE_ID && e.type === unitType).length;
      if (currCount > prevCount) break;
      eng.tick(m.id);
    }
  }

  // Restore economy to the configured starting amount
  econ.resources = m.config.startingResources;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ── per-episode state ─────────────────────────────────────────────────────────

let milestones: Milestones = freshMilestones();
let episodeShaping        = 0;
let lastTerminalReturn    = 0;
let episodeActionCounts: Record<string, number> = {};
let episodeTotalActions   = 0;


// ── match state ──────────────────────────────────────────────────────────────

let engine: MatchEngine | null = null;
let match: MatchState | null = null;
let redBot: Agent | null = null;
let blueBot: Agent | null = null;  // non-null in demo mode: scripted bot drives blue
let prevBlueObs: PlayerObservation | null = null;
let saveReplay = false;
let commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }> = [];

function handleReset(seed?: number, opponent?: string, doSave = false, configOverrides?: Partial<import("../../server/src/match/types.js").MatchConfig>, newMaxTicks?: number, demoBot?: string, prePlace?: PrePlace): void {
  milestones = freshMilestones();
  episodeShaping      = 0;
  lastTerminalReturn  = 0;
  episodeActionCounts = {};
  episodeTotalActions = 0;
  if (newMaxTicks !== undefined) MAX_TICKS = newMaxTicks;
  engine   = new MatchEngine();
  saveReplay = doSave;

  const effectiveSeed = (seed != null && isFinite(seed)) ? seed : Math.floor(Math.random() * 0xffffffff);

  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: BLUE_ID, username: "Blue", color: "blue", score: 0 },
    { playerId: RED_ID,  username: "Red",  color: "red",  score: 0 },
  ];

  const matchCfg = configOverrides ? { ...DEFAULT_CONFIG, ...configOverrides } : DEFAULT_CONFIG;
  match = engine.createMatch("headless", players, matchCfg, effectiveSeed);
  engine.startMatch(match.id);

  redBot = makeBot(opponent);
  redBot.init(RED_ID, match);

  // Demo mode: also drive blue with a scripted bot to collect demonstrations
  blueBot = demoBot ? makeBot(demoBot) : null;
  if (blueBot) blueBot.init(BLUE_ID, match);

  // Pre-place scaffolding (Phase A/B curriculum stages)
  if (prePlace) performPreSetup(match, engine, prePlace);

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

  // In demo mode, ignore Python's action — use the scripted blue bot instead
  let macroAction = indexToAction(actionIdx);
  let demoActionIdx = actionIdx;
  if (blueBot) {
    const blueLegal = getLegalActions(match, BLUE_ID);
    const botActions = blueBot.step(buildObservation(match, BLUE_ID), blueLegal);
    if (botActions.length > 0) {
      macroAction = botActions[0];
      demoActionIdx = actionToIndex(macroAction);
      if (demoActionIdx < 0) demoActionIdx = 0;  // fallback to noop if not found
    }
  }

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
  const { reward, terminalReturn, shapingReturn } = computeReward(prevBlueObs, blueObs, done, winner, winType, milestones, BLUE_ID);
  episodeShaping += shapingReturn;
  if (done) lastTerminalReturn = terminalReturn;
  prevBlueObs   = blueObs;

  const legal = getLegalActions(match, BLUE_ID);
  const info: Record<string, unknown> = { ticks: match.tick };
  if (blueBot) info.demoAction = demoActionIdx;

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
    info.terminalReward   = lastTerminalReturn;
    info.rawShapingReward = episodeShaping;
    info.finalReward      = lastTerminalReturn + episodeShaping;

    // Milestone ticks
    info.firstBarracksTick        = milestones.firstBarracksTick;
    info.firstCombatUnitTick      = milestones.firstCombatUnitTick;
    info.firstEnemyCrystalHitTick = milestones.firstAttackTick;

    // Crystal damage
    info.enemyCrystalDamagePct = Math.round((1 - milestones.minOppCrystalHealthFrac) * 1000) / 10;
    info.ownCrystalDamagePct   = Math.round((1 - milestones.minOwnCrystalHealthFrac) * 1000) / 10;

    // Action rates
    const tot = episodeTotalActions || 1;
    info.noopRate         = (episodeActionCounts["noop"]           ?? 0) / tot;
    info.trainUnitRate    = (episodeActionCounts["train_unit"]      ?? 0) / tot;
    info.attackMoveRate   = (episodeActionCounts["attack_move"]     ?? 0) / tot;
    info.attackTargetRate = (episodeActionCounts["attack_targeted"] ?? 0) / tot;
    info.retreatRate      = (episodeActionCounts["retreat"]         ?? 0) / tot;
    info.holdPosRate      = (episodeActionCounts["hold_position"]   ?? 0) / tot;

    if (milestones.minOppCrystalHealthFrac >= 1.0) info.warn_no_pressure = true;
    if (!isCombatWin && (lastTerminalReturn + episodeShaping) > 0) info.warn_loss_positive_reward = true;

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
        handleReset(msg.seed, msg.opponent, msg.save_replay === true, msg.config_overrides ?? undefined, msg.max_ticks ?? undefined, msg.demo_bot ?? undefined, msg.pre_place ?? undefined);
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
