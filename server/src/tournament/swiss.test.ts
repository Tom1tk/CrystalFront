import { describe, it, expect } from "vitest";
import {
  defaultRounds, nextMap, pairRound, seriesBlue, seriesMaps, seriesState, standings,
  type SwissPlayer, type SwissResult, type SwissRound,
} from "@crystalfront/shared";

const players = (n: number): SwissPlayer[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, seed: i + 1 }));

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Plays a round: the better seed wins with probability pWin, draws 10%. */
function play(rounds: SwissRound[], ps: SwissPlayer[], r: () => number, pool = ["m1", "m2", "m3"]) {
  const { pairings, relaxed } = pairRound(ps, rounds);
  const seed = (id: string) => ps.find((p) => p.id === id)!.seed;
  for (const m of pairings) {
    if (m.b === null) continue;
    const x = r();
    const aBetter = seed(m.a) < seed(m.b);
    m.result = (x < 0.1 ? "draw" : (x < 0.7) === aBetter ? "a" : "b") as SwissResult;
  }
  rounds.push({ map: nextMap(pool, rounds), pairings });
  return relaxed;
}

const meetings = (rounds: SwissRound[]) => rounds.flatMap((r) => r.pairings.filter((m) => m.b).map((m) => [m.a, m.b!].sort().join("-")));

