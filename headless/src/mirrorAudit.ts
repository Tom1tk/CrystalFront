/**
 * Experiment 4 (Appendix C) — mirror-invariance property-test sweep.
 *
 * Runs a real rush_medium-vs-rush_medium match and, at each tick, checks
 * whether tick(mirrorState(s)) ~= mirrorState(tick(s)). Aggregates
 * divergences by engine system (movement/combat/gathering/construction/...)
 * across the whole match so ALL violating systems are catalogued, not just
 * the first.
 *
 * Usage: npx tsx headless/src/mirrorAudit.ts [seed] [auditTicks]
 */
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
const auditTicks = Number(process.argv[3] ?? 300);

function applyActions(
  engine: MatchEngine,
  matchId: string,
  playerId: string,
  actions: MacroAction[],
  match: MatchState,
): void {
  for (const action of actions) {
    const commands = expandMacroAction(action, match, playerId);
    for (const cmd of commands) {
      engine.processCommand(matchId, playerId, cmd as Parameters<MatchEngine["processCommand"]>[2]);
    }
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

const bySystem = new Map<string, { count: number; firstTick: number; sample: string }>();
let sampledTicks = 0;

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

  // ── Mirror-invariance property check, BEFORE advancing the real match ──
  const s = deepCloneMatchState(match);
  const preExistingIds = new Set(s.entities.keys());

  const engA = new MatchEngine();
  (engA as unknown as { matches: Map<string, MatchState> }).matches.set(s.id, deepCloneMatchState(s));
  engA.tick(s.id);
  const a = (engA as unknown as { matches: Map<string, MatchState> }).matches.get(s.id)!;

  const engB = new MatchEngine();
  (engB as unknown as { matches: Map<string, MatchState> }).matches.set(s.id, mirrorState(s));
  engB.tick(s.id);
  const b = (engB as unknown as { matches: Map<string, MatchState> }).matches.get(s.id)!;

  const diffs = diffStates(mirrorState(a), b, preExistingIds);
  sampledTicks++;
  for (const d of diffs) {
    const entry = bySystem.get(d.system);
    if (!entry) {
      bySystem.set(d.system, { count: 1, firstTick: match.tick + 1, sample: d.detail });
    } else {
      entry.count++;
    }
  }

  // ── Advance the real match ──
  engine.tick(match.id);
}

console.log(`Audited ${sampledTicks} ticks (seed=${seed}, final match.tick=${match.tick}, phase=${match.phase})`);
console.log(`Final result so far: ${JSON.stringify(match.result)}`);
console.log("");
if (bySystem.size === 0) {
  console.log("No mirror-invariance violations found across all sampled ticks.");
} else {
  console.log("Violations by system:");
  for (const [system, info] of [...bySystem.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${system}: ${info.count} diffs, first at tick ${info.firstTick}`);
    console.log(`    e.g. ${info.sample}`);
  }
}
