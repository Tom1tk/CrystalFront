/**
 * Node control (G-8): the objective win that replaced "hold 4500 resources".
 *
 * Each tick every contested node gets a controller: the side with a combat unit
 * or a finished turret within CONTROL.radius when the other side has neither
 * (both present, or neither, = nobody). A side holding more than half of the
 * contested nodes starts a hold timer; it resets whenever the holder changes.
 * Holding for CONTROL.holdTicks wins.
 */
import { CONTROL } from "@crystalfront/shared";
import type { MatchEntity, MatchState } from "../types.js";

const UNIT_TYPES = new Set(["skirmisher", "gunner", "bruiser", "medic"]);

function holds(e: MatchEntity): boolean {
  return UNIT_TYPES.has(e.type) ||
    (e.type === "building" && e.buildingType === "turret" && e.constructionProgress >= 100);
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
  if (holder !== match.control.holder) match.control = { holder, since: match.tick };
  return holder !== null && match.tick - match.control.since >= CONTROL.holdTicks ? holder : null;
}
