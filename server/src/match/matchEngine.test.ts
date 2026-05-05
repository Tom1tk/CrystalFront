import { describe, it, expect, beforeEach } from "vitest";
import { MatchEngine } from "./matchEngine.js";
import { UNIT_DEFS, COUNTER_MULTIPLIERS, HEAL_RATE_PER_TICK } from "./types.js";
import type { MatchState, MatchEntity } from "./types.js";

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

  function findEntity(match: MatchState, type: string, ownerId?: string): MatchEntity | undefined {
    for (const e of match.entities.values()) {
      if (e.type === type && (ownerId === undefined || e.ownerId === ownerId)) {
        return e;
      }
    }
    return undefined;
  }

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
      expect(COUNTER_MULTIPLIERS.skirmisher.gunner).toBe(2.0);
    });

    it("skirmisher deals 0.5x damage to bruiser", () => {
      expect(COUNTER_MULTIPLIERS.skirmisher.bruiser).toBe(0.5);
    });

    it("gunner deals 2x damage to bruiser", () => {
      expect(COUNTER_MULTIPLIERS.gunner.bruiser).toBe(2.0);
    });

    it("gunner deals 0.5x damage to skirmisher", () => {
      expect(COUNTER_MULTIPLIERS.gunner.skirmisher).toBe(0.5);
    });

    it("bruiser deals 2x damage to skirmisher", () => {
      expect(COUNTER_MULTIPLIERS.bruiser.skirmisher).toBe(2.0);
    });

    it("bruiser deals 0.5x damage to gunner", () => {
      expect(COUNTER_MULTIPLIERS.bruiser.gunner).toBe(0.5);
    });

    it("medic has no counter bonuses", () => {
      expect(COUNTER_MULTIPLIERS.medic.skirmisher).toBe(1.0);
      expect(COUNTER_MULTIPLIERS.medic.gunner).toBe(1.0);
      expect(COUNTER_MULTIPLIERS.medic.bruiser).toBe(1.0);
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

      expect(allyWorker.health).toBe(50 + HEAL_RATE_PER_TICK);
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
      expect(healEvent!.damage).toBe(HEAL_RATE_PER_TICK);
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
      const w1 = findEntity(match, "worker", "p1")!;
      const w2 = findEntity(match, "worker", "p1")!;
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
