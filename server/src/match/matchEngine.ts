import { randomUUID } from "node:crypto";
import fs from "node:fs";
import pathLib from "node:path";
import type { PlayerId, PlayerColor, EntityId } from "@crystalfront/shared";
import type {
  MatchState,
  MatchEntity,
  CommandEntry,
  MatchConfig,
  PlayerSlot,
  PlayerEconomy,
  ResourceNode,
  ProductionQueueItem,
  BuildingType,
  UnitType,
} from "./types.js";
import { createMap } from "./map.js";
import { DEFAULT_CONFIG } from "./types.js";
import {
  BUILDING_DEFS,
  UNIT_DEFS,
  COUNTER_MULTIPLIERS,
  HEAL_RATE_PER_TICK,
  GATHER_RATE_PER_TICK,
} from "@crystalfront/shared";

const GATHER_RANGE = 60;
const GATHER_RATE_PER_WORKER = GATHER_RATE_PER_TICK / 3;
import {
  validatePlacement,
  findCrystalByColor,
  type PlacementResult,
} from "./buildingValidation.js";

export class MatchEngine {
  private matches = new Map<string, MatchState>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private broadcastCallback: ((matchId: string) => void) | null = null;
  private matchEndCallback: ((matchId: string, winner: PlayerId) => void) | null = null;

  setBroadcastCallback(cb: (matchId: string) => void): void {
    this.broadcastCallback = cb;
  }

  setMatchEndCallback(cb: (matchId: string, winner: PlayerId) => void): void {
    this.matchEndCallback = cb;
  }

  createMatch(
    lobbyCode: string,
    players: [PlayerSlot | null, PlayerSlot | null],
    config: MatchConfig = DEFAULT_CONFIG
  ): MatchState {
    const id = randomUUID();
    const map = createMap(config);
    const entities = new Map<EntityId, MatchEntity>();

    // Create crystals
    const blueCrystal = this.createEntity(
      "crystal",
      players[0]?.playerId ?? "",
      map.blueCrystal.x,
      map.blueCrystal.y,
      config.crystalHealth,
      config.crystalRadius,
      players[0]?.color === "blue" ? "#4488ff" : "#888888"
    );
    const redCrystal = this.createEntity(
      "crystal",
      players[1]?.playerId ?? "",
      map.redCrystal.x,
      map.redCrystal.y,
      config.crystalHealth,
      config.crystalRadius,
      players[1]?.color === "red" ? "#ff4444" : "#888888"
    );

    entities.set(blueCrystal.id, blueCrystal);
    entities.set(redCrystal.id, redCrystal);

    // Create workers
    const blueWorkers = [
      this.createEntity(
        "worker",
        players[0]?.playerId ?? "",
        map.blueWorkers[0].x,
        map.blueWorkers[0].y,
        config.workerHealth,
        config.workerRadius,
        players[0]?.color === "blue" ? "#6699ff" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[0]?.playerId ?? "",
        map.blueWorkers[1].x,
        map.blueWorkers[1].y,
        config.workerHealth,
        config.workerRadius,
        players[0]?.color === "blue" ? "#6699ff" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[0]?.playerId ?? "",
        map.blueWorkers[2].x,
        map.blueWorkers[2].y,
        config.workerHealth,
        config.workerRadius,
        players[0]?.color === "blue" ? "#6699ff" : "#888888"
      ),
    ];

    const redWorkers = [
      this.createEntity(
        "worker",
        players[1]?.playerId ?? "",
        map.redWorkers[0].x,
        map.redWorkers[0].y,
        config.workerHealth,
        config.workerRadius,
        players[1]?.color === "red" ? "#ff6666" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[1]?.playerId ?? "",
        map.redWorkers[1].x,
        map.redWorkers[1].y,
        config.workerHealth,
        config.workerRadius,
        players[1]?.color === "red" ? "#ff6666" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[1]?.playerId ?? "",
        map.redWorkers[2].x,
        map.redWorkers[2].y,
        config.workerHealth,
        config.workerRadius,
        players[1]?.color === "red" ? "#ff6666" : "#888888"
      ),
    ];

    for (const w of blueWorkers) entities.set(w.id, w);
    for (const w of redWorkers) entities.set(w.id, w);

    // Create resource nodes
    const resourceNodes: ResourceNode[] = [];

    const allNodeLayouts = [
      ...map.blueSafeNodes.map((n) => ({ ...n, ownerId: players[0]?.playerId ?? "" })),
      ...map.redSafeNodes.map((n) => ({ ...n, ownerId: players[1]?.playerId ?? "" })),
      ...map.contestedNodes.map((n) => ({ ...n, ownerId: "" })),
    ];

    for (const layout of allNodeLayouts) {
      const node: ResourceNode = {
         id: randomUUID(),
         x: layout.x,
         y: layout.y,
         radius: layout.radius,
         color: "#ccaa44",
         capacity: layout.capacity,
         remaining: layout.capacity,
         maxGathererSlots: 3,
         gathererSlots: new Set<EntityId>(),
         accumulatedGather: 0,
       };
       resourceNodes.push(node);
    }

    // Create economy for each player
    const economy: [PlayerEconomy | null, PlayerEconomy | null] = [
      players[0]
        ? {
            resources: config.startingResources,
            supply: 3 * config.workerSupplyCost, // 3 starting workers
            maxSupply: config.startingMaxSupply,
          }
        : null,
      players[1]
        ? {
            resources: config.startingResources,
            supply: 3 * config.workerSupplyCost, // 3 starting workers
            maxSupply: config.startingMaxSupply,
          }
        : null,
    ];

  const match: MatchState = {
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
    };

    this.matches.set(id, match);
    return match;
  }

