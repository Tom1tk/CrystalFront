/**
 * IdleBot — gathers resources from safe nodes, trains workers when cheap, does nothing else.
 * Useful as a baseline that any competent bot should beat easily.
 */
export class IdleBot {
    playerId = "";
    lastAssignTick = -50;
    init(playerId, _match) {
        this.playerId = playerId;
    }
    step(obs, legal) {
        const actions = [];
        // Assign idle workers to safe nodes every 50 ticks
        if (obs.tick - this.lastAssignTick >= 50) {
            const assign = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
            if (assign) {
                actions.push(assign);
                this.lastAssignTick = obs.tick;
            }
        }
        // Train a worker if we have resources and no active gathering yet
        const workerCount = obs.entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
        if (workerCount < 5 && legal.some(a => a.type === "train_worker")) {
            actions.push({ type: "train_worker" });
        }
        return actions;
    }
}
