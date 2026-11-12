// G-10 M0 T8 (P-7): scripted bots for the v2 action space.
//
// One data-driven bot (`ScriptedV2Bot`) plays a *template*: worker target, build
// order, unit mix, when and where to push, where to wait. Each template has its
// own strategy token `z` (≥ 1; 0 means "free"). A bot name maps to one or more
// templates; the episode's seeded RNG picks one (unless a z is requested) and
// jitters its timing, size and target choice. Switchers play template A until a
// random tick in [1,500, 4,000], then template B. Bots see only what the policy
// sees (their own fogged observation and masks) plus static public map facts
// (`BotContext`: map size, own-frame anchor positions, which anchors are in
// brush), and pick only legal actions, so their ineffective-action rate is 0.
import { BUILDING_DEFS, UNIT_DEFS } from "@crystalfront/shared";
import { Rng } from "../../../server/src/match/engine/rng.js";
import type { Pt } from "../../../server/src/match/engine/anchors.js";
import { T_BRUSH, terrainAt } from "../../../server/src/match/engine/terrain.js";
import type { MatchState } from "../../../server/src/match/types.js";
import { toOwnFrame } from "./frame.js";
import type { SeatState } from "./actions.js";
import {
  BUILDINGS, BUILD_SITES, ECON_ASSIGN0, ECON_BUILD0, ECON_TRAIN0, GROUPS, ORDERS, TARGET_NONE, TRAIN_UNITS, WORKER_COUNTS,
  type V2Action, type V2Masks,
} from "./actions.js";
import { ENTITY_FEATURES, GLOBAL_NAMES, NODE_FEATURES, type ObsV2 } from "./observation.js";

/** Static, public map facts a scripted bot may use (own frame). */
export interface BotContext {
  W: number;
  H: number;
  /** Tick cap of the episode (the observation's `tick` global is tick / cap). */
  cap: number;
  /** Anchor targets in own-frame coordinates, with validity (same order as the target head). */
  targets: Pt[];
  targetValid: boolean[];
  /** Anchor targets standing in brush. */
  brush: boolean[];
}

/** Anchors with brush within this radius (px) count as brush (anchors themselves sit on open ground). */
const BRUSH_RADIUS = 120;

export function botContext(match: MatchState, s: SeatState, cap: number): BotContext {
  const { W, H } = s.frame, t = match.terrain;
  const brush = s.targets.map((p, i) => {
    if (!s.targetValid[i]) return false;
    for (let dy = -BRUSH_RADIUS; dy <= BRUSH_RADIUS; dy += 20) {
      for (let dx = -BRUSH_RADIUS; dx <= BRUSH_RADIUS; dx += 20) {
        const x = p.x + dx, y = p.y + dy;
        if (dx * dx + dy * dy > BRUSH_RADIUS * BRUSH_RADIUS || x < 0 || y < 0 || x >= W || y >= H) continue;
        if (terrainAt(t, x, y) === T_BRUSH) return true;
      }
    }
    return false;
  });
  return { W, H, cap, targets: s.targets.map((p) => toOwnFrame(s.frame, p)), targetValid: [...s.targetValid], brush };
}

type Unit = typeof TRAIN_UNITS[number];
type Building = typeof BUILDINGS[number];
type PushTarget = "enemy_base" | "control" | "enemy_safe" | "enemy_nodes";
type Stage = "base" | "choke" | "own_nodes" | "hidden";

interface BuildStep {
  b: Building;
  /** Wanted count of this building (finished + under construction). */
  n: number;
  /** Site indices in preference order (0 base, 1–3 pockets, 4–6 chokes, 7–9 centre). */
  sites: number[];
  /** Start only after this tick / with this many army units. */
  tick?: number;
  army?: number;
}

