/**
 * Seeded map generator and validator (G-7). Offline tooling only: matches
 * never generate maps; they load frozen pool maps (see maps.ts, pool/).
 *
 * generateMap(seed) builds the left half of a symmetric map:
 *   - an open base area (crystal + 500 px, for the base buildings),
 *   - a sparse approach band from there to the middle third, with a few rock
 *     clusters, a mud patch and brush,
 *   - a dense middle band with contested nodes in jungle pockets (a clearing
 *     ringed by rock with 2–3 entrances), optionally one on a high-ground
 *     plateau with ramps, plus extra rock, water, mud and brush.
 * Candidates that fail validation are retried with the next sub-seed, so
 * every returned map passes validateMap().
 *
 * validateMap() checks the G-2 rules: key points open with clearance, an
 * open base area and mostly open build zone, no enclosed pockets, every route at least 3 nav cells
 * wide, base-to-base and base-to-node detour ratio ≤ GEN.maxDetour, a
 * density gradient (middle denser than the approach, approach denser than
 * the base) and contested nodes sheltered by terrain.
 */
import { MAP, NAV } from "@crystalfront/shared";
import { Rng } from "./engine/rng.js";
import { buildTerrain, isObstacleCode, T_HIGH, type MapDef, type Terrain, type TerrainShape } from "./engine/terrain.js";
import { createMap } from "./map.js";
import type { MatchConfig } from "./types.js";

export const GEN = {
  maxDetour: 1.35,          // shortest path ÷ straight line, base→base and base→node
  clearEnd: 600,            // base area kept fully open: x < clearEnd (crystal at x=100, + 500 px)
  buildEnd: 1000,           // the 20% build zone (checked by minBuildOpen)
  approachEnd: 1667,        // approach band up to the middle third
  minBuildOpen: 0.95,       // non-obstacle share of the build zone
  minMiddleDensity: 0.15,   // obstacle share of the middle third
  minGradient: 0.03,        // middle density − approach density
  nodeClearance: 60,        // px around a node free of obstacles
  pointClearance: 40,       // px around crystals, workers, safe nodes
  nodeShelter: 0.12,        // obstacle (or high-ground) share within 220 px of a contested node
  maxAttempts: 200,
} as const;

export interface MapMetrics {
  detourBase: number;
  detourNodeMax: number;
  density: { base: number; approach: number; middle: number };
  buildOpen: number;
  nodeShelterMin: number;
}

export interface Validation {
  ok: boolean;
  issues: string[];
  metrics: MapMetrics;
}

const W = MAP.width, H = MAP.height;

/** Generate a valid map for `seed` (deterministic). */
export function generateMap(seed: number, symmetry: "mirror" | "rotate" = seed % 2 ? "rotate" : "mirror"): { def: MapDef; validation: Validation; attempts: number } {
  for (let attempt = 0; attempt < GEN.maxAttempts; attempt++) {
    const def = candidate(new Rng((seed * 7919 + attempt * 104729) >>> 0), seed, symmetry);
    let validation = validateMap(def);
    if (!validation.ok && validation.issues.every((i) => i.startsWith("enclosed"))) {
      fillEnclosed(def);
      validation = validateMap(def);
    }
    if (validation.ok) return { def, validation, attempts: attempt + 1 };
  }
  throw new Error(`generateMap(${seed}): no valid candidate in ${GEN.maxAttempts} attempts`);
}

