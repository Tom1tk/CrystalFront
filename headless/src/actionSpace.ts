import type { MacroAction } from "./types.js";
import type { MatchState, MatchEntity } from "../../server/src/match/types.js";
import { MAP, BUILD_ZONES, UNIT_DEFS, BUILDING_DEFS, PLACEMENT } from "@crystalfront/shared";

/**
 * Expand a MacroAction into the raw engine commands it represents.
 * Returns an array of command objects accepted by MatchEngine.processCommand.
 */
export function expandMacroAction(
  action: MacroAction,
  match: MatchState,
  playerId: string
): Record<string, unknown>[] {
  const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
  const playerColor = match.players[playerIdx]?.color ?? "blue";

  // Visible entity IDs for this player (used by targeted attacks)
  const visibleIds: Set<string> = match.visibilityData?.get(playerId)?.entityIds ?? new Set();

  switch (action.type) {
    case "noop":
      return [];

    case "train_worker": {
      const crystal = findOwnCrystal(match, playerId);
      if (!crystal) return [];
      return [{ type: "train_worker", entityId: crystal.id }];
    }

    case "train_unit": {
      if (!action.unitType) return [];
      const building = findProductionBuilding(match, playerId, action.unitType);
      if (!building) return [];
      return [{ type: "train_unit", buildingId: building.id, entityId: building.id, unitType: action.unitType }];
    }

    case "build": {
      if (!action.buildingType) return [];
      const workers = getAvailableBuilders(match, playerId, 1);
      if (workers.length === 0) return [];
      const ownBuildingCount = [...match.entities.values()].filter(
        e => e.ownerId === playerId && e.type === "building"
      ).length;
      const Y_CYCLE = ["middle", "top", "bottom"] as const;
      const yZone = action.yZone ?? Y_CYCLE[ownBuildingCount % 3];
      const pos = chooseBuildPosition(playerColor, action.xZone ?? "mid_base", yZone, match);
      if (!pos) return [];
      return [{
        type: "build",
        buildingType: action.buildingType,
        targetX: pos.x,
        targetY: pos.y,
        workerIds: [workers[0].id],
        entityId: workers[0].id,
      }];
    }

    case "attack_move": {
      const group = getUnitGroup(match, playerId, action.group ?? "all_combat");
      if (group.length === 0) return [];
      const target = resolveTargetZone(action.targetZone ?? "midfield", playerColor, match, visibleIds);
      const cmds: Record<string, unknown>[] = [];
      const needAutoAttack = group.filter(e => !e.autoAttackEnabled).map(e => e.id);
      if (needAutoAttack.length > 0) {
        cmds.push({ type: "toggle_auto_attack", entityIds: needAutoAttack });
      }
      for (const e of group) {
        cmds.push({ type: "move", entityId: e.id, targetX: target.x, targetY: target.y });
      }
      return cmds;
    }

    case "attack_targeted": {
      const group = getUnitGroup(match, playerId, action.group ?? "all_combat");
      if (group.length === 0) return [];
      const visibleEnemies = getVisibleEnemies(match, playerId, visibleIds);
      if (visibleEnemies.length === 0) return [];

      const cmds: Record<string, unknown>[] = [];
      const targetType = action.targetType ?? "nearest_enemy";

      if (targetType === "spread_fire") {
        // Distribute group 1:1 across visible enemies — each unit claims the nearest unclaimed enemy.
        const enemyCombat = visibleEnemies.filter(e =>
          ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type)
        );
        const pool = enemyCombat.length > 0 ? [...enemyCombat] : [...visibleEnemies];
        const claimed = new Set<string>();
        for (const unit of group) {
          const available = pool.filter(e => !claimed.has(e.id));
          const candidates = available.length > 0 ? available : pool;
          const target = candidates.slice().sort((a, b) => dist2(a, unit) - dist2(b, unit))[0];
          if (!target) continue;
          claimed.add(target.id);
          cmds.push({ type: "attack", entityId: unit.id, targetEntityId: target.id });
        }
        return cmds;
      }

      for (const unit of group) {
        const target = resolveAttackTarget(unit, visibleEnemies, targetType, playerColor, match);
        if (!target) continue;
        cmds.push({ type: "attack", entityId: unit.id, targetEntityId: target.id });
      }
      return cmds;
    }

    case "hold_position": {
      // Stop moving, keep auto_attack enabled — units fire at whatever enters range.
      const group = getUnitGroup(match, playerId, action.group ?? "all_combat");
      if (group.length === 0) return [];
      const cmds: Record<string, unknown>[] = [];
      const needAutoAttack = group.filter(e => !e.autoAttackEnabled).map(e => e.id);
      if (needAutoAttack.length > 0) {
        cmds.push({ type: "toggle_auto_attack", entityIds: needAutoAttack });
      }
      // Issue a stop command (engine handler: clears moveTarget, clears attackTargetId)
      // But we want to keep autoAttackEnabled — so we only stop movement.
      // Use the stop command per-unit approach: stop clears moveTarget without touching autoAttack.
      for (const e of group) {
        // The stop command clears attackTargetId and disables autoAttack, which is wrong.
        // Instead issue move to own current position to freeze movement while preserving auto-attack.
        cmds.push({ type: "move", entityId: e.id, targetX: e.x, targetY: e.y });
      }
      // Re-enable auto_attack (the move command above may have preserved it, but ensure it's on)
      const allIds = group.map(e => e.id);
      cmds.push({ type: "toggle_auto_attack", entityIds: group.filter(e => !e.autoAttackEnabled).map(e => e.id) });
      return cmds.filter((_, i) => {
        // dedupe the toggle_auto_attack at end if nothing needed it
        if (i === cmds.length - 1) {
          const last = cmds[cmds.length - 1] as any;
          return last.entityIds && last.entityIds.length > 0;
        }
        return true;
      });
    }

    case "retreat": {
      const group = getUnitGroup(match, playerId, action.group ?? "all_combat");
      if (group.length === 0) return [];
      return [{ type: "retreat", entityIds: group.map(e => e.id) }];
    }

    case "assign_workers": {
      const idleWorkers = getIdleWorkers(match, playerId);
      const count = resolveWorkerCount(action.workerCount ?? "all_idle", idleWorkers.length);
      const chosen = idleWorkers.slice(0, count);
      if (chosen.length === 0) return [];
      const node = findNode(match, playerId, action.nodeChoice ?? "nearest_safe", chosen[0]);
      if (!node) return [];
      return chosen.map(w => ({ type: "gather", entityId: w.id, targetEntityId: node.id }));
    }

    case "set_rally":
      return [];

    default:
      return [];
  }
}

