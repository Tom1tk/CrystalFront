// Outrider play for the v3 scripted bots (mainline 0.10 plan §2a, beta ruleset).
//
// One shared scout routine: ride to the enemy base and circle its crystal just outside turret
// range, then park at a watch point; run from enemy combat units and turrets; go home below half
// health. Each game plan picks a style:
//   watch     scout once, then park on the enemy's attack path as early warning
//   map_watch watch the contested nodes and the enemy's expansion nodes, moving between the ones
//             the bot does not hold
//   careful   hit enemy workers only while no defender is in sight; run when one appears
//   reckless  go straight at the enemy's workers and keep hitting them; never runs, never goes home
// and whether it trains a new Outrider after one dies. Like the rest of the bot it sees only its
// own fogged observation and picks only legal actions.
import { UNIT_DEFS } from "@crystalfront/shared";
import type { Pt } from "../../../server/src/match/engine/anchors.js";
import {
  ECON_TRAIN0, GRID_CELL_H, GRID_CELL_W, GRID_CELLS, GRID_COLS, GROUPS, ORDERS, TARGET_GRID0, TARGET_NONE, TRAIN_UNITS,
  type V2Action, type V2Masks,
} from "./actions.js";
import { ENTITY_FEATURES, GLOBAL_NAMES, NODE_FEATURES, type ObsV2 } from "./observation.js";
import type { BotContext } from "./scripted.js";

export type ScoutStyle = "watch" | "map_watch" | "careful" | "reckless";
/** When a dead Outrider is replaced: never, with spare income, after a delay, or at once. */
export type Retrain = "never" | "spare" | "delay" | "always";

const G = Object.fromEntries(GLOBAL_NAMES.map((n, i) => [n, i])) as Record<string, number>;
const F = Object.fromEntries(ENTITY_FEATURES.map((n, i) => [n, i])) as Record<string, number>;
const N = Object.fromEntries(NODE_FEATURES.map((n, i) => [n, i])) as Record<string, number>;
const GROUP_SCOUT = GROUPS.indexOf("scout"), GROUP_UNIT = GROUPS.indexOf("unit");
const O_MOVE = ORDERS.indexOf("move"), O_AM = ORDERS.indexOf("attack_move"), O_FOCUS = ORDERS.indexOf("focus");
const O_RETREAT = ORDERS.indexOf("retreat"), O_GUARD = ORDERS.indexOf("guard");
const TRAIN_OUTRIDER = ECON_TRAIN0 + TRAIN_UNITS.indexOf("outrider");
const T_OWN_BASE = 0, T_CENTRE0 = 7, T_NODE0 = 10, T_ENEMY_BASE = 26, T_ENEMY_CHOKE0 = 30, T_ENEMY_SAFE0 = 33;
const NODE_ROW_ENEMY_SAFE0 = 4, NODE_ROW_CONTESTED0 = 8;
const COMBAT = ["skirmisher", "gunner", "bruiser", "medic", "bulwark"];

/** Circle radius round the enemy crystal (px): outside turret range of a turret beside it. */
const CIRCLE_R = 430;
/** A waypoint counts as reached within this distance (px). */
const ARRIVE = 110;
/** Run from enemy combat units or turrets within this distance (px). */
const DANGER_R = 330;
/** How far a run goes (px), and the decisions to keep away before turning back. */
const RUN_DIST = 600, RUN_DECISIONS = 12;
/** After this many runs while circling, the circle is cut short. */
const MAX_RUNS_OUT = 3;
/** Map watch: decisions spent at each watched node. */
const DWELL = 14;
/** Re-issue an unchanged order after this many decisions (the unit may have been stopped). */
const REFRESH = 10;
/** `spare` retrain needs this much in the bank; `delay` waits this many ticks after a death. */
const SPARE = 150, DELAY_TICKS = 1200;
/** Enemy Outrider near own workers: guard them for this many ticks (about 20 s), re-ordering this often (decisions). */
const GUARD_TICKS = 200, GUARD_GAP = 4, HARASS_R = 260;

type Phase = "out" | "post" | "home";

export class OutriderPlan {
  private phase: Phase = "out";
  private wp = 0;
  private runs = 0;
  private runUntil = -1;
  private dwell = 0;
  private watchIdx = 0;
  private watchPt: Pt | null = null;
  private lastKey = "";
  private lastAt = -99;
  private diedAt = -1;
  private had = false;
  /** The circle round the enemy crystal has been ridden (or cut short). */
  scouted = false;
  /** Enemy-Outrider guard: tick it ends (−1: none) and the decision of the last guard order. */
  private guardEnd = -1;
  private guardAt = -99;

  constructor(readonly style: ScoutStyle, readonly retrain: Retrain, private ctx: BotContext) {}

  // ---- geometry (own frame, normalised) ----

