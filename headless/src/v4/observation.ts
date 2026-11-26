// Observation v2 (G-10 M0 T6, R-1 / P-3).
//
// Everything is in the acting seat's own frame (frame.ts) and deterministic.
// Values are rounded to 4 decimals (`q`), so a state and its symmetric image
// with seats swapped give bit-identical observations even though W − (W − x)
// is not always exactly x in floating point.
//
// Blocks (sizes are exported for the Python side):
//   globals   GLOBAL_NAMES.length numbers
//   entities  own + currently visible enemy entities, ENTITY_F numbers each, at most MAX_ENTITIES rows
//   memory    MEMORY_SLOTS rows of MEMORY_F (slot 0: last-seen enemy army; 1..15: enemy buildings ever seen)
//   nodes     NODE_ROWS rows of NODE_F (own safe, enemy safe, contested)
//   grid      DYN_CHANNELS × rows × cols, channel-major, row-major; static channels come once per episode (`staticGrid`)
//
// Fogged blocks use only what `visibilityData` shows the seat. The enemy
// memory, last-seen counts and grid history are per-seat state (`ObsState`),
// reset per episode, updated once per decision.
import { isBeta, type MatchEntity, type MatchState } from "../../../server/src/match/types.js";
import { CONTROL, GUARD, SURGES, UNIT_DEFS, surgeStageAt } from "@crystalfront/shared";
import { getAttackCooldown, getDamage, getRange, getVisionRange } from "../../../server/src/match/engine/utils.js";
import { anchorsFor } from "../../../server/src/match/maps.js";
import { seatAnchors, type Pt } from "../../../server/src/match/engine/anchors.js";
import { T_BRUSH, T_CLIFF, T_HIGH, T_ROCK, T_ROUGH, T_WATER, terrainAt } from "../../../server/src/match/engine/terrain.js";
import { visionCellOf, visionGridOf } from "../../../server/src/match/engine/visibility.js";
import { TRAIN_MAX_TICKS } from "../episode.js";
import { fromOwnFrame, toOwnFrame } from "./frame.js";
import { BUILDINGS, DECISION_TICKS, GRID_CELL_H, GRID_CELL_W, MEMORY_SLOTS, N_ANCHOR_TARGETS, PRODUCER_QUEUE_MAX, PTR_SIZE, TRAIN_UNITS, type SeatState } from "./actions.js";

export const OBS_SCHEMA_VERSION = 8; // 6: Outrider (unit type, train counts), forward-builder flag; 7: Surge globals; 8: rebuild R1 (v4 layout, docs/REBUILD_R1_PLAN.md)

/** 4-decimal rounding; also turns −0 into 0. */
const q = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const cap1 = (v: number) => Math.min(1, v);
const AGE_SCALE = 1000;

const COMBAT = ["skirmisher", "gunner", "bruiser", "medic", "bulwark"] as const;
const COMBAT_SET = new Set<string>(COMBAT);
/** Entity type vocabulary (one-hot order). */
export const ENTITY_TYPES = ["crystal", "worker", "skirmisher", "gunner", "bruiser", "medic", "bulwark", "barracks", "foundry", "supply_depot", "turret", "outpost", "outrider"] as const;
export const MEMORY_TYPES = ["crystal", "barracks", "foundry", "supply_depot", "turret", "outpost"] as const;

function typeOf(e: MatchEntity): string | null {
  if (e.type === "building") return e.buildingType ?? null;
  if (e.type === "placeholder" || e.type === "resource_node") return null;
  return e.type;
}

export const GLOBAL_NAMES: string[] = [
  "resources", "supply", "max_supply",
  ...TRAIN_UNITS.map((u) => `own_${u}`),
  ...BUILDINGS.map((b) => `own_${b}_done`),
  ...BUILDINGS.map((b) => `own_${b}_building`),
  ...TRAIN_UNITS.map((u) => `queued_${u}`),
  "control_own", "control_enemy", "control_none", "control_progress_own", "control_progress_enemy",
  "nodes_held_own", "nodes_held_enemy",
  "tick",
  ...TRAIN_UNITS.flatMap((u) => [`seen_${u}`, `seen_${u}_age`]),
  ...BUILDINGS.flatMap((b) => [`seen_${b}`, `seen_${b}_age`]),
  "enemy_army_age",
  "army_a", "army_b", "builder",
  // Bulwark feedback over the last decision window: share of own ranged shots that enemy
  // bulwarks stopped, and share of enemy ranged shots that own bulwarks stopped.
  "shots_blocked", "shots_shielded",
  // Surges (mainline 0.10 §3): current stage / 3, time to the next stage (or to the cap after
  // Surge III) over 4 min, and time to the 20:00 cap over 20 min. All 0 / constant in 0.9 matches.
  "surge_stage", "surge_next", "cap_left",
  // Schema 8 (rebuild R1): threats near the own crystal and where the armies are. Counts of what
  // the seat sees (near-base buildings also from memory); timers in minutes, capped at 1.
  "enemy_buildings_near_base", "enemy_combat_near_base", "enemy_units_own_half", "enemy_workers_out_recent",
  "near_base_building_time", "raid_time", "nearest_enemy_to_base",
  "own_combat_near_base", "own_army_share_home", "own_army_share_enemy_half",
];

