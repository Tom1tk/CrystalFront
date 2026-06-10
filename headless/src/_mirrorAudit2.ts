import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { PlayerSlot, MatchState } from "../../server/src/match/types.js";
import { mirrorState, deepCloneMatchState, diffStates } from "../../server/src/match/engine/mirror.js";
import { MediumRushBot } from "./bots/mediumRushBot.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";
import type { Agent, MacroAction } from "./types.js";

const seed = Number(process.argv[2] ?? 1);
const auditTicks = Number(process.argv[3] ?? 6000);
const eps = Number(process.argv[4] ?? 1e-6);

function applyActions(engine: MatchEngine, matchId: string, playerId: string, actions: MacroAction[], match: MatchState): void {
  for (const action of actions) {
    const commands = expandMacroAction(action, match, playerId);
    for (const cmd of commands) engine.processCommand(matchId, playerId, cmd as any);
  }
}

const engine = new MatchEngine();
const blueId = "headless-blue";
const redId = "headless-red";
const players: [PlayerSlot | null, PlayerSlot | null] = [
  { playerId: blueId, username: "Blue", color: "blue", score: 0 },
  { playerId: redId, username: "Red", color: "red", score: 0 },
];
const config = { ...DEFAULT_CONFIG, maxTicks: 6000 };
const match = engine.createMatch("audit", players, config, seed);
engine.startMatch(match.id);

const blue: Agent = new MediumRushBot();
const red: Agent = new MediumRushBot();
blue.init(blueId, match);
red.init(redId, match);

const samples = new Map<string, string[]>();

while (match.phase === "playing" && match.tick < auditTicks) {
  const obsBlue = buildObservation(match, blueId);
  const obsRed = buildObservation(match, redId);
  const legalBlue = getLegalActions(match, blueId);
  const legalRed = getLegalActions(match, redId);
  const actionsBlue = blue.step(obsBlue, legalBlue);
  const actionsRed = red.step(obsRed, legalRed);

  if (match.tick % 2 === 0) {
    applyActions(engine, match.id, blueId, actionsBlue, match);
    applyActions(engine, match.id, redId, actionsRed, match);
  } else {
    applyActions(engine, match.id, redId, actionsRed, match);
    applyActions(engine, match.id, blueId, actionsBlue, match);
  }

  const s = deepCloneMatchState(match);
  const preExistingIds = new Set(s.entities.keys());

  const engA = new MatchEngine();
  (engA as any).matches.set(s.id, deepCloneMatchState(s));
  engA.tick(s.id);
  const a = (engA as any).matches.get(s.id)!;

  const engB = new MatchEngine();
  (engB as any).matches.set(s.id, mirrorState(s));
  engB.tick(s.id);
  const b = (engB as any).matches.get(s.id)!;

  const diffs = diffStates(mirrorState(a), b, preExistingIds, eps);
  for (const d of diffs) {
    const arr = samples.get(d.system) ?? [];
    if (arr.length < 8) arr.push(`tick ${match.tick + 1}: ${d.detail}`);
    samples.set(d.system, arr);
  }

  engine.tick(match.id);
}

console.log(`final tick=${match.tick} phase=${match.phase} result=${JSON.stringify(match.result)}`);
for (const [sys, arr] of samples) {
  console.log(`\n${sys}:`);
  for (const line of arr) console.log(`  ${line}`);
}
