import { UNIT_DEFS, SIMULATION, TERRAIN } from "@crystalfront/shared";
import type { MatchState } from "../types.js";
import { dist, buildSpatialGrid, getRange, entityIdNum } from "./utils.js";
import { footprintOf, pushOutOfRect, type Rect } from "./navGrid.js";
import { isObstacleCode, terrainAt, T_ROUGH, type Terrain } from "./terrain.js";
import { cellOf, hasLineOfSight, planPath } from "./pathfinding.js";
import type { MatchEntity } from "../types.js";

/** Ticks without progress before a unit replans (G-4). */
const STUCK_TICKS = 8;
/** Initial bestDist (a finite stand-in for "no progress measured yet"). */
const NO_PROGRESS = 1e9;
/** A stuck unit touching an idle unit this close to its goal counts as arrived (group arrival). */
const CROWD_ARRIVE_RADIUS = 300;

/** Arrive: drop the move target (and a finished move order) and the route. */
function arrive(entity: MatchEntity): void {
  entity.moveTarget = undefined;
  entity.route = undefined;
  if (!entity.attackTargetId) entity.moveOrder = undefined;
}

/** Make sure entity.route is valid for its current moveTarget (G-4). */
function ensureRoute(match: MatchState, entity: MatchEntity): NonNullable<MatchEntity["route"]> {
  const g = match.nav;
  const mt = entity.moveTarget!;
  let r = entity.route;
  let replan = !r || cellOf(g, r.goalX, r.goalY) !== cellOf(g, mt.x, mt.y);
  if (r && r.stuckTicks >= STUCK_TICKS) replan = true;
  if (r && !replan && r.version !== g.version) {
    // Nav grid changed: replan only if the remaining route is now blocked.
    let ax = entity.x, ay = entity.y;
    const legs = r.truncated ? r.waypoints : [...r.waypoints, mt];
    for (const p of legs) {
      if (!hasLineOfSight(g, ax, ay, p.x, p.y)) { replan = true; break; }
      ax = p.x; ay = p.y;
    }
    if (!replan) r.version = g.version;
  }
  if (replan) {
    // Units on a player/bot move order share the flow field for that destination.
    const useField = !!entity.moveOrder && entity.moveOrder.x === mt.x && entity.moveOrder.y === mt.y;
    const plan = planPath(g, entity.x, entity.y, mt.x, mt.y, useField);
    r = entity.route = {
      goalX: mt.x, goalY: mt.y, waypoints: plan.waypoints, truncated: plan.truncated,
      version: g.version, bestDist: NO_PROGRESS, stuckTicks: 0,
    };
  }
  return r!;
}

