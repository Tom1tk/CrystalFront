import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";

/**
 * RushBot — one worker per resource node, then skirmisher spam into the opponent's base.
 *
 * Philosophy: spend the absolute minimum on economy (exactly enough workers to cover every
 * visible node, one per slot), build barracks as early as possible, then produce skirmishers
 * non-stop and push them toward the enemy crystal every 15 ticks.  No defense.  No retreat.
 * A second barracks is added once the first wave is rolling to double throughput.
 * Supply depots are built exactly when training would otherwise stall at the cap.
 */
export class RushBot implements Agent {
  private isBlue = true;
  private lastAssignTick = -30;
  private lastPushTick   = -15;
  private lastDepotTick  = -60;

  init(playerId: string, match: MatchState): void {
    const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
    this.isBlue      = match.players[playerIdx]?.color === "blue";
    this.lastAssignTick = -30;
    this.lastPushTick   = -15;
    this.lastDepotTick  = -60;
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, nodes, tick } = obs;

    // ── Census ────────────────────────────────────────────────────────────────
    const ownWorkers    = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
    const skirmishers   = entities.filter(e => e.owner === 1 && e.typeIndex === 2).length;
    const barracksCount = entities.filter(e => e.owner === 1 && e.typeIndex === 6).length;

    // One worker per visible node: safe (own-side) + contested (middle)
    const safeNodes   = nodes.filter(n => !n.isContested && (this.isBlue ? n.xNorm < 0.5 : n.xNorm > 0.5));
    const middleNodes = nodes.filter(n => n.isContested);
    // Only send workers to middle once local economy is established
    const workerTarget = barracksCount > 0
      ? safeNodes.length + middleNodes.length
      : safeNodes.length;

    // ── Assign idle workers to nodes ──────────────────────────────────────────
    if (tick - this.lastAssignTick >= 20) {
      const safe = legal.find(a =>
        a.type === "assign_workers" && a.nodeChoice === "nearest_safe" && a.workerCount === "all_idle"
      );
      if (safe) actions.push(safe);
      // Also contest middle nodes once barracks is up
      if (barracksCount > 0) {
        const mid = legal.find(a =>
          a.type === "assign_workers" && a.nodeChoice === "nearest_contested" && a.workerCount === "all_idle"
        );
        if (mid) actions.push(mid);
      }
      this.lastAssignTick = tick;
    }

    // ── Train workers (exactly up to node target) ─────────────────────────────
    if (ownWorkers < workerTarget) {
      const tw = legal.find(a => a.type === "train_worker");
      if (tw) actions.push(tw);
    }

    // ── Build barracks ────────────────────────────────────────────────────────
    // First barracks: mid-base as soon as economy allows
    if (barracksCount === 0) {
      const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
      if (b) actions.push(b);
    }

    // Second barracks (forward position) once the first wave of skirmishers is launched
    if (barracksCount === 1 && skirmishers >= 4) {
      const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "forward");
      if (b) actions.push(b);
    }

    // ── Supply depot — only when training would stall at cap ──────────────────
    const canTrainSkirmisher = legal.some(a => a.type === "train_unit" && a.unitType === "skirmisher");
    const atSupplyCap = barracksCount > 0 && !canTrainSkirmisher &&
      global.ownMaxSupply - global.ownSupply * global.ownMaxSupply <= 2;
    if (atSupplyCap && tick - this.lastDepotTick >= 60) {
      const depot = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
      if (depot) { actions.push(depot); this.lastDepotTick = tick; }
    }

    // ── Train skirmishers ─────────────────────────────────────────────────────
    const train = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
    if (train) actions.push(train);

    // ── Push toward enemy crystal ─────────────────────────────────────────────
    if (skirmishers > 0 && tick - this.lastPushTick >= 25) {
      const push = legal.find(a =>
        a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal"
      );
      if (push) { actions.push(push); this.lastPushTick = tick; }
    }

    return actions;
  }
}
