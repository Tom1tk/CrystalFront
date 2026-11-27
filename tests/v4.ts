// Layout v4 tests (docs/REBUILD_R1_PLAN.md). Run by `npm test` after tests/index.ts.
//   npx tsx tests/v4.ts
import { VecRunnerV2 as Runner3 } from "../headless/src/v3/runner.js";
import { VecRunnerV2 as Runner4, packCritic, toWire } from "../headless/src/v4/runner.js";
import { makeV2Bot } from "../headless/src/v4/bots.js";
import { MatchEngine } from "../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type MatchEntity, type MatchState, type PlayerSlot } from "../server/src/match/types.js";
import { computeVisibility } from "../server/src/match/engine/visibility.js";
import { getDamage, getRange } from "../server/src/match/engine/utils.js";
import { UNIT_DEFS } from "@crystalfront/shared";
import * as A3 from "../headless/src/v3/actions.js";
import * as O3 from "../headless/src/v3/observation.js";
import * as A4 from "../headless/src/v4/actions.js";
import * as O4 from "../headless/src/v4/observation.js";
import { fromOwnFrame, toOwnFrame } from "../headless/src/v4/frame.js";
import { botContext } from "../headless/src/v4/scripted.js";
import { defenceLabel } from "../headless/src/v4/defence.js";
import { hashMatchState } from "../server/src/match/engine/hash.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function check(ok: boolean, name: string, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }
}

type R = Record<string, any>;

/** Play one slot to the end in a runner; returns the replay's command log, outcome and the per-decision teacher labels. */
function play(Runner: typeof Runner3 | typeof Runner4, slot: R, cap: number, extra: R = {}): { log: string; outcome: string; labels: string; memory: string } {
  let replay: R | null = null;
  const none = Runner === Runner3 ? A3.TARGET_NONE : A4.TARGET_NONE;
  const r = new Runner({ onReplay: (_i, rp) => { replay ??= rp as R; } });
  const labels: unknown[] = [], memory: unknown[] = [];
  // Teacher labels in v3 target numbering (v4 adds 8 memory slots before the grid: 53..60 have no v3 index).
  const t3 = (t: number) => (Runner === Runner3 || t < 53 ? t : t >= 61 ? t - 8 : -1);
  const v3Labels = (w: R | null | undefined) => w && {
    econ: [w.econ[0], w.econ[1], w.econ[2], t3(w.econ[3])], army: [...w.army.slice(0, 3), t3(w.army[3]), w.army[4]],
    ...(w.scout ? { scout: [w.scout[0], t3(w.scout[1]), w.scout[2]] } : {}),
  };
  let res: R = r.handle({ type: "reset_all", max_ticks: cap, critic: false, slots: [slot], ...extra });
  if (res.type === "error") throw new Error(res.message);
  let seats: R = res.slots[0].seats;
  for (let d = 0; d < cap && !replay; d++) {
    const act: R = {};
    for (const [side, s] of Object.entries(seats)) {
      labels.push([side, v3Labels(s.teacher), s.scoutTeacher ? [s.scoutTeacher[0], t3(s.scoutTeacher[1]), s.scoutTeacher[2]] : null]);
      if (s.teacher === null) act[side] = { econ: [0, 0, 0, 0], army: [0, 0, 0, none, 0] };
    }
    res = r.handle({ type: "step", actions: [act] });
    if (res.type === "error") throw new Error(res.message);
    seats = res.slots[0].seats;
    // The v3 memory slots (0..15) must match v3's exactly.
    memory.push(((r as any).slots[0].oss as { mem: unknown[] }[]).map((o) => o.mem.slice(0, 16)));
  }
  if (!replay) throw new Error("episode did not end");
  const rp = replay as R;
  return { log: JSON.stringify(rp.commandLog), outcome: JSON.stringify(rp.outcome), labels: JSON.stringify(labels), memory: JSON.stringify(memory) };
}

function equivalenceTests(): void {
  console.log("\nv4 scripted equivalence (same games as v3)");
  const cases: [R, number, R?][] = [
    [{ seed: 11, map: "shardfall", blue: "teach:backdoor", red: "teach:flank" }, 4000],
    [{ seed: 12, map: "ironreed", blue: "teach:hidden", red: "teach:swing" }, 4000],
    [{ seed: 13, map: "glimmerfen", blue: "bot:rush_post", red: "teach:macro" }, 8000],
    // A policy seat (no-op actions) with the scout teacher shadowing it, against a scripted bot.
    [{ seed: 14, map: "basalt-run", blue: "policy", red: "teach:backdoor" }, 4000, { scout_slot: true, scout_teacher: true }],
  ];
  for (const [slot, cap, extra] of cases) {
    const a = play(Runner3, slot, cap, extra), b = play(Runner4, slot, cap, extra);
    const name = `${slot.blue} v ${slot.red} on ${slot.map} (${cap} ticks)`;
    check(a.log === b.log && a.log.length > 1000, `${name}: same command log`, `${a.log.length} vs ${b.log.length} chars`);
    check(a.outcome === b.outcome, `${name}: same outcome`, `${a.outcome} vs ${b.outcome}`);
    check(a.labels === b.labels, `${name}: same teacher labels (v3 target numbering)`);
    check(a.memory === b.memory, `${name}: same memory slots 0..15`);
  }
}


// ---- S2: schema 8 features ----

const IDS = ["v2-blue", "v2-red"] as const;
const near = (a: number, b: number, tol = 2e-3) => Math.abs(a - b) <= tol;

function fresh(map: string, seed = 5): MatchState {
  const engine = new MatchEngine();
  const players: [PlayerSlot, PlayerSlot] = [
    { playerId: IDS[0], username: "a", color: "blue", score: 0 },
    { playerId: IDS[1], username: "b", color: "red", score: 0 },
  ];
  const match = engine.createMatch(`s2-${map}`, players, { ...DEFAULT_CONFIG, ruleset: "beta", mapId: map }, seed);
  engine.startMatch(match.id);
  return match;
}

let nextId = 0;
/** A unit of `type` for `owner` at world (x, y), cloned from one of the match's workers. */
function spawn(match: MatchState, owner: string, type: keyof typeof UNIT_DEFS, x: number, y: number): MatchEntity {
  const w = [...match.entities.values()].find((e) => e.type === "worker")!;
  const def = UNIT_DEFS[type] as { radius: number; maxHealth?: number; hp?: number };
  const e = { ...structuredClone(w), id: `s2-${type}-${nextId++}`, type, ownerId: owner, x, y, radius: def.radius } as MatchEntity;
  match.entities.set(e.id, e);
  return e;
}

