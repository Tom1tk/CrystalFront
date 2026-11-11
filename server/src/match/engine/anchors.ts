/**
 * Named map anchors (G-10 M0 T3, P-1).
 *
 * Fixed, named places on a map that the v2 action and observation spaces refer
 * to: each seat's base, open build pockets near it, open areas near the centre,
 * the resource nodes, and the chokes on the way out. They are derived from the
 * static nav grid (terrain + crystals), so generated maps get them for free.
 *
 * Seat 0 (blue, left) is computed; seat 1's anchors are the exact symmetric
 * images (mirror: x → W − x; rotate: also y → H − y). Shared anchors (centre,
 * nodes) are stored once, in seat 0's order; `seatAnchors` gives each seat its
 * own-frame order (seat 1's list is the image of seat 0's, item by item).
 */
import { ENTITY, PLACEMENT } from "@crystalfront/shared";
import type { MapLayout } from "../map.js";
import { createNavGrid, cellRange, type NavGrid } from "./navGrid.js";
import { cellOf, flowField, descendField } from "./pathfinding.js";
import { T_BRUSH, type Terrain } from "./terrain.js";

export interface Pt { x: number; y: number }

export interface MapAnchors {
  symmetry: "mirror" | "rotate";
  /** Per seat: just outside the crystal's no-build ring, toward the centre. */
  base: [Pt, Pt];
  /** Per seat: open build areas near the base, one per distance band (≤3). */
  pockets: [Pt[], Pt[]];
  /** Open areas near the map centre (≤3), seat 0's order. */
  centre: Pt[];
  /** Every contested node, seat 0's order. */
  nodes: Pt[];
  safeNodes: [Pt[], Pt[]];
  /** Per seat: narrowest points on base→centre paths, nearest the base first (≤3). */
  chokes: [Pt[], Pt[]];
}

export const ANCHOR_MAX = { pockets: 3, centre: 3, chokes: 3, nodes: 12, safeNodes: 4 } as const;

/** Pocket distance bands (path px from the base anchor). */
const POCKET_BANDS: Array<[number, number]> = [[150, 450], [450, 800], [800, 1200]];
/** A pocket's cell must have this many rings of buildable cells around it (3 → a 100 px square). */
const POCKET_CLEARANCE = 3;
const POCKET_MIN_GAP = 200;
/** Clearance values above this count as equal, so the nearer cell wins. */
const CLEARANCE_CAP = 6;
/** Side open areas near the centre: this far (px) left of the centre line. */
const CENTRE_BAND: [number, number] = [300, 700];
/** A choke is a path cell whose cross-section across the path is at most this wide (px). */
const CHOKE_MAX_WIDTH = 320;
/** Chokes closer than this (path px) to the base are part of the base. */
const CHOKE_MIN_DIST = 300;
const CHOKE_MIN_GAP = 160;
const UNREACHED = 0x3fffffff;

export function imagePt(p: Pt, sym: "mirror" | "rotate", W: number, H: number): Pt {
  return { x: W - p.x, y: sym === "rotate" ? H - p.y : p.y };
}

/** One seat's anchors in its own-frame order (world coordinates). */
export function seatAnchors(a: MapAnchors, seat: 0 | 1, W: number, H: number) {
  const img = (p: Pt) => imagePt(p, a.symmetry, W, H);
  return {
    base: a.base[seat],
    pockets: a.pockets[seat],
    centre: seat === 0 ? a.centre : a.centre.map(img),
    nodes: seat === 0 ? a.nodes : a.nodes.map(img),
    safeNodes: a.safeNodes[seat],
    chokes: a.chokes[seat],
  };
}

/** Pad a list to a fixed length with a validity mask. */
export function padSlots(list: Pt[], max: number): { pts: Pt[]; valid: boolean[] } {
  const pts: Pt[] = [], valid: boolean[] = [];
  for (let i = 0; i < max; i++) {
    pts.push(list[i] ?? { x: 0, y: 0 });
    valid.push(i < list.length);
  }
  return { pts, valid };
}