  private dist(a: Pt, b: Pt): number { return Math.hypot((a.x - b.x) * this.ctx.W, (a.y - b.y) * this.ctx.H); }
  private anchor(t: number): Pt | null {
    return this.ctx.targetValid[t] ? { x: this.ctx.targets[t].x / this.ctx.W, y: this.ctx.targets[t].y / this.ctx.H } : null;
  }
  /** The legal move target (grid cell) nearest `p`; −1 if none. */
  private cellNear(m: V2Masks, order: number, p: Pt): number {
    let best = -1, bd = Infinity;
    for (let g = 0; g < GRID_CELLS; g++) {
      if (!m.target[order][TARGET_GRID0 + g]) continue;
      const c = { x: ((g % GRID_COLS) * GRID_CELL_W + GRID_CELL_W / 2) / this.ctx.W, y: (Math.floor(g / GRID_COLS) * GRID_CELL_H + GRID_CELL_H / 2) / this.ctx.H };
      const d = this.dist(c, p);
      if (d < bd) { bd = d; best = g; }
    }
    return best < 0 ? -1 : TARGET_GRID0 + best;
  }
  /** Waypoints round the enemy crystal on its open side, top to bottom. */
  private circle(): Pt[] {
    const base = this.anchor(T_ENEMY_BASE);
    if (!base) return [];
    const out: Pt[] = [];
    for (const deg of [100, 140, 180, 220, 260]) {
      const a = (deg * Math.PI) / 180;
      const x = base.x + (Math.cos(a) * CIRCLE_R) / this.ctx.W, y = base.y + (Math.sin(a) * CIRCLE_R) / this.ctx.H;
      out.push({ x: Math.min(0.99, Math.max(0.01, x)), y: Math.min(0.97, Math.max(0.03, y)) });
    }
    return out;
  }

  // ---- reads ----

  private own(obs: ObsV2): { e: number[]; i: number } | null {
    const i = obs.entities.findIndex((e) => e[F.own] && e[F.type_outrider]);
    return i < 0 ? null : { e: obs.entities[i], i };
  }
  private static at(e: number[]): Pt { return { x: e[F.x], y: e[F.y] }; }
  private static isDefender(e: number[]): boolean { return COMBAT.some((u) => e[F[`type_${u}`]]) || !!e[F.type_turret]; }

  // ---- economy ----

  /** The econ action that trains a new Outrider, or 0. Call before the bot's own economy. */
  econ(obs: ObsV2, m: V2Masks, tick: number): number {
    const have = Math.round(obs.globals[G.own_outrider] * 20) + Math.round(obs.globals[G.queued_outrider] * 5) > 0;
    if (have) { this.had = true; this.diedAt = -1; return 0; }
    if (this.had && this.diedAt < 0) this.diedAt = tick;
    if (!this.had || !m.econ[TRAIN_OUTRIDER]) return 0;
    const resources = obs.globals[G.resources] * 1000;
    const ok = this.retrain === "always" ||
      (this.retrain === "spare" && resources >= SPARE + UNIT_DEFS.outrider.cost) ||
      (this.retrain === "delay" && this.diedAt >= 0 && tick - this.diedAt >= DELAY_TICKS);
    if (!ok) return 0;
    // A new Outrider starts its round again.
    this.phase = "out"; this.wp = 0; this.runs = 0; this.runUntil = -1; this.lastKey = "";
    return TRAIN_OUTRIDER;
  }

  // ---- army head ----

