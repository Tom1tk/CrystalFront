// Action space v3 (G-13 Phase B; v2 was G-10 M0 T5, R-2).
//
// One decision every DECISION_TICKS ticks = one economy action + one army order.
//   economy: kind (noop, train, build, move workers to a node, repair, rally, cancel)
//            → build site (named site or own-frame grid cell)
//            | own-entity pointer (repair / rally / cancel) → rally point
//   army:    group → order → unit pointer (group `unit`) → point target or entity pointer,
//            each masked given the previous choices
// Point targets are named map anchors (T3) in the acting seat's own frame, one of
// the seat's enemy-memory slots (filled by the observation, T6) or a cell of the
// own-frame 50 × 15 grid (the observation grid). Entity pointers index the rows
// of the seat's last observation (`SeatState.rows`). Nothing here uses map-width
// fractions. Heads that do not apply to the chosen action are ignored (0).
//
// Rule P-8: a legal action must do something. Every mask below is computed with
// the same checks the engine applies, and `applyV2` reports whether the action
// changed anything; scripted play must have an ineffective rate of 0.
import type { MatchEntity, MatchState } from "../../../server/src/match/types.js";
import type { MatchEngine } from "../../../server/src/match/matchEngine.js";
import { BUILDING_DEFS, UNIT_DEFS } from "@crystalfront/shared";
import { validateBuildSite } from "../../../server/src/match/buildingValidation.js";
import { anchorsConnected, footprintOf, type Rect } from "../../../server/src/match/engine/navGrid.js";
import { anchorsFor } from "../../../server/src/match/maps.js";
import { ANCHOR_MAX, padSlots, seatAnchors, type Pt } from "../../../server/src/match/engine/anchors.js";
import { isIdleWorker } from "../actionSpace.js";
import { frameFor, fromOwnFrame, offsetToWorld, type Frame } from "./frame.js";
import { isObstacleCode, rectTouches, terrainAt, T_BRUSH } from "../../../server/src/match/engine/terrain.js";
import { PLACEMENT } from "@crystalfront/shared";

export const DECISION_TICKS = 8;
/** Action space version (wire format and head layout). */
export const ACTION_SPACE_VERSION = 3;

/** Own-frame grid (also the observation grid). 5000×900 → 50×15; smaller maps leave cells invalid. */
export const GRID_CELL_W = 100;
export const GRID_CELL_H = 60;
export const GRID_COLS = 50;
export const GRID_ROWS = 15;
export const GRID_CELLS = GRID_COLS * GRID_ROWS; // 750
/** Entity pointer size = observation entity rows. */
export const PTR_SIZE = 200;

// ---- Economy head ----
export const TRAIN_UNITS = ["worker", "skirmisher", "gunner", "bruiser", "medic"] as const;
export const BUILDINGS = ["barracks", "foundry", "supply_depot", "turret"] as const;
/** Build sites, own frame: own base, own pockets, own chokes, centre anchors. */
export const NAMED_SITES = 1 + ANCHOR_MAX.pockets + ANCHOR_MAX.chokes + ANCHOR_MAX.centre; // 10
/** Build site head: named sites, then grid cells (cell centre). */
export const BUILD_SITES = NAMED_SITES + GRID_CELLS; // 760
/** Node slots: own safe nodes, then contested nodes. */
export const NODE_SLOTS = ANCHOR_MAX.safeNodes + ANCHOR_MAX.nodes; // 16
/**
 * Workers moved by one assign action. The plan's {1, 2, all idle} assumed idle
 * workers; with the worker autopilot there rarely are any, so assign moves
 * gathering workers instead and "all idle" becomes 4.
 */
export const WORKER_COUNTS = [1, 2, 4] as const;

export const ECON_TRAIN0 = 1;
export const ECON_BUILD0 = ECON_TRAIN0 + TRAIN_UNITS.length;                  // 6  (+ building; site head)
export const ECON_ASSIGN0 = ECON_BUILD0 + BUILDINGS.length;                   // 10
export const ECON_REPAIR = ECON_ASSIGN0 + NODE_SLOTS * WORKER_COUNTS.length;  // 58 (econ pointer: own building)
export const ECON_RALLY = ECON_REPAIR + 1;                                    // 59 (econ pointer: producer; econ target)
export const ECON_CANCEL = ECON_RALLY + 1;                                    // 60 (econ pointer: producer with a queue)
export const ECON_SIZE = ECON_CANCEL + 1;                                     // 61
/** Econ pointer mask rows: repair, rally, cancel. */
export const ECON_PTR_KINDS = ["repair", "rally", "cancel"] as const;

// ---- Army head ----
export const GROUPS = ["none", "all_combat", "army_a", "army_b", "skirmishers", "gunners", "bruisers", "medics", "scout", "unit"] as const;
export const ORDERS = ["none", "attack_move", "move", "guard", "guard_here", "retreat", "focus", "heal", "stop", "join_a", "join_b"] as const;
/** Orders that take a point target; orders that take an entity pointer. */
export const POINT_ORDERS: ReadonlySet<string> = new Set(["attack_move", "move", "guard"]);
export const PTR_ORDERS: ReadonlySet<string> = new Set(["focus", "heal"]);
export type Group = typeof GROUPS[number];
export type Order = typeof ORDERS[number];

