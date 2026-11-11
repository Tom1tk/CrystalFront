// Action space v2 (G-10 M0 T5, R-2).
//
// One decision every DECISION_TICKS ticks = one economy action + one army order.
//   economy: flat categorical (noop, train, build at a named site, move workers to a node)
//   army:    group → order → target, each masked given the previous choice
// Targets are named map anchors (T3) in the acting seat's own frame, or one of
// the seat's enemy-memory slots (filled by observation v2, T6). Nothing here
// uses map-width fractions.
//
// Rule P-8: a legal action must do something. Every mask below is computed with
// the same checks the engine applies, and `applyV2` reports whether the action
// changed anything; scripted play must have an ineffective rate of 0.
import type { MatchEntity, MatchState } from "../../../server/src/match/types.js";
import type { MatchEngine } from "../../../server/src/match/matchEngine.js";
import { BUILDING_DEFS, UNIT_DEFS } from "@crystalfront/shared";
import { validateBuildSite } from "../../../server/src/match/buildingValidation.js";
import { anchorsFor } from "../../../server/src/match/maps.js";
import { ANCHOR_MAX, padSlots, seatAnchors, type Pt } from "../../../server/src/match/engine/anchors.js";
import { isIdleWorker } from "../actionSpace.js";
import { frameFor, offsetToWorld, type Frame } from "./frame.js";

export const DECISION_TICKS = 8;

// ---- Economy head ----
export const TRAIN_UNITS = ["worker", "skirmisher", "gunner", "bruiser", "medic"] as const;
export const BUILDINGS = ["barracks", "foundry", "supply_depot", "turret"] as const;
/** Build sites, own frame: own base, own pockets, own chokes, centre anchors. */
export const BUILD_SITES = 1 + ANCHOR_MAX.pockets + ANCHOR_MAX.chokes + ANCHOR_MAX.centre; // 10
/** Node slots: own safe nodes, then contested nodes. */
export const NODE_SLOTS = ANCHOR_MAX.safeNodes + ANCHOR_MAX.nodes; // 16
/**
 * Workers moved by one assign action. The plan's {1, 2, all idle} assumed idle
 * workers; with the worker autopilot there rarely are any, so assign moves
 * gathering workers instead and "all idle" becomes 4.
 */
export const WORKER_COUNTS = [1, 2, 4] as const;

export const ECON_TRAIN0 = 1;
export const ECON_BUILD0 = ECON_TRAIN0 + TRAIN_UNITS.length;                  // 6
export const ECON_ASSIGN0 = ECON_BUILD0 + BUILDINGS.length * BUILD_SITES;     // 46
export const ECON_SIZE = ECON_ASSIGN0 + NODE_SLOTS * WORKER_COUNTS.length;    // 94

// ---- Army head ----
export const GROUPS = ["none", "all_combat", "army_a", "army_b", "skirmishers", "gunners", "bruisers", "medics", "scout"] as const;
export const ORDERS = ["none", "attack_move", "move", "hold", "retreat", "join_a", "join_b"] as const;
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
export const TARGET_NONE = N_ANCHOR_TARGETS + MEMORY_SLOTS; // 53
export const TARGET_SIZE = TARGET_NONE + 1; // 54

const COMBAT = new Set(["skirmisher", "gunner", "bruiser", "medic"]);
const FAST = new Set(["skirmisher", "medic"]);
/** Producers keep at most this many units queued (a busy producer is not "free"). */
export const PRODUCER_QUEUE_MAX = 2;
/** Units within this distance of their crystal count as home for `retreat`. */
const HOME_RADIUS = 250;
/** Nodes with less than this left are not worker targets (as in v1). */
const MIN_NODE_REMAINING = 5;

export interface V2Action { econ: number; group: number; order: number; target: number }

export const NOOP_ACTION: V2Action = { econ: 0, group: 0, order: 0, target: TARGET_NONE };

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
  return {
    playerId, frame, targets, targetValid, sites, siteValid, nodeSlots,
    armyA: new Set(), armyB: new Set(), scoutId: null,
    memory: new Array(MEMORY_SLOTS).fill(null),
    stats: { decisions: 0, econIneffective: 0, armyIneffective: 0, autopilot: 0, contested: 0 },
  };
}

// ---- Decoding ----

export type EconAction =
  | { kind: "noop" }
  | { kind: "train"; unit: typeof TRAIN_UNITS[number] }
  | { kind: "build"; building: typeof BUILDINGS[number]; site: number }
  | { kind: "assign"; slot: number; count: number };

