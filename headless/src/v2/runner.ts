// G-10 M0 T7 (P-2): two-seat vectorised runner, protocol v2.
//
// The protocol logic lives here, in-process (`VecRunnerV2.handle`), so tests can
// drive it without a pipe; `vecRunner.ts` wires it to stdin/stdout.
//
// Python → Node (newline-delimited JSON)
//   { type: "reset_all", decision_interval?: 8, max_ticks?: 12000, critic?: true,
//     slots: [ { seed, map, blue, red, z?: {blue, red}, scenario?: null, save_replay?: false } ] }
//       blue/red: "policy" | "bot:<name>" | "teach:<name>"
//   { type: "step", actions: [ { blue?: {econ, army: [group, order, target]}, red?: … } ] }
//       one entry per slot; only "policy" seats need an action
//   { type: "configure", slots: [ { index, …any slot field } ] }
//       applied at that slot's next (auto)reset; a new seed restarts its seed sequence
//   { type: "close" }
//
// Node → Python
//   { type: "ready", schemaVersion, slots: [ { seats, static, episode: {…} } ] }
//   { type: "step_result", slots: [ { seats, rewards, done, truncated, terminal, info, static?, episode? } ] }
//   { type: "configured" } | { type: "error", message }
//
// Per decision and slot: worker autopilot (both seats) → observe → masks → bot
// and teacher choices; then the step applies both seats' actions together
// (applyV2Pair, no first-mover edge) and runs `decision_interval` ticks.
// `seats` holds one entry per policy or teach seat: { obs, masks, critic?,
// oppLabels, teacher }. `teacher` is the bot's action chosen from that same obs.
// `rewards` (per policy/teach seat) covers the window just played: raw
// components, see rewards.ts. On done or truncation `terminal` holds the final
// { obs, critic, oppLabels } per policy/teach seat and the slot is autoreset:
// `seats` is then the new episode's first decision, and `static` / `episode`
// describe it. Slot settings persist across autoresets.
import { MatchEngine } from "../../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type MatchState, type PlayerSlot } from "../../../server/src/match/types.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_VERSION } from "@crystalfront/shared";
import { episodeStatus, TRAIN_MAX_TICKS } from "../episode.js";
import * as V2 from "./actions.js";
import * as OBS from "./observation.js";
import { makeV2Bot, type V2Bot } from "./bots.js";
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
export function encodeMasks(m: V2.V2Masks) {
  return { econ: bit(m.econ), group: bit(m.group), order: m.order.map(bit), target: m.target.map(bit) };
}

export interface WireAction { econ: number; army: [number, number, number] }
const toWire = (a: V2.V2Action): WireAction => ({ econ: a.econ, army: [a.group, a.order, a.target] });

function fromWire(w: unknown): V2.V2Action | null {
  const a = w as WireAction | undefined;
  if (!a || !Number.isInteger(a.econ) || !Array.isArray(a.army) || a.army.length !== 3 || !a.army.every(Number.isInteger)) return null;
  return { econ: a.econ, group: a.army[0], order: a.army[1], target: a.army[2] };
}

export interface RunnerOptions {
  /** Test hook: called after every engine tick. */
  onTick?: (slot: number, match: MatchState) => void;
}