function crystalOwn(match: MatchState, s: A4.SeatState, owner: string) {
  const c = [...match.entities.values()].find((e) => e.type === "crystal" && e.ownerId === owner)!;
  return toOwnFrame(s.frame, c);
}

const F = (n: string) => O4.ENTITY_FEATURES.indexOf(n);
const G = (n: string) => O4.GLOBAL_NAMES.indexOf(n);
const N_OLD_G = 68, N_OLD_F = 37, PLANE = A4.GRID_CELLS;

/** The obs row of the entity at own-frame (x, y). */
function rowAt(obs: O4.ObsV2, match: MatchState, x: number, y: number): number[] | undefined {
  const W = match.config.mapWidth, H = match.config.mapHeight;
  return obs.entities.find((r) => near(r[F("x")], x / W, 2e-4) && near(r[F("y")], y / H, 2e-4));
}

function schemaTests(): void {
  console.log("\nv4 schema 8 features");
  check(O4.GLOBAL_NAMES.length === 78 && O4.ENTITY_F === 48 && O4.DYN_CHANNELS.length === 7, "sizes: 78 globals, 48 entity features, 7 grid channels",
    `${O4.GLOBAL_NAMES.length} / ${O4.ENTITY_F} / ${O4.DYN_CHANNELS.length}`);

  // Appended only: the v3 part of every block is unchanged, on a busy hand-built state.
  for (const map of ["shardfall", "ironreed"]) {
    const m = fresh(map);
    const s4 = A4.createSeatState(m, IDS[0]), s3 = A3.createSeatState(m, IDS[0]);
    const c = crystalOwn(m, s4, IDS[0]);
    for (const [k, t] of (["skirmisher", "bruiser", "gunner"] as const).entries()) {
      const p = fromOwnFrame(s4.frame, { x: c.x + 250 + 40 * k, y: c.y + 30 * k });
      spawn(m, IDS[1], t, p.x, p.y);
      const q = fromOwnFrame(s4.frame, { x: c.x + 180 + 40 * k, y: c.y - 20 * k });
      spawn(m, IDS[0], t, q.x, q.y);
    }
    computeVisibility(m);
    const o4 = O4.observe(m, s4, O4.createObsState(m, s4)), o3 = O3.observe(m, s3 as never, O3.createObsState(m, s3 as never));
    check(o4.schemaVersion === 8 && o4.globals.length === 78 && o4.entities.every((r) => r.length === 48) && o4.grid.length === 7 * PLANE,
      `${map}: v4 block sizes`);
    const same = JSON.stringify(o4.globals.slice(0, N_OLD_G)) === JSON.stringify(o3.globals)
      && JSON.stringify(o4.entities.map((r) => r.slice(0, N_OLD_F))) === JSON.stringify(o3.entities)
      && JSON.stringify(o4.grid.slice(0, 5 * PLANE)) === JSON.stringify(o3.grid)
      && JSON.stringify(o4.memory.slice(0, 16).map((r) => r.slice(0, 15))) === JSON.stringify(o3.memory) && JSON.stringify(o4.nodes) === JSON.stringify(o3.nodes);
    check(same, `${map}: v3 features unchanged (schema 8 only appends)`);
  }

  // Exact values: one enemy skirmisher 300 px in front of the crystal, one own skirmisher 25 px from it.
  {
    const m = fresh("shardfall");
    const s = A4.createSeatState(m, IDS[0]), os = O4.createObsState(m, s);
    const c = crystalOwn(m, s, IDS[0]);
    const pf = { x: c.x + 300, y: c.y }, po = { x: c.x + 275, y: c.y };
    const wf = fromOwnFrame(s.frame, pf), wo = fromOwnFrame(s.frame, po);
    const foe = spawn(m, IDS[1], "skirmisher", wf.x, wf.y), mine = spawn(m, IDS[0], "skirmisher", wo.x, wo.y);
    computeVisibility(m);
    const o = O4.observe(m, s, os);
    const rf = rowAt(o, m, pf.x, pf.y), ro = rowAt(o, m, po.x, po.y);
    const dps = (getDamage(foe, m.config) / UNIT_DEFS.skirmisher.attackCooldown) * 10;
    check(!!rf && !!ro, "hand-built: both skirmishers have rows");
    if (rf && ro) {
      check(near(rf[F("range")], getRange(foe, m.terrain) / 400) && near(rf[F("range")], 32 / 400), "range = unit range + radius", `${rf[F("range")]}`);
      check(near(rf[F("speed")], 4 / 8) && near(rf[F("dps")], dps / 40), "speed and dps", `${rf[F("speed")]} ${rf[F("dps")]}`);
      check(near(rf[F("dist_own_crystal")], 300 / 3000), "enemy distance to own crystal", `${rf[F("dist_own_crystal")]}`);
      check(near(ro[F("nearest_foe")], 25 / 1000) && near(rf[F("nearest_foe")], 25 / 1000), "nearest foe distance");
      check(rf[F("in_foe_range")] === 1 && ro[F("in_foe_range")] === 1, "in foe range (25 px ≤ 32 + 12)");
      check(near(rf[F("foes_in_range")], 1 / 5) && near(ro[F("foes_in_range")], 1 / 5), "foes in range");
      check(rf[F("vx")] === 0 && rf[F("vy")] === 0, "no velocity on first sight");
    }
    const g = o.globals;
    check(near(g[G("enemy_combat_near_base")], 0.1) && near(g[G("enemy_units_own_half")], 0.1), "near-base and own-half enemy counts",
      `${g[G("enemy_combat_near_base")]} ${g[G("enemy_units_own_half")]}`);
    check(near(g[G("nearest_enemy_to_base")], 0.1), "nearest enemy to base", `${g[G("nearest_enemy_to_base")]}`);
    check(near(g[G("own_combat_near_base")], 1 / 20) && g[G("own_army_share_home")] === 1 && g[G("own_army_share_enemy_half")] === 0, "own army near base");
    check(g[G("raid_time")] === 0, "raid timer starts at 0");
    const cell = Math.floor(pf.y / A4.GRID_CELL_H) * Math.ceil(m.config.mapWidth / A4.GRID_CELL_W) + Math.floor(pf.x / A4.GRID_CELL_W);
    check(o.grid[5 * PLANE + cell] >= dps / 100 - 2e-3, "enemy threat on the enemy's own cell", `${o.grid[5 * PLANE + cell]}`);
    const far = Math.floor(pf.y / A4.GRID_CELL_H) * Math.ceil(m.config.mapWidth / A4.GRID_CELL_W) + Math.floor((pf.x + 300) / A4.GRID_CELL_W);
    check(o.grid[5 * PLANE + far] === 0, "no threat 300 px away");
    check(o.grid[6 * PLANE + cell] > 0, "own coverage there too");

    // Velocity: the own skirmisher moves 16 px forward in one decision (8 ticks × 4 px): vx = 0.5.
    const step = fromOwnFrame(s.frame, { x: po.x + 16, y: po.y });
    mine.x = step.x; mine.y = step.y;
    m.tick += A4.DECISION_TICKS;
    computeVisibility(m);
    const o2 = O4.observe(m, s, os);
    const r2 = rowAt(o2, m, po.x + 16, po.y);
    check(!!r2 && near(r2[F("vx")], 0.5, 5e-3) && near(r2[F("vy")], 0, 5e-3), "velocity in own frame", r2 ? `${r2[F("vx")]} ${r2[F("vy")]}` : "no row");
    check(near(o2.globals[G("raid_time")], A4.DECISION_TICKS / 600), "raid timer counts", `${o2.globals[G("raid_time")]}`);
  }

  // Frame symmetry: the same own-frame situation for both seats gives the same schema 8 features.
  for (const map of ["shardfall", "ironreed", "glimmerfen"]) {
    const m = fresh(map);
    const seats = [A4.createSeatState(m, IDS[0]), A4.createSeatState(m, IDS[1])];
    for (const k of [0, 1]) {
      const s = seats[k], c = crystalOwn(m, s, IDS[k]);
      const a = fromOwnFrame(s.frame, { x: c.x + 220, y: c.y + 40 }), b = fromOwnFrame(s.frame, { x: c.x + 600, y: c.y - 80 });
      spawn(m, IDS[1 - k], "bruiser", a.x, a.y);
      spawn(m, IDS[k], "gunner", b.x, b.y);
    }
    computeVisibility(m);
    const obs = seats.map((s) => O4.observe(m, s, O4.createObsState(m, s)));
    const newCols = (o: O4.ObsV2) => o.entities.map((r) => r.slice(N_OLD_F).concat(r.slice(0, 15))).map((r) => r.map((v) => Math.round(v * 500))).map((r) => JSON.stringify(r)).sort();
    const ga = obs[0].globals.slice(N_OLD_G), gb = obs[1].globals.slice(N_OLD_G);
    check(ga.every((v, i) => near(v, gb[i])), `${map}: same schema 8 globals for both seats`, `${ga} vs ${gb}`);
    check(JSON.stringify(newCols(obs[0])) === JSON.stringify(newCols(obs[1])), `${map}: same schema 8 entity columns for both seats`);
    const pa = obs[0].grid.slice(5 * PLANE), pb = obs[1].grid.slice(5 * PLANE);
    check(pa.every((v, i) => near(v, pb[i])), `${map}: same threat and coverage planes for both seats`);
  }

  // Near-base buildings (the backdoor case): counted, timed, and kept from memory once out of sight.
  {
    const m = fresh("shardfall");
    const s = A4.createSeatState(m, IDS[0]), os = O4.createObsState(m, s);
    const c = crystalOwn(m, s, IDS[0]);
    const cr = [...m.entities.values()].find((e) => e.type === "crystal" && e.ownerId === IDS[1])!;
    const w = fromOwnFrame(s.frame, { x: c.x + 700, y: c.y + 100 });
    const post = { ...structuredClone(cr), id: "s2-outpost", type: "building", buildingType: "outpost", constructionProgress: 100, radius: 20, x: w.x, y: w.y } as MatchEntity;
    m.entities.set(post.id, post);
    const eye = fromOwnFrame(s.frame, { x: c.x + 650, y: c.y + 100 });
    spawn(m, IDS[0], "skirmisher", eye.x, eye.y);
    computeVisibility(m);
    const g1 = O4.observe(m, s, os).globals;
    m.tick += 600; // a minute later, out of sight
    for (const e of m.entities.values()) if (e.ownerId === IDS[0] && e.type !== "crystal") m.entities.delete(e.id);
    computeVisibility(m);
    const vis = m.visibilityData?.get(IDS[0]);
    const g2 = O4.observe(m, s, os).globals;
    check(near(g1[G("enemy_buildings_near_base")], 0.2) && g1[G("near_base_building_time")] === 0, "near-base outpost counted on sight", `${g1[G("enemy_buildings_near_base")]}`);
    check(!!vis && !vis.entityIds.has(post.id), "the outpost is out of sight after the own units leave");
    check(near(g2[G("enemy_buildings_near_base")], 0.2) && near(g2[G("near_base_building_time")], 1),
      "near-base outpost kept from memory, timer at 1 min", `${g2[G("enemy_buildings_near_base")]} ${g2[G("near_base_building_time")]}`);
  }

  // No fog leak: an enemy unit the seat cannot see changes nothing in its observation.
  {
    const m = fresh("basalt-run");
    const sA = A4.createSeatState(m, IDS[0]), sB = A4.createSeatState(m, IDS[0]);
    const oA = O4.observe(m, sA, O4.createObsState(m, sA));
    const c = crystalOwn(m, sA, IDS[1]); // the enemy crystal, own frame
    const p = fromOwnFrame(sA.frame, { x: c.x - 150, y: c.y });
    const hidden = spawn(m, IDS[1], "bruiser", p.x, p.y);
    computeVisibility(m);
    const vis = m.visibilityData?.get(IDS[0]);
    check(!!vis && !vis.entityIds.has(hidden.id), "hidden unit is in fog");
    const oB = O4.observe(m, sB, O4.createObsState(m, sB));
    check(JSON.stringify(oA) === JSON.stringify(oB), "fogged observation ignores a hidden enemy unit");
    const crit = O4.criticState(m, sB, O4.createObsState(m, sB), A4.createSeatState(m, IDS[1]), O4.createObsState(m, A4.createSeatState(m, IDS[1])));
    check(!!rowAt(crit.self as O4.ObsV2, m, c.x - 150, c.y), "the critic does see it");
  }
}