describe("Swiss pairing (tournament T1)", () => {
  it("default rounds: ⌈log₂ N⌉, at least 3, at most N − 1", () => {
    expect([2, 3, 4, 8, 9, 16, 17, 32].map(defaultRounds)).toEqual([1, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("round 1 pairs the top half against the bottom half by seed", () => {
    const { pairings, relaxed } = pairRound(players(8), []);
    expect(relaxed).toBe(0);
    expect(pairings.map((m) => [m.a, m.b].sort())).toEqual([["p1", "p5"], ["p2", "p6"], ["p3", "p7"], ["p4", "p8"]]);
  });

  it("odd N: the lowest-ranked player without a bye gets it, worth 1 point, at most once each", () => {
    const ps = players(5);
    const rounds: SwissRound[] = [];
    const r = rng(3);
    for (let i = 0; i < defaultRounds(5); i++) expect(play(rounds, ps, r)).toBe(0);
    const byes = rounds.map((r) => r.pairings.find((m) => m.b === null)!.a);
    expect(byes[0]).toBe("p5");
    expect(new Set(byes).size).toBe(3);
    const s = standings(ps, rounds).find((x) => x.id === "p5")!;
    expect(s.byes).toBe(1);
  });

  it("standings: points, then Buchholz Cut-1, SB, wins, seed", () => {
    const ps = players(4);
    const rounds: SwissRound[] = [
      { map: "m1", pairings: [{ a: "p1", b: "p3", result: "a" }, { a: "p2", b: "p4", result: "draw" }] },
      { map: "m2", pairings: [{ a: "p4", b: "p1", result: "b" }, { a: "p3", b: "p2", result: "b" }] },
    ];
    const s = standings(ps, rounds);
    expect(s.map((x) => [x.id, x.points])).toEqual([["p1", 2], ["p2", 1.5], ["p4", 0.5], ["p3", 0]]);
    const p1 = s[0];
    // Opponents p3 (0) and p4 (0.5): Cut-1 drops p3. SB: beat both → 0 + 0.5.
    expect([p1.buchholz, p1.sb, p1.wins, p1.sides]).toEqual([0.5, 0.5, 2, 0]);
  });

  it("head-to-head breaks a tie the earlier keys leave", () => {
    const ps = players(2);
    const rounds: SwissRound[] = [{ map: "m", pairings: [{ a: "p1", b: "p2", result: "b", games: [1, 2] }] },
      { map: "m", pairings: [{ a: "p2", b: "p1", result: "b", games: [1, 2] }] }];
    // 1–1 in series, equal Buchholz/SB/game difference: head-to-head is level too, so seed decides.
    expect(standings(ps, rounds).map((s) => s.id)).toEqual(["p1", "p2"]);
    rounds.push({ map: "m", pairings: [{ a: "p1", b: "p2", result: "draw" }] });
    expect(standings(ps, rounds).map((s) => s.h2h)).toEqual([1.5, 1.5]);
  });

  it("a withdrawn player is not paired again and past results stand", () => {
    const ps = players(6);
    const rounds: SwissRound[] = [];
    play(rounds, ps, rng(1));
    const before = standings(ps, rounds).find((s) => s.id === "p1")!.points;
    ps[0].withdrawn = true;
    const { pairings } = pairRound(ps, rounds);
    expect(pairings.some((m) => m.a === "p1" || m.b === "p1")).toBe(false);
    expect(pairings.filter((m) => m.b === null).length).toBe(1); // 5 active: one bye
    const s = standings(ps, rounds).find((x) => x.id === "p1")!;
    expect([s.points, s.withdrawn]).toEqual([before, true]);
  });

  it("a late joiner starts on 0 points and is paired", () => {
    const ps = players(6);
    const rounds: SwissRound[] = [];
    play(rounds, ps, rng(2));
    play(rounds, ps, rng(2));
    ps.push({ id: "late", seed: 7 });
    expect(standings(ps, rounds).find((s) => s.id === "late")!.points).toBe(0);
    const { pairings } = pairRound(ps, rounds);
    expect(pairings.some((m) => m.a === "late" || m.b === "late")).toBe(true);
  });

  it("maps rotate through the pool without repeats until it runs out; series alternate sides", () => {
    const rounds: SwissRound[] = [];
    for (let i = 0; i < 5; i++) rounds.push({ map: nextMap(["a", "b", "c"], rounds), pairings: [] });
    expect(rounds.map((r) => r.map)).toEqual(["a", "b", "c", "a", "b"]);
    expect(seriesMaps(["a", "b", "c"], "c", 3)).toEqual(["c", "a", "b"]);
    const m = { a: "x", b: "y" };
    expect([0, 1, 2].map((g) => seriesBlue(m, g))).toEqual(["x", "y", "x"]);
  });

  it("series: majority ends it, a drawn game is ½ each, level after every game is a draw", () => {
    expect(seriesState(["a", "a"], 3)).toEqual({ done: true, score: [2, 0], result: "a" });
    expect(seriesState(["a", "draw"], 3)).toEqual({ done: false, score: [1.5, 0.5] });
    expect(seriesState(["a", "draw", "b"], 3)).toEqual({ done: true, score: [1.5, 1.5], result: "draw" });
    expect(seriesState(["b", "b", "a", "b"], 5)).toEqual({ done: true, score: [1, 3], result: "b" });
    expect(seriesState(["draw"], 1)).toEqual({ done: true, score: [0.5, 0.5], result: "draw" });
  });

  it("fuzz: no rematches, byes at most once, sides within 1, every active player paired", () => {
    let relaxedRounds = 0, total = 0;
    for (let t = 0; t < 300; t++) {
      const r = rng(1000 + t);
      const ps = players(2 + Math.floor(r() * 31));
      const rounds: SwissRound[] = [];
      const nRounds = defaultRounds(ps.length) + (ps.length > 8 ? 1 : 0);
      for (let k = 0; k < nRounds; k++) {
        if (k > 0 && r() < 0.1 && ps.filter((p) => !p.withdrawn).length > 3) ps[Math.floor(r() * ps.length)].withdrawn = true;
        if (k > 0 && r() < 0.1 && ps.length < 32) ps.push({ id: `late${k}`, seed: ps.length + 1 });
        const active = ps.filter((p) => !p.withdrawn).map((p) => p.id);
        const relaxed = play(rounds, ps, r);
        total++;
        if (relaxed) { relaxedRounds++; continue; }
        const last = rounds[rounds.length - 1].pairings;
        expect(last.flatMap((m) => [m.a, m.b].filter(Boolean)).sort()).toEqual([...active].sort());
        const ms = meetings(rounds);
        expect(new Set(ms).size).toBe(ms.length);
        const st = standings(ps, rounds);
        for (const s of st) {
          expect(s.byes).toBeLessThanOrEqual(1);
          expect(Math.abs(s.sides)).toBeLessThanOrEqual(1);
        }
      }
    }
    // Relaxation is a rare escape hatch, not the norm.
    expect(relaxedRounds / total).toBeLessThan(0.02);
  });
});
