import type { EntityId, MatchId, PlayerId, PlayerColor } from "@crystalfront/shared";

export type MatchPhase = "spawn" | "playing" | "ended";

export interface PlayerSlot {
  playerId: PlayerId;
  username: string;
  color: PlayerColor;
  score: number;
  wsId: string;
}

export interface PlayerEconomy {
  resources: number;
  supply: number;
  maxSupply: number;
}

export interface ResourceNode {
  id: EntityId;
  x: number;
  y: number;
  radius: number;
  color: string;
  capacity: number;
  remaining: number;
  maxGathererSlots: number;
  gathererSlots: Set<EntityId>;
}

export type BuildingType = "barracks" | "foundry" | "supply_depot" | "turret";

export type UnitType = "worker" | "skirmisher" | "gunner" | "bruiser" | "medic";

export interface ProductionQueueItem {
  unitType: UnitType;
  cost: number;
  supplyCost: number;
  buildTime: number;
  remainingTicks: number;
}

export interface AttackEvent {
  attackerId: EntityId;
  targetId: EntityId;
  damage: number;
  tick: number;
  isHeal: boolean;
}

export interface MatchState {
  id: MatchId;
  lobbyCode: string;
  phase: MatchPhase;
  tick: number;
  tickIntervalMs: number;
  stateTimestamp?: number;
  players: [PlayerSlot | null, PlayerSlot | null];
  entities: Map<EntityId, MatchEntity>;
  attackLog: AttackEvent[];
  result: { winner: PlayerId } | null;
  startedAt: number;
  endedAt: number | null;
  economy: [PlayerEconomy | null, PlayerEconomy | null];
  resourceNodes: ResourceNode[];
  config: MatchConfig;
  mapWidth: number;
  mapHeight: number;
}

export interface MatchEntity {
  id: EntityId;
  type: "crystal" | "worker" | "placeholder" | "resource_node" | "building" | "skirmisher" | "gunner" | "bruiser" | "medic";
  ownerId: PlayerId;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  radius: number;
  color: string;
  buildingType?: BuildingType;
  constructionProgress: number;
  buildWorkerId?: EntityId;
  productionQueue: ProductionQueueItem[];
  repairTargetId?: EntityId;
  repairProgress: number;
  gatheringNodeId?: string;
  moveTarget?: { x: number; y: number };
  attackTargetId?: EntityId;
  attackCooldown: number;
  healTargetId?: EntityId;
  autoAttackEnabled: boolean;
  commandedTicks?: number;
}

export interface CommandEntry {
  tick: number;
  playerId: PlayerId;
  type:
    | "move"
    | "select"
    | "deselect"
    | "gather"
    | "train_worker"
    | "build"
    | "repair"
    | "attack"
    | "heal";
  entityId?: string;
  targetX?: number;
  targetY?: number;
  targetEntityId?: string;
  buildingType?: BuildingType;
}

export interface BuildingDefinition {
  cost: number;
  buildTime: number;
  health: number;
  width: number;
  height: number;
  color: string;
  supplyProvided?: number;
  produces?: UnitType[];
  damage?: number;
  range?: number;
  attackCooldown?: number;
}

export interface UnitDefinition {
  cost: number;
  supplyCost: number;
  buildTime: number;
  health: number;
  radius: number;
  damage: number;
  range: number;
  speed: number;
  color: string;
  attackCooldown: number;
}

export const BUILDING_DEFS: Record<BuildingType, BuildingDefinition> = {
  barracks: {
    cost: 75,
    buildTime: 150,
    health: 500,
    width: 40,
    height: 40,
    color: "#4488cc",
    produces: ["skirmisher", "gunner"],
  },
  foundry: {
    cost: 100,
    buildTime: 200,
    health: 600,
    width: 44,
    height: 44,
    color: "#cc6644",
    produces: ["bruiser", "medic"],
  },
  supply_depot: {
    cost: 50,
    buildTime: 100,
    health: 300,
    width: 36,
    height: 36,
    color: "#88aa66",
    supplyProvided: 10,
  },
  turret: {
    cost: 60,
    buildTime: 120,
    health: 400,
    width: 30,
    height: 30,
    color: "#aa8844",
    damage: 18,
    range: 150,
    attackCooldown: 12,
  },
};

export const UNIT_DEFS: Record<UnitType, UnitDefinition> = {
  worker: {
    cost: 25,
    supplyCost: 1,
    buildTime: 80,
    health: 100,
    radius: 10,
    damage: 5,
    range: 15,
    speed: 2,
    color: "#aabbcc",
    attackCooldown: 20,
  },
  skirmisher: {
    cost: 50,
    supplyCost: 1,
    buildTime: 100,
    health: 120,
    radius: 12,
    damage: 15,
    range: 20,
    speed: 2.5,
    color: "#44dd88",
    attackCooldown: 10,
  },
  gunner: {
    cost: 75,
    supplyCost: 1,
    buildTime: 120,
    health: 80,
    radius: 11,
    damage: 20,
    range: 120,
    speed: 1.5,
    color: "#ddaa44",
    attackCooldown: 15,
  },
  bruiser: {
    cost: 100,
    supplyCost: 2,
    buildTime: 150,
    health: 250,
    radius: 14,
    damage: 12,
    range: 20,
    speed: 1.8,
    color: "#8866cc",
    attackCooldown: 8,
  },
  medic: {
    cost: 60,
    supplyCost: 1,
    buildTime: 120,
    health: 90,
    radius: 11,
    damage: 3,
    range: 80,
    speed: 2,
    color: "#44ccdd",
    attackCooldown: 25,
  },
};

export const REPAIR_COST_PER_HP = 0.5;
export const REPAIR_RATE_PER_TICK = 2;
export const BUILDING_MIN_SPACING = 50;
export const CRYSTAL_NO_BUILD_RADIUS = 80;

// Counter triangle multipliers: attacker -> defender -> multiplier
export const COUNTER_MULTIPLIERS: Record<string, Record<string, number>> = {
  skirmisher: { gunner: 2.0, bruiser: 0.5, worker: 1.0, medic: 1.0 },
  gunner: { bruiser: 2.0, skirmisher: 0.5, worker: 1.0, medic: 1.0 },
  bruiser: { skirmisher: 2.0, gunner: 0.5, worker: 1.0, medic: 1.0 },
  medic: { worker: 1.0, skirmisher: 1.0, gunner: 1.0, bruiser: 1.0 },
  worker: { worker: 1.0, skirmisher: 1.0, gunner: 1.0, bruiser: 1.0, medic: 1.0 },
};

export const HEAL_RATE_PER_TICK = 5;

export interface MatchConfig {
  tickIntervalMs: number;
  mapWidth: number;
  mapHeight: number;
  crystalHealth: number;
  crystalRadius: number;
  workerHealth: number;
  workerRadius: number;
  placeholderHealth: number;
  placeholderRadius: number;
  startingResources: number;
  startingMaxSupply: number;
  workerTrainCost: number;
  workerSupplyCost: number;
  gatherRatePerTick: number;
  viewportWidth: number;
  viewportHeight: number;
}

export const DEFAULT_CONFIG: MatchConfig = {
  tickIntervalMs: 100,
  mapWidth: 6000,
  mapHeight: 600,
  crystalHealth: 1000,
  crystalRadius: 30,
  workerHealth: 100,
  workerRadius: 10,
  placeholderHealth: 500,
  placeholderRadius: 15,
  startingResources: 50,
  startingMaxSupply: 10,
  workerTrainCost: 25,
  workerSupplyCost: 1,
  gatherRatePerTick: 1,
  viewportWidth: 600,
  viewportHeight: 600,
};
