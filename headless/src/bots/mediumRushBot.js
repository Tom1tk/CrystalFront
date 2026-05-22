/**
 * MediumRushBot — intermediate curriculum opponent.
 *
 * Between WeakRushBot and full RushBot:
 *   - First push at tick 200 (early enough to be threatening, late enough to react)
 *   - Cap of 7 skirmishers before going unlimited
 *   - Push every 35 ticks (slower than RushBot's 25)
 *   - No second barracks
 *
 * Intended as Phase 2 training: agent should already know to build barracks
 * from Phase 1, and must now learn to scale up combat units and micro better.
 */
export class MediumRushBot {
    isBlue = true;
    lastAssignTick = -30;
    lastPushTick = -15;
    lastDepotTick = -60;
    totalSkirmishersTrained = 0;
    SOFT_CAP = 7; // push regardless of count after this
    FIRST_PUSH_TICK = 200;
    PUSH_INTERVAL = 35;
    init(playerId, match) {
        const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
        this.isBlue = match.players[playerIdx]?.color === "blue";
        this.lastAssignTick = -30;
        this.lastPushTick = -15;
        this.lastDepotTick = -60;
        this.totalSkirmishersTrained = 0;
    }
    step(obs, legal) {
        const actions = [];
        const { global, entities, nodes, tick } = obs;
        const ownWorkers = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
        const skirmishers = entities.filter(e => e.owner === 1 && e.typeIndex === 2).length;
        const barracksCount = entities.filter(e => e.owner === 1 && e.typeIndex === 6).length;
        const safeNodes = nodes.filter(n => !n.isContested && (this.isBlue ? n.xNorm < 0.5 : n.xNorm > 0.5));
        const workerTarget = barracksCount > 0 ? safeNodes.length + 1 : safeNodes.length;
        if (tick - this.lastAssignTick >= 20) {
            const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe" && a.workerCount === "all_idle");
            if (safe)
                actions.push(safe);
            this.lastAssignTick = tick;
        }
        if (ownWorkers < workerTarget) {
            const tw = legal.find(a => a.type === "train_worker");
            if (tw)
                actions.push(tw);
        }
        if (barracksCount === 0) {
            const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
            if (b)
                actions.push(b);
        }
        const train = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
        if (train) {
            actions.push(train);
            this.totalSkirmishersTrained++;
        }
        const canTrainSkirmisher = legal.some(a => a.type === "train_unit" && a.unitType === "skirmisher");
        const atSupplyCap = barracksCount > 0 && !canTrainSkirmisher &&
            global.ownMaxSupply - global.ownSupply * global.ownMaxSupply <= 2;
        if (atSupplyCap && tick - this.lastDepotTick >= 60) {
            const depot = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
            if (depot) {
                actions.push(depot);
                this.lastDepotTick = tick;
            }
        }
        if (skirmishers > 0 && tick >= this.FIRST_PUSH_TICK && tick - this.lastPushTick >= this.PUSH_INTERVAL) {
            const push = legal.find(a => a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal");
            if (push) {
                actions.push(push);
                this.lastPushTick = tick;
            }
        }
        return actions;
    }
}