/** Static grid: terrain obstacles plus both crystals. */
export function staticNavGrid(terrain: Terrain, layout: MapLayout): NavGrid {
  const g = createNavGrid(layout.width, layout.height, terrain);
  const r = ENTITY.crystal.radius;
  for (const c of [layout.blueCrystal, layout.redCrystal]) {
    const { c1, r1, c2, r2 } = cellRange(g, { x1: c.x - r, y1: c.y - r, x2: c.x + r, y2: c.y + r });
    for (let row = r1; row <= r2; row++) for (let col = c1; col <= c2; col++) g.structures[row * g.cols + col]++;
  }
  return g;
}

/** Chebyshev clearance: rings of `ok` cells around each cell (0 where !ok; the map edge counts as !ok). */
function clearance(cols: number, rows: number, ok: (i: number) => boolean): Int32Array {
  const N = cols * rows;
  const d = new Int32Array(N);
  for (let i = 0; i < N; i++) d[i] = ok(i) ? 1 << 20 : 0;
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : d[r * cols + c]);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (d[i]) d[i] = Math.min(d[i], 1 + Math.min(at(c - 1, r), at(c - 1, r - 1), at(c, r - 1), at(c + 1, r - 1)));
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
    const i = r * cols + c;
    if (d[i]) d[i] = Math.min(d[i], 1 + Math.min(at(c + 1, r), at(c + 1, r + 1), at(c, r + 1), at(c - 1, r + 1)));
  }
  return d;
}

