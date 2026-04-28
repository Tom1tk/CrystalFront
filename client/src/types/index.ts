export type Screen = "menu" | "lobby" | "game" | "matchEnd";

export interface Player {
  id: string;
  username: string;
  color: "blue" | "red";
  ready: boolean;
  score: number;
}

export interface Lobby {
  code: string;
  players: [Player | null, Player | null];
  status: "waiting" | "ready" | "match";
  hostId: string;
}

export interface LobbyState {
  lobbies: Record<string, Lobby>;
}

export interface WSMessage {
  type: string;
  payload?: Record<string, unknown>;
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
  buildWorkerId?: string;
  productionQueue: ProductionQueueItem[];
  repairTargetId?: string;
  repairProgress: number;
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

export interface PlayerSlot {
  playerId: string;
  username: string;
  color: "blue" | "red";
  score: number;
}

export interface CameraState {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MatchState {
  id: string;
  lobbyCode: string;
  phase: "spawn" | "playing" | "ended";
  tick: number;
  tickIntervalMs: number;
  players: [PlayerSlot | null, PlayerSlot | null];
  entities: MatchEntity[];
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
