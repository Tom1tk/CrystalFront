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
import { getVisionRange, onHighGround } from "../../../server/src/match/engine/utils.js";
import { losSet, visionCellOf, visionGridOf } from "../../../server/src/match/engine/visibility.js";
import type { MatchEntity, MatchState } from "../../../server/src/match/types.js";
import { fromOwnFrame, toOwnFrame } from "./frame.js";
import type { SeatState } from "./actions.js";
import { OutriderPlan, enemyReads, type Retrain, type ScoutStyle } from "./scout.js";
import {
  act, BUILDINGS, ECON_ASSIGN0, ECON_BUILD0, ECON_REPAIR, ECON_TRAIN0, GRID_CELL_H, GRID_CELL_W, GRID_CELLS, GRID_COLS, GRID_ROWS, GROUPS, NAMED_SITES, ORDERS, TARGET_GRID0, TARGET_NONE, TRAIN_UNITS, WORKER_COUNTS,
  type V2Action, type V2Masks,
} from "./actions.js";
import { ENTITY_FEATURES, ENTITY_TYPES, GLOBAL_NAMES, MEMORY_FEATURES, MEMORY_TYPES, NODE_FEATURES, type ObsV2 } from "./observation.js";

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
  /** Grid cells (the action grid, row-major) whose walk point is in brush: a unit standing there is hidden from anyone outside the patch. */
  brushCell: boolean[];
  /**
   * The grid cells a watcher of this kind ("crystal", a unit type or a building type) at `p` (own frame, px) sees, by the
   * game's line-of-sight rules. A cell counts as seen if any part of it is. Brush is left out (see `brushCell`).
   */
  sight(p: Pt, kind: string): readonly number[];
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
  const brushCell = s.grid.map((p) => !!p && terrainAt(t, p.x, p.y) === T_BRUSH);
  // Vision cell (world) → the grid cells (own frame) it overlaps.
  const vg = visionGridOf(t);
  const cellsOf: number[][] = [];
  for (let r = 0; r < vg.rows; r++) {
    for (let c = 0; c < vg.cols; c++) {
      const a = toOwnFrame(s.frame, { x: c * vg.cellSize - vg.offsetX, y: r * vg.cellSize - vg.offsetY });
      const b = toOwnFrame(s.frame, { x: (c + 1) * vg.cellSize - vg.offsetX, y: (r + 1) * vg.cellSize - vg.offsetY });
      const x0 = Math.max(0, Math.min(a.x, b.x)), x1 = Math.min(W, Math.max(a.x, b.x));
      const y0 = Math.max(0, Math.min(a.y, b.y)), y1 = Math.min(H, Math.max(a.y, b.y));
      const out: number[] = [];
      for (let gr = Math.floor(y0 / GRID_CELL_H); gr * GRID_CELL_H < y1; gr++) {
        for (let gc = Math.floor(x0 / GRID_CELL_W); gc * GRID_CELL_W < x1; gc++) out.push(gr * GRID_COLS + gc);
      }
      cellsOf.push(out);
    }
  }
  const seen = new Map<string, number[]>();
  const sight = (p: Pt, kind: string): readonly number[] => {
    const w = fromOwnFrame(s.frame, p);
    const e = (kind === "crystal" ? { type: "crystal" } : BUILDING_DEFS[kind] ? { type: "building", buildingType: kind } : { type: kind }) as MatchEntity;
    e.x = w.x; e.y = w.y;
    const src = visionCellOf(vg, w.x, w.y), range = getVisionRange(e, t), high = onHighGround(e, t);
    const key = `${src}:${range}:${high ? 1 : 0}`;
    let out = seen.get(key);
    if (!out) {
      const set = new Set<number>();
      for (const v of losSet(vg, src, range, high)) for (const g of cellsOf[v]) set.add(g);
      seen.set(key, (out = [...set]));
    }
    return out;
  };
  return { W, H, cap, targets: s.targets.map((p) => toOwnFrame(s.frame, p)), targetValid: [...s.targetValid], brush, brushCell, sight };
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
  /**
   * `via`: the route before the attack. `brush` through a brush anchor; `edge` along a map edge (top or bottom, drawn per game)
   * into the enemy half; `swing` up the middle, then out to an edge on the enemy half and in from the side.
   */
  push: { tick: number; size: number; regroup: number; targets: PushTarget[]; via?: "brush" | "edge" | "swing" };
  stage: Stage;
  /** Retreat when pushing and the army's mean health fraction drops below this. */
  retreat: number;
  /** Push and regroup sizes count only the main body (units gathered around the army's middle unit), not the whole army. */
  mass?: boolean;
  /** Keep together on a push: when the leading units get COHERE_FAR ahead of the army's middle unit, the army gathers on it until they are within COHERE_NEAR. */
  cohere?: boolean;
  /** From this tick on, rebuild the economy to these targets (rushes that did not end the game). */
  late?: { tick: number; workers: number; contested: number };
  /**
   * Forward outposts, `n` of them, built by one worker sent forward as the forward builder (needs a barracks).
   * `escort`: the push heads for the enemy choke and holds while the worker walks with the army and
   * builds them beside it on the enemy half, then goes on. `backdoor`: from `tick` on the worker goes round a map edge and builds
   * them beside the enemy crystal; skirmishers are then trained there first and attack on their own,
   * while the template's own push is played by the gunners.
   */
  post?: { mode: "escort" | "backdoor"; n: number; tick?: number };
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
    z: 9, label: "foundry first, slow unstoppable push", workers: 8, contested: 1, headroom: 3,
    builds: [
      { b: "foundry", n: 1, sites: BASE }, { b: "supply_depot", n: 1, sites: POCKETS }, { b: "barracks", n: 1, sites: BASE, army: 3 },
      { b: "supply_depot", n: 2, sites: POCKETS, army: 5 },
    ],
    mix: { bruiser: 3, gunner: 2, medic: 1 }, push: { tick: 0, size: 16, regroup: 6, targets: ["enemy_base"] }, stage: "base", retreat: 0.35, cohere: true,
  },
  heavy_turret: {
    z: 10, label: "heavy army behind forward turrets", workers: 8, contested: 1, headroom: 3,
    builds: [
      { b: "foundry", n: 1, sites: BASE }, { b: "turret", n: 2, sites: FORWARD }, { b: "supply_depot", n: 1, sites: POCKETS },
      { b: "barracks", n: 1, sites: BASE, army: 4 },
    ],
    mix: { bruiser: 3, gunner: 2, medic: 1 }, push: { tick: 0, size: 16, regroup: 6, targets: ["enemy_base", "control"] }, stage: "choke", retreat: 0.35, cohere: true,
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
  // Counters to a gunner mass (found by PPO run m1-ppo-kl): skirmishers that charge instead of standing.
  skirm_swarm: {
    z: 16, label: "economy, then a skirmisher + medic swarm", workers: 8, contested: 2, headroom: 3,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE }, { b: "foundry", n: 1, sites: BASE, army: 4 },
      { b: "barracks", n: 3, sites: BASE, army: 8 },
    ],
    mix: { skirmisher: 4, medic: 1 }, push: { tick: 0, size: 18, regroup: 10, targets: ["enemy_base"] }, stage: "base", retreat: 0.4,
  },
  skirm_mass: {
    z: 17, label: "economy, then massed skirmishers", workers: 8, contested: 2, headroom: 3,
    builds: [{ b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE }, { b: "barracks", n: 3, sites: BASE, army: 6 }],
    mix: { skirmisher: 1 }, push: { tick: 0, size: 20, regroup: 10, targets: ["enemy_base"] }, stage: "base", retreat: 0,
  },
  skirm_tide: {
    z: 18, label: "turrets at home, late skirmisher + medic swarm", workers: 8, contested: 2, headroom: 3,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "turret", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE },
      { b: "foundry", n: 1, sites: BASE, army: 4 }, { b: "turret", n: 2, sites: BASE, army: 6 },
    ],
    mix: { skirmisher: 4, medic: 1 }, push: { tick: 0, size: 24, regroup: 12, targets: ["enemy_base"] }, stage: "base", retreat: 0.4,
  },
  // The swarm with escorted forward outposts: reinforcements appear beside the army instead of walking from home.
  skirm_forward: {
    z: 21, label: "skirmisher + medic swarm, escorts a worker forward to build outposts", workers: 8, contested: 2, headroom: 3,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE }, { b: "foundry", n: 1, sites: BASE, army: 4 },
      { b: "barracks", n: 3, sites: BASE, army: 8 },
    ],
    mix: { skirmisher: 4, medic: 1 }, push: { tick: 0, size: 18, regroup: 10, targets: ["enemy_base"] }, stage: "base", retreat: 0.4,
    post: { mode: "escort", n: 2 },
  },
  // Outposts at home beside the one barracks they need: cheaper and quicker than a second barracks (the control is rush_heavy).
  rush_outpost: {
    z: 22, label: "skirmisher rush from a barracks and home outposts", workers: 4, contested: 0, headroom: 2,
    builds: [{ b: "barracks", n: 1, sites: BASE }, { b: "outpost", n: 2, sites: BASE }],
    mix: { skirmisher: 1 }, push: { tick: 300, size: 2, regroup: 0, targets: ["enemy_base"] }, stage: "base", retreat: 0,
    late: { tick: 3000, workers: 7, contested: 2 },
  },
  // The turtle with a second prong: one worker sneaks round the map edge and builds outposts beside the enemy crystal.
  backdoor: {
    z: 23, label: "turrets and gunners at home, outposts behind the enemy crystal", workers: 7, contested: 2, headroom: 2,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "supply_depot", n: 1, sites: POCKETS }, { b: "turret", n: 2, sites: FORWARD },
      { b: "barracks", n: 2, sites: BASE, army: 6 },
    ],
    mix: { gunner: 1 }, push: { tick: 0, size: 8, regroup: 4, targets: ["control"] }, stage: "own_nodes", retreat: 0,
    post: { mode: "backdoor", n: 3, tick: 600 },
  },
  // The turtle's late attack: a large gunner army escorts a worker forward, then fights beside its own outposts.
  turtle_siege: {
    z: 24, label: "turrets and gunners, late escorted outposts at the enemy's door", workers: 7, contested: 2, headroom: 3,
    builds: [
      { b: "supply_depot", n: 1, sites: POCKETS }, { b: "turret", n: 1, sites: FORWARD }, { b: "barracks", n: 1, sites: BASE },
      { b: "turret", n: 3, sites: FORWARD }, { b: "barracks", n: 2, sites: BASE, army: 6 },
    ],
    mix: { gunner: 3, skirmisher: 1 }, push: { tick: 3000, size: 14, regroup: 6, targets: ["enemy_base"] }, stage: "own_nodes", retreat: 0.3, mass: true,
    post: { mode: "escort", n: 3 },
  },
  // Massed gunners: phalanx without the foundry and bulwarks (the control for it, and the strongest scripted army).
  gunline: {
    z: 20, label: "economy, then massed gunners", workers: 7, contested: 2, headroom: 3,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE, army: 4 },
    ],
    mix: { gunner: 1 }, push: { tick: 0, size: 12, regroup: 6, targets: ["enemy_base", "control"] }, stage: "choke", retreat: 0.3, mass: true,
  },
  // Gunners behind bulwarks: the shields take the enemy's shots.
  phalanx: {
    z: 19, label: "economy, then gunners behind bulwarks", workers: 7, contested: 2, headroom: 3,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "foundry", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE, army: 4 },
    ],
    mix: { gunner: 4, bulwark: 1 }, push: { tick: 0, size: 12, regroup: 6, targets: ["enemy_base", "control"] }, stage: "choke", retreat: 0.3, mass: true,
  },
  // Flankers: armies that come round the side instead of down the middle (b2, against turrets clumped on the central route).
  flank_edge: {
    z: 27, label: "gunners and skirmishers round a map edge", workers: 7, contested: 2, headroom: 3,
    builds: [{ b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE, army: 4 }],
    mix: { gunner: 2, skirmisher: 1 }, push: { tick: 0, size: 12, regroup: 5, targets: ["enemy_base"], via: "edge" }, stage: "base", retreat: 0, cohere: true,
  },
  flank_swarm: {
    z: 28, label: "skirmisher + medic swarm round a map edge", workers: 8, contested: 2, headroom: 3,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE }, { b: "foundry", n: 1, sites: BASE, army: 4 },
    ],
    mix: { skirmisher: 4, medic: 1 }, push: { tick: 0, size: 16, regroup: 8, targets: ["enemy_base"], via: "edge" }, stage: "base", retreat: 0.4,
  },
  flank_swing: {
    z: 29, label: "heavy push up the middle that swings out and hits from the side", workers: 8, contested: 2, headroom: 3,
    builds: [
      { b: "barracks", n: 1, sites: BASE }, { b: "foundry", n: 1, sites: BASE }, { b: "barracks", n: 2, sites: BASE, army: 4 },
    ],
    mix: { gunner: 2, bruiser: 1, skirmisher: 1 }, push: { tick: 0, size: 14, regroup: 6, targets: ["enemy_base", "enemy_safe"], via: "swing" }, stage: "choke", retreat: 0.3, cohere: true,
  },
};