// ---- Helpers ----

function findOwnCrystal(match: MatchState, playerId: string): MatchEntity | undefined {
  for (const e of match.entities.values()) {
    if (e.type === "crystal" && e.ownerId === playerId) return e;
  }
}

function findProductionBuilding(match: MatchState, playerId: string, unitType: string): MatchEntity | undefined {
  for (const e of match.entities.values()) {
    if (e.type !== "building" || e.ownerId !== playerId || e.constructionProgress < 100) continue;
    const def = e.buildingType ? BUILDING_DEFS[e.buildingType] : null;
    if (def?.produces?.includes(unitType)) {
      const economy = match.economy[match.players.findIndex(p => p?.playerId === playerId)];
      if (!economy) continue;
      const queuedSupply = (e.productionQueue ?? []).reduce((s, i) => s + i.supplyCost, 0);
      const unitDef = UNIT_DEFS[unitType];
      if (unitDef && economy.supply + queuedSupply + unitDef.supplyCost <= economy.maxSupply) {
        return e;
      }
    }
  }
}

function getIdleWorkers(match: MatchState, playerId: string): MatchEntity[] {
  const workers: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== playerId) continue;
    if (!e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId) {
      workers.push(e);
    }
  }
  return workers;
}

function getAvailableBuilders(match: MatchState, playerId: string): MatchEntity[] {
  const workers: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== playerId) continue;
    if (!e.buildTargetId) workers.push(e);
  }
  return workers;
}

