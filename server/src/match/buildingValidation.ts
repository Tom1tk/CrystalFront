import type { MatchEntity, BuildingType, ResourceNode, PlayerSlot } from "./types.js";
import type { EntityId } from "@crystalfront/shared";
import type { BuildZone, LaneCorridor } from "./map.js";
import {
  BUILDING_MIN_SPACING,
  CRYSTAL_NO_BUILD_RADIUS,
  type BuildingDefinition,
} from "./types.js";

export interface PlacementResult {
  valid: boolean;
  reason?: string;
}

export function validatePlacement(
  x: number,
  y: number,
  buildingDef: BuildingDefinition,
  buildZone: BuildZone,
  laneCorridor: LaneCorridor,
  entities: Map<EntityId, MatchEntity>,
  resourceNodes: ResourceNode[],
  playerColor: "blue" | "red",
  crystals: MatchEntity[],
  playerId: string,
  mapHeight: number
): PlacementResult {
  const halfW = buildingDef.width / 2;
  const halfH = buildingDef.height / 2;
  const bx1 = x - halfW;
  const by1 = y - halfH;
  const bx2 = x + halfW;
  const by2 = y + halfH;

  // Check build zone
  if (
    bx1 < buildZone.x1 ||
    bx2 > buildZone.x2 ||
    by1 < 0 ||
    by2 > mapHeight
  ) {
    return { valid: false, reason: "Outside build zone" };
  }

  // Check lane corridor blocking
  if (by2 > laneCorridor.top && by1 < laneCorridor.bottom) {
    return { valid: false, reason: "Blocks lane corridor" };
  }

  // Check overlap with existing entities (use bounding box)
  for (const entity of entities.values()) {
    if (entity.type === "resource_node") continue;

    const eRadius = entity.radius;
    const eHalfW = eRadius;
    const eHalfH = eRadius;
    const ex1 = entity.x - eHalfW;
    const ey1 = entity.y - eHalfH;
    const ex2 = entity.x + eHalfW;
    const ey2 = entity.y + eHalfH;

    if (bx1 < ex2 && bx2 > ex1 && by1 < ey2 && by2 > ey1) {
      return { valid: false, reason: "Overlaps existing entity" };
    }
  }

  // Check overlap with resource nodes
  for (const node of resourceNodes) {
    const dx = x - node.x;
    const dy = y - node.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < node.radius + halfW) {
      return { valid: false, reason: "Overlaps resource node" };
    }
  }

  // Check minimum spacing from other buildings
  for (const entity of entities.values()) {
    if (entity.type !== "building") continue;
    const dx = x - entity.x;
    const dy = y - entity.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < BUILDING_MIN_SPACING) {
      return { valid: false, reason: "Too close to another building" };
    }
  }

  // Check crystal no-build buffer
  for (const crystal of crystals) {
    if (crystal.ownerId !== playerId) continue;
    const dx = x - crystal.x;
    const dy = y - crystal.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < CRYSTAL_NO_BUILD_RADIUS) {
      return { valid: false, reason: "Too close to your Crystal" };
    }
  }

  return { valid: true };
}

export function findCrystalByColor(
  entities: Map<EntityId, MatchEntity>,
  color: "blue" | "red"
): MatchEntity | null {
  const colorPrefix = color === "blue" ? "blue" : "red";
  for (const entity of entities.values()) {
    if (entity.type === "crystal" && entity.color.includes(colorPrefix)) {
      return entity;
    }
  }
  return null;
}

export function getCrystalsForPlayer(
  entities: Map<EntityId, MatchEntity>,
  playerId: string
): MatchEntity[] {
  return Array.from(entities.values()).filter(
    (e) => e.type === "crystal" && e.ownerId === playerId
  );
}