export const ENTITY_FEATURES: string[] = [
  "own", "enemy", ...ENTITY_TYPES.map((t) => `type_${t}`), "x", "y", "hp", "max_hp",
  "built", "queue", "queue_progress",
  "gathering", "building", "moving", "attack_moving", "attacking", "idle",
  "on_high", "on_brush", "on_rough", "army_a", "army_b", "builder", "guarding",
  // Bulwark cover order: this bulwark is covering a unit; this unit has a bulwark covering it.
  "covering", "covered",
  // Schema 8 (rebuild R1): unit facts (effective range and vision, speed, damage per second) and
  // relations to the observer's crystals and to the nearest opposing entities the seat sees.
  "range", "vision", "speed", "dps", "dist_own_crystal", "dist_enemy_crystal",
  "nearest_foe", "in_foe_range", "foes_in_range", "vx", "vy",
];
export const ENTITY_F = ENTITY_FEATURES.length;
/** Entity rows; also the action pointer size (row i = pointer i, `SeatState.rows`). */
export const MAX_ENTITIES = PTR_SIZE;

export const MEMORY_FEATURES: string[] = [
  "valid", "army", ...MEMORY_TYPES.map((t) => `type_${t}`), "x", "y", "hp", "age", "destroyed", "count", "built",
];
export const MEMORY_F = MEMORY_FEATURES.length;

export const NODE_FEATURES: string[] = [
  "valid", "x", "y", "own_safe", "enemy_safe", "contested", "visible", "ever_seen", "remaining",
  "held_own", "held_enemy", "own_workers", "enemy_workers",
];
export const NODE_F = NODE_FEATURES.length;
/** own safe, enemy safe, contested. */
export const NODE_ROWS = 4 + 4 + 12;

/** Grid cell size (px), shared with the action grid. 5000×900 → 50×15; both divide the nav cell (20 px) and the map exactly. */
export { GRID_CELL_W, GRID_CELL_H };
export const STATIC_CHANNELS = ["blocked", "rough", "high", "water", "brush"] as const;
export const DYN_CHANNELS = ["visible", "ever_seen", "since_seen", "own_army", "enemy_army_seen", "enemy_threat", "own_coverage"] as const;

export interface ObsV2 {
  schemaVersion: number;
  z: number;
  globals: number[];
  entities: number[][];
  memory: number[][];
  nodes: number[][];
  grid: number[];
}

export interface CriticV2 {
  /** This seat's blocks without fog (own frame). */
  self: Omit<ObsV2, "schemaVersion" | "z" | "memory">;
  /** The enemy seat's blocks without fog (its own frame). */
  enemy: Omit<ObsV2, "schemaVersion" | "z" | "memory">;
}

export interface OppLabels {
  units: number[];      // true enemy count per TRAIN_UNITS type
  buildings: number[];  // true enemy count per BUILDINGS type (finished or not)
  queued: number[];     // enemy units in production per TRAIN_UNITS type
  /** Own-frame anchor target index nearest the enemy army's centre, or N_ANCHOR_TARGETS (none). */
  armyAnchor: number;
}

interface MemEntry {
  id: string | null; // null: the army cluster
  type: string;
  x: number; y: number; // own frame, normalised and rounded
  hp: number; built: number; count: number;
  tick: number;
  destroyed: boolean;
}

export interface ObsState {
  /** Node row → match node id. */
  nodeRows: (string | null)[];
  mem: (MemEntry | null)[];
  seenCount: number[]; seenTick: number[]; // per TRAIN_UNITS then BUILDINGS
  armySeenTick: number;
  nodeSeen: Map<string, number>; // node id → last seen remaining fraction
  /** Per own-frame nav cell: tick last lit (−1 never). */
  lastLit: Int32Array;
  /** Per own-frame grid cell: last-seen enemy combat units. */
  enemySeen: Float64Array;
  /** Schema 8: own-frame position (normalised) and tick of every entity seen at the last decision (velocity). */
  lastPos: Map<string, { x: number; y: number; tick: number }>;
  /** Schema 8: enemy worker id → last tick it was seen outside its own half. */
  workersOut: Map<string, number>;
  /** Schema 8: tick the first near-base enemy building was seen (−1: none known now). */
  nearBaseSince: number;
  /** Schema 8: start and last tick of the current raid (enemy combat units seen near the crystal). */
  raidSince: number; raidLast: number;
}

interface Dims { W: number; H: number; gc: number; gr: number; nc: number; nr: number; kx: number; ky: number }

function dims(match: MatchState): Dims {
  const W = match.config.mapWidth, H = match.config.mapHeight, t = match.terrain;
  return { W, H, gc: Math.ceil(W / GRID_CELL_W), gr: Math.ceil(H / GRID_CELL_H), nc: t.cols, nr: t.rows, kx: GRID_CELL_W / t.cellSize, ky: GRID_CELL_H / t.cellSize };
}

/** World nav cell for an own-frame nav cell of seat `s`. */
function worldNavCell(s: SeatState, d: Dims, c: number, r: number): number {
  if (s.frame.seat === 0) return r * d.nc + c;
  const wc = d.nc - 1 - c, wr = s.frame.sym === "rotate" ? d.nr - 1 - r : r;
  return wr * d.nc + wc;
}

