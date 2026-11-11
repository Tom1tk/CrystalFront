/**
 * Fog of war with terrain line of sight (G-6b).
 *
 * Vision is resolved on a coarse grid (TERRAIN.visionCellSize px), centred on
 * the map so it is symmetric under both map symmetries (a 900 px map has 23
 * rows starting 10 px above the top edge). Each vision source lights the cells whose centre is within its
 * vision range (+ half a cell) and that a ray from its own cell reaches:
 *   - rock blocks every ray;
 *   - a low-ground source can't see elevated cells (high ground or cliff), and
 *     elevated cells block its rays, so a plateau hides what's behind it;
 *   - a high-ground source is blocked by rock only.
 * A player's vision bitmap is the union over their sources. An enemy entity is
 * visible when its cell is lit — unless it stands in brush, which hides it from
 * anyone without their own entity in the same brush patch. Units that attacked
 * one of the player's entities within the attack-log window are always visible.
 *
 * Everything here is a pure function of the state (entities, attack log,
 * terrain), so clones recompute it rather than copying it.
 */
import type { PlayerId, EntityId } from "@crystalfront/shared";
import { TERRAIN } from "@crystalfront/shared";
import type { MatchEntity, MatchState } from "../types.js";
import { getVisionRange, onHighGround } from "./utils.js";
import { T_BRUSH, T_CLIFF, T_HIGH, T_ROCK, terrainCellOf, type Terrain } from "./terrain.js";

export interface PlayerVision {
  entityIds: Set<EntityId>;
  nodeIds: Set<string>;
  /** Lit vision cells (row-major, visionCols × visionRows). */
  cells: Uint8Array;
}

/** Vision-cell grid of a terrain, with per-cell blocking / elevation flags. */
export interface VisionGrid {
  cellSize: number;
  cols: number;
  rows: number;
  /** The grid starts at (−offsetX, −offsetY): it overhangs the map equally on both sides. */
  offsetX: number;
  offsetY: number;
  /** Contains rock (blocks every ray). */
  rock: Uint8Array;
  /** At least half its area is high ground or cliff. */
  elevated: Uint8Array;
  /** LOS sets, keyed by `${cell}:${range}:${high}`. */
  /** Cached lit-cell sets: key (cell * 2 + high) → vision range → cells. */
  los: Map<number, Map<number, Int32Array>>;
}

const grids = new WeakMap<Terrain, VisionGrid>();

export function visionGridOf(t: Terrain): VisionGrid {
  let g = grids.get(t);
  if (g) return g;
  const cellSize = TERRAIN.visionCellSize;
  const tc = t.cellSize, W = t.cols * tc, H = t.rows * tc;
  const cols = Math.ceil(W / cellSize);
  const rows = Math.ceil(H / cellSize);
  const offsetX = (cols * cellSize - W) / 2, offsetY = (rows * cellSize - H) / 2;
  const rock = new Uint8Array(cols * rows);
  const elevated = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y0 = r * cellSize - offsetY, y1 = y0 + cellSize;
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellSize - offsetX, x1 = x0 + cellSize;
      // Nav cells overlapping this vision cell, weighted by overlap area.
      let high = 0;
      for (let nr = Math.max(0, Math.floor(y0 / tc)); nr < Math.min(t.rows, Math.ceil(y1 / tc)); nr++) {
        const hy = Math.min(y1, (nr + 1) * tc) - Math.max(y0, nr * tc);
        for (let nc = Math.max(0, Math.floor(x0 / tc)); nc < Math.min(t.cols, Math.ceil(x1 / tc)); nc++) {
          const hx = Math.min(x1, (nc + 1) * tc) - Math.max(x0, nc * tc);
          const code = t.cells[nr * t.cols + nc];
          if (code === T_ROCK) rock[r * cols + c] = 1;
          if (code === T_HIGH || code === T_CLIFF) high += hx * hy;
        }
      }
      if (high * 2 >= cellSize * cellSize) elevated[r * cols + c] = 1;
    }
  }
  g = { cellSize, cols, rows, offsetX, offsetY, rock, elevated, los: new Map() };
  grids.set(t, g);
  return g;
}

/** Vision cell of a point (boundary points go toward the map's centre lines, so this is symmetric under both map symmetries). */
export function visionCellOf(g: VisionGrid, x: number, y: number): number {
  return centreTieCell((y + g.offsetY) / g.cellSize, g.rows) * g.cols + centreTieCell((x + g.offsetX) / g.cellSize, g.cols);
}

/** Cell index of grid coordinate f on an n-cell axis; a boundary goes to the cell nearer the centre. */
function centreTieCell(f: number, n: number): number {
  const raw = f < n / 2 ? Math.floor(f) : Math.ceil(f) - 1;
  return Math.min(n - 1, Math.max(0, raw));
}

/** Cells covering coordinate v on one axis: one cell, or both neighbours when v lies on a boundary. */
function axisCells(v: number, size: number, n: number, out: number[]): number {
  const f = v / size;
  const lo = Math.floor(f);
  let m = 0;
  if (f === lo && lo > 0 && lo - 1 < n) out[m++] = lo - 1;
  if (lo >= 0 && lo < n) out[m++] = lo;
  return m;
}

const xs = [0, 0], ys = [0, 0];