export function processMovement(match: MatchState): void {
  const entities = Array.from(match.entities.values());
  const arrivalThreshold = SIMULATION.arrivalThreshold;

  // Idle units at the start of the tick, for the avoidance nudge (a read-only
  // snapshot, so the result doesn't depend on iteration order).
  const snapCell = SIMULATION.spatialCellSize;
  const snapGrid: SnapGrid = new Map();
  for (const e of entities) {
    if (e.type === "crystal" || e.type === "building" || e.moveTarget) continue;
    const key = snapKey(Math.floor(e.x / snapCell), Math.floor(e.y / snapCell));
    let cell = snapGrid.get(key);
    if (!cell) snapGrid.set(key, (cell = []));
    cell.push({ id: e.id, x: e.x, y: e.y, radius: e.radius });
  }

  for (const entity of entities) {
    if (entity.type === "crystal" || entity.type === "building") continue;
    if (!entity.moveTarget) { entity.route = undefined; continue; }

    const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
    const baseSpeed = unitDef?.speed ?? 2;
    const speedPerTick = (
      entity.type === "worker"     && match.config.workerSpeed     !== undefined ? match.config.workerSpeed :
      entity.type === "skirmisher" && match.config.skirmisherSpeed !== undefined ? match.config.skirmisherSpeed :
      baseSpeed) * (match.terrain.any && terrainAt(match.terrain, entity.x, entity.y) === T_ROUGH ? TERRAIN.roughSpeed : 1);
    if (dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y) <= arrivalThreshold) {
      arrive(entity);
      continue;
    }

    // Complete movement when within attack range of a large entity (crystal/building)
    // at the moveTarget position. Prevents units piling up at a single center point —
    // multiple units can arrive at different positions around the entity's surface.
    let arrivedAtEntity = false;
    for (const other of entities) {
      if (other.id === entity.id) continue;
      if (other.type !== "crystal" && other.type !== "building") continue;
      const dTargetToOther = dist(entity.moveTarget.x, entity.moveTarget.y, other.x, other.y);
      if (dTargetToOther <= other.radius) {
        // The moveTarget is at/inside this large entity; arrive when in attack range
        if (dist(entity.x, entity.y, other.x, other.y) <= getRange(entity, match.terrain) + other.radius) {
          arrivedAtEntity = true;
          break;
        }
      }
    }
    if (arrivedAtEntity) {
      arrive(entity);
      continue;
    }

    // Group arrival: a unit that can't make progress, near its goal and pressed
    // against units that have already stopped, stops too (arrival chains outward).
    if (entity.route && entity.route.stuckTicks >= STUCK_TICKS &&
        dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y) <= CROWD_ARRIVE_RADIUS &&
        touchesIdle(snapGrid, snapCell, entity)) {
      arrive(entity);
      continue;
    }

    // G-4: steer along the planned route.
    const route = ensureRoute(match, entity);
    while (route.waypoints.length > 0 &&
           dist(entity.x, entity.y, route.waypoints[0].x, route.waypoints[0].y) <= Math.max(arrivalThreshold, speedPerTick * 0.5)) {
      route.waypoints.shift();
      route.bestDist = NO_PROGRESS;
    }
    if (route.waypoints.length === 0 && route.truncated) {
      // Goal unreachable: we're at the nearest reachable point.
      arrive(entity);
      continue;
    }
    const steer = route.waypoints[0] ?? entity.moveTarget;
    let dx = steer.x - entity.x;
    let dy = steer.y - entity.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance === 0) continue;
    if (distance < route.bestDist - 0.5) { route.bestDist = distance; route.stuckTicks = 0; }
    else route.stuckTicks++;
    dx /= distance;
    dy /= distance;
    const moveAmount = Math.min(speedPerTick, distance);

    // Local avoidance: if an idle unit sits right in the way, sidestep 45°.
    const blocker = findBlocker(snapGrid, snapCell, entity, dx, dy, moveAmount);
    if (blocker) {
      const c = Math.SQRT1_2;
      const left = { x: dx * c + dy * c, y: -dx * c + dy * c };
      const right = { x: dx * c - dy * c, y: dx * c + dy * c };
      const bx = blocker.x - entity.x, by = blocker.y - entity.y;
      const cross = dx * by - dy * bx;
      // Epsilons keep the choice stable under float noise (mirror-invariance).
      const EPS = 1e-6;
      let pick;
      if (cross > EPS) pick = left;
      else if (cross < -EPS) pick = right;
      else {
        // Dead ahead: mirror-safe choice — head toward the map's vertical middle,
        // or for vertical travel toward its horizontal middle.
        const towardY = entity.y < match.config.mapHeight / 2 ? 1 : -1;
        const towardX = entity.x < match.config.mapWidth / 2 ? 1 : -1;
        pick = Math.abs(left.y - right.y) > EPS
          ? (left.y * towardY > right.y * towardY ? left : right)
          : (left.x * towardX > right.x * towardX ? left : right);
      }
      dx = pick.x; dy = pick.y;
    }

    entity.x += dx * moveAmount;
    entity.y += dy * moveAmount;

    // Clamp to map bounds
    const mapW = match.config.mapWidth;
    const mapH = match.config.mapHeight;
    entity.x = Math.max(entity.radius, Math.min(mapW - entity.radius, entity.x));
    entity.y = Math.max(entity.radius, Math.min(mapH - entity.radius, entity.y));

    if (dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y) <= arrivalThreshold) {
      arrive(entity);
    }
  }

  // Soft collision resolution with spatial grid (two passes for stability).
  // Pushes are accumulated and applied simultaneously (Jacobi), so the result
  // does not depend on iteration order: mirror-symmetric states stay mirror-symmetric.
  const mobile = entities.filter((e) => e.type !== "crystal" && e.type !== "building");
  const cellSize = SIMULATION.spatialCellSize;
  for (let pass = 0; pass < 2; pass++) {
    const grid = buildSpatialGrid(mobile, cellSize);
    const pushX = new Map<string, number>();
    const pushY = new Map<string, number>();
    for (const entity of mobile) {
      const cx = Math.floor(entity.x / cellSize);
      const cy = Math.floor(entity.y / cellSize);
      for (let ddx = -1; ddx <= 1; ddx++) {
        for (let ddy = -1; ddy <= 1; ddy++) {
          const cell = grid.get(`${cx + ddx},${cy + ddy}`);
          if (!cell) continue;
          for (const other of cell) {
            // Each unordered pair once (numeric id order; "e10" < "e9" lexicographically).
            if (entityIdNum(other.id) <= entityIdNum(entity.id)) continue;
            const dx = other.x - entity.x;
            const dy = other.y - entity.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const minDist = entity.radius + other.radius;
            if (distance < minDist && distance > 0) {
              const push = (minDist - distance) * 0.5;
              const px = (dx / distance) * push;
              const py = (dy / distance) * push;
              pushX.set(entity.id, (pushX.get(entity.id) ?? 0) - px);
              pushY.set(entity.id, (pushY.get(entity.id) ?? 0) - py);
              pushX.set(other.id, (pushX.get(other.id) ?? 0) + px);
              pushY.set(other.id, (pushY.get(other.id) ?? 0) + py);
            }
          }
        }
      }
    }
    for (const entity of mobile) {
      const px = pushX.get(entity.id);
      if (px === undefined) continue;
      entity.x += px;
      entity.y += pushY.get(entity.id)!;
    }
  }

  // G-3: structures (buildings, crystals) are solid. Push any unit overlapping a
  // footprint back out along the shortest way (also covers units standing where a
  // building was just placed). Proper routing around them arrives with G-4.
  const solids: Rect[] = [];
  for (const e of entities) {
    const r = footprintOf(e);
    if (r) solids.push(r);
  }
  const terrain = match.terrain.any ? match.terrain : null;
  const mapW = match.config.mapWidth;
  const mapH = match.config.mapHeight;
  for (const u of mobile) {
    for (const r of solids) {
      if (u.x + u.radius <= r.x1 || u.x - u.radius >= r.x2 || u.y + u.radius <= r.y1 || u.y - u.radius >= r.y2) continue;
      pushOutOfRect(u, r);
    }
    if (terrain) pushOutOfTerrain(terrain, u);
    u.x = Math.max(u.radius, Math.min(mapW - u.radius, u.x));
    u.y = Math.max(u.radius, Math.min(mapH - u.radius, u.y));
  }
}

