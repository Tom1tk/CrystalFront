/**
 * PassiveBot — the lowest curriculum rung.
 *
 * Builds a basic economy and barracks, trains exactly 2 skirmishers for
 * self-defence, then sits still. Never expands to mid nodes. Never attacks.
 *
 * Purpose: curriculum opponent — easier than RushBot, harder than IdleBot.
 * The agent's current policy — with any minimal aggression — should be able
 * to destroy this opponent's crystal, generating the first winning trajectories
 * in 60M+ steps of training.
 */
export class PassiveBot {
    isBlue = true;
    lastAssignTick = -30;
    lastDepotTick = -60;
    totalSkirmishersTrained = 0;
    MAX_SKIRMISHERS = 2;
    init(playerId, match) {
        const playerIdx = match.players.findIndex(p => p?.playerId === playerId);
        this.isBlue = match.players[playerIdx]?.color === "blue";
        this.lastAssignTick = -30;
        this.lastDepotTick = -60;
        this.totalSkirmishersTrained = 0;
    }
    step(obs, legal) {
        const actions = [];
        const { global, entities, nodes, tick } = obs;
        const ownWorkers = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
        const barracksCount = entities.filter(e => e.owner === 1 && e.typeIndex === 6).length;
        const safeNodes = nodes.filter(n => !n.isContested && (this.isBlue ? n.xNorm < 0.5 : n.xNorm > 0.5));
        const workerTarget = safeNodes.length;
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
        if (barracksCount > 0 && this.totalSkirmishersTrained < this.MAX_SKIRMISHERS) {
            const train = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
            if (train) {
                actions.push(train);
                this.totalSkirmishersTrained++;
            }
        }
        // Supply depot only if barracks built and at cap
        const canTrain = legal.some(a => a.type === "train_unit" && a.unitType === "skirmisher");
        const atCap = barracksCount > 0 && !canTrain &&
            global.ownMaxSupply - global.ownSupply * global.ownMaxSupply <= 2;
        if (atCap && this.totalSkirmishersTrained < this.MAX_SKIRMISHERS &&
            tick - this.lastDepotTick >= 60) {
            const depot = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
            if (depot) {
                actions.push(depot);
                this.lastDepotTick = tick;
            }
        }
        // Once both skirmishers are trained, periodically send them to hold midfield.
        // This blocks the blue worker-rush lane and forces the agent to train combat units.
        if (this.totalSkirmishersTrained >= this.MAX_SKIRMISHERS && tick % 300 === 0) {
            const patrol = legal.find(a => a.type === "attack_move" && a.targetZone === "midfield");
            if (patrol)
                actions.push(patrol);
        }
        return actions;
    }
}
