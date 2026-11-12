import type { MacroAction } from "./types.js";
import type { MatchState, MatchEntity } from "../../server/src/match/types.js";
import { MAP, BUILD_ZONES, UNIT_DEFS, BUILDING_DEFS, PLACEMENT } from "@crystalfront/shared";
import { validateBuildSite } from "../../server/src/match/buildingValidation.js";
import { mapSymmetry } from "../../server/src/match/maps.js";

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
      const node = action.nodeId ? match.resourceNodes.find(n => n.id === action.nodeId) : undefined;
      const pos = node
        ? chooseSiteNear(match, playerId, action.buildingType, node)
        : chooseBuildPosition(playerColor, action.xZone ?? "mid_base", yZone, match, action.buildingType);
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
      const node = action.nodeId ? match.resourceNodes.find(n => n.id === action.nodeId) : undefined;
      const target = node ?? resolveTargetZone(action.targetZone ?? "midfield", playerColor, match, visibleIds);
      const cmds: Record<string, unknown>[] = [];
      const needAutoAttack = group.filter(e => !e.autoAttackEnabled).map(e => e.id);
      if (needAutoAttack.length > 0) {
        cmds.push({ type: "toggle_auto_attack", entityIds: needAutoAttack });
      }
      let rest = group;
      for (const gid of action.garrison ?? []) {
        const gn = match.resourceNodes.find(n => n.id === gid);
        if (!gn || rest.length <= GARRISON_SIZE) continue;
        rest = rest.slice().sort((a, b) => dist2(a, gn) - dist2(b, gn) || (a.id < b.id ? -1 : 1));
        for (const e of rest.slice(0, GARRISON_SIZE)) {
          cmds.push({ type: "attack_move", entityId: e.id, targetX: gn.x, targetY: gn.y });
        }
        rest = rest.slice(GARRISON_SIZE);
      }
      // Stragglers: units more than REGROUP_GAP behind the lead unit gather at
      // regroupAt; if too few are together, the whole wave regroups.
      const stage = action.regroupAt ? match.resourceNodes.find(n => n.id === action.regroupAt) : undefined;
      if (stage && rest.length > 0) {
        const lead = rest.reduce((a, b) => (dist2(b, target) < dist2(a, target) ? b : a));
        const wave = rest.filter(e => dist2(e, lead) <= REGROUP_GAP * REGROUP_GAP);
        const together = wave.length >= REGROUP_MIN;
        for (const e of rest) {
          const go = together && wave.includes(e) ? target : stage;
          cmds.push({ type: "attack_move", entityId: e.id, targetX: go.x, targetY: go.y });
        }
        return cmds;
      }
      for (const e of rest) {
        cmds.push({ type: "attack_move", entityId: e.id, targetX: target.x, targetY: target.y });
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
        // Instead attack-move to own current position: freezes movement, keeps fighting.
        cmds.push({ type: "attack_move", entityId: e.id, targetX: e.x, targetY: e.y });
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

/** The finished producer of unitType with the shortest queue that supply allows. */
function findProductionBuilding(match: MatchState, playerId: string, unitType: string): MatchEntity | undefined {
  let best: MatchEntity | undefined;
  for (const e of match.entities.values()) {
    if (e.type !== "building" || e.ownerId !== playerId || e.constructionProgress < 100) continue;
    const def = e.buildingType ? BUILDING_DEFS[e.buildingType] : null;
    if (def?.produces?.includes(unitType)) {
      const economy = match.economy[match.players.findIndex(p => p?.playerId === playerId)];
      if (!economy) continue;
      const queuedSupply = (e.productionQueue ?? []).reduce((s, i) => s + i.supplyCost, 0);
      const unitDef = UNIT_DEFS[unitType];
      if (unitDef && economy.supply + queuedSupply + unitDef.supplyCost <= economy.maxSupply &&
          (!best || (e.productionQueue?.length ?? 0) < (best.productionQueue?.length ?? 0))) {
        best = e;
      }
    }
  }
  return best;
}

/** Nodes with less than this left are skipped when assigning workers. */
const MIN_NODE_REMAINING = 5;

/**
 * A worker is idle when it has no job, or its node has run dry (G-8). Treating
 * workers on an empty node as idle lets `assign_workers` move them to a node
 * that still has resources instead of waiting there on regen.
 */
export function isIdleWorker(match: MatchState, e: MatchEntity): boolean {
  if (e.buildTargetId || e.attackTargetId || e.repairTargetId) return false;
  if (!e.gatheringNodeId) return true;
  const node = match.resourceNodes.find(n => n.id === e.gatheringNodeId);
  return !node || node.remaining < MIN_NODE_REMAINING;
}

function getIdleWorkers(match: MatchState, playerId: string): MatchEntity[] {
  const workers: MatchEntity[] = [];
  for (const e of match.entities.values()) {
    if (e.type !== "worker" || e.ownerId !== playerId) continue;
    if (isIdleWorker(match, e)) workers.push(e);
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
  const mid = (match.config?.mapWidth ?? MAP.width) / 2;

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

/**
 * Nearest valid site for a building next to a resource node (G-8 node control):
 * a ring 60–120 px out, so it covers the node without standing on it.
 */
export function chooseSiteNear(
  match: MatchState,
  playerId: string,
  buildingType: NonNullable<MacroAction["buildingType"]>,
  node: { x: number; y: number },
): { x: number; y: number } | null {
  // Offsets in the player's own frame (red mirrored, and also flipped vertically
  // on rotate maps), so both sides pick matching sites.
  const isBlue = match.players[0]?.playerId === playerId;
  const sx = isBlue ? 1 : -1;
  const sy = !isBlue && mapSymmetry(match.config?.mapId) === "rotate" ? -1 : 1;
  const sites: Array<{ x: number; y: number; gx: number; gy: number; d: number }> = [];
  for (let gx = -3; gx <= 3; gx++) for (let gy = -3; gy <= 3; gy++) {
    const d = Math.hypot(gx, gy) * 40;
    if (d < 60 || d > 120) continue;
    sites.push({ x: node.x + gx * 40 * sx, y: node.y + gy * 40 * sy, gx, gy, d });
  }
  // Prefer the side facing the own crystal, then nearest.
  const crystal = [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === playerId);
  const key = (p: { x: number; y: number; d: number }) =>
    p.d + (crystal ? 0.25 * Math.hypot(p.x - crystal.x, p.y - crystal.y) : 0);
  sites.sort((a, b) => key(a) - key(b) || a.gx - b.gx || a.gy - b.gy);
  for (const p of sites) {
    if (validateBuildSite(match, playerId, buildingType, p.x, p.y).valid) return { x: p.x, y: p.y };
  }
  return null;
}

export function chooseBuildPosition(
  color: string,
  xZone: MacroAction["xZone"],
  yZone: MacroAction["yZone"],
  match: MatchState,
  buildingType?: NonNullable<MacroAction["buildingType"]>
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
  // On rotationally symmetric maps red's "top" is blue's "bottom" (G-8 fairness).
  const flipY = !isBlue && mapSymmetry(match.config?.mapId) === "rotate";
  const bandY = yBands[yZone ?? "middle"] ?? mapH * 0.5;
  const baseY = flipY ? mapH - bandY : bandY;
  const playerId = match.players.find(p => p?.color === color)?.playerId ?? "";

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

  // Search outward from the band centre. With a building type, each site is
  // checked with the engine's own rules (terrain, no-seal, spacing), so the
  // bot never picks a site the engine would reject (G-8).
  const offsets: Array<[number, number]> = [];
  for (let gx = -4; gx <= 4; gx++) for (let gy = -4; gy <= 4; gy++) offsets.push([gx, gy]);
  offsets.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2) || a[0] - b[0] || a[1] - b[1]);
  const maxAttempts = buildingType ? offsets.length : 16;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let dx: number, dy: number;
    if (buildingType) {
      dx = offsets[attempt][0] * (STEP / 2) * (isBlue ? 1 : -1);
      dy = offsets[attempt][1] * (STEP / 2) * (flipY ? -1 : 1);
    } else {
      dx = (attempt % 4) * STEP * (attempt % 2 === 0 ? 1 : -1) * (isBlue ? 1 : -1);
      dy = Math.floor(attempt / 4) * STEP * (attempt < 8 ? 1 : -1) * (flipY ? -1 : 1);
    }
    const cx = Math.max(zoneStart + 40, Math.min(zoneEnd - 40, baseX + dx));
    const cy = Math.max(40, Math.min(mapH - 40, baseY + dy));

    if (buildingType) {
      if (validateBuildSite(match, playerId, buildingType, cx, cy).valid) return { x: cx, y: cy };
      continue;
    }

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

export function resolveTargetZone(
  zone: MacroAction["targetZone"],
  playerColor: string,
  match: MatchState,
  visibleIds: Set<string>,
): { x: number; y: number } {
  const isBlue = playerColor === "blue";
  const mapW = match.config?.mapWidth  ?? MAP.width;
  const mapH = match.config?.mapHeight ?? MAP.height;
  const mid = mapW / 2;

  if (zone === "enemy_crystal") {
    const oppColor = isBlue ? "red" : "blue";
    for (const e of match.entities.values()) {
      if (e.type === "crystal" && e.color.includes(oppColor)) return { x: e.x, y: e.y };
    }
    return { x: isBlue ? mapW - 100 : 100, y: mapH / 2 };
  }

  if (zone === "midfield") {
    return { x: mid, y: mapH / 2 };
  }

  if (zone === "contested_node") {
    let nearest: { x: number; y: number } = { x: mid, y: mapH / 2 };
    let nearestDist = Infinity;
    for (const node of match.resourceNodes) {
      if (Math.abs(node.x - mid) < mapW * 0.35) {
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
    return { x: isBlue ? mapW - 100 : 100, y: mapH / 2 };
  }

  if (zone === "defend_crystal") {
    // Position between own crystal and the nearest visible threat
    const ownPlayerId = match.players.find(p => p?.color === playerColor)?.playerId ?? "";
    const ownCrystal = [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === ownPlayerId);
    const cristalX = ownCrystal?.x ?? (isBlue ? 100 : mapW - 100);
    const crystalY = ownCrystal?.y ?? mapH / 2;

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

export function findNode(
  match: MatchState,
  playerId: string,
  choice: MacroAction["nodeChoice"],
  nearEntity: MatchEntity
): (typeof match.resourceNodes)[0] | undefined {
  const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
  const isBlue = match.players[playerIdx]?.color === "blue";
  const mapW = match.config?.mapWidth ?? MAP.width;
  const mid = mapW / 2;

  const availableNodes = match.resourceNodes.filter(n =>
    n.remaining >= MIN_NODE_REMAINING && n.gathererSlots.size < n.maxGathererSlots
  );

  if (choice === "nearest_safe") {
    const safe = availableNodes.filter(n => isBlue ? n.x < mid : n.x > mid);
    return safe.sort((a, b) => dist2(a, nearEntity) - dist2(b, nearEntity))[0];
  }
  if (choice === "nearest_contested") {
    const cont = availableNodes.filter(n => Math.abs(n.x - mid) < mapW * 0.35);
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

/** Units each garrisoned node keeps (attack_move garrison, G-8). */
const GARRISON_SIZE = 2;
/** attack_move regroupAt: units further than this behind the lead regroup; a wave needs REGROUP_MIN together. */
const REGROUP_GAP = 500;
const REGROUP_MIN = 4;

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}
