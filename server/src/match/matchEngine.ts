import { randomUUID } from "node:crypto";
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
import { DEFAULT_CONFIG, BUILDING_DEFS, UNIT_DEFS } from "./types.js";
import {
  validatePlacement,
  findCrystalByColor,
  type PlacementResult,
} from "./buildingValidation.js";

export class MatchEngine {
  private matches = new Map<string, MatchState>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private broadcastCallback: ((matchId: string) => void) | null = null;

  setBroadcastCallback(cb: (matchId: string) => void): void {
    this.broadcastCallback = cb;
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
      };
      resourceNodes.push(node);
    }

    // Create economy for each player
    const economy: [PlayerEconomy | null, PlayerEconomy | null] = [
      players[0]
        ? {
            resources: config.startingResources,
            supply: 0,
            maxSupply: config.startingMaxSupply,
          }
        : null,
      players[1]
        ? {
            resources: config.startingResources,
            supply: 0,
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
      result: null,
      startedAt: Date.now(),
      endedAt: null,
      economy,
      resourceNodes,
      config,
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
    return match;
  }

  getMatch(matchId: string): MatchState | undefined {
    return this.matches.get(matchId);
  }

  getAllMatches(): MatchState[] {
    return Array.from(this.matches.values());
  }

  processCommand(
    matchId: string,
    playerId: PlayerId,
    command: {
      type:
        | "move"
        | "select"
        | "deselect"
        | "gather"
        | "train_worker"
        | "train_unit"
        | "build"
        | "repair";
      entityId?: string;
      targetX?: number;
      targetY?: number;
      targetEntityId?: string;
      buildingType?: BuildingType;
    }
  ): { success: boolean; message?: string } {
    const match = this.matches.get(matchId);
    if (!match) return { success: false };
    if (match.phase !== "playing") return { success: false };

    const config = match.config;

    if (
      command.type === "move" ||
      command.type === "select" ||
      command.type === "deselect"
    ) {
      const entity = Array.from(match.entities.values()).find(
        (e) => e.id === command.entityId && e.ownerId === playerId
      );
      if (!entity) return { success: false };

      if (
        command.type === "move" &&
        command.targetX !== undefined &&
        command.targetY !== undefined
      ) {
        entity.x = command.targetX;
        entity.y = command.targetY;
      }

      return { success: true };
    }

    if (command.type === "gather") {
      const worker = Array.from(match.entities.values()).find(
        (e) => e.id === command.entityId && e.type === "worker" && e.ownerId === playerId
      );
      if (!worker) return { success: false, message: "Worker not found" };

      const targetNode = match.resourceNodes.find(
        (n) => n.id === command.targetEntityId
      );
      if (!targetNode) return { success: false, message: "Resource node not found" };
      if (targetNode.remaining <= 0) return { success: false, message: "Node is depleted" };
      if (targetNode.gathererSlots.size >= targetNode.maxGathererSlots)
        return { success: false, message: "Node is full" };

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

      const newWorker = this.createEntity(
        "worker",
        playerId,
        crystal.x + (Math.random() * 20 - 10),
        crystal.y + (Math.random() * 20 - 10),
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
      const building = Array.from(match.entities.values()).find(
        (e) => e.id === command.entityId && e.type === "building" && e.ownerId === playerId
      );
      if (!building) return { success: false, message: "Building not found" };
      if (building.constructionProgress < 100) {
        return { success: false, message: "Building not yet constructed" };
      }

      const unitType = command.targetEntityId as UnitType | undefined;
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

      if (economy.resources < unitDef.cost) {
        return { success: false, message: "Not enough resources" };
      }
      if (economy.supply + unitDef.supplyCost > economy.maxSupply) {
        return { success: false, message: "Not enough supply" };
      }

      building.productionQueue.push({
        unitType,
        cost: unitDef.cost,
        supplyCost: unitDef.supplyCost,
        buildTime: unitDef.buildTime,
        remainingTicks: unitDef.buildTime,
      });

      return { success: true };
    }

    if (command.type === "build") {
      console.log("[MatchEngine] BUILD cmd - playerId:", playerId, "buildingType:", command.buildingType, "pos:", command.targetX, command.targetY);
      console.log("[MatchEngine] BUILD cmd - match.players:", match.players.map((p) => p?.playerId).join(","));
      console.log("[MatchEngine] BUILD cmd - match.players[0]?.playerId:", match.players[0]?.playerId, "match.players[1]?.playerId:", match.players[1]?.playerId);

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
      console.log("[MatchEngine] BUILD cmd - playerIdx:", playerIdx, "playerId match:", playerId === match.players[playerIdx]?.playerId);
      if (playerIdx < 0) return { success: false, message: "Player not found in match" };

      const economy = match.economy[playerIdx];
      if (!economy) return { success: false, message: "No economy" };

      console.log("[MatchEngine] BUILD cmd - resources:", economy.resources, "cost:", def.cost);
      if (economy.resources < def.cost) {
        return { success: false, message: "Not enough resources" };
      }

      // Determine build zone and player color
      const playerColor = match.players[playerIdx]?.color ?? "blue";
      const map = config.mapWidth === 1200 ? createMap(config) : createMap(config);
      const buildZone =
        playerColor === "blue" ? map.blueBuildZone : map.redBuildZone;
      const laneCorridor = map.laneCorridor;

      // Find crystals for this player
      const playerCrystals = Array.from(match.entities.values()).filter(
        (e) => e.type === "crystal" && e.ownerId === playerId
      );

      // Validate placement
      const placement = validatePlacement(
        targetX,
        targetY,
        def,
        buildZone,
        laneCorridor,
        match.entities,
        match.resourceNodes,
        playerColor,
        playerCrystals,
        playerId
      );
      console.log("[MatchEngine] BUILD cmd - placement valid:", placement.valid, "reason:", placement.reason);
      console.log("[MatchEngine] BUILD cmd - buildZone:", JSON.stringify(buildZone), "playerColor:", playerColor);
      if (!placement.valid) {
        return { success: false, message: placement.reason };
      }

      // Deduct resources
      console.log("[MatchEngine] BUILD cmd - placing building, deducting", def.cost, "resources");
      economy.resources -= def.cost;

      // Create building entity
      console.log("[MatchEngine] BUILD cmd - creating building at", targetX, targetY);
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
        buildWorkerId: undefined,
        productionQueue: [],
        repairTargetId: undefined,
        repairProgress: 0,
      };
      match.entities.set(building.id, building);

      // If supply depot, increase max supply immediately
      if (def.supplyProvided) {
        economy.maxSupply += def.supplyProvided;
      }

      console.log("[MatchEngine] BUILD cmd - SUCCESS, building id:", building.id, "remaining resources:", economy.resources);
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

    return { success: false };
  }

  tick(matchId: string): MatchState | null {
    const match = this.matches.get(matchId);
    if (!match || match.phase !== "playing") return null;

    match.tick++;

    // Process resource gathering
    for (const node of match.resourceNodes) {
      if (node.remaining <= 0 || node.gathererSlots.size === 0) continue;

      const gatherCount = node.gathererSlots.size;
      const totalGather = gatherCount * 1;

      const gatheredByPlayer = new Map<string, number>();
      for (const workerId of node.gathererSlots) {
        const worker = match.entities.get(workerId);
        if (worker) {
          gatheredByPlayer.set(
            worker.ownerId,
            (gatheredByPlayer.get(worker.ownerId) ?? 0) + 1
          );
        }
      }

      for (const [ownerId, count] of gatheredByPlayer) {
        const playerIdx = match.players.findIndex((p) => p?.playerId === ownerId);
        if (playerIdx >= 0 && match.economy[playerIdx]) {
          match.economy[playerIdx]!.resources += count;
        }
      }

      node.remaining = Math.max(0, node.remaining - totalGather);

      if (node.remaining <= 0) {
        node.gathererSlots.clear();
      }
    }

    // Process construction
    for (const entity of match.entities.values()) {
      if (entity.type !== "building") continue;

      // If under construction, advance progress
      if (entity.constructionProgress < 100) {
        const def = entity.buildingType ? BUILDING_DEFS[entity.buildingType] : null;
        if (def) {
          const progressPerTick = 100 / def.buildTime;
          entity.constructionProgress = Math.min(
            100,
            entity.constructionProgress + progressPerTick
          );

          if (entity.constructionProgress >= 100) {
            entity.health = def.health;
            entity.maxHealth = def.health;
          }
        }
      }

      // Process production queue
      if (entity.constructionProgress >= 100 && entity.productionQueue.length > 0) {
        const item = entity.productionQueue[0];
        if (item) {
          item.remainingTicks -= 1;

          if (item.remainingTicks <= 0) {
            // Unit complete - spawn it
            const unitDef = UNIT_DEFS[item.unitType];
            if (unitDef) {
              const unit = this.createEntity(
                item.unitType,
                entity.ownerId,
                entity.x + (Math.random() * 30 - 15),
                entity.y + (Math.random() * 30 - 15),
                unitDef.health,
                unitDef.radius,
                unitDef.color
              );
              match.entities.set(unit.id, unit);

              // Remove from queue
              entity.productionQueue.shift();
            }
          }
        }
      }

      // Process repair
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
    }

    return match;
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
      };
      match.resourceNodes.push(node);
    }

    // Reset economy (keep scores)
    match.economy = [
      players[0]
        ? {
            resources: config.startingResources,
            supply: 0,
            maxSupply: config.startingMaxSupply,
          }
        : null,
      players[1]
        ? {
            resources: config.startingResources,
            supply: 0,
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
        buildWorkerId: undefined,
        productionQueue: [],
        repairTargetId: undefined,
        repairProgress: 0,
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
      buildWorkerId: undefined,
      productionQueue: [],
      repairTargetId: undefined,
      repairProgress: 0,
    };
  }

  private startTickLoop(matchId: string): void {
    const match = this.matches.get(matchId);
    if (!match) return;

    const interval = setInterval(() => {
      const m = this.matches.get(matchId);
      if (!m || m.phase !== "playing") {
        clearInterval(interval);
        this.intervals.delete(matchId);
        return;
      }
      this.tick(matchId);
      if (this.broadcastCallback) {
        this.broadcastCallback(matchId);
      }
    }, match.tickIntervalMs);

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
