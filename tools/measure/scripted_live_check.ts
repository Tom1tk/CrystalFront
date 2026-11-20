// Runs ScriptedBotPlayer (the live beta scripted-bot driver) on both seats headlessly and
// prints each side's entity counts, plus a trace of each Outrider: proves the live wrapper
// plays like training and shows the §2a scout routine.
//   npx tsx tools/measure/scripted_live_check.ts [botA] [botB] [ticks] [map]
import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type PlayerSlot } from "../../server/src/match/types.js";
import { ScriptedBotPlayer } from "../../server/src/match/scriptedBotPlayer.js";
const [a = "rush1", b = "macro", n = "2000", map = "shardfall"] = process.argv.slice(2);
const engine = new MatchEngine();
const players: [PlayerSlot, PlayerSlot] = [
  { playerId: "pa", username: a, color: "blue", score: 0 }, { playerId: "pb", username: b, color: "red", score: 0 },
];
const m = engine.createMatch("chk", players, { ...DEFAULT_CONFIG, mapId: map, ruleset: "beta" }, 7);
engine.startMatch(m.id);
const bots = [new ScriptedBotPlayer(a, "pa", m.id, engine), new ScriptedBotPlayer(b, "pb", m.id, engine)];
const seen = new Set<string>();
for (let t = 0; t < Number(n) && m.phase === "playing"; t++) {
  for (const x of bots) x.tick();
  engine.tick(m.id);
  const now = new Set<string>();
  for (const e of m.entities.values()) if (e.type === "outrider") now.add(e.id);
  for (const id of seen) if (!now.has(id)) console.log(`t${m.tick} outrider ${id} died`);
  for (const id of now) if (!seen.has(id)) console.log(`t${m.tick} outrider ${id} (${m.entities.get(id)!.ownerId}) appears`);
  seen.clear(); for (const id of now) seen.add(id);
  if (m.tick % 300 === 0) {
    const pos = [...m.entities.values()].filter((e) => e.type === "outrider")
      .map((e) => `${e.ownerId}@${Math.round(e.x)},${Math.round(e.y)} hp${e.health} ${e.state}`);
    console.log(`t${m.tick}`, pos.join("  "));
  }
}
for (const p of ["pa", "pb"]) {
  const c: Record<string, number> = {};
  for (const e of m.entities.values()) if (e.ownerId === p) { const k = e.type === "building" ? e.buildingType! : e.type; c[k] = (c[k] ?? 0) + 1; }
  console.log(p, JSON.stringify(c));
}
console.log("tick", m.tick, "phase", m.phase, "result", JSON.stringify(m.result));
