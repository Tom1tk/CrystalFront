import type { EntityId, MatchId, PlayerId, PlayerColor } from "@crystalfront/shared";

export type MatchPhase = "spawn" | "playing" | "ended";

export interface PlayerSlot {
  playerId: PlayerId;
  username: string;
  color: PlayerColor;
  score: number;
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
  ownerId?: PlayerId;
  accumulatedGather?: number;
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
  // Fog of war — computed per tick, keyed by playerId
  visibilityData?: Map<PlayerId, { entityIds: Set<EntityId>; nodeIds: Set<string> }>;
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
  buildWorkerIds?: Set<EntityId>;
  productionQueue: ProductionQueueItem[];
  rallyPoint?: { x: number; y: number };
  repairTargetId?: EntityId;
  repairProgress: number;
  gatheringNodeId?: string;
  buildTargetId?: EntityId;
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
    | "train_unit"
    | "build"
    | "repair"
    | "attack"
    | "heal";
  entityId?: string;
  entityIds?: string[];
  targetX?: number;
  targetY?: number;
  targetEntityId?: string;
  buildingType?: BuildingType;
  workerIds?: string[];
}

export interface BuildingDefinition {
  cost: number;
  buildTime: number;
  health: number;
  width: number;
  height: number;
  color: string;
  supplyProvided?: number;
  produces?: string[];
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

// Constants imported from @crystalfront/shared:
// BUILDING_DEFS, UNIT_DEFS, REPAIR_COST_PER_HP, REPAIR_RATE_PER_TICK,
// BUILDING_MIN_SPACING, CRYSTAL_NO_BUILD_RADIUS, COUNTER_MULTIPLIERS, HEAL_RATE_PER_TICK

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
  viewportWidth: 960,
  viewportHeight: 540,
};
