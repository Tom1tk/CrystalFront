import type { PlayerId, EntityId } from "@crystalfront/shared";
import type { MatchState } from "../types.js";
import { getVisionRange } from "./utils.js";

export function computeVisibility(match: MatchState): void {
  const allEntities = Array.from(match.entities.values());
  const visibility = new Map<PlayerId, { entityIds: Set<EntityId>; nodeIds: Set<string> }>();

  for (const p of match.players) {
    if (p) visibility.set(p.playerId, { entityIds: new Set(), nodeIds: new Set() });
  }

  for (const [playerId, vis] of visibility) {
    const myEntities = allEntities.filter(
      (e) => e.ownerId === playerId &&
        (e.health > 0 || (e.type === "building" && e.constructionProgress < 100))
    );
    // Every player always sees their own living entities (safety guarantee)
    for (const mine of myEntities) vis.entityIds.add(mine.id);

    for (const src of myEntities) {
      const vRange = getVisionRange(src);
      const vRangeSq = vRange * vRange;
      for (const target of allEntities) {
        if (target.health <= 0) continue;
        const dx = target.x - src.x;
        const dy = target.y - src.y;
        if (dx * dx + dy * dy <= vRangeSq) vis.entityIds.add(target.id);
      }
      for (const node of match.resourceNodes) {
        const dx = node.x - src.x;
        const dy = node.y - src.y;
        if (dx * dx + dy * dy <= vRangeSq) vis.nodeIds.add(node.id);
      }
    }
  }

  match.visibilityData = visibility;
}
