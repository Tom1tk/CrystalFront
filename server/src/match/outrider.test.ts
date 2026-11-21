import { describe, it, expect } from "vitest";
import { MatchEngine } from "./matchEngine.js";
import { DEFAULT_CONFIG, type MatchState } from "./types.js";
import { UNIT_DEFS } from "@crystalfront/shared";

const PLAYERS = [
  { playerId: "p1", username: "A", color: "blue" as const, score: 0 },
  { playerId: "p2", username: "B", color: "red" as const, score: 0 },
] as [any, any];

function setup(beta: boolean): { engine: MatchEngine; match: MatchState } {
  const engine = new MatchEngine();
  const match = engine.createMatch("T", PLAYERS, { ...DEFAULT_CONFIG, ...(beta ? { ruleset: "beta" as const } : {}) }, 5);
  engine.startMatch(match.id);
  return { engine, match };
}
const of = (m: MatchState, type: string, owner: string) => [...m.entities.values()].filter((e) => e.type === type && e.ownerId === owner);

describe("Outrider (beta ruleset)", () => {
  it("does not exist in 0.9 matches and cannot be trained there", () => {
    const { engine, match } = setup(false);
    expect(of(match, "outrider", "p1")).toHaveLength(0);
    const crystal = of(match, "crystal", "p1")[0];
    expect(engine.processCommand(match.id, "p1", { type: "train_unit", buildingId: crystal.id, unitType: "outrider" }).success).toBe(false);
  });

  it("starts with one free Outrider per player, counted in supply", () => {
    const { match } = setup(true);
    expect(of(match, "outrider", "p1")).toHaveLength(1);
    expect(of(match, "outrider", "p2")).toHaveLength(1);
    expect(match.economy[0]!.supply).toBe(4);
    const [a, b] = [of(match, "outrider", "p1")[0], of(match, "outrider", "p2")[0]];
    expect(a.x + b.x).toBeCloseTo(match.config.mapWidth, 3); // mirrored
  });

  it("allows one alive or queued, retrains at the Crystal after death", () => {
    const { engine, match } = setup(true);
    match.economy[0]!.resources = 1000;
    const crystal = of(match, "crystal", "p1")[0];
    const train = () => engine.processCommand(match.id, "p1", { type: "train_unit", buildingId: crystal.id, unitType: "outrider" });
    expect(train().message).toBe("Only one Outrider at a time");
    match.entities.delete(of(match, "outrider", "p1")[0].id);
    expect(train().success).toBe(true);
    expect(match.economy[0]!.resources).toBe(1000 - UNIT_DEFS.outrider.cost);
    expect(train().message).toBe("Only one Outrider at a time");
    // Only the accepted order is logged, so replays and spectator feeds see it.
    expect(match.commandLog.filter((c) => c.command.unitType === "outrider")).toHaveLength(1);
    for (let i = 0; i < UNIT_DEFS.outrider.buildTime; i++) engine.tick(match.id);
    expect(of(match, "outrider", "p1")).toHaveLength(1);
    expect(crystal.productionQueue).toHaveLength(0);
  });

  it("cannot hold contested nodes", () => {
    const { engine, match } = setup(true);
    const node = match.resourceNodes.find((n) => n.contested)!;
    const o = of(match, "outrider", "p1")[0];
    o.x = node.x; o.y = node.y;
    engine.tick(match.id);
    expect(node.controller ?? null).toBeNull();
  });
});
