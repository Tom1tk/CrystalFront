// The symmetric image of a match state with seats swapped (tests, T6/T9).
// Every position goes through the map's symmetry transform (mirror: x → W − x;
// rotate: also y → H − y); players, economies, RNGs, control progress and node
// controllers swap seats, and colours swap with them (the build zone is by colour). Ids and owners stay, so each player keeps its
// entities, now in the other seat. The terrain is left as is: pool maps are
// symmetric under their own transform.
import type { MatchState } from "../../../server/src/match/types.js";
import { deepCloneMatchState } from "../../../server/src/match/engine/mirror.js";
import { rebuildNavGrid } from "../../../server/src/match/engine/navGrid.js";
import { computeVisibility } from "../../../server/src/match/engine/visibility.js";
import { mapSymmetry } from "../../../server/src/match/maps.js";

export function imageState(match: MatchState): MatchState {
  const c = deepCloneMatchState(match);
  const W = c.mapWidth, H = c.mapHeight;
  const rot = mapSymmetry(c.config.mapId) === "rotate";
  const fx = (x: number) => W - x, fy = (y: number) => (rot ? H - y : y);
  const pt = (p: { x: number; y: number } | undefined) => { if (p) { p.x = fx(p.x); p.y = fy(p.y); } };
  const swapColor = (col: string) => (col.startsWith("blue") ? "red" + col.slice(4) : col.startsWith("red") ? "blue" + col.slice(3) : col);
  for (const e of c.entities.values()) {
    e.color = swapColor(e.color) as typeof e.color;
    pt(e); pt(e.moveTarget); pt(e.moveOrder); pt(e.rallyPoint);
    if (e.route) {
      e.route.goalX = fx(e.route.goalX); e.route.goalY = fy(e.route.goalY);
      for (const w of e.route.waypoints) pt(w);
    }
    for (const o of e.orderQueue ?? []) {
      if (o.targetX !== undefined) o.targetX = fx(o.targetX);
      if (o.targetY !== undefined) o.targetY = fy(o.targetY);
    }
  }
  for (const n of c.resourceNodes) {
    pt(n);
    if (n.controller === 0 || n.controller === 1) n.controller = (1 - n.controller) as 0 | 1;
  }
  const holder = c.control.holder;
  const out: MatchState = {
    ...c,
    players: [c.players[1], c.players[0]].map((p) => (p ? { ...p, color: swapColor(p.color) as typeof p.color } : p)) as MatchState["players"],
    economy: [c.economy[1], c.economy[0]],
    rng: [c.rng[1], c.rng[0]],
    control: { holder: holder === null ? null : (1 - holder) as 0 | 1, progress: [c.control.progress[1], c.control.progress[0]] },
  };
  out.nav = rebuildNavGrid(out);
  computeVisibility(out);
  return out;
}
