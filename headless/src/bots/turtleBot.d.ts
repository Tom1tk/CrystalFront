import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * TurtleBot — builds supply depots and turrets, trains gunners, plays defensively.
 * Tests whether offensive strategies can break a fortified position.
 */
export declare class TurtleBot implements Agent {
    private playerId;
    private lastAssignTick;
    private lastBuildTick;
    private depotCount;
    private turretCount;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
