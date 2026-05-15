import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * MacroBot — the most sophisticated scripted opponent.
 *
 * Strategy: economy-first, then a mixed gunner/bruiser/medic army.
 * Gunners provide long-range fire; bruisers absorb damage; medics sustain the push.
 *
 * Features:
 *   - Depot only when supply headroom ≤ 2 and actively training units
 *   - Per-group retreat when average unit health drops below 30%
 *   - Adaptive barracks y-zone (shifts if barracks is destroyed)
 *   - Drip attack once 4+ units exist; full-rate push in "push" phase
 */
export declare class MacroBot implements Agent {
    private playerId;
    private phase;
    private lastAssignTick;
    private lastBuildTick;
    private lastPushTick;
    private barracksYZone;
    private prevBarracksCount;
    private barracksYZones;
    private barracksZoneIdx;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
