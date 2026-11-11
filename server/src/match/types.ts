import type { EntityId, MatchId, PlayerId, PlayerColor } from "@crystalfront/shared";
import {
  ECONOMY,
  GATHERING,
  MAP,
  ENTITY,
  SIMULATION,
} from "@crystalfront/shared";
import type { Rng } from "./engine/rng.js";
import type { IdGen } from "./engine/idGen.js";
import type { NavGrid } from "./engine/navGrid.js";
import type { Terrain } from "./engine/terrain.js";
import type { PlayerVision } from "./engine/visibility.js";

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
  lifetimeResources: number;  // total ever gathered — used for passive win condition
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
  /** G-8: a contested (mid-map) node, counted for node control. */
  contested?: boolean;
  /** G-8: slot holding this node this tick (contested nodes only). */
  controller?: 0 | 1 | null;
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
  result: { winner: PlayerId; winType?: "combat" | "control" | "timeout" | "forfeit" } | null;
  startedAt: number;
  endedAt: number | null;
  economy: [PlayerEconomy | null, PlayerEconomy | null];
  resourceNodes: ResourceNode[];
  /** G-8 node control: slot holding a majority this tick, and each slot's progress toward CONTROL.holdTicks. */
  control: { holder: 0 | 1 | null; progress: [number, number] };
  config: MatchConfig;
  mapWidth: number;
  mapHeight: number;
  /** G-3 nav grid (derived from structures + terrain; excluded from the state hash). */
  nav: NavGrid;
  /** G-5 static terrain for config.mapId (shared, read-only; excluded from the hash). */
  terrain: Terrain;
  // Fog of war — computed at the end of each tick, keyed by playerId. Derived from
  // the state (clones recompute it); combat reads it for target acquisition (G-6b).
  visibilityData?: Map<PlayerId, PlayerVision>;
  // Determinism — seedable RNG and monotonic ID generator.
  // One RNG stream per player slot so spawn-position randomization for one
  // player never depends on engine processing order relative to the other
  // (a shared stream's consumption order is fixed by entity-Map insertion
  // order, which is not symmetric between players).
  rng: [Rng, Rng];
  idGen: IdGen;
  seed: number;
  // Replay — append-only log of every successful command
  commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }>;
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
  /** Active player move order (G-1). attack=false: plain move, ignores enemies until
   *  arrival. attack=true: attack-move, fights anything met, then resumes to (x,y). */
  moveOrder?: { x: number; y: number; attack: boolean };
  /** Planned route toward moveTarget (G-4). Recomputed when the goal changes cell,
   *  the nav grid blocks the remaining route, or the unit is stuck. */
  route?: EntityRoute;
  /** Shift-queued orders, run in turn once the unit is idle (G-9f). Max ORDER_QUEUE_MAX. */
  orderQueue?: QueuedOrder[];
}

export type QueuedOrderType = "move" | "attack_move" | "attack" | "build";
export interface QueuedOrder {
  type: QueuedOrderType;
  targetX?: number;
  targetY?: number;
  targetEntityId?: string;
  buildingType?: BuildingType;
}
export const ORDER_QUEUE_MAX = 8;

export interface EntityRoute {
  /** moveTarget the route was planned for. */
  goalX: number;
  goalY: number;
  /** Remaining intermediate waypoints; the final leg goes straight to moveTarget. */
  waypoints: { x: number; y: number }[];
  /** Goal unreachable: stop after the last waypoint (nearest reachable point). */
  truncated: boolean;
  /** Nav grid version the route was last validated against. */
  version: number;
  /** Stuck detection: closest distance to the current steer point, and ticks since it improved. */
  bestDist: number;
  stuckTicks: number;
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

// BuildingDef and UnitDef are defined in @crystalfront/shared gameBalance.ts — use those.

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
  /** Map id (G-5); terrain comes from the map registry. Default "classic" (no terrain). */
  mapId?: string;
  // ── Per-version balance overrides (populated from BalanceSnapshot for replays) ──
  maxTicks?: number;              // tick cap; 0 = no cap; tiebreak resolves the winner
  workerSpeed?: number;           // px/substep override
  skirmisherSpeed?: number;
  skirmisherDamage?: number;
}

export const DEFAULT_CONFIG: MatchConfig = {
  tickIntervalMs: SIMULATION.tickIntervalMs,
  mapWidth: MAP.width,
  mapHeight: MAP.height,
  crystalHealth: ENTITY.crystal.health,
  crystalRadius: ENTITY.crystal.radius,
  workerHealth: ENTITY.worker.health,
  workerRadius: ENTITY.worker.radius,
  placeholderHealth: ENTITY.placeholder.health,
  placeholderRadius: ENTITY.placeholder.radius,
  startingResources: ECONOMY.startingResources,
  startingMaxSupply: ECONOMY.startingMaxSupply,
  workerTrainCost: ECONOMY.workerTrainCost,
  workerSupplyCost: ECONOMY.workerSupplyCost,
  gatherRatePerTick: GATHERING.ratePerTick,
  viewportWidth: MAP.viewportWidth,
  viewportHeight: MAP.viewportHeight,
};
