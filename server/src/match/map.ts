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

  // Spawn positions (near crystals)
  const blueSpawn: SpawnPosition = { x: 160, y: midY };
  const redSpawn: SpawnPosition = { x: mapWidth - 160, y: midY };

  // Crystal positions (far ends of each side)
  const blueCrystal: SpawnPosition = { x: 100, y: midY };
  const redCrystal: SpawnPosition = { x: mapWidth - 100, y: midY };

  // Worker spawn positions near each crystal
  const blueWorkers: SpawnPosition[] = [
    { x: 160, y: midY - 50 },
    { x: 160, y: midY + 50 },
    { x: 200, y: midY },
  ];

  const redWorkers: SpawnPosition[] = [
    { x: mapWidth - 160, y: midY - 50 },
    { x: mapWidth - 160, y: midY + 50 },
    { x: mapWidth - 200, y: midY },
  ];

  // Safe resource nodes near each base
  const blueSafeNodes: ResourceNodeLayout[] = [
    { x: 250, y: midY - 120, radius: 18, capacity: 300, type: "safe" },
    { x: 250, y: midY + 120, radius: 18, capacity: 300, type: "safe" },
  ];

  const redSafeNodes: ResourceNodeLayout[] = [
    { x: mapWidth - 250, y: midY - 120, radius: 18, capacity: 300, type: "safe" },
    { x: mapWidth - 250, y: midY + 120, radius: 18, capacity: 300, type: "safe" },
  ];

  // Contested resource nodes spread across the middle
  const contestedNodes: ResourceNodeLayout[] = [
    { x: midX - 400, y: midY - 80, radius: 22, capacity: 500, type: "contested" },
    { x: midX, y: midY, radius: 22, capacity: 500, type: "contested" },
    { x: midX + 400, y: midY + 80, radius: 22, capacity: 500, type: "contested" },
  ];

  // Build zones (per-player areas near base, 20% of map width each)
  const blueBuildZone: BuildZone = {
    playerId: "blue",
    x1: 0,
    y1: 0,
    x2: mapWidth * 0.2,
    y2: mapHeight,
  };

  const redBuildZone: BuildZone = {
    playerId: "red",
    x1: mapWidth * 0.8,
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