// ---- S3: memory v2 (army clusters, lone units) and action space 10 ----

function memoryTests(): void {
  console.log("\nv4 memory v2 and action space 10");
  const M = (n: string) => O4.MEMORY_FEATURES.indexOf(n);
  check(A4.MEMORY_SLOTS === 24 && O4.MEMORY_F === 18 && A4.TARGET_MEMORY0 === 37 && A4.TARGET_GRID0 === 61 && A4.TARGET_NONE === 811 && A4.TARGET_SIZE === 812,
    "sizes: 24 slots × 18, memory targets 37..60, grid from 61, none 811");

  // Clusters do not depend on row order.
  {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pts = Array.from({ length: 30 }, (_, i) => ({ id: `u${i}`, x: rnd() * 3000, y: rnd() * 900 }));
    const canon = (cs: { id: string }[][]) => JSON.stringify(cs.map((c) => c.map((u) => u.id).sort()));
    const ref = canon(O4.clusterUnits(pts));
    let stable = true;
    for (let k = 0; k < 20; k++) {
      const sh = [...pts].sort(() => rnd() - 0.5);
      if (canon(O4.clusterUnits(sh)) !== ref) stable = false;
    }
    check(stable, "clusters are stable under row order");
  }

  const m = fresh("shardfall");
  const s = A4.createSeatState(m, IDS[0]), os = O4.createObsState(m, s);
  const W = m.config.mapWidth, H = m.config.mapHeight;
  const at = (x: number, y: number) => fromOwnFrame(s.frame, { x, y });
  // A builder crossing the edge (own half, moving towards the own base), with a spotter; an army of 4 further on.
  const w0 = at(0.4 * W, 0.1 * H);
  const worker = spawn(m, IDS[1], "worker", w0.x, w0.y);
  const eye = at(0.4 * W + 60, 0.1 * H + 40);
  const spotter = spawn(m, IDS[0], "outrider", eye.x, eye.y);
  const army = [0, 1, 2, 3].map((k) => { const p = at(0.3 * W + 30 * k, 0.6 * H); return spawn(m, IDS[1], "skirmisher", p.x, p.y); });
  const eye2 = at(0.3 * W + 40, 0.6 * H + 60);
  const spotter2 = spawn(m, IDS[0], "outrider", eye2.x, eye2.y);
  computeVisibility(m);
  O4.observe(m, s, os);
  const w1 = at(0.4 * W - 30, 0.1 * H);
  worker.x = w1.x; worker.y = w1.y;
  for (const e of army) e.x += s.frame.seat === 0 ? -20 : 20;
  m.tick += 8;
  computeVisibility(m);
  let o = O4.observe(m, s, os);
  const loneSlot = () => o.memory.findIndex((r, k) => k >= 19 && r[M("valid")] === 1 && r[M("lone")] === 1);
  const k = loneSlot();
  check(k >= 19 && near(o.memory[k][M("x")], (0.4 * W - 30) / W, 2e-4), "the builder outside its half takes a lone slot", `slot ${k}`);
  if (k >= 0) check(near(o.memory[k][M("heading_x")], -1) && near(o.memory[k][M("heading_y")], 0), "with its heading", `${o.memory[k][M("heading_x")]} ${o.memory[k][M("heading_y")]}`);
  const c = o.memory.findIndex((r, i) => i >= 16 && i < 19 && r[M("valid")] === 1);
  check(c === 16 && near(o.memory[c][M("count")], 4 / 20) && near(o.memory[c][M("heading_x")], -1) && o.memory[c][M("army")] === 1, "the army of 4 is a cluster with its heading");
  check(o.memory.slice(19).filter((r) => r[M("valid")]).length === 1, "clustered units are not lone units");

  // Targets: every filled slot is a legal point target at its remembered position; empty slots are not.
  {
    const masks = A4.computeMasks(m, s);
    const om = A4.ORDERS.indexOf("move");
    let ok = true;
    for (let j = 0; j < A4.MEMORY_SLOTS; j++) {
      const filled = o.memory[j][M("valid")] === 1 && o.memory[j][M("destroyed")] === 0;
      if (masks.target[om][A4.TARGET_MEMORY0 + j] !== filled) ok = false;
      if (filled) {
        const pt = toOwnFrame(s.frame, s.memory[j]!);
        if (!near(pt.x / W, o.memory[j][M("x")], 2e-4) || !near(pt.y / H, o.memory[j][M("y")], 2e-4)) ok = false;
      }
    }
    check(ok, "memory target ↔ point for every slot (mask only when filled)");
  }

  // Lost from sight: the slot stays, ages, and clears after 120 s.
  m.entities.delete(spotter.id); m.entities.delete(spotter2.id);
  m.tick += 8;
  computeVisibility(m);
  o = O4.observe(m, s, os);
  check(loneSlot() === k && o.memory[k][M("age")] > 0 && near(o.memory[k][M("heading_x")], -1), "lost from sight: kept with heading");
  check(o.memory[16][M("valid")] === 1, "lost army cluster kept");
  m.tick += 1200;
  computeVisibility(m);
  o = O4.observe(m, s, os);
  check(o.memory.slice(16).every((r) => r[M("valid")] === 0), "cleared after 120 s");

  // Seen empty: the last position is in sight and the builder is gone.
  {
    const m2 = fresh("ironreed");
    const s2 = A4.createSeatState(m2, IDS[1]), os2 = O4.createObsState(m2, s2);
    const W2 = m2.config.mapWidth, H2 = m2.config.mapHeight;
    const at2 = (x: number, y: number) => fromOwnFrame(s2.frame, { x, y });
    const p = at2(0.35 * W2, 0.2 * H2), e = at2(0.35 * W2 + 50, 0.2 * H2);
    const wk = spawn(m2, IDS[0], "worker", p.x, p.y);
    const sp = spawn(m2, IDS[1], "skirmisher", e.x, e.y);
    computeVisibility(m2);
    let o2 = O4.observe(m2, s2, os2);
    const filled = o2.memory.slice(19).some((r) => r[M("valid")] === 1);
    m2.entities.delete(wk.id);
    m2.tick += 8;
    computeVisibility(m2);
    o2 = O4.observe(m2, s2, os2);
    check(filled && o2.memory.slice(19).every((r) => r[M("valid")] === 0), "seat 1: cleared once its last position is seen empty");
    void sp;
  }
}

