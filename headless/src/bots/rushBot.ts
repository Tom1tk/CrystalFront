import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";

type Phase = "eco" | "barracks" | "spam" | "push";

/**
 * RushBot — fast barracks, mass skirmisher spam, constant pressure.
 *
 * Design: no retreat — this bot commits entirely.  It builds a depot only
 * when it hits supply cap and still wants to train more skirmishers.
 * The barracks y-position is randomised each game to prevent the RL agent
 * learning a single fixed counter-position.
 */
export class RushBot implements Agent {
  private playerId = "";
  private phase: Phase = "eco";
  private barracksBuilt = false;
  private lastPushTick  = -30;
  private lastAssignTick = -50;
  private lastBuildTick  = -60;

  // Random y-zone for the barracks each game
  private barracksYZone: MacroAction["yZone"] = "middle";

  init(playerId: string, _match: MatchState): void {
    this.playerId      = playerId;
    this.phase         = "eco";
    this.barracksBuilt = false;
    this.lastPushTick  = -30;
    this.lastAssignTick = -50;
    this.lastBuildTick  = -60;
    const zones: MacroAction["yZone"][] = ["top", "middle", "bottom"];
    this.barracksYZone = zones[Math.floor(Math.random() * zones.length)]!;
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, tick } = obs;

    // Always keep workers gathering — safe nodes first, then contest the middle
    if (tick - this.lastAssignTick >= 40) {
      const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
      if (safe) actions.push(safe);
      const contested = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_contested");
      if (contested) actions.push(contested);
      this.lastAssignTick = tick;
    }

    const ownWorkers  = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
    const hasBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const skirmishers = entities.filter(e => e.owner === 1 && e.typeIndex === 2).length;

    // Phase transitions
    if (!hasBarracks && ownWorkers >= 3) {
      this.phase = "barracks";
    } else if (hasBarracks) {
      this.phase = skirmishers >= 3 ? "push" : "spam";
    }

    switch (this.phase) {
      case "eco": {
        if (ownWorkers < 4 && legal.some(a => a.type === "train_worker")) {
          actions.push({ type: "train_worker" });
        }
        break;
      }

      case "barracks": {
        if (!this.barracksBuilt) {
          const build = legal.find(a =>
            a.type === "build" && a.buildingType === "barracks" &&
            a.xZone === "forward" && a.yZone === this.barracksYZone
          );
          if (build) { actions.push(build); this.barracksBuilt = true; }
        }
        break;
      }

      case "spam":
      case "push": {
        // Depot when at supply cap — don't stall training
        if (tick - this.lastBuildTick >= 60 && global.ownMaxSupply - global.ownSupply <= 1) {
          const depot = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
          if (depot) { actions.push(depot); this.lastBuildTick = tick; }
        }

        const train = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
        if (train) actions.push(train);

        if (this.phase === "push" && tick - this.lastPushTick >= 30) {
          const push = legal.find(a =>
            a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal"
          );
          if (push) { actions.push(push); this.lastPushTick = tick; }
        }
        break;
      }
    }

    return actions;
  }
}
