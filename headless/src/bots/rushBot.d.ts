import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * RushBot — fast barracks, mass skirmisher spam, constant pressure.
 *
 * Design: no retreat — this bot commits entirely.  It builds a depot only
 * when it hits supply cap and still wants to train more skirmishers.
 * The barracks y-position is randomised each game to prevent the RL agent
 * learning a single fixed counter-position.
 */
export declare class RushBot implements Agent {
    private playerId;
    private phase;
    private barracksBuilt;
    private lastPushTick;
    private lastAssignTick;
    private lastBuildTick;
    private barracksYZone;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
