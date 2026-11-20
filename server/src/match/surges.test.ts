import { describe, it, expect } from "vitest";
import { MatchEngine } from "./matchEngine.js";
import { DEFAULT_CONFIG, type MatchState } from "./types.js";
import { CONTROL, SURGES, UNIT_DEFS } from "@crystalfront/shared";
import { controlStep } from "./engine/surges.js";
import { controlNeeded } from "./engine/control.js";

const PLAYERS = [
  { playerId: "p1", username: "A", color: "blue" as const, score: 0 },
  { playerId: "p2", username: "B", color: "red" as const, score: 0 },
] as [any, any];

function setup(beta: boolean, tick = 0): { engine: MatchEngine; match: MatchState } {
  const engine = new MatchEngine();
  const match = engine.createMatch("S", PLAYERS, { ...DEFAULT_CONFIG, ...(beta ? { ruleset: "beta" as const } : {}) }, 7);
  engine.startMatch(match.id);
  match.tick = tick;
  return { engine, match };
}
const of = (m: MatchState, type: string, owner: string) => [...m.entities.values()].filter((e) => e.type === type && e.ownerId === owner);

/** Distance a skirmisher walks in one tick toward a far point. */
function step(beta: boolean, tick: number): number {
  const { engine, match } = setup(beta, tick);
  match.economy[0]!.resources = 1000;
  const crystal = of(match, "crystal", "p1")[0];
  expect(engine.debugSpawn(match.id, "p1", "skirmisher", crystal.x + 120, crystal.y).success).toBe(true);
  const s = of(match, "skirmisher", "p1")[0];
  engine.processCommand(match.id, "p1", { type: "move", entityId: s.id, targetX: s.x + 400, targetY: s.y });
  engine.tick(match.id);
  const [x0, y0] = [s.x, s.y];
  engine.tick(match.id);
  return Math.hypot(s.x - x0, s.y - y0);
}

/** Damage of a skirmisher's first hit on the enemy Crystal. */
function crystalHit(beta: boolean, tick: number): number {
  const { engine, match } = setup(beta, tick);
  const foe = of(match, "crystal", "p2")[0];
  expect(engine.debugSpawn(match.id, "p1", "skirmisher", foe.x - foe.radius - 8, foe.y).success).toBe(true);
  const s = of(match, "skirmisher", "p1")[0];
  engine.processCommand(match.id, "p1", { type: "attack", entityId: s.id, targetEntityId: foe.id });
  for (let i = 0; i < 40; i++) {
    engine.tick(match.id);
    const hit = match.attackLog.find((a) => a.attackerId === s.id && a.targetId === foe.id);
    if (hit) return hit.damage;
  }
  throw new Error("no hit");
}

describe("Surges, cap and draws (beta ruleset)", () => {
  it("Surge I: units move 25% faster in beta only", () => {
    const base = step(true, 100);
    expect(base).toBeCloseTo(UNIT_DEFS.skirmisher.speed, 2);
    expect(step(true, SURGES.stageTicks[0] + 10) / base).toBeCloseTo(SURGES.speedMult, 1); // path corners shave a little
    expect(step(false, SURGES.stageTicks[0] + 10)).toBeCloseTo(base, 2);
  });

  it("Surges II/III: units hit buildings and crystals ×1.5 then ×2", () => {
    const base = crystalHit(true, 100);
    expect(crystalHit(true, SURGES.stageTicks[1] + 10)).toBe(Math.round(base * 1.5));
    expect(crystalHit(true, SURGES.stageTicks[2] + 10)).toBe(base * 2);
    expect(crystalHit(false, SURGES.stageTicks[2] + 10)).toBe(base);
  });

  it("the hold shortens to 30 s and 15 s while keeping the percentage", () => {
    const at = (tick: number) => controlStep(setup(true, tick).match);
    expect([at(0), at(SURGES.stageTicks[0]), at(SURGES.stageTicks[1]), at(SURGES.stageTicks[2])]).toEqual([1, 1, 2, 4]);
    expect(controlStep(setup(false, SURGES.stageTicks[2]).match)).toBe(1);

    const { engine, match } = setup(true, SURGES.stageTicks[1] + 10);
    const nodes = match.resourceNodes.filter((n) => n.contested);
    for (const n of nodes.slice(0, controlNeeded(nodes.length))) engine.debugSpawn(match.id, "p1", "skirmisher", n.x, n.y);
    match.control.progress = [CONTROL.holdTicks / 2, 10];
    engine.tick(match.id);
    expect(match.control.progress).toEqual([CONTROL.holdTicks / 2 + 2, 8]);
  });

  it("at 20:00 the higher control percentage wins on time", () => {
    const { engine, match } = setup(true, SURGES.capTicks - 1);
    match.control.progress = [120, 300];
    engine.tick(match.id);
    expect(match.phase).toBe("ended");
    expect(match.result).toEqual({ winner: "p2", winType: "time" });
  });

  it("equal percentages at 20:00 (including 0%–0%) are a draw", () => {
    const { engine, match } = setup(true, SURGES.capTicks - 1);
    let winner: string | null | undefined;
    engine.setMatchEndCallback((_id, w) => { winner = w; });
    engine.tick(match.id);
    expect(match.result).toEqual({ winner: null, winType: "draw" });
    expect(winner).toBeNull();
  });

  it("0.9 matches have no cap and no Surges", () => {
    const { engine, match } = setup(false, SURGES.capTicks + 5);
    engine.tick(match.id);
    expect(match.phase).toBe("playing");
  });
});