export function createObsState(match: MatchState, s: SeatState): ObsState {
  const d = dims(match);
  const a = anchorsFor(match.config.mapId, d.W, d.H);
  const enemySafe = seatAnchors(a, s.frame.seat === 0 ? 1 : 0, d.W, d.H).safeNodes;
  const nodeAt = (p: Pt) => match.resourceNodes.find((n) => n.x === p.x && n.y === p.y)?.id ?? null;
  const nodeRows: (string | null)[] = [
    ...s.nodeSlots.slice(0, 4),
    ...Array.from({ length: 4 }, (_, i) => (i < enemySafe.length ? nodeAt(enemySafe[i]) : null)),
    ...s.nodeSlots.slice(4, 16),
  ];
  return {
    nodeRows,
    mem: new Array(MEMORY_SLOTS).fill(null),
    seenCount: new Array(TRAIN_UNITS.length + BUILDINGS.length).fill(0),
    seenTick: new Array(TRAIN_UNITS.length + BUILDINGS.length).fill(-1),
    armySeenTick: -1,
    nodeSeen: new Map(),
    lastLit: new Int32Array(d.nc * d.nr).fill(-1),
    enemySeen: new Float64Array(d.gc * d.gr),
    lastPos: new Map(), workersOut: new Map(), nearBaseSince: -1, raidSince: -1, raidLast: -1,
  };
}

/** Static grid channels (own frame; maps are symmetric, so the same for both seats). Send once per episode. */
export function staticGrid(match: MatchState): { cols: number; rows: number; channels: readonly string[]; data: number[] } {
  const d = dims(match), t = match.terrain;
  const out = new Array(STATIC_CHANNELS.length * d.gc * d.gr).fill(0);
  const n = d.kx * d.ky, plane = d.gc * d.gr;
  for (let r = 0; r < d.nr; r++) for (let c = 0; c < d.nc; c++) {
    const code = t.cells[r * d.nc + c];
    const g = Math.floor(r / d.ky) * d.gc + Math.floor(c / d.kx);
    if (code === T_ROCK || code === T_CLIFF) out[g] += 1;
    if (code === T_ROUGH) out[plane + g] += 1;
    if (code === T_HIGH) out[2 * plane + g] += 1;
    if (code === T_WATER) out[3 * plane + g] += 1;
    if (code === T_BRUSH) out[4 * plane + g] += 1;
  }
  return { cols: d.gc, rows: d.gr, channels: STATIC_CHANNELS, data: out.map((v) => q(v / n)) };
}

interface Seen { e: MatchEntity; type: string; x: number; y: number; own: boolean }

function ownPos(s: SeatState, d: Dims, e: { x: number; y: number }): { x: number; y: number } {
  const p = toOwnFrame(s.frame, e);
  return { x: q(p.x / d.W), y: q(p.y / d.H) };
}

function gridIdx(d: Dims, x: number, y: number): number {
  return Math.min(d.gr - 1, Math.floor(y * d.gr)) * d.gc + Math.min(d.gc - 1, Math.floor(x * d.gc));
}

function sortSeen(a: Seen, b: Seen): number {
  return (+b.own === +a.own ? 0 : a.own ? 1 : -1) // enemies first
    || ENTITY_TYPES.indexOf(a.type as never) - ENTITY_TYPES.indexOf(b.type as never)
    || a.x - b.x || a.y - b.y || a.e.health - b.e.health || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0);
}

/** Entities this seat sees (own + visible enemy, or all with fog off), own-frame, sorted. */
function seenEntities(match: MatchState, s: SeatState, d: Dims, fog: boolean): Seen[] {
  const vis = match.visibilityData?.get(s.playerId);
  const out: Seen[] = [];
  for (const e of match.entities.values()) {
    const type = typeOf(e);
    if (!type || e.health <= 0 && !(e.type === "building" && e.constructionProgress < 100)) continue;
    const own = e.ownerId === s.playerId;
    if (!own && fog && vis && !vis.entityIds.has(e.id)) continue;
    const p = ownPos(s, d, e);
    out.push({ e, type, x: p.x, y: p.y, own });
  }
  return out.sort(sortSeen);
}

function entityRow(match: MatchState, s: SeatState, d: Dims, v: Seen, covered: Set<string>): number[] {
  const e = v.e;
  const head = e.productionQueue[0];
  const terr = terrainAt(match.terrain, v.x * d.W, v.y * d.H);
  const isBuilding = e.type === "building" || e.type === "crystal";
  const moving = !!e.moveOrder && !e.moveOrder.attack;
  const attackMoving = !!e.moveOrder && e.moveOrder.attack;
  const attacking = !!(e.attackTargetId || e.healTargetId || e.coverTargetId);
  const gathering = !!e.gatheringNodeId, building = !!e.buildTargetId;
  return [
    +v.own, +!v.own, ...ENTITY_TYPES.map((t) => +(t === v.type)), v.x, v.y,
    q(e.maxHealth > 0 ? e.health / e.maxHealth : 0), q(e.maxHealth / 1000),
    q(isBuilding ? e.constructionProgress / 100 : 1),
    q(e.productionQueue.length / PRODUCER_QUEUE_MAX),
    q(head && head.buildTime > 0 ? 1 - head.remainingTicks / head.buildTime : 0),
    +gathering, +building, +moving, +attackMoving, +attacking,
    +(!isBuilding && !moving && !attackMoving && !attacking && !gathering && !building),
    +(terr === T_HIGH), +(terr === T_BRUSH), +(terr === T_ROUGH),
    +(v.own && s.armyA.has(e.id)), +(v.own && s.armyB.has(e.id)), +(v.own && s.builderId === e.id),
    +!!e.guard,
    +!!e.coverTargetId, +covered.has(e.id),
  ];
}

