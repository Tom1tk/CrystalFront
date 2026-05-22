import type { MacroAction } from "./types.js";
import type { MatchState } from "../../server/src/match/types.js";
import { BUILDING_DEFS, UNIT_DEFS, ECONOMY, MAP } from "@crystalfront/shared";

export interface LegalActionsOpts {
  noopStreak?: number;
  forcingScale?: number;  // 0.0 = off, 1.0 = always force when conditions met
}

/**
 * Returns the set of macro-actions that are currently legal for the given player.
 * "Legal" means the action is structurally possible (enough resources, supply,
 * correct buildings exist, etc.) — not that it's necessarily wise.
 *
 * When opts.forcingScale > 0, noop may be suppressed when the policy has been
 * idle for too long and could afford to train a combat unit (action-masking
 * injection for Option B curriculum). Default behaviour (forcingScale=0) is
 * identical to the original function.
 */
export function getLegalActions(match: MatchState, playerId: string, opts: LegalActionsOpts = {}): MacroAction[] {
  const legal: MacroAction[] = [];

  const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
  if (playerIdx < 0) { legal.push({ type: "noop" }); return legal; }

  const economy = match.economy[playerIdx];
  if (!economy) { legal.push({ type: "noop" }); return legal; }

  const isBlue = match.players[playerIdx]?.color === "blue";
  const mid = MAP.width / 2;

  // Visibility
  const visibleIds: Set<string> = match.visibilityData?.get(playerId)?.entityIds ?? new Set();

  const ownEntities = [...match.entities.values()].filter(e => e.ownerId === playerId);

  // Action-forcing: suppress noop when idle too long and a productive action is available.
  // Two trigger modes (Option B curriculum injection — default forcingScale=0 is a no-op):
  //   A) No barracks yet + can afford one → force building (early game responsiveness)
  //   B) Barracks complete + <2 combat units + can afford unit → force training
  const forcingScale = opts.forcingScale ?? 0.0;
  let suppressNoop = false;
  if (forcingScale > 0) {
    const noopStreak = opts.noopStreak ?? 0;
    if (noopStreak >= 30) {
      const anyBarracks = ownEntities.some(e => e.buildingType === "barracks");
      const completedBarracks = ownEntities.filter(
        e => e.type === "building" && e.buildingType === "barracks" && e.constructionProgress >= 100
      );
      const combatUnitsNow = ownEntities.filter(
        e => ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type)
      );
      const barracksBuilders = ownEntities.filter(e => e.type === "worker" && !e.buildTargetId);

      // Mode A: force barracks construction if affordable and none exists/is being built
      const modeA = !anyBarracks &&
        barracksBuilders.length > 0 &&
        economy.resources >= (BUILDING_DEFS.barracks?.cost ?? 75);

      // Mode B: force unit training if barracks ready and army is weak
      const modeB = completedBarracks.length >= 1 &&
        combatUnitsNow.length < 2 &&
        economy.resources >= 50;

      if ((modeA || modeB) && Math.random() < forcingScale) suppressNoop = true;
    }
  }
  if (!suppressNoop) legal.push({ type: "noop" });
  const workers = ownEntities.filter(e => e.type === "worker");
  const idleWorkers = workers.filter(e => !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId);
  const availableBuilders = workers.filter(e => !e.buildTargetId);
  const completedBuildings = ownEntities.filter(e => e.type === "building" && e.constructionProgress >= 100);
  const combatUnits = ownEntities.filter(e => ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type));

  // Visible enemy combat units — needed for targeted attack legality
  const visibleEnemyCombat = [...match.entities.values()].filter(e =>
    e.ownerId !== playerId &&
    visibleIds.has(e.id) &&
    ["skirmisher", "gunner", "bruiser", "medic", "crystal", "building"].includes(e.type)
  );
  const hasVisibleEnemy = visibleEnemyCombat.length > 0;

  // train_worker
  if (
    economy.resources >= ECONOMY.workerTrainCost &&
    economy.supply + ECONOMY.workerSupplyCost <= economy.maxSupply
  ) {
    legal.push({ type: "train_worker" });
  }

  // train_unit — per unit type
  const productionBuildings = completedBuildings.filter(b => b.buildingType);
  const queuedSupply = ownEntities
    .filter(e => e.type === "building")
    .reduce((s, b) => s + (b.productionQueue ?? []).reduce((a, i) => a + i.supplyCost, 0), 0);

  for (const unitType of ["skirmisher", "gunner", "bruiser", "medic"] as const) {
    const def = UNIT_DEFS[unitType];
    if (!def) continue;
    if (economy.resources < def.cost) continue;
    if (economy.supply + queuedSupply + def.supplyCost > economy.maxSupply) continue;
    const canProduce = productionBuildings.some(b => {
      const bdef = b.buildingType ? BUILDING_DEFS[b.buildingType] : null;
      return bdef?.produces?.includes(unitType);
    });
    if (canProduce) legal.push({ type: "train_unit", unitType });
  }

  // build — xZone only
  if (availableBuilders.length > 0) {
    for (const buildingType of ["barracks", "foundry", "supply_depot", "turret"] as const) {
      const def = BUILDING_DEFS[buildingType];
      if (economy.resources >= def.cost) {
        for (const xZone of ["near_crystal", "mid_base", "forward"] as const) {
          legal.push({ type: "build", buildingType, xZone });
        }
      }
    }
  }

  // attack_move (original zones)
  if (combatUnits.length > 0) {
    const groups: MacroAction["group"][] = ["all_combat"];
    if (combatUnits.some(e => e.type === "skirmisher")) groups.push("skirmishers");
    if (combatUnits.some(e => e.type === "gunner"))     groups.push("gunners");
    if (combatUnits.some(e => e.type === "bruiser"))    groups.push("bruisers");

    for (const group of groups) {
      for (const targetZone of ["enemy_crystal", "midfield", "contested_node"] as const) {
        legal.push({ type: "attack_move", group, targetZone });
      }
      // New dynamic zones
      legal.push({ type: "attack_move", group, targetZone: "enemy_army" });
      legal.push({ type: "attack_move", group, targetZone: "defend_crystal" });
    }
  }

  // retreat
  if (combatUnits.length > 0) {
    legal.push({ type: "retreat", group: "all_combat" });
  }

  // attack_targeted — requires combat units AND visible enemies
  if (combatUnits.length > 0 && hasVisibleEnemy) {
    const groups: MacroAction["group"][] = ["all_combat"];
    if (combatUnits.some(e => e.type === "skirmisher")) groups.push("skirmishers");
    if (combatUnits.some(e => e.type === "gunner"))     groups.push("gunners");
    if (combatUnits.some(e => e.type === "bruiser"))    groups.push("bruisers");

    for (const group of groups) {
      for (const targetType of ["nearest_threat", "nearest_enemy", "focus_weakest"] as const) {
        legal.push({ type: "attack_targeted", group, targetType });
      }
    }
  }

  // hold_position — requires combat units
  if (combatUnits.length > 0) {
    legal.push({ type: "hold_position", group: "all_combat" });
  }

  // move_workers — workers can be sent to any zone (scout / reposition)
  if (workers.length > 0) {
    for (const targetZone of ["enemy_crystal", "midfield", "contested_node", "enemy_army", "defend_crystal"] as const) {
      legal.push({ type: "attack_move", group: "all_workers", targetZone });
    }
  }

  // idle-only groups — legal whenever any idle unit of that type exists
  const trueIdleCombat = combatUnits.filter(e => !e.moveTarget && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId);
  if (trueIdleCombat.length > 0) {
    for (const targetZone of ["enemy_crystal", "midfield", "contested_node", "enemy_army", "defend_crystal"] as const) {
      legal.push({ type: "attack_move", group: "all_idle_combat", targetZone });
    }
  }

  const trueIdleWorkers = workers.filter(e => !e.moveTarget && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId);
  if (trueIdleWorkers.length > 0) {
    for (const targetZone of ["enemy_crystal", "midfield", "contested_node", "enemy_army", "defend_crystal"] as const) {
      legal.push({ type: "attack_move", group: "idle_workers", targetZone });
    }
  }

  // assign_workers — only "all_idle" variant
  if (idleWorkers.length > 0) {
    const hasNodes = match.resourceNodes.some(
      n => n.remaining > 0 && n.gathererSlots.size < n.maxGathererSlots
    );
    if (hasNodes) {
      for (const nodeChoice of ["nearest_safe", "nearest_contested", "richest_visible"] as const) {
        legal.push({ type: "assign_workers", nodeChoice, workerCount: "all_idle" });
      }
    }
  }

  return legal;
}