/** The cells lit by a source in cell `src` with vision `range` (px). Cached per grid. */
function losSet(g: VisionGrid, src: number, range: number, high: boolean): Int32Array {
  const key = src * 2 + (high ? 1 : 0);
  let byRange = g.los.get(key);
  if (!byRange) g.los.set(key, (byRange = new Map()));
  const hit = byRange.get(range);
  if (hit) return hit;
  const cs = g.cellSize;
  const sc = src % g.cols, sr = (src - sc) / g.cols;
  const sx = (sc + 0.5) * cs, sy = (sr + 0.5) * cs;
  const reach = range + cs / 2;
  const span = Math.ceil(reach / cs);
  const out: number[] = [];
  for (let r = Math.max(0, sr - span); r <= Math.min(g.rows - 1, sr + span); r++) {
    for (let c = Math.max(0, sc - span); c <= Math.min(g.cols - 1, sc + span); c++) {
      const tx = (c + 0.5) * cs, ty = (r + 0.5) * cs;
      if ((tx - sx) ** 2 + (ty - sy) ** 2 > reach * reach) continue;
      const tgt = r * g.cols + c;
      if (tgt !== src && !high && g.elevated[tgt]) continue;
      if (tgt === src || rayClear(g, sx, sy, tx, ty, src, tgt, high)) out.push(tgt);
    }
  }
  const set = Int32Array.from(out);
  byRange.set(range, set);
  return set;
}

function rayClear(g: VisionGrid, sx: number, sy: number, tx: number, ty: number, src: number, tgt: number, high: boolean): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(tx - sx, ty - sy) / (g.cellSize / 2)));
  for (let k = 1; k < n; k++) {
    const x = sx + ((tx - sx) * k) / n, y = sy + ((ty - sy) * k) / n;
    const mx = axisCells(x, g.cellSize, g.cols, xs);
    const my = axisCells(y, g.cellSize, g.rows, ys);
    for (let i = 0; i < mx; i++) {
      for (let j = 0; j < my; j++) {
        const cell = ys[j] * g.cols + xs[i];
        if (cell === src || cell === tgt) continue;
        if (g.rock[cell] || (!high && g.elevated[cell])) return false;
      }
    }
  }
  return true;
}

function isVisionSource(e: MatchEntity): boolean {
  return e.health > 0 || (e.type === "building" && e.constructionProgress < 100);
}

export function computeVisibility(match: MatchState): void {
  const t = match.terrain;
  const g = visionGridOf(t);
  const allEntities = Array.from(match.entities.values());
  const visibility = new Map<PlayerId, PlayerVision>();

  for (const p of match.players) {
    if (!p) continue;
    const playerId = p.playerId;
    const vis: PlayerVision = { entityIds: new Set(), nodeIds: new Set(), cells: new Uint8Array(g.cols * g.rows) };
    visibility.set(playerId, vis);

    // Light the cells each of the player's sources can see; note which brush patches they stand in.
    const patches = new Set<number>();
    const lit = new Set<Int32Array>(); // sources sharing a cell, range and height light the same cells
    for (const src of allEntities) {
      if (src.ownerId !== playerId || !isVisionSource(src)) continue;
      // Every player always sees their own living entities (safety guarantee)
      vis.entityIds.add(src.id);
      const range = getVisionRange(src, t);
      const set = losSet(g, visionCellOf(g, src.x, src.y), range, onHighGround(src, t));
      if (!lit.has(set)) {
        lit.add(set);
        for (let i = 0; i < set.length; i++) vis.cells[set[i]] = 1;
      }
      if (t.any) {
        const patch = t.brushPatch[terrainCellOf(t, src.x, src.y)];
        if (patch) patches.add(patch);
      }
    }

    for (const target of allEntities) {
      if (target.health <= 0 || target.ownerId === playerId) continue;
      if (!vis.cells[visionCellOf(g, target.x, target.y)]) continue;
      if (t.any) {
        const nav = terrainCellOf(t, target.x, target.y);
        if (t.cells[nav] === T_BRUSH && !patches.has(t.brushPatch[nav])) continue;
      }
      vis.entityIds.add(target.id);
    }

    // Attackers are revealed to their victims.
    for (const a of match.attackLog) {
      if (a.isHeal) continue;
      const victim = match.entities.get(a.targetId);
      const attacker = match.entities.get(a.attackerId);
      if (attacker && attacker.health > 0 && victim?.ownerId === playerId) vis.entityIds.add(attacker.id);
    }

    for (const node of match.resourceNodes) {
      if (vis.cells[visionCellOf(g, node.x, node.y)]) vis.nodeIds.add(node.id);
    }
  }

  match.visibilityData = visibility;
}

/** Is `target` visible to `playerId` (as of the last visibility pass)? Visible when no data exists yet. */
export function isVisibleTo(match: MatchState, playerId: PlayerId, target: MatchEntity): boolean {
  if (target.ownerId === playerId) return true;
  const vis = match.visibilityData?.get(playerId);
  return !vis || vis.entityIds.has(target.id);
}

/** Packed bitset of a player's lit vision cells, base64 (for the client fog). */
export function encodeVision(cells: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(cells.length / 8));
  for (let i = 0; i < cells.length; i++) if (cells[i]) bytes[i >> 3] |= 1 << (i & 7);
  return Buffer.from(bytes).toString("base64");
}
