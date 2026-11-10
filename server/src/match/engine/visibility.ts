/**
 * Fog of war with terrain line of sight (G-6b).
 *
 * Vision is resolved on a coarse grid (TERRAIN.visionCellSize px, 2×2 nav
 * cells). Each vision source lights the cells whose centre is within its
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
  /** Contains rock (blocks every ray). */
  rock: Uint8Array;
  /** At least 2 of its nav cells are high ground or cliff. */
  elevated: Uint8Array;
  /** LOS sets, keyed by `${cell}:${range}:${high}`. */
  los: Map<string, Int32Array>;
}

const grids = new WeakMap<Terrain, VisionGrid>();

export function visionGridOf(t: Terrain): VisionGrid {
  let g = grids.get(t);
  if (g) return g;
  const cellSize = TERRAIN.visionCellSize;
  const k = cellSize / t.cellSize; // nav cells per vision cell (2)
  const cols = Math.ceil(t.cols / k);
  const rows = Math.ceil(t.rows / k);
  const rock = new Uint8Array(cols * rows);
  const elevated = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let high = 0;
      for (let dr = 0; dr < k; dr++) {
        for (let dc = 0; dc < k; dc++) {
          const nr = r * k + dr, nc = c * k + dc;
          if (nr >= t.rows || nc >= t.cols) continue;
          const code = t.cells[nr * t.cols + nc];
          if (code === T_ROCK) rock[r * cols + c] = 1;
          if (code === T_HIGH || code === T_CLIFF) high++;
        }
      }
      if (high >= 2) elevated[r * cols + c] = 1;
    }
  }
  g = { cellSize, cols, rows, rock, elevated, los: new Map() };
  grids.set(t, g);
  return g;
}

/** Vision cell of a point (boundary points go toward the map's centre line, mirror-safe). */
export function visionCellOf(g: VisionGrid, x: number, y: number): number {
  const fx = x / g.cellSize;
  const colRaw = fx < g.cols / 2 ? Math.floor(fx) : Math.ceil(fx) - 1;
  const col = Math.min(g.cols - 1, Math.max(0, colRaw));
  const row = Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cellSize)));
  return row * g.cols + col;
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
  const key = `${src}:${range}:${high ? 1 : 0}`;
  const hit = g.los.get(key);
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
  g.los.set(key, set);
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
    for (const src of allEntities) {
      if (src.ownerId !== playerId || !isVisionSource(src)) continue;
      // Every player always sees their own living entities (safety guarantee)
      vis.entityIds.add(src.id);
      const range = getVisionRange(src, t);
      const set = losSet(g, visionCellOf(g, src.x, src.y), range, onHighGround(src, t));
      for (let i = 0; i < set.length; i++) vis.cells[set[i]] = 1;
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
