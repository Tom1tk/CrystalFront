/**
 * Generate ML_AGENT.md §3 action-space tables from the canonical ALL_ACTIONS array.
 * Usage: npx tsx headless/src/printActionTable.ts
 * Output should replace ML_AGENT.md §3 ("Action space") tables.
 */
import { ALL_ACTIONS, ACTION_SPACE_SIZE } from "./actionIndex.js";
import type { MacroAction } from "./types.js";

function describe(a: MacroAction): string {
  switch (a.type) {
    case "noop":           return "no-op";
    case "train_worker":   return "train worker";
    case "train_unit":     return `train unit  [${a.unitType}]`;
    case "build":          return `build ${a.buildingType}  @ ${a.xZone}`;
    case "attack_move":    return `attack_move  [${a.group}]  → ${a.targetZone}`;
    case "retreat":        return `retreat  [${a.group}]`;
    case "assign_workers": return `assign_workers  nodeChoice=${a.nodeChoice}`;
    case "attack_targeted":return `attack_targeted  [${a.group}]  target=${a.targetType}`;
    case "hold_position":  return `hold_position  [${a.group}]`;
    case "set_rally":      return "set_rally (stub)";
    default:               return (a as { type: string }).type;
  }
}

// ── Full table ──────────────────────────────────────────────────────────────
console.log(`> Generated from \`headless/src/actionIndex.ts\` by \`printActionTable.ts\` — `
  + `regenerate after any action-space change.\n`);
console.log(`**Total actions: ${ACTION_SPACE_SIZE}**\n`);
console.log("| Index | Type | Params |");
console.log("|---|---|---|");
for (let i = 0; i < ALL_ACTIONS.length; i++) {
  const a = ALL_ACTIONS[i];
  console.log(`| ${i} | ${a.type} | ${describe(a)} |`);
}

// ── Range summary ───────────────────────────────────────────────────────────
console.log("\n### Range summary\n");
console.log("| Range | Type | Notes |");
console.log("|---|---|---|");
const ranges: [string, string, string][] = [
  ["0",    "noop",            "safety-valve"],
  ["1",    "train_worker",    ""],
  ["2–5",  "train_unit",      "skirmisher / gunner / bruiser / medic"],
  ["6–17", "build",           "4 building types × 3 x-zones (near_crystal / mid_base / forward)"],
  ["18–29","attack_move",     "4 groups × 3 original zones (enemy_crystal / midfield / contested_node)"],
  ["30–33","retreat",         "4 groups"],
  ["34–36","assign_workers",  "3 nodeChoices (nearest_safe / nearest_contested / richest_visible)"],
  ["37–48","attack_targeted", "4 groups × 3 targetTypes (nearest_threat / nearest_enemy / focus_weakest)"],
  ["49",   "hold_position",   "all_combat"],
  ["50–57","attack_move",     "4 groups × 2 new zones (enemy_army / defend_crystal)"],
  ["58–65","attack_targeted", "4 groups × 2 new targetTypes (targeting_friend / spread_fire)"],
  ["66–70","attack_move",     "all_workers × 5 zones"],
  ["71–75","attack_move",     "all_idle_combat × 5 zones"],
  ["76–80","attack_move",     "idle_workers × 5 zones"],
];
for (const [range, type, notes] of ranges) {
  console.log(`| ${range} | ${type} | ${notes} |`);
}
