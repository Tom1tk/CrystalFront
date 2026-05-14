import type { MatchConfig } from "./types.js";
import { MAP, SPAWN, SAFE_NODE_OFFSETS, CONTESTED_NODE_OFFSETS, BUILD_ZONES, NODES } from "@crystalfront/shared";

export interface SpawnPosition {
  x: number;
  y: number;
}

export interface ResourceNodeLayout {
  x: number;
  y: number;
  radius: number;
  capacity: number;
  type: "safe" | "contested";
}

export interface BuildZone {
  playerId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LaneCorridor {
  top: number;
  bottom: number;
}

export interface MapLayout {
  width: number;
  height: number;
  blueSpawn: SpawnPosition;
  redSpawn: SpawnPosition;
  blueCrystal: SpawnPosition;
  redCrystal: SpawnPosition;
  blueWorkers: SpawnPosition[];
  redWorkers: SpawnPosition[];
  blueSafeNodes: ResourceNodeLayout[];
  redSafeNodes: ResourceNodeLayout[];
  contestedNodes: ResourceNodeLayout[];
  blueBuildZone: BuildZone;
  redBuildZone: BuildZone;
  laneCorridor: LaneCorridor;
  combatZoneTop: number;
  combatZoneBottom: number;
}

/** Mirror blue safe nodes onto red side (pixel-perfect horizontal flip around map center) */
export function mirrorBlueToRed(map: MapLayout): void {
  const midX = map.width / 2;
  // Ensure red has same count as blue, mirroring each blue node
  const mirrored: ResourceNodeLayout[] = map.blueSafeNodes.map((bn) => ({
    x: map.width - bn.x,
    y: bn.y,
    radius: bn.radius,
    capacity: bn.capacity,
    type: "safe",
  }));
  // Sort by y to keep consistent ordering
  mirrored.sort((a, b) => a.y - b.y);
  map.redSafeNodes = mirrored;
}

export function createMap(config: MatchConfig): MapLayout {
  const mapWidth = config.mapWidth;
  const mapHeight = config.mapHeight;
  const midY = mapHeight / 2;
  const midX = mapWidth / 2;

  // Spawn positions (near crystals)
  const blueSpawn: SpawnPosition = { x: SPAWN.blueCrystal.x, y: midY };
  const redSpawn: SpawnPosition = { x: mapWidth - SPAWN.redCrystal.offset, y: midY };

  // Crystal positions (far ends of each side)
  const blueCrystal: SpawnPosition = { x: SPAWN.blueCrystal.x - 0, y: midY };
  const redCrystal: SpawnPosition = { x: mapWidth - SPAWN.redCrystal.offset - 0, y: midY };

  // Worker spawn positions near each crystal
  const blueWorkers: SpawnPosition[] = SPAWN.blueWorkers.map((w) => ({
    x: w.x,
    y: midY + w.yOff,
  }));

  const redWorkers: SpawnPosition[] = SPAWN.redWorkerXOffsets.map((ox, i) => ({
    x: mapWidth - ox,
    y: midY + SPAWN.redWorkerYOffsets[i],
  }));

  // Safe resource nodes near each base (4 per side) — edit SAFE_NODE_OFFSETS in gameBalance.ts
  const blueSafeNodes: ResourceNodeLayout[] = SAFE_NODE_OFFSETS.map((n: { dx: number; dy: number; radius: number }) => ({
    x: n.dx,
    y: midY + n.dy,
    radius: n.radius,
    capacity: NODES.safeCapacity,
    type: "safe",
  }));

  const redSafeNodes: ResourceNodeLayout[] = SAFE_NODE_OFFSETS.map((n: { dx: number; dy: number; radius: number }) => ({
    x: mapWidth - n.dx,
    y: midY + n.dy,
    radius: n.radius,
    capacity: NODES.safeCapacity,
    type: "safe",
  }));

  // Contested resource nodes — edit CONTESTED_NODE_OFFSETS in gameBalance.ts
  const contestedNodes: ResourceNodeLayout[] = CONTESTED_NODE_OFFSETS.map((n: { dx: number; dy: number; radius: number }) => ({
    x: midX + n.dx,
    y: midY + n.dy,
    radius: n.radius,
    capacity: NODES.contestedCapacity,
    type: "contested",
  }));

  // Build zones (per-player areas near base) — edit BUILD_ZONES in gameBalance.ts
  const blueBuildZone: BuildZone = {
    playerId: "blue",
    x1: 0,
    y1: 0,
    x2: mapWidth * BUILD_ZONES.blueEndPct,
    y2: mapHeight,
  };

  const redBuildZone: BuildZone = {
    playerId: "red",
    x1: mapWidth * BUILD_ZONES.redStartPct,
    y1: 0,
    x2: mapWidth,
    y2: mapHeight,
  };

  // Lane corridor (non-buildable)
  const laneTop = mapHeight * 0.2;
  const laneBottom = mapHeight * 0.8;

  // Combat zone (wider middle)
  const combatZoneTop = mapHeight * 0.3;
  const combatZoneBottom = mapHeight * 0.7;

  return {
    width: mapWidth,
    height: mapHeight,
    blueSpawn,
    redSpawn,
    blueCrystal,
    redCrystal,
    blueWorkers,
    redWorkers,
    blueSafeNodes,
    redSafeNodes,
    contestedNodes,
    blueBuildZone,
    redBuildZone,
    laneCorridor: { top: laneTop, bottom: laneBottom },
    combatZoneTop,
    combatZoneBottom,
  };
}