// ---- S4: opponent-model labels (near-base threats) ----

function oppLabelTests(): void {
  console.log("\nv4 opponent-model labels");
  const COMBAT = new Set(["skirmisher", "gunner", "bruiser", "medic", "bulwark"]);
  const BLD = new Set(["barracks", "foundry", "supply_depot", "turret", "outpost"]);
  for (const [attacker, map, seed] of [["backdoor", "shardfall", 21], ["rush_post", "ironreed", 22]] as const) {
    const r = new Runner4({});
    let res: R = r.handle({ type: "reset_all", max_ticks: 7000, critic: false, slots: [{ seed, map, blue: `teach:${attacker}`, red: "teach:macro" }] });
    let ok = true, decisions = 0, maxNearB = 0, maxNearC = 0, maxOut = 0, anchors = 0, why = "";
    for (let d = 0; d < 7000 / 8 && res.type !== "error" && !res.slots?.[0]?.done; d++) {
      const match = (r as any).slots[0].match as MatchState;
      for (const [k, side] of [[0, "blue"], [1, "red"]] as const) {
        const lab = res.slots[0].seats[side]?.oppLabels;
        if (!lab) continue;
        const me = IDS[k];
        const cr = [...match.entities.values()].find((e) => e.type === "crystal" && e.ownerId === me)!;
        const leftSide = cr.x < match.config.mapWidth / 2;
        let nb = 0, nc = 0, wo = 0;
        for (const e of match.entities.values()) {
          if (e.ownerId === me || !e.ownerId || e.ownerId === "neutral") continue;
          const alive = e.health > 0 || (e.type === "building" && e.constructionProgress < 100);
          if (!alive) continue;
          const dist = Math.hypot(e.x - cr.x, e.y - cr.y);
          if (e.type === "building" && BLD.has(e.buildingType!) && dist <= 900) nb++;
          if (COMBAT.has(e.type) && dist <= 900) nc++;
          if (e.type === "worker" && (leftSide ? e.x < match.config.mapWidth / 2 : e.x > match.config.mapWidth / 2)) wo++;
        }
        decisions++;
        if (lab.nearBuildings !== nb || lab.nearCombat !== nc || lab.workersOut !== wo || (nb === 0) !== (lab.nearAnchor === A4.N_ANCHOR_TARGETS)) {
          if (ok) why = `tick ${match.tick} ${side}: ${JSON.stringify([lab.nearBuildings, lab.nearCombat, lab.workersOut, lab.nearAnchor])} vs ${JSON.stringify([nb, nc, wo])}`;
          ok = false;
        }
        maxNearB = Math.max(maxNearB, nb); maxNearC = Math.max(maxNearC, nc); maxOut = Math.max(maxOut, wo);
        if (nb > 0) anchors++;
      }
      res = r.handle({ type: "step", actions: [{}] });
    }
    check(ok && decisions > 500, `${attacker} on ${map}: labels match a hand count (${decisions} seat-decisions)`, why);
    const busy = attacker === "backdoor" ? maxNearB > 0 && maxOut > 0 && anchors > 0 : maxNearC > 0;
    check(busy, `${attacker} on ${map}: the labels are not all zero (${attacker === "backdoor" ? "near-base buildings, workers out" : "combat units near base"})`,
      `max ${maxNearB} buildings, ${maxNearC} combat, ${maxOut} workers`);
  }
}

