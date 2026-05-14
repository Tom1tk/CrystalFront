/**
 * Stable enumeration of every possible MacroAction as an integer index.
 * PPO outputs a discrete integer; the environment maps it back to a MacroAction
 * using indexToAction(), then masks illegal indices via getLegalActions().
 *
 * The order here is fixed — never reorder without bumping the spec version.
 */
import type { MacroAction } from "./types.js";

const UNIT_TYPES   = ["skirmisher", "gunner", "bruiser", "medic"] as const;
const BLDG_TYPES   = ["barracks", "foundry", "supply_depot", "turret"] as const;
const X_ZONES      = ["near_crystal", "mid_base", "forward"] as const;
const Y_ZONES      = ["top", "middle", "bottom"] as const;
const GROUPS       = ["all_combat", "skirmishers", "gunners", "bruisers"] as const;
const TARGET_ZONES = ["enemy_crystal", "midfield", "contested_node"] as const;
const NODE_CHOICES = ["nearest_safe", "nearest_contested", "richest_visible"] as const;
const WORKER_COUNTS = [1, 2, 3, "all_idle"] as const;

function buildAllActions(): MacroAction[] {
  const actions: MacroAction[] = [];

  // 0: noop
  actions.push({ type: "noop" });

  // 1: train_worker
  actions.push({ type: "train_worker" });

  // 2–5: train_unit × 4
  for (const unitType of UNIT_TYPES) {
    actions.push({ type: "train_unit", unitType });
  }

  // 6–41: build × (4 bldg × 3 x × 3 y) = 36
  for (const buildingType of BLDG_TYPES) {
    for (const xZone of X_ZONES) {
      for (const yZone of Y_ZONES) {
        actions.push({ type: "build", buildingType, xZone, yZone });
      }
    }
  }

  // 42–53: attack_move × (4 groups × 3 zones) = 12
  for (const group of GROUPS) {
    for (const targetZone of TARGET_ZONES) {
      actions.push({ type: "attack_move", group, targetZone });
    }
  }

  // 54–57: retreat × 4 groups
  for (const group of GROUPS) {
    actions.push({ type: "retreat", group });
  }

  // 58–69: assign_workers × (3 choices × 4 counts) = 12
  for (const nodeChoice of NODE_CHOICES) {
    for (const workerCount of WORKER_COUNTS) {
      actions.push({ type: "assign_workers", nodeChoice, workerCount });
    }
  }

  // 70–72: set_rally × 3 zones
  for (const targetZone of TARGET_ZONES) {
    actions.push({ type: "set_rally", targetZone });
  }

  return actions;
}

export const ALL_ACTIONS: ReadonlyArray<MacroAction> = buildAllActions();
export const ACTION_SPACE_SIZE = ALL_ACTIONS.length;  // 73

/**
 * Convert a MacroAction to its canonical integer index.
 * Returns -1 if the action is not in the enumeration (should never happen in practice).
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
 * Used by PPO to zero out illegal logits before sampling.
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
  if (a.yZone !== b.yZone) return false;
  if (a.group !== b.group) return false;
  if (a.targetZone !== b.targetZone) return false;
  if (a.nodeChoice !== b.nodeChoice) return false;
  if (a.workerCount !== b.workerCount) return false;
  return true;
}
