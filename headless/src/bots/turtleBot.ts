import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";

/**
 * TurtleBot — builds supply depots and turrets, trains gunners, plays defensively.
 * Tests whether offensive strategies can break a fortified position.
 */
export class TurtleBot implements Agent {
  private playerId = "";
  private lastAssignTick = -50;
  private lastBuildTick = -80;
  private lastPushTick = -50;
  private depotCount = 0;
  private turretCount = 0;

  init(playerId: string, _match: MatchState): void {
    this.playerId = playerId;
    this.lastAssignTick = -50;
    this.lastBuildTick = -80;
    this.lastPushTick = -50;
    this.depotCount = 0;
    this.turretCount = 0;
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, tick } = obs;

    // Gather from both node types — contested income is essential with new balance
    if (tick - this.lastAssignTick >= 40) {
      const assignSafe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
      if (assignSafe) actions.push(assignSafe);
      const assignContest = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_contested");
      if (assignContest) actions.push(assignContest);
      this.lastAssignTick = tick;
    }

    // Count own structures
    this.depotCount  = entities.filter(e => e.owner === 1 && e.typeIndex === 8 && e.constructionFrac >= 1).length;
    this.turretCount = entities.filter(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1).length;
    const hasBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1);

    const resources = global.ownResources * 1000;

    if (tick - this.lastBuildTick >= 60) {
      // Priority: 1 depot (supply headroom) → barracks (units) → turrets (defense) → 2nd depot
      if (this.depotCount === 0 && resources >= 50) {
        const build = legal.find(a =>
          a.type === "build" && a.buildingType === "supply_depot" && a.xZone === "near_crystal"
        );
        if (build) { actions.push(build); this.lastBuildTick = tick; }
      } else if (!hasBarracks && resources >= 75) {
        const build = legal.find(a =>
          a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base"
        );
        if (build) { actions.push(build); this.lastBuildTick = tick; }
      } else if (this.turretCount < 3 && resources >= 60) {
        const yZones: MacroAction["yZone"][] = ["top", "bottom", "middle"];
        const yZone = yZones[this.turretCount % 3];
        const build = legal.find(a =>
          a.type === "build" && a.buildingType === "turret" &&
          a.xZone === "forward" && a.yZone === yZone
        );
        if (build) { actions.push(build); this.lastBuildTick = tick; }
      }
    }

    // Train gunners when barracks is up
    if (hasBarracks) {
      const trainGunner = legal.find(a => a.type === "train_unit" && a.unitType === "gunner");
      if (trainGunner) actions.push(trainGunner);
    }

    // Counterattack — hold midfield at 3, commit to enemy crystal at 6
    // Cooldown prevents cancelling attacks every tick (move command clears attackTargetId)
    const gunners = entities.filter(e => e.owner === 1 && e.typeIndex === 3).length;
    if (tick - this.lastPushTick >= 40) {
      if (gunners >= 6) {
        const push = legal.find(a =>
          a.type === "attack_move" && a.group === "gunners" && a.targetZone === "enemy_crystal"
        );
        if (push) { actions.push(push); this.lastPushTick = tick; }
      } else if (gunners >= 3) {
        const hold = legal.find(a =>
          a.type === "attack_move" && a.group === "gunners" && a.targetZone === "midfield"
        );
        if (hold) { actions.push(hold); this.lastPushTick = tick; }
      }
    }

    return actions;
  }
}
