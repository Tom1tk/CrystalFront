import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { MatchConfig, PlayerSlot } from "../../server/src/match/types.js";
import type { Agent, MatchResult, MacroAction } from "./types.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";

const DEFAULT_MAX_TICKS = 6000; // 10 min at 10 Hz

export interface RunMatchOptions {
  seed?: number;
  maxTicks?: number;
  config?: MatchConfig;
}

export function runMatch(
  agentBlue: Agent,
  agentRed: Agent,
  options: RunMatchOptions = {}
): MatchResult {
  const { seed, maxTicks = DEFAULT_MAX_TICKS, config = DEFAULT_CONFIG } = options;

  const engine = new MatchEngine();

  // Stable player IDs for headless use
  const blueId = "headless-blue";
  const redId = "headless-red";

  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: blueId, username: "Blue", color: "blue", score: 0 },
    { playerId: redId,  username: "Red",  color: "red",  score: 0 },
  ];

  const match = engine.createMatch("headless", players, config, seed);
  engine.startMatch(match.id);

  agentBlue.init(blueId, match);
  agentRed.init(redId, match);

  const startMs = Date.now();

  while (match.phase === "playing" && match.tick < maxTicks) {
    // Build observations (with fog applied)
    const obsBlue = buildObservation(match, blueId);
    const obsRed  = buildObservation(match, redId);

    // Get legal actions per player
    const legalBlue = getLegalActions(match, blueId);
    const legalRed  = getLegalActions(match, redId);

    // Ask each agent for their macro-actions this tick
    const actionsBlue = agentBlue.step(obsBlue, legalBlue);
    const actionsRed  = agentRed.step(obsRed, legalRed);

    // Expand macro-actions to raw commands and apply
    applyActions(engine, match.id, blueId, actionsBlue, match);
    applyActions(engine, match.id, redId,  actionsRed,  match);

    // Advance simulation one tick
    engine.tick(match.id);
  }

  const winner = match.result?.winner ?? null;
  const winType = winner ? (match.result?.winType ?? "combat") : "timeout";
  const blueEntities = [...match.entities.values()].filter(e => e.ownerId === blueId).length;
  const redEntities  = [...match.entities.values()].filter(e => e.ownerId === redId).length;

  return {
    winner,
    winType,
    ticks: match.tick,
    durationMs: Date.now() - startMs,
    commandLog: match.commandLog,
    finalEntityCount: [blueEntities, redEntities],
    seed: match.seed,
  };
}

function applyActions(
  engine: MatchEngine,
  matchId: string,
  playerId: string,
  actions: MacroAction[],
  match: ReturnType<MatchEngine["getMatch"]> & object
): void {
  for (const action of actions) {
    const commands = expandMacroAction(action, match, playerId);
    for (const cmd of commands) {
      engine.processCommand(matchId, playerId, cmd as Parameters<MatchEngine["processCommand"]>[2]);
    }
  }
}
