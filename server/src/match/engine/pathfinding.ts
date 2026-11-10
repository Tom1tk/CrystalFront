/**
 * Auto-navigation (G-4).
 *
 * - A* on the nav grid: 8-connected, integer costs (10 straight / 14 diagonal),
 *   no corner cutting. Blocked cells may be entered at a large penalty, so a
 *   search always finds a route "towards" the goal; the route is cut at the first
 *   blocked cell. An unreachable target therefore resolves to the nearest
 *   reachable cell (and a target inside a structure to its edge).
 * - Flow fields: a Dijkstra distance field per goal cell, cached by
 *   (nav grid, goal cell, nav version), shared by every unit sent to that goal.
 * - String-pull smoothing with a thick line-of-sight test, so units walk
 *   straight diagonals instead of grid steps.
 * - Rough terrain (G-6) costs more to enter, and a smoothed leg may only cross
 *   rough cells the search itself chose, so smoothing never cuts through mud
 *   the route went around.
 *
 * Tie-breaking is total and mirror-equivariant (f, h, distance from the
 * start→goal line, row, column distance from goal) so a left-right mirrored
 * state picks the mirrored path.
 */
import type { NavGrid } from "./navGrid.js";
import { TERRAIN } from "@crystalfront/shared";
import { T_ROUGH } from "./terrain.js";

const STRAIGHT = 10;
const DIAGONAL = 14;
/** Extra cost for entering a blocked cell (per step). */
const BLOCKED_PENALTY = 1000;
/** Half-width of the swept box used for line-of-sight (just under half a cell). */
const LOS_HALF = 9;
const UNREACHED = 0x3fffffff;
const MAX_FIELDS = 64;

export interface Point { x: number; y: number }
export interface PathResult {
  /** Waypoints to visit in order (excluding the unit's own position). */
  waypoints: Point[];
  /** True when the goal itself cannot be reached; the last waypoint is the closest reachable point. */
  truncated: boolean;
}

const blocked = (g: NavGrid, i: number) => g.structures[i] > 0;
const rough = (g: NavGrid, i: number) => g.terrain !== null && g.terrain.cells[i] === T_ROUGH;
/** Cost of a step into cell i (base: STRAIGHT or DIAGONAL). */
const stepCost = (g: NavGrid, i: number, base: number) =>
  !rough(g, i) ? base : base === STRAIGHT ? TERRAIN.roughStraightCost : TERRAIN.roughDiagonalCost;

export function cellOf(g: NavGrid, x: number, y: number): number {
  // A point exactly on a column boundary goes to the column nearer the map's
  // centre line, so a left-right mirrored point lands in the mirrored column.
  const fx = x / g.cellSize;
  const colRaw = fx < g.cols / 2 ? Math.floor(fx) : Math.ceil(fx) - 1;
  const col = Math.min(g.cols - 1, Math.max(0, colRaw));
  const row = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cellSize)));
  return row * g.cols + col;
}

function centre(g: NavGrid, i: number): Point {
  const col = i % g.cols;
  const row = (i - col) / g.cols;
  return { x: (col + 0.5) * g.cellSize, y: (row + 0.5) * g.cellSize };
}

/** True if a box of half-width LOS_HALF swept from a to b touches no blocked cell. */
export function hasLineOfSight(g: NavGrid, ax: number, ay: number, bx: number, by: number): boolean {
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(len / (g.cellSize / 2)));
  const cs = g.cellSize;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const c1 = Math.max(0, Math.floor((x - LOS_HALF) / cs));
    const c2 = Math.min(g.cols - 1, Math.ceil((x + LOS_HALF) / cs) - 1);
    const r1 = Math.max(0, Math.floor((y - LOS_HALF) / cs));
    const r2 = Math.min(g.rows - 1, Math.ceil((y + LOS_HALF) / cs) - 1);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (g.structures[r * g.cols + c] > 0) return false;
      }
    }
  }
  return true;
}

/** True if the segment a→b (centre line, half-cell steps) enters a rough cell not in `allowed`. */
function crossesRough(g: NavGrid, ax: number, ay: number, bx: number, by: number, allowed: Set<number>): boolean {
  if (!g.terrain || !g.terrain.any) return false;
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(len / (g.cellSize / 2)));
  for (let k = 0; k <= n; k++) {
    const c = cellOf(g, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
    if (rough(g, c) && !allowed.has(c)) return true;
  }
  return false;
}