  startMatch(matchId: string): MatchState | null {
    const match = this.matches.get(matchId);
    if (!match) return null;
    if (match.phase !== "spawn") return null;

    match.phase = "playing";
    this.startTickLoop(matchId);
    return match;
  }

  stopMatch(matchId: string): void {
    const interval = this.intervals.get(matchId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(matchId);
    }
  }

  endMatch(matchId: string, winner: PlayerId): MatchState | null {
    const match = this.matches.get(matchId);
    if (!match) return null;

    this.stopTickLoop(matchId);
    match.phase = "ended";
    match.result = { winner };
    match.endedAt = Date.now();

    // Notify server to broadcast MATCH_END event
    if (this.matchEndCallback) {
      this.matchEndCallback(matchId, winner);
    }

    return match;
  }

  getMatch(matchId: string): MatchState | undefined {
    return this.matches.get(matchId);
  }

  getAllMatches(): MatchState[] {
    return Array.from(this.matches.values());
  }

  debugSpawn(
    matchId: string,
    playerId: PlayerId,
    entityType: "worker" | "skirmisher" | "gunner" | "bruiser" | "medic" | "building",
    x: number,
    y: number,
    buildingType?: BuildingType
  ): { success: boolean; message?: string } {
    const match = this.matches.get(matchId);
    if (!match) return { success: false, message: "Match not found" };

    const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
    if (playerIdx < 0) return { success: false, message: "Player not found" };

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
      const building = this.createEntity(
        "building",
        playerId,
        x,
        y,
        def.health,
        Math.max(def.width, def.height) / 2,
        def.color,
        buildingType
      );
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
    const unit = this.createEntity(
      entityType,
      playerId,
      x,
      y,
      unitDef.health,
      unitDef.radius,
      unitDef.color
    );
    match.entities.set(unit.id, unit);
    return { success: true };
  }

  processCommand(
    matchId: string,
    playerId: PlayerId,
    command: {
      type:
        | "move"
        | "deselect"
        | "gather"
        | "train_worker"
        | "train_unit"
        | "cancel_queue"
        | "build"
        | "assign_build"
        | "repair"
        | "attack"
        | "heal"
        | "set_rally"
        | "toggle_auto_attack"
        | "retreat"
        | "stop"
        | "debug_move_node"
        | "debug_save_layout"
        | "debug_mirror_nodes";
      entityId?: string;
      entityIds?: string[];
      targetX?: number;
      targetY?: number;
      targetEntityId?: string;
      buildingType?: BuildingType;
      workerIds?: string[];
      buildingId?: string;
      unitType?: string;
    }
  ): { success: boolean; message?: string } {
    const match = this.matches.get(matchId);
    if (!match) return { success: false };
    if (match.phase !== "playing") return { success: false };

    const config = match.config;

    if (command.type === "deselect") {
      return { success: true };
    }

if (command.type === "move") {
       const entity = Array.from(match.entities.values()).find(
         (e) => e.id === command.entityId && e.ownerId === playerId
       );
       if (!entity) return { success: false, message: "Entity not found" };

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
         entity.commandedTicks = 5;
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

       return { success: true };
     }

if (command.type === "gather") {
       const worker = Array.from(match.entities.values()).find(
         (e) => e.id === command.entityId && e.type === "worker" && e.ownerId === playerId
       );
       if (!worker) return { success: false, message: "Worker not found" };

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

       const targetNode = match.resourceNodes.find(
         (n) => n.id === command.targetEntityId
       );
       if (!targetNode) return { success: false, message: "Resource node not found" };
       if (targetNode.remaining <= 0) return { success: false, message: "Node is depleted" };
       if (targetNode.gathererSlots.size >= targetNode.maxGathererSlots)
         return { success: false, message: "Node is full" };

       worker.gatheringNodeId = targetNode.id;
       targetNode.gathererSlots.add(worker.id);
       return { success: true };
     }

    if (command.type === "train_worker") {
      const crystal = Array.from(match.entities.values()).find(
        (e) => e.id === command.entityId && e.type === "crystal" && e.ownerId === playerId
      );
      if (!crystal) return { success: false, message: "Crystal not found" };

      const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
      if (playerIdx < 0) return { success: false, message: "Player not found" };

      const economy = match.economy[playerIdx];
      if (!economy) return { success: false, message: "No economy" };

      if (economy.resources < config.workerTrainCost) {
        return { success: false, message: "Not enough resources" };
      }
      if (economy.supply + config.workerSupplyCost > economy.maxSupply) {
        return { success: false, message: "Not enough supply" };
      }

      const spawn = this.spawnOutside(crystal, config.workerRadius);
      const newWorker = this.createEntity(
        "worker",
        playerId,
        spawn.x,
        spawn.y,
        config.workerHealth,
        config.workerRadius,
        match.players[playerIdx]?.color === "blue" ? "#6699ff" : "#ff6666"
      );
      match.entities.set(newWorker.id, newWorker);

      economy.resources -= config.workerTrainCost;
      economy.supply += config.workerSupplyCost;

      return { success: true };
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

      const unitType = (command.unitType ?? command.targetEntityId) as UnitType | undefined;
      if (!unitType || !(unitType in UNIT_DEFS)) {
        return { success: false, message: "Invalid unit type" };
      }

      const unitDef = UNIT_DEFS[unitType];
      const buildingDef = building.buildingType ? BUILDING_DEFS[building.buildingType] : null;
      if (!buildingDef?.produces?.includes(unitType)) {
        return { success: false, message: "Building cannot produce this unit" };
      }

      const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
      if (playerIdx < 0) return { success: false, message: "Player not found" };

      const economy = match.economy[playerIdx];
      if (!economy) return { success: false, message: "No economy" };

      // Check total queue supply demand (existing queue + new unit)
      const queuedSupply = (building.productionQueue ?? []).reduce((sum, item) => sum + item.supplyCost, 0);
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

      return { success: true };
    }

    if (command.type === "cancel_queue") {
      const building = Array.from(match.entities.values()).find(
        (e) => e.id === command.entityId && e.type === "building" && e.ownerId === playerId
      );
      if (!building) return { success: false, message: "Building not found" };

      const queueIndex = command.targetX ?? 0;
      if (!building.productionQueue || building.productionQueue.length === 0) {
        return { success: false, message: "Queue is empty" };
      }

      const item = building.productionQueue[queueIndex];
      if (!item) return { success: false, message: "Queue item not found" };

      // Refund resources
      const playerIdx = match.players.findIndex((p) => p?.playerId === playerId);
      if (playerIdx >= 0 && match.economy[playerIdx]) {
        match.economy[playerIdx]!.resources += item.cost;
      }

      building.productionQueue.splice(queueIndex, 1);
      return { success: true };
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
        if (playerIdx < 0) return { success: false, message: "Player not found in match" };

       const economy = match.economy[playerIdx];
      if (!economy) return { success: false, message: "No economy" };

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
       const playerCrystals = Array.from(match.entities.values()).filter(
         (e) => e.type === "crystal" && e.ownerId === playerId
       );

       // Validate placement
       const placement = validatePlacement(
         targetX,
         targetY,
         def,
         match.entities,
         match.resourceNodes,
         playerColor,
         playerCrystals,
         playerId,
         config.mapWidth,
         config.mapHeight
      );
        if (!placement.valid) {
         return { success: false, message: placement.reason };
       }

       // Deduct resources
        economy.resources -= def.cost;

        // Create building entity
        const buildingRadius = Math.max(def.width, def.height) / 2;
       const building: MatchEntity = {
         id: randomUUID(),
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
         buildWorkerIds: new Set<EntityId>(workerIds),
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

    return { success: true };
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
        building.buildWorkerIds = new Set<EntityId>();
      }
      building.buildWorkerIds.add(worker.id);
      worker.buildTargetId = building.id;
      worker.moveTarget = { x: building.x, y: building.y };

      return { success: true };
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
      if (playerIdx < 0) return { success: false, message: "Player not found" };

      const economy = match.economy[playerIdx];
      if (!economy) return { success: false, message: "No economy" };

      // Set repair target on building
      building.repairTargetId = workerId;

      return { success: true };
    }

    if (command.type === "attack") {
      const entityId = command.entityId;
      const targetId = command.targetEntityId;
      if (!entityId || !targetId) {
        return { success: false, message: "Missing entity or target ID" };
      }

      const entity = Array.from(match.entities.values()).find(
        (e) => e.id === entityId && e.ownerId === playerId
      );
      if (!entity) return { success: false, message: "Entity not found" };

      const target = match.entities.get(targetId);
      if (!target) return { success: false, message: "Target not found" };
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

       return { success: true };
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

      return { success: true };
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
      } else {
        entity.rallyPoint = undefined;
      }

      return { success: true };
    }

