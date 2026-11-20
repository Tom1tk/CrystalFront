// G-10 M4: the trained v2 policy in TypeScript (ONNX Runtime, CPU).
//
// training/v2/export_onnx.py writes two graphs per model:
//   <prefix>.main.onnx  observation + LSTM state → new state, opponent-model
//                       probabilities, and every head's logits for every choice it
//                       can be conditioned on (sites per building, orders per group, …)
//   <prefix>.tail.onnx  heads' input, entity embeddings, chosen order and unit →
//                       target and pointer logits (they depend on the chosen unit)
// Sampling happens here and mirrors training/v2/model.py `Agent.policy` /
// `masked_choice`: each head samples from its masked logits; a head that does
// not apply to the choices before it, or whose mask is empty, plays 0.
import * as ort from "onnxruntime-node";
import { readFileSync } from "node:fs";
import { Rng } from "../../../server/src/match/engine/rng.js";
import {
  BUILDINGS, ECON_ASSIGN0, ECON_BUILD0, ECON_RALLY, ECON_REPAIR, GROUPS, ORDERS, POINT_ORDERS, PTR_ORDERS, PTR_SIZE,
  TRAIN_UNITS, N_ANCHOR_TARGETS, ANCHOR_TARGETS, NOOP_ACTION, type V2Action, type V2Masks,
} from "./actions.js";
import { ENTITY_F, type ObsV2 } from "./observation.js";

const N_GLOBALS = 61, NODE_ROWS = 20, NODE_F = 13, MEM_ROWS = 16, MEM_F = 15, GRID_C = 10, GRID_R = 15, GRID_W = 50;
const OPP_BINS = 6;
const GROUP_UNIT = GROUPS.indexOf("unit");
const POINT = new Set([...POINT_ORDERS].map((o) => ORDERS.indexOf(o as typeof ORDERS[number])));
const PTRO = new Set([...PTR_ORDERS].map((o) => ORDERS.indexOf(o as typeof ORDERS[number])));

export interface NeuralModel {
  name: string;
  main: ort.InferenceSession;
  tail: ort.InferenceSession;
  hidden: number;
  nOpp: number;
}

/** Load `<prefix>.main.onnx`, `<prefix>.tail.onnx` and `<prefix>.json`. One model serves any number of matches. */
export async function loadModel(prefix: string, name = prefix): Promise<NeuralModel> {
  const meta = JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as { hidden: number; nOpp: number };
  const opts: ort.InferenceSession.SessionOptions = { intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: "all" };
  const [main, tail] = await Promise.all([
    ort.InferenceSession.create(`${prefix}.main.onnx`, opts), ort.InferenceSession.create(`${prefix}.tail.onnx`, opts),
  ]);
  return { name, main, tail, hidden: meta.hidden, nOpp: meta.nOpp };
}

export interface Decision {
  action: V2Action;
  /** Opponent-model probabilities (per-group softmax, model layout). */
  opp: Float32Array;
  /** Each head's log-probability of its choice (0 when the head was inactive). */
  logp: Record<string, number>;
}

/** Index of a choice sampled from logits restricted to `mask`, and its log-probability; null when nothing is allowed. */
function choose(logits: Float32Array, off: number, n: number, mask: (i: number) => boolean, u: number | null): [number, number] | null {
  let mx = -Infinity;
  for (let i = 0; i < n; i++) if (mask(i) && logits[off + i] > mx) mx = logits[off + i];
  if (mx === -Infinity) return null;
  let z = 0;
  for (let i = 0; i < n; i++) if (mask(i)) z += Math.exp(logits[off + i] - mx);
  let a = -1;
  if (u === null) { // greedy
    for (let i = 0; i < n; i++) if (mask(i) && logits[off + i] === mx) { a = i; break; }
  } else {
    let r = u * z;
    for (let i = 0; i < n; i++) {
      if (!mask(i)) continue;
      a = i;
      r -= Math.exp(logits[off + i] - mx);
      if (r <= 0) break;
    }
  }
  return [a, logits[off + a] - mx - Math.log(z)];
}

/** One seat's policy: the model plus this match's LSTM state and sampling stream. */
export class NeuralPolicy {
  private h: Float32Array;
  private c: Float32Array;
  private rng: Rng;
  constructor(readonly model: NeuralModel, seed: number, private greedy = false) {
    this.h = new Float32Array(model.hidden);
    this.c = new Float32Array(model.hidden);
    this.rng = new Rng(seed >>> 0);
  }