const unb64 = (s: string) => { const b = Buffer.from(s, "base64"); return Array.from(new Float32Array(b.buffer, b.byteOffset, b.length / 4)); };

function criticTests(): void {
  console.log("\nv4 full critic state (S5)");
  const size = (n: number) => 2 * O4.GLOBAL_NAMES.length + 20 * O4.NODE_F + O4.DYN_CHANNELS.length * PLANE + n * O4.ENTITY_F;
  // Round trip: the packed block is both globals, then own nodes, dynamic grid and entity rows.
  {
    const m = fresh("shardfall");
    const seats = [A4.createSeatState(m, IDS[0]), A4.createSeatState(m, IDS[1])];
    const oss = seats.map((s) => O4.createObsState(m, s));
    spawn(m, IDS[1], "bruiser", 1400, 600);
    computeVisibility(m);
    const c = O4.criticState(m, seats[0], oss[0], seats[1], oss[1]);
    const p = packCritic(c), f = unb64(p.f);
    const want = [...c.self.globals, ...c.enemy.globals, ...c.self.nodes.flat(), ...c.self.grid, ...c.self.entities.flat()];
    check(p.n === c.self.entities.length && f.length === size(p.n), "packed critic has the expected size", `${f.length} vs ${size(p.n)}`);
    check(f.every((v, i) => Math.fround(want[i]) === v), "packed critic round-trips");
    const obs = O4.observe(m, seats[0], O4.createObsState(m, seats[0]));
    check(c.self.entities.length > obs.entities.length, "critic sees more entities than the fogged observation", `${c.self.entities.length} vs ${obs.entities.length}`);
  }
  // Runner: packed critic on the wire with the documented size.
  {
    const r = new Runner4({});
    const res: R = r.handle({ type: "reset_all", max_ticks: 600, critic: true, packed: true, slots: [{ seed: 3, map: "ironreed", blue: "policy", red: "policy" }] });
    const seat: R = Object.values(res.slots[0].seats)[0] as R;
    check(typeof seat.critic?.f === "string" && unb64(seat.critic.f).length === size(seat.critic.n), "runner sends the packed critic", JSON.stringify(Object.keys(seat.critic ?? {})));
  }
  // Mirror: the same own-frame situation for both seats gives the same critic block.
  for (const map of ["shardfall", "ironreed", "glimmerfen"]) {
    const m = fresh(map);
    const seats = [A4.createSeatState(m, IDS[0]), A4.createSeatState(m, IDS[1])];
    const oss = seats.map((s) => O4.createObsState(m, s));
    for (const k of [0, 1]) {
      const s = seats[k], c = crystalOwn(m, s, IDS[k]);
      const a = fromOwnFrame(s.frame, { x: c.x + 1500, y: c.y + 40 }), b = fromOwnFrame(s.frame, { x: c.x + 600, y: c.y - 80 });
      spawn(m, IDS[1 - k], "bruiser", a.x, a.y);
      spawn(m, IDS[k], "gunner", b.x, b.y);
    }
    computeVisibility(m);
    const cs = [O4.criticState(m, seats[0], oss[0], seats[1], oss[1]), O4.criticState(m, seats[1], oss[1], seats[0], oss[0])];
    const rows = (e: number[][]) => e.map((r) => JSON.stringify(r.map((v) => Math.round(v * 500)))).sort();
    const g0 = [...cs[0].self.globals, ...cs[0].enemy.globals], g1 = [...cs[1].self.globals, ...cs[1].enemy.globals];
    check(g0.every((v, i) => near(v, g1[i])), `${map}: same critic globals for both seats`);
    check(cs[0].self.nodes.flat().every((v, i) => near(v, cs[1].self.nodes.flat()[i])), `${map}: same critic nodes for both seats`);
    check(cs[0].self.grid.every((v, i) => near(v, cs[1].self.grid[i])), `${map}: same critic grid for both seats`);
    check(JSON.stringify(rows(cs[0].self.entities)) === JSON.stringify(rows(cs[1].self.entities)), `${map}: same critic entity rows for both seats`);
  }
}

