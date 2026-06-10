import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { PlayerSlot, MatchState } from "../../server/src/match/types.js";
import { mirrorState, deepCloneMatchState } from "../../server/src/match/engine/mirror.js";
import { MediumRushBot } from "./bots/mediumRushBot.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction, chooseBuildPosition } from "./actionSpace.js";
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

const XZONES: NonNullable<MacroAction["xZone"]>[] = ["near_crystal", "mid_base", "forward"];
const YZONES: NonNullable<MacroAction["yZone"]>[] = ["top", "middle", "bottom"];

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
function record(zoneKey: string, label: string, actual: Pos, expected: Pos): void {
  const samples = violations.get(zoneKey) ?? [];
  check(actual, expected, label, samples);
  violations.set(zoneKey, samples);
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

  // ── chooseBuildPosition mirror-equivariance check, BEFORE advancing ──
  const s = deepCloneMatchState(match);
  const m = mirrorState(s);
  const mapW = s.mapWidth;

  for (const xZone of XZONES) {
    for (const yZone of YZONES) {
      const posBlueOrig = chooseBuildPosition("blue", xZone, yZone, s);
      const posRedOrig = chooseBuildPosition("red", xZone, yZone, s);
      const posBlueMirror = chooseBuildPosition("blue", xZone, yZone, m);
      const posRedMirror = chooseBuildPosition("red", xZone, yZone, m);

      const zoneKey = `${xZone}/${yZone}`;
      record(zoneKey, `tick ${s.tick} blue@mirror vs mirror(red@orig)`, posBlueMirror, mirrorPos(posRedOrig, mapW));
      record(zoneKey, `tick ${s.tick} red@mirror vs mirror(blue@orig)`, posRedMirror, mirrorPos(posBlueOrig, mapW));
    }
  }
  checkedStates++;

  engine.tick(match.id);
}

console.log(`Checked ${checkedStates} states (seed=${seed}, eps=${eps}, final match.tick=${match.tick}, phase=${match.phase})`);
console.log("");
if ([...violations.values()].every((v) => v.length === 0)) {
  console.log("No chooseBuildPosition mirror-equivariance violations found.");
} else {
  console.log("Violations by xZone/yZone:");
  for (const [zoneKey, samples] of violations) {
    if (samples.length === 0) continue;
    console.log(`  ${zoneKey}: ${samples.length}+ samples`);
    for (const line of samples) console.log(`    ${line}`);
  }
}
