import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";

type Phase = "expand" | "tech" | "army" | "push";

/**
 * MacroBot — expand economy first, then foundry for bruisers/medics, then push with a mixed army.
 * This is the "balanced" scripted opponent and the hardest of the four scripted bots.
 */
export class MacroBot implements Agent {
  private playerId = "";
  private phase: Phase = "expand";
  private lastAssignTick = -50;
  private lastBuildTick = -60;
  private lastPushTick = -60;

  init(playerId: string, _match: MatchState): void {
    this.playerId = playerId;
    this.phase = "expand";
    this.lastAssignTick = -50;
    this.lastBuildTick = -60;
    this.lastPushTick = -60;
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, tick } = obs;

    // Always gather — contested nodes once safe are saturated
    if (tick - this.lastAssignTick >= 30) {
      const assignSafe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
      if (assignSafe) actions.push(assignSafe);
      const assignContest = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_contested");
      if (assignContest) actions.push(assignContest);
      this.lastAssignTick = tick;
    }

    const resources = global.ownResources * 1000;
    const ownWorkers = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
    const hasDepot    = entities.some(e => e.owner === 1 && e.typeIndex === 8);
    const hasBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1);
    const hasFoundry  = entities.some(e => e.owner === 1 && e.typeIndex === 7 && e.constructionFrac >= 1);
    const armySize    = entities.filter(e => e.owner === 1 && [2,3,4,5].includes(e.typeIndex)).length;

    // Phase transitions
    if (this.phase === "expand" && hasBarracks && hasFoundry) this.phase = "tech";
    if (this.phase === "tech"   && armySize >= 3)             this.phase = "army";
    if (this.phase === "army"   && armySize >= 5)             this.phase = "push";

    // Build queue — on a cooldown to avoid hammering idle workers
    if (tick - this.lastBuildTick >= 60) {
      let built = false;

      // First supply depot
      if (!hasDepot && resources >= 50) {
        const b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
        if (b) { actions.push(b); built = true; }
      }
      // Barracks
      if (!built && !hasBarracks && resources >= 75) {
        const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
        if (b) { actions.push(b); built = true; }
      }
      // Foundry
      if (!built && !hasFoundry && hasBarracks && resources >= 100) {
        const b = legal.find(a => a.type === "build" && a.buildingType === "foundry" && a.xZone === "mid_base");
        if (b) { actions.push(b); built = true; }
      }
      // Second supply depot
      if (!built && entities.filter(e => e.owner === 1 && e.typeIndex === 8).length < 2 && resources >= 50) {
        const b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
        if (b) { actions.push(b); built = true; }
      }

      if (built) this.lastBuildTick = tick;
    }

    // Worker training — up to 5 in expand, 6+ later
    const targetWorkers = this.phase === "expand" ? 5 : 6;
    if (ownWorkers < targetWorkers && legal.some(a => a.type === "train_worker")) {
      actions.push({ type: "train_worker" });
    }

    // Unit training — mix of skirmisher + bruiser + medic
    if (hasBarracks) {
      const trainSkirmisher = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
      if (trainSkirmisher) actions.push(trainSkirmisher);
    }
    if (hasFoundry) {
      const skirmishers = entities.filter(e => e.owner === 1 && e.typeIndex === 2).length;
      const bruisers    = entities.filter(e => e.owner === 1 && e.typeIndex === 4).length;
      const medics      = entities.filter(e => e.owner === 1 && e.typeIndex === 5).length;

      // Train bruisers until 2:1 skirmisher:bruiser ratio, then train medics
      if (bruisers < Math.floor(skirmishers / 2)) {
        const train = legal.find(a => a.type === "train_unit" && a.unitType === "bruiser");
        if (train) actions.push(train);
      } else if (medics < 2) {
        const train = legal.find(a => a.type === "train_unit" && a.unitType === "medic");
        if (train) actions.push(train);
      } else {
        const train = legal.find(a => a.type === "train_unit" && a.unitType === "bruiser");
        if (train) actions.push(train);
      }
    }

    // Set rally to midfield once in army/push phase so new units flow forward
    if ((this.phase === "army" || this.phase === "push") && tick % 200 === 0) {
      const rally = legal.find(a => a.type === "set_rally" && a.targetZone === "midfield");
      if (rally) actions.push(rally);
    }

    // Drip attack: push with any available army — don't wait for a full force
    // "push" phase attacks every 40 ticks; "army" phase uses 80-tick intervals
    // so early skirmishes don't cancel attacks too often before the army is full
    const pushInterval = this.phase === "push" ? 40 : 80;
    if (armySize >= 2 && tick - this.lastPushTick >= pushInterval) {
      const push = legal.find(a =>
        a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal"
      );
      if (push) { actions.push(push); this.lastPushTick = tick; }
    }

    return actions;
  }
}