/** Anchor targets, own frame. */
export const ANCHOR_TARGETS = [
  ["own_base", 1], ["own_pockets", ANCHOR_MAX.pockets], ["own_chokes", ANCHOR_MAX.chokes],
  ["centre", ANCHOR_MAX.centre], ["nodes", ANCHOR_MAX.nodes], ["own_safe", ANCHOR_MAX.safeNodes],
  ["enemy_base", 1], ["enemy_pockets", ANCHOR_MAX.pockets], ["enemy_chokes", ANCHOR_MAX.chokes],
  ["enemy_safe", ANCHOR_MAX.safeNodes],
] as const;
export const N_ANCHOR_TARGETS = ANCHOR_TARGETS.reduce((s, [, n]) => s + n, 0); // 37
export const MEMORY_SLOTS = 16;
export const TARGET_MEMORY0 = N_ANCHOR_TARGETS;
export const TARGET_GRID0 = N_ANCHOR_TARGETS + MEMORY_SLOTS; // 53
export const TARGET_NONE = TARGET_GRID0 + GRID_CELLS; // 803
export const TARGET_SIZE = TARGET_NONE + 1; // 804

const COMBAT = new Set(["skirmisher", "gunner", "bruiser", "medic"]);
const MOVABLE = new Set(["worker", "skirmisher", "gunner", "bruiser", "medic"]);
const FAST = new Set(["skirmisher", "medic"]);
/** Producers keep at most this many units queued (a busy producer is not "free"). */
export const PRODUCER_QUEUE_MAX = 2;
/** Units within this distance of their crystal count as home for `retreat`. */
const HOME_RADIUS = 250;
/** Nodes with less than this left are not worker targets (as in v1). */
const MIN_NODE_REMAINING = 5;

/**
 * One decision. `site` applies to build, `econPtr` to repair/rally/cancel,
 * `econTarget` to rally, `unit` to group `unit`, `target` to point orders
 * (TARGET_NONE otherwise), `ptr` to focus/heal. Heads that do not apply are ignored.
 */
export interface V2Action {
  econ: number; site: number; econPtr: number; econTarget: number;
  group: number; order: number; unit: number; target: number; ptr: number;
}

export const NOOP_ACTION: V2Action = { econ: 0, site: 0, econPtr: 0, econTarget: 0, group: 0, order: 0, unit: 0, target: TARGET_NONE, ptr: 0 };
/** A full action from the parts a caller sets (the rest are no-op defaults). */
export const act = (a: Partial<V2Action>): V2Action => ({ ...NOOP_ACTION, ...a });

/** Per-seat harness state, reset per episode. */
export interface SeatState {
  playerId: string;
  frame: Frame;
  /** Own-frame anchor targets in world coordinates, with validity. */
  targets: Pt[];
  targetValid: boolean[];
  /** Build sites (world) with validity. */
  sites: Pt[];
  siteValid: boolean[];
  /** Node slot → match node id (null = padding or not found). */
  nodeSlots: (string | null)[];
  armyA: Set<string>;
  armyB: Set<string>;
  scoutId: string | null;
  /** Enemy-memory slot positions (world), filled by observation v2 (T6). */
  memory: (Pt | null)[];
  /** Own-frame grid cells: a walkable world point per cell (null: none). */
  grid: (Pt | null)[];
  /** Grid cell centres (world) per building that pass the static placement rules (zone, bounds, terrain, nodes, crystal). */
  gridSites: boolean[][];
  /** Entity id per row of the last observation (pointer targets). */
  rows: string[];
  /** Grid-site seal results for one nav grid version (key building × GRID_CELLS + cell). */
  sealCache: { nav: unknown; version: number; ok: Map<number, boolean> };
  /** `contested`: economy actions cut short because the other seat wanted the same node slots or build spot this decision (applyV2Pair). */
  stats: { decisions: number; econIneffective: number; armyIneffective: number; autopilot: number; contested: number };
}

export function createSeatState(match: MatchState, playerId: string): SeatState {
  const frame = frameFor(match, playerId);
  const a = anchorsFor(match.config.mapId, frame.W, frame.H);
  const own = seatAnchors(a, frame.seat, frame.W, frame.H);
  const enemy = seatAnchors(a, frame.seat === 0 ? 1 : 0, frame.W, frame.H);
  const lists: Record<string, Pt[]> = {
    own_base: [own.base], own_pockets: own.pockets, own_chokes: own.chokes, centre: own.centre,
    nodes: own.nodes, own_safe: own.safeNodes,
    enemy_base: [enemy.base], enemy_pockets: enemy.pockets, enemy_chokes: enemy.chokes, enemy_safe: enemy.safeNodes,
  };
  const targets: Pt[] = [], targetValid: boolean[] = [];
  for (const [name, max] of ANCHOR_TARGETS) {
    const p = padSlots(lists[name], max);
    targets.push(...p.pts); targetValid.push(...p.valid);
  }
  const sites: Pt[] = [], siteValid: boolean[] = [];
  for (const [list, max] of [[[own.base], 1], [own.pockets, ANCHOR_MAX.pockets], [own.chokes, ANCHOR_MAX.chokes], [own.centre, ANCHOR_MAX.centre]] as Array<[Pt[], number]>) {
    const p = padSlots(list, max);
    sites.push(...p.pts); siteValid.push(...p.valid);
  }
  const nodeAt = (p: Pt) => match.resourceNodes.find((n) => n.x === p.x && n.y === p.y)?.id ?? null;
  const nodeSlots: (string | null)[] = [];
  for (const [list, max] of [[own.safeNodes, ANCHOR_MAX.safeNodes], [own.nodes, ANCHOR_MAX.nodes]] as Array<[Pt[], number]>) {
    for (let i = 0; i < max; i++) nodeSlots.push(i < list.length ? nodeAt(list[i]) : null);
  }
  const grid: (Pt | null)[] = [];
  const gridSites: boolean[][] = BUILDINGS.map(() => []);
  const t = match.terrain;
  for (let gr = 0; gr < GRID_ROWS; gr++) {
    for (let gc = 0; gc < GRID_COLS; gc++) {
      const x0 = gc * GRID_CELL_W, y0 = gr * GRID_CELL_H;
      let pt: Pt | null = null;
      if (x0 < frame.W && y0 < frame.H) {
        // Cell centre if walkable, else the first walkable nav cell centre in the cell (own frame, row-major).
        const cands: Pt[] = [{ x: x0 + GRID_CELL_W / 2, y: y0 + GRID_CELL_H / 2 }];
        for (let y = y0 + t.cellSize / 2; y < Math.min(frame.H, y0 + GRID_CELL_H); y += t.cellSize) {
          for (let x = x0 + t.cellSize / 2; x < Math.min(frame.W, x0 + GRID_CELL_W); x += t.cellSize) cands.push({ x, y });
        }
        for (const c of cands) {
          const w = fromOwnFrame(frame, c);
          if (w.x < frame.W && w.y < frame.H && !isObstacleCode(terrainAt(t, w.x, w.y))) { pt = w; break; }
        }
      }
      grid.push(pt);
      const centre = x0 + GRID_CELL_W / 2 <= frame.W && y0 + GRID_CELL_H / 2 <= frame.H
        ? fromOwnFrame(frame, { x: x0 + GRID_CELL_W / 2, y: y0 + GRID_CELL_H / 2 }) : null;
      BUILDINGS.forEach((b, bi) => { gridSites[bi].push(!!centre && staticSiteOk(match, playerId, b, centre)); });
    }
  }
  return {
    playerId, frame, targets, targetValid, sites, siteValid, nodeSlots,
    armyA: new Set(), armyB: new Set(), scoutId: null,
    memory: new Array(MEMORY_SLOTS).fill(null),
    grid, gridSites, rows: [], sealCache: { nav: null, version: -1, ok: new Map() },
    stats: { decisions: 0, econIneffective: 0, armyIneffective: 0, autopilot: 0, contested: 0 },
  };
}