export interface Template {
  z: number;
  label: string;
  workers: number;
  /** Workers to keep on own-half contested nodes. */
  contested: number;
  builds: BuildStep[];
  mix: Partial<Record<Unit, number>>;
  /** Build a depot when free supply (incl. queued) is at most this. */
  headroom: number;
  push: { tick: number; size: number; regroup: number; targets: PushTarget[]; via?: "brush" };
  stage: Stage;
  /** Retreat when pushing and the army's mean health fraction drops below this. */
  retreat: number;
  /** From this tick on, rebuild the economy to these targets (rushes that did not end the game). */
  late?: { tick: number; workers: number; contested: number };
}

const BASE = [0, 1, 2, 3], FORWARD = [4, 5, 6, 7, 8, 9, 1, 2, 3], POCKETS = [1, 2, 3, 0], CENTRE = [7, 8, 9, 4, 5, 6];

export const TEMPLATES: Record<string, Template> = {
  rush_light: {
    z: 1, label: "light skirmisher rush", workers: 5, contested: 0, headroom: 1,
    builds: [{ b: "barracks", n: 1, sites: BASE }],
    mix: { skirmisher: 1 }, push: { tick: 900, size: 5, regroup: 2, targets: ["enemy_base"] }, stage: "base", retreat: 0,
    late: { tick: 3000, workers: 7, contested: 2 },
  },
  rush_medium: {
    z: 2, label: "skirmisher rush", workers: 4, contested: 0, headroom: 1,
    builds: [{ b: "barracks", n: 1, sites: BASE }],
    mix: { skirmisher: 1 }, push: { tick: 400, size: 3, regroup: 0, targets: ["enemy_base", "enemy_safe"] }, stage: "base", retreat: 0,
    late: { tick: 3000, workers: 7, contested: 2 },
  },
  rush_heavy: {
    z: 3, label: "two-barracks skirmisher rush", workers: 4, contested: 0, headroom: 2,
    builds: [{ b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE }],
    mix: { skirmisher: 1 }, push: { tick: 300, size: 2, regroup: 0, targets: ["enemy_base"] }, stage: "base", retreat: 0,
    late: { tick: 3000, workers: 7, contested: 2 },
  },
  rush_gunner: {
    z: 4, label: "gunner rush", workers: 4, contested: 0, headroom: 1,
    builds: [{ b: "barracks", n: 1, sites: BASE }],
    mix: { gunner: 1 }, push: { tick: 500, size: 4, regroup: 0, targets: ["enemy_base", "enemy_safe"] }, stage: "base", retreat: 0,
    late: { tick: 3000, workers: 7, contested: 2 },
  },
  turtle_gunner: {
    z: 5, label: "turrets and gunners, control win", workers: 7, contested: 2, headroom: 2,
    builds: [
      { b: "supply_depot", n: 1, sites: POCKETS }, { b: "turret", n: 1, sites: FORWARD }, { b: "barracks", n: 1, sites: BASE },
      { b: "turret", n: 3, sites: FORWARD }, { b: "barracks", n: 2, sites: BASE, army: 6 },
    ],
    mix: { gunner: 1 }, push: { tick: 0, size: 8, regroup: 4, targets: ["control"] }, stage: "own_nodes", retreat: 0,
  },
  turtle_bruiser: {
    z: 6, label: "turrets and bruisers, control win", workers: 7, contested: 2, headroom: 2,
    builds: [
      { b: "supply_depot", n: 1, sites: POCKETS }, { b: "turret", n: 1, sites: FORWARD }, { b: "foundry", n: 1, sites: BASE },
      { b: "turret", n: 3, sites: FORWARD }, { b: "barracks", n: 1, sites: BASE, army: 4 },
    ],
    mix: { bruiser: 2, medic: 1, gunner: 1 }, push: { tick: 0, size: 8, regroup: 4, targets: ["control"] }, stage: "own_nodes", retreat: 0,
  },
  macro_heavy: {
    z: 7, label: "economy, then gunners + bruisers + medics", workers: 6, contested: 2, headroom: 2,
    builds: [
      { b: "supply_depot", n: 1, sites: POCKETS }, { b: "barracks", n: 1, sites: BASE }, { b: "foundry", n: 1, sites: BASE },
      { b: "barracks", n: 2, sites: BASE, tick: 1500 },
    ],
    mix: { gunner: 2, bruiser: 2, medic: 1 }, push: { tick: 0, size: 8, regroup: 4, targets: ["control", "enemy_base"] }, stage: "base", retreat: 0.3,
  },
  macro_light: {
    z: 8, label: "economy, then skirmishers + gunners", workers: 6, contested: 2, headroom: 2,
    builds: [
      { b: "supply_depot", n: 1, sites: POCKETS }, { b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE, tick: 1000 },
    ],
    mix: { skirmisher: 1, gunner: 1 }, push: { tick: 0, size: 8, regroup: 4, targets: ["control", "enemy_nodes"] }, stage: "choke", retreat: 0.3,
  },
  heavy: {
    z: 9, label: "foundry first, slow unstoppable push", workers: 6, contested: 1, headroom: 3,
    builds: [
      { b: "foundry", n: 1, sites: BASE }, { b: "supply_depot", n: 1, sites: POCKETS }, { b: "barracks", n: 1, sites: BASE, army: 3 },
      { b: "supply_depot", n: 2, sites: POCKETS, army: 5 },
    ],
    mix: { bruiser: 3, medic: 2, gunner: 1 }, push: { tick: 0, size: 10, regroup: 4, targets: ["enemy_base"] }, stage: "base", retreat: 0.35,
  },
  heavy_turret: {
    z: 10, label: "heavy army behind forward turrets", workers: 6, contested: 1, headroom: 3,
    builds: [
      { b: "foundry", n: 1, sites: BASE }, { b: "turret", n: 2, sites: FORWARD }, { b: "supply_depot", n: 1, sites: POCKETS },
      { b: "barracks", n: 1, sites: BASE, army: 4 },
    ],
    mix: { bruiser: 3, medic: 2, gunner: 1 }, push: { tick: 0, size: 10, regroup: 4, targets: ["enemy_base", "control"] }, stage: "choke", retreat: 0.35,
  },
  hidden: {
    z: 11, label: "mass out of sight, then attack", workers: 6, contested: 0, headroom: 2,
    builds: [{ b: "barracks", n: 1, sites: BASE }, { b: "foundry", n: 1, sites: BASE }, { b: "supply_depot", n: 1, sites: POCKETS }],
    mix: { skirmisher: 1, gunner: 1, bruiser: 1 }, push: { tick: 0, size: 12, regroup: 3, targets: ["enemy_base"], via: "brush" }, stage: "hidden", retreat: 0,
  },
  // Switcher phase templates (each switcher has its own z, reported for both phases).
  fake_expand: {
    z: 14, label: "fake expansion: workers and a turret forward, army at home", workers: 7, contested: 4, headroom: 2,
    builds: [{ b: "turret", n: 1, sites: CENTRE }, { b: "barracks", n: 1, sites: BASE }],
    mix: { skirmisher: 1, gunner: 1 }, push: { tick: 0, size: 99, regroup: 0, targets: ["control"] }, stage: "base", retreat: 0,
  },
  brush_strike: {
    z: 14, label: "army through brush to the enemy base", workers: 7, contested: 0, headroom: 2,
    builds: [{ b: "barracks", n: 2, sites: BASE }],
    mix: { skirmisher: 2, gunner: 1 }, push: { tick: 0, size: 8, regroup: 3, targets: ["enemy_base"], via: "brush" }, stage: "hidden", retreat: 0,
  },
  bruiser_timing: {
    z: 13, label: "foundry and a bruiser timing attack", workers: 6, contested: 2, headroom: 2,
    builds: [{ b: "foundry", n: 1, sites: BASE }, { b: "foundry", n: 2, sites: BASE }],
    mix: { bruiser: 3, medic: 1 }, push: { tick: 0, size: 8, regroup: 3, targets: ["enemy_base"] }, stage: "base", retreat: 0,
  },
  control_grab: {
    z: 15, label: "late control grab", workers: 7, contested: 2, headroom: 2,
    builds: [{ b: "barracks", n: 2, sites: BASE }],
    mix: { gunner: 2, skirmisher: 1 }, push: { tick: 0, size: 6, regroup: 2, targets: ["control"] }, stage: "own_nodes", retreat: 0,
  },
  turtle_hold: {
    z: 15, label: "turtle, no push", workers: 7, contested: 2, headroom: 2,
    builds: [
      { b: "supply_depot", n: 1, sites: POCKETS }, { b: "turret", n: 2, sites: FORWARD }, { b: "barracks", n: 1, sites: BASE },
      { b: "turret", n: 4, sites: FORWARD }, { b: "barracks", n: 2, sites: BASE },
    ],
    mix: { gunner: 1 }, push: { tick: 0, size: 99, regroup: 0, targets: ["control"] }, stage: "own_nodes", retreat: 0,
  },
};

