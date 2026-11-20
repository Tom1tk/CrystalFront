import { UNIT_DEFS, GUARD, LEASH, RETALIATE, BULWARK, SURGES } from "@crystalfront/shared";
import type { MatchEntity, MatchState } from "../types.js";
import { dist, getRange, getDamage, getAttackCooldown, getCounterMultiplier } from "./utils.js";
import { isVisibleTo } from "./visibility.js";
import { surgeStage } from "./surges.js";

/** G-13 E2 threat order for auto-targeting: 0 combat units and finished turrets, 1 workers, 2 everything else. Lower wins. */
export function targetClass(o: Pick<MatchEntity, "type" | "buildingType" | "constructionProgress">): number {
  if (o.type === "worker" || o.type === "bulwark") return 1; // unarmed: shoot what shoots back first
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
  if (e.leash?.retaliate) return e.leash;
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

/** A covering bulwark is in place within this many px of its slot (and re-aims when the slot moves this far). */
const COVER_SLACK = 6;

export function processCombat(match: MatchState): Map<string, number> {
  const damageLog = new Map<string, number>();
  // Beta Surges II/III: units hit buildings and crystals harder (×1 in 0.9).
  const buildingDamage = SURGES.buildingDamage[surgeStage(match)];
  const entities = Array.from(match.entities.values());

  // Auto-attack acquisition: idle combat units pick an enemy in range, by threat
  // class then distance (G-13 E2), and switch to a better class when one comes
  // into range. Ordered targets are kept. Candidates per owner: other owners'
  // entities it could see at the end of last tick (G-6b), in entity order, built
  // once per owner per tick.
  const candidatesOf = new Map<string, typeof entities>();
  const candidatesFor = (ownerId: string) => {
    let c = candidatesOf.get(ownerId);
    if (!c) {
      c = entities.filter((o) => o.ownerId !== ownerId && isVisibleTo(match, ownerId, o));
      candidatesOf.set(ownerId, c);
    }
    return c;
  };
  for (const entity of entities) {
    if (entity.type === "bulwark") {
      // No weapon. On attack-move it stops short of the enemy line and holds there.
      entity.attackTargetId = undefined;
      if (entity.coverTargetId) {
        // Cover: stand between the covered unit and the nearest armed enemy near it, and follow it.
        const t = match.entities.get(entity.coverTargetId);
        if (!t || t.ownerId !== entity.ownerId) entity.coverTargetId = undefined;
        else {
          let near: MatchEntity | undefined, nd = BULWARK.coverSense;
          for (const o of candidatesFor(entity.ownerId)) {
            if (targetClass(o) !== 0) continue;
            const d = dist(t.x, t.y, o.x, o.y);
            if (d < nd) { nd = d; near = o; }
          }
          const toward = near ?? entities.find((c) => c.type === "crystal" && c.ownerId !== entity.ownerId);
          const len = toward ? dist(t.x, t.y, toward.x, toward.y) : 0;
          if (toward && len > 0) {
            const dx = (toward.x - t.x) / len, dy = (toward.y - t.y) / len;
            // Several bulwarks covering one unit stand side by side, in the order they already are across the line.
            const side = (b: MatchEntity) => (b.x - t.x) * -dy + (b.y - t.y) * dx;
            const mine = side(entity);
            let rank = 0, n = 0;
            for (const b of entities) {
              if (b.type !== "bulwark" || b.coverTargetId !== t.id || b.ownerId !== entity.ownerId) continue;
              n++;
              if (b !== entity && (side(b) < mine || (side(b) === mine && b.id < entity.id))) rank++;
            }
            const off = (rank - (n - 1) / 2) * BULWARK.halfWidth * 2;
            let sx = t.x + dx * BULWARK.coverDist - dy * off, sy = t.y + dy * BULWARK.coverDist + dx * off;
            // Behind its unit with the unit in the way: go round it first, on the side it is already on
            // (dead behind: toward the middle of the map, which keeps mirrored games mirrored).
            const clear = entity.radius + t.radius + 4;
            if ((entity.x - t.x) * dx + (entity.y - t.y) * dy < 0 && Math.abs(mine) < clear) {
              let sgn = mine > 1e-6 ? 1 : mine < -1e-6 ? -1 : 0;
              if (!sgn) {
                sgn = Math.abs(dx) > 1e-6 ? ((dx > 0) === (t.y < match.config.mapHeight / 2) ? 1 : -1)
                  : ((-dy > 0) === (t.x < match.config.mapWidth / 2) ? 1 : -1);
              }
              // (a little ahead of level with it, so that arriving there counts as past it)
              sx = t.x + dx * 2 * COVER_SLACK - dy * sgn * clear; sy = t.y + dy * 2 * COVER_SLACK + dx * sgn * clear;
            }
            if (dist(entity.x, entity.y, sx, sy) <= COVER_SLACK) entity.moveTarget = undefined;
            else if (!entity.moveTarget || dist(entity.moveTarget.x, entity.moveTarget.y, sx, sy) > COVER_SLACK) entity.moveTarget = { x: sx, y: sy };
          }
          continue;
        }
      }
      if (entity.moveOrder?.attack) {
        const held = candidatesFor(entity.ownerId).some((o) => targetClass(o) === 0 && dist(entity.x, entity.y, o.x, o.y) <= BULWARK.standoff + o.radius);
        if (held) entity.moveTarget = undefined;
        else if (!entity.moveTarget) entity.moveTarget = { x: entity.moveOrder.x, y: entity.moveOrder.y };
      }
      continue;
    }
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
    const range = getRange(entity, match.terrain);
    // A unit on its way to a retaliation target (G-14) fights what it meets first.
    let enRoute = false;
    if (entity.attackTargetId) {
      const cur = match.entities.get(entity.attackTargetId);
      curClass = cur ? targetClass(cur) : Infinity;
      enRoute = !!cur && !!entity.leash?.retaliate && dist(entity.x, entity.y, cur.x, cur.y) > range + cur.radius;
      if (curClass === 0 && !enRoute) continue;
    }

    // Standing guard (G-13 E4): melee units react further out, but only to enemies
    // they can reach without leaving the guard circle.
    const guard = entity.type !== "building" && guarding(entity) && !entity.leash?.retaliate ? entity.guard : null;
    const def = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
    const reach = guard && def && def.range < GUARD.rangedMinRange ? Math.max(range, (def.visionRange ?? 0) * GUARD.acquireFrac) : range;
    const guardReach = guard ? guardRadius(entity) + range : 0;
    let nearestDist = Infinity, nearestClass = Infinity;
    let nearestId: string | undefined;
    for (const other of candidatesFor(entity.ownerId)) {
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
    if (nearestId && (nearestClass < curClass || (enRoute && nearestClass === curClass))) {
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
  const shotBy = new Map<MatchEntity, MatchEntity>(); // victim → first attacker this tick
  // Bulwarks with the direction each faces: toward the enemy crystal.
  const bulwarks: { e: MatchEntity; fx: number; fy: number }[] = [];
  for (const e of entities) {
    if (e.type !== "bulwark") continue;
    const crystal = entities.find((c) => c.type === "crystal" && c.ownerId !== e.ownerId);
    if (!crystal) continue;
    const d = dist(e.x, e.y, crystal.x, crystal.y) || 1;
    bulwarks.push({ e, fx: (crystal.x - e.x) / d, fy: (crystal.y - e.y) / d });
  }
  for (const entity of entities) {
    if (!entity.attackTargetId) continue;
    let target = match.entities.get(entity.attackTargetId!);
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

    // A ranged shot whose line crosses the front of an enemy bulwark hits the bulwark instead
    // (the first one along the shot). Melee is never blocked.
    let blockedFor: string | undefined;
    if (bulwarks.length && (entity.type === "building" || (UNIT_DEFS[entity.type]?.range ?? 0) >= GUARD.rangedMinRange)) {
      const sx = target.x - entity.x, sy = target.y - entity.y, len2 = sx * sx + sy * sy;
      let bestT = 1, blocker: MatchEntity | undefined;
      for (const b of bulwarks) {
        if (b.e === target || b.e.ownerId === entity.ownerId) continue;
        if ((damageLog.get(b.e.id) ?? 0) >= b.e.health) continue; // already broken this tick
        const bx = b.e.x - entity.x, by = b.e.y - entity.y;
        if (bx * b.fx + by * b.fy >= 0) continue; // shooter is behind the shield
        const t = len2 > 0 ? (bx * sx + by * sy) / len2 : 0;
        if (t <= 0 || t >= bestT) continue;
        if (dist(entity.x + sx * t, entity.y + sy * t, b.e.x, b.e.y) > BULWARK.halfWidth) continue;
        bestT = t; blocker = b.e;
      }
      if (blocker) { blockedFor = target.id; target = blocker; }
    }

    const baseDamage = getDamage(entity, match.config);
    const siege = entity.type !== "building" && (target.type === "building" || target.type === "crystal") ? buildingDamage : 1;
    const multiplier = getCounterMultiplier(entity.type, target.type, target.buildingType) * siege;
    const finalDamage = Math.round(baseDamage * multiplier);
    const currentDamage = damageLog.get(target.id) ?? 0;
    damageLog.set(target.id, currentDamage + finalDamage);
    match.attackLog.push({ attackerId: entity.id, targetId: target.id, damage: finalDamage, tick: match.tick, isHeal: false, ...(blockedFor ? { blockedFor } : {}) });

    entity.attackCooldown = getAttackCooldown(entity);
    if (!shotBy.has(target)) shotBy.set(target, entity);
  }

  // Retaliation (G-14): a holding combat unit (idle or on guard) with nothing to attack goes for
  // the nearest enemy that damaged it, a nearby ally or a nearby building of its own this tick,
  // even outside its own reach or guard circle.
  if (shotBy.size) {
    for (const u of entities) {
      if (u.attackTargetId || !u.autoAttackEnabled || (u.moveOrder && !u.moveOrder.attack)) continue;
      if (u.type !== "skirmisher" && u.type !== "gunner" && u.type !== "bruiser") continue;
      let best: MatchEntity | undefined, bestD = Infinity;
      for (const [victim, attacker] of shotBy) {
        if (victim.ownerId !== u.ownerId || attacker.ownerId === u.ownerId) continue;
        if (u !== victim && dist(u.x, u.y, victim.x, victim.y) > RETALIATE.assist + victim.radius) continue;
        const d = dist(u.x, u.y, attacker.x, attacker.y);
        if (d < bestD) { bestD = d; best = attacker; }
      }
      if (!best) continue;
      const anchor = guarding(u) ? u.guard : u;
      u.attackTargetId = best.id;
      u.leash = { x: anchor.x, y: anchor.y, r: RETALIATE.chase, retaliate: true };
    }
  }

  return damageLog;
}