// ---- Decoding ----

export type EconAction =
  | { kind: "noop" }
  | { kind: "train"; unit: typeof TRAIN_UNITS[number] }
  | { kind: "build"; building: typeof BUILDINGS[number] }
  | { kind: "assign"; slot: number; count: number }
  | { kind: "repair" } | { kind: "rally" } | { kind: "cancel" };

export function decodeEcon(i: number): EconAction {
  if (!Number.isInteger(i) || i <= 0 || i >= ECON_SIZE) return { kind: "noop" };
  if (i < ECON_BUILD0) return { kind: "train", unit: TRAIN_UNITS[i - ECON_TRAIN0] };
  if (i < ECON_ASSIGN0) return { kind: "build", building: BUILDINGS[i - ECON_BUILD0] };
  if (i < ECON_REPAIR) {
    const j = i - ECON_ASSIGN0;
    return { kind: "assign", slot: Math.floor(j / WORKER_COUNTS.length), count: WORKER_COUNTS[j % WORKER_COUNTS.length] };
  }
  return i === ECON_REPAIR ? { kind: "repair" } : i === ECON_RALLY ? { kind: "rally" } : { kind: "cancel" };
}

export function encodeEcon(a: EconAction): number {
  switch (a.kind) {
    case "noop": return 0;
    case "train": return ECON_TRAIN0 + TRAIN_UNITS.indexOf(a.unit);
    case "build": return ECON_BUILD0 + BUILDINGS.indexOf(a.building);
    case "assign": return ECON_ASSIGN0 + a.slot * WORKER_COUNTS.length + WORKER_COUNTS.indexOf(a.count as 1 | 2 | 4);
    case "repair": return ECON_REPAIR;
    case "rally": return ECON_RALLY;
    case "cancel": return ECON_CANCEL;
  }
}

// ---- Helpers ----

function seatIdx(match: MatchState, playerId: string): number {
  return match.players.findIndex((p) => p?.playerId === playerId);
}

function ownCrystal(match: MatchState, playerId: string): MatchEntity | undefined {
  for (const e of match.entities.values()) if (e.type === "crystal" && e.ownerId === playerId) return e;
}

function queuedSupply(match: MatchState, playerId: string): number {
  let s = 0;
  for (const e of match.entities.values()) {
    if (e.ownerId === playerId && e.type === "building") for (const q of e.productionQueue ?? []) s += q.supplyCost;
  }
  return s;
}

/** The free finished producer of `unit` with the shortest queue, if training is affordable now. */
function producerFor(match: MatchState, playerId: string, unit: string): MatchEntity | null {
  const eco = match.economy[seatIdx(match, playerId)];
  if (!eco) return null;
  if (unit === "worker") {
    const c = ownCrystal(match, playerId);
    const cfg = match.config;
    return c && eco.resources >= cfg.workerTrainCost && eco.supply + cfg.workerSupplyCost <= eco.maxSupply ? c : null;
  }
  const def = UNIT_DEFS[unit];
  if (eco.resources < def.cost || eco.supply + queuedSupply(match, playerId) + def.supplyCost > eco.maxSupply) return null;
  let best: MatchEntity | null = null;
  for (const e of match.entities.values()) {
    if (e.type !== "building" || e.ownerId !== playerId || e.constructionProgress < 100) continue;
    if (!e.buildingType || !BUILDING_DEFS[e.buildingType]?.produces?.includes(unit)) continue;
    const q = e.productionQueue?.length ?? 0;
    if (q >= PRODUCER_QUEUE_MAX) continue;
    if (!best || q < (best.productionQueue?.length ?? 0)) best = e;
  }
  return best;
}

function builder(match: MatchState, s: SeatState): MatchEntity | null {
  let best: MatchEntity | null = null;
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== s.playerId || e.buildTargetId || e.id === s.scoutId) continue;
    if (!best || (isIdleWorker(match, e) && !isIdleWorker(match, best))) best = e;
  }
  return best;
}

/** Repair: the nearest worker that is not building and not the scout (ties by id). */
function repairer(match: MatchState, s: SeatState, b: MatchEntity): MatchEntity | null {
  let best: MatchEntity | null = null, bd = Infinity;
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== s.playerId || e.buildTargetId || e.id === s.scoutId) continue;
    const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
    if (d < bd || (d === bd && best && e.id < best.id)) { best = e; bd = d; }
  }
  return best;
}

