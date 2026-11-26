// G-10 M0 T7 (P-2): two-seat vectorised runner, protocol v2.
//
// The protocol logic lives here, in-process (`VecRunnerV2.handle`), so tests can
// drive it without a pipe; `vecRunner.ts` wires it to stdin/stdout.
//
// Python → Node (newline-delimited JSON)
//   { type: "reset_all", decision_interval?: 8, max_ticks?: 12000, critic?: true, packed?: false,
//     scout_slot?: false, scout_teacher?: false, scout_lock?: true, switch_cost?: false, defence_teacher?: false,
//     slots: [ { seed, map, blue, red, z?: {blue, red}, scenario?: null, save_replay?: false } ] }
//       blue/red: "policy" | "bot:<name>" | "teach:<name>"
//   { type: "step", actions: [ { blue?: {econ: [kind, site, econPtr, econTarget], army: [group, order, unit, target, ptr], scout?: [order, target, ptr]}, red?: … } ] }
//       scout: the Outrider's own order (scout_slot: policy seats get masks for it, and the
//       Outrider is then out of the `scout` group and the unit pointer; see actions.ts)
//       action space v3 (actions.ts); heads that do not apply to the chosen kind/order are ignored
//       one entry per slot; only "policy" seats need an action
//   { type: "configure", slots: [ { index, …any slot field } ] }
//       applied at that slot's next (auto)reset; a new seed restarts its seed sequence
//   { type: "close" }
//
// Node → Python
//   { type: "ready", schemaVersion, actionSpaceVersion, slots: [ { seats, static, episode: {…} } ] }
//   { type: "step_result", slots: [ { seats, rewards, done, truncated, terminal, info, static?, episode? } ] }
//   { type: "configured" } | { type: "error", message }
//
// Per decision and slot: worker autopilot (both seats) → observe → masks → bot
// and teacher choices; then the step applies both seats' actions together
// (applyV2Pair, no first-mover edge) and runs `decision_interval` ticks.
// `seats` holds one entry per policy or teach seat: { obs, masks, critic?,
// oppLabels, teacher, scoutTeacher? }. `teacher` is the bot's action chosen from that same obs.
// `scoutTeacher` (scout_teacher, policy seats): [order, target, ptr], what a scripted Outrider
// (scout.ts, style careful) would order through the scout slot now; order 0 = keep going.
// `defenceTeacher` (defence_teacher, policy seats): [group, order, unit, target], the army order the
// scripted bots' defence rules give now (defence.ts), or null when no defence applies.
// scout_lock false: the scout slot's 50-tick commitment is off (actions.ts MaskOpts.scoutLock).
// switch_cost: rewards[side].shaped.switch counts this decision's switch events (actions.ts countSwitches).
// `rewards` (per policy/teach seat) covers the window just played: raw
// components, see rewards.ts, plus shaped.intel: first sightings of enemy entities this window
// (sightingWeight), mine minus the opponent's. On done or truncation `terminal` holds the final
// { obs, critic, oppLabels } per policy/teach seat and the slot is autoreset:
// `seats` is then the new episode's first decision, and `static` / `episode`
// describe it. Slot settings persist across autoresets.
//
// packed (training speed): every obs is { z, n, f } where f is base64 float32
// [globals | nodes | memory | grid | n entity rows]; masks are one base64
// bit string (MSB first) of MASK_KEYS in order, each flattened row-major; critic
// is base64 float32 [own globals | enemy globals] (all the trainer uses). `ready`
// then carries `layout` (the shapes) for Python to check.
import { MatchEngine } from "../../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type MatchState, type PlayerSlot } from "../../../server/src/match/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_VERSION } from "@crystalfront/shared";
import { episodeStatus, TRAIN_MAX_TICKS } from "../episode.js";
import * as V2 from "./actions.js";
import * as OBS from "./observation.js";
import { makeV2Bot, type V2Bot } from "./bots.js";
import { botContext, type BotContext } from "./scripted.js";
import { defenceLabel } from "./defence.js";
import { OutriderPlan } from "./scout.js";
import { rewardSnapshot, windowRewards, type RewardSnapshot, type SeatRewards } from "./rewards.js";

export const PLAYER_IDS = ["v2-blue", "v2-red"] as const;
const SIDES = ["blue", "red"] as const;
type Side = typeof SIDES[number];