function globalsRow(match: MatchState, s: SeatState, d: Dims, seen: Seen[], os: ObsState | null, cap: number): number[] {
  const seat = s.frame.seat, enemy = 1 - seat;
  const eco = match.economy[seat];
  const own = seen.filter((v) => v.own);
  const unitCount = (u: string) => own.filter((v) => v.type === u).length;
  const bDone = (b: string) => own.filter((v) => v.type === b && v.e.constructionProgress >= 100).length;
  const bBuild = (b: string) => own.filter((v) => v.type === b && v.e.constructionProgress < 100).length;
  const queued = (u: string) => own.reduce((n, v) => n + v.e.productionQueue.filter((it) => it.unitType === u).length, 0);
  const holder = match.control.holder;
  let heldOwn = 0, heldEnemy = 0, contested = 0;
  for (const n of match.resourceNodes) {
    if (!n.contested) continue;
    contested++;
    if (n.controller === seat) heldOwn++;
    else if (n.controller === enemy) heldEnemy++;
  }
  const seenBlock: number[] = [];
  const types = [...TRAIN_UNITS, ...BUILDINGS] as string[];
  const enemySeen = seen.filter((v) => !v.own);
  types.forEach((t, i) => {
    const scale = i < TRAIN_UNITS.length ? 20 : 5;
    if (!os) {
      seenBlock.push(q(enemySeen.filter((v) => v.type === t).length / scale), 0);
    } else {
      seenBlock.push(q(os.seenCount[i] / scale), os.seenTick[i] < 0 ? 1 : q(cap1((match.tick - os.seenTick[i]) / AGE_SCALE)));
    }
  });
  const armyAge = os
    ? (os.armySeenTick < 0 ? 1 : q(cap1((match.tick - os.armySeenTick) / AGE_SCALE)))
    : (enemySeen.some((v) => COMBAT_SET.has(v.type)) ? 0 : 1);
  return [
    q((eco?.resources ?? 0) / 1000), q((eco?.supply ?? 0) / 50), q((eco?.maxSupply ?? 0) / 50),
    ...TRAIN_UNITS.map((u) => q(unitCount(u) / 20)),
    ...BUILDINGS.map((b) => q(bDone(b) / 5)),
    ...BUILDINGS.map((b) => q(bBuild(b) / 5)),
    ...TRAIN_UNITS.map((u) => q(queued(u) / 5)),
    +(holder === seat), +(holder === enemy), +(holder === null),
    q(match.control.progress[seat] / CONTROL.holdTicks), q(match.control.progress[enemy] / CONTROL.holdTicks),
    q(contested ? heldOwn / contested : 0), q(contested ? heldEnemy / contested : 0),
    q(cap1(match.tick / cap)),
    ...seenBlock,
    armyAge,
    q(s.armyA.size / 20), q(s.armyB.size / 20), +(s.builderId !== null && match.entities.has(s.builderId)),
    ...blockedShots(match, s),
    ...surgeGlobals(match),
  ];
}

function surgeGlobals(match: MatchState): [number, number, number] {
  if (!isBeta(match)) return [0, 1, 1];
  const stage = surgeStageAt(match.tick);
  const next = stage < 3 ? SURGES.stageTicks[stage as 0 | 1 | 2] : SURGES.capTicks;
  return [q(stage / 3), q(cap1(Math.max(0, next - match.tick) / 2400)), q(cap1(Math.max(0, SURGES.capTicks - match.tick) / SURGES.capTicks))];
}

/** [share of own ranged shots stopped by enemy bulwarks, share of enemy ranged shots stopped by own bulwarks], last DECISION_TICKS. */
function blockedShots(match: MatchState, s: SeatState): [number, number] {
  let own = 0, ownBlocked = 0, foe = 0, foeBlocked = 0;
  for (const ev of match.attackLog) {
    if (ev.isHeal || ev.tick <= match.tick - DECISION_TICKS) continue;
    const a = match.entities.get(ev.attackerId);
    if (!a || !(a.type === "building" || (UNIT_DEFS[a.type]?.range ?? 0) >= GUARD.rangedMinRange)) continue;
    if (a.ownerId === s.playerId) { own++; if (ev.blockedFor) ownBlocked++; }
    else {
      // Enemy shots count only when they land on something of ours (the log is not fog-filtered here).
      const t = match.entities.get(ev.targetId);
      if (!t || t.ownerId !== s.playerId) continue;
      foe++; if (ev.blockedFor) foeBlocked++;
    }
  }
  return [q(own ? ownBlocked / own : 0), q(foe ? foeBlocked / foe : 0)];
}