interface BotDef { templates: string[]; switchTo?: string; z?: number }

/** Bot name → templates it samples from; switchers name their second phase. */
export const SCRIPTED: Record<string, BotDef> = {
  rush1: { templates: ["rush_light"] },
  rush2: { templates: ["rush_medium", "rush_gunner"] },
  rush3: { templates: ["rush_heavy"] },
  turtle: { templates: ["turtle_gunner", "turtle_bruiser"] },
  macro: { templates: ["macro_heavy", "macro_light"] },
  heavy: { templates: ["heavy", "heavy_turret"] },
  hidden: { templates: ["hidden"] },
  sw_rush_turtle: { templates: ["rush_medium"], switchTo: "turtle_gunner", z: 12 },
  sw_macro_bruiser: { templates: ["macro_light"], switchTo: "bruiser_timing", z: 13 },
  sw_fake_brush: { templates: ["fake_expand"], switchTo: "brush_strike", z: 14 },
  sw_turtle_grab: { templates: ["turtle_hold"], switchTo: "control_grab", z: 15 },
};
export const SWITCH_WINDOW: [number, number] = [1500, 4000];

/** Every z a scripted bot can play, with its bot name. */
export function scriptedZs(): Map<number, string> {
  const out = new Map<number, string>();
  for (const [name, d] of Object.entries(SCRIPTED)) {
    if (d.z !== undefined) out.set(d.z, name);
    else for (const t of d.templates) out.set(TEMPLATES[t].z, name);
  }
  return out;
}