  /** The policy's decision for this observation. `staticGrid` is OBS.staticGrid(match).data. Advances the LSTM state. */
  async decide(obs: ObsV2, staticGrid: readonly number[], m: V2Masks): Promise<Decision> {
    const n = Math.min(obs.entities.length, PTR_SIZE);
    const ent = new Float32Array(PTR_SIZE * ENTITY_F);
    for (let i = 0; i < n; i++) ent.set(obs.entities[i], i * ENTITY_F);
    const grid = new Float32Array(GRID_C * GRID_R * GRID_W);
    grid.set(obs.grid, 0);
    grid.set(staticGrid, obs.grid.length);
    const T = ort.Tensor;
    const feeds: Record<string, ort.Tensor> = {
      globals: new T("float32", Float32Array.from(obs.globals), [1, N_GLOBALS]),
      z: new T("int64", BigInt64Array.from([BigInt(obs.z)]), [1]),
      ent: new T("float32", ent, [1, PTR_SIZE, ENTITY_F]),
      ent_n: new T("int64", BigInt64Array.from([BigInt(n)]), [1]),
      nodes: new T("float32", Float32Array.from(obs.nodes.flat()), [1, NODE_ROWS, NODE_F]),
      memory: new T("float32", Float32Array.from(obs.memory.flat()), [1, MEM_ROWS, MEM_F]),
      grid: new T("float32", grid, [1, GRID_C, GRID_R, GRID_W]),
      h0: new T("float32", this.h, [1, this.model.hidden]),
      c0: new T("float32", this.c, [1, this.model.hidden]),
    };
    const o = await this.model.main.run(feeds);
    const f = (k: string) => o[k].data as Float32Array;
    this.h = Float32Array.from(f("h1"));
    this.c = Float32Array.from(f("c1"));

    const a: V2Action = { ...NOOP_ACTION };
    const logp: Record<string, number> = {};
    const u = () => (this.greedy ? null : this.rng.random());
    const row = (ok: boolean[]) => (i: number) => ok[i] === true;
    const ptrRow = (ok: boolean[]) => (i: number) => i < n && ok[i] === true;
    const pick = (key: string, logits: Float32Array, off: number, size: number, mask: (i: number) => boolean): number => {
      const r = choose(logits, off, size, mask, u());
      logp[key] = r ? r[1] : 0;
      return r ? r[0] : 0;
    };

    // Economy
    const ec = f("econ");
    a.econ = pick("econ", ec, 0, ec.length, row(m.econ));
    if (a.econ >= ECON_BUILD0 && a.econ < ECON_ASSIGN0) {
      const bi = a.econ - ECON_BUILD0, sz = m.site[bi].length;
      a.site = pick("site", f("site"), bi * sz, sz, row(m.site[bi]));
    }
    if (a.econ >= ECON_REPAIR) {
      const ki = a.econ - ECON_REPAIR;
      a.econPtr = pick("econPtr", f("econPtr"), ki * PTR_SIZE, PTR_SIZE, ptrRow(m.econPtr[ki]));
    }
    if (a.econ === ECON_RALLY) a.econTarget = pick("econTarget", f("econTarget"), 0, m.econTarget.length, row(m.econTarget));
    // Army
    a.group = pick("group", f("group"), 0, GROUPS.length, row(m.group));
    a.order = pick("order", f("order"), a.group * ORDERS.length, ORDERS.length, row(m.order[a.group]));
    let unitOn = 0;
    if (a.group === GROUP_UNIT) {
      const r = choose(f("unit"), a.order * PTR_SIZE, PTR_SIZE, ptrRow(m.unit[a.order]), u());
      logp.unit = r ? r[1] : 0;
      if (r) { a.unit = r[0]; unitOn = 1; }
    }
    const isPoint = POINT.has(a.order), isPtr = PTRO.has(a.order);
    if (isPoint || isPtr) {
      const t = await this.model.tail.run({
        hh: o.hh, E: o.E,
        order: new T("int64", BigInt64Array.from([BigInt(a.order)]), [1]),
        unit: new T("int64", BigInt64Array.from([BigInt(a.unit)]), [1]),
        unit_on: new T("float32", Float32Array.from([unitOn]), [1]),
      });
      if (isPoint) a.target = pick("target", t.target.data as Float32Array, 0, m.target[a.order].length, row(m.target[a.order]));
      else a.ptr = pick("ptr", t.ptr.data as Float32Array, 0, PTR_SIZE, ptrRow(m.ptr[a.order]));
    }
    return { action: a, opp: Float32Array.from(f("opp")), logp };
  }
}

// ---- The bot's read of its opponent (opponent-model output, for the UI) ----

const BIN_VALUE = [0, 1, 2, 3.5, 6.5, 10]; // bins 0, 1, 2, 3-4, 5-8, 9+

export interface OpponentRead {
  /** Expected enemy count per unit type (from the bot's predicted bins). */
  units: Record<string, number>;
  buildings: Record<string, number>;
  /** Where the bot thinks the enemy army is, from the bot's point of view ("own_base" = the bot's base), with its probability. */
  army: { anchor: string; p: number };
}

/** Anchor target index → name, e.g. "own_chokes[1]", "none". */
export function anchorName(i: number): string {
  if (i >= N_ANCHOR_TARGETS) return "none";
  for (const [name, k] of ANCHOR_TARGETS) {
    if (i < k) return k === 1 ? name : `${name}[${i}]`;
    i -= k;
  }
  return "none";
}

export function readOpponent(opp: Float32Array): OpponentRead {
  const groups = [...TRAIN_UNITS, ...BUILDINGS];
  const exp = groups.map((_, g) => BIN_VALUE.reduce((s, v, b) => s + v * opp[g * OPP_BINS + b], 0));
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const off = groups.length * OPP_BINS;
  let best = 0;
  for (let i = 1; i <= N_ANCHOR_TARGETS; i++) if (opp[off + i] > opp[off + best]) best = i;
  return {
    units: Object.fromEntries(TRAIN_UNITS.map((t, i) => [t, r1(exp[i])])),
    buildings: Object.fromEntries(BUILDINGS.map((t, i) => [t, r1(exp[TRAIN_UNITS.length + i])])),
    army: { anchor: anchorName(best), p: Math.round(opp[off + best] * 100) / 100 },
  };
}
