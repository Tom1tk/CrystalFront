import type { MacroAction } from "./types.js";
import type { MatchState } from "../../server/src/match/types.js";
import { BUILDING_DEFS, UNIT_DEFS, ECONOMY } from "@crystalfront/shared";

/** @deprecated — see docs/REVIVAL_PLAN.md (action-forcing was a symptom treatment; keep default-off) */
export interface LegalActionsOpts {
  noopStreak?: number;
  trainUnitStreak?: number;  // ticks since last train_unit action (Variant β')
  forcingScale?: number;     // 0.0 = off, 1.0 = always force when conditions met
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

  // Visibility
  const visibleIds: Set<string> = match.visibilityData?.get(playerId)?.entityIds ?? new Set();

  const ownEntities = [...match.entities.values()].filter(e => e.ownerId === playerId);

  // Action-forcing (Option B curriculum injection — forcingScale=0 is a no-op):
  //   Mode A (noop_streak trigger): no barracks + idle worker + can afford → force build
  //   Mode B (train_unit_streak trigger, Variant β'): barracks ready + <2 units + can afford
  //     → suppress noop AND attack_move so the policy trains instead of attacking with 1 unit
  const forcingScale = opts.forcingScale ?? 0.0;
  let suppressNoop = false;
  let suppressAttackMove = false;

  if (forcingScale > 0) {
    const anyBarracks    = ownEntities.some(e => e.buildingType === "barracks");
    const completedBarracks = ownEntities.filter(
      e => e.type === "building" && e.buildingType === "barracks" && e.constructionProgress >= 100
    );
    const combatUnitsNow = ownEntities.filter(
      e => ["skirmisher", "gunner", "bruiser", "medic"].includes(e.type)
    );
    const barracksBuilders = ownEntities.filter(e => e.type === "worker" && !e.buildTargetId);

    // Mode A: noop_streak >= 30 + no barracks + idle worker + affordable → force build
    const noopStreak = opts.noopStreak ?? 0;
    if (noopStreak >= 30 &&
        !anyBarracks &&
        barracksBuilders.length > 0 &&
        economy.resources >= (BUILDING_DEFS.barracks?.cost ?? 75)) {
      if (Math.random() < forcingScale) suppressNoop = true;
    }

    // Mode B (Variant β'): train_unit_streak >= 50 + barracks ready + <3 units + affordable
    // <3 threshold: force training WHILE 2 pre-placed units still alive (not just after they die)
    // Also suppresses attack_move: prevents "keep attacking with 2 units instead of training 3rd"
    // threshold=50: 4× more frequent than 200, targets trn≥5% for G4'
    const trainUnitStreak = opts.trainUnitStreak ?? 0;
    if (trainUnitStreak >= 50 &&
        completedBarracks.length >= 1 &&
        combatUnitsNow.length < 3 &&
        economy.resources >= 50) {
      if (Math.random() < forcingScale) {
        suppressNoop = true;
        suppressAttackMove = true;
      }
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

  // attack_move (original zones) — gated by suppressAttackMove (Mode B Variant β')
  if (combatUnits.length > 0 && !suppressAttackMove) {
    const groups: MacroAction["group"][] = ["all_combat"];
    if (combatUnits.some(e => e.type === "skirmisher")) groups.push("skirmishers");
    if (combatUnits.some(e => e.type === "gunner"))     groups.push("gunners");
    if (combatUnits.some(e => e.type === "bruiser"))    groups.push("bruisers");

    for (const group of groups) {
      for (const targetZone of ["enemy_crystal", "midfield", "contested_node"] as const) {
        legal.push({ type: "attack_move", group, targetZone });
      }
      legal.push({ type: "attack_move", group, targetZone: "enemy_army" });
      legal.push({ type: "attack_move", group, targetZone: "defend_crystal" });
    }
  }

  // retreat — allowed even when attack_move is suppressed (bot can still fall back)
  if (combatUnits.length > 0) {
    legal.push({ type: "retreat", group: "all_combat" });
  }

  // attack_targeted — gated by suppressAttackMove
  if (combatUnits.length > 0 && hasVisibleEnemy && !suppressAttackMove) {
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

  // hold_position — gated by suppressAttackMove
  if (combatUnits.length > 0 && !suppressAttackMove) {
    legal.push({ type: "hold_position", group: "all_combat" });
  }

  // move_workers — gated by suppressAttackMove
  if (workers.length > 0 && !suppressAttackMove) {
    for (const targetZone of ["enemy_crystal", "midfield", "contested_node", "enemy_army", "defend_crystal"] as const) {
      legal.push({ type: "attack_move", group: "all_workers", targetZone });
    }
  }

  // idle-only combat groups — gated by suppressAttackMove
  const trueIdleCombat = combatUnits.filter(e => !e.moveTarget && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId);
  if (trueIdleCombat.length > 0 && !suppressAttackMove) {
    for (const targetZone of ["enemy_crystal", "midfield", "contested_node", "enemy_army", "defend_crystal"] as const) {
      legal.push({ type: "attack_move", group: "all_idle_combat", targetZone });
    }
  }

  const trueIdleWorkers = workers.filter(e => !e.moveTarget && !e.buildTargetId && !e.gatheringNodeId && !e.attackTargetId);
  if (trueIdleWorkers.length > 0 && !suppressAttackMove) {
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
