/**
 * ============================================================================
 *  GAME BALANCE CONFIGURATION
 * ============================================================================
 *
 *  All tunable game-balance values live here. Change a number, rebuild, deploy.
 *
 *  ── Quick reference ────────────────────────────────────────────────
 *  Unit stats       → UNIT_DEFS          (cost, hp, atk, speed, range…)
 *  Building stats   → BUILDING_DEFS      (cost, hp, damage, vision…)
 *  Economy          → ECONOMY            (resources, supply, gather…)
 *  Map dimensions   → MAP                (width, height, viewport…)
 *  Node layout      → NODES              (capacities, gatherer slots…)
 *  Simulation       → SIMULATION         (tick rate, sub-steps, regen…)
 *  Placement        → PLACEMENT          (spacing, exclusion zones…)
 *  Healing          → HEALING            (repair, medic heal rates…)
 *  Counters         → COUNTER_MODIFIER   (rock-paper-scissors multipliers)
 * ============================================================================
 */

// ====================================================================
//  UNIT DEFINITIONS
// ====================================================================

export interface UnitDef {
  cost: number;
  supplyCost: number;
  buildTime: number;       // ticks to produce
  health: number;
  radius: number;
  damage: number;
  range: number;
  speed: number;           // pixels per sub-step
  color: string;
  attackCooldown: number;  // ticks between attacks
  visionRange?: number;
}

export const UNIT_DEFS: Record<string, UnitDef> = {
  worker: {
    cost: 50,          // was 25 — expensive enough to discourage idle spam
    supplyCost: 1,
    buildTime: 80,
    health: 100,
    radius: 10,
    damage: 5,
    range: 15,
    speed: 1.7,        // was 2 — 15% slower, workers matter more per unit
    color: "#aabbcc",
    attackCooldown: 20,
    visionRange: 225,
  },
  skirmisher: {
    cost: 50,
    supplyCost: 1,
    buildTime: 100,
    health: 120,
    radius: 12,
    damage: 12,        // was 15 — 20% less damage, faster but less punch
    range: 20,
    speed: 3.0,        // was 2.5 — 20% faster, skirmishers are now raiders
    color: "#44dd88",
    attackCooldown: 10,
    visionRange: 300,
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
    visionRange: 270,
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
    visionRange: 195,
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
    visionRange: 210,
  },
};

// ====================================================================
//  BUILDING DEFINITIONS
// ====================================================================

export interface BuildingDef {
  cost: number;
  buildTime: number;       // ticks to construct
  health: number;
  width: number;
  height: number;
  color: string;
  supplyProvided?: number;
  produces?: string[];
  damage?: number;
  range?: number;
  attackCooldown?: number;
  visionRange?: number;
}

export const BUILDING_DEFS: Record<string, BuildingDef> = {
  barracks: {
    cost: 75,
    buildTime: 150,
    health: 500,
    width: 40,
    height: 40,
    color: "#4488cc",
    produces: ["skirmisher", "gunner"],
    visionRange: 180,
  },
  foundry: {
    cost: 100,
    buildTime: 200,
    health: 600,
    width: 44,
    height: 44,
    color: "#cc6644",
    produces: ["bruiser", "medic"],
    visionRange: 180,
  },
  supply_depot: {
    cost: 50,
    buildTime: 100,
    health: 300,
    width: 36,
    height: 36,
    color: "#88aa66",
    supplyProvided: 3,
    visionRange: 150,
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
    visionRange: 225,
  },
};

export const BUILDING_ORDER: string[] = ["barracks", "foundry", "supply_depot", "turret"];

// ====================================================================
//  ECONOMY
// ====================================================================

export const ECONOMY = {
  startingResources: 50,
  startingMaxSupply: 10,
  workerTrainCost: 50,          // must match UNIT_DEFS.worker.cost
  workerSupplyCost: 1,
  passiveWinThreshold: 3000,   // current held resources = win (turtling win condition)
} as const;

// ====================================================================
//  RESOURCE NODES
// ====================================================================

export const NODES = {
  contestedCapacity: 300,
  safeCapacity: 100,
  maxGathererSlots: 3,
  regenPerTick: 0.2,        // passive refill rate (resources per tick)
} as const;

// ====================================================================
//  GATHERING
// ====================================================================

export const GATHERING = {
  range: 60,                // pixels — worker must be within to gather
  ratePerTick: 1,           // total gather pool per tick, split across workers
  perWorkerDivisor: 3,      // ratePerTick / divisor = per-worker rate (~0.33/tick)
} as const;

// ====================================================================
//  MAP
// ====================================================================

export const MAP = {
  width: 6000,
  height: 600,
  viewportWidth: 960,
  viewportHeight: 540,
} as const;

