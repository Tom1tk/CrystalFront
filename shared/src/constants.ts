/**
 * @deprecated This file re-exports everything from gameBalance.ts for backwards
 * compatibility. New code should import directly from "@crystalfront/shared/gameBalance".
 * All tunable values live in gameBalance.ts — edit there, not here.
 */

export {
  // Unit & Building definitions
  UNIT_DEFS,
  BUILDING_DEFS,
  BUILDING_ORDER,
  type UnitDef,
  type BuildingDef,

  // Economy
  ECONOMY,

  // Resource Nodes
  NODES,

  // Gathering
  GATHERING,

  // Map
  MAP,
  SPAWN,
  SAFE_NODE_OFFSETS,
  CONTESTED_NODE_OFFSETS,
  BUILD_ZONES,

  // Entity sizes
  ENTITY,

  // Simulation
  SIMULATION,

  // Placement
  PLACEMENT,

  // Healing
  HEALING,

  // Counters
  COUNTER_MODIFIER,
  COUNTER_MULTIPLIERS,

  // Legacy aliases
  STARTING_RESOURCES,
  STARTING_MAX_SUPPLY,
  WORKER_SUPPLY_COST,
  WORKER_TRAIN_COST,
  GATHER_RATE_PER_TICK,
  NODE_CAPACITY,
  SAFE_NODE_CAPACITY,
  NODE_MAX_GATHERER_SLOTS,
  REPAIR_COST_PER_HP,
  REPAIR_RATE_PER_TICK,
  HEAL_RATE_PER_TICK,
  BUILDING_MIN_SPACING,
  BUILDING_PLACEMENT_MIN_SPACING,
  CRYSTAL_NO_BUILD_RADIUS,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  VIEWPORT_WIDTH,
  VIEWPORT_HEIGHT,
  EDGE_SCROLL_THRESHOLD,
  EDGE_SCROLL_SPEED,

  // Lobby
  LOBBY_CODE_LENGTH,
  LOBBY_CODE_CHARS,
  MAX_PLAYERS_PER_LOBBY,
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_REGEX,
} from "./gameBalance.js";
