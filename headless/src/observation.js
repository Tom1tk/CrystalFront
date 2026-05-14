import { ENTITY_TYPES } from "./types.js";
import { MAP } from "../../shared/src/gameBalance.js";
export function buildObservation(match, playerId) {
    const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
    const oppIdx = playerIdx === 0 ? 1 : 0;
    const economy = match.economy[playerIdx];
    const oppEconomy = match.economy[oppIdx];
    // Fog of war: which entities/nodes are visible to this player?
    const vis = match.visibilityData?.get(playerId);
    const visibleEntityIds = vis?.entityIds ?? new Set();
    const visibleNodeIds = vis?.nodeIds ?? new Set();
    // Global features
    const ownResources = economy ? economy.resources / 1000 : 0;
    const ownSupply = economy ? economy.supply / Math.max(economy.maxSupply, 1) : 0;
    const ownMaxSupply = economy?.maxSupply ?? 0;
    // Opponent supply is only known if we can see any of their units
    const oppId = match.players[oppIdx]?.playerId ?? "";
    const canSeeOpp = [...visibleEntityIds].some(id => {
        const e = match.entities.get(id);
        return e?.ownerId === oppId;
    });
    const oppVisibleSupply = canSeeOpp && oppEconomy
        ? oppEconomy.supply / Math.max(oppEconomy.maxSupply, 1)
        : 0;
    const global = {
        ownResources,
        ownSupply,
        ownMaxSupply,
        oppVisibleSupply,
        tick: match.tick / 6000,
        scoreDiff: (match.players[playerIdx]?.score ?? 0) - (match.players[oppIdx]?.score ?? 0),
    };
    // Entity features — only visible entities
    const entities = [];
    for (const [id, e] of match.entities) {
        if (!visibleEntityIds.has(id))
            continue;
        const isOwn = e.ownerId === playerId;
        const typeKey = e.type === "building"
            ? `building_${e.buildingType ?? "barracks"}`
            : e.type;
        const typeIndex = ENTITY_TYPES.indexOf(typeKey);
        entities.push({
            id,
            typeIndex: typeIndex < 0 ? 0 : typeIndex,
            owner: isOwn ? 1 : -1,
            xNorm: e.x / MAP.width,
            yNorm: e.y / MAP.height,
            healthFrac: e.maxHealth > 0 ? e.health / e.maxHealth : 0,
            constructionFrac: e.constructionProgress / 100,
            isAttacking: !!e.attackTargetId,
            isMoving: !!e.moveTarget,
            isGathering: !!e.gatheringNodeId,
            isBuilding: !!e.buildTargetId,
            attackCooldownNorm: e.attackCooldown / 25,
        });
    }
    // Node features — only visible nodes
    const nodes = [];
    for (const node of match.resourceNodes) {
        if (!visibleNodeIds.has(node.id))
            continue;
        const midX = MAP.width / 2;
        nodes.push({
            id: node.id,
            xNorm: node.x / MAP.width,
            yNorm: node.y / MAP.height,
            remainingFrac: node.capacity > 0 ? node.remaining / node.capacity : 0,
            gathererCount: node.gathererSlots.size,
            isContested: Math.abs(node.x - midX) < MAP.width * 0.3,
        });
    }
    return { global, entities, nodes, playerId, tick: match.tick };
}