function getUnitGroup(match: MatchState, playerId: string, group: MacroAction["group"]): MatchEntity[] {
  const results: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.ownerId !== playerId) continue;
    const isCombat = ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type);
    if (group === "all_combat" && isCombat) { results.push(e); continue; }
    if (group === "skirmishers" && e.type === "skirmisher") { results.push(e); continue; }
    if (group === "gunners"     && e.type === "gunner")     { results.push(e); continue; }
    if (group === "bruisers"    && e.type === "bruiser")    { results.push(e); continue; }
    if (group === "all_workers"    && e.type === "worker")   { results.push(e); continue; }
    // Idle-only variants — only include units with no active orders
    const isIdle = !e.moveTarget && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId;
    if (group === "all_idle_combat" && isCombat && isIdle)   { results.push(e); continue; }
    if (group === "idle_workers"    && e.type === "worker" && isIdle) { results.push(e); continue; }
  }
  return results;
}

function getVisibleEnemies(match: MatchState, playerId: string, visibleIds: Set<string>): MatchEntity[] {
  const enemies: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.ownerId === playerId) continue;
    if (!visibleIds.has(e.id)) continue;
    enemies.push(e);
  }
  return enemies;
}

/**
 * Given a unit and visible enemies, pick the best target based on targetType.
 * "nearest_threat": nearest enemy whose path leads toward own crystal (past midfield, heading inward)
 * "nearest_enemy": nearest visible enemy combat unit (or any enemy if no combat)
 * "focus_weakest": visible enemy combat unit with lowest HP fraction
 */
function resolveAttackTarget(
  unit: MatchEntity,
  visibleEnemies: MatchEntity[],
  targetType: NonNullable<MacroAction["targetType"]>,
  playerColor: string,
  match: MatchState,
): MatchEntity | undefined {
  const isBlue = playerColor === "blue";
  const mid = MAP.width / 2;

  // Filter to combat units for most cases
  const enemyCombat = visibleEnemies.filter(e =>
    ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type)
  );

  if (targetType === "nearest_threat") {
    // Threats are enemy combat units that are in the agent's half of the map
    const threats = enemyCombat.filter(e => isBlue ? e.x < mid : e.x > mid);
    const pool = threats.length > 0 ? threats : enemyCombat.length > 0 ? enemyCombat : visibleEnemies;
    return pool.sort((a, b) => dist2(a, unit) - dist2(b, unit))[0];
  }

  if (targetType === "nearest_enemy") {
    const pool = enemyCombat.length > 0 ? enemyCombat : visibleEnemies;
    return pool.sort((a, b) => dist2(a, unit) - dist2(b, unit))[0];
  }

  if (targetType === "focus_weakest") {
    const pool = enemyCombat.length > 0 ? enemyCombat : visibleEnemies;
    return pool.sort((a, b) => {
      const aHp = a.maxHealth > 0 ? a.health / a.maxHealth : 0;
      const bHp = b.maxHealth > 0 ? b.health / b.maxHealth : 0;
      return aHp - bHp;
    })[0];
  }

  if (targetType === "targeting_friend") {
    // Find enemies whose current attack target is a friendly unit or building.
    const ownIds = new Set(
      [...match.entities.values()].filter(e => e.ownerId === playerId).map(e => e.id)
    );
    const attackers = enemyCombat.filter(e => e.attackTargetId && ownIds.has(e.attackTargetId));
    const pool = attackers.length > 0 ? attackers : enemyCombat.length > 0 ? enemyCombat : visibleEnemies;
    return pool.slice().sort((a, b) => dist2(a, unit) - dist2(b, unit))[0];
  }

  return visibleEnemies[0];
}