export function computeAnchors(terrain: Terrain, layout: MapLayout, symmetry: "mirror" | "rotate"): MapAnchors {
  const W = layout.width, H = layout.height;
  const g = staticNavGrid(terrain, layout);
  const { cols, rows, cellSize: cs } = g;
  const N = cols * rows;
  const free = (i: number) => g.structures[i] === 0;
  const ctr = (i: number): Pt => ({ x: (i % cols + 0.5) * cs, y: (Math.floor(i / cols) + 0.5) * cs });
  const img = (p: Pt) => imagePt(p, symmetry, W, H);
  const dist2 = (p: Pt, q: Pt) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;

  // Base: the free cell nearest a point just outside the no-build ring, toward the centre.
  const crystal = layout.blueCrystal;
  const want = { x: crystal.x + PLACEMENT.crystalNoBuildRadius + cs, y: crystal.y };
  let baseCell = -1;
  for (let i = 0; i < N; i++) {
    if (free(i) && (baseCell < 0 || dist2(ctr(i), want) < dist2(ctr(baseCell), want))) baseCell = i;
  }
  const base = ctr(baseCell);
  const field = flowField(g, baseCell);
  const reached = (i: number) => field[i] < UNREACHED;
  const pathPx = (i: number) => (field[i] * cs) / 10;

  // Pockets: the most open buildable cell in each distance band.
  const nodes = [...layout.blueSafeNodes, ...layout.contestedNodes];
  const maxX = W / 2 - PLACEMENT.centerExclusionHalfWidth - cs * 2;
  const buildable = (i: number) => {
    if (!free(i) || !reached(i) || terrain.cells[i] === T_BRUSH) return false;
    const p = ctr(i);
    if (p.x > maxX) return false;
    if (dist2(p, crystal) < (PLACEMENT.crystalNoBuildRadius + 2 * cs) ** 2) return false;
    return nodes.every((n) => dist2(p, n) >= (n.radius + 2 * cs) ** 2);
  };
  const buildClr = clearance(cols, rows, buildable);
  const pockets: Pt[] = [];
  for (const [lo, hi] of POCKET_BANDS) {
    let best = -1;
    for (let i = 0; i < N; i++) {
      if (buildClr[i] < POCKET_CLEARANCE) continue;
      const d = pathPx(i);
      if (d < lo || d >= hi) continue;
      if (pockets.some((q) => dist2(ctr(i), q) < POCKET_MIN_GAP ** 2)) continue;
      if (best < 0) { best = i; continue; }
      // Most open first, then nearest the base's axis toward the centre, then nearest the base.
      const a = Math.min(buildClr[i], CLEARANCE_CAP), b = Math.min(buildClr[best], CLEARANCE_CAP);
      const ya = Math.abs(ctr(i).y - crystal.y), yb = Math.abs(ctr(best).y - crystal.y);
      if (a > b || (a === b && (ya < yb || (ya === yb && d < pathPx(best))))) best = i;
    }
    if (best >= 0) pockets.push(ctr(best));
  }

  // Centre: the free point on the centre line nearest the middle (if it maps to
  // itself), then the most open area on seat 0's side and its image.
  const centre: Pt[] = [];
  const midCol = cols / 2 - 1; // left of the centre line (cols is even: W / cs)
  const midRow = (rows - 1) / 2;
  if (symmetry === "mirror") {
    for (let k = 0; k <= midRow + 1; k++) {
      const row = [Math.floor(midRow - k), Math.ceil(midRow + k)].find((r) => r >= 0 && r < rows && free(r * cols + midCol) && reached(r * cols + midCol));
      if (row !== undefined) { centre.push({ x: W / 2, y: (row + 0.5) * cs }); break; }
    }
  } else if (Number.isInteger(midRow) && free(midRow * cols + midCol) && reached(midRow * cols + midCol)) {
    centre.push({ x: W / 2, y: H / 2 });
  }
  const walkClr = clearance(cols, rows, (i) => free(i) && reached(i));
  const mid = { x: W / 2, y: H / 2 };
  let side = -1;
  for (let i = 0; i < N; i++) {
    const p = ctr(i);
    if (walkClr[i] < 2 || p.x < W / 2 - CENTRE_BAND[1] || p.x > W / 2 - CENTRE_BAND[0]) continue;
    if (side < 0) { side = i; continue; }
    const a = Math.min(walkClr[i], CLEARANCE_CAP), b = Math.min(walkClr[side], CLEARANCE_CAP);
    if (a > b || (a === b && dist2(p, mid) < dist2(ctr(side), mid))) side = i;
  }
  if (side >= 0) centre.push(ctr(side), img(ctr(side)));

  // Chokes: the narrowest cross-section (perpendicular to the path) on the
  // shortest path to each centre anchor.
  const blockedAt = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || !free(cellOf(g, x, y));
  const crossWidth = (p: Pt, dx: number, dy: number) => {
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, step = cs / 4;
    let w = 0;
    for (const s of [1, -1]) {
      let t = step;
      while (!blockedAt(p.x + s * nx * t, p.y + s * ny * t)) t += step;
      w += t;
    }
    return w;
  };
  const chokeCells: number[] = [];
  for (const t of centre) {
    const path = descendField(g, field, cellOf(g, t.x, t.y), baseCell).reverse(); // base → target
    let best = -1, bestW = Infinity;
    for (let k = 0; k < path.length; k++) {
      const i = path[k], p = ctr(i);
      if (p.x >= W / 2 || pathPx(i) < CHOKE_MIN_DIST) continue;
      const a = ctr(path[Math.max(0, k - 3)]), b = ctr(path[Math.min(path.length - 1, k + 3)]);
      const w = crossWidth(p, b.x - a.x, b.y - a.y);
      if (w < bestW) { best = i; bestW = w; }
    }
    if (best >= 0 && bestW <= CHOKE_MAX_WIDTH && chokeCells.every((c) => dist2(ctr(c), ctr(best)) >= CHOKE_MIN_GAP ** 2)) {
      chokeCells.push(best);
    }
  }
  chokeCells.sort((a, b) => pathPx(a) - pathPx(b) || a - b);
  const chokes = chokeCells.slice(0, ANCHOR_MAX.chokes).map(ctr);

  const contested = layout.contestedNodes.map((n) => ({ x: n.x, y: n.y })).sort((a, b) => a.x - b.x || a.y - b.y);
  const safe = layout.blueSafeNodes.map((n) => ({ x: n.x, y: n.y }));
  return {
    symmetry,
    base: [base, img(base)],
    pockets: [pockets, pockets.map(img)],
    centre,
    nodes: contested,
    safeNodes: [safe, safe.map(img)],
    chokes: [chokes, chokes.map(img)],
  };
}
