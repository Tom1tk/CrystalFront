import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { MatchEngine } from "./matchEngine.js";
import { v09View } from "./neuralAdapter.js";

import { TRAIN_MAX_TICKS } from "../../../headless/src/episode.js";
import * as V2 from "../../../headless/src/v2/actions.js";
import * as OBS from "../../../headless/src/v2/observation.js";
import { loadModel, NeuralPolicy, readOpponent, type NeuralModel, type OpponentRead } from "../../../headless/src/v2/neural.js";

/** Neural opponents (G-10 M4): difficulty → model file prefix under models/. */
export const NEURAL_LEVELS = ["easy", "normal", "hard"] as const;
export type NeuralLevel = typeof NEURAL_LEVELS[number];

const models = new Map<NeuralLevel, NeuralModel>();

/** Load every difficulty's model (call once at startup; each is shared by all matches). */
export async function loadNeuralModels(): Promise<void> {
  for (const level of NEURAL_LEVELS) {
    const prefix = resolve(process.cwd(), "models", `policy-${level}`);
    if (!existsSync(`${prefix}.main.onnx`)) { console.warn(`[neural bot] no model for ${level} at ${prefix}`); continue; }
    try {
      models.set(level, await loadModel(prefix, `policy-${level}`));
    } catch (e) {
      console.error(`[neural bot] failed to load ${level}: ${(e as Error).message}`);
    }
  }
  console.log(`[neural bot] loaded: ${[...models.keys()].join(", ") || "none"}`);
}

/** The loaded model for a difficulty, or null. Bot names are "neural_<level>". */
export function neuralModelFor(botName: string): NeuralModel | null {
  const level = botName.startsWith("neural_") ? botName.slice(7) as NeuralLevel : null;
  return level ? models.get(level) ?? null : null;
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
  private staticGrid: number[] = [];
  private lastDecision = -Infinity;
  private pending = false;
  private failed = false;
  /** One entry per decision: the opponent model's read (always saved with the replay). */
  readonly reads: BotReadEntry[] = [];

  constructor(private model: NeuralModel, private botPlayerId: string, private matchId: string, private engine: MatchEngine) {}

  get latestRead(): BotReadEntry | null {
    return this.reads.length ? this.reads[this.reads.length - 1] : null;
  }

  /** Call each tick from the LiveMatchRunner's onTick. */
  tick(): void {
    const match = this.engine.getMatch(this.matchId);
    if (!match || match.phase !== "playing" || this.failed || this.pending) return;
    if (match.tick - this.lastDecision < V2.DECISION_TICKS) return;
    if (!this.seat) {
      this.seat = V2.createSeatState(match, this.botPlayerId);
      this.os = OBS.createObsState(match, this.seat);
      this.policy = new NeuralPolicy(this.model, (match.seed ^ 0x5eed) >>> 0);
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
}