export function decodeEcon(i: number): EconAction {
  if (i <= 0 || i >= ECON_SIZE) return { kind: "noop" };
  if (i < ECON_BUILD0) return { kind: "train", unit: TRAIN_UNITS[i - ECON_TRAIN0] };
  if (i < ECON_ASSIGN0) {
    const j = i - ECON_BUILD0;
    return { kind: "build", building: BUILDINGS[Math.floor(j / BUILD_SITES)], site: j % BUILD_SITES };
  }
  const j = i - ECON_ASSIGN0;
  return { kind: "assign", slot: Math.floor(j / WORKER_COUNTS.length), count: WORKER_COUNTS[j % WORKER_COUNTS.length] };
}

export function encodeEcon(a: EconAction): number {
  switch (a.kind) {
    case "noop": return 0;
    case "train": return ECON_TRAIN0 + TRAIN_UNITS.indexOf(a.unit);
    case "build": return ECON_BUILD0 + BUILDINGS.indexOf(a.building) * BUILD_SITES + a.site;
    case "assign": return ECON_ASSIGN0 + a.slot * WORKER_COUNTS.length + WORKER_COUNTS.indexOf(a.count as 1 | 2 | 4);
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

/** Own-frame placement offsets around a site: 40 px grid out to 120 px, nearest first. */
const SITE_OFFSETS: Array<[number, number]> = (() => {
  const o: Array<[number, number]> = [];
  for (let gx = -3; gx <= 3; gx++) for (let gy = -3; gy <= 3; gy++) o.push([gx * 40, gy * 40]);
  o.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2) || a[0] - b[0] || a[1] - b[1]);
  return o;
})();

