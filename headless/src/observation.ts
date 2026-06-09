import type { MatchState } from "../../server/src/match/types.js";
import type { PlayerObservation, GlobalFeatures, EntityFeature, NodeFeature } from "./types.js";
import { ENTITY_TYPES } from "./types.js";
import { MAP, ECONOMY, UNIT_DEFS } from "@crystalfront/shared";

export function buildObservation(match: MatchState, playerId: string): PlayerObservation {
  const mapW = match.config?.mapWidth  ?? MAP.width;
  const mapH = match.config?.mapHeight ?? MAP.height;

  const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
  const oppIdx = playerIdx === 0 ? 1 : 0;

  const economy = match.economy[playerIdx];
  const oppEconomy = match.economy[oppIdx];

  const vis = match.visibilityData?.get(playerId);
  const visibleEntityIds = vis?.entityIds ?? new Set<string>();
  const visibleNodeIds   = vis?.nodeIds   ?? new Set<string>();

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

  const ownCrystal = [...match.entities.values()].find(
    e => e.type === "crystal" && e.ownerId === playerId
  );
  const oppCrystal = canSeeOpp
    ? [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === oppId)
    : undefined;

  const threshold = ECONOMY.passiveWinThreshold;
  const ownHeldRaw = economy?.resources ?? 0;
  const oppHeldRaw = canSeeOpp ? (oppEconomy?.resources ?? 0) : 0;
  const ownLifetime = economy?.lifetimeResources ?? 0;
  const oppLifetime = canSeeOpp ? (oppEconomy?.lifetimeResources ?? 0) : 0;

  const mid = mapW / 2;
  const isBlue = match.players[playerIdx]?.color === "blue";

  // Enemy unit composition (visible only)
  const visibleEnemies = [...match.entities.values()].filter(
    e => e.ownerId === oppId && visibleEntityIds.has(e.id)
  );
  const enemyWorkerCount     = visibleEnemies.filter(e => e.type === "worker").length / 10;
  const enemySkirmisherCount = visibleEnemies.filter(e => e.type === "skirmisher").length / 10;
  const enemyBruiserCount    = visibleEnemies.filter(e => e.type === "bruiser").length / 10;
  const enemyBarracksCount   = visibleEnemies.filter(e => e.type === "building" && e.buildingType === "barracks" && e.constructionProgress >= 100).length / 4;
  const enemyTurretCount     = visibleEnemies.filter(e => e.type === "building" && e.buildingType === "turret"   && e.constructionProgress >= 100).length / 4;
  const enemyForwardUnits    = visibleEnemies.filter(e =>
    ["skirmisher","gunner","bruiser","medic"].includes(e.type) && (
      isBlue ? e.x > mid : e.x < mid
    )
  ).length;
  const oppTotalVisibleCombat = visibleEnemies.filter(e =>
    ["skirmisher","gunner","bruiser","medic"].includes(e.type)
  ).length;
  const enemyForwardUnitFrac = oppTotalVisibleCombat > 0 ? enemyForwardUnits / oppTotalVisibleCombat : 0;

  // ── Threat geometry features (v0.1.57) ───────────────────────────────────────
  // nearestEnemyToCrystalDistNorm: how close is the nearest visible enemy to our crystal?
  const ownCrystalX = ownCrystal?.x ?? (isBlue ? 100 : mapW - 100);
  const ownCrystalY = ownCrystal?.y ?? mapH / 2;
  const visibleEnemyUnits = visibleEnemies.filter(e =>
    ["skirmisher","gunner","bruiser","medic"].includes(e.type)
  );
  let nearestEnemyToCrystalDistNorm = 1.0;
  for (const e of visibleEnemyUnits) {
    const d = Math.sqrt((e.x - ownCrystalX) ** 2 + (e.y - ownCrystalY) ** 2) / mapW;
    if (d < nearestEnemyToCrystalDistNorm) nearestEnemyToCrystalDistNorm = d;
  }

  // ownCombatInOwnHalf: our combat units in our half
  const ownEntities = [...match.entities.values()].filter(e => e.ownerId === playerId);
  const ownCombatInOwnHalf = ownEntities.filter(e =>
    ["skirmisher","gunner","bruiser","medic"].includes(e.type) &&
    (isBlue ? e.x < mid : e.x > mid)
  ).length / 10;

  // enemyCombatInOwnHalf: visible enemy combat units in our half
  const enemyCombatInOwnHalf = visibleEnemyUnits.filter(e =>
    isBlue ? e.x < mid : e.x > mid
  ).length / 10;

  // totalVisibleEnemyCombat
  const totalVisibleEnemyCombat = oppTotalVisibleCombat / 10;

  const global: GlobalFeatures = {
    ownResources,
    ownSupply,
    ownMaxSupply,
    oppVisibleSupply,
    tick: match.tick / 6000,
    scoreDiff: (match.players[playerIdx]?.score ?? 0) - (match.players[oppIdx]?.score ?? 0),
    ownCrystalHealthFrac: ownCrystal && ownCrystal.maxHealth > 0 ? ownCrystal.health / ownCrystal.maxHealth : 0,
    oppCrystalHealthFrac: oppCrystal && oppCrystal.maxHealth > 0 ? oppCrystal.health / oppCrystal.maxHealth : 0,
    ownResourcesWinFrac: Math.min(ownHeldRaw / threshold, 1),
    oppResourcesWinFrac: Math.min(oppHeldRaw / threshold, 1),
    ownLifetimeResourcesFrac: Math.min(ownLifetime / (threshold * 2), 1),
    oppLifetimeResourcesFrac: Math.min(oppLifetime / (threshold * 2), 1),
    enemyWorkerCount,
    enemySkirmisherCount,
    enemyBruiserCount,
    enemyBarracksCount,
    enemyTurretCount,
    enemyForwardUnitFrac,
    nearestEnemyToCrystalDistNorm,
    ownCombatInOwnHalf,
    enemyCombatInOwnHalf,
    totalVisibleEnemyCombat,
  };

  // ── Entity features — only visible entities ───────────────────────────────────
  // Pre-build a spatial lookup of visible enemies for attack-range checking
  const visibleEnemyList = [...match.entities.values()].filter(
    e => e.ownerId !== playerId && visibleEntityIds.has(e.id)
  );

  const entities: EntityFeature[] = [];
  for (const [id, e] of match.entities) {
    if (!visibleEntityIds.has(id)) continue;

    const isOwn = e.ownerId === playerId;
    const typeKey = e.type === "building"
      ? `building_${e.buildingType ?? "barracks"}` as const
      : e.type;
    const typeIndex = ENTITY_TYPES.indexOf(typeKey as typeof ENTITY_TYPES[number]);

    // inAttackRange: is there a visible enemy within this entity's weapon range?
    let inAttackRange = false;
    if (isOwn) {
      const unitRange = (UNIT_DEFS as Record<string, { range: number }>)[e.type]?.range ?? 0;
      if (unitRange > 0) {
        for (const enemy of visibleEnemyList) {
          const d = Math.sqrt((enemy.x - e.x) ** 2 + (enemy.y - e.y) ** 2);
          if (d <= unitRange + (enemy.radius ?? 0)) {
            inAttackRange = true;
            break;
          }
        }
      }
    }

    entities.push({
      id,
      typeIndex: typeIndex < 0 ? 0 : typeIndex,
      owner: isOwn ? 1 : -1,
      xNorm: e.x / mapW,
      yNorm: e.y / mapH,
      healthFrac: e.maxHealth > 0 ? e.health / e.maxHealth : 0,
      constructionFrac: e.constructionProgress / 100,
      isAttacking: !!e.attackTargetId,
      isMoving: !!e.moveTarget,
      isGathering: !!e.gatheringNodeId,
      isBuilding: !!e.buildTargetId,
      attackCooldownNorm: e.attackCooldown / 25,
      inAttackRange,
    });
  }

  // ── Node features — only visible nodes ───────────────────────────────────────
  const nodes: NodeFeature[] = [];
  for (const node of match.resourceNodes) {
    if (!visibleNodeIds.has(node.id)) continue;

    nodes.push({
      id: node.id,
      xNorm: node.x / mapW,
      yNorm: node.y / mapH,
      remainingFrac: node.capacity > 0 ? node.remaining / node.capacity : 0,
      gathererCount: node.gathererSlots.size,
      isContested: Math.abs(node.x - mid) < mapW * 0.3,
    });
  }

  return { global, entities, nodes, playerId, tick: match.tick };
}