/**
 * `read`: an informed switcher (§2a) that switches on what it has seen rather than at a random time;
 * `scout`: its Outrider style and when a dead Outrider is replaced (default: by game plan, `scoutFor`).
 */
interface BotDef { templates: string[]; switchTo?: string; z?: number; read?: "macro" | "turtle"; scout?: [ScoutStyle, Retrain] }

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
  swarm: { templates: ["skirm_swarm"] },
  swarm_mass: { templates: ["skirm_mass"] },
  swarm_tide: { templates: ["skirm_tide"] },
  phalanx: { templates: ["phalanx"] },
  gunline: { templates: ["gunline"] },
  vanguard: { templates: ["skirm_forward"] },
  rush_post: { templates: ["rush_outpost"] },
  backdoor: { templates: ["backdoor"] },
  siege: { templates: ["turtle_siege"] },
  sw_read_macro: { templates: ["macro_light"], z: 25, read: "macro", scout: ["map_watch", "spare"] },
  sw_read_turtle: { templates: ["turtle_hold"], z: 26, read: "turtle", scout: ["watch", "spare"] },
  flank: { templates: ["flank_edge", "flank_swarm"] },
  swing: { templates: ["flank_swing"] },
};

/** Outrider style by bot (mainline 0.10 plan §2a); bots not listed watch and never retrain. */
const SCOUT_STYLE: Record<string, [ScoutStyle, Retrain]> = {
  rush1: ["reckless", "always"],
  turtle: ["watch", "spare"], heavy: ["watch", "spare"], siege: ["watch", "spare"],
  macro: ["map_watch", "spare"], swarm: ["map_watch", "spare"], swarm_mass: ["map_watch", "spare"], swarm_tide: ["map_watch", "spare"],
  sw_macro_bruiser: ["map_watch", "spare"], sw_turtle_grab: ["map_watch", "spare"],
  hidden: ["careful", "delay"], backdoor: ["careful", "delay"], rush_post: ["careful", "delay"],
  flank: ["careful", "delay"], swing: ["map_watch", "spare"],
};
export function scoutFor(name: string): [ScoutStyle, Retrain] {
  return SCRIPTED[name]?.scout ?? SCOUT_STYLE[name] ?? ["watch", "never"];
}
/** Informed switchers: enemy combat units that count as an early army; reading stops at this tick (4:00). */
const READ_ARMY = 4, READ_UNTIL = 2400;
/** "Little army" reads count only from 3:00, when every plan has had time to build one. */
const READ_SMALL = 1800;
/** A fast expansion: more enemy workers on contested nodes than a standard plan keeps there (2). */
const READ_EXPAND = 3;
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
const M = Object.fromEntries(MEMORY_FEATURES.map((n, i) => [n, i])) as Record<string, number>;
const COMBAT: Unit[] = ["skirmisher", "gunner", "bruiser", "medic", "bulwark"];

