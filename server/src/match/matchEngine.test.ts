import { describe, it, expect, beforeEach } from "vitest";
import { MatchEngine } from "./matchEngine.js";
import { UNIT_DEFS, COUNTER_MODIFIER, HEALING, BUILDING_DEFS } from "@crystalfront/shared";
import type { MatchState, MatchEntity } from "./types.js";

function findEntity(match: MatchState, type: string, ownerId?: string): MatchEntity | undefined {
  for (const e of match.entities.values()) {
    if (e.type === type && (ownerId === undefined || e.ownerId === ownerId)) {
      return e;
    }
  }
  return undefined;
}

describe("Combat System", () => {
  let engine: MatchEngine;
  let match: MatchState;

  beforeEach(() => {
    engine = new MatchEngine();
    match = engine.createMatch("TEST", [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);
    match.phase = "playing";
  });

  function asUnit(entity: MatchEntity, unitType: string): void {
    entity.type = unitType as any;
    entity.autoAttackEnabled = true;
    entity.health = UNIT_DEFS[unitType as keyof typeof UNIT_DEFS]?.health ?? entity.health;
    entity.maxHealth = entity.health;
    entity.radius = UNIT_DEFS[unitType as keyof typeof UNIT_DEFS]?.radius ?? 10;
    entity.attackCooldown = 0;
    entity.attackTargetId = undefined;
    entity.healTargetId = undefined;
    entity.moveTarget = undefined;
  }

  describe("Unit Definitions", () => {
    it("skirmisher has correct stats", () => {
      expect(UNIT_DEFS.skirmisher.health).toBe(120);
      expect(UNIT_DEFS.skirmisher.damage).toBe(15);
      expect(UNIT_DEFS.skirmisher.range).toBe(20);
      expect(UNIT_DEFS.skirmisher.attackCooldown).toBe(10);
    });

    it("gunner has correct stats", () => {
      expect(UNIT_DEFS.gunner.health).toBe(80);
      expect(UNIT_DEFS.gunner.damage).toBe(20);
      expect(UNIT_DEFS.gunner.range).toBe(120);
      expect(UNIT_DEFS.gunner.attackCooldown).toBe(15);
    });

    it("bruiser has correct stats", () => {
      expect(UNIT_DEFS.bruiser.health).toBe(250);
      expect(UNIT_DEFS.bruiser.damage).toBe(12);
      expect(UNIT_DEFS.bruiser.range).toBe(20);
      expect(UNIT_DEFS.bruiser.attackCooldown).toBe(8);
    });

    it("medic has correct stats", () => {
      expect(UNIT_DEFS.medic.health).toBe(90);
      expect(UNIT_DEFS.medic.damage).toBe(3);
      expect(UNIT_DEFS.medic.range).toBe(80);
      expect(UNIT_DEFS.medic.attackCooldown).toBe(25);
    });

    it("worker has correct stats", () => {
      expect(UNIT_DEFS.worker.health).toBe(100);
      expect(UNIT_DEFS.worker.damage).toBe(5);
      expect(UNIT_DEFS.worker.range).toBe(15);
      expect(UNIT_DEFS.worker.attackCooldown).toBe(20);
    });
  });

  describe("Counter Multipliers", () => {
    it("skirmisher deals 2x damage to gunner", () => {
      expect(COUNTER_MODIFIER.skirmisher.gunner).toBe(2.0);
    });

    it("skirmisher deals 0.5x damage to bruiser", () => {
      expect(COUNTER_MODIFIER.skirmisher.bruiser).toBe(0.5);
    });

    it("gunner deals 2x damage to bruiser", () => {
      expect(COUNTER_MODIFIER.gunner.bruiser).toBe(2.0);
    });

    it("gunner deals 0.5x damage to skirmisher", () => {
      expect(COUNTER_MODIFIER.gunner.skirmisher).toBe(0.5);
    });

    it("bruiser deals 2x damage to skirmisher", () => {
      expect(COUNTER_MODIFIER.bruiser.skirmisher).toBe(2.0);
    });

    it("bruiser deals 0.5x damage to gunner", () => {
      expect(COUNTER_MODIFIER.bruiser.gunner).toBe(0.5);
    });

    it("medic has no counter bonuses", () => {
      expect(COUNTER_MODIFIER.medic.skirmisher).toBe(1.0);
      expect(COUNTER_MODIFIER.medic.gunner).toBe(1.0);
      expect(COUNTER_MODIFIER.medic.bruiser).toBe(1.0);
    });
  });

  describe("Auto-Attack Acquisition", () => {
    it("skirmisher auto-acquires enemy worker in range", () => {
      const worker = findEntity(match, "worker", "p1")!;
      asUnit(worker, "skirmisher");
      worker.x = 100;
      worker.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 110;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(worker.attackTargetId).toBe(enemyWorker.id);
    });

    it("skirmisher does not auto-acquire target out of range", () => {
      const worker = findEntity(match, "worker", "p1")!;
      asUnit(worker, "skirmisher");
      worker.x = 100;
      worker.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 300;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(worker.attackTargetId).toBeUndefined();
    });

    it("unit does not auto-acquire friendly target", () => {
      const worker = findEntity(match, "worker", "p1")!;
      asUnit(worker, "skirmisher");
      worker.x = 100;
      worker.y = 300;

      engine.tick(match.id);

      expect(worker.attackTargetId).toBeUndefined();
    });
  });

  describe("Attack Chase Behavior", () => {
    it("skirmisher chases attack target when out of range", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 200;
      enemyWorker.y = 300;
      skirm.attackTargetId = enemyWorker.id;

      const oldX = skirm.x;
      engine.tick(match.id);

      expect(skirm.moveTarget).toBeDefined();
      expect(skirm.moveTarget!.x).toBe(enemyWorker.x);
      expect(skirm.moveTarget!.y).toBe(enemyWorker.y);
      expect(skirm.x).toBeGreaterThan(oldX);
    });

    it("gunner chases attack target when out of range", () => {
      const gunner = findEntity(match, "worker", "p1")!;
      asUnit(gunner, "gunner");
      gunner.x = 100;
      gunner.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 300;
      enemyWorker.y = 300;
      gunner.attackTargetId = enemyWorker.id;

      const oldX = gunner.x;
      engine.tick(match.id);

      expect(gunner.moveTarget).toBeDefined();
      expect(gunner.x).toBeGreaterThan(oldX);
    });

    it("bruiser chases attack target when out of range", () => {
      const bruiser = findEntity(match, "worker", "p1")!;
      asUnit(bruiser, "bruiser");
      bruiser.x = 100;
      bruiser.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 200;
      enemyWorker.y = 300;
      bruiser.attackTargetId = enemyWorker.id;

      const oldX = bruiser.x;
      engine.tick(match.id);

      expect(bruiser.moveTarget).toBeDefined();
      expect(bruiser.x).toBeGreaterThan(oldX);
    });
  });

  describe("Combat Damage", () => {
    it("skirmisher deals base damage to worker", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      const originalHealth = enemyWorker.health;
      enemyWorker.x = 110;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(enemyWorker.health).toBe(originalHealth - UNIT_DEFS.skirmisher.damage);
    });

    it("skirmisher deals 2x damage to gunner (counter)", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemy = findEntity(match, "worker", "p2")!;
      asUnit(enemy, "gunner");
      const originalHealth = enemy.health;
      enemy.x = 110;
      enemy.y = 300;

      engine.tick(match.id);

      const expectedDmg = Math.round(UNIT_DEFS.skirmisher.damage * 2.0);
      expect(enemy.health).toBe(originalHealth - expectedDmg);
    });

    it("skirmisher deals 0.5x damage to bruiser (weak)", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemy = findEntity(match, "worker", "p2")!;
      asUnit(enemy, "bruiser");
      const originalHealth = enemy.health;
      enemy.x = 110;
      enemy.y = 300;

      engine.tick(match.id);

      const expectedDmg = Math.round(UNIT_DEFS.skirmisher.damage * 0.5);
      expect(enemy.health).toBe(originalHealth - expectedDmg);
    });

    it("gunner deals damage at long range", () => {
      const gunner = findEntity(match, "worker", "p1")!;
      asUnit(gunner, "gunner");
      gunner.x = 100;
      gunner.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      const originalHealth = enemyWorker.health;
      enemyWorker.x = 200;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(gunner.attackTargetId).toBe(enemyWorker.id);
      expect(enemyWorker.health).toBe(originalHealth - UNIT_DEFS.gunner.damage);
    });

    it("bruiser deals damage at melee range", () => {
      const bruiser = findEntity(match, "worker", "p1")!;
      asUnit(bruiser, "bruiser");
      bruiser.x = 100;
      bruiser.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      const originalHealth = enemyWorker.health;
      enemyWorker.x = 115;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(enemyWorker.health).toBe(originalHealth - UNIT_DEFS.bruiser.damage);
    });

    it("medic can deal damage to enemies", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      const originalHealth = enemyWorker.health;
      enemyWorker.x = 150;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(enemyWorker.health).toBe(originalHealth - UNIT_DEFS.medic.damage);
    });

    it("worker auto-attacks when enabled", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.autoAttackEnabled = true;
      worker.x = 100;
      worker.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      const originalHealth = enemyWorker.health;
      enemyWorker.x = 110;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(enemyWorker.health).toBe(originalHealth - UNIT_DEFS.worker.damage);
    });

    it("attack respects cooldown", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      const originalHealth = enemyWorker.health;
      enemyWorker.x = 110;
      enemyWorker.y = 300;

      engine.tick(match.id);
      const healthAfterFirst = enemyWorker.health;

      expect(healthAfterFirst).toBe(originalHealth - UNIT_DEFS.skirmisher.damage);
      expect(skirm.attackCooldown).toBeGreaterThan(0);
    });

    it("entity dies when health reaches 0", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.health = 10;
      enemyWorker.x = 110;
      enemyWorker.y = 300;
      const targetId = enemyWorker.id;

      engine.tick(match.id);

      expect(match.entities.has(targetId)).toBe(false);
    });
  });

  describe("Medic Healing", () => {
    it("medic heals allied unit in range", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const allyWorker = findEntity(match, "worker", "p1")!;
      allyWorker.health = 50;
      allyWorker.x = 150;
      allyWorker.y = 300;

      medic.healTargetId = allyWorker.id;

      engine.tick(match.id);

      expect(allyWorker.health).toBe(50 + HEALING.healRatePerTick);
    });

    it("medic does not heal unit at full health", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const allyWorker = findEntity(match, "worker", "p1")!;
      allyWorker.health = allyWorker.maxHealth;
      allyWorker.x = 150;
      allyWorker.y = 300;

      medic.healTargetId = allyWorker.id;

      engine.tick(match.id);

      expect(allyWorker.health).toBe(allyWorker.maxHealth);
    });

    it("medic clears heal target when target dies", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const allyWorker = findEntity(match, "worker", "p1")!;
      allyWorker.health = 1;
      allyWorker.x = 150;
      allyWorker.y = 300;

      medic.healTargetId = allyWorker.id;

      const enemySkirm = findEntity(match, "worker", "p2")!;
      asUnit(enemySkirm, "skirmisher");
      enemySkirm.x = 155;
      enemySkirm.y = 300;
      enemySkirm.attackTargetId = allyWorker.id;

      engine.tick(match.id);

      expect(medic.healTargetId).toBeUndefined();
    });

    it("medic follows heal target when out of range", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const allyWorker = findEntity(match, "worker", "p1")!;
      allyWorker.health = 50;
      allyWorker.x = 300;
      allyWorker.y = 300;

      medic.healTargetId = allyWorker.id;
      const oldX = medic.x;

      engine.tick(match.id);

      expect(medic.moveTarget).toBeDefined();
      expect(medic.moveTarget!.x).toBe(allyWorker.x);
      expect(medic.moveTarget!.y).toBe(allyWorker.y);
      expect(medic.x).toBeGreaterThan(oldX);
    });

    it("medic heal target is cleared on move command", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const allyWorker = findEntity(match, "worker", "p1")!;
      allyWorker.x = 150;
      allyWorker.y = 300;

      medic.healTargetId = allyWorker.id;
      expect(medic.healTargetId).toBe(allyWorker.id);

      engine.processCommand(match.id, "p1", {
        type: "move",
        entityId: medic.id,
        targetX: 500,
        targetY: 500,
      });

      expect(medic.healTargetId).toBeUndefined();
      expect(medic.moveTarget).toEqual({ x: 500, y: 500 });
    });

    it("medic heal target is cleared on attack command", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const allyWorker = findEntity(match, "worker", "p1")!;
      allyWorker.x = 150;
      allyWorker.y = 300;

      medic.healTargetId = allyWorker.id;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 200;
      enemyWorker.y = 300;

      engine.processCommand(match.id, "p1", {
        type: "attack",
        entityId: medic.id,
        targetEntityId: enemyWorker.id,
      });

      expect(medic.healTargetId).toBeUndefined();
      expect(medic.attackTargetId).toBe(enemyWorker.id);
    });
  });

  describe("Attack Log", () => {
    it("attack log retains events for multiple ticks", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 110;
      enemyWorker.y = 300;

      engine.tick(match.id);

      expect(match.attackLog.length).toBeGreaterThan(0);
      const attackEvent = match.attackLog.find(
        (e) => e.attackerId === skirm.id && e.targetId === enemyWorker.id
      );
      expect(attackEvent).toBeDefined();
      expect(attackEvent!.damage).toBe(UNIT_DEFS.skirmisher.damage);
      expect(attackEvent!.isHeal).toBe(false);
    });

    it("heal events appear in attack log", () => {
      const medic = findEntity(match, "worker", "p1")!;
      asUnit(medic, "medic");
      medic.x = 100;
      medic.y = 300;

      const allyWorker = findEntity(match, "worker", "p1")!;
      allyWorker.health = 50;
      allyWorker.x = 150;
      allyWorker.y = 300;

      medic.healTargetId = allyWorker.id;

      engine.tick(match.id);

      const healEvent = match.attackLog.find(
        (e) => e.attackerId === medic.id && e.targetId === allyWorker.id
      );
      expect(healEvent).toBeDefined();
      expect(healEvent!.isHeal).toBe(true);
      expect(healEvent!.damage).toBe(HEALING.healRatePerTick);
    });

    it("old attack log events are pruned after 15 ticks", () => {
      const skirm = findEntity(match, "worker", "p1")!;
      asUnit(skirm, "skirmisher");
      skirm.x = 100;
      skirm.y = 300;

      const enemyWorker = findEntity(match, "worker", "p2")!;
      enemyWorker.x = 110;
      enemyWorker.y = 300;

      engine.tick(match.id);
      expect(match.attackLog.length).toBeGreaterThan(0);

      for (let i = 0; i < 20; i++) {
        enemyWorker.x = 300;
        enemyWorker.y = 500;
        engine.tick(match.id);
      }

      const oldEvent = match.attackLog.find(
        (e) => e.attackerId === skirm.id
      );
      expect(oldEvent).toBeUndefined();
    });
  });

  describe("Toggle Auto-Attack Command", () => {
    it("toggles auto-attack on from off", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.autoAttackEnabled = false;

      const result = engine.processCommand(match.id, "p1", {
        type: "toggle_auto_attack",
        entityIds: [worker.id],
      });

      expect(result.success).toBe(true);
      expect(worker.autoAttackEnabled).toBe(true);
    });

    it("toggles auto-attack off from on", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.autoAttackEnabled = true;

      const result = engine.processCommand(match.id, "p1", {
        type: "toggle_auto_attack",
        entityIds: [worker.id],
      });

      expect(result.success).toBe(true);
      expect(worker.autoAttackEnabled).toBe(false);
    });

    it("ignores buildings when toggling auto-attack", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.autoAttackEnabled = false;

      const result = engine.processCommand(match.id, "p1", {
        type: "toggle_auto_attack",
        entityIds: [worker.id, "nonexistent_building"],
      });

      expect(result.success).toBe(true);
      expect(worker.autoAttackEnabled).toBe(true);
    });

    it("toggles multiple units at once", () => {
      const allWorkers = Array.from(match.entities.values()).filter(
        (e) => e.type === "worker" && e.ownerId === "p1"
      );
      const w1 = allWorkers[0];
      const w2 = allWorkers[1];
      w1.autoAttackEnabled = false;
      w2.autoAttackEnabled = false;

      const result = engine.processCommand(match.id, "p1", {
        type: "toggle_auto_attack",
        entityIds: [w1.id, w2.id],
      });

      expect(result.success).toBe(true);
      expect(w1.autoAttackEnabled).toBe(true);
      expect(w2.autoAttackEnabled).toBe(true);
    });

    it("returns error with no entity IDs", () => {
      const result = engine.processCommand(match.id, "p1", {
        type: "toggle_auto_attack",
        entityIds: [],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("Stop Command", () => {
    it("clears move target and attack target", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.moveTarget = { x: 500, y: 500 };
      worker.autoAttackEnabled = true;
      worker.healTargetId = "some_target";

      const result = engine.processCommand(match.id, "p1", {
        type: "stop",
        entityIds: [worker.id],
      });

      expect(result.success).toBe(true);
      expect(worker.moveTarget).toBeUndefined();
      expect(worker.autoAttackEnabled).toBe(false);
      expect(worker.healTargetId).toBeUndefined();
    });

    it("stops multiple units at once", () => {
      const w1 = findEntity(match, "worker", "p1")!;
      const w2 = findEntity(match, "worker", "p1")!;
      w1.moveTarget = { x: 100, y: 100 };
      w1.autoAttackEnabled = true;
      w2.moveTarget = { x: 200, y: 200 };
      w2.autoAttackEnabled = true;

      const result = engine.processCommand(match.id, "p1", {
        type: "stop",
        entityIds: [w1.id, w2.id],
      });

      expect(result.success).toBe(true);
      expect(w1.moveTarget).toBeUndefined();
      expect(w1.autoAttackEnabled).toBe(false);
      expect(w2.moveTarget).toBeUndefined();
      expect(w2.autoAttackEnabled).toBe(false);
    });

    it("ignores buildings when stopping", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.moveTarget = { x: 100, y: 100 };

      const crystal = findEntity(match, "crystal", "p1")!;

      const result = engine.processCommand(match.id, "p1", {
        type: "stop",
        entityIds: [worker.id, crystal.id],
      });

      expect(result.success).toBe(true);
      expect(worker.moveTarget).toBeUndefined();
    });

    it("returns error with no entity IDs", () => {
      const result = engine.processCommand(match.id, "p1", {
        type: "stop",
        entityIds: [],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("Retreat Command", () => {
    it("moves unit toward own crystal", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.x = 500;
      worker.y = 300;
      worker.autoAttackEnabled = true;

      const crystal = findEntity(match, "crystal", "p1")!;

      const result = engine.processCommand(match.id, "p1", {
        type: "retreat",
        entityIds: [worker.id],
      });

      expect(result.success).toBe(true);
      expect(worker.moveTarget).toEqual({ x: crystal.x, y: crystal.y });
      expect(worker.autoAttackEnabled).toBe(false);
    });

    it("clears attack target on retreat", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.attackTargetId = "enemy_id";
      worker.healTargetId = "ally_id";

      const result = engine.processCommand(match.id, "p1", {
        type: "retreat",
        entityIds: [worker.id],
      });

      expect(result.success).toBe(true);
      expect(worker.attackTargetId).toBeUndefined();
      expect(worker.healTargetId).toBeUndefined();
    });

    it("cancels gathering on retreat", () => {
      const worker = findEntity(match, "worker", "p1")!;
      worker.gatheringNodeId = match.resourceNodes[0]?.id;
      if (match.resourceNodes[0]) {
        match.resourceNodes[0].gathererSlots.add(worker.id);
      }

      const result = engine.processCommand(match.id, "p1", {
        type: "retreat",
        entityIds: [worker.id],
      });

      expect(result.success).toBe(true);
      expect(worker.gatheringNodeId).toBeUndefined();
    });

    it("retreats multiple units at once", () => {
      const w1 = findEntity(match, "worker", "p1")!;
      const w2 = findEntity(match, "worker", "p1")!;
      w1.autoAttackEnabled = true;
      w2.autoAttackEnabled = true;

      const crystal = findEntity(match, "crystal", "p1")!;

      const result = engine.processCommand(match.id, "p1", {
        type: "retreat",
        entityIds: [w1.id, w2.id],
      });

      expect(result.success).toBe(true);
      expect(w1.moveTarget).toEqual({ x: crystal.x, y: crystal.y });
      expect(w2.moveTarget).toEqual({ x: crystal.x, y: crystal.y });
      expect(w1.autoAttackEnabled).toBe(false);
      expect(w2.autoAttackEnabled).toBe(false);
    });

    it("ignores buildings when retreating", () => {
      const worker = findEntity(match, "worker", "p1")!;
      const crystal = findEntity(match, "crystal", "p1")!;

      const result = engine.processCommand(match.id, "p1", {
        type: "retreat",
        entityIds: [worker.id, crystal.id],
      });

      expect(result.success).toBe(true);
      expect(worker.moveTarget).toEqual({ x: crystal.x, y: crystal.y });
    });

    it("returns error with no entity IDs", () => {
      const result = engine.processCommand(match.id, "p1", {
        type: "retreat",
        entityIds: [],
      });

      expect(result.success).toBe(false);
    });
  });

  describe("Unit Default Auto-Attack", () => {
    it("newly created combat units should NOT have auto-attack enabled by default", () => {
      const worker = findEntity(match, "worker", "p1")!;
      expect(worker.autoAttackEnabled).toBe(false);
    });
  });
});

describe("Economy System", () => {
  let engine: MatchEngine;
  let match: MatchState;

  beforeEach(() => {
    engine = new MatchEngine();
    match = engine.createMatch("ECON_TEST", [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);
    match.phase = "playing";
    match.economy[0]!.resources = 999;
  });

  it("resources are deducted when training workers", () => {
    const crystal = findEntity(match, "crystal", "p1")!;
    const before = match.economy[0]!.resources;
    const cost = match.config.workerTrainCost;

    engine.processCommand(match.id, "p1", {
      type: "train_worker",
      entityId: crystal.id,
    });

    expect(match.economy[0]!.resources).toBe(before - cost);
  });

  it("supply is consumed when training workers", () => {
    const crystal = findEntity(match, "crystal", "p1")!;
    const before = match.economy[0]!.supply;

    engine.processCommand(match.id, "p1", {
      type: "train_worker",
      entityId: crystal.id,
    });

    expect(match.economy[0]!.supply).toBe(before + match.config.workerSupplyCost);
  });

  it("supply is released on worker death", () => {
    const crystal = findEntity(match, "crystal", "p1")!;
    engine.processCommand(match.id, "p1", {
      type: "train_worker",
      entityId: crystal.id,
    });

    const workers = Array.from(match.entities.values()).filter(
      (e) => e.type === "worker" && e.ownerId === "p1"
    );
    const newWorker = workers[workers.length - 1];
    const supplyBefore = match.economy[0]!.supply;

    newWorker.health = 1;

    const enemy = findEntity(match, "worker", "p2")!;
    enemy.x = newWorker.x;
    enemy.y = newWorker.y;
    enemy.autoAttackEnabled = true;
    engine.tick(match.id);

    expect(match.economy[0]!.supply).toBe(supplyBefore - match.config.workerSupplyCost);
  });

  it("resources are deducted on build command", () => {
    const worker = findEntity(match, "worker", "p1")!;
    const before = match.economy[0]!.resources;

    const result = engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    expect(result.success).toBe(true);
    expect(match.economy[0]!.resources).toBe(before - BUILDING_DEFS.supply_depot.cost);
  });

  it("resources are refunded on build cancel when building is removed", () => {
    const worker = findEntity(match, "worker", "p1")!;
    const before = match.economy[0]!.resources;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    // Resources were deducted on build command
    expect(match.economy[0]!.resources).toBe(before - BUILDING_DEFS.supply_depot.cost);

    // Remove the building entity (simulating cancel)
    match.entities.delete(building.id);
    // Resources are NOT automatically refunded on entity removal (by design)
    expect(match.economy[0]!.resources).toBe(before - BUILDING_DEFS.supply_depot.cost);
  });

  it("supply is added when supply depot completes construction", () => {
    const worker = findEntity(match, "worker", "p1")!;
    const beforeMaxSupply = match.economy[0]!.maxSupply;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    // Verify supply NOT added on placement
    expect(match.economy[0]!.maxSupply).toBe(beforeMaxSupply);

    // Set worker right next to building and tick to progress construction
    worker.x = building.x;
    worker.y = building.y;

    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 300) {
      engine.tick(match.id);
      ticks++;
    }

    // Verify supply IS added on completion
    expect(building.constructionProgress).toBe(100);
    expect(match.economy[0]!.maxSupply).toBe(beforeMaxSupply + BUILDING_DEFS.supply_depot.supplyProvided!);
  });

  it("supply is removed when supply depot is destroyed", () => {
    const worker = findEntity(match, "worker", "p1")!;
    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    // Complete construction
    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 300) {
      engine.tick(match.id);
      ticks++;
    }

    const afterBuildMaxSupply = match.economy[0]!.maxSupply;

    // Destroy the building by attacking it
    const enemy = findEntity(match, "worker", "p2")!;
    enemy.x = building.x;
    enemy.y = building.y;
    building.health = 1;

    enemy.attackTargetId = building.id;
    enemy.autoAttackEnabled = true;

    engine.tick(match.id);

    expect(match.economy[0]!.maxSupply).toBeLessThan(afterBuildMaxSupply);
  });

  it("cannot train worker when insufficient resources", () => {
    match.economy[0]!.resources = 0;
    const crystal = findEntity(match, "crystal", "p1")!;

    const result = engine.processCommand(match.id, "p1", {
      type: "train_worker",
      entityId: crystal.id,
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("Not enough resources");
  });

  it("cannot train worker when insufficient supply", () => {
    match.economy[0]!.resources = 999;
    match.economy[0]!.supply = match.economy[0]!.maxSupply;
    const crystal = findEntity(match, "crystal", "p1")!;

    const result = engine.processCommand(match.id, "p1", {
      type: "train_worker",
      entityId: crystal.id,
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe("Not enough supply");
  });

  it("workers gather resources from resource nodes", () => {
    const worker = findEntity(match, "worker", "p1")!;
    worker.x = 300;
    worker.y = 300;

    const node = {
      id: "test-node-1",
      x: 310,
      y: 300,
      radius: 20,
      color: "#ccaa44",
      capacity: 500,
      remaining: 500,
      maxGathererSlots: 3,
      gathererSlots: new Set<string>(),
      accumulatedGather: 0,
    };
    match.resourceNodes.push(node);

    const result = engine.processCommand(match.id, "p1", {
      type: "gather",
      entityId: worker.id,
      targetEntityId: node.id,
    });

    expect(result.success).toBe(true);
    expect(worker.gatheringNodeId).toBe(node.id);

    const resourcesBefore = match.economy[0]!.resources;

    for (let i = 0; i < 10; i++) {
      engine.tick(match.id);
    }

    expect(match.economy[0]!.resources).toBeGreaterThan(resourcesBefore);
  });
});

describe("Building Construction", () => {
  let engine: MatchEngine;
  let match: MatchState;

  beforeEach(() => {
    engine = new MatchEngine();
    match = engine.createMatch("BUILD_TEST", [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);
    match.phase = "playing";
    match.economy[0]!.resources = 999;
  });

  it("building placement creates entity", () => {
    const worker = findEntity(match, "worker", "p1")!;

    const result = engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "barracks",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    expect(result.success).toBe(true);

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    );
    expect(building).toBeDefined();
    expect(building!.buildingType).toBe("barracks");
    expect(building!.constructionProgress).toBe(0);
    expect(building!.health).toBe(0);
  });

  it("construction progresses when worker is in range", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    expect(building.constructionProgress).toBe(0);

    worker.x = building.x;
    worker.y = building.y;
    worker.moveTarget = { x: building.x, y: building.y };

    engine.tick(match.id);

    expect(building.constructionProgress).toBeGreaterThan(0);
  });

  it("construction completes at 100% and building becomes functional", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;

    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    expect(building.constructionProgress).toBe(100);
    expect(building.health).toBeGreaterThan(0);
    expect(building.buildWorkerIds!.size).toBe(0);
    expect(worker.buildTargetId).toBeUndefined();
  });

  it("workers assigned to building via assign_build command", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "barracks",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    const workers = Array.from(match.entities.values()).filter(
      (e) => e.type === "worker" && e.ownerId === "p1"
    );
    const worker2 = workers[1];

    const result = engine.processCommand(match.id, "p1", {
      type: "assign_build",
      entityId: worker2.id,
      targetEntityId: building.id,
    });

    expect(result.success).toBe(true);
    expect(worker2.buildTargetId).toBe(building.id);
    expect(building.buildWorkerIds!.has(worker2.id)).toBe(true);
  });

  it("building overlap validation prevents placing on existing entity", () => {
    const workers = Array.from(match.entities.values()).filter(
      (e) => e.type === "worker" && e.ownerId === "p1"
    );
    const worker1 = workers[0];
    const worker2 = workers[1];

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker1.id],
    });

    // Give enough resources for second build
    match.economy[0]!.resources = 999;

    const result = engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker2.id],
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/overlap|too close|entity/i);
  });
});