function candidate(rng: Rng, seed: number, symmetry: "mirror" | "rotate"): MapDef {
  const shapes: TerrainShape[] = [];
  const carve: TerrainShape[] = [];
  const r = (a: number, b: number) => a + rng.random() * (b - a);
  const ri = (a: number, b: number) => rng.randInt(a, b);
  const nodes: Array<[number, number]> = [];

  const rockCluster = (cx: number, cy: number, size: number) => {
    const n = ri(2, 4);
    for (let i = 0; i < n; i++) {
      shapes.push({ kind: "rock", circle: [Math.round(cx + r(-size, size)), Math.round(cy + r(-size, size) * 0.7), Math.round(r(size * 0.45, size))] });
    }
  };
  const patch = (kind: "rough" | "brush" | "water", cx: number, cy: number, w: number, h: number) => {
    shapes.push({ kind, rect: [Math.round(cx - w / 2), Math.round(cy - h / 2), Math.round(cx + w / 2), Math.round(cy + h / 2)] });
  };

  // Approach band: sparse.
  const approach = ri(4, 6);
  for (let i = 0; i < approach; i++) rockCluster(r(750, 1650), r(80, H - 80), r(30, 55));
  if (rng.random() < 0.7) patch("rough", r(750, 1600), r(150, H - 150), r(100, 180), r(100, 160));

  // Contested nodes: 4 on the left half (a near and a far pair, one north and
  // one south in each), optionally one in the centre.
  const centre = rng.random() < 0.5;
  const ys = [r(110, 330), r(H - 330, H - 110)];
  if (rng.random() < 0.5) ys.reverse();
  nodes.push([Math.round(r(1850, 2050)), Math.round(ys[0])]);
  nodes.push([Math.round(r(2150, 2350)), Math.round(ys[1])]);
  const nearYs = [r(130, 330), r(H - 330, H - 130)];
  if (rng.random() < 0.5) nearYs.reverse();
  nodes.push([Math.round(r(1250, 1450)), Math.round(nearYs[0])]);
  nodes.push([Math.round(r(1500, 1650)), Math.round(nearYs[1])]);
  if (centre) nodes.push([W / 2, H / 2]);

  // Optional plateau holding the first node (high ground overlooking a path).
  const plateauNode = rng.random() < 0.4 ? 0 : -1;

  // Middle band: dense filler first, pockets after (so their carving wins).
  const filler = ri(9, 13);
  for (let i = 0; i < filler; i++) rockCluster(r(1700, 2500), r(60, H - 60), r(40, 75));
  if (rng.random() < 0.5) {
    const vertical = rng.random() < 0.5;
    const len = r(140, 260);
    patch("water", r(1750, 2400), r(120, H - 120), vertical ? 50 : len, vertical ? len : 50);
  }
  if (rng.random() < 0.7) patch("rough", r(1800, 2400), r(150, H - 150), r(120, 200), r(100, 180));

  nodes.forEach(([nx, ny], i) => {
    if (i === plateauNode) {
      plateau(shapes, nx, ny, rng);
      return;
    }
    // Pocket: rock ring with 2–3 gaps.
    const segs = 7;
    const gaps = new Set<number>();
    const want = ri(2, 3);
    while (gaps.size < want) gaps.add(ri(0, segs - 1));
    const ringR = r(120, 150);
    const a0 = r(0, Math.PI * 2);
    for (let k = 0; k < segs; k++) {
      if (gaps.has(k)) continue;
      const a = a0 + (k * 2 * Math.PI) / segs;
      shapes.push({ kind: "rock", circle: [Math.round(nx + Math.cos(a) * ringR), Math.round(ny + Math.sin(a) * ringR), Math.round(r(38, 50))] });
    }
    carve.push({ kind: "open", circle: [nx, ny, 80] });
  });

  // Brush on routes, away from nodes.
  const brush = ri(3, 5);
  for (let i = 0; i < brush; i++) {
    for (let tries = 0; tries < 10; tries++) {
      const bx = r(750, 2450), by = r(60, H - 60);
      if (nodes.some(([nx, ny]) => Math.hypot(nx - bx, ny - by) < 200)) continue;
      patch("brush", bx, by, r(60, 120), r(60, 100));
      break;
    }
  }

  // Keep the base band and key points clear.
  carve.push({ kind: "open", rect: [0, 0, GEN.clearEnd, H] });
  return {
    id: `gen-${seed}`,
    name: `Generated ${seed}`,
    version: 1,
    symmetry,
    shapes: [...shapes, ...carve],
    nodes,
  };
}

/** High-ground plateau around (nx, ny), cliff-edged with 1–2 ramps. */
function plateau(shapes: TerrainShape[], nx: number, ny: number, rng: Rng): void {
  const hw = Math.round(110 + rng.random() * 50), hh = Math.round(100 + rng.random() * 40);
  const x1 = nx - hw, x2 = nx + hw;
  const y1 = Math.max(0, ny - hh), y2 = Math.min(H, ny + hh);
  shapes.push({ kind: "high", rect: [x1, y1, x2, y2] });
  const edges: TerrainShape[] = [];
  if (y1 > 0) edges.push({ kind: "cliff", rect: [x1, y1, x2, y1 + 20] });
  if (y2 < H) edges.push({ kind: "cliff", rect: [x1, y2 - 20, x2, y2] });
  edges.push({ kind: "cliff", rect: [x1, y1, x1 + 20, y2] });
  edges.push({ kind: "cliff", rect: [x2 - 20, y1, x2, y2] });
  shapes.push(...edges);
  // Ramps: gaps in two different edges, 80 px wide.
  const order = edges.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.randInt(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.length = 2;
  for (const i of order) {
    const e = (edges[i] as { rect: [number, number, number, number] }).rect;
    const horizontal = e[2] - e[0] > e[3] - e[1];
    if (horizontal) {
      const mx = Math.round(e[0] + 40 + rng.random() * (e[2] - e[0] - 80));
      shapes.push({ kind: "high", rect: [mx - 40, e[1], mx + 40, e[3]] });
    } else {
      const my = Math.round(e[1] + 40 + rng.random() * (e[3] - e[1] - 80));
      shapes.push({ kind: "high", rect: [e[0], my - 40, e[2], my + 40] });
    }
  }
}

// ── Validation ──────────────────────────────────────────────────────

const cfg = { mapWidth: W, mapHeight: H } as MatchConfig;

function nodesOf(def: MapDef): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const [x, y] of def.nodes ?? []) {
    out.push({ x, y });
    const ix = W - x, iy = def.symmetry === "rotate" ? H - y : y;
    if (def.symmetry !== "none" && (ix !== x || iy !== y)) out.push({ x: ix, y: iy });
  }
  return out;
}

