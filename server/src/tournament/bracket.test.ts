import { describe, it, expect } from "vitest";
import { buildBracket, bracketRounds, eliminationRanks, finalNode, resolveBracket, roundRobin, seedOrder, type BracketNode, type NodeSeries } from "@crystalfront/shared";

/** Plays a bracket to the end: `pick(a, b)` returns the winner of each series. */
function play(nodes: BracketNode[], n: number, pick: (a: string, b: string) => string, out = new Set<string>()) {
  const seeds = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const series = new Map<string, NodeSeries>();
  const games = new Map<string, number>();
  let rounds = 0;
  for (;;) {
    const st = resolveBracket(nodes, seeds, series, out);
    if (st.get(finalNode(nodes).id)!.winner !== undefined) return { st, rounds, games, seeds };
    const ready = nodes.filter((x) => st.get(x.id)!.ready);
    expect(ready.length).toBeGreaterThan(0);
    // Nobody plays twice in a round.
    const busy = ready.flatMap((x) => [st.get(x.id)!.a, st.get(x.id)!.b]);
    expect(new Set(busy).size).toBe(busy.length);
    rounds++;
    for (const x of ready) {
      const { a, b } = st.get(x.id)!;
      series.set(x.id, { a: a!, b: b!, result: pick(a!, b!) === a ? "a" : "b" });
      for (const p of [a!, b!]) games.set(p, (games.get(p) ?? 0) + 1);
    }
  }
}
const seedNo = (id: string) => Number(id.slice(1));
const higherSeed = (a: string, b: string) => (seedNo(a) < seedNo(b) ? a : b);

describe("brackets", () => {
  it("seed order keeps 1 and 2 apart", () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  for (const n of [2, 3, 5, 8, 13, 32]) {
    it(`single elimination, ${n} players: favourites win, ranks 1, 2, 3, 3, …`, () => {
      const nodes = buildBracket("single", n);
      const { st, rounds, seeds } = play(nodes, n, higherSeed);
      expect(st.get(finalNode(nodes).id)!.winner).toBe("p1");
      expect(rounds).toBe(Math.ceil(Math.log2(n)));
      expect(rounds).toBeLessThanOrEqual(bracketRounds(nodes));
      const ranks = eliminationRanks(nodes, st, seeds, seedNo, new Set());
      expect(ranks.slice(0, 2).map((r) => [r.id, r.rank])).toEqual([["p1", 1], ["p2", 2]]);
      if (n >= 4) expect(ranks.slice(2, 4).map((r) => r.rank)).toEqual([3, 3]);
    });

    it(`double elimination, ${n} players: everyone but the champion loses twice (or once to them in the final)`, () => {
      const nodes = buildBracket("double", n);
      // Upsets everywhere: the lower seed wins, so the grand final reset gets played.
      const { st, rounds, games, seeds } = play(nodes, n, (a, b) => (seedNo(a) < seedNo(b) ? b : a));
      const champ = st.get(finalNode(nodes).id)!.winner!;
      expect(champ).toBeTruthy();
      expect(rounds).toBeLessThanOrEqual(bracketRounds(nodes));
      const ranks = eliminationRanks(nodes, st, seeds, seedNo, new Set());
      expect(ranks[0]).toMatchObject({ id: champ, rank: 1 });
      expect(ranks[1].rank).toBe(2);
      // Every player plays at least twice unless they had byes all the way down.
      if (n === 8 || n === 32) for (const s of seeds) expect(games.get(s)).toBeGreaterThanOrEqual(2);
    });
  }

  it("double elimination: the reset is only played when the losers-bracket player wins the grand final", () => {
    const nodes = buildBracket("double", 4);
    const fav = play(nodes, 4, higherSeed);
    expect(fav.st.get("GF")!.winner).toBe("p1");
    expect(fav.st.get("GF2")!.winner).toBe("p1");
    expect(fav.rounds).toBe(4); // W1, W2+L1, L2, GF: no reset
    // p2 loses the winners final to p1, comes back through the losers final, then beats p1 twice.
    let meetings = 0;
    const comeback = play(nodes, 4, (a, b) => {
      if ([a, b].sort().join() !== "p1,p2") return higherSeed(a, b);
      return ++meetings === 1 ? "p1" : "p2";
    });
    expect(meetings).toBe(3);
    expect(comeback.st.get("GF")!.winner).toBe("p2");
    expect(comeback.st.get("GF2")!.winner).toBe("p2");
  });

  it("withdrawn players are walked over and finish last", () => {
    const nodes = buildBracket("single", 4);
    const { st, seeds } = play(nodes, 4, higherSeed, new Set(["p1"]));
    expect(st.get(finalNode(nodes).id)!.winner).toBe("p2");
    const ranks = eliminationRanks(nodes, st, seeds, seedNo, new Set(["p1"]));
    expect(ranks[ranks.length - 1].id).toBe("p1");
  });
});

describe("round robin", () => {
  for (const n of [2, 3, 4, 7, 10]) {
    it(`${n} players: every pair meets exactly once, one series per player per round`, () => {
      const rounds = roundRobin(n);
      expect(rounds.length).toBe(n % 2 ? n : n - 1);
      const met = new Set<string>();
      for (const r of rounds) {
        const seen = r.flatMap(([x, y]) => (y === null ? [x] : [x, y]));
        expect(new Set(seen).size).toBe(n);
        for (const [x, y] of r) if (y !== null) {
          const k = [x, y].sort().join("-");
          expect(met.has(k)).toBe(false);
          met.add(k);
        }
      }
      expect(met.size).toBe((n * (n - 1)) / 2);
    });
  }
});
