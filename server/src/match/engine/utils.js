/**
 * Shared pure helpers used by multiple engine phase modules.
 * No match mutation here — all functions return values or are read-only.
 */
import { UNIT_DEFS, BUILDING_DEFS, SIMULATION, COUNTER_MODIFIER, } from "@crystalfront/shared";
// ── Spatial ────────────────────────────────────────────────────────────────────
export function dist(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
}
export function buildSpatialGrid(entities, cellSize) {
    const grid = new Map();
    for (const entity of entities) {
        const key = `${Math.floor(entity.x / cellSize)},${Math.floor(entity.y / cellSize)}`;
        if (!grid.has(key))
            grid.set(key, []);
        grid.get(key).push(entity);
    }
    return grid;
}
// ── Vision ─────────────────────────────────────────────────────────────────────
export function getVisionRange(entity) {
    if (entity.type === "building" && entity.buildingType) {
        const def = BUILDING_DEFS[entity.buildingType];
        return def?.visionRange ?? 100;
    }
    if (entity.type === "crystal") {
        return SIMULATION.crystalVisionRange;
    }
    const def = UNIT_DEFS[entity.type];
    return def?.visionRange ?? SIMULATION.defaultVisionRange;
}
// ── Combat stats ───────────────────────────────────────────────────────────────
export function getRange(entity) {
    if (entity.type === "building" && entity.buildingType === "turret") {
        return BUILDING_DEFS.turret.range ?? 150;
    }
    const unitDef = UNIT_DEFS[entity.type];
    // Add own radius so melee range is measured from unit edge, not center
    return (unitDef?.range ?? 20) + entity.radius;
}
export function getDamage(entity, config) {
    if (entity.type === "building" && entity.buildingType === "turret") {
        return BUILDING_DEFS.turret.damage ?? 18;
    }
    if (entity.type === "skirmisher" && config?.skirmisherDamage !== undefined) {
        return config.skirmisherDamage;
    }
    const unitDef = UNIT_DEFS[entity.type];
    return unitDef?.damage ?? 5;
}
export function getAttackCooldown(entity) {
    if (entity.type === "building" && entity.buildingType === "turret") {
        return BUILDING_DEFS.turret.attackCooldown ?? 12;
    }
    const unitDef = UNIT_DEFS[entity.type];
    return unitDef?.attackCooldown ?? 20;
}
export function getCounterMultiplier(attackerType, defenderType, defenderBuildingType) {
    // Attackers: turret acts like a gunner offensively
    const effectiveAttacker = attackerType === "building" ? "gunner" : attackerType;
    // Defenders: turret acts like a gunner (skirmisher counters it 2×);
    // all other buildings act like workers (no counter bonus applies)
    const effectiveDefender = defenderType !== "building" ? defenderType
        : defenderBuildingType === "turret" ? "gunner"
            : "worker";
    return COUNTER_MODIFIER[effectiveAttacker]?.[effectiveDefender] ?? 1.0;
}