// ---- Observation access ----

const G = Object.fromEntries(GLOBAL_NAMES.map((n, i) => [n, i])) as Record<string, number>;
const F = Object.fromEntries(ENTITY_FEATURES.map((n, i) => [n, i])) as Record<string, number>;
const N = Object.fromEntries(NODE_FEATURES.map((n, i) => [n, i])) as Record<string, number>;
const COMBAT: Unit[] = ["skirmisher", "gunner", "bruiser", "medic"];

const GROUP_ALL = GROUPS.indexOf("all_combat");
const O_AM = ORDERS.indexOf("attack_move"), O_MOVE = ORDERS.indexOf("move"), O_RETREAT = ORDERS.indexOf("retreat");
const T_OWN_BASE = 0, T_OWN_POCKET0 = 1, T_OWN_CHOKE0 = 4, T_CENTRE0 = 7, T_NODE0 = 10, T_ENEMY_BASE = 26, T_ENEMY_SAFE0 = 33;
const NODE_ROW_CONTESTED0 = 8, NODE_ROW_ENEMY_SAFE0 = 4;
const SLOT_CONTESTED0 = 4;
/** Re-issue an unchanged army order after this many decisions. */
const ORDER_REFRESH = 6;
const THREAT_RADIUS = 600;
const CONTROL_PATIENCE = 1500;