function chooseBuildPosition(
  color: string,
  xZone: MacroAction["xZone"],
  yZone: MacroAction["yZone"],
  match: MatchState
): { x: number; y: number } | null {
  // Use match.config dimensions so training overrides (e.g. mapWidth=1000) are respected.
  // MAP.width/height are the live-game constants (6000×600) and must NOT be used here.
  const mapW = match.config?.mapWidth ?? MAP.width;
  const mapH = match.config?.mapHeight ?? MAP.height;
  const isBlue = color === "blue";

  const zoneStart = isBlue ? 0 : mapW * BUILD_ZONES.redStartPct;
  // Ensure zone end clears the crystal no-build buffer (crystal at x≈100, radius 80 = 180px).
  // On small training maps (e.g. 1000px) mapW*0.2=200px would leave only 20px of valid range.
  const zoneEnd   = isBlue
    ? Math.max(mapW * BUILD_ZONES.blueEndPct, 280)
    : Math.min(mapW, mapW - 0);  // red mirror: keep full right side
  const zoneWidth = zoneEnd - zoneStart;

  const xBands: Record<NonNullable<MacroAction["xZone"]>, number> = {
    near_crystal: zoneStart + zoneWidth * (isBlue ? 0.15 : 0.85),
    mid_base:     zoneStart + zoneWidth * 0.5,
    forward:      zoneStart + zoneWidth * (isBlue ? 0.8 : 0.2),
  };

  const yBands: Record<NonNullable<MacroAction["yZone"]>, number> = {
    top:    mapH * 0.2,
    middle: mapH * 0.5,
    bottom: mapH * 0.8,
  };

  const baseX = xBands[xZone ?? "mid_base"] ?? (zoneStart + zoneWidth * 0.5);
  const baseY = yBands[yZone ?? "middle"] ?? mapH * 0.5;

  const STEP = 80;
  // Use the barracks half-dimensions for overlap checks (largest building, safe over-estimate).
  const halfW = 25;
  const halfH = 25;
  // Check all non-resource entities AND crystal no-build radius to avoid positions that
  // chooseBuildPosition passes but validatePlacement then rejects.
  const blockingEntities = [...match.entities.values()].filter(e => e.type !== "resource_node");
  const ownCrystals = blockingEntities.filter(
    e => e.type === "crystal" && e.ownerId === (isBlue ? match.players[0]?.playerId : match.players[1]?.playerId)
  );

  for (let attempt = 0; attempt < 16; attempt++) {
    const dx = (attempt % 4) * STEP * (attempt % 2 === 0 ? 1 : -1);
    const dy = Math.floor(attempt / 4) * STEP * (attempt < 8 ? 1 : -1);
    const cx = Math.max(zoneStart + 40, Math.min(zoneEnd - 40, baseX + dx));
    const cy = Math.max(40, Math.min(mapH - 40, baseY + dy));

    const entityBlocked = blockingEntities.some(e => {
      const ex1 = e.x - e.radius, ex2 = e.x + e.radius;
      const ey1 = e.y - e.radius, ey2 = e.y + e.radius;
      return (cx - halfW) < ex2 && (cx + halfW) > ex1 && (cy - halfH) < ey2 && (cy + halfH) > ey1;
    });
    const crystalBlocked = ownCrystals.some(c => {
      const d = Math.sqrt((cx - c.x) ** 2 + (cy - c.y) ** 2);
      return d < PLACEMENT.crystalNoBuildRadius;
    });

    if (!entityBlocked && !crystalBlocked) return { x: cx, y: cy };
  }

  return null;  // no valid position found — caller treats as illegal
}

