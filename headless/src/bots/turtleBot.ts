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
export class TurtleBot implements Agent {
  private playerId = "";
  private lastAssignTick = -50;
  private lastBuildTick  = -60;

  private turretYZones: MacroAction["yZone"][] = ["top", "bottom", "middle"];
  private turretBaseZone = 0;  // increments when a turret is destroyed
  private prevTurretCount = 0;

  init(playerId: string, _match: MatchState): void {
    this.playerId       = playerId;
    this.lastAssignTick = -50;
    this.lastBuildTick  = -60;
    this.prevTurretCount = 0;
    this.turretBaseZone = Math.floor(Math.random() * 3); // vary starting position
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, tick } = obs;

    const ownResourcesWinFrac = global.ownResourcesWinFrac ?? 0;
    const nearGoal  = ownResourcesWinFrac > 0.85;
    const ownWorkers = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
    const turretCount = entities.filter(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1).length;
    const oppArmy   = global.oppVisibleSupply ?? 0;

    // Detect turret destroyed → shift base zone so next replacement lands elsewhere
    if (turretCount < this.prevTurretCount) {
      this.turretBaseZone = (this.turretBaseZone + 1) % this.turretYZones.length;
    }
    this.prevTurretCount = turretCount;

    // ── Gathering ──────────────────────────────────────────────────────────
    if (tick - this.lastAssignTick >= 40) {
      if (oppArmy >= 3) {
        const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
        if (safe) actions.push(safe);
      } else {
        const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
        if (safe) actions.push(safe);
        const contested = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_contested");
        if (contested) actions.push(contested);
      }
      this.lastAssignTick = tick;
    }

    // ── Stop spending when close to goal ───────────────────────────────────
    if (nearGoal) return actions;

    // ── Train workers (primary economy lever) ──────────────────────────────
    if (ownWorkers < 7 && legal.some(a => a.type === "train_worker")) {
      actions.push({ type: "train_worker" });
    }

    // ── Build turrets for defence ──────────────────────────────────────────
    if (tick - this.lastBuildTick >= 60 && turretCount < 3) {
      // Cycle y-zone by count so each turret lands at a different position
      const zoneIdx = (this.turretBaseZone + turretCount) % this.turretYZones.length;
      const yZone   = this.turretYZones[zoneIdx];
      const build = legal.find(a =>
        a.type === "build" && a.buildingType === "turret" &&
        a.xZone === "forward" && a.yZone === yZone
      );
      if (build) { actions.push(build); this.lastBuildTick = tick; }
    }

    return actions;
  }
}