interface View {
  tick: number;
  resources: number;
  freeSupply: number;
  units: Record<Unit, number>;     // own, including queued
  buildings: Record<Building, number>; // finished + under construction
  depotBuilding: boolean;
  army: number[][];                // own combat rows
  crystal: Pt;
  threat: boolean;
  contestedWorkers: number;
}

export class ScriptedV2Bot {
  readonly name: string;
  z: number;
  private t: Template;
  private next: Template | null;
  readonly switchTick: number | null;
  private pushTick: number;
  private pushSize: number;
  private target: PushTarget;
  private pushing = false;
  private lastOrder = "";
  private lastOrderAt = -99;
  private decisions = 0;
  private viaDone = false;
  /** Control push: best own control progress seen and the tick it was reached. */
  private ctrlBest = 0;
  private ctrlAt = 0;

  constructor(name: string, seed: number, private ctx: BotContext, zWanted = 0) {
    const def = SCRIPTED[name];
    if (!def) throw new Error(`unknown scripted bot "${name}"`);
    this.name = name;
    const rng = new Rng(seed);
    let tName: string;
    if (zWanted) {
      const hit = def.z === zWanted ? def.templates[0] : def.templates.find((t) => TEMPLATES[t].z === zWanted);
      if (!hit) throw new Error(`bot "${name}" has no template with z = ${zWanted}`);
      tName = hit;
      rng.random(); // keep the draw sequence independent of how the template was chosen
    } else {
      tName = def.templates[Math.floor(rng.random() * def.templates.length)];
    }
    this.t = TEMPLATES[tName];
    this.next = def.switchTo ? TEMPLATES[def.switchTo] : null;
    this.z = def.z ?? this.t.z;
    this.switchTick = this.next ? Math.round(SWITCH_WINDOW[0] + rng.random() * (SWITCH_WINDOW[1] - SWITCH_WINDOW[0])) : null;
    // Per-episode jitter of the first phase; the switch phase gets its own draws.
    this.pushTick = 0; this.pushSize = 0; this.target = "enemy_base";
    this.jitter(this.t, rng);
    this.rng = rng;
  }
  private rng: Rng;

  /** Template label (and switch tick) for logs. */
  describe(): string {
    return this.next ? `${this.t.label} → ${this.next.label} @${this.switchTick}` : this.t.label;
  }

  private jitter(t: Template, rng: Rng): void {
    this.pushTick = Math.round(t.push.tick * (0.8 + 0.4 * rng.random()));
    this.pushSize = Math.max(1, t.push.size + Math.floor(rng.random() * 3) - 1);
    this.target = t.push.targets[Math.floor(rng.random() * t.push.targets.length)];
  }

  decide(obs: ObsV2, m: V2Masks): V2Action {
    const v = this.view(obs);
    if (this.next && this.switchTick !== null && v.tick >= this.switchTick) {
      this.t = this.next; this.next = null;
      this.jitter(this.t, this.rng);
      this.pushing = false; this.viaDone = false; this.lastOrder = ""; this.ctrlBest = 0;
    }
    const econ = this.econ(obs, v, m);
    const army = this.armyOrder(obs, v, m);
    this.decisions++;
    return { econ, ...army };
  }

  // ---- view ----