const GROUP_ALL = GROUPS.indexOf("all_combat"), GROUP_MEDICS = GROUPS.indexOf("medics"), GROUP_UNIT = GROUPS.indexOf("unit");
const GROUP_SKIRMISHERS = GROUPS.indexOf("skirmishers"), GROUP_GUNNERS = GROUPS.indexOf("gunners");
const O_AM = ORDERS.indexOf("attack_move"), O_MOVE = ORDERS.indexOf("move"), O_RETREAT = ORDERS.indexOf("retreat");
const O_GUARD = ORDERS.indexOf("guard"), O_FOCUS = ORDERS.indexOf("focus"), O_HEAL = ORDERS.indexOf("heal"), O_COVER = ORDERS.indexOf("cover");
/** Micro (v3): enemies and wounded allies within this distance (px) of the army centre count. */
const MICRO_RADIUS = 300;
/** Units this close to the army's middle unit count as its main body (templates with `mass`). */
const MASS_RADIUS = 400;
/** `cohere` templates: gather when the leading quarter of the army is this far ahead of its middle unit (px); go on once within COHERE_NEAR. */
const COHERE_FAR = 250, COHERE_NEAR = 120;
/** Edge and swing routes: how close the army's centre must get to a waypoint (px), how long it may take (ticks), and how far from the edge it walks (fraction of the height). */
const VIA_NEAR = 220, VIA_PATIENCE = 900, FLANK_EDGE_Y = 0.1;
/** Scripted bots repair own turrets below this health fraction. */
const REPAIR_BELOW = 0.75;
/** A focus order holds the main army order back for this many decisions; micro of one kind repeats at most this often. */
const FOCUS_DECISIONS = 3;
const MICRO_GAP = 4;
/** Focus enemies below this HP fraction; heal allies below this; pull back own units below this when enemies are close. */
const FOCUS_HP = 0.6, HEAL_HP = 0.7, PULL_HP = 0.25;
const T_OWN_BASE = 0, T_OWN_POCKET0 = 1, T_OWN_CHOKE0 = 4, T_CENTRE0 = 7, T_NODE0 = 10, T_ENEMY_BASE = 26, T_ENEMY_POCKET0 = 27, T_ENEMY_CHOKE0 = 30, T_ENEMY_SAFE0 = 33;
const NODE_ROW_CONTESTED0 = 8, NODE_ROW_ENEMY_SAFE0 = 4;
const SLOT_CONTESTED0 = 4;
/** Re-issue an unchanged army order after this many decisions. */
const ORDER_REFRESH = 6;
const THREAT_RADIUS = 600;

/** Own crystal position (own frame, normalised; the last own crystal row, else the left edge's middle). */
export function ownCrystalAt(obs: ObsV2): Pt {
  let crystal: Pt = { x: 0, y: 0.5 };
  for (const e of obs.entities) if (e[F.own] && e[F.type_crystal]) crystal = { x: e[F.x], y: e[F.y] };
  return crystal;
}