// ---- S7: trainer-side hooks (defence teacher, switch cost, scout lock) ----

function s7Tests(): void {
  console.log("\nv4 R1 trainer hooks (S7)");
  const g = (n: string) => A4.GROUPS.indexOf(n as never), o = (n: string) => A4.ORDERS.indexOf(n as never);
  const setup = (map = "shardfall") => {
    const m = fresh(map);
    const s = A4.createSeatState(m, IDS[0]), os = O4.createObsState(m, s);
    const c = crystalOwn(m, s, IDS[0]);
    const at = (dx: number, dy: number) => fromOwnFrame(s.frame, { x: c.x + dx, y: c.y + dy });
    const look = () => { computeVisibility(m); const obs = O4.observe(m, s, os); return { obs, masks: A4.computeMasks(m, s, { scoutSlot: true }) }; };
    return { m, s, at, look, ctx: () => botContext(m, s, 20000) };
  };

  // Defence labels on hand-made states.
  {
    const { m, s, at, look, ctx } = setup();
    for (let k = 0; k < 4; k++) { const p = at(1400 + 30 * k, 0); spawn(m, IDS[0], "gunner", p.x, p.y); }
    let { obs, masks } = look();
    check(defenceLabel(obs, masks, ctx()) === null, "no threat, no raid: no defence label");
    const b = at(250, 40);
    const brute = spawn(m, IDS[1], "bruiser", b.x, b.y);
    ({ obs, masks } = look());
    const lab = defenceLabel(obs, masks, ctx());
    check(JSON.stringify(lab) === JSON.stringify([g("all_combat"), o("attack_move"), 0, 0]), "threat with the army away: all_combat attack-moves home", JSON.stringify(lab));
    check(JSON.stringify(defenceLabel(obs, masks, ctx())) === JSON.stringify(lab), "the label is pure (same inputs, same label)");
    // The army home: the threat needs no recall.
    for (const e of m.entities.values()) if (e.ownerId === IDS[0] && e.type === "gunner") { const p = at(150, 0); e.x = p.x; e.y = p.y; }
    ({ obs, masks } = look());
    check(defenceLabel(obs, masks, ctx()) === null, "threat with the army home: no recall label");
    m.entities.delete(brute.id);
    // An Outrider at the workers: one combat unit guards.
    const w = [...m.entities.values()].find((e) => e.type === "worker" && e.ownerId === IDS[0])!;
    spawn(m, IDS[1], "outrider", w.x + 60, w.y);
    ({ obs, masks } = look());
    const r = defenceLabel(obs, masks, ctx());
    const ok = !!r && r[0] === g("unit") && r[1] === o("guard") && masks.unit[r[1]][r[2]] && masks.target[r[1]][r[3]] &&
      m.entities.get(s.rows[r[2]])?.type === "gunner";
    check(ok, "a raid at the workers: a gunner guards (legal unit and target)", JSON.stringify(r));
  }

  // Switch counting on a scripted sequence.
  {
    const { m, s, look } = setup();
    look();
    const far = s.targets.findIndex((p, t) => t > 0 && s.targetValid[t] && Math.hypot(p.x - s.targets[0].x, p.y - s.targets[0].y) > 600);
    const am = (target: number, group = g("all_combat")) => ({ ...A4.NOOP_ACTION, group, order: o("attack_move"), target });
    const log: A4.OrderLog = new Map();
    const seq: [number, A4.V2Action, number][] = [
      [0, am(0), 0],                                         // first order: nothing to switch from
      [8, am(0), 0],                                         // the same order again
      [16, am(far), 1],                                      // a far target within the window
      [24, { ...am(far), order: o("move") }, 1],              // another order
      [32, am(far, g("army_a")), 0],                          // another group has its own history
      [32 + 6 * 8 + 1, am(0), 0],                             // after the window
      [32 + 6 * 8 + 9, { ...A4.NOOP_ACTION }, 0],             // no order
    ];
    let ok = true, why = "";
    for (const [tick, a, want] of seq) {
      m.tick = tick;
      const n = A4.countSwitches(m, s, a, log, A4.SWITCH_DECISIONS * 8);
      if (n !== want && ok) { ok = false; why = `tick ${tick}: ${n} vs ${want}`; }
    }
    check(far > 0 && ok, "switches: counted for a new order or a far target within 6 decisions, per group", why || `far ${far}`);
  }

  // Scout lock: a committed Outrider order closes the slot unless the lock is off.
  {
    const { m, s, at, look } = setup();
    const q = at(2000, 0);
    const rider = [...m.entities.values()].find((e) => e.type === "outrider" && e.ownerId === IDS[0])!;  // the starting Outrider
    rider.moveTarget = { x: q.x, y: q.y };
    look();
    s.scoutCmd = { order: o("move"), x: q.x, y: q.y, targetId: null, tick: m.tick, until: m.tick + A4.SCOUT_COMMIT_TICKS };
    const open = (lock: boolean) => A4.computeMasks(m, s, { scoutSlot: true, scoutLock: lock }).scoutOrder.filter(Boolean).length;
    check(open(true) < open(false) && open(false) > 2, "scout lock on: the committed slot is narrowed; off: every order open", `${open(true)} vs ${open(false)}`);
  }

  // Runner flags: labels and the switch reward only when asked for; the game itself does not change.
  // The policy seat is played by the scripted flank bot (from this test) against the backdoor bot.
  {
    const slot = { seed: 31, map: "shardfall", blue: "policy", red: "teach:backdoor" };
    const run = (extra: R) => {
      const r = new Runner4({});
      let res: R = r.handle({ type: "reset_all", max_ticks: 9000, critic: false, slots: [slot], ...extra });
      const sl = (r as any).slots[0];
      const bot = makeV2Bot("flank", 31, botContext(sl.match, sl.seats[0], 9000));
      let labels = 0, recalls = 0, guards = 0, legal = true, hasD = false, hasSw = false;
      for (let d = 0; d < 9000 / 8 && res.type !== "error" && !res.slots[0].done; d++) {
        const st = res.slots[0].seats.blue, mk = sl.masks[0] as A4.V2Masks;
        if ("defenceTeacher" in st) hasD = true;
        if (st.defenceTeacher) {
          labels++;
          const [gg, oo, uu, tt] = st.defenceTeacher;
          if (gg === g("unit")) guards++; else recalls++;
          if (!mk.group[gg] || !mk.order[gg][oo] || (gg === g("unit") && !mk.unit[oo][uu]) || !mk.target[oo][tt]) legal = false;
        }
        res = r.handle({ type: "step", actions: [{ blue: toWire(bot.decide(st.obs, mk)) }] });
        if (res.type === "error") throw new Error(res.message);
        const rw = res.slots[0].rewards?.blue;
        if (rw && "switch" in rw.shaped) hasSw = true;
      }
      const m = sl.match as MatchState;
      const log = [m.tick, ...[...m.entities.values()].map((e) => [e.id, Math.round(e.x), Math.round(e.y), e.health])];
      return { labels, recalls, guards, legal, hasD, hasSw, log: JSON.stringify(log) };
    };
    const off = run({}), on = run({ defence_teacher: true, switch_cost: true });
    check(!off.hasD && !off.hasSw, "flags off: no defenceTeacher field, no shaped.switch");
    check(on.hasD && on.hasSw, "flags on: defenceTeacher field and shaped.switch present");
    check(on.labels > 0 && on.legal, `flank (as policy) v backdoor: defence labels appear and are legal (${on.recalls} recalls, ${on.guards} guards)`);
    check(on.log === off.log, "the flags do not change the game");
  }
}

