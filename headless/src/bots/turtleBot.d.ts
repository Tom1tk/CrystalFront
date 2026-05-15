import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * TurtleBot — resource-accumulation strategy targeting the passive win condition
 * (hold ≥5000 resources simultaneously).
 *
 * Design:
 *   - Train workers aggressively (up to 7) for maximum income
 *   - Build turrets to deter attackers; no barracks, no combat units
 *   - Gather from all nodes; pull back to safe when enemy army is visible
 *   - Stop all spending when close to the resource win threshold (>85%)
 *   - Turret y-zones rotate naturally by count; shift base on destruction
 */
export declare class TurtleBot implements Agent {
    private playerId;
    private lastAssignTick;
    private lastBuildTick;
    private turretYZones;
    private turretBaseZone;
    private prevTurretCount;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