  /** This decision's Outrider order, or null; `urgent` orders (running, going home) may take the army slot. */
  order(obs: ObsV2, m: V2Masks, decisions: number): { a: Partial<V2Action>; urgent: boolean } | null {
    const me = this.own(obs);
    if (!me || !m.group[GROUP_SCOUT]) return null;
    const pos = OutriderPlan.at(me.e);
    const home = this.anchor(T_OWN_BASE) ?? { x: 0.02, y: 0.5 };
    const enemies = obs.entities.filter((e) => e[F.enemy]);

    if (this.style !== "reckless") {
      // Below half health: home for good (it stays as base vision).
      if (me.e[F.hp] < 0.5 && this.phase !== "home") {
        this.phase = "home";
        if (m.order[GROUP_SCOUT][O_RETREAT]) return this.send({ group: GROUP_SCOUT, order: O_RETREAT }, "home", decisions, true);
      }
      if (this.phase === "home") return null;
      // Run from enemy combat units and turrets.
      let near: Pt | null = null, nd = DANGER_R;
      for (const e of enemies) {
        if (!OutriderPlan.isDefender(e)) continue;
        const d = this.dist(OutriderPlan.at(e), pos);
        if (d < nd) { nd = d; near = OutriderPlan.at(e); }
      }
      if (near) {
        if (this.phase === "out" && decisions > this.runUntil && ++this.runs >= MAX_RUNS_OUT) { this.phase = "post"; this.scouted = true; }
        this.runUntil = decisions + RUN_DECISIONS;
        // Away from the nearest danger, leaning towards home (px-space unit vectors).
        const unit = (dx: number, dy: number) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
        const [ax, ay] = unit((pos.x - near.x) * this.ctx.W, (pos.y - near.y) * this.ctx.H);
        const [hx, hy] = unit((home.x - pos.x) * this.ctx.W, (home.y - pos.y) * this.ctx.H);
        const [rx, ry] = unit(ax + 0.6 * hx, ay + 0.6 * hy);
        const to = { x: pos.x + (rx * RUN_DIST) / this.ctx.W, y: pos.y + (ry * RUN_DIST) / this.ctx.H };
        const t = this.cellNear(m, O_MOVE, to);
        if (t >= 0 && m.order[GROUP_SCOUT][O_MOVE]) return this.send({ group: GROUP_SCOUT, order: O_MOVE, target: t }, "run", decisions, true, 4);
        return null;
      }
      if (decisions <= this.runUntil) return null; // keeping away for a while
    }

    // Workers in reach: careful and reckless raiders hit the nearest one.
    if (this.style === "careful" || this.style === "reckless") {
      const raid = this.style === "reckless" || this.phase === "post";
      if (raid && m.order[GROUP_SCOUT][O_FOCUS]) {
        let best = -1, bd = Infinity;
        obs.entities.forEach((e, i) => {
          if (!e[F.enemy] || !e[F.type_worker] || !m.ptr[O_FOCUS][i]) return;
          const d = this.dist(OutriderPlan.at(e), pos);
          if (d < bd) { bd = d; best = i; }
        });
        if (best >= 0) return this.send({ group: GROUP_SCOUT, order: O_FOCUS, ptr: best }, `hit${Math.round(bd / 50)}`, decisions, false);
      }
    }

    // Reckless: straight to the enemy's mining nodes; the others ride the circle first.
    if (this.style === "reckless") return this.goTo(m, this.enemyMining(obs, pos), decisions, O_AM);
    if (this.phase === "out") {
      const wps = this.circle();
      while (this.wp < wps.length && this.dist(pos, wps[this.wp]) < ARRIVE) this.wp++;
      if (this.wp >= wps.length) { this.phase = "post"; this.scouted = true; }
      else return this.goTo(m, wps[this.wp], decisions, O_MOVE);
    }
    // Parked or patrolling.
    if (this.style === "careful") return this.goTo(m, this.enemyMining(obs, pos), decisions, O_MOVE);
    if (this.style === "map_watch") return this.goTo(m, this.watchNode(obs, pos), decisions, O_MOVE);
    return this.goTo(m, this.anchor(T_ENEMY_CHOKE0) ?? this.anchor(T_CENTRE0), decisions, O_MOVE);
  }

  /** An enemy safe node that has (or may have) workers: the nearest one with enemy workers seen, else the nearest. */
  private enemyMining(obs: ObsV2, pos: Pt): Pt | null {
    let best: Pt | null = null, bd = Infinity;
    for (let r = NODE_ROW_ENEMY_SAFE0; r < NODE_ROW_ENEMY_SAFE0 + 4; r++) {
      const n = obs.nodes[r];
      if (!n?.[N.valid]) continue;
      const p = { x: n[N.x], y: n[N.y] };
      const d = this.dist(p, pos) - (n[N.enemy_workers] > 0 ? 2000 : 0);
      if (d < bd) { bd = d; best = p; }
    }
    return best ?? this.anchor(T_ENEMY_SAFE0) ?? this.anchor(T_ENEMY_BASE);
  }

  /**
   * Map watch: the contested and enemy safe nodes the bot does not hold, visited in turn (DWELL
   * decisions at each). The node being watched is kept until its time is up, so a hold that flickers
   * does not turn the Outrider back and forth.
   */
  private watchNode(obs: ObsV2, pos: Pt): Pt | null {
    const done = this.watchPt && this.dist(pos, this.watchPt) < ARRIVE * 1.5 && ++this.dwell >= DWELL;
    if (!this.watchPt || done) {
      const pts: Pt[] = [];
      for (let r = NODE_ROW_CONTESTED0; r < obs.nodes.length; r++) if (obs.nodes[r][N.valid] && !obs.nodes[r][N.held_own]) pts.push({ x: obs.nodes[r][N.x], y: obs.nodes[r][N.y] });
      for (let r = NODE_ROW_ENEMY_SAFE0; r < NODE_ROW_ENEMY_SAFE0 + 4; r++) if (obs.nodes[r]?.[N.valid]) pts.push({ x: obs.nodes[r][N.x], y: obs.nodes[r][N.y] });
      // Round the map in a fixed order (by x, then y); the next one after the last visited.
      pts.sort((a, b) => a.x - b.x || a.y - b.y);
      this.dwell = 0;
      this.watchPt = pts.length ? pts[this.watchIdx++ % pts.length] : this.anchor(T_CENTRE0);
    }
    return this.watchPt;
  }

