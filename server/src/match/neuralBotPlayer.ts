import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { MatchEngine } from "./matchEngine.js";
import { v09View } from "./neuralAdapter.js";

import { TRAIN_MAX_TICKS } from "../../../headless/src/episode.js";
import * as V2 from "../../../headless/src/v2/actions.js";
import * as OBS from "../../../headless/src/v2/observation.js";
import { loadModel, NeuralPolicy, readOpponent, type NeuralModel, type OpponentRead } from "../../../headless/src/v2/neural.js";
// The beta bots (mainline 0.10): their own frozen copy, with the Outrider and Surges in the layout.
import * as V3 from "../../../headless/src/v3/actions.js";
import * as OBS3 from "../../../headless/src/v3/observation.js";
import * as N3 from "../../../headless/src/v3/neural.js";
// Rebuild R1/R2 models (observation schema 8, action space 10); none is shipped yet.
import * as V4 from "../../../headless/src/v4/actions.js";
import * as OBS4 from "../../../headless/src/v4/observation.js";
import * as N4 from "../../../headless/src/v4/neural.js";

/** The beta layouts' code; v4 has the same interface as v3 with larger blocks. */
const BETA = { v3: { A: V3, O: OBS3, N: N3 }, v4: { A: V4, O: OBS4, N: N4 } as unknown as { A: typeof V3; O: typeof OBS3; N: typeof N3 } };

/** Neural opponents (G-10 M4): difficulty → model file prefix under models/ (0.9) and models/beta/. */
export const NEURAL_LEVELS = ["easy", "normal", "hard"] as const;
export type NeuralLevel = typeof NEURAL_LEVELS[number];

/** A loaded model and the code that drives it: "v2" = the 0.9 bots, "v3" / "v4" = the beta bots. */
export interface LoadedModel { model: NeuralModel | N3.NeuralModel; layout: "v2" | "v3" | "v4"; checkpoint: string }

const models = new Map<NeuralLevel, LoadedModel>();
const betaModels = new Map<NeuralLevel, LoadedModel>();

/** Load every difficulty's model (call once at startup; each is shared by all matches). */
export async function loadNeuralModels(root = process.cwd()): Promise<void> {
  for (const [dir, into, layout] of [["models", models, "v2"], ["models/beta", betaModels, "v3"]] as const) {
    for (const level of NEURAL_LEVELS) {
      const prefix = resolve(root, dir, `policy-${level}`);
      if (!existsSync(`${prefix}.main.onnx`)) { console.warn(`[neural bot] no model for ${level} at ${prefix}`); continue; }
      try {
        const meta = JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as { layout?: string; checkpoint?: string };
        const got = meta.layout ?? "v2";
        if (got !== layout && !(layout === "v3" && got === "v4")) throw new Error(`layout ${got}, expected ${layout}`);
        const name = `${dir}/policy-${level}`;
        const model = got === "v2" ? await loadModel(prefix, name) : await BETA[got as "v3" | "v4"].N.loadModel(prefix, name);
        into.set(level, { model, layout: got as LoadedModel["layout"], checkpoint: meta.checkpoint ?? "" });
      } catch (e) {
        console.error(`[neural bot] failed to load ${dir}/${level}: ${(e as Error).message}`);
      }
    }
  }
  console.log(`[neural bot] loaded 0.9: ${[...models.keys()].join(", ") || "none"}; beta: ${[...betaModels.keys()].join(", ") || "none"}`);
}

/**
 * The model for a bot name, or null. "neural_<level>" is the beta model in a beta match (the 0.9
 * model through the adapter when there is no beta one) and the 0.9 model otherwise;
 * "neural09_<level>" is always the 0.9 model and "neuralb_<level>" always the beta one (tournaments).
 */
export function neuralModelFor(botName: string, ruleset?: string): LoadedModel | null {
  const m = /^neural(09|b)?_(easy|normal|hard)$/.exec(botName);
  if (!m) return null;
  const level = m[2] as NeuralLevel;
  if (m[1] === "09") return models.get(level) ?? null;
  if (m[1] === "b") return betaModels.get(level) ?? null;
  return (ruleset === "beta" ? betaModels.get(level) : undefined) ?? models.get(level) ?? null;
}

