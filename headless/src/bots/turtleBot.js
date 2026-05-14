/**
 * TurtleBot — builds supply depots and turrets, trains gunners, plays defensively.
 * Tests whether offensive strategies can break a fortified position.
 */
export class TurtleBot {
    playerId = "";
    lastAssignTick = -50;
    lastBuildTick = -80;
    depotCount = 0;
    turretCount = 0;
    init(playerId, _match) {
        this.playerId = playerId;
        this.lastAssignTick = -50;
        this.lastBuildTick = -80;
        this.depotCount = 0;
        this.turretCount = 0;
    }
    step(obs, legal) {
        const actions = [];
        const { global, entities, tick } = obs;
        // Gather constantly
        if (tick - this.lastAssignTick >= 40) {
            const assign = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
            if (assign) {
                actions.push(assign);
                this.lastAssignTick = tick;
            }
        }
        // Count own structures
        this.depotCount = entities.filter(e => e.owner === 1 && e.typeIndex === 8 && e.constructionFrac >= 1).length;
        this.turretCount = entities.filter(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1).length;
        const hasBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1);
        const resources = global.ownResources * 1000;
        if (tick - this.lastBuildTick >= 80) {
            // Priority: supply depot → barracks → turrets
            if (this.depotCount < 2 && resources >= 50) {
                const build = legal.find(a => a.type === "build" && a.buildingType === "supply_depot" && a.xZone === "near_crystal");
                if (build) {
                    actions.push(build);
                    this.lastBuildTick = tick;
                }
            }
            else if (!hasBarracks && resources >= 75) {
                const build = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
                if (build) {
                    actions.push(build);
                    this.lastBuildTick = tick;
                }
            }
            else if (this.turretCount < 3 && resources >= 60) {
                const yZones = ["top", "bottom", "middle"];
                const yZone = yZones[this.turretCount % 3];
                const build = legal.find(a => a.type === "build" && a.buildingType === "turret" &&
                    a.xZone === "forward" && a.yZone === yZone);
                if (build) {
                    actions.push(build);
                    this.lastBuildTick = tick;
                }
            }
        }
        // Train gunners when barracks is up
        if (hasBarracks) {
            const trainGunner = legal.find(a => a.type === "train_unit" && a.unitType === "gunner");
            if (trainGunner)
                actions.push(trainGunner);
        }
        // Counterattack only when army is strong
        const gunners = entities.filter(e => e.owner === 1 && e.typeIndex === 3).length;
        if (gunners >= 6) {
            const push = legal.find(a => a.type === "attack_move" && a.group === "gunners" && a.targetZone === "midfield");
            if (push)
                actions.push(push);
        }
        return actions;
    }
}