  /**
   * Training teacher for a policy seat's scout slot (no dedupe; the caller compares with the order
   * the Outrider already has). `m` holds the slot's masks; the plan sees them as the `scout` group.
   * Returns the order the plan wants now as scout-slot fields, or null.
   */
  shadow(obs: ObsV2, m: V2Masks, decisions: number): { scoutOrder: number; scoutTarget: number; scoutPtr: number } | null {
    const open = m.scoutOrder.some((v, i) => i > 0 && v);
    const view: V2Masks = { ...m, group: m.group.map((v, i) => (i === GROUP_SCOUT ? open : v)), order: m.order.map((r, i) => (i === GROUP_SCOUT ? m.scoutOrder : r)) };
    this.lastKey = "";
    const r = this.order(obs, view, decisions);
    if (!r || !r.a.order) return null;
    return { scoutOrder: r.a.order, scoutTarget: r.a.target ?? TARGET_NONE, scoutPtr: r.a.ptr ?? 0 };
  }

  private goTo(m: V2Masks, p: Pt | null, decisions: number, order: number): { a: Partial<V2Action>; urgent: boolean } | null {
    if (!p || !m.order[GROUP_SCOUT][order]) return null;
    const t = this.cellNear(m, order, p);
    return t < 0 ? null : this.send({ group: GROUP_SCOUT, order, target: t }, `${order}:${t}`, decisions, false);
  }

  private send(a: Partial<V2Action>, key: string, decisions: number, urgent: boolean, refresh = REFRESH): { a: Partial<V2Action>; urgent: boolean } | null {
    if (key === this.lastKey && decisions - this.lastAt < refresh) return null;
    this.lastKey = key; this.lastAt = decisions;
    return { a, urgent };
  }

  // ---- enemy Outrider ----

  /**
   * An enemy Outrider near own workers: the nearest single combat unit guards those workers for
   * about 20 s. Returns its order (on decisions it is due), and whether the guard just ended (the
   * bot's main order should then go out again to take the unit back).
   */
  guardWorkers(obs: ObsV2, m: V2Masks, tick: number, decisions: number): { a: Partial<V2Action> | null; ended: boolean } {
    const workers = obs.entities.filter((e) => e[F.own] && e[F.type_worker]);
    const raider = obs.entities.find((e) => e[F.enemy] && e[F.type_outrider] && workers.some((w) => this.dist(OutriderPlan.at(w), OutriderPlan.at(e)) < HARASS_R));
    if (raider) {
      if (this.guardEnd < 0) this.guardEnd = tick + GUARD_TICKS;
    } else if (this.guardEnd >= 0 && tick >= this.guardEnd) {
      this.guardEnd = -1;
      return { a: null, ended: true };
    }
    if (this.guardEnd < 0 || !raider || decisions - this.guardAt < GUARD_GAP || !m.order[GROUP_UNIT][O_GUARD]) return { a: null, ended: false };
    const spot = OutriderPlan.at(raider);
    let best = -1, bd = Infinity;
    obs.entities.forEach((e, i) => {
      if (!e[F.own] || e[F.type_bulwark] || e[F.type_medic] || !COMBAT.some((u) => e[F[`type_${u}`]]) || !m.unit[O_GUARD][i]) return;
      const d = this.dist(OutriderPlan.at(e), spot);
      if (d < bd) { bd = d; best = i; }
    });
    const t = best >= 0 ? this.cellNear(m, O_GUARD, spot) : -1;
    if (t < 0) return { a: null, ended: false };
    this.guardAt = decisions;
    return { a: { group: GROUP_UNIT, order: O_GUARD, unit: best, target: t }, ended: false };
  }
}

/** What the bot's Outriders (and the rest of its army) have seen of the enemy, from the observation's last-seen counts. */
export function enemyReads(obs: ObsV2): { combat: number; barracks: number; turrets: number; outposts: number; contestedWorkers: number } {
  const g = obs.globals;
  const combat = COMBAT.reduce((s, u) => s + Math.round(g[G[`seen_${u}`]] * 20), 0);
  let contestedWorkers = 0;
  for (let r = NODE_ROW_CONTESTED0; r < obs.nodes.length; r++) contestedWorkers += Math.round(obs.nodes[r][N.enemy_workers] * 3);
  return {
    combat, barracks: Math.round(g[G.seen_barracks] * 5), turrets: Math.round(g[G.seen_turret] * 5),
    outposts: Math.round(g[G.seen_outpost] * 5), contestedWorkers,
  };
}
