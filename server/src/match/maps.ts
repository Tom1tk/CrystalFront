/**
 * Map registry (G-5). "classic" is the open map (no terrain). "testbed" is the
 * hand-authored U3 test map with every terrain type; the U4 generator and map
 * pool add entries here.
 *
 * Node, spawn and build-zone positions still come from map.ts for every map.
 */
import { buildTerrain, type MapDef, type Terrain } from "./engine/terrain.js";

export const DEFAULT_MAP_ID = "classic";

/**
 * Left half only (mirrored). Reference points on the 5000×900 map:
 * crystal (100,450); safe nodes x 230–280; build zone x ≤ 1000;
 * contested nodes (2150,330) (2320,390) (2500,450).
 */
const TESTBED: MapDef = {
  id: "testbed",
  name: "Testbed",
  version: 1,
  symmetry: "mirror",
  shapes: [
    // Rock outcrop north-west of the middle: blocks movement and sight.
    { kind: "rock", rect: [1300, 160, 1400, 340] },
    { kind: "rock", circle: [1700, 420, 45] },
    // High-ground plateau in the south with a western ramp (gap in the cliff).
    { kind: "high", rect: [1480, 580, 1820, 900] },
    { kind: "cliff", rect: [1480, 580, 1820, 600] },
    { kind: "cliff", rect: [1480, 600, 1500, 700] },
    { kind: "cliff", rect: [1480, 780, 1500, 900] },
    { kind: "cliff", rect: [1800, 600, 1820, 900] },
    // River: can be seen across, not walked across; crossing in the middle.
    { kind: "water", rect: [1950, 0, 2010, 260] },
    { kind: "water", rect: [1950, 620, 2010, 900] },
    // Mud field south of the contested nodes.
    { kind: "rough", rect: [2200, 520, 2400, 720] },
    { kind: "rough", rect: [1050, 420, 1200, 560] },
    // Brush: small ambush patches on routes, ≥200 px from nodes.
    { kind: "brush", rect: [1550, 120, 1650, 200] },
    { kind: "brush", rect: [2250, 780, 2330, 860] },
  ],
};

const MAPS: Record<string, MapDef | null> = {
  classic: null,
  testbed: TESTBED,
};

export function mapIds(): string[] {
  return Object.keys(MAPS);
}

export function isKnownMap(id: string): boolean {
  return id in MAPS;
}

const cache = new Map<string, Terrain>();

/** Terrain for a map id (unknown ids fall back to classic). Shared and read-only. */
export function terrainFor(mapId: string | undefined, mapW: number, mapH: number): Terrain {
  const id = mapId && isKnownMap(mapId) ? mapId : DEFAULT_MAP_ID;
  const key = `${id}:${mapW}x${mapH}`;
  let t = cache.get(key);
  if (!t) {
    t = buildTerrain(MAPS[id], mapW, mapH);
    cache.set(key, t);
  }
  return t;
}