// ---- Neighbour expansion -------------------------------------------------

const DIRS: Array<[number, number, number]> = [
  [1, 0, STRAIGHT], [-1, 0, STRAIGHT], [0, 1, STRAIGHT], [0, -1, STRAIGHT],
  [1, 1, DIAGONAL], [1, -1, DIAGONAL], [-1, 1, DIAGONAL], [-1, -1, DIAGONAL],
];

/** Calls fn(neighbour, stepCost) for each legal move out of cell i. */
function forNeighbours(g: NavGrid, i: number, fn: (n: number, cost: number) => void): void {
  const col = i % g.cols;
  const row = (i - col) / g.cols;
  for (const [dc, dr, base] of DIRS) {
    const c = col + dc, r = row + dr;
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
    const n = r * g.cols + c;
    if (dc !== 0 && dr !== 0) {
      // Diagonals only through open space: no corner cutting, never into walls.
      if (blocked(g, n) || blocked(g, row * g.cols + c) || blocked(g, r * g.cols + col)) continue;
    }
    const cost = stepCost(g, n, base);
    fn(n, blocked(g, n) ? cost + BLOCKED_PENALTY : cost);
  }
}

/** Calls fn(predecessor, stepCost) for each legal move *into* cell i (reverse of forNeighbours). */
function forPredecessors(g: NavGrid, i: number, fn: (n: number, cost: number) => void): void {
  const col = i % g.cols;
  const row = (i - col) / g.cols;
  const intoBlocked = blocked(g, i);
  for (const [dc, dr, base] of DIRS) {
    const c = col + dc, r = row + dr;
    if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
    const n = r * g.cols + c;
    if (dc !== 0 && dr !== 0) {
      if (intoBlocked || blocked(g, row * g.cols + c) || blocked(g, r * g.cols + col)) continue;
    }
    const cost = stepCost(g, i, base);
    fn(n, intoBlocked ? cost + BLOCKED_PENALTY : cost);
  }
}

// ---- Deterministic, mirror-equivariant priority --------------------------

interface Frame { g: NavGrid; sCol: number; sRow: number; gCol: number; gRow: number }

/** Secondary keys after cost: |cross| from start→goal line, row, |col - goalCol|, index. */
function tieLess(f: Frame, a: number, b: number): boolean {
  const ac = a % f.g.cols, ar = (a - ac) / f.g.cols;
  const bc = b % f.g.cols, br = (b - bc) / f.g.cols;
  const lx = f.gCol - f.sCol, ly = f.gRow - f.sRow;
  const xa = Math.abs((ac - f.sCol) * ly - (ar - f.sRow) * lx);
  const xb = Math.abs((bc - f.sCol) * ly - (br - f.sRow) * lx);
  if (xa !== xb) return xa < xb;
  if (ar !== br) return ar < br;
  const da = Math.abs(ac - f.gCol), db = Math.abs(bc - f.gCol);
  if (da !== db) return da < db;
  return a < b;
}

/**
 * Binary min-heap of cells. Keys are captured at push time: A* lowers a cell's
 * cost while an older entry is still queued, and reading live keys would corrupt
 * the heap order (making pop order depend on push order, which isn't mirror-safe).
 */
class Heap {
  private cell: number[] = [];
  private k1: number[] = [];
  private k2: number[] = [];
  constructor(private key1: Int32Array, private key2: Int32Array, private frame: Frame) {}
  get size() { return this.cell.length; }
  private less(i: number, j: number): boolean {
    if (this.k1[i] !== this.k1[j]) return this.k1[i] < this.k1[j];
    if (this.k2[i] !== this.k2[j]) return this.k2[i] < this.k2[j];
    return tieLess(this.frame, this.cell[i], this.cell[j]);
  }
  private swap(i: number, j: number) {
    const c = this.cell, a = this.k1, b = this.k2;
    let t = c[i]; c[i] = c[j]; c[j] = t;
    t = a[i]; a[i] = a[j]; a[j] = t;
    t = b[i]; b[i] = b[j]; b[j] = t;
  }
  push(i: number) {
    this.cell.push(i); this.k1.push(this.key1[i]); this.k2.push(this.key2[i]);
    let k = this.cell.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.less(k, p)) break;
      this.swap(k, p);
      k = p;
    }
  }
  pop(): number {
    const top = this.cell[0];
    const n = this.cell.length - 1;
    this.swap(0, n);
    this.cell.pop(); this.k1.pop(); this.k2.pop();
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === k) break;
      this.swap(k, m);
      k = m;
    }
    return top;
  }
}