// ---- Build placement ----
//
// validateBuildSite is exact but slow for ~4 × 760 sites per decision, so the
// masks split it into the same checks with the same arithmetic: the rules that
// never change in a match (staticSiteOk: zone, centre strip, bounds, terrain,
// nodes, own crystal), the ones that depend on where entities stand (one pass
// over the entities per decision, PlaceCtx) and the no-seal rule (cached per
// nav-grid version). A test checks the result against validateBuildSite.

/** Placement rules that never change during a match (validatePlacement's zone, bounds, node and crystal checks; terrain). */
function staticSiteOk(match: MatchState, playerId: string, b: typeof BUILDINGS[number], p: Pt): boolean {
  const def = BUILDING_DEFS[b], W = match.config.mapWidth, H = match.config.mapHeight;
  const halfW = def.width / 2, halfH = def.height / 2;
  const x1 = p.x - halfW, x2 = p.x + halfW, y1 = p.y - halfH, y2 = p.y + halfH, midX = W / 2;
  const blue = (match.players.find((q) => q?.playerId === playerId)?.color ?? "blue") === "blue";
  if (blue ? x2 > midX : x1 < midX) return false;
  if (x2 > midX - PLACEMENT.centerExclusionHalfWidth && x1 < midX + PLACEMENT.centerExclusionHalfWidth) return false;
  if (x1 < 0 || x2 > W || y1 < 0 || y2 > H) return false;
  for (const n of match.resourceNodes) {
    const dx = p.x - n.x, dy = p.y - n.y;
    if (Math.sqrt(dx * dx + dy * dy) < n.radius + halfW) return false;
  }
  for (const c of match.entities.values()) {
    if (c.type !== "crystal" || c.ownerId !== playerId) continue;
    const dx = p.x - c.x, dy = p.y - c.y;
    if (Math.sqrt(dx * dx + dy * dy) < PLACEMENT.crystalNoBuildRadius) return false;
  }
  return !rectTouches(match.terrain, x1, y1, x2, y2, (c) => isObstacleCode(c) || c === T_BRUSH);
}

/** Per-decision placement data: entity boxes (x1, y1, x2, y2) and building centres (x, y), flat. */
interface PlaceCtx { boxes: number[]; bpos: number[]; crystalRects: Rect[] }

function placeCtx(match: MatchState): PlaceCtx {
  const boxes: number[] = [], bpos: number[] = [], crystalRects: Rect[] = [];
  for (const e of match.entities.values()) {
    if (e.type === "resource_node") continue;
    boxes.push(e.x - e.radius, e.y - e.radius, e.x + e.radius, e.y + e.radius);
    if (e.type === "building") bpos.push(e.x, e.y);
    if (e.type === "crystal") crystalRects.push(footprintOf(e) as Rect);
  }
  return { boxes, bpos, crystalRects };
}

/** validatePlacement's entity overlap and spacing checks. */
function dynamicSiteOk(pc: PlaceCtx, b: typeof BUILDINGS[number], x: number, y: number): boolean {
  const def = BUILDING_DEFS[b];
  const bx1 = x - def.width / 2, by1 = y - def.height / 2, bx2 = x + def.width / 2, by2 = y + def.height / 2;
  const B = pc.boxes;
  for (let i = 0; i < B.length; i += 4) if (bx1 < B[i + 2] && bx2 > B[i] && by1 < B[i + 3] && by2 > B[i + 1]) return false;
  const P = pc.bpos;
  for (let i = 0; i < P.length; i += 2) {
    const dx = x - P[i], dy = y - P[i + 1];
    if (Math.sqrt(dx * dx + dy * dy) < PLACEMENT.minSpacing) return false;
  }
  return true;
}

/** The no-seal rule (validateBuildSite's last check). */
function sealOk(match: MatchState, pc: PlaceCtx, b: typeof BUILDINGS[number], x: number, y: number): boolean {
  return anchorsConnected(match.nav, pc.crystalRects, footprintOf({ type: "building", x, y, radius: 0, buildingType: b }) ?? undefined);
}

/** Grid site g passes every rule for building bi (static rules from SeatState, seal result cached per nav version). */
function gridSiteOk(match: MatchState, s: SeatState, pc: PlaceCtx, bi: number, g: number): boolean {
  if (!s.gridSites[bi][g]) return false;
  const b = BUILDINGS[bi], p = gridCentre(s, g);
  if (!dynamicSiteOk(pc, b, p.x, p.y)) return false;
  const c = s.sealCache;
  if (c.nav !== match.nav || c.version !== match.nav.version) { c.nav = match.nav; c.version = match.nav.version; c.ok.clear(); }
  const k = bi * GRID_CELLS + g;
  let ok = c.ok.get(k);
  if (ok === undefined) { ok = sealOk(match, pc, b, p.x, p.y); c.ok.set(k, ok); }
  return ok;
}

/** World centre of own-frame grid cell g. */
function gridCentre(s: SeatState, g: number): Pt {
  return fromOwnFrame(s.frame, { x: (g % GRID_COLS) * GRID_CELL_W + GRID_CELL_W / 2, y: Math.floor(g / GRID_COLS) * GRID_CELL_H + GRID_CELL_H / 2 });
}

/** Own-frame placement offsets around a site: 40 px grid out to 120 px, nearest first. */
const SITE_OFFSETS: Array<[number, number]> = (() => {
  const o: Array<[number, number]> = [];
  for (let gx = -3; gx <= 3; gx++) for (let gy = -3; gy <= 3; gy++) o.push([gx * 40, gy * 40]);
  o.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || a[0] - b[0] || a[1] - b[1]);
  return o;
})();

