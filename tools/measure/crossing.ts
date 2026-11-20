import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import { mapIds } from "../../server/src/match/maps.js";
import { UNIT_DEFS } from "../../shared/src/index.js";
const out: string[] = [];
for (const map of mapIds()) {
  const eng = new MatchEngine();
  const m = eng.createMatch("x-" + map, [
    { playerId: "a", username: "a", color: "blue", score: 0 },
    { playerId: "b", username: "b", color: "red", score: 0 }], { ...DEFAULT_CONFIG, mapId: map }, 1);
  eng.startMatch(m.id);
  const ents = [...m.entities.values()];
  const rc = ents.find((e) => e.type === "crystal" && e.ownerId === "b")!;
  const bc = ents.find((e) => e.type === "crystal" && e.ownerId === "a")!;
  const w = ents.find((e) => e.type === "worker" && e.ownerId === "a")!;
  // stop short of the enemy crystal (inside its vision, 150 px out)
  const dx = rc.x - bc.x, dy = rc.y - bc.y, L = Math.hypot(dx, dy);
  const tx = rc.x - dx / L * 150, ty = rc.y - dy / L * 150;
  const x0 = w.x, y0 = w.y;
  eng.processCommand(m.id, "a", { type: "move", entityId: w.id, targetX: tx, targetY: ty } as any);
  let t = 0;
  while (t < 8000 && Math.hypot(w.x - tx, w.y - ty) > 20) { eng.tick(m.id); t++; if (!m.entities.has(w.id)) break; }
  const workerSec = t / 10;
  const ratio = (u: string) => (UNIT_DEFS as any).worker.speed / (UNIT_DEFS as any)[u].speed;
  out.push(`${map.padEnd(14)} straight ${Math.round(Math.hypot(tx - x0, ty - y0))}px  worker ${workerSec.toFixed(0)}s  skirm ${(workerSec * ratio("skirmisher")).toFixed(0)}s  gunner ${(workerSec * ratio("gunner")).toFixed(0)}s  outrider@8 ${(workerSec * (UNIT_DEFS as any).worker.speed / 8).toFixed(0)}s`);
  eng.destroyMatch(m.id);
}
console.log(out.join("\n"));
