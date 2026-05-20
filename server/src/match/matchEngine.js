import fs from "node:fs";
import pathLib from "node:path";
import { Rng } from "./engine/rng.js";
import { IdGen } from "./engine/idGen.js";
import { createMap } from "./map.js";
import { DEFAULT_CONFIG } from "./types.js";
import { BUILDING_DEFS, UNIT_DEFS, GATHERING, SIMULATION, ECONOMY } from "@crystalfront/shared";
import { computeVisibility } from "./engine/visibility.js";
import { processMovement } from "./engine/movement.js";
import { processCombat } from "./engine/combat.js";
import { processGathering } from "./engine/gathering.js";
import { processRepairAndHealing } from "./engine/repair.js";
import { dist } from "./engine/utils.js";
import { validatePlacement, } from "./buildingValidation.js";
const GATHER_RANGE = GATHERING.range;
export class MatchEngine {
    matches = new Map();
    broadcastCallback = null;
    matchEndCallback = null;
    nextMatchId = 0;
    setBroadcastCallback(cb) {
        this.broadcastCallback = cb;
    }
    setMatchEndCallback(cb) {
        this.matchEndCallback = cb;
    }
    createMatch(lobbyCode, players, config = DEFAULT_CONFIG, seed) {
        const id = `match-${++this.nextMatchId}`;
        const resolvedSeed = seed ?? (Date.now() & 0xffffffff);
        const rng = new Rng(resolvedSeed);
        const idGen = new IdGen();
        const map = createMap(config);
        const entities = new Map();
        // Create crystals
        const blueCrystal = this.createEntity(idGen, "crystal", players[0]?.playerId ?? "", map.blueCrystal.x, map.blueCrystal.y, config.crystalHealth, config.crystalRadius, players[0]?.color === "blue" ? "#4488ff" : "#888888");
        const redCrystal = this.createEntity(idGen, "crystal", players[1]?.playerId ?? "", map.redCrystal.x, map.redCrystal.y, config.crystalHealth, config.crystalRadius, players[1]?.color === "red" ? "#ff4444" : "#888888");
        entities.set(blueCrystal.id, blueCrystal);
        entities.set(redCrystal.id, redCrystal);
        // Create workers
        const blueWorkers = [
            this.createEntity(idGen, "worker", players[0]?.playerId ?? "", map.blueWorkers[0].x, map.blueWorkers[0].y, config.workerHealth, config.workerRadius, players[0]?.color === "blue" ? "#6699ff" : "#888888"),
            this.createEntity(idGen, "worker", players[0]?.playerId ?? "", map.blueWorkers[1].x, map.blueWorkers[1].y, config.workerHealth, config.workerRadius, players[0]?.color === "blue" ? "#6699ff" : "#888888"),
            this.createEntity(idGen, "worker", players[0]?.playerId ?? "", map.blueWorkers[2].x, map.blueWorkers[2].y, config.workerHealth, config.workerRadius, players[0]?.color === "blue" ? "#6699ff" : "#888888"),
        ];
        const redWorkers = [
            this.createEntity(idGen, "worker", players[1]?.playerId ?? "", map.redWorkers[0].x, map.redWorkers[0].y, config.workerHealth, config.workerRadius, players[1]?.color === "red" ? "#ff6666" : "#888888"),
            this.createEntity(idGen, "worker", players[1]?.playerId ?? "", map.redWorkers[1].x, map.redWorkers[1].y, config.workerHealth, config.workerRadius, players[1]?.color === "red" ? "#ff6666" : "#888888"),
            this.createEntity(idGen, "worker", players[1]?.playerId ?? "", map.redWorkers[2].x, map.redWorkers[2].y, config.workerHealth, config.workerRadius, players[1]?.color === "red" ? "#ff6666" : "#888888"),
        ];
        for (const w of blueWorkers)
            entities.set(w.id, w);
        for (const w of redWorkers)
            entities.set(w.id, w);
        // Create resource nodes
        const resourceNodes = [];
        const allNodeLayouts = [
            ...map.blueSafeNodes.map((n) => ({ ...n, ownerId: players[0]?.playerId ?? "" })),
            ...map.redSafeNodes.map((n) => ({ ...n, ownerId: players[1]?.playerId ?? "" })),
            ...map.contestedNodes.map((n) => ({ ...n, ownerId: "" })),
        ];
        for (const layout of allNodeLayouts) {
            const node = {
                id: idGen.next(),
                x: layout.x,
                y: layout.y,
                radius: layout.radius,
                color: "#ccaa44",
                capacity: layout.capacity,
                remaining: layout.capacity,
                maxGathererSlots: 3,
                gathererSlots: new Set(),
                accumulatedGather: 0,
            };
            resourceNodes.push(node);
        }
        // Create economy for each player
        const economy = [
            players[0]
                ? {
                    resources: config.startingResources,
                    supply: 3 * config.workerSupplyCost, // 3 starting workers
                    maxSupply: config.startingMaxSupply,
                    lifetimeResources: 0,
                }
                : null,
            players[1]
                ? {
                    resources: config.startingResources,
                    supply: 3 * config.workerSupplyCost, // 3 starting workers
                    maxSupply: config.startingMaxSupply,
                    lifetimeResources: 0,
                }
                : null,
        ];
        const match = {
            id,
            lobbyCode,
            phase: "spawn",
            tick: 0,
            tickIntervalMs: config.tickIntervalMs,
            players,
            entities,
            attackLog: [],
            result: null,
            startedAt: Date.now(),
            endedAt: null,
            economy,
            resourceNodes,
            config,
            mapWidth: config.mapWidth,
            mapHeight: config.mapHeight,
            rng,
            idGen,
            seed: resolvedSeed,
            commandLog: [],
        };
        this.matches.set(id, match);
        return match;
    }
    startMatch(matchId) {
        const match = this.matches.get(matchId);
        if (!match)
            return null;
        if (match.phase !== "spawn")
            return null;
        match.phase = "playing";
        return match;
    }
    endMatch(matchId, winner) {
        const match = this.matches.get(matchId);
        if (!match)
            return null;
        match.phase = "ended";
        match.result = { winner };
        match.endedAt = Date.now();
        // Notify server to broadcast MATCH_END event
        if (this.matchEndCallback) {
            this.matchEndCallback(matchId, winner);
        }
        return match;
    }
    getMatch(matchId) {
        return this.matches.get(matchId);
    }
    getAllMatches() {
        return Array.from(this.matches.values());
    }
    debugSpawn(matchId, playerId, entityType, x, y, buildingType) {
        const match = this.matches.get(matchId);
        if (!match)
            return { success: false, message: "Match not found" };
        const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
        if (playerIdx < 0)
            return { success: false, message: "Player not found" };
        const playerColor = match.players[playerIdx]?.color ?? "blue";
        const color = playerColor === "blue" ? "#6699ff" : "#ff6666";
        if (x < 0 || x > match.config.mapWidth || y < 0 || y > match.config.mapHeight) {
            return { success: false, message: "Position out of bounds" };
        }
        if (entityType === "building") {
            if (!buildingType || !(buildingType in BUILDING_DEFS)) {
                return { success: false, message: "Invalid building type" };
            }
            const def = BUILDING_DEFS[buildingType];
            const building = this.createEntity(match.idGen, "building", playerId, x, y, def.health, Math.max(def.width, def.height) / 2, def.color, buildingType);
            // Fully constructed — bypass build process
            building.constructionProgress = 100;
            building.health = def.health;
            match.entities.set(building.id, building);
            return { success: true };
        }
        const unitDef = UNIT_DEFS[entityType];
        if (!unitDef) {
            return { success: false, message: "Invalid unit type" };
        }
        const unit = this.createEntity(match.idGen, entityType, playerId, x, y, unitDef.health, unitDef.radius, unitDef.color);
        match.entities.set(unit.id, unit);
        return { success: true };
    }
    processCommand(matchId, playerId, command) {
        const match = this.matches.get(matchId);
        if (!match)
            return { success: false };
        if (match.phase !== "playing")
            return { success: false };
        const config = match.config;
        const ok = () => {
            match.commandLog.push({ tick: match.tick, playerId, command: command });
            return { success: true };
        };
        if (command.type === "deselect") {
            return ok();
        }
        if (command.type === "move") {
            const entity = command.entityId ? match.entities.get(command.entityId) : undefined;
            if (!entity || entity.ownerId !== playerId)
                return { success: false, message: "Entity not found" };
            // Only movable units can move
            if (entity.type === "crystal" || entity.type === "building") {
                return { success: false, message: "Unit cannot move" };
            }
            if (command.targetX !== undefined && command.targetY !== undefined) {
                // Clamp to map bounds
                const clampedX = Math.max(entity.radius, Math.min(config.mapWidth - entity.radius, command.targetX));
                const clampedY = Math.max(entity.radius, Math.min(config.mapHeight - entity.radius, command.targetY));
                entity.moveTarget = { x: clampedX, y: clampedY };
                entity.attackTargetId = undefined;
                entity.healTargetId = undefined;
                entity.commandedTicks = 1;
            }
            // Clean up gathering assignment when moving
            if (entity.type === "worker" && entity.gatheringNodeId) {
                const prevNode = match.resourceNodes.find((n) => n.id === entity.gatheringNodeId);
                if (prevNode) {
                    prevNode.gathererSlots.delete(entity.id);
                }
                entity.gatheringNodeId = undefined;
            }
            // Clean up building assignment when moving
            if (entity.buildTargetId) {
                const building = match.entities.get(entity.buildTargetId);
                if (building && building.buildWorkerIds) {
                    building.buildWorkerIds.delete(entity.id);
                }
                entity.buildTargetId = undefined;
            }
            return ok();
        }
        if (command.type === "gather") {
            const worker = command.entityId ? match.entities.get(command.entityId) : undefined;
            if (!worker || worker.type !== "worker" || worker.ownerId !== playerId)
                return { success: false, message: "Worker not found" };
            // Remove from previous node if gathering elsewhere
            if (worker.gatheringNodeId) {
                const prevNode = match.resourceNodes.find((n) => n.id === worker.gatheringNodeId);
                if (prevNode) {
                    prevNode.gathererSlots.delete(worker.id);
                }
            }
            // Clean up building assignment when gathering
            if (worker.buildTargetId) {
                const building = match.entities.get(worker.buildTargetId);
                if (building && building.buildWorkerIds) {
                    building.buildWorkerIds.delete(worker.id);
                }
                worker.buildTargetId = undefined;
            }
            const targetNode = match.resourceNodes.find((n) => n.id === command.targetEntityId);
            if (!targetNode)
                return { success: false, message: "Resource node not found" };
            if (targetNode.remaining <= 0)
                return { success: false, message: "Node is depleted" };
            if (targetNode.gathererSlots.size >= targetNode.maxGathererSlots)
                return { success: false, message: "Node is full" };
            worker.gatheringNodeId = targetNode.id;
            targetNode.gathererSlots.add(worker.id);
            return ok();
        }
        if (command.type === "train_worker") {
            const crystal = command.entityId ? match.entities.get(command.entityId) : undefined;
            if (!crystal || crystal.type !== "crystal" || crystal.ownerId !== playerId)
                return { success: false, message: "Crystal not found" };
            const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
            if (playerIdx < 0)
                return { success: false, message: "Player not found" };
            const economy = match.economy[playerIdx];
            if (!economy)
                return { success: false, message: "No economy" };
            if (economy.resources < config.workerTrainCost) {
                return { success: false, message: "Not enough resources" };
            }
            if (economy.supply + config.workerSupplyCost > economy.maxSupply) {
                return { success: false, message: "Not enough supply" };
            }
            const spawn = this.spawnOutside(match.rng, crystal, config.workerRadius);
            const newWorker = this.createEntity(match.idGen, "worker", playerId, spawn.x, spawn.y, config.workerHealth, config.workerRadius, match.players[playerIdx]?.color === "blue" ? "#6699ff" : "#ff6666");
            match.entities.set(newWorker.id, newWorker);
            economy.resources -= config.workerTrainCost;
            economy.supply += config.workerSupplyCost;
            return ok();
        }
        if (command.type === "train_unit") {
            const buildingId = command.buildingId ?? command.entityId;
            if (!buildingId) {
                return { success: false, message: "Missing building ID" };
            }
            const building = match.entities.get(buildingId);
            if (!building || building.type !== "building" || building.ownerId !== playerId) {
                return { success: false, message: "Invalid building" };
            }
            if (building.constructionProgress < 100) {
                return { success: false, message: "Building not yet constructed" };
            }
            const unitType = (command.unitType ?? command.targetEntityId);
            if (!unitType || !(unitType in UNIT_DEFS)) {
                return { success: false, message: "Invalid unit type" };
            }
            const unitDef = UNIT_DEFS[unitType];
            const buildingDef = building.buildingType ? BUILDING_DEFS[building.buildingType] : null;
            if (!buildingDef?.produces?.includes(unitType)) {
                return { success: false, message: "Building cannot produce this unit" };
            }
            const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
            if (playerIdx < 0)
                return { success: false, message: "Player not found" };
            const economy = match.economy[playerIdx];
            if (!economy)
                return { success: false, message: "No economy" };
            // Check total queue supply demand across ALL production buildings
            const queuedSupply = Array.from(match.entities.values())
                .filter((e) => e.ownerId === playerId && e.type === "building")
                .reduce((sum, b) => sum + (b.productionQueue ?? []).reduce((s, item) => s + item.supplyCost, 0), 0);
            if (economy.supply + queuedSupply + unitDef.supplyCost > economy.maxSupply) {
                return { success: false, message: "Not enough supply" };
            }
            if (economy.resources < unitDef.cost) {
                return { success: false, message: "Not enough resources" };
            }
            // Deduct resources immediately on queue
            economy.resources -= unitDef.cost;
            building.productionQueue.push({
                unitType,
                cost: unitDef.cost,
                supplyCost: unitDef.supplyCost,
                buildTime: unitDef.buildTime,
                remainingTicks: unitDef.buildTime,
            });
            return ok();
        }
        if (command.type === "cancel_queue") {
            const building = command.entityId ? match.entities.get(command.entityId) : undefined;
            if (!building || building.type !== "building" || building.ownerId !== playerId)
                return { success: false, message: "Building not found" };
            const queueIndex = command.targetX ?? 0;
            if (!building.productionQueue || building.productionQueue.length === 0) {
                return { success: false, message: "Queue is empty" };
            }
            const item = building.productionQueue[queueIndex];
            if (!item)
                return { success: false, message: "Queue item not found" };
            // Refund resources
            const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
            if (playerIdx >= 0 && match.economy[playerIdx]) {
                match.economy[playerIdx].resources += item.cost;
            }
            building.productionQueue.splice(queueIndex, 1);
            return ok();
        }
        if (command.type === "build") {
            const buildingType = command.buildingType;
            if (!buildingType || !(buildingType in BUILDING_DEFS)) {
                return { success: false, message: "Invalid building type" };
            }
            const def = BUILDING_DEFS[buildingType];
            const targetX = command.targetX;
            const targetY = command.targetY;
            if (targetX === undefined || targetY === undefined) {
                return { success: false, message: "Missing placement position" };
            }
            const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
            if (playerIdx < 0)
                return { success: false, message: "Player not found in match" };
            const economy = match.economy[playerIdx];
            if (!economy)
                return { success: false, message: "No economy" };
            if (economy.resources < def.cost) {
                return { success: false, message: "Not enough resources" };
            }
            // Validate workers
            const workerIds = command.workerIds;
            if (!workerIds || workerIds.length === 0) {
                return { success: false, message: "No workers specified" };
            }
            for (const wid of workerIds) {
                const worker = match.entities.get(wid);
                if (!worker || worker.type !== "worker" || worker.ownerId !== playerId) {
                    return { success: false, message: "Invalid worker" };
                }
                if (worker.buildTargetId) {
                    return { success: false, message: "Worker already building" };
                }
            }
            // Determine player color
            const playerColor = match.players[playerIdx]?.color ?? "blue";
            // Find crystals for this player
            const playerCrystals = Array.from(match.entities.values()).filter((e) => e.type === "crystal" && e.ownerId === playerId);
            // Validate placement
            const placement = validatePlacement(targetX, targetY, def, match.entities, match.resourceNodes, playerColor, playerCrystals, playerId, config.mapWidth, config.mapHeight);
            if (!placement.valid) {
                return { success: false, message: placement.reason };
            }
            // Deduct resources
            economy.resources -= def.cost;
            // Create building entity
            const buildingRadius = Math.max(def.width, def.height) / 2;
            const building = {
                id: match.idGen.next(),
                type: "building",
                ownerId: playerId,
                x: targetX,
                y: targetY,
                health: 0,
                maxHealth: def.health,
                radius: buildingRadius,
                color: def.color,
                buildingType,
                constructionProgress: 0,
                buildWorkerIds: new Set(workerIds),
                productionQueue: [],
                repairTargetId: undefined,
                repairProgress: 0,
                gatheringNodeId: undefined,
                moveTarget: undefined,
                attackTargetId: undefined,
                attackCooldown: 0,
                healTargetId: undefined,
                autoAttackEnabled: buildingType === "turret",
            };
            match.entities.set(building.id, building);
            // Assign workers to building
            for (const wid of workerIds) {
                const worker = match.entities.get(wid);
                if (worker) {
                    worker.buildTargetId = building.id;
                    worker.moveTarget = { x: targetX, y: targetY };
                    // Clear gathering if active
                    if (worker.gatheringNodeId) {
                        const prevNode = match.resourceNodes.find((n) => n.id === worker.gatheringNodeId);
                        if (prevNode) {
                            prevNode.gathererSlots.delete(worker.id);
                        }
                        worker.gatheringNodeId = undefined;
                    }
                }
            }
            return ok();
        }
        if (command.type === "assign_build") {
            const workerId = command.entityId;
            const buildingId = command.targetEntityId;
            if (!workerId || !buildingId) {
                return { success: false, message: "Missing worker or building ID" };
            }
            const worker = match.entities.get(workerId);
            if (!worker || worker.type !== "worker" || worker.ownerId !== playerId) {
                return { success: false, message: "Worker not found" };
            }
            const building = match.entities.get(buildingId);
            if (!building || building.type !== "building" || building.ownerId !== playerId) {
                return { success: false, message: "Building not found" };
            }
            // Building must be under construction
            if (building.constructionProgress >= 100) {
                return { success: false, message: "Building is already constructed" };
            }
            // Remove worker from previous build target if assigned
            if (worker.buildTargetId && worker.buildTargetId !== buildingId) {
                const prevBuilding = match.entities.get(worker.buildTargetId);
                if (prevBuilding && prevBuilding.buildWorkerIds) {
                    prevBuilding.buildWorkerIds.delete(worker.id);
                }
            }
            // Remove worker from gathering if active
            if (worker.gatheringNodeId) {
                const prevNode = match.resourceNodes.find((n) => n.id === worker.gatheringNodeId);
                if (prevNode) {
                    prevNode.gathererSlots.delete(worker.id);
                }
                worker.gatheringNodeId = undefined;
            }
            // Assign worker to building
            if (!building.buildWorkerIds) {
                building.buildWorkerIds = new Set();
            }
            building.buildWorkerIds.add(worker.id);
            worker.buildTargetId = building.id;
            worker.moveTarget = { x: building.x, y: building.y };
            return ok();
        }
        if (command.type === "repair") {
            const workerId = command.entityId;
            const buildingId = command.targetEntityId;
            if (!workerId || !buildingId) {
                return { success: false, message: "Missing worker or building ID" };
            }
            const worker = match.entities.get(workerId);
            if (!worker || worker.type !== "worker" || worker.ownerId !== playerId) {
                return { success: false, message: "Worker not found" };
            }
            // Clean up gathering assignment when repairing
            if (worker.gatheringNodeId) {
                const prevNode = match.resourceNodes.find((n) => n.id === worker.gatheringNodeId);
                if (prevNode) {
                    prevNode.gathererSlots.delete(worker.id);
                }
                worker.gatheringNodeId = undefined;
            }
            const building = match.entities.get(buildingId);
            if (!building || building.type !== "building" || building.ownerId !== playerId) {
                return { success: false, message: "Building not found" };
            }
            // Building must be damaged
            if (building.health >= building.maxHealth) {
                return { success: false, message: "Building is at full health" };
            }
            const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
            if (playerIdx < 0)
                return { success: false, message: "Player not found" };
            const economy = match.economy[playerIdx];
            if (!economy)
                return { success: false, message: "No economy" };
            // Set repair target on building
            building.repairTargetId = workerId;
            return ok();
        }
        if (command.type === "attack") {
            const entityId = command.entityId;
            const targetId = command.targetEntityId;
            if (!entityId || !targetId) {
                return { success: false, message: "Missing entity or target ID" };
            }
            const entity = match.entities.get(entityId);
            if (!entity || entity.ownerId !== playerId)
                return { success: false, message: "Entity not found" };
            const target = match.entities.get(targetId);
            if (!target)
                return { success: false, message: "Target not found" };
            if (target.ownerId === playerId) {
                return { success: false, message: "Cannot attack friendly units" };
            }
            entity.attackTargetId = targetId;
            entity.moveTarget = undefined;
            entity.healTargetId = undefined;
            // Cancel gathering if worker
            if (entity.type === "worker" && entity.gatheringNodeId) {
                const prevNode = match.resourceNodes.find((n) => n.id === entity.gatheringNodeId);
                if (prevNode) {
                    prevNode.gathererSlots.delete(entity.id);
                }
                entity.gatheringNodeId = undefined;
            }
            // Cancel building if worker
            if (entity.buildTargetId) {
                const building = match.entities.get(entity.buildTargetId);
                if (building && building.buildWorkerIds) {
                    building.buildWorkerIds.delete(entity.id);
                }
                entity.buildTargetId = undefined;
            }
            return ok();
        }
        if (command.type === "heal") {
            const medicId = command.entityId;
            const targetId = command.targetEntityId;
            if (!medicId || !targetId) {
                return { success: false, message: "Missing Medic or target ID" };
            }
            const medic = match.entities.get(medicId);
            if (!medic || medic.type !== "medic" || medic.ownerId !== playerId) {
                return { success: false, message: "Medic not found" };
            }
            const target = match.entities.get(targetId);
            if (!target || target.ownerId !== playerId) {
                return { success: false, message: "Target not found or not friendly" };
            }
            if (target.type === "crystal" || target.type === "building") {
                return { success: false, message: "Cannot heal buildings" };
            }
            medic.healTargetId = targetId;
            medic.attackTargetId = undefined;
            return ok();
        }
        if (command.type === "set_rally") {
            const entityId = command.entityId;
            if (!entityId) {
                return { success: false, message: "Missing entity ID" };
            }
            const entity = match.entities.get(entityId);
            if (!entity || entity.ownerId !== playerId) {
                return { success: false, message: "Entity not found" };
            }
            // Only buildings and crystals can have rally points
            if (entity.type !== "building" && entity.type !== "crystal") {
                return { success: false, message: "Only buildings and crystals can have rally points" };
            }
            if (command.targetX !== undefined && command.targetY !== undefined) {
                entity.rallyPoint = { x: command.targetX, y: command.targetY };
            }
            else {
                entity.rallyPoint = undefined;
            }
            return ok();
        }
        // --- toggle_auto_attack: toggle auto-attack mode on selected unit(s) ---
        if (command.type === "toggle_auto_attack") {
            const entityIds = command.entityIds || [];
            if (entityIds.length === 0) {
                return { success: false, message: "No entities specified" };
            }
            for (const eid of entityIds) {
                const entity = match.entities.get(eid);
                if (!entity || entity.ownerId !== playerId)
                    continue;
                if (entity.type === "building")
                    continue;
                entity.autoAttackEnabled = !entity.autoAttackEnabled;
            }
            return ok();
        }
        // --- retreat: path unit(s) toward own crystal ---
        if (command.type === "retreat") {
            const entityIds = command.entityIds || [];
            if (entityIds.length === 0) {
                return { success: false, message: "No entities specified" };
            }
            // Find this player's crystal
            const crystal = Array.from(match.entities.values()).find((e) => e.type === "crystal" && e.ownerId === playerId);
            if (!crystal) {
                return { success: false, message: "Player crystal not found" };
            }
            for (const eid of entityIds) {
                const entity = match.entities.get(eid);
                if (!entity || entity.ownerId !== playerId)
                    continue;
                if (entity.type === "building")
                    continue;
                // Path toward own crystal. Keep autoAttackEnabled so units fire while retreating.
                entity.moveTarget = { x: crystal.x, y: crystal.y };
                entity.attackTargetId = undefined;
                entity.healTargetId = undefined;
                // Cancel gathering
                if (entity.gatheringNodeId) {
                    const prevNode = match.resourceNodes.find((n) => n.id === entity.gatheringNodeId);
                    if (prevNode)
                        prevNode.gathererSlots.delete(entity.id);
                    entity.gatheringNodeId = undefined;
                }
                // Cancel building
                if (entity.buildTargetId) {
                    const building = match.entities.get(entity.buildTargetId);
                    if (building && building.buildWorkerIds) {
                        building.buildWorkerIds.delete(entity.id);
                    }
                    entity.buildTargetId = undefined;
                }
            }
            return ok();
        }
        // --- stop: halt all movement and clear targets ---
        if (command.type === "stop") {
            const entityIds = command.entityIds || [];
            if (entityIds.length === 0) {
                return { success: false, message: "No entities specified" };
            }
            for (const eid of entityIds) {
                const entity = match.entities.get(eid);
                if (!entity || entity.ownerId !== playerId)
                    continue;
                if (entity.type === "building")
                    continue;
                entity.moveTarget = undefined;
                entity.attackTargetId = undefined;
                entity.autoAttackEnabled = false;
                entity.healTargetId = undefined;
            }
            return ok();
        }
        if (command.type === "debug_move_node") {
            const nodeId = command.targetEntityId;
            if (!nodeId) {
                return { success: false, message: "Missing node ID" };
            }
            const node = match.resourceNodes.find((n) => n.id === nodeId);
            if (!node) {
                return { success: false, message: "Resource node not found" };
            }
            if (command.targetX !== undefined && command.targetY !== undefined) {
                node.x = command.targetX;
                node.y = command.targetY;
            }
            return { success: true };
        }
        // --- debug_save_layout: save current resource node positions to file ---
        if (command.type === "debug_save_layout") {
            const layoutDir = pathLib.join(process.env.HOME || "/root", ".hermes");
            const layoutFile = pathLib.join(layoutDir, "crystalfront_map_layout.json");
            const layoutData = match.resourceNodes.map((n) => ({
                x: Math.round(n.x),
                y: Math.round(n.y),
                radius: n.radius,
                capacity: n.capacity,
                ownerId: n.ownerId || "",
            }));
            const midX = match.config.mapWidth / 2;
            const p1Id = match.players[0]?.playerId;
            const p2Id = match.players[1]?.playerId;
            const blueSafe = layoutData
                .filter((n) => n.ownerId === p1Id && n.x < midX)
                .sort((a, b) => a.y - b.y);
            const contested = layoutData
                .filter((n) => !n.ownerId)
                .sort((a, b) => a.x - b.x);
            const redSafe = layoutData
                .filter((n) => n.ownerId === p2Id && n.x > midX)
                .sort((a, b) => a.y - b.y);
            const output = {
                mapWidth: match.config.mapWidth,
                mapHeight: match.config.mapHeight,
                blueSafeNodes: blueSafe,
                contestedNodes: contested,
                redSafeNodes: redSafe,
            };
            fs.mkdirSync(layoutDir, { recursive: true });
            fs.writeFileSync(layoutFile, JSON.stringify(output, null, 2) + "\n");
            return { success: true };
        }
        // --- debug_mirror_nodes: mirror blue safe nodes onto red side ---
        if (command.type === "debug_mirror_nodes") {
            const midX = match.config.mapWidth / 2;
            const p1Id = match.players[0]?.playerId;
            const p2Id = match.players[1]?.playerId;
            const blueNodes = match.resourceNodes.filter((n) => n.ownerId === p1Id && n.x < midX);
            const redNodes = match.resourceNodes.filter((n) => n.ownerId === p2Id && n.x > midX);
            const sortedBlue = [...blueNodes].sort((a, b) => a.y - b.y);
            const sortedRed = [...redNodes].sort((a, b) => a.y - b.y);
            for (let i = 0; i < sortedBlue.length; i++) {
                const blue = sortedBlue[i];
                const mirroredX = match.config.mapWidth - blue.x;
                if (i < sortedRed.length) {
                    sortedRed[i].x = mirroredX;
                    sortedRed[i].y = blue.y;
                }
            }
            return { success: true };
        }
        return { success: false };
    }
    tick(matchId) {
        const match = this.matches.get(matchId);
        if (!match || match.phase !== "playing")
            return null;
        match.tick++;
        const currentTick = match.tick;
        match.attackLog = match.attackLog.filter(evt => currentTick - evt.tick < SIMULATION.attackLogRetention);
        // Phase 1: Movement
        processMovement(match, 100);
        // Phase 2: Combat
        const damageLog = processCombat(match);
        // Phase 2.5: Post-combat movement (chase/follow initiated this tick)
        processMovement(match, 100);
        // Phase 3: Gathering
        processGathering(match);
        // Phase 3.5: Passive win — first player to hold enough resources at once wins
        for (let i = 0; i < 2; i++) {
            const eco = match.economy[i];
            const passiveThreshold = match.config.passiveWinThreshold ?? ECONOMY.passiveWinThreshold;
            if (eco && eco.resources >= passiveThreshold) {
                const winner = match.players[i]?.playerId;
                if (winner) {
                    match.phase = "ended";
                    match.result = { winner, winType: "resource" };
                    match.endedAt = Date.now();
                    if (this.matchEndCallback)
                        this.matchEndCallback(match.id, winner);
                    return match;
                }
            }
        }
        // Phase 4: Construction & production
        this.processConstruction(match);
        // Phase 5: Death removal (before healing so dead targets are detected)
        this.processDeaths(match, damageLog);
        // Phase 6: Repair & Medic healing
        processRepairAndHealing(match);
        // Phase 7: Fog of war — compute visibility per player
        computeVisibility(match);
        match.stateTimestamp = Date.now();
        return match;
    }
    subStepMovement(matchId) {
        const match = this.matches.get(matchId);
        if (!match || match.phase !== "playing")
            return;
        processMovement(match, 20);
    }
    processConstruction(match) {
        for (const entity of match.entities.values()) {
            if (entity.type !== "building")
                continue;
            if (entity.constructionProgress < 100) {
                const def = entity.buildingType ? BUILDING_DEFS[entity.buildingType] : null;
                if (def && entity.buildWorkerIds && entity.buildWorkerIds.size > 0) {
                    let workersInRange = 0;
                    for (const wid of entity.buildWorkerIds) {
                        const worker = match.entities.get(wid);
                        if (!worker)
                            continue;
                        const d = dist(worker.x, worker.y, entity.x, entity.y);
                        if (d <= GATHER_RANGE) {
                            workersInRange++;
                            if (worker.moveTarget) {
                                const dx = worker.moveTarget.x - entity.x;
                                const dy = worker.moveTarget.y - entity.y;
                                if (Math.sqrt(dx * dx + dy * dy) < 5)
                                    worker.moveTarget = undefined;
                            }
                        }
                        else {
                            worker.moveTarget = { x: entity.x, y: entity.y };
                        }
                    }
                    if (workersInRange > 0) {
                        const progressPerTick = (workersInRange / def.buildTime) * 100;
                        entity.constructionProgress = Math.min(100, entity.constructionProgress + progressPerTick);
                        if (entity.constructionProgress >= 100) {
                            entity.health = def.health;
                            entity.maxHealth = def.health;
                            for (const wid of entity.buildWorkerIds) {
                                const worker = match.entities.get(wid);
                                if (worker) {
                                    worker.buildTargetId = undefined;
                                    worker.moveTarget = undefined;
                                }
                            }
                            entity.buildWorkerIds.clear();
                            if (entity.buildingType === "supply_depot") {
                                const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
                                if (playerIdx >= 0 && match.economy[playerIdx]) {
                                    match.economy[playerIdx].maxSupply += BUILDING_DEFS.supply_depot.supplyProvided;
                                }
                            }
                        }
                    }
                }
            }
            if (entity.constructionProgress >= 100 && entity.productionQueue.length > 0) {
                const item = entity.productionQueue[0];
                if (item) {
                    item.remainingTicks -= 1;
                    if (item.remainingTicks <= 0) {
                        const unitDef = UNIT_DEFS[item.unitType];
                        if (unitDef) {
                            const spawn = this.spawnOutside(match.rng, entity, unitDef.radius);
                            const unit = this.createEntity(match.idGen, item.unitType, entity.ownerId, spawn.x, spawn.y, unitDef.health, unitDef.radius, unitDef.color);
                            if (entity.rallyPoint)
                                unit.moveTarget = { ...entity.rallyPoint };
                            match.entities.set(unit.id, unit);
                            const spawnPIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
                            if (spawnPIdx >= 0 && match.economy[spawnPIdx]) {
                                match.economy[spawnPIdx].supply += item.supplyCost;
                            }
                            entity.productionQueue.shift();
                        }
                    }
                }
            }
        }
    }
    processDeaths(match, damageLog) {
        const toRemove = new Set();
        // Apply damage
        for (const [entityId, damage] of damageLog) {
            const entity = match.entities.get(entityId);
            if (!entity)
                continue;
            entity.health -= damage;
            if (entity.health <= 0) {
                toRemove.add(entityId);
            }
        }
        // Remove dead entities
        for (const entityId of toRemove) {
            const entity = match.entities.get(entityId);
            if (!entity)
                continue;
            // Handle supply
            if (entity.type !== "crystal" && entity.type !== "building") {
                const unitDef = UNIT_DEFS[entity.type];
                const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
                if (playerIdx >= 0 && match.economy[playerIdx]) {
                    match.economy[playerIdx].supply = Math.max(0, match.economy[playerIdx].supply - (unitDef?.supplyCost ?? 1));
                }
            }
            // Free workers assigned to this building
            if (entity.type === "building" && entity.buildWorkerIds) {
                for (const wid of entity.buildWorkerIds) {
                    const worker = match.entities.get(wid);
                    if (worker) {
                        worker.buildTargetId = undefined;
                        worker.moveTarget = undefined;
                    }
                }
            }
            // Handle supply depot death
            if (entity.type === "building" && entity.buildingType === "supply_depot") {
                const def = BUILDING_DEFS.supply_depot;
                const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
                if (playerIdx >= 0 && match.economy[playerIdx]) {
                    match.economy[playerIdx].maxSupply = Math.max(0, match.economy[playerIdx].maxSupply - (def.supplyProvided ?? 0));
                    match.economy[playerIdx].supply = Math.min(match.economy[playerIdx].supply, match.economy[playerIdx].maxSupply);
                }
            }
            match.entities.delete(entityId);
            // Crystal destruction = match end
            if (entity.type === "crystal") {
                const winner = match.players.find((p) => p?.playerId !== entity.ownerId);
                if (winner) {
                    this.endMatch(match.id, winner.playerId);
                }
            }
        }
    }
    resetMatch(matchId, players, config = DEFAULT_CONFIG) {
        const match = this.matches.get(matchId);
        if (!match)
            return null;
        const newSeed = (Date.now() & 0xffffffff);
        match.seed = newSeed;
        match.rng = new Rng(newSeed);
        match.idGen = new IdGen();
        match.commandLog = [];
        match.phase = "spawn";
        match.tick = 0;
        match.players = players;
        match.result = null;
        match.startedAt = Date.now();
        match.endedAt = null;
        match.entities.clear();
        // Respawn entities
        const map = createMap(config);
        const blueCrystal = this.createEntity(match.idGen, "crystal", players[0]?.playerId ?? "", map.blueCrystal.x, map.blueCrystal.y, config.crystalHealth, config.crystalRadius, players[0]?.color === "blue" ? "#4488ff" : "#888888");
        const redCrystal = this.createEntity(match.idGen, "crystal", players[1]?.playerId ?? "", map.redCrystal.x, map.redCrystal.y, config.crystalHealth, config.crystalRadius, players[1]?.color === "red" ? "#ff4444" : "#888888");
        match.entities.set(blueCrystal.id, blueCrystal);
        match.entities.set(redCrystal.id, redCrystal);
        const blueWorkers = [
            this.createEntity(match.idGen, "worker", players[0]?.playerId ?? "", map.blueWorkers[0].x, map.blueWorkers[0].y, config.workerHealth, config.workerRadius, players[0]?.color === "blue" ? "#6699ff" : "#888888"),
            this.createEntity(match.idGen, "worker", players[0]?.playerId ?? "", map.blueWorkers[1].x, map.blueWorkers[1].y, config.workerHealth, config.workerRadius, players[0]?.color === "blue" ? "#6699ff" : "#888888"),
            this.createEntity(match.idGen, "worker", players[0]?.playerId ?? "", map.blueWorkers[2].x, map.blueWorkers[2].y, config.workerHealth, config.workerRadius, players[0]?.color === "blue" ? "#6699ff" : "#888888"),
        ];
        const redWorkers = [
            this.createEntity(match.idGen, "worker", players[1]?.playerId ?? "", map.redWorkers[0].x, map.redWorkers[0].y, config.workerHealth, config.workerRadius, players[1]?.color === "red" ? "#ff6666" : "#888888"),
            this.createEntity(match.idGen, "worker", players[1]?.playerId ?? "", map.redWorkers[1].x, map.redWorkers[1].y, config.workerHealth, config.workerRadius, players[1]?.color === "red" ? "#ff6666" : "#888888"),
            this.createEntity(match.idGen, "worker", players[1]?.playerId ?? "", map.redWorkers[2].x, map.redWorkers[2].y, config.workerHealth, config.workerRadius, players[1]?.color === "red" ? "#ff6666" : "#888888"),
        ];
        for (const w of blueWorkers)
            match.entities.set(w.id, w);
        for (const w of redWorkers)
            match.entities.set(w.id, w);
        // Reset resource nodes
        match.resourceNodes = [];
        const allNodeLayouts = [
            ...map.blueSafeNodes.map((n) => ({ ...n, ownerId: players[0]?.playerId ?? "" })),
            ...map.redSafeNodes.map((n) => ({ ...n, ownerId: players[1]?.playerId ?? "" })),
            ...map.contestedNodes.map((n) => ({ ...n, ownerId: "" })),
        ];
        for (const layout of allNodeLayouts) {
            const node = {
                id: match.idGen.next(),
                x: layout.x,
                y: layout.y,
                radius: layout.radius,
                color: "#ccaa44",
                capacity: layout.capacity,
                remaining: layout.capacity,
                maxGathererSlots: 3,
                gathererSlots: new Set(),
                accumulatedGather: 0,
            };
            match.resourceNodes.push(node);
        }
        // Reset economy (keep scores)
        match.economy = [
            players[0]
                ? {
                    resources: config.startingResources,
                    supply: 3 * config.workerSupplyCost, // 3 starting workers
                    maxSupply: config.startingMaxSupply,
                    lifetimeResources: 0,
                }
                : null,
            players[1]
                ? {
                    resources: config.startingResources,
                    supply: 3 * config.workerSupplyCost, // 3 starting workers
                    maxSupply: config.startingMaxSupply,
                    lifetimeResources: 0,
                }
                : null,
        ];
        return match;
    }
    destroyMatch(matchId) {
        this.matches.delete(matchId);
    }
    hasActiveMatch(lobbyCode) {
        for (const m of this.matches.values()) {
            if (m.lobbyCode === lobbyCode && m.phase !== "ended") {
                return true;
            }
        }
        return false;
    }
    createEntity(idGen, type, ownerId, x, y, health, radius, color, buildingType) {
        const autoAttackEnabled = ["skirmisher", "gunner", "bruiser", "medic"].includes(type);
        if (type === "building" && buildingType) {
            const def = BUILDING_DEFS[buildingType];
            return {
                id: idGen.next(),
                type,
                ownerId,
                x,
                y,
                health: 0,
                maxHealth: def.health,
                radius: Math.max(def.width, def.height) / 2,
                color: def.color,
                buildingType,
                constructionProgress: 0,
                buildWorkerIds: undefined,
                productionQueue: [],
                rallyPoint: undefined,
                repairTargetId: undefined,
                repairProgress: 0,
                gatheringNodeId: undefined,
                buildTargetId: undefined,
                moveTarget: undefined,
                attackTargetId: undefined,
                attackCooldown: 0,
                healTargetId: undefined,
                autoAttackEnabled: buildingType === "turret",
            };
        }
        return {
            id: idGen.next(),
            type,
            ownerId,
            x,
            y,
            health,
            maxHealth: health,
            radius,
            color,
            buildingType: undefined,
            constructionProgress: 100,
            buildWorkerIds: undefined,
            buildTargetId: undefined,
            productionQueue: [],
            rallyPoint: undefined,
            repairTargetId: undefined,
            repairProgress: 0,
            gatheringNodeId: undefined,
            moveTarget: undefined,
            attackTargetId: undefined,
            attackCooldown: 0,
            healTargetId: undefined,
            autoAttackEnabled,
        };
    }
    /**
     * Compute a spawn position just outside the parent entity so the new unit
     * doesn't overlap the building/crystal and can be selected immediately.
     */
    spawnOutside(rng, parent, childRadius) {
        const gap = SIMULATION.spawnGap;
        const spawnDist = parent.radius + childRadius + gap;
        const angle = rng.random() * Math.PI * 2;
        return {
            x: parent.x + Math.cos(angle) * spawnDist,
            y: parent.y + Math.sin(angle) * spawnDist,
        };
    }
}