function resolveTargetZone(
  zone: MacroAction["targetZone"],
  playerColor: string,
  match: MatchState,
  visibleIds: Set<string>,
): { x: number; y: number } {
  const isBlue = playerColor === "blue";
  const mid = MAP.width / 2;

  if (zone === "enemy_crystal") {
    const oppColor = isBlue ? "red" : "blue";
    for (const e of match.entities.values()) {
      if (e.type === "crystal" && e.color.includes(oppColor)) return { x: e.x, y: e.y };
    }
    return { x: isBlue ? MAP.width - 100 : 100, y: MAP.height / 2 };
  }

  if (zone === "midfield") {
    return { x: mid, y: MAP.height / 2 };
  }

  if (zone === "contested_node") {
    let nearest: { x: number; y: number } = { x: mid, y: MAP.height / 2 };
    let nearestDist = Infinity;
    for (const node of match.resourceNodes) {
      if (Math.abs(node.x - mid) < MAP.width * 0.35) {
        const dist = Math.abs(node.x - mid);
        if (dist < nearestDist) { nearestDist = dist; nearest = node; }
      }
    }
    return nearest;
  }

  if (zone === "enemy_army") {
    // Centroid of all visible enemy combat units; fall back to enemy crystal
    const oppId = match.players.find(p => p?.playerId !== match.players.find(pp => pp?.color === playerColor)?.playerId)?.playerId ?? "";
    const enemyCombat = [...match.entities.values()].filter(e =>
      e.ownerId !== (match.players.find(p => p?.color === playerColor)?.playerId ?? "") &&
      visibleIds.has(e.id) &&
      ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type)
    );
    if (enemyCombat.length > 0) {
      const cx = enemyCombat.reduce((s, e) => s + e.x, 0) / enemyCombat.length;
      const cy = enemyCombat.reduce((s, e) => s + e.y, 0) / enemyCombat.length;
      return { x: cx, y: cy };
    }
    // Fall back to enemy crystal
    return { x: isBlue ? MAP.width - 100 : 100, y: MAP.height / 2 };
  }

  if (zone === "defend_crystal") {
    // Position between own crystal and the nearest visible threat
    const ownPlayerId = match.players.find(p => p?.color === playerColor)?.playerId ?? "";
    const ownCrystal = [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === ownPlayerId);
    const cristalX = ownCrystal?.x ?? (isBlue ? 100 : MAP.width - 100);
    const crystalY = ownCrystal?.y ?? MAP.height / 2;

    const threats = [...match.entities.values()].filter(e =>
      e.ownerId !== ownPlayerId && visibleIds.has(e.id) &&
      ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type)
    );

    if (threats.length > 0) {
      // Find nearest threat to own crystal
      const nearest = threats.sort((a, b) =>
        dist2(a, { x: cristalX, y: crystalY }) - dist2(b, { x: cristalX, y: crystalY })
      )[0];
      // Stand 150px in front of crystal toward the threat
      const dx = nearest.x - cristalX;
      const dy = nearest.y - crystalY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      return {
        x: cristalX + (dx / len) * 150,
        y: crystalY + (dy / len) * 150,
      };
    }

    // No visible threat — stand 200px in front of crystal toward midfield
    return {
      x: cristalX + (isBlue ? 200 : -200),
      y: crystalY,
    };
  }

  return { x: mid, y: MAP.height / 2 };
}

function findNode(
  match: MatchState,
  playerId: string,
  choice: MacroAction["nodeChoice"],
  nearEntity: MatchEntity
): (typeof match.resourceNodes)[0] | undefined {
  const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
  const isBlue = match.players[playerIdx]?.color === "blue";
  const mid = MAP.width / 2;

  const availableNodes = match.resourceNodes.filter(n =>
    n.remaining > 0 && n.gathererSlots.size < n.maxGathererSlots
  );

  if (choice === "nearest_safe") {
    const safe = availableNodes.filter(n => isBlue ? n.x < mid : n.x > mid);
    return safe.sort((a, b) => dist2(a, nearEntity) - dist2(b, nearEntity))[0];
  }
  if (choice === "nearest_contested") {
    const cont = availableNodes.filter(n => Math.abs(n.x - mid) < MAP.width * 0.35);
    return cont.sort((a, b) => dist2(a, nearEntity) - dist2(b, nearEntity))[0];
  }
  if (choice === "richest_visible") {
    return availableNodes.sort((a, b) => b.remaining - a.remaining)[0];
  }
  return availableNodes[0];
}

function resolveWorkerCount(choice: MacroAction["workerCount"], available: number): number {
  if (choice === "all_idle") return available;
  return Math.min(choice as number, available);
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
