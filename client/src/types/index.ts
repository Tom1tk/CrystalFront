import type {
  Lobby,
  Player,
  LobbyState,
  BuildingType,
  UnitType,
  ProductionQueueItem,
  AttackEvent,
  PlayerSlot,
  CameraState,
} from "@crystalfront/shared";

export type { Lobby, Player, LobbyState, BuildingType, UnitType, ProductionQueueItem, AttackEvent, PlayerSlot, CameraState };

export type Screen = "menu" | "lobby" | "game" | "matchEnd";

export interface WSMessage {
  type: string;
  payload?: Record<string, unknown>;
}

export interface MatchEntity {
  id: string;
  type: "crystal" | "worker" | "placeholder" | "resource_node" | "building" | "skirmisher" | "gunner" | "bruiser" | "medic";
  ownerId: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  radius: number;
  color: string;
  buildingType?: BuildingType;
  constructionProgress: number;
  buildWorkerIds?: string[];
  buildTargetId?: string;
  productionQueue: ProductionQueueItem[];
  repairTargetId?: string;
  repairProgress?: number;
  gatheringNodeId?: string;
  moveTarget?: { x: number; y: number };
  attackTargetId?: string;
  attackCooldown: number;
  healTargetId?: string;
  autoAttackEnabled: boolean;
  rallyPoint?: { x: number; y: number };
}

export interface ResourceNodeDisplay {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  capacity: number;
  remaining: number;
}

export interface PlayerEconomyDisplay {
  resources: number;
  supply: number;
  maxSupply: number;
}

export interface MatchState {
  id: string;
  lobbyCode: string;
  phase: "spawn" | "playing" | "ended";
  tick: number;
  tickIntervalMs: number;
  stateTimestamp?: number;
  players: [PlayerSlot | null, PlayerSlot | null];
  entities: MatchEntity[];
  attackLog: AttackEvent[];
  result: { winner: string } | null;
  startedAt: number;
  endedAt: number | null;
  economy: [PlayerEconomyDisplay | null, PlayerEconomyDisplay | null];
  resourceNodes: ResourceNodeDisplay[];
  config?: {
    mapWidth: number;
    mapHeight: number;
    viewportWidth: number;
    viewportHeight: number;
  };
  mapWidth: number;
  mapHeight: number;
}
