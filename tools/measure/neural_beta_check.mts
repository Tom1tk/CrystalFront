// A 0.9 neural model (through the 0.9 adapter) against a v3 scripted bot in a beta match,
// headless: checks the adapter keeps the old models playing in beta rules.
//   npx tsx tools/measure/neural_beta_check.mts [level] [scripted] [ticks] [map]
import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type PlayerSlot } from "../../server/src/match/types.js";
import { ScriptedBotPlayer } from "../../server/src/match/scriptedBotPlayer.js";
import { NeuralBotPlayer, loadNeuralModels, neuralModelFor } from "../../server/src/match/neuralBotPlayer.js";
const [level = "hard", b = "rush1", n = "12000", map = "twin-spires"] = process.argv.slice(2);
await loadNeuralModels();
const model = neuralModelFor(`neural_${level}`);
if (!model) throw new Error(`no model ${level}`);
const engine = new MatchEngine();
const players: [PlayerSlot, PlayerSlot] = [
  { playerId: "pa", username: level, color: "blue", score: 0 }, { playerId: "pb", username: b, color: "red", score: 0 },
];
const m = engine.createMatch("chk", players, { ...DEFAULT_CONFIG, mapId: map, ruleset: "beta" }, 3);
engine.startMatch(m.id);
const nb = new NeuralBotPlayer(model, "pa", m.id, engine);
const sb = new ScriptedBotPlayer(b, "pb", m.id, engine);
const busy = nb as unknown as { pending: boolean; failed: boolean };
for (let t = 0; t < Number(n) && m.phase === "playing"; t++) {
  nb.tick(); sb.tick();
  while (busy.pending) await new Promise((r) => setTimeout(r, 0));
  if (busy.failed) throw new Error("neural bot failed");
  engine.tick(m.id);
}
for (const p of ["pa", "pb"]) {
  const c: Record<string, number> = {};
  for (const e of m.entities.values()) if (e.ownerId === p) { const k = e.type === "building" ? e.buildingType! : e.type; c[k] = (c[k] ?? 0) + 1; }
  console.log(p, JSON.stringify(c));
}
console.log("tick", m.tick, "phase", m.phase, "result", JSON.stringify(m.result), "decisions", nb.reads.length);
