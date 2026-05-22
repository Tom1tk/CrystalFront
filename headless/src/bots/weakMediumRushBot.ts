import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";

/**
 * WeakMediumRushBot — curriculum opponent between WeakRushBot and MediumRushBot.
 *
 * Designed to require 2 combat units to beat reliably (vs WeakRushBot's 1):
 *   - First push at tick 300 (vs 400 for weak, 200 for medium)
 *   - Hard cap of 6 skirmishers (vs 4 for weak, ~unlimited for medium)
 *   - Push interval 50 ticks (same as WeakRushBot)
 *
 * Intended as the curriculum step between rush_weak (6000px cleared) and
 * rush_medium (3 units, harder to overcome). Fills the §A6.3 gap from the
 * second ML review: minimum-unit count escalation, one step at a time.
 */
export class WeakMediumRushBot implements Agent {
  private isBlue = true;
  private lastAssignTick = -30;
  private lastPushTick   = -15;
  private lastDepotTick  = -60;
  private totalSkirmishersTrained = 0;

  private readonly MAX_SKIRMISHERS = 6;
  private readonly FIRST_PUSH_TICK = 300;

  init(playerId: string, match: MatchState): void {
    const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
    this.isBlue      = match.players[playerIdx]?.color === "blue";
    this.lastAssignTick = -30;
    this.lastPushTick   = -15;
    this.lastDepotTick  = -60;
    this.totalSkirmishersTrained = 0;
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, nodes, tick } = obs;

    const ownWorkers    = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
    const skirmishers   = entities.filter(e => e.owner === 1 && e.typeIndex === 2).length;
    const barracksCount = entities.filter(e => e.owner === 1 && e.typeIndex === 6).length;

    const safeNodes   = nodes.filter(n => !n.isContested && (this.isBlue ? n.xNorm < 0.5 : n.xNorm > 0.5));
    const workerTarget = safeNodes.length;

    if (tick - this.lastAssignTick >= 20) {
      const safe = legal.find(a =>
        a.type === "assign_workers" && a.nodeChoice === "nearest_safe" && a.workerCount === "all_idle"
      );
      if (safe) actions.push(safe);
      this.lastAssignTick = tick;
    }

    if (ownWorkers < workerTarget) {
      const tw = legal.find(a => a.type === "train_worker");
      if (tw) actions.push(tw);
    }

    if (barracksCount === 0) {
      const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
      if (b) actions.push(b);
    }

    if (this.totalSkirmishersTrained < this.MAX_SKIRMISHERS) {
      const train = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
      if (train) {
        actions.push(train);
        this.totalSkirmishersTrained++;
      }
    }

    const canTrainSkirmisher = legal.some(a => a.type === "train_unit" && a.unitType === "skirmisher");
    const atSupplyCap = barracksCount > 0 && !canTrainSkirmisher &&
      global.ownMaxSupply - global.ownSupply * global.ownMaxSupply <= 2;
    if (atSupplyCap && this.totalSkirmishersTrained < this.MAX_SKIRMISHERS &&
        tick - this.lastDepotTick >= 60) {
      const depot = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
      if (depot) { actions.push(depot); this.lastDepotTick = tick; }
    }

    if (skirmishers > 0 && tick >= this.FIRST_PUSH_TICK && tick - this.lastPushTick >= 50) {
      const push = legal.find(a =>
        a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal"
      );
      if (push) { actions.push(push); this.lastPushTick = tick; }
    }

    return actions;
  }
}
