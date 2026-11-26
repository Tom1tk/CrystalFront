// Layout v4 tests (docs/REBUILD_R1_PLAN.md). Run by `npm test` after tests/index.ts.
//   npx tsx tests/v4.ts
import { VecRunnerV2 as Runner3 } from "../headless/src/v3/runner.js";
import { VecRunnerV2 as Runner4 } from "../headless/src/v4/runner.js";
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

schemaTests();
oppLabelTests();
memoryTests();
if (!process.env.V4_QUICK) equivalenceTests();
console.log(`\nv4: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
