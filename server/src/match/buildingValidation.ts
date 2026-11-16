import type { MatchEntity, MatchState, BuildingType, ResourceNode, PlayerSlot } from "./types.js";
import { rectTouches, isObstacleCode, T_BRUSH } from "./engine/terrain.js";
import { anchorsConnected, footprintOf, type Rect } from "./engine/navGrid.js";
import { visionCellOf, visionGridOf } from "./engine/visibility.js";
import type { BuildingDef as BuildingDefinition } from "@crystalfront/shared";
import type { EntityId } from "@crystalfront/shared";
import type { BuildZone, LaneCorridor } from "./map.js";
import {
  BUILDING_DEFS,
  PLACEMENT,
} from "@crystalfront/shared";

export interface PlacementResult {
  valid: boolean;
  reason?: string;
}

const CENTER_EXCLUSION_HALF_WIDTH = PLACEMENT.centerExclusionHalfWidth;

export function validatePlacement(
  x: number,
  y: number,
  buildingDef: BuildingDefinition,
  entities: Map<EntityId, MatchEntity>,
  resourceNodes: ResourceNode[],
  playerColor: "blue" | "red",
  crystals: MatchEntity[],
  playerId: string,
  mapWidth: number,
  mapHeight: number
): PlacementResult {
  const halfW = buildingDef.width / 2;
  const halfH = buildingDef.height / 2;
  const bx1 = x - halfW;
  const by1 = y - halfH;
  const bx2 = x + halfW;
  const by2 = y + halfH;
  const midX = mapWidth / 2;

  // Check player half: blue = left half, red = right half (not for `anywhere` buildings)
  if (!buildingDef.anywhere) {
    if (playerColor === "blue") {
      if (bx2 > midX) {
        return { valid: false, reason: "Outside your build zone" };
      }
    } else {
      if (bx1 < midX) {
        return { valid: false, reason: "Outside your build zone" };
      }
    }

    // Check center exclusion zone
    if (bx2 > midX - CENTER_EXCLUSION_HALF_WIDTH && bx1 < midX + CENTER_EXCLUSION_HALF_WIDTH) {
      return { valid: false, reason: "Too close to center" };
    }
  }

  // Check map bounds
  if (bx1 < 0 || bx2 > mapWidth || by1 < 0 || by2 > mapHeight) {
    return { valid: false, reason: "Outside map bounds" };
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
    if (dist < PLACEMENT.minSpacing) {
      return { valid: false, reason: "Too close to another building" };
    }
  }

  // Check crystal no-build buffer
  for (const crystal of crystals) {
    if (crystal.ownerId !== playerId) continue;
    const dx = x - crystal.x;
    const dy = y - crystal.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < PLACEMENT.crystalNoBuildRadius) {
      return { valid: false, reason: "Too close to your Crystal" };
    }
  }

  return { valid: true };
}

/**
 * Every rule a new building must pass: zone, spacing and overlap
 * (validatePlacement), terrain (G-5/G-6b: no obstacles or brush) and the G-3
 * no-seal rule. Used by the engine's build command and by scripted bots, so
 * bots only pick sites the engine will accept.
 */
export function validateBuildSite(
  match: MatchState,
  playerId: string,
  buildingType: BuildingType,
  x: number,
  y: number
): PlacementResult {
  const def = BUILDING_DEFS[buildingType];
  if (!requirementMet(match, playerId, buildingType)) {
    const need = def.requires!.replace(/_/g, " ");
    return { valid: false, reason: `Requires a ${need[0].toUpperCase()}${need.slice(1)}` };
  }
  const playerColor = match.players.find((p) => p?.playerId === playerId)?.color ?? "blue";
  const playerCrystals = Array.from(match.entities.values()).filter(
    (e) => e.type === "crystal" && e.ownerId === playerId
  );
  const placement = validatePlacement(
    x, y, def, match.entities, match.resourceNodes, playerColor, playerCrystals, playerId,
    match.config.mapWidth, match.config.mapHeight
  );
  if (!placement.valid) return placement;

  // `anywhere` buildings go only on ground the player can see right now (no build sites in the fog).
  if (def.anywhere && !siteInSight(match, playerId, x, y)) {
    return { valid: false, reason: "Not in sight" };
  }

  if (rectTouches(match.terrain, x - def.width / 2, y - def.height / 2, x + def.width / 2, y + def.height / 2,
      (c) => isObstacleCode(c) || c === T_BRUSH)) {
    return { valid: false, reason: "Blocked by terrain" };
  }

  const crystalRects = Array.from(match.entities.values())
    .filter((e) => e.type === "crystal")
    .map((e) => footprintOf(e) as Rect);
  const newRect = footprintOf({ type: "building", x, y, radius: 0, buildingType });
  if (!anchorsConnected(match.nav, crystalRects, newRect ?? undefined)) {
    return { valid: false, reason: "Would seal off a crystal" };
  }
  return { valid: true };
}

/** The player has a finished building of the type `buildingType` requires (true if it requires none). */
export function requirementMet(match: MatchState, playerId: string, buildingType: string): boolean {
  const need = BUILDING_DEFS[buildingType]?.requires;
  if (!need) return true;
  for (const e of match.entities.values()) {
    if (e.type === "building" && e.ownerId === playerId && e.buildingType === need && e.constructionProgress >= 100) return true;
  }
  return false;
}

/** The point is on the player's enemy half of the map: nearer an enemy crystal than any crystal of their own. */
export function onEnemyHalf(match: MatchState, playerId: string, x: number, y: number): boolean {
  let own = Infinity, enemy = Infinity;
  for (const e of match.entities.values()) {
    if (e.type !== "crystal") continue;
    const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
    if (e.ownerId === playerId) own = Math.min(own, d); else enemy = Math.min(enemy, d);
  }
  return enemy < own;
}

/** The `forward` terms of a building that has them and stands on its owner's enemy half; undefined otherwise. */
export function forwardTerms(match: MatchState, e: MatchEntity): { buildTime: number; trainTimeMult: number } | undefined {
  const f = BUILDING_DEFS[e.buildingType ?? ""]?.forward;
  return f && onEnemyHalf(match, e.ownerId ?? "", e.x, e.y) ? f : undefined;
}

/** The player currently sees the point (true before the first visibility pass). */
export function siteInSight(match: MatchState, playerId: string, x: number, y: number): boolean {
  const vis = match.visibilityData?.get(playerId);
  return !vis || vis.cells[visionCellOf(visionGridOf(match.terrain), x, y)] === 1;
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