/**
 * G-5: push a unit out of terrain obstacle cells. Each overlapping cell proposes
 * a displacement from the same starting position; per axis the largest push each
 * way is applied, so a flat wall of several cells pushes once and the result
 * doesn't depend on cell iteration order (mirror-safe).
 */
function pushOutOfTerrain(t: Terrain, u: { x: number; y: number; radius: number }): void {
  const cs = t.cellSize;
  const c1 = Math.max(0, Math.floor((u.x - u.radius) / cs));
  const c2 = Math.min(t.cols - 1, Math.floor((u.x + u.radius) / cs));
  const r1 = Math.max(0, Math.floor((u.y - u.radius) / cs));
  const r2 = Math.min(t.rows - 1, Math.floor((u.y + u.radius) / cs));
  let maxX = 0, minX = 0, maxY = 0, minY = 0;
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      if (!isObstacleCode(t.cells[r * t.cols + c])) continue;
      const p = { x: u.x, y: u.y, radius: u.radius };
      if (!pushOutOfRect(p, { x1: c * cs, y1: r * cs, x2: (c + 1) * cs, y2: (r + 1) * cs })) continue;
      const dx = p.x - u.x, dy = p.y - u.y;
      if (dx > maxX) maxX = dx; else if (dx < minX) minX = dx;
      if (dy > maxY) maxY = dy; else if (dy < minY) minY = dy;
    }
  }
  u.x += maxX + minX;
  u.y += maxY + minY;
}

type SnapGrid = Map<number, Array<{ id: string; x: number; y: number; radius: number }>>;
const snapKey = (cx: number, cy: number) => cx * 4096 + cy;

/** Is the entity touching an idle unit from the start-of-tick snapshot? */
function touchesIdle(grid: SnapGrid, cellSize: number, entity: MatchEntity): boolean {
  if (grid.size === 0) return false;
  const cx = Math.floor(entity.x / cellSize);
  const cy = Math.floor(entity.y / cellSize);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const cell = grid.get(snapKey(cx + ox, cy + oy));
      if (!cell) continue;
      for (const o of cell) {
        if (o.id !== entity.id && dist(entity.x, entity.y, o.x, o.y) <= entity.radius + o.radius + 2) return true;
      }
    }
  }
  return false;
}

/** An idle unit (from the start-of-tick snapshot) directly ahead within reach this step. */
function findBlocker(
  grid: SnapGrid,
  cellSize: number,
  entity: MatchEntity,
  dx: number,
  dy: number,
  step: number,
): { x: number; y: number } | null {
  if (grid.size === 0) return null;
  const cx = Math.floor(entity.x / cellSize);
  const cy = Math.floor(entity.y / cellSize);
  let best: { x: number; y: number } | null = null;
  let bestAlong = Infinity;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const cell = grid.get(snapKey(cx + ox, cy + oy));
      if (!cell) continue;
      for (const o of cell) {
        if (o.id === entity.id) continue;
        const bx = o.x - entity.x, by = o.y - entity.y;
        const along = bx * dx + by * dy;
        if (along <= 0) continue;
        const reach = entity.radius + o.radius;
        if (along > reach + step) continue;
        const side = Math.abs(bx * dy - by * dx);
        if (side >= reach * 0.8) continue;
        if (along < bestAlong) { bestAlong = along; best = o; }
      }
    }
  }
  return best;
}
