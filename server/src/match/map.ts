import type { MatchConfig } from "./types.js";

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

export function createMap(config: MatchConfig): MapLayout {
  const { mapWidth, mapHeight } = config;
  const midY = mapHeight / 2;
  const midX = mapWidth / 2;

  // Spawn positions
  const blueSpawn: SpawnPosition = { x: 80, y: midY };
  const redSpawn: SpawnPosition = { x: mapWidth - 80, y: midY };

  // Crystal positions
  const blueCrystal: SpawnPosition = { x: 120, y: midY };
  const redCrystal: SpawnPosition = { x: mapWidth - 120, y: midY };

  // Worker spawn positions
  const blueWorkers: SpawnPosition[] = [
    { x: 60, y: midY - 50 },
    { x: 60, y: midY + 50 },
    { x: 100, y: midY },
  ];

  const redWorkers: SpawnPosition[] = [
    { x: mapWidth - 60, y: midY - 50 },
    { x: mapWidth - 60, y: midY + 50 },
    { x: mapWidth - 100, y: midY },
  ];

  // Safe resource nodes near each base
  const blueSafeNodes: ResourceNodeLayout[] = [
    { x: 60, y: midY - 120, radius: 18, capacity: 300, type: "safe" },
    { x: 60, y: midY + 120, radius: 18, capacity: 300, type: "safe" },
  ];

  const redSafeNodes: ResourceNodeLayout[] = [
    { x: mapWidth - 60, y: midY - 120, radius: 18, capacity: 300, type: "safe" },
    { x: mapWidth - 60, y: midY + 120, radius: 18, capacity: 300, type: "safe" },
  ];

  // Contested resource nodes near middle
  const contestedNodes: ResourceNodeLayout[] = [
    { x: midX - 60, y: midY - 80, radius: 22, capacity: 500, type: "contested" },
    { x: midX + 60, y: midY + 80, radius: 22, capacity: 500, type: "contested" },
  ];

  // Build zones (per-player areas near base)
  const blueBuildZone: BuildZone = {
    playerId: "blue",
    x1: 0,
    y1: 0,
    x2: mapWidth * 0.3,
    y2: mapHeight,
  };

  const redBuildZone: BuildZone = {
    playerId: "red",
    x1: mapWidth * 0.7,
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