// S10 scenario starts: a replay fast-forwarded to a decision tick continues the same game.
function scenarioTests(): void {
  console.log("\nscenario starts (S10)");
  const dir = mkdtempSync(join(tmpdir(), "cf-scenario-"));
  const flags = { scout_slot: true, scout_teacher: true, defence_teacher: true, switch_cost: true, critic: false };
  const MAPS = ["shardfall", "basalt-run", "twin-spires", "hollow-crown", "glimmerfen", "saltmarsh", "ironreed", "cinder-flats"];
  const POL = ["flank", "macro", "rush2", "swing", "hidden"], OPP = ["backdoor", "flank", "swing", "hidden", "rush_post"];
  const CAP = 4000, MID = 800;
  /** One game: the policy seat played by a scripted bot; its replay, final hash and the decisions at MID. */
  const original = (i: number) => {
    const side = i % 2 ? "red" : "blue", other = side === "blue" ? "red" : "blue";
    const slot: R = { seed: 900 + i, map: MAPS[i % MAPS.length], [side]: "policy", [other]: `bot:${OPP[i % OPP.length]}` };
    let replay: R | null = null, hash = "";
    const r: Runner4 = new Runner4({ onReplay: (_i, rp) => { replay = rp as R; hash = hashMatchState(r.matchOf(0)); } });
    let res: R = r.handle({ type: "reset_all", max_ticks: CAP, slots: [slot], ...flags });
    if (res.type === "error") throw new Error(res.message);
    const sl = (r as any).slots[0];
    const pi = side === "blue" ? 0 : 1;
    const bot = makeV2Bot(POL[i % POL.length], 900 + i, botContext(sl.match, sl.seats[pi], CAP));
    const at: R[] = [];
    while (!replay) {
      const tick = sl.match.tick, st = res.slots[0].seats[side];
      const a = toWire(bot.decide(st.obs, sl.masks[pi]));
      res = r.handle({ type: "step", actions: [{ [side]: a }] });
      if (res.type === "error") throw new Error(res.message);
      if (tick >= MID && at.length < 10) at.push({ seat: JSON.stringify(st), a, rewards: JSON.stringify(res.slots[0].rewards) });
    }
    const file = join(dir, `g${i}.json`);
    writeFileSync(file, JSON.stringify(replay));
    return { slot, side, file, replay: replay as R, hash, at };
  };
  const reset = (slot: R, sc: R, extra: R = {}) => {
    let hash = "";
    const r: Runner4 = new Runner4({ onReplay: () => { hash = hashMatchState(r.matchOf(0)); } });
    const res: R = r.handle({ type: "reset_all", max_ticks: CAP, slots: [{ ...slot, scenario: sc }], ...flags, ...extra });
    return { r, res, hash: () => hash };
  };
  const n = process.env.V4_QUICK ? 4 : 20;
  let ends = 0, endsOk = 0;
  const games: ReturnType<typeof original>[] = [];
  for (let i = 0; i < n; i++) {
    const g = original(i);
    if (i < 4) games.push(g);
    const acts = g.replay.v2.actions as R[], last = acts[acts.length - 1];
    const { r, res, hash } = reset(g.slot, { replay: g.file, tick: last.tick, seat: g.side });
    if (res.type === "error") { console.log(`    game ${i}: ${res.message}`); ends++; continue; }
    const out: R = r.handle({ type: "step", actions: [{ [g.side]: last[g.side] }] });
    ends++;
    if (out.type !== "error" && (out.slots[0].done || out.slots[0].truncated) && hash() === g.hash) endsOk++;
    else console.log(`    game ${i}: ${out.type === "error" ? out.message : "final state differs"}`);
  }
  check(endsOk === ends, `${ends} replays fast-forwarded to their last decision end in the original final state hash`, `${endsOk}/${ends}`);

  // Handover mid-game: the first decision's observation, masks and teacher labels are the original's, and so
  // are the next decisions' rewards (only the window after the handover counts); twice gives the same.
  for (const [k, g] of games.slice(0, 2).entries()) {
    const run = () => {
      const { r, res } = reset(g.slot, { replay: g.file, tick: (g.replay.v2.actions as R[]).find((a) => a.tick >= MID)!.tick, seat: g.side });
      if (res.type === "error") throw new Error(res.message);
      const got: R[] = [];
      let cur: R = res.slots[0];
      for (const want of g.at) {
        const seat = JSON.stringify(cur.seats[g.side]);
        const nx: R = r.handle({ type: "step", actions: [{ [g.side]: want.a }] });
        if (nx.type === "error") throw new Error(nx.message);
        got.push({ seat, rewards: JSON.stringify(nx.slots[0].rewards) });
        cur = nx.slots[0];
      }
      return { got, info: res.slots[0].episode };
    };
    const a = run(), b = run();
    check(a.got.every((x, j) => x.seat === g.at[j].seat), `game ${k}: handover at tick ~${MID}: obs, masks and teacher labels equal the original game's`);
    check(a.got.every((x, j) => x.rewards === g.at[j].rewards), `game ${k}: rewards after the handover equal the original game's`);
    check(JSON.stringify(a) === JSON.stringify(b) && a.info.scenario?.replay === g.file, `game ${k}: deterministic; episode info names the scenario`);
  }

  // A scenario configured for a slot's next episode fast-forwards in the background while the current
  // episode plays (Slot.pre); the episode it starts equals a direct start of the scenario.
  {
    const g = games[0], tick = (g.replay.v2.actions as R[]).find((a) => a.tick >= MID)!.tick, sc = { replay: g.file, tick, seat: g.side };
    const direct = reset(g.slot, sc);
    if (direct.res.type === "error") throw new Error(direct.res.message);
    const r: Runner4 = new Runner4({});
    let res: R = r.handle({ type: "reset_all", max_ticks: CAP, slots: [{ ...g.slot, seed: 4242 }], ...flags });
    if (res.type === "error") throw new Error(res.message);
    const cf: R = r.handle({ type: "configure", slots: [{ index: 0, ...g.slot, scenario: sc }] });
    if (cf.type === "error") throw new Error(cf.message);
    const sl = (r as any).slots[0];
    let steps = 0, ahead = 0, preMatch: unknown = null;
    while (!(res.slots[0].done || res.slots[0].truncated)) {
      ahead = sl.pre ? sl.pre.slot.match.tick : 0;
      preMatch = sl.pre?.slot.match;
      res = r.handle({ type: "step", actions: [{ [g.side]: toWire(A4.NOOP_ACTION) }] });
      if (res.type === "error") throw new Error(res.message);
      steps++;
    }
    check(ahead >= tick, `a scenario for the next episode fast-forwards in the background (to tick ${ahead} of ${tick} during ${steps} steps)`);
    const same = JSON.stringify(res.slots[0].seats[g.side]) === JSON.stringify(direct.res.slots[0].seats[g.side]);
    const a1 = r.handle({ type: "step", actions: [{ [g.side]: g.at[0].a }] }) as R;
    const a2 = direct.r.handle({ type: "step", actions: [{ [g.side]: g.at[0].a }] }) as R;
    check(same && JSON.stringify(a1.slots[0]) === JSON.stringify(a2.slots[0]) && sl.match === preMatch,
      "the episode it starts equals a direct start of the scenario");
  }

  // Mismatches fail loudly.
  {
    const g = games[0], acts = g.replay.v2.actions as R[], tick = acts[200].tick, other = g.side === "blue" ? "red" : "blue";
    const bad = (mut: (r: R) => void, slotMut: (s: R) => void = () => {}) => {
      const rp = JSON.parse(JSON.stringify(g.replay));
      mut(rp);
      const f = join(dir, "bad.json");
      writeFileSync(f, JSON.stringify(rp));
      const slot = { ...g.slot };
      slotMut(slot);
      const res = reset(slot, { replay: f, tick, seat: g.side }).res;
      return res.type === "error" ? String(res.message) : "";
    };
    const divergent = bad((rp) => { const a = rp.v2.actions[50][other]; a.army[0] = a.army[0] === 1 ? 2 : 1; });
    check(/diverged/.test(divergent), "a bot action that is not the replay's fails", divergent);
    const logBad = bad((rp) => { rp.commandLog.splice(5, 1); });
    check(/command log differs/.test(logBad), "a command log that is not the replay's fails", logBad);
    const mapBad = bad(() => {}, (s) => { s.map = s.map === "ironreed" ? "shardfall" : "ironreed"; });
    check(/the replay is/.test(mapBad), "a slot whose map is not the replay's fails", mapBad);
    const tickBad = bad(() => {}, () => {});
    check(tickBad === "", "the unmodified replay starts", tickBad);
    const notDecision = reset(g.slot, { replay: g.file, tick: tick + 1, seat: g.side }).res;
    check(notDecision.type === "error" && /not one of its decisions/.test(notDecision.message), "a handover tick between decisions fails");
  }
  rmSync(dir, { recursive: true, force: true });
}