// ── Spawn positions (relative to map edges) ──────────────────────
export const SPAWN = {
  blueCrystal: { x: 100, yPct: 0.5 },     // yPct = fraction of mapHeight
  redCrystal: { xPct: 1, offset: 100, yPct: 0.5 },
  blueWorkers: [
    { x: 160, yPct: 0.5, yOff: -50 },
    { x: 160, yPct: 0.5, yOff: 50 },
    { x: 200, yPct: 0.5, yOff: 0 },
  ],
  redWorkerXOffsets: [160, 160, 200],    // subtracted from mapWidth
  redWorkerYOffsets: [-50, 50, 0],       // added to midY
} as const;

// ── Safe node offsets from blue base ─────────────────────────────
//    Red safe nodes are auto-mirrored.  yPct is fraction of mapHeight.
//    To move nodes, edit dx/dy offsets below.
export const SAFE_NODE_OFFSETS = [
  { dx: 230, dy: -200, radius: 18 },
  { dx: 280, dy: -100, radius: 18 },
  { dx: 230, dy: 100,  radius: 18 },
  { dx: 280, dy: 200,  radius: 18 },
] as const;

// ── Contested node offsets from map center ───────────────────────
// Nodes at ±dx share the same dy so the map is horizontally symmetric.
export const CONTESTED_NODE_OFFSETS = [
  { dx: -350, dy: -120, radius: 22 },
  { dx: -180, dy: -60,  radius: 22 },
  { dx: 0,    dy: 0,    radius: 22 },
  { dx: 180,  dy: -60,  radius: 22 },
  { dx: 350,  dy: -120, radius: 22 },
] as const;

// ── Build zones (fraction of map width) ──────────────────────────
export const BUILD_ZONES = {
  blueEndPct: 0.2,    // blue can build in 0..20% of map width
  redStartPct: 0.8,   // red can build in 80..100% of map width
} as const;

// ====================================================================
//  ENTITY SIZES
// ====================================================================

export const ENTITY = {
  crystal: { health: 1000, radius: 30 },
  worker:  { health: 100,  radius: 10 },
  placeholder: { health: 500, radius: 15 },
} as const;

// ====================================================================
//  SIMULATION
// ====================================================================

export const SIMULATION = {
  tickIntervalMs: 100,     // ms per game tick (10 Hz)
  subStepMs: 20,            // ms per movement sub-step within a tick
  arrivalThreshold: 1,      // pixels — unit stops moving when this close
  spatialCellSize: 50,      // collision grid cell size in pixels
  spawnGap: 4,              // pixels gap between parent and spawned child
  attackLogRetention: 15,   // ticks to keep attack events
  crystalVisionRange: 225,  // crystal vision for fog of war
  defaultVisionRange: 100,  // fallback vision when unit/building has none
} as const;

// ====================================================================
//  PLACEMENT RULES
// ====================================================================

export const PLACEMENT = {
  minSpacing: 50,                   // minimum distance between buildings
  crystalNoBuildRadius: 80,         // no buildings within this radius of crystal
  centerExclusionHalfWidth: 200,    // no building within ±200px of map center
} as const;

// ====================================================================
//  HEALING & REPAIR
// ====================================================================

export const HEALING = {
  repairHpPerTick: 2,       // HP restored per tick when repairing
  repairCostPerHp: 0.5,     // resources cost per HP repaired
  healRatePerTick: 2,        // HP restored per tick by medic
} as const;

// ====================================================================
//  COUNTER MODIFIERS (Rock-Paper-Scissors)
//  skirmisher > gunner > bruiser > skirmisher
// ====================================================================

export const COUNTER_MODIFIER: Record<string, Record<string, number>> = {
  skirmisher: { gunner: 2.0, bruiser: 0.5, worker: 1.0, medic: 1.0 },
  gunner:     { bruiser: 2.0, skirmisher: 0.5, worker: 1.0, medic: 1.0 },
  bruiser:    { skirmisher: 2.0, gunner: 0.5, worker: 1.0, medic: 1.0 },
  medic:      { worker: 1.0, skirmisher: 1.0, gunner: 1.0, bruiser: 1.0 },
  worker:     { worker: 1.0, skirmisher: 1.0, gunner: 1.0, bruiser: 1.0, medic: 1.0 },
};

// Legacy alias — keep for backwards compatibility
export const COUNTER_MULTIPLIERS = COUNTER_MODIFIER;

// ====================================================================
//  LOBBY & NETWORK (non-balance, but grouped for completeness)
// ====================================================================

export const LOBBY_CODE_LENGTH = 6;
export const LOBBY_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const MAX_PLAYERS_PER_LOBBY = 2;
export const USERNAME_MIN_LENGTH = 1;
export const USERNAME_MAX_LENGTH = 20;
export const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// Use the named exports above directly (ECONOMY, GATHERING, NODES, HEALING, PLACEMENT, MAP).
