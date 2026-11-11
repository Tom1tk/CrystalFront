/**
 * Static terrain (G-5 / G-6 / G-6b).
 *
 * A map's terrain is a grid of codes at nav-cell resolution (NAV.cellSize px),
 * rasterised once from the map definition's shapes and shared, read-only, by
 * every match on that map. It never changes during a match, so it is not part
 * of the state hash; the map id in the config identifies it.
 */
import { NAV } from "@crystalfront/shared";

export const T_OPEN = 0;
export const T_ROUGH = 1;
export const T_HIGH = 2;
export const T_BRUSH = 3;
export const T_ROCK = 4;
export const T_CLIFF = 5;
export const T_WATER = 6;

export type TerrainKind = "open" | "rough" | "high" | "brush" | "rock" | "cliff" | "water";
const KIND_CODE: Record<TerrainKind, number> = {
  open: T_OPEN, rough: T_ROUGH, high: T_HIGH, brush: T_BRUSH, rock: T_ROCK, cliff: T_CLIFF, water: T_WATER,
};

/** Rock, cliff and water: blocked for movement and building. */
export const isObstacleCode = (c: number) => c >= T_ROCK;
/** Rock and cliff block line of sight; water does not. */
export const blocksSightCode = (c: number) => c === T_ROCK || c === T_CLIFF;

export type TerrainShape =
  | { kind: TerrainKind; rect: [number, number, number, number] }   // x1, y1, x2, y2 (px)
  | { kind: TerrainKind; circle: [number, number, number] };        // cx, cy, r (px)

export interface MapDef {
  id: string;
  name: string;
  version: number;
  /**
   * "mirror": shapes are also reflected left↔right; "rotate": also rotated 180°
   * about the map centre. Shapes normally describe the left half.
   */
  symmetry: "mirror" | "rotate" | "none";
  /** Later shapes win; "open" carves earlier shapes away. */
  shapes: TerrainShape[];
  /**
   * Contested node positions (px), left half; each is also placed at its
   * symmetric image (once only, for a node on the centre). Absent: the default
   * layout from CONTESTED_NODE_OFFSETS.
   */
  nodes?: Array<[number, number]>;
}

export interface Terrain {
  mapId: string;
  mapVersion: number;
  cellSize: number;
  cols: number;
  rows: number;
  /** Terrain code per nav cell (row-major). */
  cells: Uint8Array;
  /** Brush patch id per nav cell (0 = not brush). 4-connected components. */
  brushPatch: Int32Array;
  /** True if any cell is non-open (lets hot paths skip terrain work on plain maps). */
  any: boolean;
  /** The map is symmetric under a 180° rotation (else a left-right mirror); pathfinding tie-breaks need it. */
  rotate: boolean;
}

/** Copy of a shape under the map's symmetry transform. */
function imageOf(s: TerrainShape, sym: "mirror" | "rotate", mapW: number, mapH: number): TerrainShape {
  if ("rect" in s) {
    const [x1, y1, x2, y2] = s.rect;
    return sym === "mirror"
      ? { kind: s.kind, rect: [mapW - x2, y1, mapW - x1, y2] }
      : { kind: s.kind, rect: [mapW - x2, mapH - y2, mapW - x1, mapH - y1] };
  }
  const [cx, cy, r] = s.circle;
  return { kind: s.kind, circle: [mapW - cx, sym === "mirror" ? cy : mapH - cy, r] };
}

/** Rasterise a map definition (cell centres tested against shapes; later shapes win, each with its image). */
export function buildTerrain(def: MapDef | null, mapW: number, mapH: number): Terrain {
  const cellSize = NAV.cellSize;
  const cols = Math.ceil(mapW / cellSize);
  const rows = Math.ceil(mapH / cellSize);
  const cells = new Uint8Array(cols * rows);
  if (def) {
    for (const s of def.shapes) {
      paint(cells, cols, rows, cellSize, s);
      if (def.symmetry !== "none") paint(cells, cols, rows, cellSize, imageOf(s, def.symmetry, mapW, mapH));
    }
  }
  return finishTerrain(def?.id ?? "classic", def?.version ?? 1, cellSize, cols, rows, cells, def?.symmetry === "rotate");
}

