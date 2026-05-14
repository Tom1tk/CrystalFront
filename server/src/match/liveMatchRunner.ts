import { SIMULATION } from "@crystalfront/shared";
import type { MatchEngine } from "./matchEngine.js";

/**
 * Drives a MatchEngine with a wall-clock setInterval loop.
 * Keeping this separate from MatchEngine means the engine itself is
 * time-independent and can be stepped manually for headless training.
 */
export class LiveMatchRunner {
  private intervals = new Map<string, NodeJS.Timeout>();

  constructor(
    private engine: MatchEngine,
    private onTick: (matchId: string) => void
  ) {}

  start(matchId: string): void {
    if (this.intervals.has(matchId)) return;

    const match = this.engine.getMatch(matchId);
    if (!match) return;

    let subStepCount = 0;
    const subStepMs = SIMULATION.subStepMs;
    const fullTickMs = match.tickIntervalMs || 100;

    const interval = setInterval(() => {
      const m = this.engine.getMatch(matchId);
      if (!m || m.phase !== "playing") {
        this.stop(matchId);
        return;
      }

      subStepCount++;
      if (subStepCount % (fullTickMs / subStepMs) === 0) {
        this.engine.tick(matchId);
        this.onTick(matchId);
      } else {
        this.engine.subStepMovement(matchId);
      }
    }, subStepMs);

    this.intervals.set(matchId, interval);
  }

  stop(matchId: string): void {
    const interval = this.intervals.get(matchId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(matchId);
    }
  }

  stopAll(): void {
    for (const matchId of [...this.intervals.keys()]) {
      this.stop(matchId);
    }
  }
}
