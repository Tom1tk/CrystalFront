import { NODES } from "@crystalfront/shared";
import type { EntityId } from "@crystalfront/shared";
import type { MatchState } from "../types.js";
import { dist } from "./utils.js";

const GATHER_RANGE = 60;
const GATHER_RATE_PER_WORKER = 0.33;

export function processGathering(match: MatchState): void {
  for (const node of match.resourceNodes) {
    if (node.gathererSlots.size === 0) continue;
    if (node.remaining < 1) continue;

    const inRangeWorkers: EntityId[] = [];
    for (const workerId of node.gathererSlots) {
      const worker = match.entities.get(workerId);
      if (!worker) continue;
      const d = dist(worker.x, worker.y, node.x, node.y);
      if (d <= GATHER_RANGE) {
        inRangeWorkers.push(workerId);
        if (worker.moveTarget) {
          const dx = worker.moveTarget.x - node.x;
          const dy = worker.moveTarget.y - node.y;
          if (Math.sqrt(dx * dx + dy * dy) < 5) worker.moveTarget = undefined;
        }
      } else {
        worker.moveTarget = { x: node.x, y: node.y };
      }
    }

    const gatherCount = inRangeWorkers.length;
    if (gatherCount === 0) continue;

    const totalGather = gatherCount * GATHER_RATE_PER_WORKER;
    node.accumulatedGather = (node.accumulatedGather ?? 0) + totalGather;
    const wholeResources = Math.floor(node.accumulatedGather);

    if (wholeResources > 0) {
      const perWorker = wholeResources / Math.max(inRangeWorkers.length, 1);
      const gatheredByPlayer = new Map<string, number>();
      for (const workerId of inRangeWorkers) {
        const worker = match.entities.get(workerId);
        if (worker) {
          gatheredByPlayer.set(
            worker.ownerId,
            (gatheredByPlayer.get(worker.ownerId) ?? 0) + perWorker,
          );
        }
      }

      // Alternate processing order by tick parity so that, when both
      // players' rounded shares tie for a contested node's limited
      // wholeResources, neither side gets a persistent first-mover edge.
      let entries = [...gatheredByPlayer.entries()];
      if (match.tick % 2 === 1) entries = entries.reverse();

      let distributed = 0;
      for (const [ownerId, count] of entries) {
        const rounded = Math.round(count);
        const capped = Math.min(rounded, wholeResources - distributed);
        if (capped <= 0) continue;
        const playerIdx = match.players.findIndex((p) => p?.playerId === ownerId);
        if (playerIdx >= 0 && match.economy[playerIdx]) {
          match.economy[playerIdx]!.resources += capped;
          match.economy[playerIdx]!.lifetimeResources += capped;
          distributed += capped;
        }
      }

      node.remaining = Math.max(0, node.remaining - distributed);
      node.accumulatedGather -= distributed;
    }
  }

  // Passive regen: all nodes slowly refill regardless of assignment
  for (const node of match.resourceNodes) {
    if (node.remaining < node.capacity) {
      node.remaining = Math.min(node.capacity, node.remaining + NODES.regenPerTick);
    }
  }
}