function octile(g: NavGrid, a: number, b: number): number {
  const ac = a % g.cols, ar = (a - ac) / g.cols;
  const bc = b % g.cols, br = (b - bc) / g.cols;
  const dx = Math.abs(ac - bc), dy = Math.abs(ar - br);
  return STRAIGHT * Math.max(dx, dy) + (DIAGONAL - STRAIGHT) * Math.min(dx, dy);
}

function frameOf(g: NavGrid, start: number, goal: number): Frame {
  return { g, sCol: start % g.cols, sRow: Math.floor(start / g.cols), gCol: goal % g.cols, gRow: Math.floor(goal / g.cols) };
}

/** Scratch buffers reused across searches (sized to the largest grid seen). */
let scratch: { n: number; gCost: Int32Array; fCost: Int32Array; hCost: Int32Array; parent: Int32Array; stamp: Uint32Array; closedStamp: Uint32Array; gen: number } | null = null;
function scratchFor(N: number) {
  if (!scratch || scratch.n < N) {
    scratch = { n: N, gCost: new Int32Array(N), fCost: new Int32Array(N), hCost: new Int32Array(N), parent: new Int32Array(N), stamp: new Uint32Array(N), closedStamp: new Uint32Array(N), gen: 0 };
  }
  scratch.gen++;
  return scratch;
}

/** A* over cells (blocked cells allowed at a penalty). Returns the cell sequence start..goal. */
export function astarCells(g: NavGrid, start: number, goal: number): number[] {
  const S = scratchFor(g.cols * g.rows);
  const { gCost, fCost, hCost, parent, stamp, closedStamp, gen } = S;
  // A cell's g/f/h/parent are valid only when stamp[i] === gen.
  const seen = (i: number) => stamp[i] === gen;
  const heap = new Heap(fCost, hCost, frameOf(g, start, goal));
  stamp[start] = gen;
  gCost[start] = 0;
  hCost[start] = octile(g, start, goal);
  fCost[start] = hCost[start];
  parent[start] = -1;
  heap.push(start);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closedStamp[cur] === gen) continue;
    closedStamp[cur] = gen;
    if (cur === goal) break;
    forNeighbours(g, cur, (n, cost) => {
      if (closedStamp[n] === gen) return;
      const ng = gCost[cur] + cost;
      if (seen(n) && ng >= gCost[n]) return;
      stamp[n] = gen;
      gCost[n] = ng;
      hCost[n] = octile(g, n, goal);
      fCost[n] = ng + hCost[n];
      parent[n] = cur;
      heap.push(n);
    });
  }
  const cells: number[] = [];
  if (!seen(goal)) return [start];
  for (let c = goal; c !== -1; c = parent[c]) cells.push(c);
  return cells.reverse();
}

// ---- Flow fields ----------------------------------------------------------

let zeros: Int32Array | null = null;
function zeroKeys(N: number): Int32Array {
  if (!zeros || zeros.length < N) zeros = new Int32Array(N);
  return zeros;
}

const fieldCache = new WeakMap<NavGrid, { version: number; fields: Map<number, Int32Array> }>();

/** Dijkstra distance-to-goal for every cell (blocked cells at a penalty). Cached. */
export function flowField(g: NavGrid, goal: number): Int32Array {
  let entry = fieldCache.get(g);
  if (!entry || entry.version !== g.version) {
    entry = { version: g.version, fields: new Map() };
    fieldCache.set(g, entry);
  }
  const hit = entry.fields.get(goal);
  if (hit) return hit;

  const N = g.cols * g.rows;
  const dist = new Int32Array(N).fill(UNREACHED);
  const zero = zeroKeys(N);
  const done = new Uint8Array(N);
  const heap = new Heap(dist, zero, frameOf(g, goal, goal));
  dist[goal] = 0;
  heap.push(goal);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    forPredecessors(g, cur, (n, cost) => {
      const nd = dist[cur] + cost;
      if (nd < dist[n]) { dist[n] = nd; heap.push(n); }
    });
  }
  if (entry.fields.size >= MAX_FIELDS) entry.fields.delete(entry.fields.keys().next().value!);
  entry.fields.set(goal, dist);
  return dist;
}