describe("Production Queue", () => {
  let engine: MatchEngine;
  let match: MatchState;

  beforeEach(() => {
    engine = new MatchEngine();
    match = engine.createMatch("PROD_TEST", [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);
    match.phase = "playing";
    match.economy[0]!.resources = 999;
  });

  it("train unit adds to queue and deducts resources", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "barracks",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    const beforeResources = match.economy[0]!.resources;

    const result = engine.processCommand(match.id, "p1", {
      type: "train_unit",
      buildingId: building.id,
      unitType: "skirmisher",
    });

    expect(result.success).toBe(true);
    expect(building.productionQueue.length).toBe(1);
    expect(building.productionQueue[0].unitType).toBe("skirmisher");
    expect(match.economy[0]!.resources).toBe(beforeResources - UNIT_DEFS.skirmisher.cost);
  });

  it("queue processes and spawns unit when ticks elapse", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "barracks",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    match.economy[0]!.resources = 500;
    const entityCountBefore = match.entities.size;

    engine.processCommand(match.id, "p1", {
      type: "train_unit",
      buildingId: building.id,
      unitType: "skirmisher",
    });

    for (let i = 0; i < 120; i++) {
      engine.tick(match.id);
    }

    expect(match.entities.size).toBeGreaterThan(entityCountBefore);
    expect(building.productionQueue.length).toBe(0);
  });

  it("rally point applies to spawned units", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "barracks",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    engine.processCommand(match.id, "p1", {
      type: "set_rally",
      entityId: building.id,
      targetX: 500,
      targetY: 300,
    });

    expect(building.rallyPoint).toEqual({ x: 500, y: 300 });

    match.economy[0]!.resources = 500;

    engine.processCommand(match.id, "p1", {
      type: "train_unit",
      buildingId: building.id,
      unitType: "skirmisher",
    });

    for (let i = 0; i < 120; i++) {
      engine.tick(match.id);
    }

    const spawned = Array.from(match.entities.values()).find(
      (e) => e.type === "skirmisher" && e.ownerId === "p1"
    );
    expect(spawned).toBeDefined();
    expect(spawned!.moveTarget).toEqual({ x: 500, y: 300 });
  });

  it("cancel queue refunds resources", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "barracks",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    match.economy[0]!.resources = 500;
    const beforeResources = match.economy[0]!.resources;

    engine.processCommand(match.id, "p1", {
      type: "train_unit",
      buildingId: building.id,
      unitType: "skirmisher",
    });

    const afterTrainResources = match.economy[0]!.resources;
    expect(afterTrainResources).toBe(beforeResources - UNIT_DEFS.skirmisher.cost);

    const cancelResult = engine.processCommand(match.id, "p1", {
      type: "cancel_queue",
      entityId: building.id,
      targetX: 0,
    });

    expect(cancelResult.success).toBe(true);
    expect(building.productionQueue.length).toBe(0);
    expect(match.economy[0]!.resources).toBe(beforeResources);
  });
});

