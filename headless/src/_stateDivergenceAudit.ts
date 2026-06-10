import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { PlayerSlot, MatchState } from "../../server/src/match/types.js";
import { MediumRushBot } from "./bots/mediumRushBot.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";
import type { Agent, MacroAction } from "./types.js";

// ── C.3 #7 (state-level): first-divergence tracer ──────────────────────────
// blue and red start from an exact mirror-symmetric state (C.1 #13). Their
// own-side scalar features (counts, resources, supply — which require no
// x-mirroring to compare) should be IDENTICAL at every tick if no asymmetry
// has acted yet. Find the first tick where they diverge, and by how much.

const seed = Number(process.argv[2] ?? 1);
const auditTicks = Number(process.argv[3] ?? 6000);

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

let firstDivergenceTick: number | null = null;
let divergenceCount = 0;
const samples: string[] = [];

while (match.phase === "playing" && match.tick < auditTicks) {
  const obsBlue = buildObservation(match, blueId);
  const obsRed = buildObservation(match, redId);
  const legalBlue = getLegalActions(match, blueId);
  const legalRed = getLegalActions(match, redId);
  const actionsBlue = blue.step(obsBlue, legalBlue);
  const actionsRed = red.step(obsRed, legalRed);

  // ── compare own-side scalar features BEFORE applying actions ──
  const gB = obsBlue.global, gR = obsRed.global;
  const fields: [string, number, number][] = [
    ["ownResources", gB.ownResources, gR.ownResources],
    ["ownSupply", gB.ownSupply, gR.ownSupply],
    ["ownMaxSupply", gB.ownMaxSupply, gR.ownMaxSupply],
    ["ownCrystalHealthFrac", gB.ownCrystalHealthFrac, gR.ownCrystalHealthFrac],
    ["ownLifetimeResourcesFrac", gB.ownLifetimeResourcesFrac, gR.ownLifetimeResourcesFrac],
    ["ownCombatInOwnHalf", gB.ownCombatInOwnHalf, gR.ownCombatInOwnHalf],
  ];
  const ownEntities = (obs: typeof obsBlue) => obs.entities.filter(e => e.owner === 1);
  const countByType = (obs: typeof obsBlue, t: number) => ownEntities(obs).filter(e => e.typeIndex === t).length;
  for (let t = 1; t <= 9; t++) {
    fields.push([`ownTypeCount[${t}]`, countByType(obsBlue, t), countByType(obsRed, t)]);
  }
  // action lists (symbolic, should be deep-equal)
  const actionsBlueStr = JSON.stringify(actionsBlue);
  const actionsRedStr = JSON.stringify(actionsRed);

  let tickDiverged = false;
  for (const [name, b, r] of fields) {
    if (Math.abs(b - r) > 1e-9) {
      tickDiverged = true;
      if (samples.length < 20) samples.push(`tick ${match.tick}: ${name} blue=${b} red=${r}`);
    }
  }
  if (actionsBlueStr !== actionsRedStr) {
    tickDiverged = true;
    if (samples.length < 20) samples.push(`tick ${match.tick}: actions blue=${actionsBlueStr} red=${actionsRedStr}`);
  }
  if (tickDiverged) {
    divergenceCount++;
    if (firstDivergenceTick === null) firstDivergenceTick = match.tick;
  }

  if (match.tick % 2 === 0) {
    applyActions(engine, match.id, blueId, actionsBlue, match);
    applyActions(engine, match.id, redId, actionsRed, match);
  } else {
    applyActions(engine, match.id, redId, actionsRed, match);
    applyActions(engine, match.id, blueId, actionsBlue, match);
  }

  engine.tick(match.id);
}

console.log(`Checked ticks 0-${match.tick} (seed=${seed}, final phase=${match.phase})`);
console.log(`First divergence tick: ${firstDivergenceTick ?? "none"}`);
console.log(`Total diverging ticks: ${divergenceCount}`);
console.log("");
for (const line of samples) console.log("  " + line);