/**
 * A valid placement for `building` at build site `site`, or null. Named sites
 * search own-frame offsets around the anchor, so both seats pick matching spots;
 * grid sites use the cell centre only.
 */
export function siteFor(match: MatchState, s: SeatState, building: typeof BUILDINGS[number], site: number, pc = placeCtx(match)): Pt | null {
  if (!Number.isInteger(site) || site < 0 || site >= BUILD_SITES) return null;
  if (site >= NAMED_SITES) {
    const g = site - NAMED_SITES;
    return gridSiteOk(match, s, pc, BUILDINGS.indexOf(building), g) ? gridCentre(s, g) : null;
  }
  if (!s.siteValid[site]) return null;
  const c = s.sites[site];
  for (const [dx, dy] of SITE_OFFSETS) {
    const o = offsetToWorld(s.frame, dx, dy);
    const x = c.x + o.x, y = c.y + o.y;
    if (staticSiteOk(match, s.playerId, building, { x, y }) && dynamicSiteOk(pc, building, x, y) && sealOk(match, pc, building, x, y)) return { x, y };
  }
  return null;
}

function nodeById(match: MatchState, id: string | null) {
  return id ? match.resourceNodes.find((n) => n.id === id) : undefined;
}

/** Workers that `assign` may move to a node: not building, not the scout, not already there; nearest first. */
function assignCandidates(match: MatchState, s: SeatState, node: { id: string; x: number; y: number }): MatchEntity[] {
  const out: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== s.playerId || e.buildTargetId || e.id === s.scoutId) continue;
    if (e.gatheringNodeId === node.id) continue;
    out.push(e);
  }
  const d = (e: MatchEntity) => (e.x - node.x) ** 2 + (e.y - node.y) ** 2;
  return out.sort((a, b) => d(a) - d(b) || (a.id < b.id ? -1 : 1));
}

function pruneArmies(match: MatchState, s: SeatState): void {
  for (const set of [s.armyA, s.armyB]) for (const id of set) if (!match.entities.has(id)) set.delete(id);
  if (s.scoutId && !match.entities.has(s.scoutId)) s.scoutId = null;
}

function pickScout(match: MatchState, s: SeatState): MatchEntity | null {
  if (s.scoutId) {
    const e = match.entities.get(s.scoutId);
    if (e) return e;
  }
  let fast: MatchEntity | null = null, worker: MatchEntity | null = null;
  for (const e of match.entities.values()) {
    if (e.ownerId !== s.playerId) continue;
    if (FAST.has(e.type) && !e.moveTarget && !e.attackTargetId && !s.armyA.has(e.id) && !s.armyB.has(e.id)) { fast ??= e; }
    else if (e.type === "worker" && !e.buildTargetId) { if (!worker || (isIdleWorker(match, e) && !isIdleWorker(match, worker))) worker = e; }
  }
  return fast ?? worker;
}

/** Members of an army group (not `none` or `unit`). Does not assign the scout. */
function groupMembers(match: MatchState, s: SeatState, g: Group): MatchEntity[] {
  if (g === "scout") { const e = pickScout(match, s); return e ? [e] : []; }
  const out: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.ownerId !== s.playerId || !COMBAT.has(e.type)) continue;
    if (g === "all_combat" || (g === "army_a" && s.armyA.has(e.id)) || (g === "army_b" && s.armyB.has(e.id)) ||
        (g === "skirmishers" && e.type === "skirmisher") || (g === "gunners" && e.type === "gunner") ||
        (g === "bruisers" && e.type === "bruiser") || (g === "medics" && e.type === "medic")) out.push(e);
  }
  return out;
}

/** The own movable unit at pointer row `i`, if any. */
function unitAt(match: MatchState, s: SeatState, i: number): MatchEntity | null {
  const e = Number.isInteger(i) ? match.entities.get(s.rows[i] ?? "") : undefined;
  return e && e.ownerId === s.playerId && MOVABLE.has(e.type) && e.health > 0 ? e : null;
}

function isRetreating(e: MatchEntity, c: MatchEntity): boolean {
  return !!e.moveOrder && !e.moveOrder.attack && e.moveOrder.x === c.x && e.moveOrder.y === c.y;
}

/** Whether order `o` does something for unit `e` (target/pointer choice aside). */
function memberAccepts(match: MatchState, s: SeatState, g: Group, o: Order, e: MatchEntity, crystal: MatchEntity | undefined): boolean {
  switch (o) {
    case "none": return false;
    case "attack_move": case "move": case "guard": return true;
    case "guard_here": return !e.guard || !!e.moveTarget;
    case "retreat": return !!crystal && !isRetreating(e, crystal) && (e.x - crystal.x) ** 2 + (e.y - crystal.y) ** 2 > HOME_RADIUS ** 2;
    case "focus": return e.type !== "medic";
    case "heal": return e.type === "medic";
    case "stop": return !!(e.moveTarget || e.moveOrder || e.attackTargetId || e.healTargetId || e.guard);
    case "join_a": return g !== "scout" && COMBAT.has(e.type) && !s.armyA.has(e.id);
    case "join_b": return g !== "scout" && COMBAT.has(e.type) && !s.armyB.has(e.id);
  }
}

// ---- Masks ----

export interface V2Masks {
  econ: boolean[];          // [ECON_SIZE]
  site: boolean[][];        // [BUILDINGS][BUILD_SITES]
  econPtr: boolean[][];     // [ECON_PTR_KINDS][PTR_SIZE]
  econTarget: boolean[];    // [TARGET_SIZE] (rally point)
  group: boolean[];         // [G]
  order: boolean[][];       // [G][O]
  unit: boolean[][];        // [O][PTR_SIZE] (group `unit`)
  target: boolean[][];      // [O][T]
  ptr: boolean[][];         // [O][PTR_SIZE]
}

