import { HEALING } from "@crystalfront/shared";
import { dist, getRange } from "./utils.js";
export function processRepairAndHealing(match) {
    for (const entity of match.entities.values()) {
        // Building repair by assigned worker
        if (entity.type === "building" && entity.health < entity.maxHealth && entity.repairTargetId) {
            const worker = match.entities.get(entity.repairTargetId);
            if (worker) {
                const playerIdx = match.players.findIndex((p) => p?.playerId === entity.ownerId);
                if (playerIdx >= 0 && match.economy[playerIdx]) {
                    const economy = match.economy[playerIdx];
                    const hpToRestore = HEALING.repairHpPerTick;
                    const cost = hpToRestore * HEALING.repairCostPerHp;
                    if (economy.resources >= cost) {
                        economy.resources -= cost;
                        entity.health = Math.min(entity.maxHealth, entity.health + hpToRestore);
                        if (entity.health >= entity.maxHealth)
                            entity.repairTargetId = undefined;
                    }
                }
            }
        }
        // Medic healing
        if (entity.type === "medic" && entity.healTargetId) {
            const target = match.entities.get(entity.healTargetId);
            if (!target || target.ownerId !== entity.ownerId) {
                entity.healTargetId = undefined;
                continue;
            }
            if (target.type === "crystal" || target.type === "building") {
                entity.healTargetId = undefined;
                continue;
            }
            const healRange = getRange(entity);
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
