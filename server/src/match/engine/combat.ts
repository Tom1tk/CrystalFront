import { UNIT_DEFS } from "@crystalfront/shared";
import type { MatchState } from "../types.js";
import { dist, getRange, getDamage, getAttackCooldown, getCounterMultiplier } from "./utils.js";
import { isVisibleTo } from "./visibility.js";

export function processCombat(match: MatchState): Map<string, number> {
  const damageLog = new Map<string, number>();
  const entities = Array.from(match.entities.values());

  // Auto-attack acquisition: idle combat units find nearest enemy in range
  for (const entity of entities) {
    if (!entity.autoAttackEnabled) continue;
    // Plain move order: ignore enemies until arrival (G-1)
    if (entity.moveOrder && !entity.moveOrder.attack) continue;
    if (entity.type === "building") {
      if (entity.constructionProgress < 100) continue;
    }
    if (entity.attackTargetId) continue;

    let nearestDist = Infinity;
    let nearestId: string | undefined;
    const range = getRange(entity, match.terrain);
    for (const other of entities) {
      if (other.ownerId === entity.ownerId) continue;
      // Only what the owner could see at the end of last tick (G-6b)
      if (!isVisibleTo(match, entity.ownerId, other)) continue;
      // Workers cannot initiate combat on crystals or buildings — only workers and combat units
      if (entity.type === "worker" && (other.type === "crystal" || other.type === "building")) continue;
      const d = dist(entity.x, entity.y, other.x, other.y);
      if (d <= range + other.radius && d < nearestDist) {
        nearestDist = d;
        nearestId = other.id;
      }
    }
    if (nearestId) entity.attackTargetId = nearestId;
    // Attack-move with nothing to fight: resume toward the order's destination
    else if (entity.moveOrder?.attack && !entity.moveTarget) {
      entity.moveTarget = { x: entity.moveOrder.x, y: entity.moveOrder.y };
    }
  }

  // Attack chase: units with attackTargetId move toward target if out of range.
  // When already in range, clear moveTarget so the unit holds position rather than
  // continuing to drift toward the exact center (which causes crowding on large targets).
  for (const entity of entities) {
    if (!entity.attackTargetId) continue;
    if (entity.type === "crystal" || entity.type === "building") continue;
    const target = match.entities.get(entity.attackTargetId);
    if (!target) { entity.attackTargetId = undefined; continue; }
    const range = getRange(entity, match.terrain);
    const d = dist(entity.x, entity.y, target.x, target.y);
    // Out of range, or hidden (brush / high ground): close in until it can be seen and hit.
    if (d > range + target.radius || !isVisibleTo(match, entity.ownerId, target)) {
      entity.moveTarget = { x: target.x, y: target.y };
    } else {
      entity.moveTarget = undefined;
    }
  }

  // Medic follow behavior
  for (const entity of entities) {
    if (entity.type !== "medic" || !entity.healTargetId) continue;
    const target = match.entities.get(entity.healTargetId);
    if (!target) { entity.healTargetId = undefined; continue; }
    const healRange = UNIT_DEFS.medic.range;
    const d = dist(entity.x, entity.y, target.x, target.y);
    if (d > healRange + entity.radius + target.radius) {
      entity.moveTarget = { x: target.x, y: target.y };
    } else if (entity.moveTarget) {
      if (!entity.attackTargetId) entity.moveTarget = undefined;
    }
  }

  // Resolve attacks
  for (const entity of entities) {
    if (!entity.attackTargetId) continue;
    const target = match.entities.get(entity.attackTargetId!);
    if (!target) { entity.attackTargetId = undefined; continue; }

    const range = getRange(entity, match.terrain);
    const d = dist(entity.x, entity.y, target.x, target.y);
    if (d > range + target.radius) {
      if (entity.type === "building") entity.attackTargetId = undefined;
      continue;
    }
    // Can't fire at what you can't see (G-6b): towers lose the target, units keep closing in.
    if (!isVisibleTo(match, entity.ownerId, target)) {
      if (entity.type === "building") entity.attackTargetId = undefined;
      continue;
    }

    // In range: stop moving to hold position
    if (entity.type !== "building") entity.moveTarget = undefined;

    if (entity.attackCooldown > 0) { entity.attackCooldown--; continue; }

    const baseDamage = getDamage(entity, match.config);
    const multiplier = getCounterMultiplier(entity.type, target.type, target.buildingType);
    const finalDamage = Math.round(baseDamage * multiplier);
    const currentDamage = damageLog.get(target.id) ?? 0;
    damageLog.set(target.id, currentDamage + finalDamage);
    match.attackLog.push({ attackerId: entity.id, targetId: target.id, damage: finalDamage, tick: match.tick, isHeal: false });

    entity.attackCooldown = getAttackCooldown(entity);
  }

  return damageLog;
}
