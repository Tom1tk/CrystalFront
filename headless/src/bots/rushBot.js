/**
 * RushBot — fast barracks, mass skirmisher spam, constant attack-move.
 * Designed to apply early pressure and test whether defensive strategies hold.
 */
export class RushBot {
    playerId = "";
    phase = "eco";
    barracksBuilt = false;
    lastPushTick = -30;
    lastAssignTick = -50;
    init(playerId, _match) {
        this.playerId = playerId;
        this.phase = "eco";
        this.barracksBuilt = false;
        this.lastPushTick = -30;
        this.lastAssignTick = -50;
    }
    step(obs, legal) {
        const actions = [];
        const { global, entities, tick } = obs;
        // Always keep workers gathering
        if (tick - this.lastAssignTick >= 40) {
            const assign = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
            if (assign) {
                actions.push(assign);
                this.lastAssignTick = tick;
            }
        }
        const ownWorkers = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
        const hasBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6);
        const skirmishers = entities.filter(e => e.owner === 1 && e.typeIndex === 2).length;
        // Phase transitions
        if (!hasBarracks && global.ownResources * 1000 >= 75 && ownWorkers >= 3) {
            this.phase = "barracks";
        }
        else if (hasBarracks) {
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
                    const build = legal.find(a => a.type === "build" && a.buildingType === "barracks" &&
                        a.xZone === "forward" && a.yZone === "middle");
                    if (build) {
                        actions.push(build);
                        this.barracksBuilt = true;
                    }
                }
                break;
            }
            case "spam": {
                const trainSkirmisher = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
                if (trainSkirmisher)
                    actions.push(trainSkirmisher);
                break;
            }
            case "push": {
                // Train more while pushing
                const trainSkirmisher = legal.find(a => a.type === "train_unit" && a.unitType === "skirmisher");
                if (trainSkirmisher)
                    actions.push(trainSkirmisher);
                // Push every 30 ticks
                if (tick - this.lastPushTick >= 30) {
                    const push = legal.find(a => a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal");
                    if (push) {
                        actions.push(push);
                        this.lastPushTick = tick;
                    }
                }
                break;
            }
        }
        return actions;
    }
}
