// Runs ScriptedBotPlayer (the live beta scripted-bot driver) on both seats headlessly and
// prints each side's entity counts: proves the live wrapper plays like training.
//   npx tsx tools/measure/scripted_live_check.ts [botA] [botB] [ticks]
import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type PlayerSlot } from "../../server/src/match/types.js";
import { ScriptedBotPlayer } from "../../server/src/match/scriptedBotPlayer.js";
const [a = "rush1", b = "macro", n = "2000"] = process.argv.slice(2);
const engine = new MatchEngine();
const players: [PlayerSlot, PlayerSlot] = [
  { playerId: "pa", username: a, color: "blue", score: 0 }, { playerId: "pb", username: b, color: "red", score: 0 },
];
const m = engine.createMatch("chk", players, { ...DEFAULT_CONFIG, mapId: "shardfall", ruleset: "beta" }, 7);
engine.startMatch(m.id);
const bots = [new ScriptedBotPlayer(a, "pa", m.id, engine), new ScriptedBotPlayer(b, "pb", m.id, engine)];
for (let t = 0; t < Number(n) && m.phase === "playing"; t++) { for (const x of bots) x.tick(); engine.tick(m.id); }
for (const p of ["pa", "pb"]) {
  const c: Record<string, number> = {};
  for (const e of m.entities.values()) if (e.ownerId === p) { const k = e.type === "building" ? e.buildingType! : e.type; c[k] = (c[k] ?? 0) + 1; }
  console.log(p, JSON.stringify(c));
}
console.log("tick", m.tick, "phase", m.phase, "result", JSON.stringify(m.result));
