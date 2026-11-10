import { UNIT_DEFS, SIMULATION } from "@crystalfront/shared";
import type { MatchState } from "../types.js";
import { dist, buildSpatialGrid, getRange, entityIdNum } from "./utils.js";
import { footprintOf, pushOutOfRect, type Rect } from "./navGrid.js";

export function processMovement(match: MatchState): void {
  const entities = Array.from(match.entities.values());
  const arrivalThreshold = SIMULATION.arrivalThreshold;

  for (const entity of entities) {
    if (entity.type === "crystal" || entity.type === "building") continue;
    if (!entity.moveTarget) continue;

    const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
    const baseSpeed = unitDef?.speed ?? 2;
    const speedPerTick =
      entity.type === "worker"     && match.config.workerSpeed     !== undefined ? match.config.workerSpeed :
      entity.type === "skirmisher" && match.config.skirmisherSpeed !== undefined ? match.config.skirmisherSpeed :
      baseSpeed;
    const moveAmount = Math.min(
      speedPerTick,
      dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y),
    );

    const dx = entity.moveTarget.x - entity.x;
    const dy = entity.moveTarget.y - entity.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= arrivalThreshold) {
      entity.moveTarget = undefined;
      if (!entity.attackTargetId) entity.moveOrder = undefined;
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
        if (dist(entity.x, entity.y, other.x, other.y) <= getRange(entity) + other.radius) {
          arrivedAtEntity = true;
          break;
        }
      }
    }
    if (arrivedAtEntity) {
      entity.moveTarget = undefined;
      if (!entity.attackTargetId) entity.moveOrder = undefined;
      continue;
    }

    entity.x += (dx / distance) * moveAmount;
    entity.y += (dy / distance) * moveAmount;

    // Clamp to map bounds
    const mapW = match.config.mapWidth;
    const mapH = match.config.mapHeight;
    entity.x = Math.max(entity.radius, Math.min(mapW - entity.radius, entity.x));
    entity.y = Math.max(entity.radius, Math.min(mapH - entity.radius, entity.y));

    if (dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y) <= arrivalThreshold) {
      entity.moveTarget = undefined;
      if (!entity.attackTargetId) entity.moveOrder = undefined;
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
  if (solids.length === 0) return;
  const mapW = match.config.mapWidth;
  const mapH = match.config.mapHeight;
  for (const u of mobile) {
    for (const r of solids) {
      if (u.x + u.radius <= r.x1 || u.x - u.radius >= r.x2 || u.y + u.radius <= r.y1 || u.y - u.radius >= r.y2) continue;
      pushOutOfRect(u, r);
    }
    u.x = Math.max(u.radius, Math.min(mapW - u.radius, u.x));
    u.y = Math.max(u.radius, Math.min(mapH - u.radius, u.y));
  }
}