  private view(obs: ObsV2): View {
    const g = obs.globals;
    const units = {} as Record<Unit, number>;
    for (const u of TRAIN_UNITS) units[u] = Math.round(g[G[`own_${u}`]] * 20) + Math.round(g[G[`queued_${u}`]] * 5);
    const buildings = {} as Record<Building, number>;
    for (const b of BUILDINGS) buildings[b] = Math.round(g[G[`own_${b}_done`]] * 5) + Math.round(g[G[`own_${b}_building`]] * 5);
    let queuedSupply = 0;
    for (const u of TRAIN_UNITS) queuedSupply += Math.round(g[G[`queued_${u}`]] * 5) * UNIT_DEFS[u].supplyCost;
    const supply = Math.round(g[G.supply] * 50), maxSupply = Math.round(g[G.max_supply] * 50);
    const army: number[][] = [];
    let crystal: Pt = { x: 0, y: 0.5 };
    const enemyCombat: number[][] = [];
    for (const e of obs.entities) {
      if (e[F.own]) {
        if (e[F.type_crystal]) crystal = { x: e[F.x], y: e[F.y] };
        else if (COMBAT.some((u) => e[F[`type_${u}`]])) army.push(e);
      } else if (COMBAT.some((u) => e[F[`type_${u}`]])) enemyCombat.push(e);
    }
    const threat = enemyCombat.some((e) => this.dist({ x: e[F.x], y: e[F.y] }, crystal) < THREAT_RADIUS);
    let contestedWorkers = 0;
    for (let r = NODE_ROW_CONTESTED0; r < obs.nodes.length; r++) contestedWorkers += Math.round(obs.nodes[r][N.own_workers] * 3);
    return {
      tick: Math.round(g[G.tick] * this.ctx.cap), resources: Math.round(g[G.resources] * 1000),
      freeSupply: maxSupply - supply - queuedSupply, units, buildings,
      depotBuilding: g[G.own_supply_depot_building] > 0, army, crystal, threat, contestedWorkers,
    };
  }

  /** Own-frame distance between normalised points, in px. */
  private dist(a: Pt, b: Pt): number {
    return Math.hypot((a.x - b.x) * this.ctx.W, (a.y - b.y) * this.ctx.H);
  }

  // ---- economy ----

  private buildAction(m: V2Masks, b: Building, sites: number[]): number {
    const bi = BUILDINGS.indexOf(b);
    for (const s of sites) {
      const i = ECON_BUILD0 + bi * BUILD_SITES + s;
      if (m.econ[i]) return i;
    }
    for (let s = 0; s < BUILD_SITES; s++) if (m.econ[ECON_BUILD0 + bi * BUILD_SITES + s]) return ECON_BUILD0 + bi * BUILD_SITES + s;
    return 0;
  }

  private econ(obs: ObsV2, v: View, m: V2Masks): number {
    const t = this.t;
    const train = (u: Unit) => (m.econ[ECON_TRAIN0 + TRAIN_UNITS.indexOf(u)] ? ECON_TRAIN0 + TRAIN_UNITS.indexOf(u) : 0);
    const armySize = COMBAT.reduce((s, u) => s + v.units[u], 0);
    const producers = v.buildings.barracks + v.buildings.foundry;

    if (producers > 0 && v.freeSupply <= t.headroom && !v.depotBuilding) {
      const d = this.buildAction(m, "supply_depot", POCKETS);
      if (d) return d;
    }
    let saving = 0;
    const step = t.builds.find((s) => v.buildings[s.b] < s.n);
    if (step && v.tick >= (step.tick ?? 0) && armySize >= (step.army ?? 0)) {
      const a = this.buildAction(m, step.b, step.sites);
      if (a) return a;
      if (v.resources < BUILDING_DEFS[step.b].cost) saving = BUILDING_DEFS[step.b].cost;
    }
    const late = t.late && v.tick >= t.late.tick ? t.late : null;
    if (v.units.worker < (late?.workers ?? t.workers)) {
      const w = train("worker");
      if (w) return w;
    }
    if (!saving) {
      // Most-needed unit first; save for it when it is unaffordable, try the next when its producers are busy.
      const weights = (Object.entries(t.mix) as Array<[Unit, number]>).filter(([u]) => this.canProduce(obs, u));
      const total = weights.reduce((s, [, w]) => s + w, 0);
      const order = weights.map(([u, w]) => ({ u, d: (w / total) * (armySize + 1) - v.units[u] })).sort((a, b) => b.d - a.d);
      for (const { u } of order) {
        const a = train(u);
        if (a) return a;
        if (v.resources < UNIT_DEFS[u].cost) break;
      }
    }
    if ((late?.contested ?? t.contested) > v.contestedWorkers && !v.threat) {
      const a = this.assignContested(obs, v, m);
      if (a) return a;
    }
    return 0;
  }