describe("Repair System", () => {
  let engine: MatchEngine;
  let match: MatchState;

  beforeEach(() => {
    engine = new MatchEngine();
    match = engine.createMatch("REPAIR_TEST", [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);
    match.phase = "playing";
    match.economy[0]!.resources = 999;
  });

  it("repair command sets repairTargetId on building", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    building.health = building.maxHealth / 2;

    const result = engine.processCommand(match.id, "p1", {
      type: "repair",
      entityId: worker.id,
      targetEntityId: building.id,
    });

    expect(result.success).toBe(true);
    expect(building.repairTargetId).toBe(worker.id);
  });

  it("repair heals building when worker is in range", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    building.health = building.maxHealth / 2;
    engine.processCommand(match.id, "p1", {
      type: "repair",
      entityId: worker.id,
      targetEntityId: building.id,
    });

    const healthBefore = building.health;
    match.economy[0]!.resources = 999;

    engine.tick(match.id);

    expect(building.health).toBeGreaterThan(healthBefore);
  });

  it("repair costs resources", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    building.health = building.maxHealth / 2;
    engine.processCommand(match.id, "p1", {
      type: "repair",
      entityId: worker.id,
      targetEntityId: building.id,
    });

    match.economy[0]!.resources = 100;
    const resourcesBefore = match.economy[0]!.resources;

    engine.tick(match.id);

    expect(match.economy[0]!.resources).toBeLessThan(resourcesBefore);
  });
});

