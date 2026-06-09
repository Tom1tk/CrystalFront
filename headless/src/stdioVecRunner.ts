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
import type { LegalActionsOpts } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";
import { indexToAction, legalMask as buildLegalMask } from "./actionIndex.js";
import { IdleBot, RushBot, WeakRushBot, MediumRushBot, PassiveBot, TurtleBot, MacroBot, HeavyBot } from "./bots/index.js";
import type { Agent, PlayerObservation, MacroAction } from "./types.js";
import { type Milestones, freshMilestones, computeReward } from "./reward.js";

interface PrePlace { barracks: boolean; units: string[] }

function performPreSetup(m: MatchState, eng: MatchEngine, pre: PrePlace): void {
  if (!pre.barracks && pre.units.length === 0) return;
  const pidx = m.players.findIndex(p => p?.playerId === BLUE_ID);
  const econ = m.economy[pidx];
  if (!econ) return;

  // Cap at 400 — enough for barracks (75) + units (50 each), below passive-win threshold (4500).
  econ.resources = 400;
  econ.maxSupply = Math.max(econ.maxSupply, 10 + pre.units.length * 2);

  const buildCmds = expandMacroAction({ type: "build", buildingType: "barracks", xZone: "near_crystal" } as MacroAction, m, BLUE_ID);
  for (const cmd of buildCmds) eng.processCommand(m.id, BLUE_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);

  for (let t = 0; t < 300 && m.phase === "playing"; t++) {
    const done = [...m.entities.values()].find(e =>
      e.ownerId === BLUE_ID && e.type === "building" && e.buildingType === "barracks" && e.constructionProgress >= 100
    );
    if (done) break;
    eng.tick(m.id);
  }

  for (const unitType of pre.units) {
    econ.resources = 400;
    const trainCmds = expandMacroAction({ type: "train_unit", unitType } as MacroAction, m, BLUE_ID);
    for (const cmd of trainCmds) eng.processCommand(m.id, BLUE_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);

    const prevCount = [...m.entities.values()].filter(e => e.ownerId === BLUE_ID && e.type === unitType).length;
    for (let t = 0; t < 150 && m.phase === "playing"; t++) {
      const currCount = [...m.entities.values()].filter(e => e.ownerId === BLUE_ID && e.type === unitType).length;
      if (currCount > prevCount) break;
      eng.tick(m.id);
    }
  }

  econ.resources = m.config.startingResources;
}

const REPO_ROOT   = resolve(__dirnameHere, "..", "..");
const REPLAYS_DIR = resolve(REPO_ROOT, "replays");

const BLUE_ID        = "headless-blue";
const RED_ID         = "headless-red";
let MAX_TICKS        = 6000;
let ACTION_FORCING_SCALE = 0.0;  // read from reset_all; 0 = forcing off

// ── per-slot state ────────────────────────────────────────────────────────────

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
  episodeShaping: number;
  lastTerminalReturn: number;
  episodeActionCounts: Record<string, number>;
  episodeTotalActions: number;
  prePlace?: PrePlace;
  noopStreak: number;
  trainUnitStreak: number;  // ticks since last train_unit action (Variant β')
  cfgOverrides?: Partial<import("../../server/src/match/types.js").MatchConfig>;
  botCrashCount: number;
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


// ── slot lifecycle ────────────────────────────────────────────────────────────

