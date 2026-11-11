// P-4 (M0 T4): truncation at the tick cap.
//
// At the cap the engine still names a tiebreak winner (winType "timeout"), which
// the live game and runMatch keep. For training, an episode that hit the cap is
// *truncated*, not terminated: the trainer must not treat it as a win or loss
// and bootstraps the value from the final observation instead. In evaluation a
// truncated game counts as a draw.
import type { MatchState } from "../../server/src/match/types.js";

/** Training tick cap (live play stays uncapped: maxTicks 0). */
export const TRAIN_MAX_TICKS = 12000;

export interface EpisodeStatus {
  /** Ended by the rules (combat, control or forfeit): a real win or loss. */
  terminated: boolean;
  /** Stopped by the tick cap: neither a win nor a loss. */
  truncated: boolean;
}

/**
 * Classify a match after a tick. `cap` is the runner's tick cap; it also covers
 * a runner that stops at the cap without the engine's tiebreak (config maxTicks 0).
 */
export function episodeStatus(match: MatchState, cap: number): EpisodeStatus {
  if (match.phase === "ended") {
    const timeout = match.result?.winType === "timeout";
    return { terminated: !timeout, truncated: timeout };
  }
  return { terminated: false, truncated: cap > 0 && match.tick >= cap };
}

/** Evaluation score for `playerId`: 1 win, 0 loss, 0.5 for a truncated game. */
export function evalScore(winner: string | null, truncated: boolean, playerId: string): number {
  if (truncated || winner === null) return 0.5;
  return winner === playerId ? 1 : 0;
}
