import type { MacroAction } from "./types.js";
import type { MatchState } from "../../server/src/match/types.js";
/**
 * Returns the set of macro-actions that are currently legal for the given player.
 * "Legal" means the action is structurally possible (enough resources, supply,
 * correct buildings exist, etc.) — not that it's necessarily wise.
 */
export declare function getLegalActions(match: MatchState, playerId: string): MacroAction[];
