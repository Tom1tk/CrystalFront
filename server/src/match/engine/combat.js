import { UNIT_DEFS } from "@crystalfront/shared";
import { dist, getRange, getDamage, getAttackCooldown, getCounterMultiplier } from "./utils.js";
export function processCombat(match) {
    const damageLog = new Map();
    const entities = Array.from(match.entities.values());
    // Auto-attack acquisition: idle combat units find nearest enemy in range
    for (const entity of entities) {
        if (!entity.autoAttackEnabled)
            continue;
        if (entity.commandedTicks !== undefined && entity.commandedTicks > 0) {
            entity.commandedTicks--;
        }
        if (entity.commandedTicks !== undefined && entity.commandedTicks > 0)
            continue;
        if (entity.type === "building") {
            if (entity.constructionProgress < 100)
                continue;
        }
        if (entity.attackTargetId)
            continue;
        let nearestDist = Infinity;
        let nearestId;
        for (const other of entities) {
            if (other.ownerId === entity.ownerId)
                continue;
            // Workers cannot initiate combat on crystals or buildings — only workers and combat units
            if (entity.type === "worker" && (other.type === "crystal" || other.type === "building"))
                continue;
            const range = getRange(entity);
            const d = dist(entity.x, entity.y, other.x, other.y);
            if (d <= range + other.radius && d < nearestDist) {
                nearestDist = d;
                nearestId = other.id;
            }
        }
        if (nearestId)
            entity.attackTargetId = nearestId;
    }
    // Attack chase: units with attackTargetId move toward target if out of range
    for (const entity of entities) {
        if (!entity.attackTargetId)
            continue;
        if (entity.type === "crystal" || entity.type === "building")
            continue;
        const target = match.entities.get(entity.attackTargetId);
        if (!target) {
            entity.attackTargetId = undefined;
            continue;
        }
        const range = getRange(entity);
        const d = dist(entity.x, entity.y, target.x, target.y);
        if (d > range + target.radius) {
            entity.moveTarget = { x: target.x, y: target.y };
        }
    }
    // Medic follow behavior
    for (const entity of entities) {
        if (entity.type !== "medic" || !entity.healTargetId)
            continue;
        const target = match.entities.get(entity.healTargetId);
        if (!target) {
            entity.healTargetId = undefined;
            continue;
        }
        const healRange = UNIT_DEFS.medic.range;
        const d = dist(entity.x, entity.y, target.x, target.y);
        if (d > healRange + entity.radius + target.radius) {
            entity.moveTarget = { x: target.x, y: target.y };
        }
        else if (entity.moveTarget) {
            if (!entity.attackTargetId)
                entity.moveTarget = undefined;
        }
    }
    // Resolve attacks
    for (const entity of entities) {
        if (!entity.attackTargetId)
            continue;
        const target = match.entities.get(entity.attackTargetId);
        if (!target) {
            entity.attackTargetId = undefined;
            continue;
        }
        const range = getRange(entity);
        const d = dist(entity.x, entity.y, target.x, target.y);
        if (d > range + target.radius) {
            if (entity.type === "building")
                entity.attackTargetId = undefined;
            continue;
        }
        // In range: stop moving to hold position
        if (entity.type !== "building")
            entity.moveTarget = undefined;
        if (entity.attackCooldown > 0) {
            entity.attackCooldown--;
            continue;
        }
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
