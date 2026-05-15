import type { MacroAction } from "./types.js";
import type { MatchState, MatchEntity } from "../../server/src/match/types.js";
import { MAP, BUILD_ZONES, UNIT_DEFS, BUILDING_DEFS } from "@crystalfront/shared";

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
      // Find a production building that produces this unit type and isn't full
      const building = findProductionBuilding(match, playerId, action.unitType);
      if (!building) return [];
      return [{ type: "train_unit", buildingId: building.id, entityId: building.id, unitType: action.unitType }];
    }

    case "build": {
      if (!action.buildingType) return [];
      // Any worker not mid-construction can be redirected; engine clears gatheringNodeId
      const workers = getAvailableBuilders(match, playerId, 1);
      if (workers.length === 0) return [];
      const pos = chooseBuildPosition(playerColor, action.xZone ?? "mid_base", action.yZone ?? "middle", match);
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
      const target = resolveTargetZone(action.targetZone ?? "midfield", playerColor, match);
      const cmds: Record<string, unknown>[] = [];
      // Enable auto-attack on any unit that doesn't have it on yet
      const needAutoAttack = group.filter(e => !e.autoAttackEnabled).map(e => e.id);
      if (needAutoAttack.length > 0) {
        cmds.push({ type: "toggle_auto_attack", entityIds: needAutoAttack });
      }
      for (const e of group) {
        cmds.push({
          type: "move",
          entityId: e.id,
          targetX: target.x,
          targetY: target.y,
        });
      }
      return cmds;
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

    case "set_rally": {
      const buildings = [...match.entities.values()].filter(
        e => e.ownerId === playerId && e.type === "building" && e.constructionProgress >= 100
      );
      if (buildings.length === 0) return [];
      const target = resolveTargetZone(action.targetZone ?? "midfield", playerColor, match);
      return buildings.map(b => ({ type: "set_rally", entityId: b.id, targetX: target.x, targetY: target.y }));
    }

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

function getIdleWorkers(match: MatchState, playerId: string, min = 0): MatchEntity[] {
  const workers: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== playerId) continue;
    if (!e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId) {
      workers.push(e);
    }
  }
  return workers;
}

function getAvailableBuilders(match: MatchState, playerId: string, min = 0): MatchEntity[] {
  const workers: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== playerId) continue;
    if (!e.buildTargetId) workers.push(e);  // gathering workers OK; engine clears it on build
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
    if (group === "all_workers" && e.type === "worker")     { results.push(e); continue; }
  }
  return results;
}

function chooseBuildPosition(
  color: string,
  xZone: MacroAction["xZone"],
  yZone: MacroAction["yZone"],
  match: MatchState
): { x: number; y: number } | null {
  const mapW = MAP.width;
  const mapH = MAP.height;
  const isBlue = color === "blue";

  // X bands within the player's build zone (0-20% for blue, 80-100% for red)
  const zoneStart = isBlue ? 0 : mapW * BUILD_ZONES.redStartPct;
  const zoneEnd   = isBlue ? mapW * BUILD_ZONES.blueEndPct : mapW;
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

  // Jitter position if the zone coordinate is blocked by an existing building.
  // Step in 80-pixel increments (roughly one building width) up to 5 attempts.
  const STEP = 80;
  const existingBuildings = [...match.entities.values()].filter(e => e.type === "building");

  for (let attempt = 0; attempt < 8; attempt++) {
    const dx = (attempt % 3) * STEP * (attempt % 2 === 0 ? 1 : -1);
    const dy = Math.floor(attempt / 3) * STEP * (attempt < 4 ? 1 : -1);
    const cx = Math.max(zoneStart + 40, Math.min(zoneEnd - 40, baseX + dx));
    const cy = Math.max(40, Math.min(mapH - 40, baseY + dy));

    const blocked = existingBuildings.some(b => {
      const d = Math.sqrt((b.x - cx) ** 2 + (b.y - cy) ** 2);
      return d < b.radius + 50; // 50px clearance
    });

    if (!blocked) return { x: cx, y: cy };
  }

  return { x: baseX, y: baseY }; // fallback — engine will reject if still blocked
}

function resolveTargetZone(
  zone: MacroAction["targetZone"],
  playerColor: string,
  match: MatchState
): { x: number; y: number } {
  const isBlue = playerColor === "blue";

  if (zone === "enemy_crystal") {
    const oppColor = isBlue ? "red" : "blue";
    for (const e of match.entities.values()) {
      if (e.type === "crystal" && e.color.includes(oppColor)) return { x: e.x, y: e.y };
    }
    // Fallback: known crystal spawn position
    return { x: isBlue ? MAP.width - 100 : 100, y: MAP.height / 2 };
  }

  if (zone === "midfield") {
    return { x: MAP.width / 2, y: MAP.height / 2 };
  }

  if (zone === "contested_node") {
    // Find the nearest visible contested node
    const mid = MAP.width / 2;
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

  return { x: MAP.width / 2, y: MAP.height / 2 };
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