export interface SlotConfig {
  seed: number;
  map: string;
  blue: string;
  red: string;
  z: { blue: number; red: number };
  scenario: null;
  save_replay: boolean;
}

interface SeatSpec { kind: "policy" | "bot" | "teach"; bot: string | null }

export function parseSeat(spec: string): SeatSpec {
  if (spec === "policy") return { kind: "policy", bot: null };
  const m = /^(bot|teach):([a-z0-9_]+)$/.exec(spec);
  if (!m) throw new Error(`bad seat "${spec}" (want "policy", "bot:<name>" or "teach:<name>")`);
  return { kind: m[1] as "bot" | "teach", bot: m[2] };
}

/** 32-bit mix (murmur3 finaliser) for derived seeds. */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function strSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

const bit = (b: boolean[]) => b.map((v) => (v ? 1 : 0));

const b64 = (a: Float32Array | Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
export const MASK_KEYS = ["econ", "site", "econPtr", "econTarget", "group", "order", "unit", "target", "ptr", "scoutOrder"] as const;

export function packObs(o: OBS.ObsV2) {
  const n = o.entities.length;
  const parts = [o.globals, ...o.nodes, ...o.memory, o.grid, ...o.entities];
  const f = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of parts) { f.set(p, k); k += p.length; }
  return { z: o.z, n, f: b64(f) };
}

export function packMasks(m: V2.V2Masks): string {
  const rows: boolean[][] = [];
  for (const key of MASK_KEYS) {
    const v = m[key] as boolean[] | boolean[][];
    if (Array.isArray(v[0])) rows.push(...(v as boolean[][])); else rows.push(v as boolean[]);
  }
  const total = rows.reduce((s, r) => s + r.length, 0);
  const out = new Uint8Array((total + 7) >> 3);
  let i = 0;
  for (const r of rows) for (const v of r) { if (v) out[i >> 3] |= 0x80 >> (i & 7); i++; }
  return b64(out);
}

/**
 * Full critic state (rebuild R1, S5; training only): both seats' true globals, then this seat's unfogged
 * nodes, dynamic grid and entity rows (`n` rows, the observation's row priority), all in its own frame.
 */
export function packCritic(c: OBS.CriticV2) {
  const parts = [c.self.globals, c.enemy.globals, ...c.self.nodes, c.self.grid, ...c.self.entities];
  const f = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of parts) { f.set(p, k); k += p.length; }
  return { n: c.self.entities.length, f: b64(f) };
}

/** Shapes Python checks before trusting packed messages. */
function layout(o: OBS.ObsV2, m: V2.V2Masks) {
  const shape = (v: boolean[] | boolean[][]) => (Array.isArray(v[0]) ? [v.length, (v[0] as boolean[]).length] : [v.length]);
  return {
    globals: o.globals.length, nodes: [o.nodes.length, o.nodes[0].length], memory: [o.memory.length, o.memory[0].length],
    grid: o.grid.length, entityF: OBS.ENTITY_F,
    masks: MASK_KEYS.map((k) => [k, shape(m[k] as boolean[] | boolean[][])]),
  };
}
export function encodeMasks(m: V2.V2Masks) {
  return {
    econ: bit(m.econ), site: m.site.map(bit), econPtr: m.econPtr.map(bit), econTarget: bit(m.econTarget),
    group: bit(m.group), order: m.order.map(bit), unit: m.unit.map(bit), target: m.target.map(bit), ptr: m.ptr.map(bit),
    scoutOrder: bit(m.scoutOrder),
  };
}

export interface WireAction { econ: [number, number, number, number]; army: [number, number, number, number, number]; scout?: [number, number, number] }
export const toWire = (a: V2.V2Action): WireAction => ({
  econ: [a.econ, a.site, a.econPtr, a.econTarget], army: [a.group, a.order, a.unit, a.target, a.ptr],
  ...(a.scoutOrder !== undefined ? { scout: [a.scoutOrder, a.scoutTarget ?? V2.TARGET_NONE, a.scoutPtr ?? 0] as [number, number, number] } : {}),
});