/** The beta models' checkpoints, e.g. { hard: "b1-main/cycle_2" } (for names). */
export function betaNeuralCheckpoints(): Partial<Record<NeuralLevel, string>> {
  return Object.fromEntries([...betaModels].map(([l, m]) => [l, m.checkpoint.replace(/^.*checkpoints\/v2\//, "").replace(/\.pt$/, "")]));
}

/** What the bot believed about its opponent at one decision (kept for the replay). */
export interface BotReadEntry extends OpponentRead { tick: number }

/**
 * Drives the trained v2 policy in a live match, as in training: every
 * DECISION_TICKS ticks the worker autopilot runs, the bot observes and the
 * policy picks one economy and one army action. Inference is asynchronous, so
 * the action is applied when it returns (normally well before the next tick),
 * through processCommand like a human's commands, and the replay's command log
 * records it at that tick.
 */
export class NeuralBotPlayer {
  private seat: V2.SeatState | null = null;
  private os: OBS.ObsState | null = null;
  private policy: NeuralPolicy | null = null;
  private seat3: V3.SeatState | null = null;
  private os3: OBS3.ObsState | null = null;
  private policy3: N3.NeuralPolicy | null = null;
  private staticGrid: number[] = [];
  private lastDecision = -Infinity;
  private pending = false;
  private failed = false;
  /** One entry per decision: the opponent model's read (always saved with the replay). */
  readonly reads: BotReadEntry[] = [];

  constructor(private loaded: LoadedModel, private botPlayerId: string, private matchId: string, private engine: MatchEngine) {}

  get latestRead(): BotReadEntry | null {
    return this.reads.length ? this.reads[this.reads.length - 1] : null;
  }

  /** Call each tick from the LiveMatchRunner's onTick. */
  tick(): void {
    const match = this.engine.getMatch(this.matchId);
    if (!match || match.phase !== "playing" || this.failed || this.pending) return;
    if (match.tick - this.lastDecision < V2.DECISION_TICKS) return;
    if (this.loaded.layout !== "v2") { this.tickBeta(match); return; }
    if (!this.seat) {
      this.seat = V2.createSeatState(match, this.botPlayerId);
      this.os = OBS.createObsState(match, this.seat);
      this.policy = new NeuralPolicy(this.loaded.model as NeuralModel, (match.seed ^ 0x5eed) >>> 0);
      this.staticGrid = OBS.staticGrid(match).data;
    }
    const seat = this.seat, tick = match.tick;
    this.lastDecision = tick;
    V2.workerAutopilot(this.engine, match, seat);
    // Beta matches: the bot sees them as 0.9 would show them (neuralAdapter.ts).
    const view = v09View(match, this.botPlayerId);
    const obs = OBS.observe(view, seat, this.os!, { z: 0, cap: TRAIN_MAX_TICKS });
    const masks = V2.computeMasks(view, seat);
    this.pending = true;
    this.policy!.decide(obs, this.staticGrid, masks).then((d) => {
      this.pending = false;
      const m = this.engine.getMatch(this.matchId);
      if (!m || m.phase !== "playing") return;
      V2.applyV2(this.engine, m, seat, V2.isLegal(masks, d.action) ? d.action : { ...V2.NOOP_ACTION });
      this.reads.push({ tick, ...readOpponent(d.opp) });
    }).catch((e) => {
      this.pending = false;
      this.failed = true;
      console.error(`[neural bot] match ${this.matchId}: ${(e as Error).stack ?? e}`);
    });
  }

  /** The beta bot: the v3 / v4 layouts see beta matches as they are, so there is no adapter. */
  private tickBeta(match: NonNullable<ReturnType<MatchEngine["getMatch"]>>): void {
    const { A, O, N } = BETA[this.loaded.layout as "v3" | "v4"];
    if (!this.seat3) {
      this.seat3 = A.createSeatState(match, this.botPlayerId);
      this.os3 = O.createObsState(match, this.seat3);
      this.policy3 = new N.NeuralPolicy(this.loaded.model as N3.NeuralModel, (match.seed ^ 0x5eed) >>> 0);
      this.staticGrid = O.staticGrid(match).data;
    }
    const seat = this.seat3, tick = match.tick;
    this.lastDecision = tick;
    A.workerAutopilot(this.engine, match, seat);
    const obs = O.observe(match, seat, this.os3!, { z: 0, cap: TRAIN_MAX_TICKS });
    const masks = A.computeMasks(match, seat, { scoutSlot: this.policy3!.model.scoutSlot });
    this.pending = true;
    this.policy3!.decide(obs, this.staticGrid, masks).then((d) => {
      this.pending = false;
      const m = this.engine.getMatch(this.matchId);
      if (!m || m.phase !== "playing") return;
      A.applyV2(this.engine, m, seat, A.isLegal(masks, d.action) ? d.action : { ...A.NOOP_ACTION });
      this.reads.push({ tick, ...N.readOpponent(d.opp) });
    }).catch((e) => {
      this.pending = false;
      this.failed = true;
      console.error(`[neural bot] match ${this.matchId}: ${(e as Error).stack ?? e}`);
    });
  }
}
