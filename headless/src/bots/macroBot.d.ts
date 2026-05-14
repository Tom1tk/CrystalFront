import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * MacroBot — expand economy first, then foundry for bruisers/medics, then push with a mixed army.
 * This is the "balanced" scripted opponent and the hardest of the four scripted bots.
 */
export declare class MacroBot implements Agent {
    private playerId;
    private phase;
    private lastAssignTick;
    private lastBuildTick;
    private lastPushTick;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
