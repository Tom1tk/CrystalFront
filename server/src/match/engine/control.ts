/**
 * Node control (G-8): the objective win that replaced "hold 4500 resources".
 *
 * Each tick every contested node gets a controller: the side with a combat unit
 * within CONTROL.radius when the other side has none (both present, or neither,
 * = nobody). Turrets defend nodes but don't hold them, so control needs an army
 * on the map. A side holding more than half of the contested nodes gains 1
 * progress per tick and drains the opponent's by 1 (king of the hill: a brief
 * loss costs a little, not the whole hold). CONTROL.holdTicks progress wins.
 */
import { CONTROL } from "@crystalfront/shared";
import type { MatchEntity, MatchState } from "../types.js";

const UNIT_TYPES = new Set(["skirmisher", "gunner", "bruiser", "medic"]);

function holds(e: MatchEntity): boolean {
  return UNIT_TYPES.has(e.type);
}

/** Contested nodes needed for a hold: more than half. */
export function controlNeeded(total: number): number {
  return Math.floor(total / 2) + 1;
}

/** Updates node controllers and the hold timer. Returns the winning slot, or null. */
export function processControl(match: MatchState): 0 | 1 | null {
  const contested = match.resourceNodes.filter((n) => n.contested);
  if (contested.length === 0) return null;

  const ids = [match.players[0]?.playerId, match.players[1]?.playerId];
  const r2 = CONTROL.radius * CONTROL.radius;
  const holders: MatchEntity[] = [];
  for (const e of match.entities.values()) if (holds(e)) holders.push(e);

  const counts = [0, 0];
  for (const n of contested) {
    let blue = false, red = false;
    for (const e of holders) {
      const dx = e.x - n.x, dy = e.y - n.y;
      if (dx * dx + dy * dy > r2) continue;
      if (e.ownerId === ids[0]) blue = true;
      else if (e.ownerId === ids[1]) red = true;
    }
    n.controller = blue === red ? null : blue ? 0 : 1;
    if (n.controller !== null) counts[n.controller]++;
  }

  const need = controlNeeded(contested.length);
  const holder = counts[0] >= need ? 0 : counts[1] >= need ? 1 : null;
  match.control.holder = holder;
  if (holder === null) return null;
  const p = match.control.progress;
  p[holder]++;
  p[1 - holder] = Math.max(0, p[1 - holder] - 1);
  return p[holder] >= CONTROL.holdTicks ? holder : null;
}
