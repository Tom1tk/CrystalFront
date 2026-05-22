/**
 * HeavyBot — slow-build, unstoppable heavy army.
 *
 * Core: bruisers (tank) + medics (sustain) + gunners (range).
 * Refuses to push until 8+ units, but when it does it is very hard to stop.
 *
 * Key behaviours:
 *   - Foundry-first (bruisers/medics are the core)
 *   - Barracks added once bruisers are rolling (for gunner range support)
 *   - Depots built pre-emptively in stages as army grows (not reactive to cap)
 *   - 2 forward turrets for early protection while army builds
 *   - Retreat all combat at 35% avg heavy-unit health (preserve expensive units)
 *   - Turret y-zones cycle by count; shift base when one is destroyed
 */
export class HeavyBot {
    playerId = "";
    phase = "eco";
    lastAssignTick = -50;
    lastBuildTick = -60;
    lastPushTick = -60;
    prevTurretCount = 0;
    init(playerId, _match) {
        this.playerId = playerId;
        this.phase = "eco";
        this.lastAssignTick = -50;
        this.lastBuildTick = -60;
        this.lastPushTick = -60;
        this.prevTurretCount = 0;
    }
    step(obs, legal) {
        const actions = [];
        const { global, entities, tick } = obs;
        const ownWorkers = entities.filter(e => e.owner === 1 && e.typeIndex === 1).length;
        const hasFoundry = entities.some(e => e.owner === 1 && e.typeIndex === 7 && e.constructionFrac >= 1);
        const hasBarracks = entities.some(e => e.owner === 1 && e.typeIndex === 6 && e.constructionFrac >= 1);
        const depotCount = entities.filter(e => e.owner === 1 && e.typeIndex === 8).length;
        const armySize = entities.filter(e => e.owner === 1 && [2, 3, 4, 5].includes(e.typeIndex)).length;
        const bruisers = entities.filter(e => e.owner === 1 && e.typeIndex === 4).length;
        const medics = entities.filter(e => e.owner === 1 && e.typeIndex === 5).length;
        const gunners = entities.filter(e => e.owner === 1 && e.typeIndex === 3).length;
        const turretCount = entities.filter(e => e.owner === 1 && e.typeIndex === 9 && e.constructionFrac >= 1).length;
        this.prevTurretCount = turretCount;
        // Phase transitions
        if (this.phase === "eco" && hasFoundry)
            this.phase = "tech";
        if (this.phase === "tech" && armySize >= 4)
            this.phase = "mass";
        if (this.phase === "mass" && armySize >= 8)
            this.phase = "push";
        // ── Gathering ──────────────────────────────────────────────────────────
        if (tick - this.lastAssignTick >= 30) {
            const safe = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_safe");
            if (safe)
                actions.push(safe);
            const contested = legal.find(a => a.type === "assign_workers" && a.nodeChoice === "nearest_contested");
            if (contested)
                actions.push(contested);
            this.lastAssignTick = tick;
        }
        // ── Retreat when heavy units are taking losses ─────────────────────────
        const heavyUnits = entities.filter(e => e.owner === 1 && [4, 5].includes(e.typeIndex));
        if (heavyUnits.length > 0) {
            const avgHealth = heavyUnits.reduce((s, e) => s + e.healthFrac, 0) / heavyUnits.length;
            if (avgHealth < 0.35) {
                const retreat = legal.find(a => a.type === "retreat" && a.group === "all_combat");
                if (retreat)
                    actions.push(retreat);
            }
        }
        // ── Build queue ────────────────────────────────────────────────────────
        if (tick - this.lastBuildTick >= 60) {
            let built = false;
            // 1st depot: headroom for workers + early units
            if (!built && depotCount < 1) {
                const b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
                if (b) {
                    actions.push(b);
                    built = true;
                }
            }
            // Foundry: core production
            if (!built && !hasFoundry) {
                const b = legal.find(a => a.type === "build" && a.buildingType === "foundry" && a.xZone === "mid_base");
                if (b) {
                    actions.push(b);
                    built = true;
                }
            }
            // 2 forward turrets for early defence
            if (!built && turretCount < 2) {
                const b = legal.find(a => a.type === "build" && a.buildingType === "turret" && a.xZone === "forward");
                if (b) {
                    actions.push(b);
                    built = true;
                }
            }
            // 2nd depot when first units exist (pre-emptive, don't wait for cap)
            if (!built && depotCount < 2 && armySize >= 2) {
                const b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
                if (b) {
                    actions.push(b);
                    built = true;
                }
            }
            // Barracks once bruisers are rolling — adds gunner range support
            if (!built && !hasBarracks && bruisers >= 3) {
                const b = legal.find(a => a.type === "build" && a.buildingType === "barracks" && a.xZone === "mid_base");
                if (b) {
                    actions.push(b);
                    built = true;
                }
            }
            // 3rd depot when army is large
            if (!built && depotCount < 3 && armySize >= 6) {
                const b = legal.find(a => a.type === "build" && a.buildingType === "supply_depot");
                if (b) {
                    actions.push(b);
                    built = true;
                }
            }
            if (built)
                this.lastBuildTick = tick;
        }
        // ── Worker training ────────────────────────────────────────────────────
        if (ownWorkers < 6 && legal.some(a => a.type === "train_worker")) {
            actions.push({ type: "train_worker" });
        }
        // ── Unit training: bruiser/medic core, gunners for range ──────────────
        if (hasFoundry) {
            if (medics * 2 < bruisers) {
                const train = legal.find(a => a.type === "train_unit" && a.unitType === "medic");
                if (train)
                    actions.push(train);
            }
            else {
                const train = legal.find(a => a.type === "train_unit" && a.unitType === "bruiser");
                if (train)
                    actions.push(train);
            }
        }
        // 1 gunner per 3 bruisers for ranged support
        if (hasBarracks && gunners < Math.floor(bruisers / 3) + 1) {
            const train = legal.find(a => a.type === "train_unit" && a.unitType === "gunner");
            if (train)
                actions.push(train);
        }
        // ── Attack: only commit with a full heavy force ────────────────────────
        if (armySize >= 8 && tick - this.lastPushTick >= 60) {
            const push = legal.find(a => a.type === "attack_move" && a.group === "all_combat" && a.targetZone === "enemy_crystal");
            if (push) {
                actions.push(push);
                this.lastPushTick = tick;
            }
        }
        return actions;
    }
}