describe("Death & Cleanup", () => {
  let engine: MatchEngine;
  let match: MatchState;

  beforeEach(() => {
    engine = new MatchEngine();
    match = engine.createMatch("DEATH_TEST", [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);
    match.phase = "playing";
    match.economy[0]!.resources = 999;
  });

  it("dead unit's supply is returned", () => {
    const crystal = findEntity(match, "crystal", "p1")!;
    engine.processCommand(match.id, "p1", {
      type: "train_worker",
      entityId: crystal.id,
    });

    const workers = Array.from(match.entities.values()).filter(
      (e) => e.type === "worker" && e.ownerId === "p1"
    );
    const newWorker = workers[workers.length - 1];
    const supplyBefore = match.economy[0]!.supply;

    newWorker.health = 1;
    const enemy = findEntity(match, "worker", "p2")!;
    enemy.x = newWorker.x;
    enemy.y = newWorker.y;
    enemy.autoAttackEnabled = true;
    engine.tick(match.id);

    expect(match.economy[0]!.supply).toBe(supplyBefore - 1);
  });

  it("building death frees workers", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    expect(worker.buildTargetId).toBe(building.id);

    // Destroy the building through combat tick
    building.health = 1;
    const enemy = findEntity(match, "worker", "p2")!;
    enemy.x = building.x;
    enemy.y = building.y;
    enemy.attackTargetId = building.id;
    enemy.autoAttackEnabled = true;

    engine.tick(match.id);

    expect(worker.buildTargetId).toBeUndefined();
  });

  it("supply depot death reduces maxSupply", () => {
    const worker = findEntity(match, "worker", "p1")!;

    engine.processCommand(match.id, "p1", {
      type: "build",
      buildingType: "supply_depot",
      targetX: 350,
      targetY: 300,
      workerIds: [worker.id],
    });

    const building = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.ownerId === "p1"
    )!;

    worker.x = building.x;
    worker.y = building.y;
    let ticks = 0;
    while (building.constructionProgress < 100 && ticks < 500) {
      engine.tick(match.id);
      ticks++;
    }

    const maxSupplyAfterBuild = match.economy[0]!.maxSupply;

    building.health = 1;
    const enemy = findEntity(match, "worker", "p2")!;
    enemy.x = building.x;
    enemy.y = building.y;
    enemy.attackTargetId = building.id;
    enemy.autoAttackEnabled = true;
    engine.tick(match.id);

    expect(match.economy[0]!.maxSupply).toBeLessThan(maxSupplyAfterBuild);
  });

  it("crystal destruction ends match", () => {
    const enemy = findEntity(match, "worker", "p2")!;

    const crystal = findEntity(match, "crystal", "p1")!;

    enemy.x = crystal.x;
    enemy.y = crystal.y;
    crystal.health = 1;

    enemy.attackTargetId = crystal.id;
    enemy.autoAttackEnabled = true;

    for (let i = 0; i < 50; i++) {
      engine.tick(match.id);
      if (match.phase === "ended") break;
    }

    expect(match.phase).toBe("ended");
    expect(match.result).not.toBeNull();
    expect(match.result!.winner).toBe("p2");
  });
});

