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

export type Screen = "menu" | "lobby" | "game" | "matchEnd" | "replays" | "watching_replay";

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
  /** G-11: facing in radians toward the current target (undefined = keep last). */
  heading?: number;
  /** G-11: animation hint. */
  actionState?: "idle" | "moving" | "attacking" | "gathering" | "constructing" | "dying";
  /** G-4: remaining route waypoints before moveTarget (own units only). */
  path?: Array<{ x: number; y: number }>;
  /** G-9f: shift-queued order destinations (own units only). */
  queue?: Array<{ x: number; y: number; type: string }>;
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
  result: { winner: string; winType?: "combat" | "control" | "timeout" } | null;
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
  /** Sent with match_start; the client hook carries it on every later state (G-5). */
  staticMap?: StaticMap;
  /** Node control (G-8): public, ignores fog. holder/controller are player slots. */
  control?: ControlState;
  /** Own vision bitmap (G-6b): base64 bitset over the vision grid, row-major. */
  vision?: string;
}

export interface ControlState {
  holder: 0 | 1 | null;
  /** Each slot's control progress toward holdTicks. */
  progress: [number, number];
  holdTicks: number;
  need: number;
  radius: number;
  nodes: { id: string; x: number; y: number; controller: 0 | 1 | null }[];
}

export interface StaticMap {
  cellSize: number;
  cols: number;
  rows: number;
  mapId?: string;
  mapVersion?: number;
  /** RLE terrain codes "code:count,…" — 0 open, 1 rough, 2 high, 3 brush, 4 rock, 5 cliff, 6 water. */
  terrain?: string;
  /** Vision grid geometry (G-6b). */
  visionCellSize?: number;
  visionCols?: number;
  visionRows?: number;
}
