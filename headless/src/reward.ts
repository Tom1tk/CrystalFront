/**
 * Shared reward module — single source of truth for computeReward.
 * Imported by both stdioRunner.ts and stdioVecRunner.ts to prevent drift.
 *
 * Reward components (7 total):
 *   +5 × crystal healthFrac delta dealt   (continuous)
 *   -2 × crystal healthFrac delta taken   (continuous)
 *   +10 one-time first barracks built
 *   +5  one-time first combat unit trained   (bootstrap shaping)
 *   +3  one-time second combat unit trained  (bootstrap shaping — tested on 3a_rwm with 10-37% win context)
 *   -0.001/tick time penalty
 *   ±100 terminal (win/loss)
 */

import type { PlayerObservation } from "./types.js";

export interface Milestones {
  hasBuiltBarracks: boolean;
  firstBarracksTick: number;
  hasTrainedCombatUnit: boolean;
  firstCombatUnitTick: number;
  hasTrainedSecondCombatUnit: boolean;
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
    firstAttackTick: -1,
    minOppCrystalHealthFrac: 1.0,
    minOwnCrystalHealthFrac: 1.0,
  };
}

export interface RewardResult {
  reward: number;
  terminalReturn: number;  // 0 unless done; ±100 on terminal tick
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

  // Crystal damage dealt (+5 per full crystal HP lost)
  // Both prev and curr must be > 0 to avoid false rewards from visibility changes.
  if (prev.global.oppCrystalHealthFrac > 0 && curr.global.oppCrystalHealthFrac > 0) {
    const delta = prev.global.oppCrystalHealthFrac - curr.global.oppCrystalHealthFrac;
    if (delta > 0) r += 5.0 * delta;
  }

  // Crystal damage taken (-2 per full crystal HP lost)
  const ownDelta = prev.global.ownCrystalHealthFrac - curr.global.ownCrystalHealthFrac;
  if (ownDelta > 0) r -= 2.0 * ownDelta;

  // First barracks built (+10 one-time)
  if (!milestones.hasBuiltBarracks) {
    const hadBarracks = prev.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const hasBarracks = curr.entities.some(e => e.owner === 1 && e.typeIndex === 6);
    if (!hadBarracks && hasBarracks) {
      r += 10.0;
      milestones.hasBuiltBarracks = true;
      milestones.firstBarracksTick = curr.tick;
    }
  }

  // First and second combat unit trained (+5 / +3 one-time bootstrap shaping)
  if (!milestones.hasTrainedCombatUnit || !milestones.hasTrainedSecondCombatUnit) {
    const prevCombat = prev.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
    const currCombat = curr.entities.filter(e => e.owner === 1 && e.typeIndex >= 2 && e.typeIndex <= 4).length;
    if (currCombat > prevCombat) {
      if (!milestones.hasTrainedCombatUnit) {
        r += 5.0;
        milestones.hasTrainedCombatUnit = true;
        milestones.firstCombatUnitTick = curr.tick;
      } else if (!milestones.hasTrainedSecondCombatUnit) {
        r += 3.0;
        milestones.hasTrainedSecondCombatUnit = true;
      }
    }
  }

  // Time penalty (-0.001/tick = -6 over a 6000-tick episode)
  r -= 0.001;

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
    terminalReturn = (winner === blueId && winType !== "resource") ? 100.0 : -100.0;
    r += terminalReturn;
  }

  return { reward: r, terminalReturn, shapingReturn };
}
