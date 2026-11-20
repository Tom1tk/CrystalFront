/** Beta Surges (mainline 0.10 plan §3); see SURGES in shared gameBalance. 0.9 matches stay at stage 0. */
import { CONTROL, SURGES, surgeStageAt } from "@crystalfront/shared";
import { isBeta, type MatchState } from "../types.js";

export function surgeStage(match: MatchState): 0 | 1 | 2 | 3 {
  return isBeta(match) ? surgeStageAt(match.tick) : 0;
}

/** Control progress gained (and drained) per tick of majority hold: 1 in 0.9, up to 4 at Surge III. */
export function controlStep(match: MatchState): number {
  return CONTROL.holdTicks / (SURGES.holdSeconds[surgeStage(match)] * 10);
}

/** Tick at which a beta match ends at the latest: 20:00, or a runner's shorter cap. */
export function betaCap(match: MatchState): number {
  const m = match.config.maxTicks ?? 0;
  return m > 0 ? Math.min(m, SURGES.capTicks) : SURGES.capTicks;
}
