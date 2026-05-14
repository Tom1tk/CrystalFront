import type { MatchState } from "../../server/src/match/types.js";
import type { PlayerObservation, GlobalFeatures, EntityFeature, NodeFeature } from "./types.js";
import { ENTITY_TYPES } from "./types.js";
import { MAP, ECONOMY, ENTITY } from "@crystalfront/shared";

export function buildObservation(match: MatchState, playerId: string): PlayerObservation {
  const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
  const oppIdx = playerIdx === 0 ? 1 : 0;

  const economy = match.economy[playerIdx];
  const oppEconomy = match.economy[oppIdx];

  // Fog of war: which entities/nodes are visible to this player?
  const vis = match.visibilityData?.get(playerId);
  const visibleEntityIds = vis?.entityIds ?? new Set<string>();
  const visibleNodeIds   = vis?.nodeIds   ?? new Set<string>();

  // Global features
  const ownResources  = economy ? economy.resources / 1000 : 0;
  const ownSupply     = economy ? economy.supply / Math.max(economy.maxSupply, 1) : 0;
  const ownMaxSupply  = economy?.maxSupply ?? 0;
  const oppId = match.players[oppIdx]?.playerId ?? "";
  const canSeeOpp = [...visibleEntityIds].some(id => {
    const e = match.entities.get(id);
    return e?.ownerId === oppId;
  });
  const oppVisibleSupply = canSeeOpp && oppEconomy
    ? oppEconomy.supply / Math.max(oppEconomy.maxSupply, 1)
    : 0;

  // Crystal health fractions
  const ownCrystal = [...match.entities.values()].find(
    e => e.type === "crystal" && e.ownerId === playerId
  );
  const oppCrystal = canSeeOpp
    ? [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === oppId)
    : undefined;
  const crystalMaxHp = ENTITY.crystal.health;

  // Lifetime resources for passive win tracking
  const ownLifetime = economy?.lifetimeResources ?? 0;
  const oppLifetime = canSeeOpp ? (oppEconomy?.lifetimeResources ?? 0) : 0;
  const threshold = ECONOMY.passiveWinThreshold;

  const global: GlobalFeatures = {
    ownResources,
    ownSupply,
    ownMaxSupply,
    oppVisibleSupply,
    tick: match.tick / 6000,
    scoreDiff: (match.players[playerIdx]?.score ?? 0) - (match.players[oppIdx]?.score ?? 0),
    ownCrystalHealthFrac: ownCrystal ? ownCrystal.health / crystalMaxHp : 0,
    oppCrystalHealthFrac: oppCrystal ? oppCrystal.health / crystalMaxHp : 0,
    ownLifetimeResourcesFrac: Math.min(ownLifetime / threshold, 1),
    oppLifetimeResourcesFrac: Math.min(oppLifetime / threshold, 1),
  };

  // Entity features — only visible entities
  const entities: EntityFeature[] = [];
  for (const [id, e] of match.entities) {
    if (!visibleEntityIds.has(id)) continue;

    const isOwn = e.ownerId === playerId;
    const typeKey = e.type === "building"
      ? `building_${e.buildingType ?? "barracks"}` as const
      : e.type;
    const typeIndex = ENTITY_TYPES.indexOf(typeKey as typeof ENTITY_TYPES[number]);

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
  const nodes: NodeFeature[] = [];
  for (const node of match.resourceNodes) {
    if (!visibleNodeIds.has(node.id)) continue;

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
