import { UNIT_DEFS, SIMULATION } from "@crystalfront/shared";
import type { MatchState } from "../types.js";
import { dist, buildSpatialGrid } from "./utils.js";

export function processMovement(match: MatchState, subStepMs: number = 100): void {
  const entities = Array.from(match.entities.values());
  const arrivalThreshold = SIMULATION.arrivalThreshold;
  const stepsPerTick = (100 / subStepMs) || 1;

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
      speedPerTick / stepsPerTick,
      dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y),
    );

    const dx = entity.moveTarget.x - entity.x;
    const dy = entity.moveTarget.y - entity.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= arrivalThreshold) {
      entity.moveTarget = undefined;
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
    }
  }

  // Soft collision resolution with spatial grid (two passes for stability)
  const mobile = entities.filter((e) => e.type !== "crystal" && e.type !== "building");
  const cellSize = SIMULATION.spatialCellSize;
  for (let pass = 0; pass < 2; pass++) {
    const grid = buildSpatialGrid(mobile, cellSize);
    const checked = new Set<string>();
    for (const entity of mobile) {
      const cx = Math.floor(entity.x / cellSize);
      const cy = Math.floor(entity.y / cellSize);
      for (let ddx = -1; ddx <= 1; ddx++) {
        for (let ddy = -1; ddy <= 1; ddy++) {
          const key = `${cx + ddx},${cy + ddy}`;
          const cell = grid.get(key);
          if (!cell) continue;
          for (const other of cell) {
            if (other.id <= entity.id) continue;
            if (checked.has(`${entity.id}-${other.id}`)) continue;
            checked.add(`${entity.id}-${other.id}`);
            const dx = other.x - entity.x;
            const dy = other.y - entity.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const minDist = entity.radius + other.radius;
            if (distance < minDist && distance > 0) {
              const push = (minDist - distance) * 0.5;
              const nx = dx / distance;
              const ny = dy / distance;
              entity.x -= nx * push;
              entity.y -= ny * push;
              other.x += nx * push;
              other.y += ny * push;
            }
          }
        }
      }
    }
  }
}
