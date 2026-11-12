/**
 * Navigation grid (G-3).
 *
 * The map is divided into NAV.cellSize-px cells (5000×900 → 250×45). Each cell
 * records how many structures (buildings, crystals) overlap it; later phases add
 * static terrain. A cell is walkable when nothing blocks it.
 *
 * The grid is derived state: it can always be rebuilt from the entities
 * (`rebuildNavGrid`), so it is excluded from the state hash.
 */
import { NAV, BUILDING_DEFS } from "@crystalfront/shared";
import type { MatchEntity, MatchState } from "../types.js";
import { isObstacleCode, type Terrain } from "./terrain.js";

export interface NavGrid {
  cellSize: number;
  cols: number;
  rows: number;
  /** Number of structures overlapping each cell (row-major). Terrain obstacles
   *  (rock, cliff, water) count as one permanent structure (G-5). */
  structures: Uint8Array;
  /** Static terrain the grid was built on (read-only, shared). */
  terrain: Terrain | null;
  /** Bumped on every change, so path/flow-field caches can be invalidated (G-4). */
  version: number;
}

export interface Rect { x1: number; y1: number; x2: number; y2: number }

export function createNavGrid(mapWidth: number, mapHeight: number, terrain: Terrain | null = null): NavGrid {
  const cellSize = NAV.cellSize;
  const cols = Math.ceil(mapWidth / cellSize);
  const rows = Math.ceil(mapHeight / cellSize);
  const structures = new Uint8Array(cols * rows);
  if (terrain && terrain.cols === cols && terrain.rows === rows) {
    for (let i = 0; i < structures.length; i++) if (isObstacleCode(terrain.cells[i])) structures[i] = 1;
  }
  return { cellSize, cols, rows, structures, terrain, version: 0 };
}

export function cloneNavGrid(g: NavGrid): NavGrid {
  return { ...g, structures: new Uint8Array(g.structures) };
}

/** Solid footprint of a structure, or null for non-structures. */
export function footprintOf(e: Pick<MatchEntity, "type" | "x" | "y" | "radius" | "buildingType">): Rect | null {
  if (e.type === "building" && e.buildingType) {
    const def = BUILDING_DEFS[e.buildingType];
    return { x1: e.x - def.width / 2, y1: e.y - def.height / 2, x2: e.x + def.width / 2, y2: e.y + def.height / 2 };
  }
  if (e.type === "crystal") {
    return { x1: e.x - e.radius, y1: e.y - e.radius, x2: e.x + e.radius, y2: e.y + e.radius };
  }
  return null;
}

/** Inclusive cell range overlapped by a rect (open on the far edges). */
export function cellRange(g: NavGrid, r: Rect) {
  const c1 = Math.max(0, Math.floor(r.x1 / g.cellSize));
  const r1 = Math.max(0, Math.floor(r.y1 / g.cellSize));
  const c2 = Math.min(g.cols - 1, Math.ceil(r.x2 / g.cellSize) - 1);
  const r2 = Math.min(g.rows - 1, Math.ceil(r.y2 / g.cellSize) - 1);
  return { c1, r1, c2, r2 };
}

function stamp(g: NavGrid, r: Rect, delta: 1 | -1): void {
  const { c1, r1, c2, r2 } = cellRange(g, r);
  for (let row = r1; row <= r2; row++) {
    for (let col = c1; col <= c2; col++) {
      const i = row * g.cols + col;
      g.structures[i] = Math.max(0, g.structures[i] + delta);
    }
  }
  g.version++;
}

export function addStructure(g: NavGrid, e: MatchEntity): void {
  const r = footprintOf(e);
  if (r) stamp(g, r, 1);
}

export function removeStructure(g: NavGrid, e: MatchEntity): void {
  const r = footprintOf(e);
  if (r) stamp(g, r, -1);
}

export function rebuildNavGrid(match: MatchState): NavGrid {
  const g = createNavGrid(match.mapWidth, match.mapHeight, match.terrain);
  for (const e of match.entities.values()) addStructure(g, e);
  return g;
}

export function isCellBlocked(g: NavGrid, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return true;
  return g.structures[row * g.cols + col] > 0;
}

/**
 * True if every pair of `anchors` (crystal footprints) stays connected through
 * walkable cells after additionally blocking `extra`. 4-connected flood fill, so
 * diagonal squeezes between two corners don't count as a route.
 */
export function anchorsConnected(g: NavGrid, anchors: Rect[], extra?: Rect): boolean {
  if (anchors.length < 2) return true;
  // The answer depends only on the grid's structures (tracked by `version`), the
  // anchors and `extra`, so it is memoised per grid version (build-site masks ask
  // the same questions every decision).
  // Exact shortcut: if `extra` stays clear of every anchor's ring and the free cells
  // in its own 1-cell ring are one run around the ring, any path through it can go
  // round it instead, so blocking it changes nothing.
  if (extra && ringIsOneRun(g, extra) && !anchors.some((a) => ringsOverlap(g, a, extra))) return anchorsConnected(g, anchors);
  let memo = connectedMemo.get(g);
  if (!memo || memo.version !== g.version) { memo = { version: g.version, results: new Map() }; connectedMemo.set(g, memo); }
  const r2s = (r: Rect) => `${r.x1},${r.y1},${r.x2},${r.y2}`;
  const key = anchors.map(r2s).join(";") + "|" + (extra ? r2s(extra) : "");
  let res = memo.results.get(key);
  if (res === undefined) { res = floodConnected(g, anchors, extra); memo.results.set(key, res); }
  return res;
}