  /** A finished building of mine produces `u`. */
  private canProduce(obs: ObsV2, u: Unit): boolean {
    return BUILDINGS.some((b) => obs.globals[G[`own_${b}_done`]] > 0 && BUILDING_DEFS[b].produces?.includes(u));
  }

  /** One worker to the nearest own-half contested node not held by the enemy. */
  private assignContested(obs: ObsV2, v: View, m: V2Masks): number {
    const rows = this.contestedRows(obs, v).filter((r) => obs.nodes[r][N.x] < 0.5 && !obs.nodes[r][N.held_enemy]);
    for (const r of rows) {
      const i = ECON_ASSIGN0 + (SLOT_CONTESTED0 + r - NODE_ROW_CONTESTED0) * WORKER_COUNTS.length;
      if (m.econ[i]) return i;
    }
    return 0;
  }

  /** Contested node rows, nearest own crystal first (ties by row). */
  private contestedRows(obs: ObsV2, v: View): number[] {
    const rows: number[] = [];
    for (let r = NODE_ROW_CONTESTED0; r < obs.nodes.length; r++) if (obs.nodes[r][N.valid]) rows.push(r);
    const d = (r: number) => Math.round(this.dist({ x: obs.nodes[r][N.x], y: obs.nodes[r][N.y] }, v.crystal));
    return rows.sort((a, b) => d(a) - d(b) || a - b);
  }

  // ---- army ----

  private armyOrder(obs: ObsV2, v: View, m: V2Masks): { group: number; order: number; target: number } {
    const none = { group: 0, order: 0, target: TARGET_NONE };
    const size = v.army.length;
    if (size === 0 || !m.group[GROUP_ALL]) { this.pushing = false; return none; }
    if (!this.pushing && size >= this.pushSize && v.tick >= this.pushTick) {
      this.pushing = true; this.viaDone = false; this.ctrlAt = v.tick;
    }
    // A control push that makes no progress for CONTROL_PATIENCE ticks turns into a base attack
    // (holding more than half the contested nodes needs several separately ordered groups).
    if (this.pushing && this.target === "control") {
      const p = obs.globals[G.control_progress_own];
      if (p > this.ctrlBest) { this.ctrlBest = p; this.ctrlAt = v.tick; }
      else if (v.tick - this.ctrlAt > CONTROL_PATIENCE) this.target = "enemy_base";
    }
    if (this.pushing && size < this.t.push.regroup) this.pushing = false;

    let order = O_AM, target: number;
    if (v.threat) {
      target = T_OWN_BASE;
    } else if (this.pushing) {
      const hp = v.army.reduce((s, e) => s + e[F.hp], 0) / size;
      if (this.t.retreat > 0 && hp < this.t.retreat && m.order[GROUP_ALL][O_RETREAT]) {
        this.pushing = false;
        return this.issue(m, O_RETREAT, TARGET_NONE, true);
      }
      target = this.pushTarget(obs, v);
      if (this.t.push.via === "brush" && !this.viaDone) {
        const via = this.brushVia();
        const c = this.centroid(v.army);
        if (via < 0 || this.dist(c, this.norm(this.ctx.targets[via])) < 250) this.viaDone = true;
        else { order = O_MOVE; target = via; }
      }
    } else {
      target = this.stageTarget(obs, v);
    }
    return this.issue(m, order, target, false);
  }

  /** Issue an order if it changed or is due a refresh; otherwise no army action. */
  private issue(m: V2Masks, order: number, target: number, force: boolean) {
    const key = `${order}:${target}`;
    if (!force && key === this.lastOrder && this.decisions - this.lastOrderAt < ORDER_REFRESH) return { group: 0, order: 0, target: TARGET_NONE };
    if (!m.order[GROUP_ALL][order] || !m.target[order][target]) return { group: 0, order: 0, target: TARGET_NONE };
    this.lastOrder = key; this.lastOrderAt = this.decisions;
    return { group: GROUP_ALL, order, target };
  }