function nodeRows(match: MatchState, s: SeatState, d: Dims, rows: (string | null)[], os: ObsState | null): number[][] {
  const vis = match.visibilityData?.get(s.playerId);
  const seat = s.frame.seat, enemy = 1 - seat;
  return rows.map((id, i) => {
    const n = id ? match.resourceNodes.find((x) => x.id === id) : undefined;
    if (!n) return new Array(NODE_F).fill(0);
    const p = ownPos(s, d, n);
    const visible = !os || !vis || vis.nodeIds.has(n.id);
    const frac = q(n.capacity > 0 ? n.remaining / n.capacity : 0);
    if (os && visible) os.nodeSeen.set(n.id, frac);
    const remaining = visible ? frac : (os?.nodeSeen.get(n.id) ?? 0);
    let ownW = 0, enemyW = 0;
    for (const wid of n.gathererSlots) {
      const w = match.entities.get(wid);
      if (!w) continue;
      if (w.ownerId === s.playerId) ownW++;
      else if (!os || !vis || vis.entityIds.has(wid)) enemyW++;
    }
    return [
      1, p.x, p.y, +(i < 4), +(i >= 4 && i < 8), +(i >= 8), +visible, +(visible || (os?.nodeSeen.has(n.id) ?? false)), remaining,
      +(n.controller === seat), +(n.controller === enemy), q(ownW / 3), q(enemyW / 3),
    ];
  });
}

/** Per own-frame nav cell: its grid cell and the world vision cell it reads (static per episode and seat). */
const cellMaps = new WeakMap<ObsState, { grid: Int32Array; vision: Int32Array }>();
function cellMap(match: MatchState, s: SeatState, d: Dims, os: ObsState): { grid: Int32Array; vision: Int32Array } {
  let m = cellMaps.get(os);
  if (m) return m;
  const vg = visionGridOf(match.terrain), tc = match.terrain.cellSize;
  m = { grid: new Int32Array(d.nr * d.nc), vision: new Int32Array(d.nr * d.nc) };
  for (let r = 0; r < d.nr; r++) for (let c = 0; c < d.nc; c++) {
    const k = r * d.nc + c;
    m.grid[k] = Math.floor(r / d.ky) * d.gc + Math.floor(c / d.kx);
    const w = worldNavCell(s, d, c, r);
    const wc = w % d.nc, wr = (w - wc) / d.nc;
    m.vision[k] = visionCellOf(vg, (wc + 0.5) * tc, (wr + 0.5) * tc);
  }
  cellMaps.set(os, m);
  return m;
}

function dynamicGrid(match: MatchState, s: SeatState, d: Dims, seen: Seen[], os: ObsState | null, rel: Rel): number[] {
  const plane = d.gc * d.gr, n = d.kx * d.ky;
  const out = new Array(DYN_CHANNELS.length * plane).fill(0);
  const vis = match.visibilityData?.get(s.playerId);
  const litGrid = new Uint8Array(plane);
  const map = os && vis ? cellMap(match, s, d, os) : null;
  for (let r = 0; r < d.nr; r++) for (let c = 0; c < d.nc; c++) {
    const k = r * d.nc + c;
    const g = map ? map.grid[k] : Math.floor(r / d.ky) * d.gc + Math.floor(c / d.kx);
    if (!os || !vis || !map) { out[g] += 1; out[plane + g] += 1; continue; }
    const lit = vis.cells[map.vision[k]] === 1;
    if (lit) { os.lastLit[k] = match.tick; out[g] += 1; litGrid[g] = 1; }
    if (os.lastLit[k] >= 0) out[plane + g] += 1;
    out[2 * plane + g] += os.lastLit[k] < 0 ? 1 : cap1((match.tick - os.lastLit[k]) / AGE_SCALE);
  }
  const ownArmy = new Float64Array(plane), enemyNow = new Float64Array(plane);
  for (const v of seen) {
    if (!COMBAT_SET.has(v.type)) continue;
    (v.own ? ownArmy : enemyNow)[gridIdx(d, v.x, v.y)] += 1;
  }
  for (let g = 0; g < plane; g++) {
    out[g] = q(out[g] / n);
    out[plane + g] = q(out[plane + g] / n);
    out[2 * plane + g] = q(out[2 * plane + g] / n);
    out[3 * plane + g] = q(ownArmy[g] / 5);
    if (os) { if (litGrid[g]) os.enemySeen[g] = enemyNow[g]; out[4 * plane + g] = q(os.enemySeen[g] / 5); }
    else out[4 * plane + g] = q(enemyNow[g] / 5);
    out[5 * plane + g] = q(rel.threat[g] / 100);
    out[6 * plane + g] = q(rel.cover[g] / 100);
  }
  return out;
}

// ---- Schema 8: unit facts and relations (rebuild R1, S2) ----

/** Near-base radius (px) around the own crystal. */
export const NEAR_BASE = 900;
/** Ticks without enemy combat units near the crystal that end a raid. */
const RAID_GAP = 300;
/** Enemy workers seen outside their own half count for this many ticks (60 s). */
const WORKERS_OUT_TICKS = 600;
/** Memory slots that hold buildings (1..15; slot 0 is the army). */
const BUILDING_SLOTS = 16;
const TICKS_PER_S = 10;

