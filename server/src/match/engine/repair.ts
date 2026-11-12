import { GATHERING, HEALING } from "@crystalfront/shared";
import type { MatchEntity, MatchState } from "../types.js";
import { dist, getRange } from "./utils.js";

/** End a worker's repair; stop it walking to the building if it still is. */
export function releaseRepairer(worker: MatchEntity, building: MatchEntity): void {
  worker.repairTargetId = undefined;
  if (worker.moveTarget && worker.moveTarget.x === building.x && worker.moveTarget.y === building.y) worker.moveTarget = undefined;
}

export function processRepairAndHealing(match: MatchState): void {
  for (const entity of match.entities.values()) {
    // Building repair (G-13): the building's repairer must be alive, still assigned to it,
    // and within working range (the builders' range). Out of range it walks back, as
    // builders do; any other order ends the repair (matchEngine's ok()).
    if (entity.type === "building" && entity.repairTargetId) {
      const worker = match.entities.get(entity.repairTargetId);
      if (!worker || worker.health <= 0 || worker.repairTargetId !== entity.id || entity.health >= entity.maxHealth) {
        entity.repairTargetId = undefined;
        if (worker && worker.repairTargetId === entity.id) releaseRepairer(worker, entity);
      } else if (dist(worker.x, worker.y, entity.x, entity.y) <= GATHERING.range) {
        if (worker.moveTarget && worker.moveTarget.x === entity.x && worker.moveTarget.y === entity.y) worker.moveTarget = undefined;
        const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
        if (playerIdx >= 0 && match.economy[playerIdx]) {
          const economy = match.economy[playerIdx]!;
          const hpToRestore = HEALING.repairHpPerTick;
          const cost = hpToRestore * HEALING.repairCostPerHp;
          if (economy.resources >= cost) {
            economy.resources -= cost;
            entity.health = Math.min(entity.maxHealth, entity.health + hpToRestore);
            if (entity.health >= entity.maxHealth) { entity.repairTargetId = undefined; releaseRepairer(worker, entity); }
          }
        }
      } else if (!worker.moveTarget) {
        worker.moveTarget = { x: entity.x, y: entity.y };
      }
    } else if (entity.type !== "building" && entity.repairTargetId) {
      // A worker whose building is gone, or no longer names it as its repairer.
      const b = match.entities.get(entity.repairTargetId);
      if (!b || b.repairTargetId !== entity.id) {
        entity.repairTargetId = undefined;
        if (b) releaseRepairer(entity, b);
      }
    }

    // Medic auto-heal (G-13 E5): with no heal order and not moving, heal the ally in
    // range with the lowest HP fraction (then nearest, then entity order). Never moves.
    if (entity.type === "medic" && !entity.healTargetId && !entity.moveTarget) {
      const healRange = getRange(entity, match.terrain);
      let best: MatchEntity | undefined, bestFrac = Infinity, bestDist = Infinity;
      for (const o of match.entities.values()) {
        if (o === entity || o.ownerId !== entity.ownerId || o.health >= o.maxHealth || o.health <= 0) continue;
        if (o.type === "crystal" || o.type === "building" || o.type === "resource_node" || o.type === "placeholder") continue;
        const d = dist(entity.x, entity.y, o.x, o.y);
        if (d > healRange + o.radius) continue;
        const f = o.health / o.maxHealth;
        if (f < bestFrac || (f === bestFrac && d < bestDist)) { best = o; bestFrac = f; bestDist = d; }
      }
      if (best) {
        best.health = Math.min(best.maxHealth, best.health + HEALING.healRatePerTick);
        match.attackLog.push({
          attackerId: entity.id, targetId: best.id,
          damage: HEALING.healRatePerTick, tick: match.tick, isHeal: true,
        });
      }
      continue;
    }

    // Medic healing
    if (entity.type === "medic" && entity.healTargetId) {
      const target = match.entities.get(entity.healTargetId);
      if (!target || target.ownerId !== entity.ownerId) { entity.healTargetId = undefined; continue; }
      if (target.type === "crystal" || target.type === "building") { entity.healTargetId = undefined; continue; }
      const healRange = getRange(entity, match.terrain);
      const d = dist(entity.x, entity.y, target.x, target.y);
      if (d <= healRange + target.radius && target.health < target.maxHealth) {
        target.health = Math.min(target.maxHealth, target.health + HEALING.healRatePerTick);
        match.attackLog.push({
          attackerId: entity.id, targetId: target.id,
          damage: HEALING.healRatePerTick, tick: match.tick, isHeal: true,
        });
      }
    }
  }
}

// Crystals slowly regenerate when undefended, giving turtling players a path
// back to full HP between enemy pushes.
export function processCrystalRegen(match: MatchState): void {
  for (const crystal of match.entities.values()) {
    if (crystal.type !== "crystal" || crystal.health >= crystal.maxHealth) continue;
    let enemyNearby = false;
    for (const other of match.entities.values()) {
      if (other.ownerId === crystal.ownerId) continue;
      if (dist(crystal.x, crystal.y, other.x, other.y) <= HEALING.crystalRegenRange) {
        enemyNearby = true;
        break;
      }
    }
    if (!enemyNearby) {
      crystal.health = Math.min(crystal.maxHealth, crystal.health + HEALING.crystalRegenHpPerTick);
    }
  }
}
