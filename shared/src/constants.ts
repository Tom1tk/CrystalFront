export const LOBBY_CODE_LENGTH = 6;
export const LOBBY_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const MAX_PLAYERS_PER_LOBBY = 2;
export const USERNAME_MIN_LENGTH = 1;
export const USERNAME_MAX_LENGTH = 20;
export const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// ---- Economy Constants ----

export const STARTING_RESOURCES = 50;
export const STARTING_MAX_SUPPLY = 10;
export const WORKER_SUPPLY_COST = 1;
export const WORKER_TRAIN_COST = 25;
export const GATHER_RATE_PER_TICK = 1;
export const NODE_CAPACITY = 500;
export const SAFE_NODE_CAPACITY = 300;
export const NODE_MAX_GATHERER_SLOTS = 3;

// ---- Building Definitions ----

export const BUILDING_DEFS: Record<
  string,
  {
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
    visionRange?: number;
  }
> = {
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

export const BUILDING_ORDER = ["barracks", "foundry", "supply_depot", "turret"] as const;

// ---- Unit Definitions ----

export const UNIT_DEFS: Record<
  string,
  {
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
    produces?: string[];
    visionRange?: number;
  }
> = {
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
    visionRange: 225,
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

// ---- Counter Triangle ----
// skirmisher > gunner > bruiser > skirmisher

export const COUNTER_MODIFIER: Record<string, Record<string, number>> = {
  skirmisher: { gunner: 2.0, bruiser: 0.5, worker: 1.0, medic: 1.0 },
  gunner: { bruiser: 2.0, skirmisher: 0.5, worker: 1.0, medic: 1.0 },
  bruiser: { skirmisher: 2.0, gunner: 0.5, worker: 1.0, medic: 1.0 },
  medic: { worker: 1.0, skirmisher: 1.0, gunner: 1.0, bruiser: 1.0 },
  worker: { worker: 1.0, skirmisher: 1.0, gunner: 1.0, bruiser: 1.0, medic: 1.0 },
};

export const COUNTER_MULTIPLIERS = COUNTER_MODIFIER;

// ---- Repair ----

export const REPAIR_COST_PER_HP = 0.5;
export const REPAIR_RATE_PER_TICK = 2;
export const HEAL_RATE_PER_TICK = 2;

// ---- Building Placement ----

export const BUILDING_PLACEMENT_MIN_SPACING = 50;
export const BUILDING_MIN_SPACING = BUILDING_PLACEMENT_MIN_SPACING;
export const CRYSTAL_NO_BUILD_RADIUS = 80;

// ---- World / Camera Constants ----

export const WORLD_WIDTH = 3000;
export const WORLD_HEIGHT = 600;
export const VIEWPORT_WIDTH = 960;
export const VIEWPORT_HEIGHT = 540;
export const EDGE_SCROLL_THRESHOLD = 50;
export const EDGE_SCROLL_SPEED = 3;
