import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { PlayerSlot, MatchState } from "../../server/src/match/types.js";
import { MediumRushBot } from "./bots/mediumRushBot.js";
import { buildObservation } from "./observation.js";
import { getLegalActions } from "./legalActions.js";
import { expandMacroAction } from "./actionSpace.js";
import type { Agent, MacroAction } from "./types.js";

// ── H7 trace: dump worker counts / resources / gatherer-slot assignments
// for ticks 0-70 to find exactly when/why blue vs red gathering rates diverge.

const seed = Number(process.argv[2] ?? 1);
const maxTick = Number(process.argv[3] ?? 70);

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

const mid = match.mapWidth / 2;

while (match.phase === "playing" && match.tick <= maxTick) {
  const obsBlue = buildObservation(match, blueId);
  const obsRed = buildObservation(match, redId);
  const legalBlue = getLegalActions(match, blueId);
  const legalRed = getLegalActions(match, redId);
  const actionsBlue = blue.step(obsBlue, legalBlue);
  const actionsRed = red.step(obsRed, legalRed);

  const workersBlue = [...match.entities.values()].filter(e => e.type === "worker" && e.ownerId === blueId);
  const workersRed = [...match.entities.values()].filter(e => e.type === "worker" && e.ownerId === redId);

  const blueGatherTargets = new Set(workersBlue.map(w => w.gatheringNodeId).filter(Boolean));
  const redGatherTargets = new Set(workersRed.map(w => w.gatheringNodeId).filter(Boolean));

  const economyBlue = match.economy[match.players.findIndex(p => p?.playerId === blueId)];
  const economyRed = match.economy[match.players.findIndex(p => p?.playerId === redId)];

  const actionsBlueStr = JSON.stringify(actionsBlue);
  const actionsRedStr = JSON.stringify(actionsRed);

  console.log(
    `tick ${match.tick}: ` +
    `blueWorkers=${workersBlue.length} (gathering@${[...blueGatherTargets].join(",")}) res=${economyBlue?.resources} | ` +
    `redWorkers=${workersRed.length} (gathering@${[...redGatherTargets].join(",")}) res=${economyRed?.resources}` +
    (actionsBlueStr !== actionsRedStr ? `  ACTIONS DIFFER: blue=${actionsBlueStr} red=${actionsRedStr}` : "")
  );

  for (const node of match.resourceNodes) {
    if (node.gathererSlots.size === 0) continue;
    const side = node.x < mid ? "blue-side" : "red-side";
    console.log(`    node ${node.id} (${side}, x=${node.x}, y=${node.y}, r=${node.radius}) slots=${node.gathererSlots.size}/${node.maxGathererSlots} accum=${(node.accumulatedGather ?? 0).toFixed(3)} remaining=${node.remaining}`);
  }

  // Trace the 4th workers (e11/e15 gatherers) specifically
  for (const w of workersBlue) {
    if (w.gatheringNodeId === "e11") {
      const n = match.resourceNodes.find(n => n.id === "e11")!;
      const d = Math.hypot(w.x - n.x, w.y - n.y);
      console.log(`    BLUE 4th worker ${w.id}: pos=(${w.x.toFixed(3)},${w.y.toFixed(3)}) moveTarget=${JSON.stringify(w.moveTarget)} distToNode=${d.toFixed(3)}`);
    }
  }
  for (const w of workersRed) {
    if (w.gatheringNodeId === "e15") {
      const n = match.resourceNodes.find(n => n.id === "e15")!;
      const d = Math.hypot(w.x - n.x, w.y - n.y);
      console.log(`    RED 4th worker ${w.id}: pos=(${w.x.toFixed(3)},${w.y.toFixed(3)}) moveTarget=${JSON.stringify(w.moveTarget)} distToNode=${d.toFixed(3)}`);
    }
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