interface Globals { k: number; cap: number; critic: boolean }

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
  chosen: [V2.V2Action | null, V2.V2Action | null] = [null, null];
  snap!: RewardSnapshot;
  log: Array<{ tick: number; playerId: string; command: Record<string, unknown> }> = [];
  illegal: [number, number] = [0, 0];
  episodeSeed = 0;

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
    this.match = this.engine.createMatch(`v2-${this.idx}-${this.episodes}`, players, { ...DEFAULT_CONFIG, mapId: cfg.map, maxTicks: this.g.cap }, this.episodeSeed);
    this.engine.startMatch(this.match.id);
    this.seats = [V2.createSeatState(this.match, PLAYER_IDS[0]), V2.createSeatState(this.match, PLAYER_IDS[1])];
    this.oss = [OBS.createObsState(this.match, this.seats[0]), OBS.createObsState(this.match, this.seats[1])];
    // Bot seeds come from the episode seed and the bot's name, never the seat:
    // the same seed with seats swapped then plays the mirrored game.
    this.bots = this.specs.map((s) => (s.bot ? makeV2Bot(s.bot, mixSeed(this.episodeSeed, strSeed(s.bot))) : null)) as [V2Bot | null, V2Bot | null];
    this.log = [];
    this.illegal = [0, 0];
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
      for (const c of V2.workerAutopilot(engine, match, s)) this.log.push({ tick: match.tick, playerId: s.playerId, command: c });
    }
    const out: Record<string, unknown> = {};
    const critic = this.g.critic && this.learnerSides().length ? this.critic() : null;
    for (const i of [0, 1] as const) {
      const obs = OBS.observe(match, this.seats[i], this.oss[i], { z: this.cfg.z[SIDES[i]], cap: this.g.cap });
      this.masks[i] = V2.computeMasks(match, this.seats[i]);
      this.chosen[i] = this.bots[i] ? this.bots[i]!.decide(obs, this.masks[i]) : null;
      if (this.specs[i].kind === "bot") continue;
      out[SIDES[i]] = {
        obs, masks: encodeMasks(this.masks[i]),
        ...(critic ? { critic: critic[i] } : {}),
        oppLabels: OBS.oppLabels(match, this.seats[i]),
        teacher: this.specs[i].kind === "teach" ? toWire(this.chosen[i]!) : null,
      };
    }
    this.snap = rewardSnapshot(match);
    return out;
  }

  /** Fog-free blocks for both seats, each in its own frame (computed once, swapped for seat 1). */
  private critic(): [OBS.CriticV2, OBS.CriticV2] {
    const c0 = OBS.criticState(this.match, this.seats[0], this.oss[0], this.seats[1], this.oss[1], this.g.cap);
    return [c0, { self: c0.enemy, enemy: c0.self }];
  }

  /**
   * Write the episode as a replay in the server's format (replayRunner.saveReplay,
   * not imported: it pulls in the websocket server) under <cwd>/replays.
   */
  private saveReplay(winner: Side | null): string {
    const m = this.match, dir = resolve(process.cwd(), "replays");
    mkdirSync(dir, { recursive: true });
    const id = `${Date.now()}-v2-${this.idx}-${this.episodes - 1}`;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, seed: m.seed, blue: this.cfg.blue, red: this.cfg.red, bluePlayerId: PLAYER_IDS[0], redPlayerId: PLAYER_IDS[1],
      version: GAME_VERSION, engineVersion: ENGINE_VERSION, mapId: this.cfg.map, mapVersion: m.terrain.mapVersion, timestamp: Date.now(),
      outcome: { winner, winnerName: winner === null ? null : this.cfg[winner], winType: m.result?.winType ?? null, ticks: m.tick },
      commandLog: this.log,
    }));
    return id;
  }

  episodeInfo() {
    return { index: this.episodes - 1, seed: this.episodeSeed, map: this.cfg.map, blue: this.cfg.blue, red: this.cfg.red, z: { ...this.cfg.z } };
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
    const res = V2.applyV2Pair(engine, match, this.seats, [acts[0], acts[1]]);
    res.forEach((r, i) => { for (const c of r.accepted) this.log.push({ tick: match.tick, playerId: PLAYER_IDS[i], command: c }); });
    let st = episodeStatus(match, this.g.cap);
    for (let t = 0; t < this.g.k && !st.terminated && !st.truncated; t++) {
      engine.tick(match.id);
      this.opts.onTick?.(this.idx, match);
      st = episodeStatus(match, this.g.cap);
    }
    const winnerSeat = st.terminated && match.result ? (match.result.winner === PLAYER_IDS[0] ? 0 : match.result.winner === PLAYER_IDS[1] ? 1 : null) : null;
    const rw = windowRewards(match, this.snap, winnerSeat);
    const rewards: Record<string, SeatRewards> = {};
    for (const i of this.learnerSides()) rewards[SIDES[i]] = rw[i];

    if (!st.terminated && !st.truncated) {
      return { seats: this.prepare(), rewards, done: false, truncated: false, terminal: null, info: {} };
    }

    // Episode over: final observations, info, replay, then autoreset.
    const terminal: Record<string, unknown> = {};
    const critic = this.g.critic ? this.critic() : null;
    for (const i of this.learnerSides()) {
      terminal[SIDES[i]] = {
        obs: OBS.observe(match, this.seats[i], this.oss[i], { z: this.cfg.z[SIDES[i]], cap: this.g.cap }),
        ...(critic ? { critic: critic[i] } : {}),
        oppLabels: OBS.oppLabels(match, this.seats[i]),
      };
    }
    const winner = winnerSeat === null ? null : SIDES[winnerSeat];
    const info: Record<string, unknown> = {
      episode: this.episodeInfo(),
      winner, winType: st.terminated ? match.result?.winType ?? null : null,
      ticks: match.tick, terminated: st.terminated, truncated: st.truncated,
      stats: Object.fromEntries(SIDES.map((s, i) => [s, { ...this.seats[i].stats, illegal: this.illegal[i] }])),
    };
    if (this.cfg.save_replay) info.replayId = this.saveReplay(winner);
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
  private g: Globals = { k: V2.DECISION_TICKS, cap: TRAIN_MAX_TICKS, critic: true };
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
          };
          if (!(this.g.k >= 1)) throw new Error("decision_interval must be ≥ 1");
          const raw = (msg.slots ?? []) as Record<string, unknown>[];
          this.slots = raw.map((r, i) => new Slot(slotConfig(r, i), i, this.g, this.opts));
          const out = this.slots.map((s) => {
            const seats = s.start();
            return { seats, static: OBS.staticGrid(s.match), episode: s.episodeInfo() };
          });
          return { type: "ready", schemaVersion: OBS.OBS_SCHEMA_VERSION, slots: out };
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