export function fromWire(w: unknown): V2.V2Action | null {
  const a = w as WireAction | undefined;
  const ints = (x: unknown, n: number): x is number[] => Array.isArray(x) && x.length === n && x.every(Number.isInteger);
  if (!a || !ints(a.econ, 4) || !ints(a.army, 5) || (a.scout !== undefined && !ints(a.scout, 3))) return null;
  const [econ, site, econPtr, econTarget] = a.econ, [group, order, unit, target, ptr] = a.army;
  const out: V2.V2Action = { econ, site, econPtr, econTarget, group, order, unit, target, ptr };
  if (a.scout) [out.scoutOrder, out.scoutTarget, out.scoutPtr] = a.scout;
  return out;
}

export interface RunnerOptions {
  /** Test hook: called after every engine tick. */
  onTick?: (slot: number, match: MatchState) => void;
  /** Test hook: called with every finished episode's replay (whether or not it is saved). */
  onReplay?: (slot: number, replay: V2Replay) => void;
}

/**
 * A v2 episode in the server's replay format. `commandLog` alone replays the
 * game on the server; `v2` adds what an observation replay needs (`replayObs.ts`):
 * the decision interval, cap, each seat's z and every decision's applied actions
 * (forbidden policy actions recorded as the no-op that was played).
 */
export interface V2Replay {
  id: string; seed: number; blue: string; red: string; bluePlayerId: string; redPlayerId: string;
  version: string; engineVersion: number; mapId: string; mapVersion: number; timestamp: number;
  outcome: { winner: Side | null; winnerName: string | null; winType: string | null; ticks: number };
  commandLog: Array<{ tick: number; playerId: string; command: Record<string, unknown> }>;
  v2: { obsSchemaVersion: number; actionSpaceVersion: number; k: number; cap: number; z: [number, number]; actions: Array<{ tick: number; blue: WireAction; red: WireAction }> };
}

interface Globals {
  k: number; cap: number; critic: boolean; packed: boolean; scoutSlot: boolean; scoutTeacher: boolean;
  scoutLock: boolean; switchCost: boolean; defenceTeacher: boolean;
}

/** First-sighting weights for the intel reward: buildings (and the crystal) 1, army units 0.25, workers 0.1; per INTEL_SCALE. */
export const INTEL_SCALE = 20;
export function sightingWeight(e: { type: string }): number {
  return e.type === "building" || e.type === "crystal" ? 1 : e.type === "worker" ? 0.1 : 0.25;
}
/** Scout teacher: an order the Outrider got through the slot within this many decisions still counts as carried out. */
const SCOUT_TEACHER_REFRESH = 10;

class Slot {
  cfg: SlotConfig;
  /** Seed sequence: episode n of the sequence uses seed n = 0 ? base : mixSeed(base, n). */
  seedBase: number;
  seqIndex = 0;
  episodes = 0;
  pendingCfg: Partial<SlotConfig> | null = null;

  engine!: MatchEngine;
  match!: MatchState;
  specs!: [SeatSpec, SeatSpec];
  seats!: [V2.SeatState, V2.SeatState];
  oss!: [OBS.ObsState, OBS.ObsState];
  bots!: [V2Bot | null, V2Bot | null];
  /** This decision's masks and bot/teacher choices. */
  masks = [] as unknown as [V2.V2Masks, V2.V2Masks];
  /** packed mode: shapes of the first observed seat (reported once, in `ready`). */
  layout: ReturnType<typeof layout> | null = null;
  chosen: [V2.V2Action | null, V2.V2Action | null] = [null, null];
  snap!: RewardSnapshot;
  actions: V2Replay["v2"]["actions"] = [];
  illegal: [number, number] = [0, 0];
  botErrors: [number, number] = [0, 0];
  episodeSeed = 0;
  /** Strategy token in each seat's observation: the configured z, or a scripted bot's own z when none is configured. */
  zSeat: [number, number] = [0, 0];
  /** scout_teacher: the scripted Outrider plan shadowing each policy seat. */
  shadows: [OutriderPlan | null, OutriderPlan | null] = [null, null];
  /** Enemy entity ids each seat has seen (intel reward). */
  sighted: [Set<string>, Set<string>] = [new Set(), new Set()];
  /** defence_teacher: each policy seat's bot context (defence.ts). */
  defCtx: [BotContext | null, BotContext | null] = [null, null];
  /** switch_cost: the last order per group key, per seat. */
  orderLogs: [V2.OrderLog, V2.OrderLog] = [new Map(), new Map()];

