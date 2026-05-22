/**
 * WeakRushBot — curriculum opponent for teaching basic defense.
 *
 * Same philosophy as RushBot (economy + skirmisher spam) but:
 *   - First push delayed until tick 400 (gives agent time to build barracks + train 2 units)
 *   - Hard cap of 4 skirmishers ever produced
 *   - Otherwise identical to RushBot
 *
 * Intended as Phase 1 training opponent: the agent CAN beat this with
 * 1 barracks + 2 skirmishers, making combat wins achievable and providing
 * positive terminal reward to bootstrap combat behavior.
 */
export class WeakRushBot {
    isBlue = true;
    lastAssignTick = -30;
    lastPushTick = -15;
    lastDepotTick = -60;
    totalSkirmishersTrained = 0;
    MAX_SKIRMISHERS = 4;
    FIRST_PUSH_TICK = 400;
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
        const workerTarget = safeNodes.length; // only safe nodes; no middle expansion
        // Assign idle workers
        if (tick - this.lastAssignTick >= 20) {
            const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe" && a.workerCount === "all_idle");
            if (safe)
                actions.push(safe);
            this.lastAssignTick = tick;
        }
        // Train workers up to safe-node count
        if (ownWorkers < workerTarget) {
            const tw = legal.find(a => a.type === "train_worker");
            if (tw)
                actions.push(tw);
        }
        // Build barracks once economy allows
        if (barracksCount === 0) {
            const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
            if (b)
                actions.push(b);
        }
        // Train skirmishers up to the cap
        if (this.totalSkirmishersTrained < this.MAX_SKIRMISHERS) {
            const prevSkirmishers = skirmishers;
            const train = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
            if (train) {
                actions.push(train);
                // Estimate trained this tick (rough: if train is legal and we push it, +1)
                this.totalSkirmishersTrained++;
            }
        }
        // Supply depot only if at cap and can't train
        const canTrainSkirmisher = legal.some(a => a.type === "train_unit" && a.unitType === "skirmisher");
        const atSupplyCap = barracksCount > 0 && !canTrainSkirmisher &&
            global.ownMaxSupply - global.ownSupply * global.ownMaxSupply <= 2;
        if (atSupplyCap && this.totalSkirmishersTrained < this.MAX_SKIRMISHERS &&
            tick - this.lastDepotTick >= 60) {
            const depot = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
            if (depot) {
                actions.push(depot);
                this.lastDepotTick = tick;
            }
        }
        // Delayed first push
        if (skirmishers > 0 && tick >= this.FIRST_PUSH_TICK && tick - this.lastPushTick >= 50) {
            const push = legal.find(a => a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal");
            if (push) {
                actions.push(push);
                this.lastPushTick = tick;
            }
        }
        return actions;
    }
}
