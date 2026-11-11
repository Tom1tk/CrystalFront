/**
 * Map registry (G-5, G-7). "classic" is the open map (no terrain). "testbed" is
 * the hand-authored U3 test map with every terrain type. Pool maps are frozen
 * generator output (pool/*.json, listed in pool/manifest.json with the user's
 * sign-off date) and are what the lobby offers.
 *
 * Spawn, safe-node and build-zone positions come from map.ts for every map;
 * a map def may set its own contested node positions.
 */
import { buildTerrain, type MapDef, type Terrain } from "./engine/terrain.js";
import { computeAnchors, type MapAnchors } from "./engine/anchors.js";
import { createMap } from "./map.js";
import type { MatchConfig } from "./types.js";
import { POOL_MAPS } from "./pool/index.js";
import manifest from "./pool/manifest.json" with { type: "json" };

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
for (const def of POOL_MAPS) MAPS[def.id] = def;

export interface PoolEntry {
  mapId: string;
  name: string;
  version: number;
  /** Date the user signed the map off, or null while it is a candidate. */
  approved: string | null;
}

/** Pool maps in manifest order (candidates included; the lobby labels them). */
export function poolMaps(): PoolEntry[] {
  return (manifest as PoolEntry[]).filter((m) => MAPS[m.mapId]).map(({ mapId, name, version, approved }) => ({ mapId, name, version, approved }));
}

/** Add or replace a map at runtime (offline tools only: candidates under test). */
export function registerMap(def: MapDef): void {
  MAPS[def.id] = def;
  for (const k of [...cache.keys()]) if (k.startsWith(`${def.id}:`)) cache.delete(k);
  for (const k of [...anchorCache.keys()]) if (k.startsWith(`${def.id}:`)) anchorCache.delete(k);
}

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

const anchorCache = new Map<string, MapAnchors>();

/** Named anchors for a map (T3), computed once per map and size. Maps without symmetry use the default mirror layout. */
export function anchorsFor(mapId: string | undefined, mapW: number, mapH: number): MapAnchors {
  const id = mapId && isKnownMap(mapId) ? mapId : DEFAULT_MAP_ID;
  const key = `${id}:${mapW}x${mapH}`;
  let a = anchorCache.get(key);
  if (!a) {
    const sym = mapSymmetry(id) === "rotate" ? "rotate" : "mirror";
    const layout = createMap({ mapWidth: mapW, mapHeight: mapH } as MatchConfig, contestedNodesFor(id, mapW, mapH), sym === "rotate");
    a = computeAnchors(terrainFor(id, mapW, mapH), layout, sym);
    anchorCache.set(key, a);
  }
  return a;
}

/** Symmetry of a map ("none" for unknown ids and asymmetric test maps). */
export function mapSymmetry(mapId: string | undefined): "mirror" | "rotate" | "none" {
  const def = mapId && isKnownMap(mapId) ? MAPS[mapId] : null;
  return def?.symmetry ?? "none";
}

/** Contested node positions for a map with its own node layout (symmetric images included), else undefined. */
export function contestedNodesFor(mapId: string | undefined, mapW: number, mapH: number): Array<{ x: number; y: number }> | undefined {
  const def = mapId && isKnownMap(mapId) ? MAPS[mapId] : null;
  if (!def?.nodes) return undefined;
  const out: Array<{ x: number; y: number }> = [];
  for (const [x, y] of def.nodes) {
    out.push({ x, y });
    const ix = mapW - x, iy = def.symmetry === "rotate" ? mapH - y : y;
    if (def.symmetry !== "none" && (ix !== x || iy !== y)) out.push({ x: ix, y: iy });
  }
  return out;
}
