import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { PlayerSlot, MatchState } from "../../server/src/match/types.js";
import { MediumRushBot } from "./bots/mediumRushBot.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction, resolveTargetZone, findNode } from "./actionSpace.js";
import type { Agent, MacroAction } from "./types.js";

// ── C.3 #7: direct decision-layer mirror-symmetry audit ────────────────────
// Property under test (no mirrorState involved): for any color-branching
// function f(color, match, ...) that returns a position, in a real
// rush_medium mirror match (mirror-symmetric since t=0, C.1 #13),
//   f("blue", s, ...) ~= mirrorPos(f("red", s, ...))
// at every tick. This is the direct prerequisite for a 50/50 mirror match
// (REVIVAL_PLAN.md Appendix C, H7). Checks the only two actionSpace
// position-resolvers MediumRushBot actually exercises (besides
// chooseBuildPosition, already covered by _buildPosAudit.ts):
//   - resolveTargetZone(zone, color, match, visibleIds) — all 5 zones
//   - findNode(match, playerId, choice, ownCrystal) — all 3 choices
//     (ownCrystal used as nearEntity: stationary, exact mirror pair)

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

const ZONES: NonNullable<MacroAction["targetZone"]>[] = ["enemy_crystal", "midfield", "contested_node", "enemy_army", "defend_crystal"];
const NODE_CHOICES: NonNullable<MacroAction["nodeChoice"]>[] = ["nearest_safe", "nearest_contested", "richest_visible"];

type Pos = { x: number; y: number } | null;
const close = (a: number, b: number) => Math.abs(a - b) <= eps;

function mirrorPos(p: Pos, mapW: number): Pos {
  return p ? { x: mapW - p.x, y: p.y } : null;
}

function check(actual: Pos, expected: Pos, label: string, samples: string[]): void {
  if (actual === null && expected === null) return;
  if (actual === null || expected === null) {
    if (samples.length < 8) samples.push(`${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} (null mismatch)`);
    return;
  }
  if (!close(actual.x, expected.x) || !close(actual.y, expected.y)) {
    if (samples.length < 8) {
      samples.push(`${label}: actual=(${actual.x},${actual.y}) expected=(${expected.x},${expected.y})`);
    }
  }
}

const violations = new Map<string, string[]>();
function record(key: string, label: string, actual: Pos, expected: Pos): void {
  const samples = violations.get(key) ?? [];
  check(actual, expected, label, samples);
  violations.set(key, samples);
}

let checkedStates = 0;

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

  // ── direct symmetry checks, BEFORE advancing ──
  const mapW = match.mapWidth;
  const allIds = new Set(match.entities.keys());

  for (const zone of ZONES) {
    const posBlue = resolveTargetZone(zone, "blue", match, allIds);
    const posRed = resolveTargetZone(zone, "red", match, allIds);
    record(`resolveTargetZone/${zone}`, `tick ${match.tick} blue vs mirror(red)`, posBlue, mirrorPos(posRed, mapW));
    record(`resolveTargetZone/${zone}`, `tick ${match.tick} red vs mirror(blue)`, posRed, mirrorPos(posBlue, mapW));
  }

  const ownCrystalBlue = [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === blueId);
  const ownCrystalRed = [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === redId);
  if (ownCrystalBlue && ownCrystalRed) {
    for (const choice of NODE_CHOICES) {
      const nodeBlue = findNode(match, blueId, choice, ownCrystalBlue);
      const nodeRed = findNode(match, redId, choice, ownCrystalRed);
      const posBlue: Pos = nodeBlue ? { x: nodeBlue.x, y: nodeBlue.y } : null;
      const posRed: Pos = nodeRed ? { x: nodeRed.x, y: nodeRed.y } : null;
      record(`findNode/${choice}`, `tick ${match.tick} blue vs mirror(red)`, posBlue, mirrorPos(posRed, mapW));
      record(`findNode/${choice}`, `tick ${match.tick} red vs mirror(blue)`, posRed, mirrorPos(posBlue, mapW));
    }
  }
  checkedStates++;

  engine.tick(match.id);
}

console.log(`Checked ${checkedStates} states (seed=${seed}, eps=${eps}, final match.tick=${match.tick}, phase=${match.phase})`);
console.log("");
if ([...violations.values()].every((v) => v.length === 0)) {
  console.log("No direct decision-layer mirror-symmetry violations found.");
} else {
  console.log("Violations by function/zone:");
  for (const [key, samples] of violations) {
    if (samples.length === 0) continue;
    console.log(`  ${key}: ${samples.length}+ samples`);
    for (const line of samples) console.log(`    ${line}`);
  }
}