  private norm(p: Pt): Pt { return { x: p.x / this.ctx.W, y: p.y / this.ctx.H }; }

  private centroid(rows: number[][]): Pt {
    let x = 0, y = 0;
    for (const e of rows) { x += e[F.x]; y += e[F.y]; }
    return { x: x / rows.length, y: y / rows.length };
  }

  private valid(t: number): boolean { return !!this.ctx.targetValid[t]; }

  private pushTarget(obs: ObsV2, v: View): number {
    const rows = this.contestedRows(obs, v);
    const tgt = (r: number) => T_NODE0 + r - NODE_ROW_CONTESTED0;
    switch (this.target) {
      case "enemy_base": return T_ENEMY_BASE;
      case "enemy_safe": {
        const safe = [0, 1, 2, 3].filter((i) => obs.nodes[NODE_ROW_ENEMY_SAFE0 + i][N.valid] && this.valid(T_ENEMY_SAFE0 + i));
        return safe.length ? T_ENEMY_SAFE0 + safe[0] : T_ENEMY_BASE;
      }
      case "enemy_nodes": {
        const r = rows.find((x) => obs.nodes[x][N.held_enemy]);
        if (r !== undefined) return tgt(r);
        break;
      }
      case "control": break;
    }
    const need = Math.floor(rows.length / 2) + 1;
    const held = rows.filter((r) => obs.nodes[r][N.held_own]);
    if (held.length < need) {
      const r = rows.find((x) => !obs.nodes[x][N.held_own]);
      if (r !== undefined) return tgt(r);
    }
    return held.length ? tgt(held[held.length - 1]) : T_ENEMY_BASE;
  }

  private stageTarget(obs: ObsV2, v: View): number {
    switch (this.t.stage) {
      case "base": return T_OWN_BASE;
      case "choke": return this.valid(T_OWN_CHOKE0) ? T_OWN_CHOKE0 : T_OWN_BASE;
      case "hidden": {
        const b = this.hiddenSpot();
        return b >= 0 ? b : this.valid(T_OWN_POCKET0) ? T_OWN_POCKET0 : T_OWN_BASE;
      }
      case "own_nodes": {
        const rows = this.contestedRows(obs, v).filter((r) => obs.nodes[r][N.x] < 0.5);
        const lost = rows.find((r) => !obs.nodes[r][N.held_own]);
        const r = lost ?? rows[rows.length - 1];
        return r !== undefined ? T_NODE0 + r - NODE_ROW_CONTESTED0 : T_OWN_BASE;
      }
    }
  }

  /** An own-half brush anchor (pockets, chokes), farthest from the centre line; −1 if none. */
  private hiddenSpot(): number {
    let best = -1, bx = Infinity;
    for (const t of [1, 2, 3, 4, 5, 6]) {
      if (!this.valid(t) || !this.ctx.brush[t]) continue;
      const x = this.ctx.targets[t].x;
      if (x < bx) { bx = x; best = t; }
    }
    return best;
  }

  /** A brush anchor to route the attack through: centre or own chokes, then the flank-most centre anchor; −1 if none valid. */
  private brushVia(): number {
    for (const t of [7, 8, 9, 6, 5, 4, 30, 31, 32]) if (this.valid(t) && this.ctx.brush[t]) return t;
    let best = -1, off = -1;
    for (const t of [T_CENTRE0, T_CENTRE0 + 1, T_CENTRE0 + 2]) {
      if (!this.valid(t)) continue;
      const o = Math.abs(this.ctx.targets[t].y - this.ctx.H / 2);
      if (o > off) { off = o; best = t; }
    }
    return best;
  }
}