function paint(cells: Uint8Array, cols: number, rows: number, cs: number, s: TerrainShape): void {
  const code = KIND_CODE[s.kind];
  const [bx1, by1, bx2, by2] = "rect" in s
    ? s.rect
    : [s.circle[0] - s.circle[2], s.circle[1] - s.circle[2], s.circle[0] + s.circle[2], s.circle[1] + s.circle[2]];
  // Cells whose centre (c + 0.5) * cs can lie in [b1, b2].
  const c1 = Math.max(0, Math.ceil(bx1 / cs - 0.5)), c2 = Math.min(cols - 1, Math.floor(bx2 / cs - 0.5));
  const r1 = Math.max(0, Math.ceil(by1 / cs - 0.5)), r2 = Math.min(rows - 1, Math.floor(by2 / cs - 0.5));
  for (let row = r1; row <= r2; row++) {
    const y = (row + 0.5) * cs;
    for (let col = c1; col <= c2; col++) {
      const x = (col + 0.5) * cs;
      if ("circle" in s) {
        const dx = x - s.circle[0], dy = y - s.circle[1];
        if (dx * dx + dy * dy > s.circle[2] * s.circle[2]) continue;
      }
      cells[row * cols + col] = code;
    }
  }
}

function finishTerrain(mapId: string, mapVersion: number, cellSize: number, cols: number, rows: number, cells: Uint8Array, rotate: boolean): Terrain {
  const brushPatch = new Int32Array(cols * rows);
  let next = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== T_BRUSH || brushPatch[i]) continue;
    const id = ++next;
    const stack = [i];
    brushPatch[i] = id;
    while (stack.length) {
      const c = stack.pop()!;
      const col = c % cols, row = (c - col) / cols;
      const nb = [col > 0 ? c - 1 : -1, col < cols - 1 ? c + 1 : -1, row > 0 ? c - cols : -1, row < rows - 1 ? c + cols : -1];
      for (const n of nb) {
        if (n >= 0 && cells[n] === T_BRUSH && !brushPatch[n]) { brushPatch[n] = id; stack.push(n); }
      }
    }
  }
  let any = false;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== T_OPEN) { any = true; break; }
  return { mapId, mapVersion, cellSize, cols, rows, cells, brushPatch, any, rotate };
}

/** Left-right reflection (used by the mirror-invariance harness). */
export function mirrorTerrain(t: Terrain): Terrain {
  const cells = new Uint8Array(t.cells.length);
  for (let row = 0; row < t.rows; row++) {
    for (let col = 0; col < t.cols; col++) {
      cells[row * t.cols + col] = t.cells[row * t.cols + (t.cols - 1 - col)];
    }
  }
  return finishTerrain(t.mapId, t.mapVersion, t.cellSize, t.cols, t.rows, cells, t.rotate);
}

/** Nav cell index of a point (boundary points go toward the map's centre line, mirror-safe). */
export function terrainCellOf(t: Terrain, x: number, y: number): number {
  const fx = x / t.cellSize;
  const colRaw = fx < t.cols / 2 ? Math.floor(fx) : Math.ceil(fx) - 1;
  const col = Math.min(t.cols - 1, Math.max(0, colRaw));
  const row = Math.min(t.rows - 1, Math.max(0, Math.floor(y / t.cellSize)));
  return row * t.cols + col;
}

export function terrainAt(t: Terrain, x: number, y: number): number {
  return t.cells[terrainCellOf(t, x, y)];
}

/** Does the rect (px) overlap any cell matching pred? Same cell range as nav-grid stamping. */
export function rectTouches(t: Terrain, x1: number, y1: number, x2: number, y2: number, pred: (code: number) => boolean): boolean {
  const c1 = Math.max(0, Math.floor(x1 / t.cellSize));
  const r1 = Math.max(0, Math.floor(y1 / t.cellSize));
  const c2 = Math.min(t.cols - 1, Math.ceil(x2 / t.cellSize) - 1);
  const r2 = Math.min(t.rows - 1, Math.ceil(y2 / t.cellSize) - 1);
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (pred(t.cells[r * t.cols + c])) return true;
  return false;
}

/** Run-length encoding of the cell codes for the client: "code:count,code:count,…". */
export function encodeTerrain(t: Terrain): string {
  const out: string[] = [];
  let prev = t.cells[0], run = 0;
  for (let i = 0; i < t.cells.length; i++) {
    if (t.cells[i] === prev) { run++; continue; }
    out.push(`${prev}:${run}`);
    prev = t.cells[i]; run = 1;
  }
  out.push(`${prev}:${run}`);
  return out.join(",");
}
