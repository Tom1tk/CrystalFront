import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * RushBot — fast barracks, mass skirmisher spam, constant attack-move.
 * Designed to apply early pressure and test whether defensive strategies hold.
 */
export declare class RushBot implements Agent {
    private playerId;
    private phase;
    private barracksBuilt;
    private lastPushTick;
    private lastAssignTick;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
