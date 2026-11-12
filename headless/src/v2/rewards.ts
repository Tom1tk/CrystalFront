// G-10 M0 T7 (R-7): raw reward components for one decision window.
//
// The runner returns components, not a weighted sum: Python applies weights,
// time decay and schedules (ML_RETRAIN_PLAN §7.4), so changing them needs no
// rebuild. Every shaped component is a zero-sum differential (my change minus
// the opponent's), scaled so a typical decision is O(0.01):
//   res   resources gathered (lifetime total), per RES_SCALE
//   army  army value (cost × health fraction of combat units), per ARMY_SCALE
//   dmg   health removed from enemy units and buildings (a death removes what
//         was left), minus the same for mine, per DMG_SCALE
//   ctrl  control progress, as a fraction of CONTROL.holdTicks
// `win` is +1 / −1 on a real win or loss, 0 otherwise (truncation included).
import type { MatchState } from "../../../server/src/match/types.js";
import { CONTROL, UNIT_DEFS } from "@crystalfront/shared";

export const RES_SCALE = 1000;
export const ARMY_SCALE = 1000;
export const DMG_SCALE = 1000;

export interface ShapedRewards { res: number; army: number; dmg: number; ctrl: number }
export interface SeatRewards { win: number; shaped: ShapedRewards }

const COMBAT = new Set(["skirmisher", "gunner", "bruiser", "medic"]);
const DAMAGEABLE = new Set(["crystal", "worker", "building", "skirmisher", "gunner", "bruiser", "medic"]);

/** What a decision window is measured against, per seat. */
export interface RewardSnapshot {
  lifetime: [number, number];
  army: [number, number];
  ctrl: [number, number];
  /** Entity id → health, per seat. */
  hp: [Map<string, number>, Map<string, number>];
}

function seatOf(match: MatchState, ownerId: string): 0 | 1 | -1 {
  if (match.players[0]?.playerId === ownerId) return 0;
  if (match.players[1]?.playerId === ownerId) return 1;
  return -1;
}

export function rewardSnapshot(match: MatchState): RewardSnapshot {
  const army: [number, number] = [0, 0];
  const hp: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
  for (const e of match.entities.values()) {
    if (!DAMAGEABLE.has(e.type)) continue;
    const s = seatOf(match, e.ownerId);
    if (s < 0) continue;
    hp[s].set(e.id, e.health);
    if (COMBAT.has(e.type) && e.maxHealth > 0) army[s] += UNIT_DEFS[e.type].cost * (e.health / e.maxHealth);
  }
  return {
    lifetime: [match.economy[0]?.lifetimeResources ?? 0, match.economy[1]?.lifetimeResources ?? 0],
    army,
    ctrl: [match.control?.progress[0] ?? 0, match.control?.progress[1] ?? 0],
    hp,
  };
}

/** Health seat `s` lost between the snapshots (gains such as healing or construction are ignored). */
function damageTaken(prev: Map<string, number>, match: MatchState): number {
  let d = 0;
  for (const [id, h] of prev) d += Math.max(0, h - (match.entities.get(id)?.health ?? 0));
  return d;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Rewards for both seats over the window that started at `prev`. Seat 1's
 * shaped values are the negatives of seat 0's (zero-sum).
 * `winnerSeat` is set only when the episode was terminated by the rules.
 */
export function windowRewards(match: MatchState, prev: RewardSnapshot, winnerSeat: 0 | 1 | null): [SeatRewards, SeatRewards] {
  const now = rewardSnapshot(match);
  const diff = (a: [number, number], b: [number, number]) => (a[0] - b[0]) - (a[1] - b[1]);
  const taken: [number, number] = [damageTaken(prev.hp[0], match), damageTaken(prev.hp[1], match)];
  const s0: ShapedRewards = {
    res: round(diff(now.lifetime, prev.lifetime) / RES_SCALE),
    army: round(diff(now.army, prev.army) / ARMY_SCALE),
    dmg: round((taken[1] - taken[0]) / DMG_SCALE),
    ctrl: round(diff(now.ctrl, prev.ctrl) / CONTROL.holdTicks),
  };
  const neg = (r: ShapedRewards): ShapedRewards => ({ res: -r.res || 0, army: -r.army || 0, dmg: -r.dmg || 0, ctrl: -r.ctrl || 0 });
  const win = (s: 0 | 1) => (winnerSeat === null ? 0 : winnerSeat === s ? 1 : -1);
  return [{ win: win(0), shaped: s0 }, { win: win(1), shaped: neg(s0) }];
}