function resetSlot(slot: SlotState, seed: number | undefined, opponent: string, doSave: boolean, configOverrides?: Partial<import("../../server/src/match/types.js").MatchConfig>, prePlace?: PrePlace): PlayerObservation {
  slot.milestones         = freshMilestones();
  slot.episodeShaping     = 0;
  slot.lastTerminalReturn = 0;
  slot.episodeActionCounts = {};
  slot.episodeTotalActions = 0;
  slot.noopStreak         = 0;
  slot.trainUnitStreak    = 0;
  slot.botCrashCount      = 0;
  slot.opponentName       = opponent.toLowerCase();
  slot.saveReplay         = doSave;
  slot.commandLog         = [];
  slot.engine             = new MatchEngine();

  const effectiveSeed = (seed != null && isFinite(seed)) ? seed : Math.floor(Math.random() * 0xffffffff);
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: BLUE_ID, username: "Blue", color: "blue", score: 0 },
    { playerId: RED_ID,  username: "Red",  color: "red",  score: 0 },
  ];
  const matchCfg = configOverrides ? { ...DEFAULT_CONFIG, ...configOverrides } : DEFAULT_CONFIG;
  slot.match  = slot.engine.createMatch("headless", players, matchCfg, effectiveSeed);
  slot.engine.startMatch(slot.match.id);
  slot.redBot = makeBot(opponent);
  slot.redBot.init(RED_ID, slot.match);

  if (prePlace) performPreSetup(slot.match, slot.engine, prePlace);

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
  slot.noopStreak = macroAction.type === "noop" ? slot.noopStreak + 1 : 0;
  slot.trainUnitStreak = macroAction.type === "train_unit" ? 0 : slot.trainUnitStreak + 1;

  const blueCmds = expandMacroAction(macroAction, match, BLUE_ID);
  for (const cmd of blueCmds) {
    const result = engine.processCommand(match.id, BLUE_ID, cmd as Parameters<MatchEngine["processCommand"]>[2]);
    if (result.success) slot.commandLog.push({ tick: match.tick, playerId: BLUE_ID, command: cmd as Record<string, unknown> });
  }

  const redObs   = buildObservation(match, RED_ID);
  const redLegal = getLegalActions(match, RED_ID);
  let redActions: ReturnType<typeof redBot.step> = [];
  try {
    redActions = redBot.step(redObs, redLegal);
  } catch (e) {
    process.stderr.write(`[bot crash] ${slot.opponentName}: ${(e as Error).message}\n`);
    slot.botCrashCount++;
  }
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
  const { reward, terminalReturn, shapingReturn } = computeReward(prevBlueObs, blueObs, done, winner, winType, slot.milestones, BLUE_ID);
  slot.episodeShaping += shapingReturn;
  if (done) slot.lastTerminalReturn = terminalReturn;
  slot.prevBlueObs = blueObs;

  const info: Record<string, unknown> = {};

  if (done) {
    info.winner      = winner;
    info.winType     = winType;
    info.botCrashCount = slot.botCrashCount;
    info.seed        = match.seed;
    info.opponentType = slot.opponentName;

    const isCombatWin = winner === BLUE_ID && winType !== "resource";
    info.episodeOutcome = isCombatWin ? "combat_win"
      : winner === BLUE_ID ? "resource_win"
      : winner !== null    ? "loss"
      : "timeout";

    info.terminalReward   = slot.lastTerminalReturn;
    info.rawShapingReward = slot.episodeShaping;
    info.finalReward      = slot.lastTerminalReturn + slot.episodeShaping;

    info.firstBarracksTick        = slot.milestones.firstBarracksTick;
    info.firstCombatUnitTick      = slot.milestones.firstCombatUnitTick;
    info.firstEnemyCrystalHitTick = slot.milestones.firstAttackTick;
    info.enemyCrystalDamagePct    = Math.round((1 - slot.milestones.minOppCrystalHealthFrac) * 1000) / 10;
    info.ownCrystalDamagePct      = Math.round((1 - slot.milestones.minOwnCrystalHealthFrac) * 1000) / 10;

    const tot = slot.episodeTotalActions || 1;
    info.noopRate         = (slot.episodeActionCounts["noop"]           ?? 0) / tot;
    info.trainUnitRate    = (slot.episodeActionCounts["train_unit"]      ?? 0) / tot;
    info.attackMoveRate   = (slot.episodeActionCounts["attack_move"]     ?? 0) / tot;
    info.attackTargetRate = (slot.episodeActionCounts["attack_targeted"] ?? 0) / tot;
    info.retreatRate      = (slot.episodeActionCounts["retreat"]         ?? 0) / tot;
    info.holdPosRate      = (slot.episodeActionCounts["hold_position"]   ?? 0) / tot;

    if (slot.milestones.minOppCrystalHealthFrac >= 1.0) info.warn_no_pressure = true;
    if (!isCombatWin && (slot.lastTerminalReturn + slot.episodeShaping) > 0) info.warn_loss_positive_reward = true;

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
    const nextObs    = resetSlot(slot, undefined, slot.opponentName, doNextSave, slot.cfgOverrides, slot.prePlace);
    const forcingOpts: LegalActionsOpts = ACTION_FORCING_SCALE > 0
      ? { noopStreak: slot.noopStreak, trainUnitStreak: slot.trainUnitStreak, forcingScale: ACTION_FORCING_SCALE }
      : {};
    const nextLegal  = getLegalActions(slot.match!, BLUE_ID, forcingOpts);
    const nextCfg = slot.match!.config;
    info.nextEpisodeConfig = { mapWidth: nextCfg.mapWidth, crystalHealth: nextCfg.crystalHealth, startingResources: nextCfg.startingResources };
    return { obs: nextObs, legalMask: buildLegalMask(nextLegal), reward, done, info };
  }

  const forcingOpts: LegalActionsOpts = ACTION_FORCING_SCALE > 0
    ? { noopStreak: slot.noopStreak, trainUnitStreak: slot.trainUnitStreak, forcingScale: ACTION_FORCING_SCALE }
    : {};
  const legal = getLegalActions(match, BLUE_ID, forcingOpts);
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
        const cfgOverrides = msg.config_overrides as Partial<import("../../server/src/match/types.js").MatchConfig> | undefined;
        const prePlaceMsg  = msg.pre_place as PrePlace | undefined;
        if (msg.max_ticks !== undefined) MAX_TICKS = msg.max_ticks as number;
        if (msg.action_forcing_scale !== undefined) ACTION_FORCING_SCALE = msg.action_forcing_scale as number;

        slots = [];
        const readySlots: { obs: PlayerObservation; legalMask: boolean[]; config: { mapWidth: number; crystalHealth: number; startingResources: number } }[] = [];
        for (let i = 0; i < n; i++) {
          const slot: SlotState = {
            engine: new MatchEngine(),
            match: null, redBot: null, prevBlueObs: null,
            opponentName: opponents[i],
            saveReplay: saveReplays[i],
            saveReplayEvery: saveEvery,
            episodeCount: i,
            commandLog: [],
            milestones: freshMilestones(),
            episodeShaping: 0,
            lastTerminalReturn: 0,
            episodeActionCounts: {}, episodeTotalActions: 0,
            prePlace: prePlaceMsg,
            noopStreak: 0,
            trainUnitStreak: 0,
            cfgOverrides: cfgOverrides,
            botCrashCount: 0,
          };
          const obs = resetSlot(slot, seeds[i], opponents[i], saveReplays[i], cfgOverrides, prePlaceMsg);
          slots.push(slot);
          const legal = getLegalActions(slot.match!, BLUE_ID);
          const cfg = slot.match!.config;
          readySlots.push({ obs, legalMask: buildLegalMask(legal), config: { mapWidth: cfg.mapWidth, crystalHealth: cfg.crystalHealth, startingResources: cfg.startingResources } });
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

      case "set_forcing_scale": {
        ACTION_FORCING_SCALE = (msg.scale as number) ?? 0.0;
        send({ type: "ack_forcing_scale", scale: ACTION_FORCING_SCALE });
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
