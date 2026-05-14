import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * IdleBot — gathers resources from safe nodes, trains workers when cheap, does nothing else.
 * Useful as a baseline that any competent bot should beat easily.
 */
export declare class IdleBot implements Agent {
    private playerId;
    private lastAssignTick;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