  constructor(cfg: SlotConfig, private idx: number, private g: Globals, private opts: RunnerOptions) {
    this.cfg = cfg;
    this.seedBase = cfg.seed;
  }

  /** Start the next episode (applying any pending configuration) and prepare its first decision. */
  start(): Record<string, unknown> {
    if (this.pendingCfg) {
      const p = this.pendingCfg;
      this.pendingCfg = null;
      this.cfg = { ...this.cfg, ...p, z: { ...this.cfg.z, ...(p.z ?? {}) } };
      if (p.seed !== undefined) { this.seedBase = p.seed; this.seqIndex = 0; }
    }
    const cfg = this.cfg;
    if (cfg.scenario !== null) throw new Error("scenarios are not implemented yet (probes, §6)");
    this.specs = [parseSeat(cfg.blue), parseSeat(cfg.red)];
    this.episodeSeed = this.seqIndex === 0 ? this.seedBase >>> 0 : mixSeed(this.seedBase, this.seqIndex);
    this.seqIndex++;
    this.engine = new MatchEngine();
    const players: [PlayerSlot, PlayerSlot] = [
      { playerId: PLAYER_IDS[0], username: cfg.blue, color: "blue", score: 0 },
      { playerId: PLAYER_IDS[1], username: cfg.red, color: "red", score: 0 },
    ];
    this.match = this.engine.createMatch(`v2-${this.idx}-${this.episodes}`, players, { ...DEFAULT_CONFIG, ruleset: "beta", mapId: cfg.map, maxTicks: this.g.cap }, this.episodeSeed);
    this.engine.startMatch(this.match.id);
    this.seats = [V2.createSeatState(this.match, PLAYER_IDS[0]), V2.createSeatState(this.match, PLAYER_IDS[1])];
    this.oss = [OBS.createObsState(this.match, this.seats[0]), OBS.createObsState(this.match, this.seats[1])];
    // Bot seeds come from the episode seed and the bot's name, never the seat:
    // the same seed with seats swapped then plays the mirrored game.
    this.bots = this.specs.map((s, i) => (s.bot
      ? makeV2Bot(s.bot, mixSeed(this.episodeSeed, strSeed(s.bot)), botContext(this.match, this.seats[i], this.g.cap), cfg.z[SIDES[i]])
      : null)) as [V2Bot | null, V2Bot | null];
    this.zSeat = [0, 1].map((i) => cfg.z[SIDES[i]] || this.bots[i]?.z || 0) as [number, number];
    this.shadows = [0, 1].map((i) => (this.g.scoutTeacher && this.specs[i].kind === "policy"
      ? new OutriderPlan("careful", "never", botContext(this.match, this.seats[i], this.g.cap)) : null)) as [OutriderPlan | null, OutriderPlan | null];
    this.sighted = [new Set(), new Set()];
    this.sight();
    this.defCtx = [0, 1].map((i) => (this.g.defenceTeacher && this.specs[i].kind === "policy" ? botContext(this.match, this.seats[i], this.g.cap) : null)) as [BotContext | null, BotContext | null];
    this.orderLogs = [new Map(), new Map()];
    this.actions = [];
    this.illegal = [0, 0];
    this.botErrors = [0, 0];
    this.episodes++;
    return this.prepare();
  }

  private learnerSides(): number[] {
    return [0, 1].filter((i) => this.specs[i].kind !== "bot");
  }