/** Does the cell range of `extra` touch the 1-cell ring (or footprint) of anchor `a`? */
function ringsOverlap(g: NavGrid, a: Rect, extra: Rect): boolean {
  const A = cellRange(g, a), E = cellRange(g, extra);
  return E.c1 <= A.c2 + 1 && E.c2 >= A.c1 - 1 && E.r1 <= A.r2 + 1 && E.r2 >= A.r1 - 1;
}

/** Are the walkable cells of the 1-cell ring around `r` (out-of-grid cells count as blocked) at most one cyclic run? */
function ringIsOneRun(g: NavGrid, r: Rect): boolean {
  const { c1, r1, c2, r2 } = cellRange(g, r);
  const cyc: number[] = [];
  for (let col = c1 - 1; col <= c2 + 1; col++) cyc.push(cellOrBlocked(g, col, r1 - 1));
  for (let row = r1; row <= r2; row++) cyc.push(cellOrBlocked(g, c2 + 1, row));
  for (let col = c2 + 1; col >= c1 - 1; col--) cyc.push(cellOrBlocked(g, col, r2 + 1));
  for (let row = r2; row >= r1; row--) cyc.push(cellOrBlocked(g, c1 - 1, row));
  let switches = 0;
  for (let i = 0; i < cyc.length; i++) if (cyc[i] !== cyc[(i + 1) % cyc.length]) switches++;
  return switches <= 2;
}

/** 1 if the cell is walkable (no structure, inside the grid), else 0. */
function cellOrBlocked(g: NavGrid, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return 0;
  return g.structures[row * g.cols + col] > 0 ? 0 : 1;
}

const connectedMemo = new WeakMap<NavGrid, { version: number; results: Map<string, boolean> }>();

export function floodConnected(g: NavGrid, anchors: Rect[], extra?: Rect): boolean {
  const blocked = new Uint8Array(g.structures.length);
  for (let i = 0; i < blocked.length; i++) blocked[i] = g.structures[i] > 0 ? 1 : 0;
  if (extra) {
    const { c1, r1, c2, r2 } = cellRange(g, extra);
    for (let row = r1; row <= r2; row++) for (let col = c1; col <= c2; col++) blocked[row * g.cols + col] = 1;
  }
  // Seeds/goals: walkable cells in the 1-cell ring around each anchor footprint.
  const ring = (r: Rect): number[] => {
    const { c1, r1, c2, r2 } = cellRange(g, r);
    const out: number[] = [];
    for (let row = r1 - 1; row <= r2 + 1; row++) {
      for (let col = c1 - 1; col <= c2 + 1; col++) {
        if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) continue;
        const i = row * g.cols + col;
        if (!blocked[i]) out.push(i);
      }
    }
    return out;
  };
  const seen = new Uint8Array(blocked.length);
  const queue: number[] = ring(anchors[0]);
  for (const i of queue) seen[i] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const col = i % g.cols;
    const row = (i - col) / g.cols;
    const nbrs = [
      col > 0 ? i - 1 : -1,
      col < g.cols - 1 ? i + 1 : -1,
      row > 0 ? i - g.cols : -1,
      row < g.rows - 1 ? i + g.cols : -1,
    ];
    for (const n of nbrs) {
      if (n < 0 || seen[n] || blocked[n]) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  for (let a = 1; a < anchors.length; a++) {
    if (!ring(anchors[a]).some((i) => seen[i])) return false;
  }
  return true;
}

/**
 * Push a mobile unit (circle) out of a solid rect along the shortest way out.
 * Returns true if the unit was moved.
 */
export function pushOutOfRect(u: { x: number; y: number; radius: number }, r: Rect): boolean {
  const cx = Math.max(r.x1, Math.min(u.x, r.x2));
  const cy = Math.max(r.y1, Math.min(u.y, r.y2));
  const dx = u.x - cx;
  const dy = u.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= u.radius * u.radius) return false;
  if (d2 > 0) {
    // Centre outside the rect but the circle overlaps an edge/corner.
    const d = Math.sqrt(d2);
    u.x = cx + (dx / d) * u.radius;
    u.y = cy + (dy / d) * u.radius;
    return true;
  }
  // Centre inside the rect: exit through the nearest side.
  const left = u.x - r.x1, right = r.x2 - u.x, top = u.y - r.y1, bottom = r.y2 - u.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) u.x = r.x1 - u.radius;
  else if (m === right) u.x = r.x2 + u.radius;
  else if (m === top) u.y = r.y1 - u.radius;
  else u.y = r.y2 + u.radius;
  return true;
}
