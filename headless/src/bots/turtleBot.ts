import type { Agent, PlayerObservation, MacroAction } from "../types.js";
import type { MatchState, ResourceNode } from "../../../server/src/match/types.js";

/**
 * TurtleBot — node-control strategy (G-8).
 *
 * Plays for the control win (hold a majority of contested nodes long enough):
 *   - Strong economy (up to 7 workers), gathering from all nodes
 *   - A turret beside each contested node on its own half, nearest first
 *   - One barracks of gunners that holds its own nodes at home
 *   - Once the army reaches 8, it takes the nearest enemy-side node to reach a
 *     majority and holds it; below 4 it falls back to its own nodes
 *   - Defends the crystal when enemy units come close
 */
export class TurtleBot implements Agent {
  private playerId = "";
  private slot: 0 | 1 = 0;
  private match!: MatchState;
  private lastAssignTick = -50;
  private lastBuildTick  = -60;
  private lastMoveTick   = -60;
  private pushing = false;
  private static readonly PUSH_SIZE = 8;

  init(playerId: string, match: MatchState): void {
    this.playerId       = playerId;
    this.match          = match;
    this.slot           = match.players[0]?.playerId === playerId ? 0 : 1;
    this.lastAssignTick = -50;
    this.lastBuildTick  = -60;
    this.lastMoveTick   = -60;
    this.pushing        = false;
  }

  step(obs: PlayerObservation, legal: MacroAction[]): MacroAction[] {
    const actions: MacroAction[] = [];
    const { global, entities, tick } = obs;
    const match = this.match;

    const ownWorkers   = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
    const hasDepot     = entities.some(e => e.owner === 1 && e.typeIndex === 8);
    const ownsBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6);
    const hasBarracks  = entities.some(e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1);
    const armySize     = entities.filter(e => e.owner === 1 && [2, 3, 4, 5].includes(e.typeIndex)).length;
    const oppArmy      = global.oppVisibleSupply ?? 0;

    // ── Node bookkeeping (node positions and control are public) ──────────
    const crystal = [...match.entities.values()].find(e => e.type === "crystal" && e.ownerId === this.playerId);
    const cx = crystal?.x ?? 0, cy = crystal?.y ?? 0;
    const byDist = (a: ResourceNode, b: ResourceNode) =>
      Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy);
    const mid = match.config.mapWidth / 2;
    const ownSide = (n: ResourceNode) => (n.x < mid) === (this.slot === 0);
    const contested = match.resourceNodes.filter(n => n.contested);
    const ownNodes   = contested.filter(ownSide).sort(byDist);
    const enemyNodes = contested.filter(n => !ownSide(n)).sort(byDist);
    const turrets = [...match.entities.values()].filter(e =>
      e.ownerId === this.playerId && e.type === "building" && e.buildingType === "turret");
    const unturreted = ownNodes.filter(n => !turrets.some(t => Math.hypot(t.x - n.x, t.y - n.y) <= 130));

    // ── Gathering ──────────────────────────────────────────────────────────
    if (tick - this.lastAssignTick >= 40) {
      const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
      if (safe) actions.push(safe);
      if (oppArmy < 3) {
        const c = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_contested");
        if (c) actions.push(c);
      }
      this.lastAssignTick = tick;
    }

    // ── Build queue ────────────────────────────────────────────────────────
    if (tick - this.lastBuildTick >= 60) {
      const turret = legal.find(a => a.type === "build" && a.buildingType === "turret");
      const turretAt = (n: ResourceNode): MacroAction | undefined =>
        turret ? { ...turret, nodeId: n.id } : undefined;
      let b: MacroAction | undefined;
      if (!hasDepot) b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
      else if (unturreted.length > ownNodes.length - 2) b = turretAt(unturreted[0]);
      else if (!ownsBarracks) b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
      else if (global.ownMaxSupply - global.ownSupply * global.ownMaxSupply <= 2) b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
      else if (unturreted.length > 0) b = turretAt(unturreted[0]);
      if (b) { actions.push(b); this.lastBuildTick = tick; }
    }

    // ── Training ───────────────────────────────────────────────────────────
    if (ownWorkers < 7 && legal.some(a => a.type === "train_worker")) actions.push({ type: "train_worker" });
    if (hasBarracks) {
      const train = legal.find(a => a.type === "train_unit" && a.unitType === "gunner");
      if (train) actions.push(train);
    }

    // ── Army: hold own nodes, push for a majority when strong ─────────────
    if (!this.pushing && armySize >= TurtleBot.PUSH_SIZE) this.pushing = true;
    if (this.pushing && armySize < TurtleBot.PUSH_SIZE / 2) this.pushing = false;
    if (armySize > 0 && tick - this.lastMoveTick >= 50) {
      const opp = 1 - this.slot;
      const threat = [...match.entities.values()].some(e =>
        e.ownerId !== this.playerId && e.ownerId !== "" && e.type !== "crystal" && e.type !== "building" &&
        e.type !== "worker" && Math.hypot(e.x - cx, e.y - cy) < 500);
      let move: MacroAction | undefined;
      if (threat) {
        move = legal.find(a => a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "defend_crystal");
      } else {
        const lost = ownNodes.find(n => n.controller === opp);
        const target = this.pushing
          ? enemyNodes.find(n => n.controller === this.slot) ?? enemyNodes[0]
          : lost ?? ownNodes[ownNodes.length - 1];
        const am = legal.find(a => a.type === "attack_move" && a.group === "all_combat");
        if (am && target) move = { ...am, nodeId: target.id };
      }
      if (move) { actions.push(move); this.lastMoveTick = tick; }
    }

    return actions;
  }
}
