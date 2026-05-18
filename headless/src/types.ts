import type { MatchState } from "../../server/src/match/types.js";

// ---- Observation ----

export interface GlobalFeatures {
  ownResources: number;            // normalised /1000
  ownSupply: number;               // fraction of maxSupply
  ownMaxSupply: number;            // absolute
  oppVisibleSupply: number;        // fraction (last seen, 0 if unknown)
  tick: number;                    // normalised /6000
  scoreDiff: number;               // own score - opp score
  ownCrystalHealthFrac: number;    // own crystal hp / max hp
  oppCrystalHealthFrac: number;    // opp crystal hp / max hp (0 if not visible)
  ownResourcesWinFrac: number;     // current held resources / passiveWinThreshold ∈ [0,1]
  oppResourcesWinFrac: number;     // (0 if not visible)
  ownLifetimeResourcesFrac: number; // lifetime gathered / (passiveWinThreshold*2) — for reward signal
  oppLifetimeResourcesFrac: number; // (0 if unknown)
  // Enemy unit composition (visible only) — enables adaptive counter-play
  enemyWorkerCount: number;        // visible enemy workers / 10
  enemySkirmisherCount: number;    // visible enemy skirmishers / 10
  enemyBruiserCount: number;       // visible enemy bruisers / 10
  enemyBarracksCount: number;      // visible enemy completed barracks / 4
  enemyTurretCount: number;        // visible enemy completed turrets / 4
  enemyForwardUnitFrac: number;    // fraction of visible enemy supply that is past midfield
  // Threat geometry (v0.1.57) — derived features for tactical awareness
  nearestEnemyToCrystalDistNorm: number; // dist from own crystal to nearest visible enemy / MAP.width
  ownCombatInOwnHalf: number;      // own combat units in own half / 10
  enemyCombatInOwnHalf: number;    // visible enemy combat in own half / 10
  totalVisibleEnemyCombat: number; // total visible enemy combat units / 10
}

export interface EntityFeature {
  id: string;
  typeIndex: number;          // one-hot index into ENTITY_TYPES
  owner: 1 | -1;              // 1=mine, -1=enemy
  xNorm: number;              // x / mapWidth
  yNorm: number;              // y / mapHeight
  healthFrac: number;         // health / maxHealth
  constructionFrac: number;   // 0-1 (buildings only, else 1)
  isAttacking: boolean;
  isMoving: boolean;
  isGathering: boolean;
  isBuilding: boolean;
  attackCooldownNorm: number;
  inAttackRange: boolean;     // v0.1.57: enemy within this unit's weapon range
}

export interface NodeFeature {
  id: string;
  xNorm: number;
  yNorm: number;
  remainingFrac: number;      // remaining / capacity
  gathererCount: number;      // 0-3
  isContested: boolean;
}

export interface PlayerObservation {
  global: GlobalFeatures;
  entities: EntityFeature[];
  nodes: NodeFeature[];
  playerId: string;
  tick: number;
}

// ---- Actions ----

export type MacroActionType =
  | "noop"
  | "train_worker"
  | "train_unit"
  | "build"
  | "attack_move"
  | "attack_targeted"
  | "hold_position"
  | "retreat"
  | "assign_workers"
  | "set_rally";

export interface MacroAction {
  type: MacroActionType;
  // train_unit
  unitType?: "skirmisher" | "gunner" | "bruiser" | "medic";
  // build
  buildingType?: "barracks" | "foundry" | "supply_depot" | "turret";
  xZone?: "near_crystal" | "mid_base" | "forward";
  yZone?: "top" | "middle" | "bottom";
  // attack_move / retreat / hold_position
  group?: "all_combat" | "skirmishers" | "gunners" | "bruisers" | "all_workers";
  targetZone?: "enemy_crystal" | "midfield" | "contested_node" | "enemy_army" | "defend_crystal";
  // attack_targeted
  targetType?: "nearest_threat" | "nearest_enemy" | "focus_weakest";
  // assign_workers
  nodeChoice?: "nearest_safe" | "nearest_contested" | "richest_visible";
  workerCount?: 1 | 2 | 3 | "all_idle";
}

// ---- Agent interface ----

export interface Agent {
  /** Called once at match start. */
  init(playerId: string, match: MatchState): void;
  /** Called every tick. Returns list of macro-actions to execute this tick (can be empty). */
  step(obs: PlayerObservation, legalActions: MacroAction[]): MacroAction[];
}

// ---- Match result ----

export interface MatchResult {
  winner: string | null;            // null = max-ticks draw
  winType: "combat" | "resource" | "timeout" | null;
  ticks: number;
  durationMs: number;
  commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }>;
  finalEntityCount: [number, number];  // [blueCount, redCount]
  seed: number;
}

// ---- Entity type index lookup ----

export const ENTITY_TYPES = [
  "crystal", "worker", "skirmisher", "gunner", "bruiser", "medic",
  "building_barracks", "building_foundry", "building_supply_depot", "building_turret",
] as const;

export type EntityTypeName = typeof ENTITY_TYPES[number];
