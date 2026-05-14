import type { MacroAction } from "./types.js";
import type { MatchState } from "../../server/src/match/types.js";
import { BUILDING_DEFS, UNIT_DEFS, ECONOMY } from "@crystalfront/shared";

/**
 * Returns the set of macro-actions that are currently legal for the given player.
 * "Legal" means the action is structurally possible (enough resources, supply,
 * correct buildings exist, etc.) — not that it's necessarily wise.
 */
export function getLegalActions(match: MatchState, playerId: string): MacroAction[] {
  const legal: MacroAction[] = [{ type: "noop" }];

  const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
  if (playerIdx < 0) return legal;

  const economy = match.economy[playerIdx];
  if (!economy) return legal;

  const ownEntities = [...match.entities.values()].filter(e => e.ownerId === playerId);
  const workers = ownEntities.filter(e => e.type === "worker");
  const idleWorkers = workers.filter(e => !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId);
  const completedBuildings = ownEntities.filter(e => e.type === "building" && e.constructionProgress >= 100);
  const combatUnits = ownEntities.filter(e => ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type));

  // train_worker — needs resources and supply headroom
  if (
    economy.resources >= ECONOMY.workerTrainCost &&
    economy.supply + ECONOMY.workerSupplyCost <= economy.maxSupply
  ) {
    legal.push({ type: "train_worker" });
  }

  // train_unit — per unit type, per available building
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
    if (canProduce) {
      legal.push({ type: "train_unit", unitType });
    }
  }

  // build — needs resources, idle workers, and a valid building type
  if (idleWorkers.length > 0) {
    for (const buildingType of ["barracks", "foundry", "supply_depot", "turret"] as const) {
      const def = BUILDING_DEFS[buildingType];
      if (economy.resources >= def.cost) {
        for (const xZone of ["near_crystal", "mid_base", "forward"] as const) {
          for (const yZone of ["top", "middle", "bottom"] as const) {
            legal.push({ type: "build", buildingType, xZone, yZone });
          }
        }
      }
    }
  }

  // attack_move — needs combat units
  if (combatUnits.length > 0) {
    const groups: MacroAction["group"][] = ["all_combat"];
    if (combatUnits.some(e => e.type === "skirmisher")) groups.push("skirmishers");
    if (combatUnits.some(e => e.type === "gunner"))     groups.push("gunners");
    if (combatUnits.some(e => e.type === "bruiser"))    groups.push("bruisers");

    for (const group of groups) {
      for (const targetZone of ["enemy_crystal", "midfield", "contested_node"] as const) {
        legal.push({ type: "attack_move", group, targetZone });
      }
    }
  }

  // retreat — needs units that can retreat
  if (combatUnits.length > 0) {
    legal.push({ type: "retreat", group: "all_combat" });
  }

  // assign_workers — needs idle workers and available nodes
  if (idleWorkers.length > 0) {
    const hasNodes = match.resourceNodes.some(
      n => n.remaining > 0 && n.gathererSlots.size < n.maxGathererSlots
    );
    if (hasNodes) {
      for (const nodeChoice of ["nearest_safe", "nearest_contested", "richest_visible"] as const) {
        for (const count of [1, 2, 3, "all_idle"] as const) {
          legal.push({ type: "assign_workers", nodeChoice, workerCount: count });
        }
      }
    }
  }

  // set_rally — needs completed buildings
  if (completedBuildings.length > 0) {
    for (const targetZone of ["enemy_crystal", "midfield", "contested_node"] as const) {
      legal.push({ type: "set_rally", targetZone });
    }
  }

  return legal;
}