/** A valid placement for `building` near site `site`, or null. Offsets are own-frame, so both seats pick matching spots. */
export function siteFor(match: MatchState, s: SeatState, building: typeof BUILDINGS[number], site: number): Pt | null {
  if (!s.siteValid[site]) return null;
  const c = s.sites[site];
  for (const [dx, dy] of SITE_OFFSETS) {
    const o = offsetToWorld(s.frame, dx, dy);
    const x = c.x + o.x, y = c.y + o.y;
    if (validateBuildSite(match, s.playerId, building, x, y).valid) return { x, y };
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

/** Members of an army group (not `none`). Does not assign the scout. */
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

function isRetreating(e: MatchEntity, c: MatchEntity): boolean {
  return !!e.moveOrder && !e.moveOrder.attack && e.moveOrder.x === c.x && e.moveOrder.y === c.y;
}

function orderLegal(match: MatchState, s: SeatState, g: Group, o: Order, members: MatchEntity[]): boolean {
  if (g === "none") return o === "none";
  if (o === "none" || members.length === 0) return false;
  switch (o) {
    case "attack_move": case "move": return true;
    case "hold": return members.some((e) => !!e.moveTarget);
    case "retreat": {
      const c = ownCrystal(match, s.playerId);
      return !!c && members.some((e) => !isRetreating(e, c) && (e.x - c.x) ** 2 + (e.y - c.y) ** 2 > HOME_RADIUS ** 2);
    }
    case "join_a": return g !== "scout" && members.some((e) => !s.armyA.has(e.id));
    case "join_b": return g !== "scout" && members.some((e) => !s.armyB.has(e.id));
  }
}

// ---- Masks ----

export interface V2Masks {
  econ: boolean[];          // [ECON_SIZE]
  group: boolean[];         // [G]
  order: boolean[][];       // [G][O]
  target: boolean[][];      // [O][T]
}

export function computeMasks(match: MatchState, s: SeatState): V2Masks {
  pruneArmies(match, s);
  const econ = new Array<boolean>(ECON_SIZE).fill(false);
  econ[0] = true;
  TRAIN_UNITS.forEach((u, i) => { econ[ECON_TRAIN0 + i] = !!producerFor(match, s.playerId, u); });
  const eco = match.economy[seatIdx(match, s.playerId)];
  const hasBuilder = !!builder(match, s);
  BUILDINGS.forEach((b, bi) => {
    if (!eco || !hasBuilder || eco.resources < BUILDING_DEFS[b].cost) return;
    for (let site = 0; site < BUILD_SITES; site++) econ[ECON_BUILD0 + bi * BUILD_SITES + site] = !!siteFor(match, s, b, site);
  });
  for (let slot = 0; slot < NODE_SLOTS; slot++) {
    const node = nodeById(match, s.nodeSlots[slot]);
    if (!node || node.remaining < MIN_NODE_REMAINING) continue;
    const free = node.maxGathererSlots - node.gathererSlots.size;
    const cands = assignCandidates(match, s, node).length;
    WORKER_COUNTS.forEach((c, ci) => { econ[ECON_ASSIGN0 + slot * WORKER_COUNTS.length + ci] = free >= c && cands >= c; });
  }

  const group: boolean[] = [], order: boolean[][] = [];
  for (const g of GROUPS) {
    const members = g === "none" ? [] : groupMembers(match, s, g);
    const row = ORDERS.map((o) => orderLegal(match, s, g, o, members));
    order.push(row);
    group.push(row.some(Boolean));
  }

  const moveTargets = new Array<boolean>(TARGET_SIZE).fill(false);
  for (let t = 0; t < N_ANCHOR_TARGETS; t++) moveTargets[t] = s.targetValid[t];
  for (let m = 0; m < MEMORY_SLOTS; m++) moveTargets[TARGET_MEMORY0 + m] = !!s.memory[m];
  const noneOnly = new Array<boolean>(TARGET_SIZE).fill(false);
  noneOnly[TARGET_NONE] = true;
  const target = ORDERS.map((o) => (o === "attack_move" || o === "move" ? moveTargets.slice() : noneOnly.slice()));
  return { econ, group, order, target };
}

/** True if the action is allowed by the masks. */
export function isLegal(m: V2Masks, a: V2Action): boolean {
  return !!m.econ[a.econ] && !!m.group[a.group] && !!m.order[a.group]?.[a.order] && !!m.target[a.order]?.[a.target];
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

function econCommands(match: MatchState, s: SeatState, a: EconAction): Cmd[] {
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
      const pos = w ? siteFor(match, s, a.building, a.site) : null;
      if (!w || !pos) return [];
      return [{ type: "build", buildingType: a.building, targetX: pos.x, targetY: pos.y, workerIds: [w.id], entityId: w.id }];
    }
    case "assign": {
      const node = nodeById(match, s.nodeSlots[a.slot]);
      if (!node) return [];
      return assignCandidates(match, s, node).slice(0, a.count).map((w) => ({ type: "gather", entityId: w.id, targetEntityId: node.id }));
    }
  }
}

function targetPoint(s: SeatState, t: number): Pt | null {
  if (t < N_ANCHOR_TARGETS) return s.targetValid[t] ? s.targets[t] : null;
  if (t < TARGET_NONE) return s.memory[t - TARGET_MEMORY0];
  return null;
}

/**
 * Apply one v2 decision for a seat. The caller checks legality first (or relies
 * on masks); an illegal or no-op part simply does nothing and is counted.
 */
export function applyV2(engine: MatchEngine, match: MatchState, s: SeatState, a: V2Action): ApplyResult {
  return applyResolved(engine, match, s, a, econCommands(match, s, decodeEcon(a.econ)), false);
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
    const members = groupMembers(match, s, g);
    if (g === "scout" && members[0]) s.scoutId = members[0].id;
    const ids = members.map((e) => e.id);
    armyEffective = false;
    if (o === "attack_move" || o === "move") {
      const p = targetPoint(s, a.target);
      if (p) armyEffective = run(engine, match, s.playerId, ids.map((id) => ({ type: o, entityId: id, targetX: p.x, targetY: p.y })), accepted);
    } else if (o === "hold") {
      armyEffective = run(engine, match, s.playerId,
        members.filter((e) => e.moveTarget).map((e) => ({ type: "attack_move", entityId: e.id, targetX: e.x, targetY: e.y })), accepted);
    } else if (o === "retreat") {
      armyEffective = ids.length > 0 && run(engine, match, s.playerId, [{ type: "retreat", entityIds: ids }], accepted);
    } else if (o === "join_a" || o === "join_b") {
      const into = o === "join_a" ? s.armyA : s.armyB, out = o === "join_a" ? s.armyB : s.armyA;
      for (const id of ids) {
        if (!into.has(id)) { into.add(id); armyEffective = true; }
        out.delete(id);
      }
    }
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
  const cmds = [econCommands(match, seats[0], ea[0]), econCommands(match, seats[1], ea[1])];
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
