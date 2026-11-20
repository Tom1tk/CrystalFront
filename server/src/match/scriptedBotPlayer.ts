import type { MatchEngine } from "./matchEngine.js";
import { TRAIN_MAX_TICKS } from "../../../headless/src/episode.js";
import * as V3 from "../../../headless/src/v3/actions.js";
import * as OBS from "../../../headless/src/v3/observation.js";
import { makeV2Bot, type V2Bot } from "../../../headless/src/v3/bots.js";
import { SCRIPTED, botContext } from "../../../headless/src/v3/scripted.js";

/** Menu name of a beta scripted bot: "v3_<name>" (mainline 0.10 plan §2a). */
export const SCRIPTED_PREFIX = "v3_";

/** The v3 scripted bot a menu name refers to, or null. */
export function scriptedBotFor(botName: string): string | null {
  if (!botName.startsWith(SCRIPTED_PREFIX)) return null;
  const name = botName.slice(SCRIPTED_PREFIX.length);
  return Object.hasOwn(SCRIPTED, name) ? name : null;
}

/**
 * Drives a v3 scripted bot (the beta "Scripted" list) in a live match, exactly as in training:
 * every DECISION_TICKS ticks the worker autopilot runs, the bot observes its fogged view and
 * picks one economy and one army action, applied through processCommand.
 */
export class ScriptedBotPlayer {
  private seat: V3.SeatState | null = null;
  private os: OBS.ObsState | null = null;
  private bot: V2Bot | null = null;
  private lastDecision = -Infinity;

  constructor(private botName: string, private botPlayerId: string, private matchId: string, private engine: MatchEngine) {}

  /** Call each tick from the LiveMatchRunner's onTick. */
  tick(): void {
    const match = this.engine.getMatch(this.matchId);
    if (!match || match.phase !== "playing") return;
    if (match.tick - this.lastDecision < V3.DECISION_TICKS) return;
    if (!this.seat) {
      this.seat = V3.createSeatState(match, this.botPlayerId);
      this.os = OBS.createObsState(match, this.seat);
      this.bot = makeV2Bot(this.botName, (match.seed ^ 0x5c1d) >>> 0, botContext(match, this.seat, TRAIN_MAX_TICKS));
    }
    this.lastDecision = match.tick;
    V3.workerAutopilot(this.engine, match, this.seat);
    const obs = OBS.observe(match, this.seat, this.os!, { z: this.bot!.z ?? 0, cap: TRAIN_MAX_TICKS });
    const masks = V3.computeMasks(match, this.seat);
    const a = this.bot!.decide(obs, masks);
    V3.applyV2(this.engine, match, this.seat, V3.isLegal(masks, a) ? a : { ...V3.NOOP_ACTION });
  }
}
