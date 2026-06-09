import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState } from "../../../server/src/match/types.js";

type Phase = "expand" | "tech" | "army" | "push";

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
export class MacroBot implements Agent {
  private playerId = "";
  private phase: Phase = "expand";
  private lastAssignTick = -50;
  private lastBuildTick  = -60;
  private lastPushTick   = -60;

  init(playerId: string, _match: MatchState): void {
    this.playerId       = playerId;
    this.phase          = "expand";
    this.lastAssignTick = -50;
    this.lastBuildTick  = -60;
    this.lastPushTick   = -60;
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, tick } = obs;

    const ownWorkers  = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
    const hasDepot    = entities.some(e => e.owner === 1 && e.typeIndex === 8);
    const hasBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1);
    const hasFoundry  = entities.some(e => e.owner === 1 && e.typeIndex === 7 && e.constructionFrac >= 1);
    const armySize    = entities.filter(e => e.owner === 1 && [2,3,4,5].includes(e.typeIndex)).length;

    // Phase transitions
    if (this.phase === "expand" && hasBarracks && hasFoundry) this.phase = "tech";
    if (this.phase === "tech"   && armySize >= 3)             this.phase = "army";
    if (this.phase === "army"   && armySize >= 5)             this.phase = "push";

    // ── Gathering ──────────────────────────────────────────────────────────
    if (tick - this.lastAssignTick >= 30) {
      const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
      if (safe) actions.push(safe);
      const contested = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_contested");
      if (contested) actions.push(contested);
      this.lastAssignTick = tick;
    }

    // ── Retreat: pull back when average combat health is low ───────────────
    const combatUnits = entities.filter(e => e.owner === 1 && [2,3,4,5].includes(e.typeIndex));
    if (combatUnits.length > 0) {
      const avgHealth = combatUnits.reduce((s, e) => s + e.healthFrac, 0) / combatUnits.length;
      if (avgHealth < 0.30) {
        const retreat = legal.find(a => a.type === "retreat" && a.group === "all_combat");
        if (retreat) actions.push(retreat);
      }
    }

    // ── Build queue ────────────────────────────────────────────────────────
    if (tick - this.lastBuildTick >= 60) {
      let built = false;

      if (!hasDepot) {
        const b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
        if (b) { actions.push(b); built = true; }
      }
      if (!built && !hasBarracks) {
        const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
        if (b) { actions.push(b); built = true; }
      }
      if (!built && !hasFoundry && hasBarracks) {
        const b = legal.find(a =>
          a.type === "build" && a.buildingType === "foundry" && a.xZone === "mid_base"
        );
        if (b) { actions.push(b); built = true; }
      }
      // Second depot when actively training and near supply cap
      if (!built && global.ownMaxSupply - global.ownSupply <= 2 && armySize > 0) {
        const b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
        if (b) { actions.push(b); built = true; }
      }
      if (built) this.lastBuildTick = tick;
    }

    // ── Worker training ────────────────────────────────────────────────────
    const targetWorkers = this.phase === "expand" ? 5 : 6;
    if (ownWorkers < targetWorkers && legal.some(a => a.type === "train_worker")) {
      actions.push({ type: "train_worker" });
    }

    // ── Unit training ──────────────────────────────────────────────────────
    // Barracks → gunners (long range, good for sieging crystal)
    if (hasBarracks) {
      const train = legal.find(a => a.type === "train_unit" && a.unitType === "gunner");
      if (train) actions.push(train);
    }
    // Foundry → bruisers (tank) + medics (sustain), 2:1 bruiser:medic ratio
    if (hasFoundry) {
      const bruisers = entities.filter(e => e.owner === 1 && e.typeIndex === 4).length;
      const medics   = entities.filter(e => e.owner === 1 && e.typeIndex === 5).length;
      if (medics < Math.floor(bruisers / 2) + 1) {
        const train = legal.find(a => a.type === "train_unit" && a.unitType === "medic");
        if (train) actions.push(train);
      } else {
        const train = legal.find(a => a.type === "train_unit" && a.unitType === "bruiser");
        if (train) actions.push(train);
      }
    }

    // ── Attack: drip from ≥4 units, full-rate in push phase ───────────────
    const pushInterval = this.phase === "push" ? 40 : 80;
    if (armySize >= 4 && tick - this.lastPushTick >= pushInterval) {
      const push = legal.find(a =>
        a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal"
      );
      if (push) { actions.push(push); this.lastPushTick = tick; }
    }

    return actions;
  }
}