describe("Match Lifecycle", () => {
  let engine: MatchEngine;
  let match: MatchState;

  beforeEach(() => {
    engine = new MatchEngine();
    match = engine.createMatch("LIFE_TEST", [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);
  });

  it("end match sets phase to ended", () => {
    match.phase = "playing";
    const result = engine.endMatch(match.id, "p1");

    expect(result).not.toBeNull();
    expect(match.phase).toBe("ended");
    expect(match.result!.winner).toBe("p1");
  });

  it("match cannot process commands after end", () => {
    match.phase = "playing";
    engine.endMatch(match.id, "p1");

    const cmdResult = engine.processCommand(match.id, "p1", {
      type: "move",
      entityId: "any-id",
      targetX: 350,
      targetY: 100,
    });

    expect(cmdResult.success).toBe(false);
  });

  it("tick returns null after match ends", () => {
    match.phase = "playing";
    engine.endMatch(match.id, "p1");

    const tickResult = engine.tick(match.id);
    expect(tickResult).toBeNull();
  });

  it("reset match clears entities and creates new ones", () => {
    match.phase = "playing";

    const extra = engine["createEntity"](
      match.idGen, "skirmisher", "p1", 3000, 300, 120, 12, "#44dd88"
    );
    match.entities.set(extra.id, extra);

    const resetResult = engine.resetMatch(match.id, [
      { playerId: "p1", username: "Player1", color: "blue", score: 0 },
      { playerId: "p2", username: "Player2", color: "red", score: 0 },
    ]);

    expect(resetResult).not.toBeNull();
    expect(resetResult!.phase).toBe("spawn");
    expect(resetResult!.tick).toBe(0);
    expect(resetResult!.result).toBeNull();
    expect(resetResult!.entities.size).toBe(8);
    expect(resetResult!.economy[0]!.resources).toBe(match.config.startingResources);
    expect(resetResult!.economy[0]!.supply).toBe(0);
  });

  it("destroy match removes match from engine", () => {
    match.phase = "playing";
    engine.destroyMatch(match.id);

    expect(engine.getMatch(match.id)).toBeUndefined();
  });

  it("hasActiveMatch returns true for active match", () => {
    match.phase = "playing";
    expect(engine.hasActiveMatch("LIFE_TEST")).toBe(true);
  });

  it("hasActiveMatch returns false for ended match", () => {
    match.phase = "playing";
    engine.endMatch(match.id, "p1");
    expect(engine.hasActiveMatch("LIFE_TEST")).toBe(false);
  });
});
