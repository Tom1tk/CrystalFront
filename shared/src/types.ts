export type PlayerId = string;

export type LobbyCode = string;

export type PlayerColor = "blue" | "red";

export type LobbyStatus = "waiting" | "ready" | "match";

export interface Player {
  id: PlayerId;
  username: string;
  color: PlayerColor;
  ready: boolean;
  score: number;
}

export interface Lobby {
  code: LobbyCode;
  players: [Player | null, Player | null];
  status: LobbyStatus;
  hostId: PlayerId;
}

export interface LobbyState {
  lobbies: Record<LobbyCode, Lobby>;
}

// ---- Match / Simulation Types ----

export type EntityId = string;
export type MatchId = string;

export type EntityType =
  | "crystal"
  | "worker"
  | "placeholder"
  | "resource_node"
  | "building"
  | "skirmisher"
  | "gunner"
  | "bruiser"
  | "medic";

export type BuildingType = "barracks" | "foundry" | "supply_depot" | "turret";

export type UnitType = "worker" | "skirmisher" | "gunner" | "bruiser" | "medic";

export interface Entity {
  id: EntityId;
  type: EntityType;
  ownerId: PlayerId;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  radius: number;
  color: string;
  buildingType?: BuildingType;
  constructionProgress?: number;
  buildWorkerIds?: string[];
  buildTargetId?: string;
  productionQueue?: ProductionQueueItem[];
  repairTargetId?: string;
  repairProgress?: number;
  gatheringNodeId?: string;
  moveTarget?: { x: number; y: number };
  attackTargetId?: string;
  attackCooldown: number;
  healTargetId?: string;
  autoAttackEnabled: boolean;
}

export type MatchPhase = "spawn" | "playing" | "ended";

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
}

export interface BuildingStats {
  cost: number;
  buildTime: number;
  health: number;
  width: number;
  height: number;
  color: string;
  supplyProvided?: number;
  produces?: string[];
}

export interface UnitStats {
  cost: number;
  supplyCost: number;
  buildTime: number;
  health: number;
  radius: number;
  damage: number;
  range: number;
  speed: number;
  color: string;
  produces?: string[];
}

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

export interface MatchConfig {
  mapWidth: number;
  mapHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface MatchState {
  id: MatchId;
  lobbyCode: LobbyCode;
  phase: MatchPhase;
  tick: number;
  tickIntervalMs: number;
  stateTimestamp?: number;
  players: [PlayerSlot | null, PlayerSlot | null];
  entities: Entity[];
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

export interface PlayerSlot {
  playerId: PlayerId;
  username: string;
  color: PlayerColor;
  score: number;
}

export type CommandType =
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

export interface ClientCommand {
  tick: number;
  type: CommandType;
  entityId?: string;
  entityIds?: string[];
  targetX?: number;
  targetY?: number;
  targetEntityId?: string;
  buildingType?: BuildingType;
  workerIds?: string[];
}

export interface GameSnapshot {
  match: MatchState;
  commands: ClientCommand[];
}

// ---- Camera ----

export interface CameraState {
  x: number;
  y: number;
  width: number;
  height: number;
}