    // --- toggle_auto_attack: toggle auto-attack mode on selected unit(s) ---
    if (command.type === "toggle_auto_attack") {
      const entityIds = command.entityIds || [];
      if (entityIds.length === 0) {
        return { success: false, message: "No entities specified" };
      }
      for (const eid of entityIds) {
        const entity = Array.from(match.entities.values()).find(
          (e) => e.id === eid && e.ownerId === playerId
        );
        if (!entity) continue;
        if (entity.type === "building") continue;
        entity.autoAttackEnabled = !entity.autoAttackEnabled;
      }
      return { success: true };
    }

    // --- retreat: path unit(s) toward own crystal ---
    if (command.type === "retreat") {
      const entityIds = command.entityIds || [];
      if (entityIds.length === 0) {
        return { success: false, message: "No entities specified" };
      }
      // Find this player's crystal
      const crystal = Array.from(match.entities.values()).find(
        (e) => e.type === "crystal" && e.ownerId === playerId
      );
      if (!crystal) {
        return { success: false, message: "Player crystal not found" };
      }
      for (const eid of entityIds) {
        const entity = Array.from(match.entities.values()).find(
          (e) => e.id === eid && e.ownerId === playerId
        );
        if (!entity) continue;
        if (entity.type === "building") continue;
        // Cancel all modes
        entity.moveTarget = { x: crystal.x, y: crystal.y };
        entity.attackTargetId = undefined;
        entity.autoAttackEnabled = false;
        entity.healTargetId = undefined;
        // Cancel gathering
        if (entity.gatheringNodeId) {
          const prevNode = match.resourceNodes.find((n) => n.id === entity.gatheringNodeId);
          if (prevNode) prevNode.gathererSlots.delete(entity.id);
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
      return { success: true };
    }

    // --- stop: halt all movement and clear targets ---
    if (command.type === "stop") {
      const entityIds = command.entityIds || [];
      if (entityIds.length === 0) {
        return { success: false, message: "No entities specified" };
      }
      for (const eid of entityIds) {
        const entity = Array.from(match.entities.values()).find(
          (e) => e.id === eid && e.ownerId === playerId
        );
        if (!entity) continue;
        if (entity.type === "building") continue;
        entity.moveTarget = undefined;
        entity.attackTargetId = undefined;
        entity.autoAttackEnabled = false;
        entity.healTargetId = undefined;
      }
      return { success: true };
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
      const layoutData = match.resourceNodes.map((n: any) => ({
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
        .filter((n: any) => n.ownerId === p1Id && n.x < midX)
        .sort((a: any, b: any) => a.y - b.y);
      const contested = layoutData
        .filter((n: any) => !n.ownerId)
        .sort((a: any, b: any) => a.x - b.x);
      const redSafe = layoutData
        .filter((n: any) => n.ownerId === p2Id && n.x > midX)
        .sort((a: any, b: any) => a.y - b.y);
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
      const blueNodes = match.resourceNodes.filter(
        (n: any) => n.ownerId === p1Id && n.x < midX
      );
      const redNodes = match.resourceNodes.filter(
        (n: any) => n.ownerId === p2Id && n.x > midX
      );
      const sortedBlue = [...blueNodes].sort((a: any, b: any) => a.y - b.y);
      const sortedRed = [...redNodes].sort((a: any, b: any) => a.y - b.y);
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

  tick(matchId: string): MatchState | null {
    const match = this.matches.get(matchId);
    if (!match || match.phase !== "playing") return null;

    match.tick++;
    const currentTick = match.tick;
    match.attackLog = match.attackLog.filter(evt => currentTick - evt.tick < 15);

    // Phase 1: Movement
    this.processMovement(match, 100);

    // Phase 2: Combat
    const damageLog = this.processCombat(match);

    // Phase 2.5: Post-combat movement (chase/follow initiated this tick)
    this.processMovement(match, 100);

    // Phase 3: Gathering
    this.processGathering(match);

    // Phase 4: Construction & production
    this.processConstruction(match);

    // Phase 5: Death removal (before healing so dead targets are detected)
    this.processDeaths(match, damageLog);

    // Phase 6: Repair & Medic healing
    this.processRepairAndHealing(match);

    // Phase 7: Fog of war — compute visibility per player
    this.computeVisibility(match);

    match.stateTimestamp = Date.now();
    return match;
  }

  /**
   * Compute fog-of-war visibility for each player.
   * Each entity has a vision range; any entity within that range is "visible".
   * Results stored on match.visibilityData keyed by playerId.
   */
  private computeVisibility(match: MatchState): void {
    const allEntities = Array.from(match.entities.values());
    const visibility = new Map<PlayerId, { entityIds: Set<EntityId>; nodeIds: Set<string> }>();

    for (const p of match.players) {
      if (p) {
        visibility.set(p.playerId, { entityIds: new Set(), nodeIds: new Set() });
      }
    }

    for (const [playerId, vis] of visibility) {
      const myEntities = allEntities.filter(e => e.ownerId === playerId && e.health > 0);
      // Every player always sees their own living entities (safety guarantee)
      for (const mine of myEntities) {
        vis.entityIds.add(mine.id);
      }
      for (const src of myEntities) {
        const vRange = this.getVisionRange(src);
        const vRangeSq = vRange * vRange;
        for (const target of allEntities) {
          if (target.health <= 0) continue;
          const dx = target.x - src.x;
          const dy = target.y - src.y;
          if (dx * dx + dy * dy <= vRangeSq) {
            vis.entityIds.add(target.id);
          }
        }
        for (const node of match.resourceNodes) {
          const dx = node.x - src.x;
          const dy = node.y - src.y;
          if (dx * dx + dy * dy <= vRangeSq) {
            vis.nodeIds.add(node.id);
          }
        }
      }
    }

    match.visibilityData = visibility;
  }

  /** Get the vision range for an entity based on its type. */
  private getVisionRange(entity: MatchEntity): number {
    if (entity.type === "building" && entity.buildingType) {
      const def = BUILDING_DEFS[entity.buildingType];
      return def?.visionRange ?? 100;
    }
    if (entity.type === "crystal") {
      return 225; // Crystal vision
    }
    const def = UNIT_DEFS[entity.type];
    return def?.visionRange ?? 100;
  }

  subStepMovement(matchId: string): void {
    const match = this.matches.get(matchId);
    if (!match || match.phase !== "playing") return;
    this.processMovement(match, 20);
  }

  private dist(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private buildSpatialGrid(entities: MatchEntity[], cellSize: number): Map<string, MatchEntity[]> {
    const grid = new Map<string, MatchEntity[]>();
    for (const entity of entities) {
      const key = `${Math.floor(entity.x / cellSize)},${Math.floor(entity.y / cellSize)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(entity);
    }
    return grid;
  }

  private processMovement(match: MatchState, subStepMs: number = 100): void {
    const entities = Array.from(match.entities.values());
    const arrivalThreshold = 1;
    const stepsPerTick = (100 / subStepMs) || 1;

    for (const entity of entities) {
      if (entity.type === "crystal" || entity.type === "building") continue;
      if (!entity.moveTarget) continue;

      const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
      const speedPerTick = unitDef?.speed ?? 2;
      const moveAmount = Math.min(speedPerTick / stepsPerTick, this.dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y));

      const dx = entity.moveTarget.x - entity.x;
      const dy = entity.moveTarget.y - entity.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance <= arrivalThreshold) {
        entity.moveTarget = undefined;
        continue;
      }

      entity.x += (dx / distance) * moveAmount;
      entity.y += (dy / distance) * moveAmount;

      // Clamp to map bounds (prevent units walking off-map)
      const mapW = match.config.mapWidth;
      const mapH = match.config.mapHeight;
      entity.x = Math.max(entity.radius, Math.min(mapW - entity.radius, entity.x));
      entity.y = Math.max(entity.radius, Math.min(mapH - entity.radius, entity.y));

      const newDistance = this.dist(entity.x, entity.y, entity.moveTarget.x, entity.moveTarget.y);
      if (newDistance <= arrivalThreshold) {
        entity.moveTarget = undefined;
      }
    }

    // Soft collision with spatial grid (run twice for stability)
    const mobile = entities.filter(
      (e) => e.type !== "crystal" && e.type !== "building"
    );
    const cellSize = 50;
    for (let pass = 0; pass < 2; pass++) {
      const grid = this.buildSpatialGrid(mobile, cellSize);
      const checked = new Set<string>();
      for (const entity of mobile) {
        const cx = Math.floor(entity.x / cellSize);
        const cy = Math.floor(entity.y / cellSize);
        for (let ddx = -1; ddx <= 1; ddx++) {
          for (let ddy = -1; ddy <= 1; ddy++) {
            const key = `${cx + ddx},${cy + ddy}`;
            const cell = grid.get(key);
            if (!cell) continue;
            for (const other of cell) {
              if (other.id <= entity.id) continue;
              if (checked.has(`${entity.id}-${other.id}`)) continue;
              checked.add(`${entity.id}-${other.id}`);
              const dx = other.x - entity.x;
              const dy = other.y - entity.y;
              const distance = Math.sqrt(dx * dx + dy * dy);
              const minDist = entity.radius + other.radius;
              if (distance < minDist && distance > 0) {
                const push = (minDist - distance) * 0.5;
                const nx = dx / distance;
                const ny = dy / distance;
                entity.x -= nx * push;
                entity.y -= ny * push;
                other.x += nx * push;
                other.y += ny * push;
              }
            }
          }
        }
      }
    }
  }

  private processCombat(match: MatchState): Map<string, number> {
    const damageLog = new Map<string, number>();
    const entities = Array.from(match.entities.values());

    // Auto-attack acquisition: idle combat units find nearest enemy in range
    for (const entity of entities) {
      if (!entity.autoAttackEnabled) continue;
      // Decrement player command cooldown
      if (entity.commandedTicks !== undefined && entity.commandedTicks > 0) {
        entity.commandedTicks--;
      }
      // Don't auto-acquire while player command is active
      if (entity.commandedTicks !== undefined && entity.commandedTicks > 0) continue;
      if (entity.type === "building") {
        // Turrets: auto-attack if constructed
        if (entity.constructionProgress < 100) continue;
      }
      // Don't auto-acquire if already has a target
      if (entity.attackTargetId) continue;

      // Find nearest enemy in range
      let nearestDist = Infinity;
      let nearestId: string | undefined;
      for (const other of entities) {
        if (other.ownerId === entity.ownerId) continue;
        const range = this.getRange(entity);
        const d = this.dist(entity.x, entity.y, other.x, other.y);
        if (d <= range + other.radius && d < nearestDist) {
          nearestDist = d;
          nearestId = other.id;
        }
      }
      if (nearestId) {
        entity.attackTargetId = nearestId;
      }
    }

    // Attack chase: units with attackTargetId move toward target if out of range
    for (const entity of entities) {
      if (!entity.attackTargetId) continue;
      if (entity.type === "crystal" || entity.type === "building") continue;
      const target = match.entities.get(entity.attackTargetId);
      if (!target) {
        entity.attackTargetId = undefined;
        continue;
      }
      const range = this.getRange(entity);
      const d = this.dist(entity.x, entity.y, target.x, target.y);
      if (d > range + target.radius) {
        entity.moveTarget = { x: target.x, y: target.y };
      }
    }

    // Medic follow behavior: move toward heal target if out of range
    for (const entity of entities) {
      if (entity.type !== "medic" || !entity.healTargetId) continue;
      const target = match.entities.get(entity.healTargetId);
      if (!target) {
        entity.healTargetId = undefined;
        continue;
      }
      const healRange = UNIT_DEFS.medic.range;
      const d = this.dist(entity.x, entity.y, target.x, target.y);
      if (d > healRange + entity.radius + target.radius) {
        entity.moveTarget = { x: target.x, y: target.y };
      } else if (entity.moveTarget) {
        if (!entity.attackTargetId) {
          entity.moveTarget = undefined;
        }
      }
    }

    // Resolve attacks - all entities with attackTargetId, regardless of autoAttackEnabled
    for (const entity of entities) {
      if (!entity.attackTargetId) continue;

      // Check if target still exists
      const target = match.entities.get(entity.attackTargetId!);
      if (!target) {
        entity.attackTargetId = undefined;
        continue;
      }

      // Check range (edge-to-edge: include target radius)
      const range = this.getRange(entity);
      const d = this.dist(entity.x, entity.y, target.x, target.y);
       if (d > range + target.radius) {
        if (entity.type === "building") {
          entity.attackTargetId = undefined;
        }
        continue;
      }

      // In range: clear moveTarget so unit stops and holds position to attack
      if (entity.type !== "building") {
        entity.moveTarget = undefined;
      }

      // Check cooldown
      if (entity.attackCooldown > 0) {
        entity.attackCooldown--;
        continue;
      }

      // Deal damage
      const baseDamage = this.getDamage(entity);
      const multiplier = this.getCounterMultiplier(entity.type, target.type);
     const finalDamage = Math.round(baseDamage * multiplier);

        const currentDamage = damageLog.get(target.id) ?? 0;
      damageLog.set(target.id, currentDamage + finalDamage);
      match.attackLog.push({ attackerId: entity.id, targetId: target.id, damage: finalDamage, tick: match.tick, isHeal: false });

      // Reset cooldown
      const cooldown = this.getAttackCooldown(entity);
      entity.attackCooldown = cooldown;
    }

    return damageLog;
  }

  private getRange(entity: MatchEntity): number {
    if (entity.type === "building" && entity.buildingType === "turret") {
      return BUILDING_DEFS.turret.range ?? 150;
    }
    const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
    // Add own radius so melee range is measured from unit edge, not center
    return (unitDef?.range ?? 20) + entity.radius;
  }

  private getDamage(entity: MatchEntity): number {
    if (entity.type === "building" && entity.buildingType === "turret") {
      return BUILDING_DEFS.turret.damage ?? 18;
    }
    const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
    return unitDef?.damage ?? 5;
  }

  private getAttackCooldown(entity: MatchEntity): number {
    if (entity.type === "building" && entity.buildingType === "turret") {
      return BUILDING_DEFS.turret.attackCooldown ?? 12;
    }
    const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
    return unitDef?.attackCooldown ?? 20;
  }

  private getCounterMultiplier(attackerType: string, defenderType: string): number {
    const attackerCounters = COUNTER_MULTIPLIERS[attackerType];
    if (!attackerCounters) return 1.0;
    // Turret uses gunner counter multipliers
    const effectiveAttacker = attackerType === "building" ? "gunner" : attackerType;
    const effectiveDefender = defenderType === "building" ? "worker" : defenderType;
    return COUNTER_MULTIPLIERS[effectiveAttacker]?.[effectiveDefender] ?? 1.0;
  }

  private processGathering(match: MatchState): void {
    for (const node of match.resourceNodes) {
      if (node.remaining <= 0 || node.gathererSlots.size === 0) continue;

      const inRangeWorkers: EntityId[] = [];
      for (const workerId of node.gathererSlots) {
        const worker = match.entities.get(workerId);
        if (!worker) continue;

        const d = this.dist(worker.x, worker.y, node.x, node.y);
        if (d <= GATHER_RANGE) {
          inRangeWorkers.push(workerId);
          if (worker.moveTarget) {
            const dx = worker.moveTarget.x - node.x;
            const dy = worker.moveTarget.y - node.y;
            if (Math.sqrt(dx * dx + dy * dy) < 5) {
              worker.moveTarget = undefined;
            }
          }
        } else {
          worker.moveTarget = { x: node.x, y: node.y };
        }
      }

      const gatherCount = inRangeWorkers.length;
      if (gatherCount === 0) continue;

      const totalGather = gatherCount * GATHER_RATE_PER_WORKER;
      node.accumulatedGather = (node.accumulatedGather ?? 0) + totalGather;
      const wholeResources = Math.floor(node.accumulatedGather);

      if (wholeResources > 0) {
        const perWorker = wholeResources / Math.max(inRangeWorkers.length, 1);
        const gatheredByPlayer = new Map<string, number>();
        for (const workerId of inRangeWorkers) {
          const worker = match.entities.get(workerId);
          if (worker) {
            gatheredByPlayer.set(
              worker.ownerId,
              (gatheredByPlayer.get(worker.ownerId) ?? 0) + perWorker
            );
          }
        }

        let distributed = 0;
        for (const [ownerId, count] of gatheredByPlayer) {
          const rounded = Math.round(count);
          const capped = Math.min(rounded, wholeResources - distributed);
          if (capped <= 0) continue;
          const playerIdx = match.players.findIndex((p) => p?.playerId === ownerId);
          if (playerIdx >= 0 && match.economy[playerIdx]) {
            match.economy[playerIdx]!.resources += capped;
            distributed += capped;
          }
        }

        node.remaining = Math.max(0, node.remaining - distributed);
        node.accumulatedGather -= distributed;
      }

      if (node.remaining <= 0) {
        node.gathererSlots.clear();
      }
    }

    // Passive refresh: slowly replenish nodes not being actively gathered
    for (const node of match.resourceNodes) {
      if (node.gathererSlots.size === 0 && node.remaining < node.capacity) {
        node.remaining = Math.min(node.capacity, node.remaining + 0.1);
      }
    }
  }

private processConstruction(match: MatchState): void {
     for (const entity of match.entities.values()) {
       if (entity.type !== "building") continue;

       // If under construction, advance progress based on workers in range
       if (entity.constructionProgress < 100) {
         const def = entity.buildingType ? BUILDING_DEFS[entity.buildingType] : null;
         if (def && entity.buildWorkerIds && entity.buildWorkerIds.size > 0) {
           let workersInRange = 0;
           for (const wid of entity.buildWorkerIds) {
             const worker = match.entities.get(wid);
             if (!worker) continue;
             const d = this.dist(worker.x, worker.y, entity.x, entity.y);
             if (d <= GATHER_RANGE) {
               workersInRange++;
               // Stop worker at building edge
               if (worker.moveTarget) {
                 const dx = worker.moveTarget.x - entity.x;
                 const dy = worker.moveTarget.y - entity.y;
                 if (Math.sqrt(dx * dx + dy * dy) < 5) {
                   worker.moveTarget = undefined;
                 }
               }
             } else {
               // Move worker toward building
               worker.moveTarget = { x: entity.x, y: entity.y };
             }
           }

           if (workersInRange > 0) {
             const progressPerTick = (workersInRange / def.buildTime) * 100;
             entity.constructionProgress = Math.min(
               100,
               entity.constructionProgress + progressPerTick
             );

             if (entity.constructionProgress >= 100) {
               entity.health = def.health;
               entity.maxHealth = def.health;
               // Free workers
               for (const wid of entity.buildWorkerIds) {
                 const worker = match.entities.get(wid);
                 if (worker) {
                   worker.buildTargetId = undefined;
                   worker.moveTarget = undefined;
                 }
               }
               entity.buildWorkerIds.clear();

              // If supply depot, increase max supply upon completion
              if (entity.buildingType === "supply_depot") {
                const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
                if (playerIdx >= 0 && match.economy[playerIdx]) {
                  match.economy[playerIdx]!.maxSupply += BUILDING_DEFS.supply_depot.supplyProvided!;
                }
              }
            }
           }
         }
       }

       // Process production queue
       if (entity.constructionProgress >= 100 && entity.productionQueue.length > 0) {
         const item = entity.productionQueue[0];
         if (item) {
           item.remainingTicks -= 1;

           if (item.remainingTicks <= 0) {
             const unitDef = UNIT_DEFS[item.unitType];
             if (unitDef) {
               const spawn = this.spawnOutside(entity, unitDef.radius);
               const unit = this.createEntity(
                 item.unitType,
                 entity.ownerId,
                 spawn.x,
                 spawn.y,
                 unitDef.health,
                 unitDef.radius,
                 unitDef.color
               );
               // Apply rally point if set
               if (entity.rallyPoint) {
                 unit.moveTarget = { ...entity.rallyPoint };
               }
               match.entities.set(unit.id, unit);
               // Increment supply for the spawned unit
               const spawnPIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
               if (spawnPIdx >= 0 && match.economy[spawnPIdx]) {
                 match.economy[spawnPIdx]!.supply += item.supplyCost;
               }
               entity.productionQueue.shift();
             }
           }
         }
       }
     }
   }

  private processRepairAndHealing(match: MatchState): void {
    for (const entity of match.entities.values()) {
      // Process building repair
      if (
        entity.type === "building" &&
        entity.health < entity.maxHealth &&
        entity.repairTargetId
      ) {
        const worker = match.entities.get(entity.repairTargetId);
        if (worker) {
          const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
          if (playerIdx >= 0 && match.economy[playerIdx]) {
            const economy = match.economy[playerIdx]!;
            const hpToRestore = 2;
            const cost = hpToRestore * 0.5;

            if (economy.resources >= cost) {
              economy.resources -= cost;
              entity.health = Math.min(
                entity.maxHealth,
                entity.health + hpToRestore
              );

              if (entity.health >= entity.maxHealth) {
                entity.repairTargetId = undefined;
              }
            }
          }
        }
      }

      // Process Medic healing
      if (entity.type === "medic" && entity.healTargetId) {
        const target = match.entities.get(entity.healTargetId);
        if (!target || target.ownerId !== entity.ownerId) {
          entity.healTargetId = undefined;
          continue;
        }
        if (target.type === "crystal" || target.type === "building") {
          entity.healTargetId = undefined;
          continue;
        }
      const healRange = this.getRange(entity);
        const d = this.dist(entity.x, entity.y, target.x, target.y);
        if (d <= healRange + target.radius && target.health < target.maxHealth) {
          const healed = Math.min(
            target.maxHealth,
            target.health + HEAL_RATE_PER_TICK
          );
          target.health = healed;
          match.attackLog.push({ attackerId: entity.id, targetId: target.id, damage: HEAL_RATE_PER_TICK, tick: match.tick, isHeal: true });
        }
      }
    }
  }

  private processDeaths(match: MatchState, damageLog: Map<string, number>): void {
    const toRemove = new Set<string>();

    // Apply damage
    for (const [entityId, damage] of damageLog) {
      const entity = match.entities.get(entityId);
      if (!entity) continue;
      entity.health -= damage;
      if (entity.health <= 0) {
        toRemove.add(entityId);
      }
    }

    // Remove dead entities
    for (const entityId of toRemove) {
      const entity = match.entities.get(entityId);
      if (!entity) continue;

      // Handle supply
      if (entity.type !== "crystal" && entity.type !== "building") {
        const unitDef = UNIT_DEFS[entity.type as keyof typeof UNIT_DEFS];
        const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
        if (playerIdx >= 0 && match.economy[playerIdx]) {
          match.economy[playerIdx]!.supply = Math.max(
            0,
            match.economy[playerIdx]!.supply - (unitDef?.supplyCost ?? 1)
          );
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
           match.economy[playerIdx]!.maxSupply = Math.max(
             0,
             match.economy[playerIdx]!.maxSupply - (def.supplyProvided ?? 0)
           );
           match.economy[playerIdx]!.supply = Math.min(
             match.economy[playerIdx]!.supply,
             match.economy[playerIdx]!.maxSupply
           );
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

  resetMatch(
    matchId: string,
    players: [PlayerSlot | null, PlayerSlot | null],
    config: MatchConfig = DEFAULT_CONFIG
  ): MatchState | null {
    this.stopTickLoop(matchId);

    const match = this.matches.get(matchId);
    if (!match) return null;

    match.phase = "spawn";
    match.tick = 0;
    match.players = players;
    match.result = null;
    match.startedAt = Date.now();
    match.endedAt = null;
    match.entities.clear();

    // Respawn entities
    const map = createMap(config);
    const blueCrystal = this.createEntity(
      "crystal",
      players[0]?.playerId ?? "",
      map.blueCrystal.x,
      map.blueCrystal.y,
      config.crystalHealth,
      config.crystalRadius,
      players[0]?.color === "blue" ? "#4488ff" : "#888888"
    );
    const redCrystal = this.createEntity(
      "crystal",
      players[1]?.playerId ?? "",
      map.redCrystal.x,
      map.redCrystal.y,
      config.crystalHealth,
      config.crystalRadius,
      players[1]?.color === "red" ? "#ff4444" : "#888888"
    );
    match.entities.set(blueCrystal.id, blueCrystal);
    match.entities.set(redCrystal.id, redCrystal);

    const blueWorkers = [
      this.createEntity(
        "worker",
        players[0]?.playerId ?? "",
        map.blueWorkers[0].x,
        map.blueWorkers[0].y,
        config.workerHealth,
        config.workerRadius,
        players[0]?.color === "blue" ? "#6699ff" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[0]?.playerId ?? "",
        map.blueWorkers[1].x,
        map.blueWorkers[1].y,
        config.workerHealth,
        config.workerRadius,
        players[0]?.color === "blue" ? "#6699ff" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[0]?.playerId ?? "",
        map.blueWorkers[2].x,
        map.blueWorkers[2].y,
        config.workerHealth,
        config.workerRadius,
        players[0]?.color === "blue" ? "#6699ff" : "#888888"
      ),
    ];

    const redWorkers = [
      this.createEntity(
        "worker",
        players[1]?.playerId ?? "",
        map.redWorkers[0].x,
        map.redWorkers[0].y,
        config.workerHealth,
        config.workerRadius,
        players[1]?.color === "red" ? "#ff6666" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[1]?.playerId ?? "",
        map.redWorkers[1].x,
        map.redWorkers[1].y,
        config.workerHealth,
        config.workerRadius,
        players[1]?.color === "red" ? "#ff6666" : "#888888"
      ),
      this.createEntity(
        "worker",
        players[1]?.playerId ?? "",
        map.redWorkers[2].x,
        map.redWorkers[2].y,
        config.workerHealth,
        config.workerRadius,
        players[1]?.color === "red" ? "#ff6666" : "#888888"
      ),
    ];

    for (const w of blueWorkers) match.entities.set(w.id, w);
    for (const w of redWorkers) match.entities.set(w.id, w);

    // Reset resource nodes
    match.resourceNodes = [];
    const allNodeLayouts = [
      ...map.blueSafeNodes.map((n) => ({ ...n, ownerId: players[0]?.playerId ?? "" })),
      ...map.redSafeNodes.map((n) => ({ ...n, ownerId: players[1]?.playerId ?? "" })),
      ...map.contestedNodes.map((n) => ({ ...n, ownerId: "" })),
    ];

    for (const layout of allNodeLayouts) {
     const node: ResourceNode = {
         id: randomUUID(),
         x: layout.x,
         y: layout.y,
         radius: layout.radius,
         color: "#ccaa44",
         capacity: layout.capacity,
         remaining: layout.capacity,
         maxGathererSlots: 3,
         gathererSlots: new Set<EntityId>(),
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
          }
        : null,
      players[1]
        ? {
            resources: config.startingResources,
            supply: 3 * config.workerSupplyCost, // 3 starting workers
            maxSupply: config.startingMaxSupply,
          }
        : null,
    ];

    return match;
  }

  destroyMatch(matchId: string): void {
    this.stopTickLoop(matchId);
    this.matches.delete(matchId);
  }

  hasActiveMatch(lobbyCode: string): boolean {
    for (const m of this.matches.values()) {
      if (m.lobbyCode === lobbyCode && m.phase !== "ended") {
        return true;
      }
    }
    return false;
  }

  private createEntity(
    type: "crystal" | "worker" | "placeholder" | "resource_node" | "building" | "skirmisher" | "gunner" | "bruiser" | "medic",
    ownerId: PlayerId,
    x: number,
    y: number,
    health: number,
    radius: number,
    color: string,
    buildingType?: BuildingType
  ): MatchEntity {
    const autoAttackEnabled = false; // Units start with auto-attack off; player toggles via hotkey

    if (type === "building" && buildingType) {
      const def = BUILDING_DEFS[buildingType];
      return {
        id: randomUUID(),
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
      id: randomUUID(),
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
  private spawnOutside(parent: MatchEntity, childRadius: number): { x: number; y: number } {
    const parentRadius = parent.type === "building" || parent.type === "crystal"
      ? parent.radius
      : parent.radius;
    const gap = 4;
    const spawnDist = parentRadius + childRadius + gap;
    const angle = Math.random() * Math.PI * 2;
    return {
      x: parent.x + Math.cos(angle) * spawnDist,
      y: parent.y + Math.sin(angle) * spawnDist,
    };
  }

  private startTickLoop(matchId: string): void {
    const match = this.matches.get(matchId);
    if (!match) return;

    let subStepCount = 0;
    const subStepMs = 20;
    const fullTickMs = match.tickIntervalMs || 100;

    const interval = setInterval(() => {
      const m = this.matches.get(matchId);
      if (!m || m.phase !== "playing") {
        clearInterval(interval);
        this.intervals.delete(matchId);
        return;
      }

      subStepCount++;
      if (subStepCount % (fullTickMs / subStepMs) === 0) {
        this.tick(matchId);
        if (this.broadcastCallback) {
          this.broadcastCallback(matchId);
        }
      } else {
        this.subStepMovement(matchId);
      }
    }, subStepMs);

    this.intervals.set(matchId, interval);
  }

  private stopTickLoop(matchId: string): void {
    const interval = this.intervals.get(matchId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(matchId);
    }
  }
}