/** Effective weapon range (px, as the engine checks it: attacker centre to target edge) and damage per second; 0 when the entity cannot attack. */
export function weaponOf(match: MatchState, e: MatchEntity): { range: number; dps: number } {
  const turret = e.type === "building" && e.buildingType === "turret" && e.constructionProgress >= 100;
  if (!turret && (!UNIT_DEFS[e.type as keyof typeof UNIT_DEFS] || e.type === "medic")) return { range: 0, dps: 0 };
  const cd = getAttackCooldown(e), dmg = getDamage(e, match.config);
  if (!(cd > 0) || !(dmg > 0)) return { range: 0, dps: 0 };
  return { range: getRange(e, match.terrain), dps: (dmg / cd) * TICKS_PER_S };
}

interface Rel { ent: number[][]; glob: number[]; threat: Float64Array; cover: Float64Array }

/**
 * Relational features for the seen entities (rows in `seen` order, first MAX_ENTITIES), the schema 8
 * globals and the threat / coverage grid planes. `os` (fogged observation) is updated: velocities,
 * enemy workers seen out, near-base and raid timers. `timers` (critic, fog off) is only read.
 */
function relations(match: MatchState, s: SeatState, d: Dims, seen: Seen[], os: ObsState | null, timers: ObsState | null): Rel {
  const tick = match.tick;
  let ownC: { x: number; y: number } | null = null, foeC: { x: number; y: number } | null = null;
  for (const e of match.entities.values()) {
    if (e.type !== "crystal") continue;
    const p = ownPos(s, d, e), px = { x: p.x * d.W, y: p.y * d.H };
    if (e.ownerId === s.playerId) ownC = px; else foeC = px;
  }
  const P = seen.map((v) => ({ x: v.x * d.W, y: v.y * d.H }));
  const W8 = seen.map((v) => weaponOf(match, v.e));
  const dist = (a: { x: number; y: number }, b: { x: number; y: number } | null) => (b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity);
  const isUnit = (v: Seen) => v.e.type !== "building" && v.e.type !== "crystal";

  const ent: number[][] = [];
  const n = Math.min(seen.length, MAX_ENTITIES);
  for (let i = 0; i < n; i++) {
    const v = seen[i], e = v.e;
    let nearest = Infinity, threatened = 0, inRange = 0;
    for (let j = 0; j < seen.length; j++) {
      if (seen[j].own === v.own) continue;
      const dd = Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y);
      if (dd < nearest) nearest = dd;
      if (W8[j].dps > 0 && dd <= W8[j].range + e.radius) threatened = 1;
      if (W8[i].dps > 0 && dd <= W8[i].range + seen[j].e.radius) inRange++;
    }
    const speed = isUnit(v) ? UNIT_DEFS[e.type as keyof typeof UNIT_DEFS]?.speed ?? 0 : 0;
    let vx = 0, vy = 0;
    const prev = os?.lastPos.get(e.id);
    if (prev && speed > 0 && tick > prev.tick) {
      const k = (tick - prev.tick) * speed;
      vx = Math.max(-1, Math.min(1, ((v.x - prev.x) * d.W) / k));
      vy = Math.max(-1, Math.min(1, ((v.y - prev.y) * d.H) / k));
    }
    ent.push([
      q(W8[i].range / 400), q(getVisionRange(e, match.terrain) / 600), q(speed / 8), q(W8[i].dps / 40),
      q(cap1(dist(P[i], ownC) / 3000)), q(cap1(dist(P[i], foeC) / 3000)),
      q(cap1(nearest / 1000)), threatened, q(cap1(inRange / 5)), q(vx), q(vy),
    ]);
  }

  // Grid planes: damage per second that reaches into each cell (enemy: threat; own: coverage).
  const plane = d.gc * d.gr;
  const threat = new Float64Array(plane), cover = new Float64Array(plane);
  for (let i = 0; i < seen.length; i++) {
    const { range: r, dps } = W8[i];
    if (!(dps > 0)) continue;
    const into = seen[i].own ? cover : threat, { x, y } = P[i];
    const c0 = Math.max(0, Math.floor((x - r) / GRID_CELL_W)), c1 = Math.min(d.gc - 1, Math.floor((x + r) / GRID_CELL_W));
    const r0 = Math.max(0, Math.floor((y - r) / GRID_CELL_H)), r1 = Math.min(d.gr - 1, Math.floor((y + r) / GRID_CELL_H));
    for (let gr = r0; gr <= r1; gr++) for (let gc = c0; gc <= c1; gc++) {
      // The weapon reaches some of the cell: nearest point of the cell within range.
      const cx = Math.max(gc * GRID_CELL_W - x, 0, x - (gc + 1) * GRID_CELL_W), cy = Math.max(gr * GRID_CELL_H - y, 0, y - (gr + 1) * GRID_CELL_H);
      if (cx * cx + cy * cy <= r * r) into[gr * d.gc + gc] += dps;
    }
  }

  // Globals.
  const near = (i: number) => dist(P[i], ownC) <= NEAR_BASE;
  let foeCombatNear = 0, foeUnitsHalf = 0, nearestFoe = Infinity, ownCombat = 0, ownNear = 0, ownAway = 0, workersOutNow = 0, foeBuildNear = 0;
  for (let i = 0; i < seen.length; i++) {
    const v = seen[i];
    if (v.own) {
      if (!COMBAT_SET.has(v.type)) continue;
      ownCombat++;
      if (near(i)) ownNear++;
      if (v.x >= 0.5) ownAway++;
      continue;
    }
    if (v.type === "crystal") continue;
    nearestFoe = Math.min(nearestFoe, dist(P[i], ownC));
    if (COMBAT_SET.has(v.type) && near(i)) foeCombatNear++;
    if (isUnit(v) && v.x < 0.5) foeUnitsHalf++;
    if (v.type === "worker" && v.x < 0.5) workersOutNow++;
    if (!isUnit(v) && near(i)) foeBuildNear++;
  }
  let workersOut = workersOutNow;
  if (os) {
    // Fogged: near-base buildings also from memory, enemy workers seen out in the last 60 s.
    foeBuildNear = 0;
    for (let k = 1; k < BUILDING_SLOTS; k++) {
      const m = os.mem[k];
      if (m && !m.destroyed && m.type !== "crystal" && dist({ x: m.x * d.W, y: m.y * d.H }, ownC) <= NEAR_BASE) foeBuildNear++;
    }
    for (const v of seen) if (!v.own && v.type === "worker") {
      if (v.x < 0.5) os.workersOut.set(v.e.id, tick); else os.workersOut.delete(v.e.id);
    }
    for (const [id, t] of os.workersOut) if (tick - t > WORKERS_OUT_TICKS) os.workersOut.delete(id);
    workersOut = os.workersOut.size;
    os.nearBaseSince = foeBuildNear > 0 ? (os.nearBaseSince < 0 ? tick : os.nearBaseSince) : -1;
    if (foeCombatNear > 0) {
      if (os.raidSince < 0 || tick - os.raidLast > RAID_GAP) os.raidSince = tick;
      os.raidLast = tick;
    }
    os.lastPos = new Map(seen.map((v) => [v.e.id, { x: v.x, y: v.y, tick }]));
  }
  const t = os ?? timers;
  const sinceMin = (since: number) => (since < 0 ? 0 : q(cap1((tick - since) / 600)));
  const glob = [
    q(cap1(foeBuildNear / 5)), q(cap1(foeCombatNear / 10)), q(cap1(foeUnitsHalf / 10)), q(cap1(workersOut / 3)),
    t ? sinceMin(t.nearBaseSince) : 0,
    t && t.raidSince >= 0 && tick - t.raidLast <= RAID_GAP ? sinceMin(t.raidSince) : 0,
    q(cap1(nearestFoe / 3000)),
    q(cap1(ownNear / 20)), q(ownCombat ? ownNear / ownCombat : 0), q(ownCombat ? ownAway / ownCombat : 0),
  ];
  return { ent, glob, threat, cover };
}

