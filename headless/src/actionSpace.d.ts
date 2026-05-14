import type { MacroAction } from "./types.js";
import type { MatchState } from "../../server/src/match/types.js";
/**
 * Expand a MacroAction into the raw engine commands it represents.
 * Returns an array of command objects accepted by MatchEngine.processCommand.
 */
export declare function expandMacroAction(action: MacroAction, match: MatchState, playerId: string): Record<string, unknown>[];