/** Follow a flow field downhill from start to its goal. */
export function descendField(g: NavGrid, field: Int32Array, start: number, goal: number): number[] {
  const frame = frameOf(g, start, goal);
  const cells = [start];
  let cur = start;
  for (let guard = 0; guard < g.cols * g.rows && cur !== goal; guard++) {
    let best = -1;
    let bestVal = field[cur];
    forNeighbours(g, cur, (n, cost) => {
      const v = field[n] + cost;
      // Strictly downhill: an optimal step satisfies field[n] + cost === field[cur].
      if (field[n] >= field[cur]) return;
      if (best === -1 || v < bestVal || (v === bestVal && tieLess(frame, n, best))) { best = n; bestVal = v; }
    });
    if (best === -1) break;
    cells.push(best);
    cur = best;
  }
  return cells;
}

// ---- Path assembly --------------------------------------------------------

/**
 * Plan a route for a unit at (sx,sy) to (tx,ty).
 * useField: follow the shared flow field for this goal (group moves) instead of A*.
 */
export function planPath(g: NavGrid, sx: number, sy: number, tx: number, ty: number, useField: boolean): PathResult {
  let goalBlocked = false;
  if (blocked(g, cellOf(g, tx, ty))) {
    // Target inside a structure (attacking/building/repairing it): head for the
    // nearest free point on the straight line from the target back to the unit.
    const len = Math.hypot(sx - tx, sy - ty);
    const n = Math.max(1, Math.ceil(len / (g.cellSize / 2)));
    let found = false;
    for (let k = 1; k <= n; k++) {
      const x = tx + ((sx - tx) * k) / n, y = ty + ((sy - ty) * k) / n;
      if (!blocked(g, cellOf(g, x, y))) { tx = x; ty = y; found = true; break; }
    }
    if (!found) return { waypoints: [], truncated: true };
    goalBlocked = true;
    useField = false; // per-unit approach point, nothing to share
  }
  if (hasLineOfSight(g, sx, sy, tx, ty) &&
      !crossesRough(g, sx, sy, tx, ty, new Set([cellOf(g, sx, sy), cellOf(g, tx, ty)]))) {
    return goalBlocked ? { waypoints: [{ x: tx, y: ty }], truncated: true } : { waypoints: [], truncated: false };
  }
  const start = cellOf(g, sx, sy);
  const goal = cellOf(g, tx, ty);
  let cells = useField ? descendField(g, flowField(g, goal), start, goal) : astarCells(g, start, goal);

  // Cut at the first blocked cell after the start (the start may overlap a wall edge).
  let truncated = goalBlocked || cells[cells.length - 1] !== goal;
  for (let k = 1; k < cells.length; k++) {
    if (blocked(g, cells[k])) { cells = cells.slice(0, k); truncated = true; break; }
  }

  // Keep only turning points (straight runs add nothing to string pulling).
  const turns: number[] = [];
  for (let k = 1; k < cells.length; k++) {
    if (k === cells.length - 1) { turns.push(cells[k]); break; }
    const d1 = cells[k] - cells[k - 1];
    const d2 = cells[k + 1] - cells[k];
    if (d1 !== d2) turns.push(cells[k]);
  }
  const pts: Point[] = turns.map((c) => centre(g, c));
  const reachedGoal = cells[cells.length - 1] === goal;
  if (reachedGoal) {
    if (pts.length > 0) pts[pts.length - 1] = { x: tx, y: ty };
    else pts.push({ x: tx, y: ty });
  }

  // String-pull: keep a waypoint only when the next one isn't visible from the anchor
  // (or the shortcut would cross rough cells the route avoided).
  const onRoute = new Set(cells);
  const out: Point[] = [];
  let ax = sx, ay = sy;
  for (let k = 0; k < pts.length; k++) {
    const next = pts[k + 1];
    if (next && hasLineOfSight(g, ax, ay, next.x, next.y) && !crossesRough(g, ax, ay, next.x, next.y, onRoute)) continue;
    out.push(pts[k]);
    ax = pts[k].x; ay = pts[k].y;
  }
  // When the real goal is reached, the final leg steers to the unit's moveTarget itself.
  if (!truncated && out.length > 0) out.pop();
  return { waypoints: out, truncated };
}
