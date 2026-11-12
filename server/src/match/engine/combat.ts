import { UNIT_DEFS, GUARD, LEASH } from "@crystalfront/shared";
import type { MatchEntity, MatchState } from "../types.js";
import { dist, getRange, getDamage, getAttackCooldown, getCounterMultiplier } from "./utils.js";
import { isVisibleTo } from "./visibility.js";

/** G-13 E2 threat order for auto-targeting: 0 combat units and finished turrets, 1 workers, 2 everything else. Lower wins. */
export function targetClass(o: Pick<MatchEntity, "type" | "buildingType" | "constructionProgress">): number {
  if (o.type === "worker") return 1;
  if (o.type === "building") return o.buildingType === "turret" && o.constructionProgress >= 100 ? 0 : 2;
  if (o.type === "crystal" || o.type === "resource_node" || o.type === "placeholder") return 2;
  return 0;
}

/** G-13 E4: radius of the circle a guarding unit defends. */
export function guardRadius(e: Pick<MatchEntity, "type">): number {
  return (UNIT_DEFS[e.type as keyof typeof UNIT_DEFS]?.visionRange ?? 0) * GUARD.radiusFrac;
}

/** Is the unit standing guard (guard point set and the walk there finished)? */
function guarding(e: MatchEntity): e is MatchEntity & { guard: { x: number; y: number } } {
  return !!e.guard && !e.moveOrder;
}

/** Circle the unit's current target may be chased within, or null (ordered targets, buildings). */
function chaseCircle(e: MatchEntity): { x: number; y: number; r: number } | null {
  if (e.attackOrdered) return null;
  if (guarding(e)) return { x: e.guard.x, y: e.guard.y, r: guardRadius(e) };
  return e.leash ?? null;
}

/** Give up an auto-acquired target and go back to what the unit was doing (G-13 E3/E4). */
function release(e: MatchEntity, circle: { x: number; y: number }): void {
  e.attackTargetId = undefined;
  e.leash = undefined;
  if (guarding(e)) e.moveTarget = { x: e.guard.x, y: e.guard.y };
  else if (e.moveOrder?.attack) e.moveTarget = { x: e.moveOrder.x, y: e.moveOrder.y };
  else e.moveTarget = { x: circle.x, y: circle.y };
}

export function processCombat(match: MatchState): Map<string, number> {
  const damageLog = new Map<string, number>();
  const entities = Array.from(match.entities.values());

  // Auto-attack acquisition: idle combat units pick an enemy in range, by threat
  // class then distance (G-13 E2), and switch to a better class when one comes
  // into range. Ordered targets are kept. Candidates per owner: other owners'
  // entities it could see at the end of last tick (G-6b), in entity order, built
  // once per owner per tick.
  const candidatesOf = new Map<string, typeof entities>();
  for (const entity of entities) {
    if (!entity.attackTargetId) {
      if (entity.attackOrdered) entity.attackOrdered = undefined;
      if (entity.leash) entity.leash = undefined;
    }
    if (!entity.autoAttackEnabled) continue;
    // Plain move order: ignore enemies until arrival (G-1)
    if (entity.moveOrder && !entity.moveOrder.attack) continue;
    if (entity.type === "building") {
      if (entity.constructionProgress < 100) continue;
    }
    if (entity.attackOrdered) continue;
    let curClass = Infinity;
    if (entity.attackTargetId) {
      const cur = match.entities.get(entity.attackTargetId);
      curClass = cur ? targetClass(cur) : Infinity;
      if (curClass === 0) continue;
    }

    const range = getRange(entity, match.terrain);
    // Standing guard (G-13 E4): melee units react further out, but only to enemies
    // they can reach without leaving the guard circle.
    const guard = entity.type !== "building" && guarding(entity) ? entity.guard : null;
    const def = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
    const reach = guard && def && def.range < GUARD.rangedMinRange ? Math.max(range, (def.visionRange ?? 0) * GUARD.acquireFrac) : range;
    const guardReach = guard ? guardRadius(entity) + range : 0;
    let nearestDist = Infinity, nearestClass = Infinity;
    let nearestId: string | undefined;
    let candidates = candidatesOf.get(entity.ownerId);
    if (!candidates) {
      candidates = entities.filter((o) => o.ownerId !== entity.ownerId && isVisibleTo(match, entity.ownerId, o));
      candidatesOf.set(entity.ownerId, candidates);
    }
    for (const other of candidates) {
      // Workers cannot initiate combat on crystals or buildings — only workers and combat units
      if (entity.type === "worker" && (other.type === "crystal" || other.type === "building")) continue;
      const d = dist(entity.x, entity.y, other.x, other.y);
      if (d > reach + other.radius) continue;
      if (guard && dist(guard.x, guard.y, other.x, other.y) > guardReach + other.radius) continue;
      const c = targetClass(other);
      if (c < nearestClass || (c === nearestClass && d < nearestDist)) {
        nearestDist = d;
        nearestClass = c;
        nearestId = other.id;
      }
    }
    if (nearestId && nearestClass < curClass) {
      entity.attackTargetId = nearestId;
      if (entity.type !== "building" && !guard && !entity.leash) entity.leash = { x: entity.x, y: entity.y, r: LEASH.chase };
    } else if (entity.attackTargetId) {
      // keep the current target
    } else if (guard) {
      // Nothing to fight: walk back to the guard point.
      if (!entity.moveTarget && dist(entity.x, entity.y, guard.x, guard.y) > GUARD.returnSlack) entity.moveTarget = { x: guard.x, y: guard.y };
    } else if (entity.moveOrder?.attack && !entity.moveTarget) {
      // Attack-move with nothing to fight: resume toward the order's destination
      entity.moveTarget = { x: entity.moveOrder.x, y: entity.moveOrder.y };
    }
  }

  // Attack chase: units with attackTargetId move toward target if out of range.
  // When already in range, clear moveTarget so the unit holds position rather than
  // continuing to drift toward the exact center (which causes crowding on large targets).
  // Auto-acquired targets are chased only inside the leash or guard circle (G-13 E3/E4).
  for (const entity of entities) {
    if (!entity.attackTargetId) continue;
    if (entity.type === "crystal" || entity.type === "building") continue;
    const target = match.entities.get(entity.attackTargetId);
    if (!target) { entity.attackTargetId = undefined; continue; }
    const range = getRange(entity, match.terrain);
    const d = dist(entity.x, entity.y, target.x, target.y);
    const circle = chaseCircle(entity);
    // Can't be hit from anywhere inside the circle: let it go.
    if (circle && dist(circle.x, circle.y, target.x, target.y) > circle.r + range + target.radius) { release(entity, circle); continue; }
    // Out of range, or hidden (brush / high ground): close in until it can be seen and hit.
    if (d > range + target.radius || !isVisibleTo(match, entity.ownerId, target)) {
      let tx = target.x, ty = target.y;
      if (circle) {
        const c = dist(circle.x, circle.y, tx, ty);
        if (c > circle.r) {
          tx = circle.x + (tx - circle.x) * circle.r / c;
          ty = circle.y + (ty - circle.y) * circle.r / c;
          // Already at the edge and still can't hit it: let it go.
          if (dist(entity.x, entity.y, tx, ty) <= GUARD.returnSlack) { release(entity, circle); continue; }
        }
      }
      entity.moveTarget = { x: tx, y: ty };
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
