/**
 * Shared reward module — single source of truth for computeReward.
 * Imported by both stdioRunner.ts and stdioVecRunner.ts to prevent drift.
 *
 * Reward components (9 total):
 *   +0.05 × crystal healthFrac delta dealt   (continuous)
 *   -0.02 × crystal healthFrac delta taken   (continuous)
 *   +0.10 one-time first barracks built
 *   +0.05  one-time first combat unit trained   (bootstrap shaping)
 *   +0.03  one-time second combat unit trained  (bootstrap shaping)
 *   +0.02  one-time third combat unit trained   (bootstrap shaping — needed for rush_medium)
 *   +0.01  one-time fourth combat unit trained  (bootstrap shaping — needed for rush_medium)
 *   -0.00001/tick time penalty
 *   ±1.0 terminal (win/loss)
 */

import type { PlayerObservation } from "./types.js";

export interface Milestones {
  hasBuiltBarracks: boolean;
  firstBarracksTick: number;
  hasTrainedCombatUnit: boolean;
  firstCombatUnitTick: number;
  hasTrainedSecondCombatUnit: boolean;
  hasTrainedThirdCombatUnit: boolean;
  hasTrainedFourthCombatUnit: boolean;
  firstAttackTick: number;
  minOppCrystalHealthFrac: number;
  minOwnCrystalHealthFrac: number;
}

export function freshMilestones(): Milestones {
  return {
    hasBuiltBarracks: false,
    firstBarracksTick: -1,
    hasTrainedCombatUnit: false,
    firstCombatUnitTick: -1,
    hasTrainedSecondCombatUnit: false,
    hasTrainedThirdCombatUnit: false,
    hasTrainedFourthCombatUnit: false,
    firstAttackTick: -1,
    minOppCrystalHealthFrac: 1.0,
    minOwnCrystalHealthFrac: 1.0,
  };
}

export interface RewardResult {
  reward: number;
  terminalReturn: number;  // 0 unless done; ±1.0 on terminal tick
  shapingReturn: number;   // shaping component only (excl. terminal)
}

export function computeReward(
  prev: PlayerObservation,
  curr: PlayerObservation,
  done: boolean,
  winner: string | null,
  winType: string | null,
  milestones: Milestones,
  blueId: string,
): RewardResult {
  let r = 0;

  // Crystal damage dealt (+0.05 per full crystal HP lost)
  // Both prev and curr must be > 0 to avoid false rewards from visibility changes.
  if (prev.global.oppCrystalHealthFrac > 0 && curr.global.oppCrystalHealthFrac > 0) {
    const delta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (delta > 0) r += 0.05 * delta;
  }

  // Crystal damage taken (-0.02 per full crystal HP lost)
  const ownDelta = prev.global.ownCrystalHealthFrac - curr.global.ownCrystalHealthFrac;
  if (ownDelta > 0) r -= 0.02 * ownDelta;

  // First barracks built (+0.10 one-time)
  if (!milestones.hasBuiltBarracks) {
    const hadBarracks = prev.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const hasBarracks = curr.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    if (!hadBarracks && hasBarracks) {
      r += 0.10;
      milestones.hasBuiltBarracks = true;
      milestones.firstBarracksTick = curr.tick;
    }
  }

  // Combat units trained — one-time bootstrap shaping (0.05/0.03/0.02/0.01 for units 1/2/3/4)
  const allUnitMilestonesFired = milestones.hasTrainedCombatUnit &&
    milestones.hasTrainedSecondCombatUnit &&
    milestones.hasTrainedThirdCombatUnit &&
    milestones.hasTrainedFourthCombatUnit;
  if (!allUnitMilestonesFired) {
    const prevCombat = prev.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
    const currCombat = curr.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
    if (currCombat > prevCombat) {
      if (!milestones.hasTrainedCombatUnit) {
        r += 0.05;
        milestones.hasTrainedCombatUnit = true;
        milestones.firstCombatUnitTick = curr.tick;
      } else if (!milestones.hasTrainedSecondCombatUnit) {
        r += 0.03;
        milestones.hasTrainedSecondCombatUnit = true;
      } else if (!milestones.hasTrainedThirdCombatUnit) {
        r += 0.02;
        milestones.hasTrainedThirdCombatUnit = true;
      } else if (!milestones.hasTrainedFourthCombatUnit) {
        r += 0.01;
        milestones.hasTrainedFourthCombatUnit = true;
      }
    }
  }

  // Time penalty (-0.00001/tick = -0.06 over a 6000-tick episode)
  r -= 0.00001;

  // Diagnostic tracking (no reward) — only update when crystal is visible (> 0)
  if (milestones.firstAttackTick < 0
      && prev.global.oppCrystalHealthFrac > 0
      && curr.global.oppCrystalHealthFrac > 0
      && curr.global.oppCrystalHealthFrac < prev.global.oppCrystalHealthFrac)
    milestones.firstAttackTick = curr.tick;
  if (curr.global.oppCrystalHealthFrac > 0
      && curr.global.oppCrystalHealthFrac < milestones.minOppCrystalHealthFrac)
    milestones.minOppCrystalHealthFrac = curr.global.oppCrystalHealthFrac;
  if (curr.global.ownCrystalHealthFrac < milestones.minOwnCrystalHealthFrac)
    milestones.minOwnCrystalHealthFrac = curr.global.ownCrystalHealthFrac;

  const shapingReturn = r;
  let terminalReturn = 0;

  if (done) {
    // winner === null only as a defensive fallback (Phase 1 tiebreaker guarantees a winner on timeout).
    terminalReturn = (winner === blueId) ? 1.0 : -1.0;
    r += terminalReturn;
  }

  return { reward: r, terminalReturn, shapingReturn };
}
