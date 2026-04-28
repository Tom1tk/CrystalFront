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
  },
  foundry: {
    cost: 100,
    buildTime: 200,
    health: 600,
    width: 44,
    height: 44,
    color: "#cc6644",
    produces: ["bruiser", "medic"],
  },
  supply_depot: {
    cost: 50,
    buildTime: 100,
    health: 300,
    width: 36,
    height: 36,
    color: "#88aa66",
    supplyProvided: 10,
  },
  turret: {
    cost: 60,
    buildTime: 120,
    health: 400,
    width: 30,
    height: 30,
    color: "#aa8844",
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
    produces?: string[];
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
  },
};

// ---- Counter Triangle ----
// skirmisher > gunner > bruiser > skirmisher

export const COUNTER_MODIFIER: Record<string, Record<string, number>> = {
  skirmisher: { gunner: 2.0 },
  gunner: { bruiser: 2.0 },
  bruiser: { skirmisher: 2.0 },
};

// ---- Repair ----

export const REPAIR_COST_PER_HP = 0.5;
export const REPAIR_RATE_PER_TICK = 2;

// ---- Building Placement ----

export const BUILDING_PLACEMENT_MIN_SPACING = 50;
export const CRYSTAL_NO_BUILD_RADIUS = 80;
