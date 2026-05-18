/**
 * Stable enumeration of every possible MacroAction as an integer index.
 * PPO outputs a discrete integer; the environment maps it back to a MacroAction
 * using indexToAction(), then masks illegal indices via getLegalActions().
 *
 * v0.1.57-ML changes:
 *   + attack_targeted × 4 groups × 3 targetTypes = 12 (indices 37-48)
 *   + hold_position × 1 = 1 (index 49)
 *   + attack_move 2 new zones × 4 groups = 8 (indices 50-57)
 *   Total: 37 → 58 actions
 *
 * The order here is fixed — never reorder without bumping the spec version.
 */
import type { MacroAction } from "./types.js";

const UNIT_TYPES    = ["skirmisher", "gunner", "bruiser", "medic"] as const;
const BLDG_TYPES    = ["barracks", "foundry", "supply_depot", "turret"] as const;
const X_ZONES       = ["near_crystal", "mid_base", "forward"] as const;
const GROUPS        = ["all_combat", "skirmishers", "gunners", "bruisers"] as const;
const TARGET_ZONES  = ["enemy_crystal", "midfield", "contested_node"] as const;
const NEW_ZONES     = ["enemy_army", "defend_crystal"] as const;
const TARGET_TYPES  = ["nearest_threat", "nearest_enemy", "focus_weakest"] as const;
const NODE_CHOICES  = ["nearest_safe", "nearest_contested", "richest_visible"] as const;

function buildAllActions(): MacroAction[] {
  const actions: MacroAction[] = [];

  // 0: noop (safety-valve when nothing else is legal)
  actions.push({ type: "noop" });

  // 1: train_worker
  actions.push({ type: "train_worker" });

  // 2–5: train_unit × 4
  for (const unitType of UNIT_TYPES) {
    actions.push({ type: "train_unit", unitType });
  }

  // 6–17: build × (4 bldg × 3 x-zones) = 12
  for (const buildingType of BLDG_TYPES) {
    for (const xZone of X_ZONES) {
      actions.push({ type: "build", buildingType, xZone });
    }
  }

  // 18–29: attack_move × (4 groups × 3 zones) = 12 [original zones]
  for (const group of GROUPS) {
    for (const targetZone of TARGET_ZONES) {
      actions.push({ type: "attack_move", group, targetZone });
    }
  }

  // 30–33: retreat × 4 groups
  for (const group of GROUPS) {
    actions.push({ type: "retreat", group });
  }

  // 34–36: assign_workers × 3 node-choices, always "all_idle"
  for (const nodeChoice of NODE_CHOICES) {
    actions.push({ type: "assign_workers", nodeChoice, workerCount: "all_idle" });
  }

  // 37–48: attack_targeted × (4 groups × 3 targetTypes) = 12  [v0.1.57]
  for (const group of GROUPS) {
    for (const targetType of TARGET_TYPES) {
      actions.push({ type: "attack_targeted", group, targetType });
    }
  }

  // 49: hold_position (all_combat)  [v0.1.57]
  actions.push({ type: "hold_position", group: "all_combat" });

  // 50–57: attack_move × (4 groups × 2 new zones) = 8  [v0.1.57]
  for (const group of GROUPS) {
    for (const targetZone of NEW_ZONES) {
      actions.push({ type: "attack_move", group, targetZone });
    }
  }

  return actions;
}

export const ALL_ACTIONS: ReadonlyArray<MacroAction> = buildAllActions();
export const ACTION_SPACE_SIZE = ALL_ACTIONS.length;  // 58

/**
 * Convert a MacroAction to its canonical integer index.
 * Returns -1 if the action is not in the enumeration.
 */
export function actionToIndex(action: MacroAction): number {
  for (let i = 0; i < ALL_ACTIONS.length; i++) {
    if (actionsEqual(action, ALL_ACTIONS[i])) return i;
  }
  return -1;
}

/** Convert an integer index back to its MacroAction. */
export function indexToAction(index: number): MacroAction {
  if (index < 0 || index >= ALL_ACTIONS.length) {
    throw new RangeError(`Action index ${index} out of range [0, ${ALL_ACTIONS.length})`);
  }
  return ALL_ACTIONS[index];
}

/**
 * Given a list of legal actions, return a boolean mask of length ACTION_SPACE_SIZE
 * where mask[i] = true means index i is legal.
 */
export function legalMask(legalActions: MacroAction[]): boolean[] {
  const mask = new Array<boolean>(ACTION_SPACE_SIZE).fill(false);
  for (const a of legalActions) {
    const i = actionToIndex(a);
    if (i >= 0) mask[i] = true;
  }
  return mask;
}

function actionsEqual(a: MacroAction, b: MacroAction): boolean {
  if (a.type !== b.type) return false;
  if (a.unitType !== b.unitType) return false;
  if (a.buildingType !== b.buildingType) return false;
  if (a.xZone !== b.xZone) return false;
  // yZone intentionally ignored — removed from action space
  if (a.group !== b.group) return false;
  if (a.targetZone !== b.targetZone) return false;
  if (a.targetType !== b.targetType) return false;
  if (a.nodeChoice !== b.nodeChoice) return false;
  // workerCount intentionally ignored for assign_workers — always "all_idle" in enumeration
  return true;
}
