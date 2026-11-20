import type { MatchEntity, MatchState } from "./types.js";
import { isBeta } from "./types.js";

/**
 * The 0.9 neural bots in a beta match (mainline 0.10 plan §2a and §4.5): they were trained without
 * the Outrider, so they see the match as 0.9 would show it. Their own Outrider is hidden (it idles at
 * home as free base vision). An enemy Outrider shows as a worker, a unit type they know. They never
 * train one, because the v2 action space has no such action. In 0.9 matches the match itself is used.
 *
 * The view shares everything with the match except its entity map, so it is only for observing and
 * computing masks. Commands still go to the real match (entity ids are the same).
 */
export function v09View(match: MatchState, playerId: string): MatchState {
  if (!isBeta(match)) return match;
  const entities = new Map<string, MatchEntity>();
  for (const [id, e] of match.entities) {
    if (e.type !== "outrider") entities.set(id, e);
    else if (e.ownerId !== playerId) entities.set(id, { ...e, type: "worker" });
  }
  return { ...match, entities };
}