/** Update the enemy memory from what the seat sees now; mirror valid positions into `s.memory` (world) for targets. */
function updateMemory(match: MatchState, s: SeatState, d: Dims, seen: Seen[], os: ObsState): void {
  const vis = match.visibilityData?.get(s.playerId);
  const vg = visionGridOf(match.terrain);
  const enemy = seen.filter((v) => !v.own);
  // Last-seen counts per type.
  [...TRAIN_UNITS, ...BUILDINGS].forEach((t, i) => {
    const c = enemy.filter((v) => v.type === t).length;
    if (c > 0) { os.seenCount[i] = c; os.seenTick[i] = match.tick; }
  });
  // Army cluster (slot 0): centroid of visible enemy combat units.
  const army = enemy.filter((v) => COMBAT_SET.has(v.type));
  if (army.length) {
    const x = q(army.reduce((a, v) => a + v.x, 0) / army.length), y = q(army.reduce((a, v) => a + v.y, 0) / army.length);
    const hp = q(army.reduce((a, v) => a + v.e.health / v.e.maxHealth, 0) / army.length);
    os.mem[0] = { id: null, type: "army", x, y, hp, built: 1, count: army.length, tick: match.tick, destroyed: false };
    os.armySeenTick = match.tick;
  }
  // Buildings (slots 1..): update known ones, then add new ones in sorted order.
  const bySlot = new Map<string, number>();
  os.mem.forEach((m, i) => { if (m?.id) bySlot.set(m.id, i); });
  const visibleBuildings = enemy.filter((v) => MEMORY_TYPES.includes(v.type as never));
  const visibleIds = new Set(visibleBuildings.map((v) => v.e.id));
  for (const v of visibleBuildings) {
    const i = bySlot.get(v.e.id);
    const entry: MemEntry = {
      id: v.e.id, type: v.type, x: v.x, y: v.y, hp: q(v.e.health / v.e.maxHealth),
      built: q(v.e.type === "building" ? v.e.constructionProgress / 100 : 1), count: 1, tick: match.tick, destroyed: false,
    };
    if (i !== undefined) { os.mem[i] = entry; continue; }
    let slot = -1;
    for (let k = 1; k < MEMORY_SLOTS; k++) if (!os.mem[k]) { slot = k; break; }
    if (slot < 0) {
      // Full: replace the oldest destroyed entry, else the oldest entry.
      let best = -1;
      for (const destroyedOnly of [true, false]) {
        for (let k = 1; k < MEMORY_SLOTS; k++) {
          const m = os.mem[k]!;
          if (visibleIds.has(m.id!) || (destroyedOnly && !m.destroyed)) continue;
          if (best < 0 || m.tick < os.mem[best]!.tick) best = k;
        }
        if (best >= 0) break;
      }
      slot = best;
    }
    if (slot < 0) continue;
    os.mem[slot] = entry;
    bySlot.set(v.e.id, slot);
  }
  // Known buildings not visible where the seat can see the spot (and not hidden in brush): destroyed.
  for (let k = 1; k < MEMORY_SLOTS; k++) {
    const m = os.mem[k];
    if (!m || m.destroyed || visibleIds.has(m.id!) || !vis) continue;
    const w = fromOwnFrame(s.frame, { x: m.x * d.W, y: m.y * d.H });
    if (terrainAt(match.terrain, m.x * d.W, m.y * d.H) === T_BRUSH) continue;
    if (vis.cells[visionCellOf(vg, w.x, w.y)]) m.destroyed = true;
  }
  for (let k = 0; k < MEMORY_SLOTS; k++) {
    const m = os.mem[k];
    s.memory[k] = m && !m.destroyed ? fromOwnFrame(s.frame, { x: m.x * d.W, y: m.y * d.H }) : null;
  }
}