const PRODUCERS = new Set(["barracks", "foundry"]);
const isProducer = (e: MatchEntity) => e.type === "crystal" || (e.type === "building" && PRODUCERS.has(e.buildingType ?? "") && e.constructionProgress >= 100);

export function computeMasks(match: MatchState, s: SeatState): V2Masks {
  pruneArmies(match, s);
  const rowEnt = s.rows.map((id) => match.entities.get(id));
  const crystal = ownCrystal(match, s.playerId);

  // Point targets (move, attack-move, guard, rally).
  const points = new Array<boolean>(TARGET_SIZE).fill(false);
  for (let t = 0; t < N_ANCHOR_TARGETS; t++) points[t] = s.targetValid[t];
  for (let m = 0; m < MEMORY_SLOTS; m++) points[TARGET_MEMORY0 + m] = !!s.memory[m];
  for (let g = 0; g < GRID_CELLS; g++) points[TARGET_GRID0 + g] = !!s.grid[g];

  // Economy.
  const econ = new Array<boolean>(ECON_SIZE).fill(false);
  econ[0] = true;
  TRAIN_UNITS.forEach((u, i) => { econ[ECON_TRAIN0 + i] = !!producerFor(match, s.playerId, u); });
  const eco = match.economy[seatIdx(match, s.playerId)];
  const hasBuilder = !!builder(match, s);
  const site = BUILDINGS.map(() => new Array<boolean>(BUILD_SITES).fill(false));
  const pc = placeCtx(match);
  BUILDINGS.forEach((b, bi) => {
    if (!eco || !hasBuilder || eco.resources < BUILDING_DEFS[b].cost) return;
    for (let k = 0; k < NAMED_SITES; k++) site[bi][k] = !!siteFor(match, s, b, k, pc);
    for (let g = 0; g < GRID_CELLS; g++) site[bi][NAMED_SITES + g] = gridSiteOk(match, s, pc, bi, g);
    econ[ECON_BUILD0 + bi] = site[bi].some(Boolean);
  });
  for (let slot = 0; slot < NODE_SLOTS; slot++) {
    const node = nodeById(match, s.nodeSlots[slot]);
    if (!node || node.remaining < MIN_NODE_REMAINING) continue;
    const free = node.maxGathererSlots - node.gathererSlots.size;
    const cands = assignCandidates(match, s, node).length;
    WORKER_COUNTS.forEach((c, ci) => { econ[ECON_ASSIGN0 + slot * WORKER_COUNTS.length + ci] = free >= c && cands >= c; });
  }
  const econPtr = ECON_PTR_KINDS.map(() => new Array<boolean>(PTR_SIZE).fill(false));
  rowEnt.forEach((e, i) => {
    if (!e || e.ownerId !== s.playerId || i >= PTR_SIZE) return;
    // Repair: a finished, damaged building nobody repairs, and a worker to send.
    if (e.type === "building" && e.constructionProgress >= 100 && e.health < e.maxHealth &&
        !(e.repairTargetId && match.entities.has(e.repairTargetId)) && repairer(match, s, e)) econPtr[0][i] = true;
    if (isProducer(e)) {
      econPtr[1][i] = true;
      econPtr[2][i] = (e.productionQueue?.length ?? 0) > 0;
    }
  });
  econ[ECON_REPAIR] = econPtr[0].some(Boolean);
  econ[ECON_RALLY] = econPtr[1].some(Boolean);
  econ[ECON_CANCEL] = econPtr[2].some(Boolean);

  // Army.
  const enemyRows = new Array<boolean>(PTR_SIZE).fill(false);
  const hurtRows = new Array<boolean>(PTR_SIZE).fill(false);
  rowEnt.forEach((e, i) => {
    if (!e || i >= PTR_SIZE || e.health <= 0) return;
    if (e.ownerId !== s.playerId) enemyRows[i] = true;
    else if (MOVABLE.has(e.type) && e.health < e.maxHealth) hurtRows[i] = true;
  });
  const anyEnemy = enemyRows.some(Boolean), anyHurt = hurtRows.some(Boolean);
  const ptrOk = (o: Order) => (o === "focus" ? anyEnemy : o === "heal" ? anyHurt : true);

  const group: boolean[] = [], order: boolean[][] = [];
  const unit = ORDERS.map(() => new Array<boolean>(PTR_SIZE).fill(false));
  for (const g of GROUPS) {
    let row: boolean[];
    if (g === "none") row = ORDERS.map((o) => o === "none");
    else if (g === "unit") {
      rowEnt.forEach((e, i) => {
        if (i >= PTR_SIZE || !unitAt(match, s, i)) return;
        ORDERS.forEach((o, oi) => { unit[oi][i] = ptrOk(o) && memberAccepts(match, s, g, o, e!, crystal); });
      });
      row = unit.map((u) => u.some(Boolean));
    } else {
      const members = groupMembers(match, s, g);
      row = ORDERS.map((o) => ptrOk(o) && members.some((e) => memberAccepts(match, s, g, o, e, crystal)));
    }
    order.push(row);
    group.push(row.some(Boolean));
  }

  const noneOnly = new Array<boolean>(TARGET_SIZE).fill(false);
  noneOnly[TARGET_NONE] = true;
  const target = ORDERS.map((o) => (POINT_ORDERS.has(o) ? points.slice() : noneOnly.slice()));
  const nothing = new Array<boolean>(PTR_SIZE).fill(false);
  const ptr = ORDERS.map((o) => (o === "focus" ? enemyRows.slice() : o === "heal" ? hurtRows.slice() : nothing.slice()));
  return { econ, site, econPtr, econTarget: points, group, order, unit, target, ptr };
}

