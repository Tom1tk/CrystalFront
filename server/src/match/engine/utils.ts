/**
 * Shared pure helpers used by multiple engine phase modules.
 * No match mutation here — all functions return values or are read-only.
 */

import type { EntityId } from "@crystalfront/shared";
import {
  UNIT_DEFS, BUILDING_DEFS, SIMULATION, COUNTER_MODIFIER, TERRAIN,
} from "@crystalfront/shared";
import type { MatchConfig, MatchEntity } from "../types.js";
import { terrainAt, T_HIGH, type Terrain } from "./terrain.js";

/** Is the entity standing on high ground (G-6)? */
export function onHighGround(entity: MatchEntity, terrain?: Terrain | null): boolean {
  return !!terrain && terrain.any && terrainAt(terrain, entity.x, entity.y) === T_HIGH;
}

// ── Spatial ────────────────────────────────────────────────────────────────────

export function dist(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Numeric value of an entity id like "e10" -> 10. Lexicographic comparison of
// these ids is wrong once the counter reaches double digits (e.g. "e10" < "e9").
export function entityIdNum(id: string): number {
  return parseInt(id.slice(1), 10);
}

// ── Vision ─────────────────────────────────────────────────────────────────────

export function getVisionRange(entity: MatchEntity, terrain?: Terrain | null): number {
  const mult = onHighGround(entity, terrain) ? TERRAIN.highVision : 1;
  if (entity.type === "building" && entity.buildingType) {
    const def = BUILDING_DEFS[entity.buildingType];
    return (def?.visionRange ?? 100) * mult;
  }
  if (entity.type === "crystal") {
    return SIMULATION.crystalVisionRange * mult;
  }
  const def = UNIT_DEFS[entity.type];
  return (def?.visionRange ?? SIMULATION.defaultVisionRange) * mult;
}

// ── Combat stats ───────────────────────────────────────────────────────────────

/** Weapon/heal range; pass the match terrain to apply the high-ground bonus (G-6). */
export function getRange(entity: MatchEntity, terrain?: Terrain | null): number {
  const high = onHighGround(entity, terrain);
  if (entity.type === "building" && entity.buildingType === "turret") {
    return (BUILDING_DEFS.turret.range ?? 150) * (high ? TERRAIN.highBuildingRange : 1);
  }
  const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
  // Add own radius so melee range is measured from unit edge, not center
  return (unitDef?.range ?? 20) * (high ? TERRAIN.highUnitRange : 1) + entity.radius;
}

export function getDamage(entity: MatchEntity, config?: MatchConfig): number {
  if (entity.type === "building" && entity.buildingType === "turret") {
    return BUILDING_DEFS.turret.damage ?? 18;
  }
  if (entity.type === "skirmisher" && config?.skirmisherDamage !== undefined) {
    return config.skirmisherDamage;
  }
  const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
  return unitDef?.damage ?? 5;
}

export function getAttackCooldown(entity: MatchEntity): number {
  if (entity.type === "building" && entity.buildingType === "turret") {
    return BUILDING_DEFS.turret.attackCooldown ?? 12;
  }
  const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
  return unitDef?.attackCooldown ?? 20;
}

export function getCounterMultiplier(
  attackerType: string,
  defenderType: string,
  defenderBuildingType?: string,
): number {
  // Attackers: turret acts like a gunner offensively
  const effectiveAttacker = attackerType === "building" ? "gunner" : attackerType;
  // Defenders: turret acts like a gunner (skirmisher counters it 2×);
  // all other buildings act like workers (no counter bonus applies)
  const effectiveDefender =
    defenderType !== "building"             ? defenderType
    : defenderBuildingType === "turret"     ? "gunner"
    :                                         "worker";
  return COUNTER_MODIFIER[effectiveAttacker]?.[effectiveDefender] ?? 1.0;
}
