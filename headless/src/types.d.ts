import type { MatchState } from "../../server/src/match/types.js";
export interface GlobalFeatures {
    ownResources: number;
    ownSupply: number;
    ownMaxSupply: number;
    oppVisibleSupply: number;
    tick: number;
    scoreDiff: number;
    ownCrystalHealthFrac: number;
    oppCrystalHealthFrac: number;
    ownResourcesWinFrac: number;
    oppResourcesWinFrac: number;
    ownLifetimeResourcesFrac: number;
    oppLifetimeResourcesFrac: number;
}
export interface EntityFeature {
    id: string;
    typeIndex: number;
    owner: 1 | -1;
    xNorm: number;
    yNorm: number;
    healthFrac: number;
    constructionFrac: number;
    isAttacking: boolean;
    isMoving: boolean;
    isGathering: boolean;
    isBuilding: boolean;
    attackCooldownNorm: number;
}
export interface NodeFeature {
    id: string;
    xNorm: number;
    yNorm: number;
    remainingFrac: number;
    gathererCount: number;
    isContested: boolean;
}
export interface PlayerObservation {
    global: GlobalFeatures;
    entities: EntityFeature[];
    nodes: NodeFeature[];
    playerId: string;
    tick: number;
}
export type MacroActionType = "noop" | "train_worker" | "train_unit" | "build" | "attack_move" | "retreat" | "assign_workers" | "set_rally";
export interface MacroAction {
    type: MacroActionType;
    unitType?: "skirmisher" | "gunner" | "bruiser" | "medic";
    buildingType?: "barracks" | "foundry" | "supply_depot" | "turret";
    xZone?: "near_crystal" | "mid_base" | "forward";
    yZone?: "top" | "middle" | "bottom";
    group?: "all_combat" | "skirmishers" | "gunners" | "bruisers" | "all_workers";
    targetZone?: "enemy_crystal" | "midfield" | "contested_node";
    nodeChoice?: "nearest_safe" | "nearest_contested" | "richest_visible";
    workerCount?: 1 | 2 | 3 | "all_idle";
}
export interface Agent {
    /** Called once at match start. */
    init(playerId: string, match: MatchState): void;
    /** Called every tick. Returns list of macro-actions to execute this tick (can be empty). */
    step(obs: PlayerObservation, legalActions: MacroAction[]): MacroAction[];
}
export interface MatchResult {
    winner: string | null;
    winType: "combat" | "resource" | "timeout" | null;
    ticks: number;
    durationMs: number;
    commandLog: Array<{
        tick: number;
        playerId: string;
        command: Record<string, unknown>;
    }>;
    finalEntityCount: [number, number];
    seed: number;
}
export declare const ENTITY_TYPES: readonly ["crystal", "worker", "skirmisher", "gunner", "bruiser", "medic", "building_barracks", "building_foundry", "building_supply_depot", "building_turret"];
export type EntityTypeName = typeof ENTITY_TYPES[number];