  /** Autopilot, observe, masks and bot choices for the decision about to be made. */
  prepare(): Record<string, unknown> {
    const { engine, match } = this;
    for (const s of this.seats) {
      V2.workerAutopilot(engine, match, s);
    }
    const out: Record<string, unknown> = {};
    const critic = this.g.critic && this.learnerSides().length ? this.critic() : null;
    for (const i of [0, 1] as const) {
      const obs = OBS.observe(match, this.seats[i], this.oss[i], { z: this.zSeat[i], cap: this.g.cap });
      this.masks[i] = V2.computeMasks(match, this.seats[i], { scoutSlot: this.g.scoutSlot && this.specs[i].kind === "policy", scoutLock: this.g.scoutLock });
      this.chosen[i] = this.bots[i] ? this.botDecide(i, obs) : null;
      const sh = this.shadows[i];
      let scoutTeacher: [number, number, number] | null = null;
      if (sh) {
        const want = sh.shadow(obs, this.masks[i], this.seats[i].stats.decisions);
        scoutTeacher = !want || V2.scoutCmdMatches(match, this.seats[i], want, SCOUT_TEACHER_REFRESH * this.g.k)
          ? [0, V2.TARGET_NONE, 0] : [want.scoutOrder, want.scoutTarget, want.scoutPtr];
      }
      if (this.specs[i].kind === "bot") continue;
      if (this.g.packed && !this.layout) this.layout = layout(obs, this.masks[i]);
      out[SIDES[i]] = {
        obs: this.g.packed ? packObs(obs) : obs,
        masks: this.g.packed ? packMasks(this.masks[i]) : encodeMasks(this.masks[i]),
        ...(critic ? { critic: this.g.packed ? packCritic(critic[i]) : critic[i] } : {}),
        oppLabels: OBS.oppLabels(match, this.seats[i]),
        teacher: this.specs[i].kind === "teach" ? toWire(this.chosen[i]!) : null,
        ...(scoutTeacher ? { scoutTeacher } : {}),
        ...(this.defCtx[i] ? { defenceTeacher: defenceLabel(obs, this.masks[i], this.defCtx[i]!) } : {}),
      };
    }
    this.snap = rewardSnapshot(match);
    return out;
  }

  /** New first sightings per seat since the last call (weighted, sightingWeight). */
  private sight(): [number, number] {
    const out: [number, number] = [0, 0];
    for (const i of [0, 1] as const) {
      const pid = PLAYER_IDS[i], vis = this.match.visibilityData?.get(pid), seen = this.sighted[i];
      for (const e of this.match.entities.values()) {
        if (e.ownerId === pid || e.health <= 0 || seen.has(e.id) || (vis && !vis.entityIds.has(e.id))) continue;
        if (e.ownerId !== PLAYER_IDS[1 - i]) continue;
        seen.add(e.id);
        out[i] += sightingWeight(e);
      }
    }
    return out;
  }

  /** A bot's choice; a bot exception is logged and counted (`stats.botErrors`) and plays a no-op. */
  private botDecide(i: 0 | 1, obs: OBS.ObsV2): V2.V2Action {
    try {
      return this.bots[i]!.decide(obs, this.masks[i]);
    } catch (e) {
      this.botErrors[i]++;
      if (this.botErrors[i] <= 3) process.stderr.write(`v2 runner: slot ${this.idx} ${SIDES[i]} bot ${this.specs[i].bot} threw at tick ${this.match.tick}: ${(e as Error).stack ?? e}\n`);
      return { ...V2.NOOP_ACTION };
    }
  }

  /** Fog-free blocks for both seats, each in its own frame (computed once, swapped for seat 1). */
  private critic(): [OBS.CriticV2, OBS.CriticV2] {
    const c0 = OBS.criticState(this.match, this.seats[0], this.oss[0], this.seats[1], this.oss[1], this.g.cap);
    return [c0, { self: c0.enemy, enemy: c0.self }];
  }

  /** The finished episode as a replay (server format plus the `v2` block). */
  private replay(winner: Side | null): V2Replay {
    const m = this.match, now = Date.now();
    return {
      id: `${now}-v2-${this.idx}-${this.episodes - 1}`, seed: m.seed, blue: this.cfg.blue, red: this.cfg.red, bluePlayerId: PLAYER_IDS[0], redPlayerId: PLAYER_IDS[1],
      version: GAME_VERSION, engineVersion: ENGINE_VERSION, mapId: this.cfg.map, mapVersion: m.terrain.mapVersion, timestamp: now,
      outcome: { winner, winnerName: winner === null ? null : this.cfg[winner], winType: m.result?.winType ?? null, ticks: m.tick },
      // The engine's own log: every accepted command in the order it was processed.
      commandLog: m.commandLog.map((e) => ({ ...e })),
      v2: { obsSchemaVersion: OBS.OBS_SCHEMA_VERSION, actionSpaceVersion: V2.ACTION_SPACE_VERSION, k: this.g.k, cap: this.g.cap, z: [...this.zSeat], actions: this.actions },
    };
  }

