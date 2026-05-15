import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";
/**
 * HeavyBot — slow-build, unstoppable heavy army.
 *
 * Core: bruisers (tank) + medics (sustain) + gunners (range).
 * Refuses to push until 8+ units, but when it does it is very hard to stop.
 *
 * Key behaviours:
 *   - Foundry-first (bruisers/medics are the core)
 *   - Barracks added once bruisers are rolling (for gunner range support)
 *   - Depots built pre-emptively in stages as army grows (not reactive to cap)
 *   - 2 forward turrets for early protection while army builds
 *   - Retreat all combat at 35% avg heavy-unit health (preserve expensive units)
 *   - Turret y-zones cycle by count; shift base when one is destroyed
 */
export declare class HeavyBot implements Agent {
    private playerId;
    private phase;
    private lastAssignTick;
    private lastBuildTick;
    private lastPushTick;
    private turretYZones;
    private turretBaseZone;
    private prevTurretCount;
    init(playerId: string, _match: MatchState): void;
    step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[];
}