// Rebuild R1 S11: forced exploiters. A policy seat with a shadow bot gets the bot's action as `shadowTeacher`
// and its build list as shaped.build; playing the labels plays the bot, so its build list completes.
function shadowTests(): void {
  console.log("\n== shadow bot (S11)");
  const noop = toWire(A4.NOOP_ACTION);
  const reset = (slot: Record<string, unknown>) => new Runner4().handle({ type: "reset_all", scout_slot: true, slots: [slot] });
  const base = { seed: 7, map: "shardfall", blue: "policy", red: "bot:idle" };
  const r = new Runner4();
  let res: any = r.handle({ type: "reset_all", scout_slot: true, slots: [{ ...base, z: { blue: 23, red: 0 }, shadow: { blue: "backdoor" } }] });
  check(res.type === "ready", "a shadow slot starts", res.message ?? "");
  let seats = res.slots[0].seats, n = 0, nul = 0, build = 0, gotKey = 0;
  for (let step = 0; step < 400; step++) {
    const t = seats.blue.shadowTeacher;
    n++; if (t === null) nul++;
    res = r.handle({ type: "step", actions: [{ blue: t ?? noop }] });
    const s = res.slots[0];
    if (s.rewards.blue && "build" in s.rewards.blue.shaped) gotKey++;
    build += s.rewards.blue?.shaped.build ?? 0;
    if (s.done || s.truncated) break;
    seats = s.seats;
  }
  check(gotKey === n, "every window carries shaped.build", `${gotKey} of ${n}`);
  check(nul / n < 0.05, "the shadow bot's labels are legal on the policy seat's masks", `${nul} of ${n} illegal`);
  check(Math.abs(build - 1) < 1e-9, "playing the labels completes the build list (shaped.build sums to 1)", `${build}`);
  const plain = new Runner4().handle({ type: "reset_all", slots: [base] }) as any;
  check(!("shadowTeacher" in plain.slots[0].seats.blue), "no shadow, no shadowTeacher");
  const err = (slot: Record<string, unknown>, re: RegExp, name: string) => {
    const e = reset(slot) as any;
    check(e.type === "error" && re.test(e.message), name, e.message ?? e.type);
  };
  err({ ...base, shadow: { red: "backdoor" } }, /not a policy seat/, "a shadow on a bot seat fails");
  err({ ...base, shadow: { blue: "nobody" } }, /unknown scripted bot/, "an unknown shadow bot fails");
  err({ ...base, z: { blue: 99, red: 0 }, shadow: { blue: "backdoor" } }, /no template with z/, "a z the shadow bot has no template for fails");
  err({ ...base, shadow: { blue: "backdoor" }, scenario: { replay: "x.json", tick: 800, seat: "blue" } }, /cannot have a shadow/, "a scenario start with a shadow bot fails");
}

schemaTests();
shadowTests();
criticTests();
s7Tests();
oppLabelTests();
memoryTests();
scenarioTests();
if (!process.env.V4_QUICK) equivalenceTests();
console.log(`\nv4: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