  /**
   * Write the replay under <cwd>/replays (the server's replayRunner.saveReplay is
   * not imported: it pulls in the websocket server).
   */
  private saveReplay(r: V2Replay): string {
    const dir = resolve(process.cwd(), "replays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r));
    return r.id;
  }

  episodeInfo() {
    return { index: this.episodes - 1, seed: this.episodeSeed, map: this.cfg.map, blue: this.cfg.blue, red: this.cfg.red, z: { ...this.cfg.z }, botZ: { blue: this.bots[0]?.z ?? 0, red: this.bots[1]?.z ?? 0 } };
  }

  step(wire: Record<string, unknown> | undefined): Record<string, unknown> {
    const { engine, match } = this;
    const acts: V2.V2Action[] = [];
    for (const i of [0, 1] as const) {
      if (this.specs[i].kind !== "policy") { acts.push(this.chosen[i]!); continue; }
      const raw = wire?.[SIDES[i]];
      if (raw === undefined) throw new Error(`slot ${this.idx}: missing action for policy seat ${SIDES[i]}`);
      const a = fromWire(raw);
      if (!a) throw new Error(`slot ${this.idx}: malformed action for ${SIDES[i]}: ${JSON.stringify(raw)}`);
      if (V2.isLegal(this.masks[i], a)) acts.push(a);
      else { this.illegal[i]++; acts.push({ ...V2.NOOP_ACTION }); }
    }
    this.actions.push({ tick: match.tick, blue: toWire(acts[0]), red: toWire(acts[1]) });
    const switches = this.g.switchCost
      ? [0, 1].map((i) => V2.countSwitches(match, this.seats[i], acts[i], this.orderLogs[i], V2.SWITCH_DECISIONS * this.g.k)) : null;
    V2.applyV2Pair(engine, match, this.seats, [acts[0], acts[1]]);
    let st = episodeStatus(match, this.g.cap);
    for (let t = 0; t < this.g.k && !st.terminated && !st.truncated; t++) {
      engine.tick(match.id);
      this.opts.onTick?.(this.idx, match);
      st = episodeStatus(match, this.g.cap);
    }
    const winnerSeat = st.terminated && match.result ? (match.result.winner === PLAYER_IDS[0] ? 0 : match.result.winner === PLAYER_IDS[1] ? 1 : null) : null;
    const rw = windowRewards(match, this.snap, winnerSeat);
    const seen = this.sight();
    const intel = Math.round(((seen[0] - seen[1]) / INTEL_SCALE) * 1e6) / 1e6;
    const rewards: Record<string, SeatRewards & { shaped: { intel: number; switch?: number } }> = {};
    for (const i of this.learnerSides()) {
      rewards[SIDES[i]] = { ...rw[i], shaped: { ...rw[i].shaped, intel: i === 0 ? intel : -intel || 0, ...(switches ? { switch: switches[i] } : {}) } };
    }

    if (!st.terminated && !st.truncated) {
      return { seats: this.prepare(), rewards, done: false, truncated: false, terminal: null, info: {} };
    }

    // Episode over: final observations, info, replay, then autoreset.
    const terminal: Record<string, unknown> = {};
    const critic = this.g.critic ? this.critic() : null;
    for (const i of this.learnerSides()) {
      const obs = OBS.observe(match, this.seats[i], this.oss[i], { z: this.zSeat[i], cap: this.g.cap });
      terminal[SIDES[i]] = {
        obs: this.g.packed ? packObs(obs) : obs,
        ...(critic ? { critic: this.g.packed ? packCritic(critic[i]) : critic[i] } : {}),
        oppLabels: OBS.oppLabels(match, this.seats[i]),
      };
    }
    const winner = winnerSeat === null ? null : SIDES[winnerSeat];
    const info: Record<string, unknown> = {
      episode: this.episodeInfo(),
      winner, winType: st.terminated ? match.result?.winType ?? null : null,
      ticks: match.tick, terminated: st.terminated, truncated: st.truncated,
      stats: Object.fromEntries(SIDES.map((s, i) => [s, { ...this.seats[i].stats, illegal: this.illegal[i], botErrors: this.botErrors[i] }])),
    };
    if (this.cfg.save_replay || this.opts.onReplay) {
      const r = this.replay(winner);
      this.opts.onReplay?.(this.idx, r);
      if (this.cfg.save_replay) info.replayId = this.saveReplay(r);
    }
    engine.destroyMatch(match.id);
    const seats = this.start();
    return {
      seats, rewards, done: st.terminated, truncated: st.truncated, terminal, info,
      static: OBS.staticGrid(this.match), episode: this.episodeInfo(),
    };
  }
}

let GAME_VERSION = "unknown";
/** Version string written into saved replays (the stdio entry sets it from package.json). */
export function setGameVersion(v: string): void { GAME_VERSION = v; }

function slotConfig(raw: Record<string, unknown>, i: number): SlotConfig {
  const z = (raw.z ?? {}) as Partial<{ blue: number; red: number }>;
  const cfg: SlotConfig = {
    seed: Number(raw.seed ?? i + 1) >>> 0,
    map: String(raw.map ?? "shardfall"),
    blue: String(raw.blue ?? "policy"),
    red: String(raw.red ?? "bot:idle"),
    z: { blue: z.blue ?? 0, red: z.red ?? 0 },
    scenario: (raw.scenario ?? null) as null,
    save_replay: Boolean(raw.save_replay ?? false),
  };
  parseSeat(cfg.blue); parseSeat(cfg.red);
  return cfg;
}

export class VecRunnerV2 {
  private slots: Slot[] = [];
  private g: Globals = {
    k: V2.DECISION_TICKS, cap: TRAIN_MAX_TICKS, critic: true, packed: false, scoutSlot: false, scoutTeacher: false,
    scoutLock: true, switchCost: false, defenceTeacher: false,
  };
  constructor(private opts: RunnerOptions = {}) {}

