import { MAP, BUILD_ZONES, UNIT_DEFS, BUILDING_DEFS } from "../../shared/src/gameBalance.js";
/**
 * Expand a MacroAction into the raw engine commands it represents.
 * Returns an array of command objects accepted by MatchEngine.processCommand.
 */
export function expandMacroAction(action, match, playerId) {
    const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
    const playerColor = match.players[playerIdx]?.color ?? "blue";
    switch (action.type) {
        case "noop":
            return [];
        case "train_worker": {
            const crystal = findOwnCrystal(match, playerId);
            if (!crystal)
                return [];
            return [{ type: "train_worker", entityId: crystal.id }];
        }
        case "train_unit": {
            if (!action.unitType)
                return [];
            // Find a production building that produces this unit type and isn't full
            const building = findProductionBuilding(match, playerId, action.unitType);
            if (!building)
                return [];
            return [{ type: "train_unit", buildingId: building.id, entityId: building.id, unitType: action.unitType }];
        }
        case "build": {
            if (!action.buildingType)
                return [];
            const workers = getIdleWorkers(match, playerId, 1);
            if (workers.length === 0)
                return [];
            const pos = chooseBuildPosition(playerColor, action.xZone ?? "mid_base", action.yZone ?? "middle", match);
            if (!pos)
                return [];
            return [{
                    type: "build",
                    buildingType: action.buildingType,
                    targetX: pos.x,
                    targetY: pos.y,
                    workerIds: [workers[0].id],
                    entityId: workers[0].id,
                }];
        }
        case "attack_move": {
            const group = getUnitGroup(match, playerId, action.group ?? "all_combat");
            if (group.length === 0)
                return [];
            const target = resolveTargetZone(action.targetZone ?? "midfield", playerColor, match);
            return group.map(e => ({
                type: "move",
                entityId: e.id,
                targetX: target.x + (Math.random() * 60 - 30),
                targetY: target.y + (Math.random() * 60 - 30),
            }));
        }
        case "retreat": {
            const group = getUnitGroup(match, playerId, action.group ?? "all_combat");
            if (group.length === 0)
                return [];
            return [{ type: "retreat", entityIds: group.map(e => e.id) }];
        }
        case "assign_workers": {
            const idleWorkers = getIdleWorkers(match, playerId);
            const count = resolveWorkerCount(action.workerCount ?? "all_idle", idleWorkers.length);
            const chosen = idleWorkers.slice(0, count);
            if (chosen.length === 0)
                return [];
            const node = findNode(match, playerId, action.nodeChoice ?? "nearest_safe", chosen[0]);
            if (!node)
                return [];
            return chosen.map(w => ({ type: "gather", entityId: w.id, targetEntityId: node.id }));
        }
        case "set_rally": {
            const buildings = [...match.entities.values()].filter(e => e.ownerId === playerId && e.type === "building" && e.constructionProgress >= 100);
            if (buildings.length === 0)
                return [];
            const target = resolveTargetZone(action.targetZone ?? "midfield", playerColor, match);
            return buildings.map(b => ({ type: "set_rally", entityId: b.id, targetX: target.x, targetY: target.y }));
        }
        default:
            return [];
    }
}
// ---- Helpers ----
function findOwnCrystal(match, playerId) {
    for (const e of match.entities.values()) {
        if (e.type === "crystal" && e.ownerId === playerId)
            return e;
    }
}
function findProductionBuilding(match, playerId, unitType) {
    for (const e of match.entities.values()) {
        if (e.type !== "building" || e.ownerId !== playerId || e.constructionProgress < 100)
            continue;
        const def = e.buildingType ? BUILDING_DEFS[e.buildingType] : null;
        if (def?.produces?.includes(unitType)) {
            const economy = match.economy[match.players.findIndex(p => p?.playerId === playerId)];
            if (!economy)
                continue;
            const queuedSupply = (e.productionQueue ?? []).reduce((s, i) => s + i.supplyCost, 0);
            const unitDef = UNIT_DEFS[unitType];
            if (unitDef && economy.supply + queuedSupply + unitDef.supplyCost <= economy.maxSupply) {
                return e;
            }
        }
    }
}
function getIdleWorkers(match, playerId, min = 0) {
    const workers = [];
    for (const e of match.entities.values()) {
        if (e.type !== "worker" || e.ownerId !== playerId)
            continue;
        if (!e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId) {
            workers.push(e);
        }
    }
    return workers;
}
function getUnitGroup(match, playerId, group) {
    const results = [];
    for (const e of match.entities.values()) {
        if (e.ownerId !== playerId)
            continue;
        const isCombat = ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type);
        if (group === "all_combat" && isCombat) {
            results.push(e);
            continue;
        }
        if (group === "skirmishers" && e.type === "skirmisher") {
            results.push(e);
            continue;
        }
        if (group === "gunners" && e.type === "gunner") {
            results.push(e);
            continue;
        }
        if (group === "bruisers" && e.type === "bruiser") {
            results.push(e);
            continue;
        }
        if (group === "all_workers" && e.type === "worker") {
            results.push(e);
            continue;
        }
    }
    return results;
}
function chooseBuildPosition(color, xZone, yZone, match) {
    const mapW = MAP.width;
    const mapH = MAP.height;
    const isBlue = color === "blue";
    // X bands within the player's build zone (0-20% for blue, 80-100% for red)
    const zoneStart = isBlue ? 0 : mapW * BUILD_ZONES.redStartPct;
    const zoneEnd = isBlue ? mapW * BUILD_ZONES.blueEndPct : mapW;
    const zoneWidth = zoneEnd - zoneStart;
    const xBands = {
        near_crystal: zoneStart + zoneWidth * (isBlue ? 0.15 : 0.85),
        mid_base: zoneStart + zoneWidth * 0.5,
        forward: zoneStart + zoneWidth * (isBlue ? 0.8 : 0.2),
    };
    const yBands = {
        top: mapH * 0.2,
        middle: mapH * 0.5,
        bottom: mapH * 0.8,
    };
    const x = xBands[xZone ?? "mid_base"] ?? (zoneStart + zoneWidth * 0.5);
    const y = yBands[yZone ?? "middle"] ?? mapH * 0.5;
    // Add small jitter to avoid exact overlaps
    return {
        x: x + (Math.random() * 40 - 20),
        y: y + (Math.random() * 40 - 20),
    };
}
function resolveTargetZone(zone, playerColor, match) {
    const isBlue = playerColor === "blue";
    if (zone === "enemy_crystal") {
        const oppColor = isBlue ? "red" : "blue";
        for (const e of match.entities.values()) {
            if (e.type === "crystal" && e.color.includes(oppColor))
                return { x: e.x, y: e.y };
        }
        // Fallback: known crystal spawn position
        return { x: isBlue ? MAP.width - 100 : 100, y: MAP.height / 2 };
    }
    if (zone === "midfield") {
        return { x: MAP.width / 2, y: MAP.height / 2 };
    }
    if (zone === "contested_node") {
        // Find the nearest visible contested node
        const mid = MAP.width / 2;
        let nearest = { x: mid, y: MAP.height / 2 };
        let nearestDist = Infinity;
        for (const node of match.resourceNodes) {
            if (Math.abs(node.x - mid) < MAP.width * 0.35) {
                const dist = Math.abs(node.x - mid);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearest = node;
                }
            }
        }
        return nearest;
    }
    return { x: MAP.width / 2, y: MAP.height / 2 };
}
function findNode(match, playerId, choice, nearEntity) {
    const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
    const isBlue = match.players[playerIdx]?.color === "blue";
    const mid = MAP.width / 2;
    const availableNodes = match.resourceNodes.filter(n => n.remaining > 0 && n.gathererSlots.size < n.maxGathererSlots);
    if (choice === "nearest_safe") {
        const safe = availableNodes.filter(n => isBlue ? n.x < mid : n.x > mid);
        return safe.sort((a, b) => dist2(a, nearEntity) - dist2(b, nearEntity))[0];
    }
    if (choice === "nearest_contested") {
        const cont = availableNodes.filter(n => Math.abs(n.x - mid) < MAP.width * 0.35);
        return cont.sort((a, b) => dist2(a, nearEntity) - dist2(b, nearEntity))[0];
    }
    if (choice === "richest_visible") {
        return availableNodes.sort((a, b) => b.remaining - a.remaining)[0];
    }
    return availableNodes[0];
}
function resolveWorkerCount(choice, available) {
    if (choice === "all_idle")
        return available;
    return Math.min(choice, available);
}
function dist2(a, b) {
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
