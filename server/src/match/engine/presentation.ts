/**
 * Presentation hooks for the state stream (G-11).
 *
 * Derived from simulation state at serialisation time, so they never affect the
 * sim, the hash or mirror invariance. The future visual layer uses them to pick
 * sprite facing and animation.
 */
import type { MatchEntity, MatchState } from "../types.js";
import { encodeTerrain } from "./terrain.js";

export type ActionState = "idle" | "moving" | "attacking" | "gathering" | "constructing" | "dying";

export function actionStateOf(e: MatchEntity): ActionState {
  if (e.health <= 0 && e.type !== "building") return "dying";
  if (e.type === "building" && e.constructionProgress < 100) return "constructing";
  if (e.attackTargetId || e.healTargetId) return "attacking";
  if (e.buildTargetId || e.repairTargetId) return "constructing";
  if (e.gatheringNodeId) return "gathering";
  if (e.moveTarget || e.moveOrder) return "moving";
  return "idle";
}

/**
 * Facing in radians (atan2, 0 = +x/east) toward whatever the entity is acting on,
 * or undefined when it has nothing to face (client keeps the last heading).
 */
export function headingOf(e: MatchEntity, match: MatchState): number | undefined {
  let tx: number | undefined;
  let ty: number | undefined;
  const targetId = e.attackTargetId ?? e.healTargetId ?? e.buildTargetId ?? e.repairTargetId;
  const target = targetId ? match.entities.get(targetId) : undefined;
  if (target) { tx = target.x; ty = target.y; }
  else if (e.moveTarget) { tx = e.moveTarget.x; ty = e.moveTarget.y; }
  else if (e.moveOrder) { tx = e.moveOrder.x; ty = e.moveOrder.y; }
  else if (e.gatheringNodeId) {
    const node = match.resourceNodes.find((n) => n.id === e.gatheringNodeId);
    if (node) { tx = node.x; ty = node.y; }
  }
  if (tx === undefined || ty === undefined) return undefined;
  const dx = tx - e.x, dy = ty - e.y;
  if (dx === 0 && dy === 0) return undefined;
  return Math.round(Math.atan2(dy, dx) * 1000) / 1000;
}

/**
 * Static map data, sent once with MATCH_START. `terrain` is the run-length
 * encoded nav-cell terrain codes ("code:count,…"; 0 open, 1 rough, 2 high,
 * 3 brush, 4 rock, 5 cliff, 6 water).
 */
export function staticMapOf(match: MatchState) {
  return {
    cellSize: match.nav.cellSize,
    cols: match.nav.cols,
    rows: match.nav.rows,
    mapId: match.terrain.mapId,
    mapVersion: match.terrain.mapVersion,
    terrain: encodeTerrain(match.terrain),
  };
}