  /** The live match of a slot (tests). */
  matchOf(i: number): MatchState { return this.slots[i].match; }

  handle(msg: Record<string, unknown>): Record<string, unknown> {
    try {
      switch (msg.type) {
        case "reset_all": {
          this.g = {
            k: Number(msg.decision_interval ?? V2.DECISION_TICKS),
            cap: Number(msg.max_ticks ?? TRAIN_MAX_TICKS),
            critic: msg.critic === undefined ? true : Boolean(msg.critic),
            packed: Boolean(msg.packed),
            scoutSlot: Boolean(msg.scout_slot),
            scoutTeacher: Boolean(msg.scout_teacher),
            scoutLock: msg.scout_lock === undefined ? true : Boolean(msg.scout_lock),
            switchCost: Boolean(msg.switch_cost),
            defenceTeacher: Boolean(msg.defence_teacher),
          };
          if (!(this.g.k >= 1)) throw new Error("decision_interval must be ≥ 1");
          const raw = (msg.slots ?? []) as Record<string, unknown>[];
          this.slots = raw.map((r, i) => new Slot(slotConfig(r, i), i, this.g, this.opts));
          const out = this.slots.map((s) => {
            const seats = s.start();
            return { seats, static: OBS.staticGrid(s.match), episode: s.episodeInfo() };
          });
          const lay = this.slots.find((s) => s.layout)?.layout;
          return { type: "ready", schemaVersion: OBS.OBS_SCHEMA_VERSION, actionSpaceVersion: V2.ACTION_SPACE_VERSION, slots: out, ...(lay ? { layout: lay } : {}) };
        }
        case "step": {
          const actions = (msg.actions ?? []) as Record<string, unknown>[];
          if (actions.length !== this.slots.length) throw new Error(`expected ${this.slots.length} action entries, got ${actions.length}`);
          return { type: "step_result", slots: this.slots.map((s, i) => s.step(actions[i])) };
        }
        case "configure": {
          for (const r of (msg.slots ?? []) as Record<string, unknown>[]) {
            const i = Number(r.index);
            const s = this.slots[i];
            if (!s) throw new Error(`configure: no slot ${r.index}`);
            const { index: _, ...rest } = r;
            const merged = slotConfig({ ...s.cfg, ...(s.pendingCfg ?? {}), ...rest }, i);
            const p: Partial<SlotConfig> = { ...(s.pendingCfg ?? {}) };
            for (const k of Object.keys(rest) as (keyof SlotConfig)[]) (p as Record<string, unknown>)[k] = merged[k];
            s.pendingCfg = p;
          }
          return { type: "configured" };
        }
        default:
          throw new Error(`unknown message type: ${String(msg.type)}`);
      }
    } catch (e) {
      return { type: "error", message: (e as Error).message };
    }
  }
}