function enclosedCells(t: Terrain, start: number): number[] {
  const seen = new Uint8Array(t.cells.length);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    const col = c % t.cols, row = (c - col) / t.cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= t.cols || nr >= t.rows) continue;
      const n = nr * t.cols + nc;
      if (seen[n] || isObstacleCode(t.cells[n])) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < t.cells.length; i++) if (!seen[i] && !isObstacleCode(t.cells[i])) out.push(i);
  return out;
}

/** Turn enclosed open cells (left half) into rock, so the map has no unreachable pockets. */
function fillEnclosed(def: MapDef): void {
  const t = buildTerrain(def, W, H);
  const cs = NAV.cellSize;
  for (const c of enclosedCells(t, cellAt(t, 100, H / 2))) {
    const col = c % t.cols, row = (c - col) / t.cols;
    if (col >= t.cols / 2) continue;
    def.shapes.push({ kind: "rock", rect: [col * cs, row * cs, (col + 1) * cs, (row + 1) * cs] });
  }
}

function cellAt(t: Terrain, x: number, y: number): number {
  const col = Math.min(t.cols - 1, Math.max(0, Math.floor(x / t.cellSize)));
  const row = Math.min(t.rows - 1, Math.max(0, Math.floor(y / t.cellSize)));
  return row * t.cols + col;
}

function clear(t: Terrain, x: number, y: number, radius: number): boolean {
  const cs = t.cellSize;
  for (let row = Math.floor((y - radius) / cs); row <= Math.floor((y + radius) / cs); row++) {
    for (let col = Math.floor((x - radius) / cs); col <= Math.floor((x + radius) / cs); col++) {
      if (row < 0 || col < 0 || row >= t.rows || col >= t.cols) continue;
      const cx = (col + 0.5) * cs, cy = (row + 0.5) * cs;
      if ((cx - x) ** 2 + (cy - y) ** 2 > radius * radius) continue;
      if (isObstacleCode(t.cells[row * t.cols + col])) return false;
    }
  }
  return true;
}

/** Octile Dijkstra over cells with clearance 1 (no obstacle in the 8-neighbourhood); px distances. */
function wideDistances(t: Terrain, start: number): Float64Array {
  const n = t.cells.length;
  const wide = new Uint8Array(n);
  for (let row = 0; row < t.rows; row++) {
    for (let col = 0; col < t.cols; col++) {
      let ok = 1;
      for (let dr = -1; dr <= 1 && ok; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r2 = row + dr, c2 = col + dc;
          if (r2 < 0 || c2 < 0 || r2 >= t.rows || c2 >= t.cols) continue; // map edge is fine
          if (isObstacleCode(t.cells[r2 * t.cols + c2])) { ok = 0; break; }
        }
      }
      wide[row * t.cols + col] = ok;
    }
  }
  const dist = new Float64Array(n).fill(Infinity);
  const cs = t.cellSize;
  // Binary heap of [dist, cell].
  const heap: Array<[number, number]> = [];
  const push = (d: number, c: number) => {
    heap.push([d, c]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  if (!wide[start]) return dist;
  dist[start] = 0;
  push(0, start);
  while (heap.length) {
    const [d, c] = pop();
    if (d > dist[c]) continue;
    const col = c % t.cols, row = (c - col) / t.cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r2 = row + dr, c2 = col + dc;
        if (r2 < 0 || c2 < 0 || r2 >= t.rows || c2 >= t.cols) continue;
        const m = r2 * t.cols + c2;
        if (!wide[m]) continue;
        if (dr && dc && (!wide[row * t.cols + c2] || !wide[r2 * t.cols + col])) continue;
        const nd = d + (dr && dc ? Math.SQRT2 : 1) * cs;
        if (nd < dist[m]) { dist[m] = nd; push(nd, m); }
      }
    }
  }
  return dist;
}

