import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { PlayerSlot } from "../../server/src/match/types.js";
import { mirrorState, deepCloneMatchState, diffStates } from "../../server/src/match/engine/mirror.js";

const seed = Number(process.argv[2] ?? 1);

const engine = new MatchEngine();
const blueId = "headless-blue";
const redId = "headless-red";
const players: [PlayerSlot | null, PlayerSlot | null] = [
  { playerId: blueId, username: "Blue", color: "blue", score: 0 },
  { playerId: redId, username: "Red", color: "red", score: 0 },
];
const config = { ...DEFAULT_CONFIG, maxTicks: 6000 };
const match = engine.createMatch("audit", players, config, seed);

// Check: is the initial state already its own mirror image (with colors swapped)?
const m = mirrorState(deepCloneMatchState(match));
const allIds = new Set(match.entities.keys());

console.log(`mapWidth=${match.mapWidth}`);
console.log("\nEntities (original):");
for (const e of match.entities.values()) {
  console.log(`  ${e.id} ${e.type} owner=${e.ownerId} x=${e.x} y=${e.y} radius=${e.radius}`);
}
console.log("\nEntities (mirrorState):");
for (const e of m.entities.values()) {
  console.log(`  ${e.id} ${e.type} owner=${e.ownerId} x=${e.x} y=${e.y} radius=${e.radius}`);
}

console.log("\nResource nodes (original):");
for (const n of match.resourceNodes) console.log(`  ${n.id} x=${n.x} y=${n.y} remaining=${n.remaining}`);
console.log("\nResource nodes (mirrorState):");
for (const n of m.resourceNodes) console.log(`  ${n.id} x=${n.x} y=${n.y} remaining=${n.remaining}`);

// diff: expected = mirrorState(match) [i.e. m], actual = match itself, with colors implicitly swapped
// We want: for each entity owned by blueId at (x,y), is there an entity owned by redId at (mapW-x,y) of the same type, and vice versa?
const mapW = match.mapWidth;
console.log("\nCross-check: for each blue entity, is there a matching mirrored red entity (same type, x'=mapW-x, y'=y)?");
const reds = [...match.entities.values()].filter(e => e.ownerId === redId);
const blues = [...match.entities.values()].filter(e => e.ownerId === blueId);
for (const b of blues) {
  const match2 = reds.find(r => r.type === b.type && Math.abs(r.x - (mapW - b.x)) < 1e-6 && Math.abs(r.y - b.y) < 1e-6);
  console.log(`  blue ${b.id} ${b.type} (${b.x},${b.y}) -> mirror=(${mapW-b.x},${b.y}) : ${match2 ? `MATCHES red ${match2.id}` : "NO MATCH"}`);
}
if (blues.length !== reds.length) console.log(`  COUNT MISMATCH: blue=${blues.length} red=${reds.length}`);