/** The scripted threat rule: a visible enemy combat unit within THREAT_RADIUS (px) of the own crystal. Shared with defence.ts. */
export function crystalThreat(obs: ObsV2, ctx: BotContext): boolean {
  const c = ownCrystalAt(obs);
  return obs.entities.some((e) => !e[F.own] && COMBAT.some((u) => e[F[`type_${u}`]]) && Math.hypot((e[F.x] - c.x) * ctx.W, (e[F.y] - c.y) * ctx.H) < THREAT_RADIUS);
}
const CONTROL_PATIENCE = 1500;
/** Enemy bulwarks stopping more than this share of own shots (recent peak) turn half of new production to melee. */
const SHIELD_REACT = 0.2;
const SHIELD_DECAY = 0.98;
/** Forward outposts: the worker counts as with the army, or at the backdoor spot, within this distance (px). */
const POST_NEAR = 200;
/** From Surge II on, the most units a push waits for. */
const SURGE_PUSH = 5;
/** An escort hold lasts at most this many ticks; then the push goes on without the outposts. */
const ESCORT_PATIENCE = 1800;
/** Decisions between orders to the forward worker; forward workers a bot spends per game. */
const POST_WORKER_GAP = 4, POST_WORKERS = 3;
/** Backdoor outposts go this far (px) from the enemy crystal when no hidden ground is found, toward the bot's side of the map. */
const BACKDOOR_OFFSET = 320;
/** Backdoor outposts go on ground the enemy is not known to see, between these distances (px) from its crystal. */
const BACKDOOR_MIN = 250, BACKDOOR_MAX = 900;
/** Backdoor skirmishers wait in brush when there is some within this distance (px) of their outposts. */
const BACKDOOR_BRUSH = 300;
/** Hiding: walking onto a grid cell a known enemy watcher sees costs this many times its length; a cell the enemy is likely to see, this many. */
const SEEN_COST = 25, LIKELY_COST = 4;
/** Backdoor skirmishers wait at their outposts until this many stand there, then attack; below the second number they gather again. */
const BACKDOOR_MASS = 8, BACKDOOR_REGROUP = 3;
/** With escorted outposts standing and full, a skirmisher is trained at home only with this many skirmishers' worth of resources in hand. */
const FRONT_SPILL = 3;

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
  /** Edge and swing routes: the waypoint the army is walking to, and the tick it set out for it. */
  private viaStep = 0;
  private viaAt = 0;
  /** `cohere`: grid cell the army is gathering on (−1: not gathering). */
  private gather = -1;
  /** Control push: best own control progress seen and the tick it was reached. */
  private ctrlBest = 0;
  /** Surge II push rule applied (beta). */
  private surged = false;
  private ctrlAt = 0;
  /** Micro: the main army order waits until this decision (after a focus); last decision of each micro kind. */
  private focusUntil = 0;
  private lastMicro: Record<"pull" | "focus" | "heal" | "shield", number> = { pull: -99, focus: -99, heal: -99, shield: -99 };
  /** Recent peak of the share of own shots stopped by enemy bulwarks (decays per decision). */
  private shielded = 0;
  /** Forward outposts: tick the escort hold began (−1: none), whether this push is done with it, workers sent,
   *  last decision with a worker order, the backdoor's side of the map (0 top, 1 bottom) and the grid cell its outposts go at (−1: not chosen),
   *  and whether an outpost is being saved for. */
  private postHold = -1;
  private postDone = false;
  private postSent = 0;
  private lastPostOrder = -99;
  private edge = 0;
  private spot = -1;
  private postSaving = false;
  private lastSkirmOrder = -99;
  private striking = false;

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
    // (Drawn only by templates that use it, so the other bots' draws are unchanged.)
    if (this.t.post?.mode === "backdoor" || this.t.push.via === "edge" || this.t.push.via === "swing") this.edge = rng.random() < 0.5 ? 0 : 1;
    this.rng = rng;
    const [style, retrain] = scoutFor(name);
    this.scout = new OutriderPlan(style, retrain, ctx);
    this.read = def.read ?? null;
  }
  private rng: Rng;
  private scout: OutriderPlan;
  /** Informed switcher still reading the enemy (null once it has decided, or for other bots). */
  private read: "macro" | "turtle" | null;

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
    if (this.read) this.readEnemy(obs, v.tick);
    this.site = 0; this.econPtr = 0;
    this.shielded = Math.max(obs.globals[G.shots_blocked], this.shielded * SHIELD_DECAY);
    const econ = this.scout.econ(obs, m, v.tick) || this.econ(obs, v, m);
    let army: Partial<V2Action> = this.armyOrder(obs, v, m);
    if (this.t.post?.mode === "backdoor") {
      // The backdoor's worker and skirmishers come before the home army's order (which is then issued on the next decision).
      const post = this.postOrder(obs, v, m);
      if (post) { if (army.group) this.lastOrder = ""; army = post; }
      else if (!army.group) army = this.micro(obs, v, m) ?? army;
    } else if (!army.group) army = this.postOrder(obs, v, m) ?? this.micro(obs, v, m) ?? army;
    // An enemy Outrider at the workers: one unit guards them for a while (it comes before the army order, which goes out again next decision).
    const guard = this.scout.guardWorkers(obs, m, v.tick, this.decisions);
    if (guard.ended) this.lastOrder = "";
    if (guard.a) { if (army.group) this.lastOrder = ""; army = guard.a; }
    else {
      // The Outrider: urgent orders (running, going home) take the army slot; the others only a free one.
      const s = this.scout.order(obs, m, this.decisions);
      if (s && (s.urgent || !army.group)) { if (army.group) this.lastOrder = ""; army = s.a; }
    }
    this.decisions++;
    return act({ econ, site: econ >= ECON_BUILD0 && econ < ECON_ASSIGN0 ? this.site : 0, econPtr: this.econPtr, ...army });
  }

  /** Informed switchers: switch on what has been seen of the enemy, or stay on the first plan at READ_UNTIL. */
  private readEnemy(obs: ObsV2, tick: number): void {
    const r = enemyReads(obs);
    let to: string | null = null;
    if (this.read === "macro") {
      if (r.combat >= READ_ARMY || r.barracks >= 2) to = "turtle_gunner";
      else if (r.turrets > 0 && r.combat <= 1 && tick >= READ_SMALL) to = "bruiser_timing";
    } else if (this.read === "turtle") {
      if (r.combat > READ_ARMY) this.read = null; // a big army: the turtle stays
      else if (r.contestedWorkers >= READ_EXPAND || r.outposts > 0 || (this.scout.scouted && r.combat <= 2 && tick >= READ_SMALL)) to = "control_grab";
    }
    if (to) {
      this.t = TEMPLATES[to]; this.read = null;
      this.jitter(this.t, this.rng);
      this.pushing = false; this.viaDone = false; this.lastOrder = ""; this.ctrlBest = 0;
    } else if (tick >= READ_UNTIL) this.read = null;
  }

  /** Template label now (informed switchers change it when they switch). */
  get template(): string { return this.t.label; }

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
    for (const e of obs.entities) {
      if (e[F.own]) {
        if (e[F.type_crystal]) crystal = { x: e[F.x], y: e[F.y] };
        // Backdoor skirmishers fight on their own beside the enemy crystal: they are not part of the army the template leads.
        else if (COMBAT.some((u) => e[F[`type_${u}`]]) && !(this.t.post?.mode === "backdoor" && e[F.type_skirmisher])) army.push(e);
      }
    }
    const threat = crystalThreat(obs, this.ctx);
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

  /** Build `b` at the first legal preferred site, else any legal site (named first, then grid). Sets `this.site`. */
  private buildAction(m: V2Masks, b: Building, sites: number[]): number {
    const bi = BUILDINGS.indexOf(b);
    if (!m.econ[ECON_BUILD0 + bi]) return 0;
    const site = sites.find((s) => m.site[bi][s]) ?? m.site[bi].indexOf(true);
    if (site < 0) return 0;
    this.site = site;
    return ECON_BUILD0 + bi;
  }
  /** Build `b` at the legal grid site nearest `near` (own frame, normalised); `extra` adds px to a cell's distance. Sets `this.site`. */
  private buildNear(m: V2Masks, b: Building, near: Pt, extra?: (g: number) => number): number {
    const bi = BUILDINGS.indexOf(b);
    if (!m.econ[ECON_BUILD0 + bi]) return 0;
    let best = -1, bd = Infinity;
    for (let g = 0; g < GRID_CELLS; g++) {
      if (!m.site[bi][NAMED_SITES + g]) continue;
      const c = { x: ((g % GRID_COLS) * GRID_CELL_W + GRID_CELL_W / 2) / this.ctx.W, y: (Math.floor(g / GRID_COLS) * GRID_CELL_H + GRID_CELL_H / 2) / this.ctx.H };
      const d = Math.round(this.dist(c, near)) + (extra?.(g) ?? 0);
      if (d < bd) { bd = d; best = g; }
    }
    if (best < 0) return 0;
    this.site = NAMED_SITES + best;
    return ECON_BUILD0 + bi;
  }
  /** Build site chosen by the last buildAction this decision. */
  private site = 0;
  /** Econ pointer row (repair target) chosen this decision. */
  private econPtr = 0;

  private econ(obs: ObsV2, v: View, m: V2Masks): number {
    const t = this.t;
    const train = (u: Unit) => (m.econ[ECON_TRAIN0 + TRAIN_UNITS.indexOf(u)] ? ECON_TRAIN0 + TRAIN_UNITS.indexOf(u) : 0);
    const armySize = COMBAT.reduce((s, u) => s + v.units[u], 0);
    const producers = v.buildings.barracks + v.buildings.foundry + v.buildings.outpost;

    // Repair the most damaged own turret below REPAIR_BELOW health, if a worker can be sent.
    if (m.econ[ECON_REPAIR]) {
      let best = -1;
      obs.entities.forEach((e, i) => {
        if (e[F.own] && e[F.type_turret] && e[F.hp] < REPAIR_BELOW && m.econPtr[0][i] &&
            (best < 0 || e[F.hp] < obs.entities[best][F.hp])) best = i;
      });
      if (best >= 0) { this.econPtr = best; return ECON_REPAIR; }
    }

    if (producers > 0 && v.freeSupply <= t.headroom && !v.depotBuilding) {
      const d = this.buildAction(m, "supply_depot", POCKETS);
      if (d) return d;
    }
    // Forward outposts come first once their worker is in place.
    const post = this.postBuild(obs, v, m);
    if (post) return post;
    let saving = this.postSaving ? BUILDING_DEFS.outpost.cost : 0;
    const step = t.builds.find((s) => v.buildings[s.b] < s.n);
    if (!saving && step && v.tick >= (step.tick ?? 0) && armySize >= (step.army ?? 0)) {
      const a = this.buildAction(m, step.b, step.sites);
      if (a) return a;
      if (v.resources < BUILDING_DEFS[step.b].cost) saving = BUILDING_DEFS[step.b].cost;
    }
    const late = t.late && v.tick >= t.late.tick ? t.late : null;
    if (v.units.worker < (late?.workers ?? t.workers)) {
      const w = train("worker");
      if (w) return w;
    }
    // Backdoor: every skirmisher an outpost can take comes before the home army.
    if (!saving && t.post?.mode === "backdoor" && this.outpostFree(obs)) {
      const a = train("skirmisher");
      if (a) return a;
      if (v.resources < UNIT_DEFS.skirmisher.cost) saving = UNIT_DEFS.skirmisher.cost;
    }
    // Backdoor: once the worker is on the enemy half nothing is trained at home, so the outposts open with a full purse.
    const banking = t.post?.mode === "backdoor" && obs.globals[G.own_outpost_done] === 0 && (this.forwardWorker(obs)?.e[F.x] ?? 0) >= 0.5;
    if (!saving && !banking) {
      // Most-needed unit first; save for it when it is unaffordable, try the next when its producers are busy.
      const weights = (Object.entries(t.mix) as Array<[Unit, number]>).filter(([u]) => this.canProduce(obs, u));
      if (this.shielded > SHIELD_REACT) {
        // Shots are being stopped by enemy bulwarks: melee is not, so it gets half of new production.
        const melee = (["skirmisher", "bruiser"] as Unit[]).find((u) => this.canProduce(obs, u));
        const sum = weights.reduce((s, [, w]) => s + w, 0);
        const have = weights.find(([u]) => u === melee);
        if (melee && have) have[1] += sum; else if (melee) weights.push([melee, sum]);
      }
      const total = weights.reduce((s, [, w]) => s + w, 0);
      const order = weights.map(([u, w]) => ({ u, d: (w / total) * (armySize + 1) - v.units[u] })).sort((a, b) => b.d - a.d);
      // With escorted outposts standing, skirmishers are trained there first: at home only when the outposts are full and resources pile up.
      const frontFirst = t.post?.mode === "escort" && obs.globals[G.own_outpost_done] > 0 && !this.outpostFree(obs) && v.resources < FRONT_SPILL * UNIT_DEFS.skirmisher.cost;
      for (const { u } of order) {
        if (u === "skirmisher" && frontFirst) continue;
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
    if (v.army.length === 0 || !m.group[this.main]) { this.endPush(); return none; }
    const size = this.t.mass ? this.massed(v) : v.army.length;
    // Surges (beta): from Surge II the clock decides, so every style goes out with what it has,
    // and a side not ahead on its control bar fights for the nodes (the fuller bar wins at 20:00).
    if (!this.surged && obs.globals[G.surge_stage] >= 2 / 3 - 1e-6) {
      this.surged = true;
      this.pushSize = Math.min(this.pushSize, Math.max(SURGE_PUSH, this.t.push.regroup + 1));
      this.pushTick = Math.min(this.pushTick, v.tick);
      if (obs.globals[G.control_progress_own] <= obs.globals[G.control_progress_enemy]) { this.target = "control"; this.ctrlBest = -1; this.ctrlAt = v.tick; }
    }
    if (!this.pushing && size >= this.pushSize && v.tick >= this.pushTick) {
      this.pushing = true; this.viaDone = false; this.ctrlAt = v.tick; this.viaStep = 0; this.viaAt = v.tick;
    }
    // A control push that makes no progress for CONTROL_PATIENCE ticks turns into a base attack
    // (holding more than half the contested nodes needs several separately ordered groups).
    if (this.pushing && this.target === "control") {
      const p = obs.globals[G.control_progress_own];
      if (p > this.ctrlBest) { this.ctrlBest = p; this.ctrlAt = v.tick; }
      else if (v.tick - this.ctrlAt > CONTROL_PATIENCE) this.target = "enemy_base";
    }
    if (this.pushing && size < this.t.push.regroup) this.endPush();

    let order = O_AM, target: number;
    if (v.threat) {
      target = T_OWN_BASE;
    } else if (this.pushing) {
      const hp = v.army.reduce((s, e) => s + e[F.hp], 0) / v.army.length;
      if (this.t.retreat > 0 && hp < this.t.retreat && m.order[this.main][O_RETREAT]) {
        this.endPush();
        return this.issue(m, O_RETREAT, TARGET_NONE, true);
      }
      target = this.pushTarget(obs, v);
      if (this.t.cohere && v.army.length >= 4) {
        const ahead = this.lead(v);
        if (this.gather < 0 && ahead > COHERE_FAR) this.gather = this.cellOf(this.middle(v));
        else if (this.gather >= 0 && ahead < COHERE_NEAR) this.gather = -1;
        if (this.gather >= 0 && m.target[O_AM][TARGET_GRID0 + this.gather]) target = TARGET_GRID0 + this.gather;
      }
      // Escort: hold at the forward point until the outposts stand (or patience, the barracks or the workers run out).
      if (this.t.post?.mode === "escort" && !this.postDone) {
        if (this.postHold < 0) this.postHold = v.tick;
        const done = Math.round(obs.globals[G.own_outpost_done] * 5) >= this.t.post.n;
        const lost = obs.globals[G.own_barracks_done] === 0 || (this.postSent >= POST_WORKERS && !this.forwardWorker(obs));
        if (done || lost || v.tick - this.postHold > ESCORT_PATIENCE) this.postDone = true;
        else { order = O_GUARD; target = this.forwardPoint(); }
      }
      if (this.t.push.via === "brush" && !this.viaDone) {
        const via = this.brushVia();
        const c = this.centroid(v.army);
        if (via < 0 || this.dist(c, this.norm(this.ctx.targets[via])) < 250) this.viaDone = true;
        else { order = O_MOVE; target = via; }
      } else if ((this.t.push.via === "edge" || this.t.push.via === "swing") && !this.viaDone) {
        // Walk the route (attack-moving, so it fights what it meets); a waypoint it can't reach is given up after VIA_PATIENCE.
        const route = this.flankRoute(this.t.push.via);
        const c = this.centroid(v.army);
        while (this.viaStep < route.length && (this.dist(c, route[this.viaStep]) < VIA_NEAR || v.tick - this.viaAt > VIA_PATIENCE)) { this.viaStep++; this.viaAt = v.tick; }
        const cell = this.viaStep < route.length ? this.cellNear(m, route[this.viaStep]) : -1;
        if (cell < 0) this.viaDone = true;
        else { order = O_AM; target = cell; }
      }
    } else {
      // Waiting: guard the staging point (v3) instead of attack-moving to it.
      order = O_GUARD;
      target = this.stageTarget(obs, v);
    }
    return this.issue(m, order, target, false);
  }

  /** Issue an order if it changed or is due a refresh; otherwise no army action. */
  private issue(m: V2Masks, order: number, target: number, force: boolean) {
    const key = `${order}:${target}`;
    if (!force && key === this.lastOrder && this.decisions - this.lastOrderAt < ORDER_REFRESH) return { group: 0, order: 0, target: TARGET_NONE };
    if (!force && this.decisions < this.focusUntil) return { group: 0, order: 0, target: TARGET_NONE };
    if (!m.order[this.main][order] || !m.target[order][target]) return { group: 0, order: 0, target: TARGET_NONE };
    this.lastOrder = key; this.lastOrderAt = this.decisions;
    return { group: this.main, order, target };
  }

  /** The group the template's own army orders go to: everything, or the gunners when skirmishers fight on their own (backdoor). */
  private get main(): number { return this.t.post?.mode === "backdoor" ? GROUP_GUNNERS : GROUP_ALL; }

  private endPush(): void { this.pushing = false; this.postHold = -1; this.postDone = false; this.gather = -1; }

  /** `cohere`: how far the leading quarter of the army is ahead of its middle unit, towards the enemy base (px). */
  private lead(v: View): number {
    const goal = this.norm(this.ctx.targets[T_ENEMY_BASE]);
    const d = v.army.map((e) => this.dist({ x: e[F.x], y: e[F.y] }, goal)).sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)] - d[Math.floor(d.length / 4)];
  }

  /** The worker sent forward (the forward builder), if it is alive. */
  private forwardWorker(obs: ObsV2): { e: number[]; i: number } | null {
    const i = obs.entities.findIndex((e) => e[F.own] && e[F.type_worker] && e[F.builder]);
    return i < 0 ? null : { e: obs.entities[i], i };
  }

  /** Where an escorted push holds: the enemy choke, else the centre, else the enemy base. */
  private forwardPoint(): number {
    return [T_ENEMY_CHOKE0, T_CENTRE0].find((t) => this.valid(t)) ?? T_ENEMY_BASE;
  }

  // ---- hiding (backdoor) ----

  /** Centre of a grid cell (own frame, normalised), and the grid cell of a point. */
  private cellAt(g: number): Pt {
    return { x: ((g % GRID_COLS) * GRID_CELL_W + GRID_CELL_W / 2) / this.ctx.W, y: (Math.floor(g / GRID_COLS) * GRID_CELL_H + GRID_CELL_H / 2) / this.ctx.H };
  }
  private cellOf(p: Pt): number {
    const c = Math.min(GRID_COLS - 1, Math.max(0, Math.floor(p.x * this.ctx.W / GRID_CELL_W)));
    const r = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor(p.y * this.ctx.H / GRID_CELL_H)));
    return r * GRID_COLS + c;
  }

  /**
   * What the enemy can see, per grid cell, as far as the bot can tell: 2 where a watcher it knows of looks (the enemy crystal,
   * the workers at the enemy's own nodes and at nodes it holds, enemy buildings it remembers, enemy units in its sight now),
   * 1 where the enemy is likely to be looking (its pockets and chokes, the centre of the map), 0 elsewhere. Once per decision.
   */
  private watched(obs: ObsV2): Uint8Array {
    if (this.watchAt === this.decisions) return this.watch;
    const w = this.watch.fill(0), px = (x: number, y: number): Pt => ({ x: x * this.ctx.W, y: y * this.ctx.H });
    const mark = (p: Pt, kind: string, level: number) => { for (const g of this.ctx.sight(p, kind)) if (w[g] < level) w[g] = level; };
    const anchors = (t0: number, kind: string, level: number) => { for (let i = 0; i < 4 && (t0 === T_ENEMY_SAFE0 || i < 3); i++) if (this.valid(t0 + i)) mark(this.ctx.targets[t0 + i], kind, level); };
    mark(this.ctx.targets[T_ENEMY_BASE], "crystal", 2);
    anchors(T_ENEMY_SAFE0, "worker", 2);
    for (let k = 1; k < obs.memory.length; k++) {
      const r = obs.memory[k];
      const type = r[M.valid] && !r[M.destroyed] ? MEMORY_TYPES.find((t) => r[M[`type_${t}`]]) : undefined;
      if (type) mark(px(r[M.x], r[M.y]), type, 2);
    }
    for (const e of obs.entities) {
      const type = e[F.enemy] ? ENTITY_TYPES.find((t) => e[F[`type_${t}`]]) : undefined;
      if (type) mark(px(e[F.x], e[F.y]), type, 2);
    }
    // Nodes the enemy holds or was seen working have its workers at them.
    for (const n of obs.nodes) if (n[N.valid] && (n[N.held_enemy] || n[N.enemy_workers])) mark(px(n[N.x], n[N.y]), "worker", 2);
    anchors(T_ENEMY_POCKET0, "barracks", 1);
    anchors(T_ENEMY_CHOKE0, "gunner", 1);
    anchors(T_CENTRE0, "gunner", 1);
    this.watchAt = this.decisions;
    return w;
  }
  private watch = new Uint8Array(GRID_CELLS);
  private watchAt = -1;
  /** The cell the backdoor worker was last sent to and where it stood then; cells it could not walk to. */
  private walkTo = -1;
  private walkFrom: Pt = { x: 0, y: 0 };
  private noGo = new Set<number>();

  /** Cheapest walk over the grid from cell `from` to every cell, watched ground being dear: the cost per cell and the cell each is reached from. */
  private routes(m: V2Masks, w: Uint8Array, from: number): { cost: Float64Array; prev: Int32Array } {
    const cost = new Float64Array(GRID_CELLS).fill(Infinity), prev = new Int32Array(GRID_CELLS).fill(-1), done = new Uint8Array(GRID_CELLS);
    const weight = [1, LIKELY_COST, SEEN_COST];
    cost[from] = 0;
    for (;;) {
      let g = -1;
      for (let i = 0; i < GRID_CELLS; i++) if (!done[i] && cost[i] < Infinity && (g < 0 || cost[i] < cost[g])) g = i;
      if (g < 0) break;
      done[g] = 1;
      const c = g % GRID_COLS, r = (g - c) / GRID_COLS;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc, nr = r + dr, n = nr * GRID_COLS + nc;
          if ((!dr && !dc) || nc < 0 || nr < 0 || nc >= GRID_COLS || nr >= GRID_ROWS || done[n] || !m.target[O_MOVE][TARGET_GRID0 + n] || this.noGo.has(n)) continue;
          const d = cost[g] + Math.hypot(dc * GRID_CELL_W, dr * GRID_CELL_H) * weight[w[n]];
          if (d < cost[n]) { cost[n] = d; prev[n] = g; }
        }
      }
    }
    return { cost, prev };
  }

  /**
   * Backdoor: choose the cell the outposts go at. The reachable open ground nearest the enemy crystal that the enemy is not
   * known to see, on the bot's side of the map when there is a choice. A spot still unseen is kept; one that an enemy watcher
   * now sees is given up while no outpost stands there.
   */
  private pickSpot(v: View, m: V2Masks, w: Uint8Array, cost: Float64Array): void {
    if (this.spot >= 0 && (v.buildings.outpost > 0 || (w[this.spot] < 2 && cost[this.spot] < Infinity))) return;
    const base = this.norm(this.ctx.targets[T_ENEMY_BASE]), side = this.edge ? 1 : 0;
    let best = -1, bs = Infinity;
    for (let g = 0; g < GRID_CELLS; g++) {
      if (cost[g] === Infinity || this.ctx.brushCell[g]) continue;
      const at = this.cellAt(g), d = this.dist(at, base);
      if (d < BACKDOOR_MIN || d > BACKDOOR_MAX) continue;
      // Watched neighbours leave less room for three outposts and their skirmishers.
      let near = 0;
      const c = g % GRID_COLS, r = (g - c) / GRID_COLS;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nc = c + dc, nr = r + dr;
        if (nc >= 0 && nr >= 0 && nc < GRID_COLS && nr < GRID_ROWS && w[nr * GRID_COLS + nc] === 2) near++;
      }
      const score = Math.round(d + [0, 400, 3000][w[g]] + 60 * near + 0.3 * Math.abs(at.y - side) * this.ctx.H);
      if (score < bs) { bs = score; best = g; }
    }
    if (best < 0) {
      // Nowhere in range: beside the crystal on the bot's side, as near as a walkable cell allows.
      const dy = BACKDOOR_OFFSET / this.ctx.H;
      const t = this.cellNear(m, { x: base.x, y: Math.min(0.95, Math.max(0.05, base.y + (this.edge ? dy : -dy))) });
      best = t < 0 ? -1 : t - TARGET_GRID0;
    }
    this.spot = best;
  }

  /** No point of the straight walk from `a` to `b` is on ground more watched than `level`. */
  private clearWalk(w: Uint8Array, a: Pt, b: Pt, level: number): boolean {
    const n = Math.max(1, Math.ceil(this.dist(a, b) / 25));
    for (let i = 1; i <= n; i++) {
      if (w[this.cellOf({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n })] > level) return false;
    }
    return true;
  }

  /** The next cell to walk to on the route to `to`: the farthest one the unit at `at` reaches in a straight line without crossing ground more watched than the route itself. */
  private routeStep(w: Uint8Array, prev: Int32Array, at: Pt, to: number): number {
    const path: number[] = [];
    for (let g = to; g >= 0 && prev[g] >= 0; g = prev[g]) path.push(g);
    path.reverse();
    if (!path.length) return to;
    let best = path[0], worst = 0;
    for (const g of path) {
      worst = Math.max(worst, w[g]);
      if (!this.clearWalk(w, at, this.cellAt(g), worst)) break;
      best = g;
    }
    return best;
  }

  /** Backdoor: where the skirmishers wait. Brush near the outposts if there is some (they cannot be seen in it), else the outposts' own cell. */
  private gatherCell(m: V2Masks): number {
    if (this.spot < 0) return -1;
    const at = this.cellAt(this.spot);
    let best = this.spot, bd = Infinity;
    for (let g = 0; g < GRID_CELLS; g++) {
      if (!this.ctx.brushCell[g] || !m.target[O_GUARD][TARGET_GRID0 + g]) continue;
      const d = Math.round(this.dist(at, this.cellAt(g)));
      if (d <= BACKDOOR_BRUSH && d < bd) { bd = d; best = g; }
    }
    return TARGET_GRID0 + best;
  }

  /** Backdoor: the worker's next walking order. It goes to the hidden spot by the least watched way, and looks again on every order. */
  private backdoorWalk(obs: ObsV2, v: View, m: V2Masks): Partial<V2Action> | null {
    if (obs.globals[G.own_barracks_done] === 0 || v.tick < (this.t.post?.tick ?? 0)) return null;
    let w = this.forwardWorker(obs);
    if (!w) {
      // Send a new worker: the foremost one that is not building.
      if (this.postSent >= POST_WORKERS) return null;
      const free = obs.entities.map((e, i) => ({ e, i })).filter(({ e, i }) => e[F.own] && e[F.type_worker] && !e[F.building] && m.unit[O_MOVE][i]);
      w = free.reduce<{ e: number[]; i: number } | null>((b, x) => (!b || x.e[F.x] > b.e[F.x] ? x : b), null);
      if (!w) return null;
      this.postSent++;
    } else if (w.e[F.building] || !m.unit[O_MOVE][w.i]) {
      return null;
    }
    const at = { x: w.e[F.x], y: w.e[F.y] }, watch = this.watched(obs);
    // A cell the worker was sent to and did not move toward cannot be walked to from here: leave it out of the routes.
    if (this.walkTo >= 0 && this.dist(at, this.walkFrom) < 5) this.noGo.add(this.walkTo);
    const { cost, prev } = this.routes(m, watch, this.cellOf(at));
    this.pickSpot(v, m, watch, cost);
    if (this.spot < 0 || this.dist(at, this.cellAt(this.spot)) <= POST_NEAR / 2) { this.walkTo = -1; return null; }
    const step = this.routeStep(watch, prev, at, this.spot), target = TARGET_GRID0 + step;
    if (!m.target[O_MOVE][target]) return null;
    this.walkTo = step; this.walkFrom = at;
    this.lastPostOrder = this.decisions;
    return { group: GROUP_UNIT, order: O_MOVE, unit: w.i, target };
  }

  // ---- forward outposts ----

  /** Escort: where the forward worker should be now, or null if none is wanted. */
  private postGoal(obs: ObsV2, v: View): Pt | null {
    if (obs.globals[G.own_barracks_done] === 0) return null;
    return this.postHold >= 0 && !this.postDone && v.army.length ? this.middle(v) : null;
  }

  /** The legal move target (grid cell) nearest `p`; −1 if none. */
  private cellNear(m: V2Masks, p: Pt): number {
    let best = -1, bd = Infinity;
    for (let g = 0; g < GRID_CELLS; g++) {
      if (!m.target[O_MOVE][TARGET_GRID0 + g]) continue;
      const c = { x: ((g % GRID_COLS) * GRID_CELL_W + GRID_CELL_W / 2) / this.ctx.W, y: (Math.floor(g / GRID_COLS) * GRID_CELL_H + GRID_CELL_H / 2) / this.ctx.H };
      const d = Math.round(this.dist(c, p));
      if (d < bd) { bd = d; best = g; }
    }
    return best < 0 ? -1 : TARGET_GRID0 + best;
  }

  /** Orders of a forward-outpost bot on decisions without a main army order: the worker's walk, and the backdoor skirmishers' attack. */
  private postOrder(obs: ObsV2, v: View, m: V2Masks): Partial<V2Action> | null {
    const p = this.t.post;
    if (!p) return null;
    if (p.mode === "backdoor" && m.group[GROUP_SKIRMISHERS]) {
      // The skirmishers gather at their outposts and attack the crystal as one body.
      const n = obs.entities.filter((e) => e[F.own] && e[F.type_skirmisher]).length;
      const was = this.striking;
      if (n >= BACKDOOR_MASS) this.striking = true; else if (n < BACKDOOR_REGROUP) this.striking = false;
      const order = this.striking ? O_AM : O_GUARD, target = this.striking ? T_ENEMY_BASE : this.gatherCell(m);
      if (was !== this.striking || this.decisions - this.lastSkirmOrder >= ORDER_REFRESH) {
        // The strike goes for the crystal itself when it is in sight (nothing on the way distracts it).
        const crystal = this.striking && m.order[GROUP_SKIRMISHERS][O_FOCUS] ? obs.entities.findIndex((e, i) => e[F.enemy] && e[F.type_crystal] && m.ptr[O_FOCUS][i]) : -1;
        if (crystal >= 0) { this.lastSkirmOrder = this.decisions; return { group: GROUP_SKIRMISHERS, order: O_FOCUS, ptr: crystal }; }
        if (target >= 0 && m.order[GROUP_SKIRMISHERS][order] && m.target[order][target]) {
          this.lastSkirmOrder = this.decisions;
          return { group: GROUP_SKIRMISHERS, order, target };
        }
      }
    }
    if (!m.group[GROUP_UNIT] || this.decisions - this.lastPostOrder < POST_WORKER_GAP) return null;
    if (p.mode === "backdoor") return this.backdoorWalk(obs, v, m);
    const goal = this.postGoal(obs, v);
    if (!goal) return null;
    const at = (e: number[]): Pt => ({ x: e[F.x], y: e[F.y] });
    let w = this.forwardWorker(obs);
    if (!w) {
      // Send a new worker: the one nearest the goal that is not building.
      if (this.postSent >= POST_WORKERS) return null;
      const free = obs.entities.map((e, i) => ({ e, i })).filter(({ e, i }) => e[F.own] && e[F.type_worker] && !e[F.building] && m.unit[O_MOVE][i]);
      w = free.reduce<{ e: number[]; i: number } | null>((b, x) => (!b || this.dist(at(x.e), goal!) < this.dist(at(b.e), goal!) ? x : b), null);
      if (!w) return null;
      this.postSent++;
    } else if (w.e[F.building] || !m.unit[O_MOVE][w.i]) {
      return null;
    } else if (this.dist(at(w.e), goal) <= POST_NEAR / 2) {
      return null; // with the army: it waits here
    }
    const target = this.cellNear(m, goal);
    if (target < 0) return null;
    this.lastPostOrder = this.decisions;
    return { group: GROUP_UNIT, order: O_MOVE, unit: w.i, target };
  }

  /** Build the next forward outpost beside its worker once it is in place; sets `postSaving` when only the price is missing. */
  private postBuild(obs: ObsV2, v: View, m: V2Masks): number {
    const p = this.t.post;
    this.postSaving = false;
    if (!p || v.buildings.outpost >= p.n || obs.globals[G.own_barracks_done] === 0) return 0;
    // One at a time: the worker builds the next when it is free again.
    const w = this.forwardWorker(obs);
    if (!w || w.e[F.building]) return 0;
    const at = { x: w.e[F.x], y: w.e[F.y] };
    if (p.mode === "escort") {
      if (this.postHold < 0 || this.postDone || !v.army.length) return 0;
      // Wherever the army has got to on the enemy half (it may be stopped short of its forward point).
      const mid = this.middle(v);
      if (mid.x < 0.5 || this.dist(at, mid) > POST_NEAR) return 0;
    } else if (this.spot < 0 || this.dist(at, this.cellAt(this.spot)) > POST_NEAR / 2) {
      return 0;
    }
    // The backdoor keeps its outposts on ground the enemy does not watch, if there is any near the worker.
    const watch = p.mode === "backdoor" ? this.watched(obs) : null;
    const a = this.buildNear(m, "outpost", at, watch ? (g) => [0, 100, 400][watch[g]] : undefined);
    if (!a && v.resources < BUILDING_DEFS.outpost.cost) this.postSaving = true;
    // The worker gets no walking order in the decision that sends it to build (the order would replace the build).
    if (a) this.lastPostOrder = this.decisions;
    return a;
  }

  /** A finished own outpost would take the next skirmisher: its queue has room and is no longer than any barracks queue. */
  private outpostFree(obs: ObsV2): boolean {
    let post = Infinity, barracks = Infinity;
    for (const e of obs.entities) {
      if (!e[F.own] || e[F.built] < 1) continue;
      if (e[F.type_outpost]) post = Math.min(post, e[F.queue]);
      else if (e[F.type_barracks]) barracks = Math.min(barracks, e[F.queue]);
    }
    return post < 1 && post <= barracks;
  }

  // ---- micro (v3), used on decisions without a main army order ----

  /** Give a free bulwark a unit to cover, pull back a badly hurt unit, focus a weak enemy near the army, or send medics to a hurt ally; null if none applies. */
  private micro(obs: ObsV2, v: View, m: V2Masks): Partial<V2Action> | null {
    if (!v.army.length) return null;
    const c = this.centroid(v.army);
    const at = (e: number[]): Pt => ({ x: e[F.x], y: e[F.y] });
    const isCombat = (e: number[]) => COMBAT.some((u) => e[F[`type_${u}`]]);
    // Enemy bulwarks are not worth a focus order: armed units first.
    const enemies = obs.entities.map((e, i) => ({ e, i })).filter(({ e }) => !e[F.own] && isCombat(e) && !e[F.type_bulwark]);
    const due = (k: "pull" | "focus" | "heal" | "shield") => this.decisions - this.lastMicro[k] >= MICRO_GAP;
    const lowest = (xs: Array<{ e: number[]; i: number }>) => xs.reduce<{ e: number[]; i: number } | null>((b, x) => (!b || x.e[F.hp] < b.e[F.hp] ? x : b), null);

    // 0. A bulwark that covers nothing takes the nearest gunner without cover (else the nearest armed ally);
    //    with no armed ally left and enemies near, it goes home (it cannot fight).
    if (due("shield") && m.group[GROUP_UNIT]) {
      const own = obs.entities.map((e, i) => ({ e, i })).filter(({ e }) => e[F.own]);
      const free = own.find(({ e, i }) => e[F.type_bulwark] && !e[F.covering] && (m.unit[O_COVER][i] || m.unit[O_RETREAT][i]));
      if (free) {
        const armed = own.filter(({ e, i }) => isCombat(e) && !e[F.type_bulwark] && !e[F.type_medic] && m.ptr[O_COVER][i]);
        const rank = (x: { e: number[] }) => (x.e[F.covered] ? 2 : 0) + (x.e[F.type_gunner] ? 0 : 1);
        const pick = armed.reduce<{ e: number[]; i: number } | null>((b, x) =>
          (!b || rank(x) < rank(b) || (rank(x) === rank(b) && this.dist(at(x.e), at(free.e)) < this.dist(at(b.e), at(free.e))) ? x : b), null);
        if (pick && m.unit[O_COVER][free.i]) { this.lastMicro.shield = this.decisions; return { group: GROUP_UNIT, order: O_COVER, unit: free.i, ptr: pick.i }; }
        if (!pick && m.unit[O_RETREAT][free.i] && enemies.some((x) => this.dist(at(x.e), at(free.e)) < MICRO_RADIUS)) {
          this.lastMicro.shield = this.decisions;
          return { group: GROUP_UNIT, order: O_RETREAT, unit: free.i };
        }
      }
    }
    // 1. Templates that retreat also pull single badly hurt units out of a fight.
    if (this.t.retreat > 0 && due("pull") && m.group[GROUP_UNIT] && m.order[GROUP_UNIT][O_RETREAT]) {
      const hurt = obs.entities.map((e, i) => ({ e, i })).filter(({ e, i }) =>
        e[F.own] && isCombat(e) && !e[F.type_medic] && e[F.hp] < PULL_HP && m.unit[O_RETREAT][i] &&
        enemies.some((x) => this.dist(at(x.e), at(e)) < MICRO_RADIUS));
      const u = lowest(hurt);
      if (u) { this.lastMicro.pull = this.decisions; return { group: GROUP_UNIT, order: O_RETREAT, unit: u.i }; }
    }
    // 2. Focus the weakest enemy combat unit near the army.
    if (v.army.length >= 2 && due("focus") && m.order[this.main][O_FOCUS]) {
      const t = lowest(enemies.filter(({ e, i }) => e[F.hp] < FOCUS_HP && m.ptr[O_FOCUS][i] && this.dist(at(e), c) < MICRO_RADIUS));
      if (t) {
        this.lastMicro.focus = this.decisions;
        this.focusUntil = this.decisions + FOCUS_DECISIONS;
        this.lastOrder = ""; // the main order goes out again when the focus ends
        return { group: this.main, order: O_FOCUS, ptr: t.i };
      }
    }
    // 3. Medics follow the most hurt ally near the army (they auto-heal in range anyway).
    if (due("heal") && m.group[GROUP_MEDICS] && m.order[GROUP_MEDICS][O_HEAL]) {
      const t = lowest(obs.entities.map((e, i) => ({ e, i })).filter(({ e, i }) =>
        e[F.hp] < HEAL_HP && m.ptr[O_HEAL][i] && this.dist(at(e), c) < MICRO_RADIUS));
      if (t) { this.lastMicro.heal = this.decisions; return { group: GROUP_MEDICS, order: O_HEAL, ptr: t.i }; }
    }
    return null;
  }

  /** Army units within MASS_RADIUS of the army's middle unit (by distance to the enemy base): the main body. */
  private massed(v: View): number {
    const mid = this.middle(v);
    return v.army.filter((e) => this.dist({ x: e[F.x], y: e[F.y] }, mid) < MASS_RADIUS).length;
  }

  /** Position of the army's middle unit, ranked by distance to the enemy base (own frame, normalised). */
  private middle(v: View): Pt {
    const goal = this.norm(this.ctx.targets[T_ENEMY_BASE]);
    const at = (e: number[]): Pt => ({ x: e[F.x], y: e[F.y] });
    const byProgress = v.army.map((e) => ({ e, d: Math.round(this.dist(at(e), goal)) })).sort((a, b) => a.d - b.d);
    return at(byProgress[Math.floor(byProgress.length / 2)].e);
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

  /** Waypoints (own frame, normalised) of an edge or swing route on the side drawn for this game. */
  private flankRoute(via: "edge" | "swing"): Pt[] {
    const y = this.edge ? 1 - FLANK_EDGE_Y : FLANK_EDGE_Y;
    return via === "edge" ? [{ x: 0.3, y }, { x: 0.78, y }] : [{ x: 0.45, y: 0.5 }, { x: 0.72, y }];
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