function memoryRows(match: MatchState, os: ObsState): number[][] {
  return os.mem.map((m) => m
    ? [1, +(m.id === null), ...MEMORY_TYPES.map((t) => +(t === m.type)), m.x, m.y, m.hp,
       q(cap1((match.tick - m.tick) / AGE_SCALE)), +m.destroyed, q(m.count / 20), m.built]
    : new Array(MEMORY_F).fill(0));
}

function blocks(match: MatchState, s: SeatState, rows: (string | null)[], os: ObsState | null, cap: number, timers: ObsState | null = null) {
  const d = dims(match);
  const seen = seenEntities(match, s, d, os !== null);
  if (os) updateMemory(match, s, d, seen, os);
  const covered = new Set<string>();
  for (const e of match.entities.values()) if (e.coverTargetId) covered.add(e.coverTargetId);
  const nodes = nodeRows(match, s, d, rows, os);
  const rel = relations(match, s, d, seen, os, timers);
  return {
    seen,
    globals: [...globalsRow(match, s, d, seen, os, cap), ...rel.glob],
    entities: seen.slice(0, MAX_ENTITIES).map((v, i) => [...entityRow(match, s, d, v, covered), ...rel.ent[i]]),
    nodes,
    grid: dynamicGrid(match, s, d, seen, os, rel),
  };
}

export interface ObserveOpts { z?: number; cap?: number }

/** The seat's fogged observation (updates its ObsState and `s.memory`). Call once per decision, before masks. */
export function observe(match: MatchState, s: SeatState, os: ObsState, opts: ObserveOpts = {}): ObsV2 {
  const { seen, ...b } = blocks(match, s, os.nodeRows, os, opts.cap ?? TRAIN_MAX_TICKS);
  s.rows = seen.slice(0, MAX_ENTITIES).map((v) => v.e.id);
  return { schemaVersion: OBS_SCHEMA_VERSION, z: opts.z ?? 0, ...b, memory: memoryRows(match, os) };
}

/** Training only: both seats' blocks without fog. Pure (no state updates). */
export function criticState(match: MatchState, s: SeatState, os: ObsState, other: SeatState, otherOs: ObsState, cap = TRAIN_MAX_TICKS): CriticV2 {
  const strip = ({ seen: _, ...rest }: ReturnType<typeof blocks>) => rest;
  return { self: strip(blocks(match, s, os.nodeRows, null, cap, os)), enemy: strip(blocks(match, other, otherOs.nodeRows, null, cap, otherOs)) };
}

/** Training only: what an opponent model should predict about the enemy (true state). */
export function oppLabels(match: MatchState, s: SeatState): OppLabels {
  const d = dims(match);
  const enemy = seenEntities(match, s, d, false).filter((v) => !v.own);
  const units = TRAIN_UNITS.map((u) => enemy.filter((v) => v.type === u).length);
  const buildings = BUILDINGS.map((b) => enemy.filter((v) => v.type === b).length);
  const queued = TRAIN_UNITS.map((u) => enemy.reduce((n, v) => n + v.e.productionQueue.filter((it) => it.unitType === u).length, 0));
  const army = enemy.filter((v) => COMBAT_SET.has(v.type));
  let armyAnchor = N_ANCHOR_TARGETS;
  if (army.length) {
    const cx = army.reduce((a, v) => a + v.x, 0) / army.length * d.W, cy = army.reduce((a, v) => a + v.y, 0) / army.length * d.H;
    let bd = Infinity;
    for (let i = 0; i < N_ANCHOR_TARGETS; i++) {
      if (!s.targetValid[i]) continue;
      const p = ownPos(s, d, s.targets[i]);
      const dd = (p.x * d.W - cx) ** 2 + (p.y * d.H - cy) ** 2;
      if (dd < bd) { bd = dd; armyAnchor = i; }
    }
  }
  return { units, buildings, queued, armyAnchor };
}