/** True if the action is allowed by the masks (heads that do not apply are not checked). */
export function isLegal(m: V2Masks, a: V2Action): boolean {
  if (!m.econ[a.econ]) return false;
  const ea = decodeEcon(a.econ);
  if (ea.kind === "build" && !m.site[BUILDINGS.indexOf(ea.building)]?.[a.site]) return false;
  if (ea.kind === "repair" && !m.econPtr[0][a.econPtr]) return false;
  if (ea.kind === "rally" && (!m.econPtr[1][a.econPtr] || !m.econTarget[a.econTarget])) return false;
  if (ea.kind === "cancel" && !m.econPtr[2][a.econPtr]) return false;
  if (!m.group[a.group] || !m.order[a.group]?.[a.order]) return false;
  if (GROUPS[a.group] === "unit" && !m.unit[a.order]?.[a.unit]) return false;
  if (!m.target[a.order]?.[a.target]) return false;
  if (PTR_ORDERS.has(ORDERS[a.order]) && !m.ptr[a.order]?.[a.ptr]) return false;
  return true;
}

// ---- Execution ----

type Cmd = Record<string, unknown>;

export interface ApplyResult {
  /** Commands the engine accepted, in order (for the command log). */
  accepted: Cmd[];
  econEffective: boolean;
  armyEffective: boolean;
}

function run(engine: MatchEngine, match: MatchState, playerId: string, cmds: Cmd[], accepted: Cmd[]): boolean {
  let any = false;
  for (const c of cmds) {
    if (engine.processCommand(match.id, playerId, c as Parameters<MatchEngine["processCommand"]>[2]).success) {
      accepted.push(c); any = true;
    }
  }
  return any;
}

function targetPoint(s: SeatState, t: number): Pt | null {
  if (!Number.isInteger(t) || t < 0) return null;
  if (t < N_ANCHOR_TARGETS) return s.targetValid[t] ? s.targets[t] : null;
  if (t < TARGET_GRID0) return s.memory[t - TARGET_MEMORY0];
  if (t < TARGET_NONE) return s.grid[t - TARGET_GRID0];
  return null;
}

function rowEntity(match: MatchState, s: SeatState, i: number): MatchEntity | undefined {
  return Number.isInteger(i) ? match.entities.get(s.rows[i] ?? "") : undefined;
}

function econCommands(match: MatchState, s: SeatState, a: EconAction, act: V2Action): Cmd[] {
  switch (a.kind) {
    case "noop": return [];
    case "train": {
      const p = producerFor(match, s.playerId, a.unit);
      if (!p) return [];
      return a.unit === "worker"
        ? [{ type: "train_worker", entityId: p.id }]
        : [{ type: "train_unit", buildingId: p.id, entityId: p.id, unitType: a.unit }];
    }
    case "build": {
      const w = builder(match, s);
      const pos = w ? siteFor(match, s, a.building, act.site) : null;
      if (!w || !pos) return [];
      return [{ type: "build", buildingType: a.building, targetX: pos.x, targetY: pos.y, workerIds: [w.id], entityId: w.id }];
    }
    case "assign": {
      const node = nodeById(match, s.nodeSlots[a.slot]);
      if (!node) return [];
      return assignCandidates(match, s, node).slice(0, a.count).map((w) => ({ type: "gather", entityId: w.id, targetEntityId: node.id }));
    }
    case "repair": {
      const b = rowEntity(match, s, act.econPtr);
      const w = b && b.ownerId === s.playerId && b.type === "building" ? repairer(match, s, b) : null;
      return w ? [{ type: "repair", entityId: w.id, targetEntityId: b!.id }] : [];
    }
    case "rally": {
      const b = rowEntity(match, s, act.econPtr), p = targetPoint(s, act.econTarget);
      return b && p && b.ownerId === s.playerId && isProducer(b) ? [{ type: "set_rally", entityId: b.id, targetX: p.x, targetY: p.y }] : [];
    }
    case "cancel": {
      const b = rowEntity(match, s, act.econPtr);
      const n = b?.productionQueue?.length ?? 0;
      return b && n > 0 && b.ownerId === s.playerId ? [{ type: "cancel_queue", entityId: b.id, targetX: n - 1 }] : [];
    }
  }
}

function armyCommands(match: MatchState, s: SeatState, g: Group, o: Order, a: V2Action): Cmd[] | null {
  let members: MatchEntity[];
  if (g === "unit") { const e = unitAt(match, s, a.unit); members = e ? [e] : []; }
  else members = groupMembers(match, s, g);
  if (g === "scout" && members[0]) s.scoutId = members[0].id;
  const crystal = ownCrystal(match, s.playerId);
  const doers = members.filter((e) => memberAccepts(match, s, g, o, e, crystal));
  const ids = doers.map((e) => e.id);
  if (!ids.length) return [];
  switch (o) {
    case "attack_move": case "move": {
      const p = targetPoint(s, a.target);
      return p ? ids.map((id) => ({ type: o, entityId: id, targetX: p.x, targetY: p.y })) : [];
    }
    case "guard": {
      const p = targetPoint(s, a.target);
      return p ? [{ type: "guard", entityIds: ids, targetX: p.x, targetY: p.y }] : [];
    }
    case "guard_here": return doers.map((e) => ({ type: "guard", entityIds: [e.id], targetX: e.x, targetY: e.y }));
    case "retreat": return [{ type: "retreat", entityIds: ids }];
    case "focus": case "heal": {
      const t = rowEntity(match, s, a.ptr);
      if (!t || t.health <= 0) return [];
      if (o === "focus" ? t.ownerId === s.playerId : t.ownerId !== s.playerId || !MOVABLE.has(t.type)) return [];
      return ids.map((id) => ({ type: o === "focus" ? "attack" : "heal", entityId: id, targetEntityId: t.id }));
    }
    case "stop": return [{ type: "stop", entityIds: ids }];
    case "join_a": case "join_b": {
      const into = o === "join_a" ? s.armyA : s.armyB, out = o === "join_a" ? s.armyB : s.armyA;
      for (const id of ids) { into.add(id); out.delete(id); }
      return null; // harness-only, effective
    }
    case "none": return [];
  }
}