function obstacleShare(t: Terrain, x1: number, x2: number): number {
  let n = 0, k = 0;
  for (let row = 0; row < t.rows; row++) {
    for (let col = 0; col < t.cols; col++) {
      const x = (col + 0.5) * t.cellSize;
      if (x < x1 || x >= x2) continue;
      n++;
      if (isObstacleCode(t.cells[row * t.cols + col])) k++;
    }
  }
  return n ? k / n : 0;
}

/** Validate a map definition against the G-2 rules. */
export function validateMap(def: MapDef): Validation {
  const t = buildTerrain(def, W, H);
  const issues: string[] = [];
  const contested = nodesOf(def);
  const map = createMap(cfg, contested.length ? contested : undefined, def.symmetry === "rotate");

  const keyPoints = [
    map.blueCrystal, map.redCrystal, ...map.blueWorkers, ...map.redWorkers,
    ...map.blueSafeNodes, ...map.redSafeNodes,
  ];
  for (const p of keyPoints) if (!clear(t, p.x, p.y, GEN.pointClearance)) issues.push(`blocked point (${p.x},${p.y})`);
  for (const n of map.contestedNodes) if (!clear(t, n.x, n.y, GEN.nodeClearance)) issues.push(`blocked node (${n.x},${n.y})`);

  const startCell = cellAt(t, map.blueCrystal.x, map.blueCrystal.y);
  const enclosed = enclosedCells(t, startCell);
  if (enclosed.length) issues.push(`enclosed cells: ${enclosed.length}`);

  const dist = wideDistances(t, startCell);
  const detour = (p: { x: number; y: number }) => {
    const d = dist[cellAt(t, p.x, p.y)];
    const straight = Math.hypot(p.x - map.blueCrystal.x, p.y - map.blueCrystal.y);
    return d / Math.max(straight, t.cellSize);
  };
  const detourBase = detour(map.redCrystal);
  if (!(detourBase <= GEN.maxDetour)) issues.push(`base detour ${detourBase.toFixed(2)}`);
  let detourNodeMax = 0;
  for (const n of map.contestedNodes) {
    const d = detour(n);
    detourNodeMax = Math.max(detourNodeMax, d);
    if (!(d <= GEN.maxDetour)) issues.push(`node (${n.x},${n.y}) detour ${d.toFixed(2)}`);
  }

  const density = {
    base: obstacleShare(t, 0, GEN.clearEnd),
    approach: obstacleShare(t, GEN.clearEnd, GEN.approachEnd),
    middle: obstacleShare(t, GEN.approachEnd, W - GEN.approachEnd),
  };
  if (density.middle < GEN.minMiddleDensity) issues.push(`middle density ${density.middle.toFixed(3)}`);
  if (density.middle < density.approach + GEN.minGradient) issues.push("no density gradient (middle vs approach)");
  if (density.approach <= density.base) issues.push("no density gradient (approach vs base)");
  const buildOpen = 1 - obstacleShare(t, 0, GEN.buildEnd);
  if (buildOpen < GEN.minBuildOpen) issues.push(`build zone open ${buildOpen.toFixed(3)}`);

  let nodeShelterMin = 1;
  for (const n of map.contestedNodes) {
    let k = 0, m = 0;
    const R = 220, cs = t.cellSize;
    for (let row = Math.floor((n.y - R) / cs); row <= Math.floor((n.y + R) / cs); row++) {
      for (let col = Math.floor((n.x - R) / cs); col <= Math.floor((n.x + R) / cs); col++) {
        if (row < 0 || col < 0 || row >= t.rows || col >= t.cols) continue;
        if (((col + 0.5) * cs - n.x) ** 2 + ((row + 0.5) * cs - n.y) ** 2 > R * R) continue;
        m++;
        const c = t.cells[row * t.cols + col];
        if (isObstacleCode(c) || c === T_HIGH) k++;
      }
    }
    nodeShelterMin = Math.min(nodeShelterMin, m ? k / m : 0);
  }
  if (map.contestedNodes.length && nodeShelterMin < GEN.nodeShelter) issues.push(`exposed node (shelter ${nodeShelterMin.toFixed(3)})`);

  return { ok: issues.length === 0, issues, metrics: { detourBase, detourNodeMax, density, buildOpen, nodeShelterMin } };
}