/**
 * Apply one decision for a seat. The caller checks legality first (or relies
 * on masks); an illegal or no-op part simply does nothing and is counted.
 */
export function applyV2(engine: MatchEngine, match: MatchState, s: SeatState, a: V2Action): ApplyResult {
  return applyResolved(engine, match, s, a, econCommands(match, s, decodeEcon(a.econ), a), false);
}

function applyResolved(engine: MatchEngine, match: MatchState, s: SeatState, a: V2Action, econCmds: Cmd[], contested: boolean): ApplyResult {
  pruneArmies(match, s);
  s.stats.decisions++;
  const accepted: Cmd[] = [];
  const ea = decodeEcon(a.econ);
  const econEffective = ea.kind === "noop" || run(engine, match, s.playerId, econCmds, accepted);
  if (contested) s.stats.contested++;
  else if (!econEffective) s.stats.econIneffective++;

  const g = GROUPS[a.group] ?? "none", o = ORDERS[a.order] ?? "none";
  let armyEffective = true;
  if (g !== "none") {
    const cmds = armyCommands(match, s, g, o, a);
    armyEffective = cmds === null || run(engine, match, s.playerId, cmds, accepted);
    if (!armyEffective) s.stats.armyIneffective++;
  }
  return { accepted, econEffective, armyEffective };
}

/** Deterministic coin (0 or 1) from the match seed and tick. */
function coin(match: MatchState): 0 | 1 {
  let h = (match.seed ^ Math.imul(match.tick + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) & 1) as 0 | 1;
}

/**
 * Apply both seats' decisions for one decision step without a first-mover edge.
 * The engine claims gather slots and build spots at command time, so on rotate
 * maps (where the centre node and centre site are shared) whichever seat was
 * applied first would win. Here contention is resolved first:
 * - both assign workers to the same node: the free slots are split evenly; an
 *   odd slot goes to the seat with fewer own workers on that node, else a coin;
 * - both build and the second spot is no longer valid after the first is
 *   placed: the coin decides who builds.
 * A seat that loses a contended action counts it in `stats.contested`, not as
 * ineffective. Everything else is order-independent.
 */
export function applyV2Pair(engine: MatchEngine, match: MatchState, seats: [SeatState, SeatState], actions: [V2Action, V2Action]): [ApplyResult, ApplyResult] {
  const ea = [decodeEcon(actions[0].econ), decodeEcon(actions[1].econ)];
  const cmds = [econCommands(match, seats[0], ea[0], actions[0]), econCommands(match, seats[1], ea[1], actions[1])];
  const contested = [false, false];
  const c = coin(match);
  const [a0, a1] = ea;
  if (a0.kind === "assign" && a1.kind === "assign" && seats[0].nodeSlots[a0.slot] === seats[1].nodeSlots[a1.slot]) {
    const node = nodeById(match, seats[0].nodeSlots[a0.slot])!;
    const free = node.maxGathererSlots - node.gathererSlots.size;
    if (cmds[0].length + cmds[1].length > free) {
      const want = [cmds[0].length, cmds[1].length];
      const half = Math.floor(free / 2);
      const got = [Math.min(want[0], half), Math.min(want[1], half)];
      let left = free - got[0] - got[1];
      while (left > 0 && (got[0] < want[0] || got[1] < want[1])) {
        let i: 0 | 1;
        if (got[0] >= want[0]) i = 1;
        else if (got[1] >= want[1]) i = 0;
        else {
          const on = seats.map((s) => [...node.gathererSlots].filter((id) => match.entities.get(id)?.ownerId === s.playerId).length);
          i = on[0] < on[1] ? 0 : on[1] < on[0] ? 1 : c;
        }
        got[i]++; left--;
      }
      for (const i of [0, 1]) {
        if (got[i] < want[i]) { contested[i] = true; cmds[i] = cmds[i].slice(0, got[i]); }
      }
    }
  }
  const first = c, second = (1 - c) as 0 | 1;
  const r: ApplyResult[] = [];
  r[first] = applyResolved(engine, match, seats[first], actions[first], cmds[first], contested[first]);
  if (a0.kind === "build" && a1.kind === "build" && r[first].econEffective && cmds[second].length) {
    const b = cmds[second][0] as { buildingType: typeof BUILDINGS[number]; targetX: number; targetY: number };
    if (!validateBuildSite(match, seats[second].playerId, b.buildingType, b.targetX, b.targetY).valid) {
      contested[second] = true; cmds[second] = [];
    }
  }
  r[second] = applyResolved(engine, match, seats[second], actions[second], cmds[second], contested[second]);
  return [r[0], r[1]];
}

/**
 * Worker autopilot (harness rule for bots and policy alike): send every idle
 * worker to the nearest own safe node that still has resources and a free slot.
 * Run before the seat's action each decision. Returns the accepted commands.
 */
export function workerAutopilot(engine: MatchEngine, match: MatchState, s: SeatState): Cmd[] {
  const accepted: Cmd[] = [];
  const safe = s.nodeSlots.slice(0, ANCHOR_MAX.safeNodes).map((id) => nodeById(match, id)).filter((n) => !!n);
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== s.playerId || e.id === s.scoutId || e.moveOrder) continue;
    if (!isIdleWorker(match, e)) continue;
    let best: (typeof safe)[number] | undefined, bd = Infinity;
    for (const n of safe) {
      if (n.remaining < MIN_NODE_REMAINING || n.gathererSlots.size >= n.maxGathererSlots) continue;
      const d = (n.x - e.x) ** 2 + (n.y - e.y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    if (best && run(engine, match, s.playerId, [{ type: "gather", entityId: e.id, targetEntityId: best.id }], accepted)) s.stats.autopilot++;
  }
  return accepted;
}
