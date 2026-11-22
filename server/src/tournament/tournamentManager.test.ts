import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TournamentManager, TournamentError, type Tournament, type TournamentHooks } from "./tournamentManager.js";

/** A fake server: records started games, lets tests end them, controls the clock. */
function harness(dir: string | null = null) {
  let clock = 1_000_000;
  let nextMatch = 1;
  const live = new Map<string, { blue: string; series: number; game: number }>();
  const stopped: string[] = [];
  const pushes: number[] = [];
  const hooks: TournamentHooks = {
    startGame: (_t, _r, s, game) => {
      const id = `m${nextMatch++}`;
      live.set(id, { blue: s.games[game].blue, series: s.slot, game });
      return id;
    },
    stopGame: (id) => { stopped.push(id); live.delete(id); },
    changed: () => { pushes.push(clock); },
  };
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const mgr = new TournamentManager(hooks, { dir, now: () => clock, random, botName: (b) => (b === "hard" ? "Hard (0.9)" : b === "rush" ? "Rush" : null) });
  return {
    mgr, live, stopped, pushes, hooks,
    advance: (ms: number) => { clock += ms; mgr.tick(); },
    /** Ends a live match: `winner` is the entrant id (null = draw). */
    end: (matchId: string, winner: string | null) => { live.delete(matchId); mgr.gameEnded(matchId, winner, winner ? "destruction" : "draw", `r-${matchId}`); },
  };
}

const POOL = ["ironreed", "saltmarsh", "cinder"];

function withPlayers(h: ReturnType<typeof harness>, n: number, settings: Record<string, unknown> = {}): Tournament {
  const t = h.mgr.create("mgr", { name: "Cup", format: "swiss", ...settings }, POOL);
  for (let i = 1; i <= n; i++) h.mgr.join(t, `P${i}`, `tok${i}`);
  return t;
}
const tok = (t: Tournament, id: string) => t.tokens[id];
const current = (t: Tournament) => t.rounds[t.rounds.length - 1];
const readyAll = (h: ReturnType<typeof harness>, t: Tournament) => {
  for (const s of current(t).series) if (s.status === "ready_check") {
    if (!s.ready.a) h.mgr.ready(t, tok(t, s.a));
    if (!s.ready.b) h.mgr.ready(t, tok(t, s.b!));
  }
};
/** Plays out the current round: blue wins every game. */
const playRound = (h: ReturnType<typeof harness>, t: Tournament) => {
  for (let guard = 0; guard < 20 && current(t).series.some((s) => s.status !== "done"); guard++) {
    readyAll(h, t);
    for (const [id, m] of [...h.live]) h.end(id, m.blue);
  }
};

describe("TournamentManager (tournament T2)", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it("create, join by code, rejoin with the same token, public state hides tokens", () => {
    const t = withPlayers(h, 3);
    expect(h.mgr.byCode(t.code.toLowerCase())).toBe(t);
    expect(t.code).toMatch(/^[A-Z2-9]{6}$/);
    const again = h.mgr.join(t, "Renamed", "tok2");
    expect(again.name).toBe("P2");
    expect(t.entrants.length).toBe(3);
    const pub = JSON.stringify(h.mgr.publicState(t));
    expect(pub).not.toContain("tok1");
    expect(pub).not.toContain("mgr");
    expect(h.mgr.viewer(t, "mgr")).toEqual({ isManager: true });
    expect(h.mgr.viewer(t, "tok3")).toEqual({ isManager: false, entrantId: "e3" });
  });

  it("only the manager can run admin operations; start needs 2 players; locking stops joins", () => {
    const t = withPlayers(h, 1);
    expect(() => h.mgr.admin(t, "tok1", { op: "start" })).toThrow(TournamentError);
    expect(() => h.mgr.admin(t, "mgr", { op: "start" })).toThrow(/At least 2/);
    h.mgr.admin(t, "mgr", { op: "lock" });
    expect(() => h.mgr.join(t, "X", "x")).toThrow(/closed/);
    h.mgr.admin(t, "mgr", { op: "unlock" });
    h.mgr.join(t, "X", "x");
    h.mgr.admin(t, "mgr", { op: "start" });
    expect(t.status).toBe("running");
    expect(t.locked).toBe(true);
  });

  it("ready check: both ready starts the game; a no-show loses; neither ready, both lose", () => {
    const t = withPlayers(h, 6, { rounds: 2 });
    h.mgr.admin(t, "mgr", { op: "start" });
    const [s1, s2, s3] = current(t).series;
    expect(s1.status).toBe("ready_check");
    h.mgr.ready(t, tok(t, s1.a));
    h.mgr.ready(t, tok(t, s1.b!));
    expect(s1.status).toBe("playing");
    expect(h.live.size).toBe(1);
    h.mgr.ready(t, tok(t, s2.b!));
    h.advance(60_001);
    expect([s2.result, s2.games[0].decided]).toEqual(["b", "no_show"]);
    expect(s3.result).toBe("both_lose");
    expect(s1.status).toBe("playing");
  });

  it("a full tournament: rounds advance after the countdown, standings and finish", () => {
    const t = withPlayers(h, 8);
    h.mgr.admin(t, "mgr", { op: "start" });
    for (let r = 1; r <= 3; r++) {
      expect(current(t).number).toBe(r);
      playRound(h, t);
      if (r < 3) {
        expect(t.nextRoundAt).toBe(h.pushes[h.pushes.length - 1] + 60_000);
        h.advance(59_000);
        expect(t.rounds.length).toBe(r);
        h.advance(1_000);
      }
    }
    expect(t.status).toBe("finished");
    const st = h.mgr.publicState(t).standings;
    expect(st[0].points).toBe(st.reduce((m, s) => Math.max(m, s.points), 0));
    expect(st.reduce((x, s) => x + s.points, 0)).toBe(12); // 4 series × 3 rounds
    expect(t.rounds.map((r) => r.map)).toEqual(POOL);
    // Every game has its replay recorded.
    expect(t.rounds.flatMap((r) => r.series.flatMap((s) => s.games.map((g) => g.replayId))).every(Boolean)).toBe(true);
  });

  it("odd entrants: the bye is scored at once", () => {
    const t = withPlayers(h, 5);
    h.mgr.admin(t, "mgr", { op: "start" });
    const bye = current(t).series.find((s) => s.b === null)!;
    expect([bye.status, bye.result]).toEqual(["done", "a"]);
  });

  it("Bo3: sides alternate, maps follow the pool, the series ends at 2 wins", () => {
    const t = withPlayers(h, 2, { bestOf: 3, rounds: 1 });
    h.mgr.admin(t, "mgr", { op: "start" });
    const s = current(t).series[0];
    readyAll(h, t);
    let [id] = [...h.live.keys()];
    h.end(id, s.a);
    expect(s.status).toBe("ready_check"); // 60 s ready check between games
    readyAll(h, t);
    [id] = [...h.live.keys()];
    expect(s.games[1].blue).toBe(s.b);
    h.end(id, s.a);
    expect([s.status, s.result, s.games.length]).toEqual(["done", "a", 2]);
    expect(s.games.map((g) => g.map)).toEqual([current(t).map, POOL[(POOL.indexOf(current(t).map) + 1) % 3]]);
    expect(t.status).toBe("finished");
  });

  it("bot v bot starts at once; bots are always ready; duplicate bots are numbered", () => {
    const t = h.mgr.create("mgr", { name: "Bots", format: "swiss", rounds: 1 }, POOL);
    h.mgr.admin(t, "mgr", { op: "add_bot", bot: "hard" });
    h.mgr.admin(t, "mgr", { op: "add_bot", bot: "hard" });
    expect(t.entrants.map((e) => e.name)).toEqual(["Hard (0.9) #1", "Hard (0.9) #2"]);
    expect(() => h.mgr.admin(t, "mgr", { op: "add_bot", bot: "nope" })).toThrow(/Unknown bot/);
    h.mgr.admin(t, "mgr", { op: "start" });
    expect(current(t).series[0].status).toBe("playing");
  });

  it("withdraw mid-round forfeits the live match and stops it; results stand", () => {
    const t = withPlayers(h, 4, { rounds: 2 });
    h.mgr.admin(t, "mgr", { op: "start" });
    readyAll(h, t);
    const s = current(t).series[0];
    const matchId = s.games[0].matchId!;
    h.mgr.leave(t, tok(t, s.a));
    expect(h.stopped).toContain(matchId);
    expect([s.result, s.games[0].decided]).toEqual(["b", "forfeit"]);
    h.end(matchId, s.a); // a late report for a stopped match is ignored
    expect(s.result).toBe("b");
    playRound(h, t);
    h.advance(60_000);
    expect(current(t).series.some((x) => x.a === s.a || x.b === s.a)).toBe(false);
  });

  it("late join: unlocked registration adds a 0-point player who is paired next round", () => {
    const t = withPlayers(h, 4, { rounds: 3 });
    h.mgr.admin(t, "mgr", { op: "start" });
    expect(() => h.mgr.join(t, "Late", "late")).toThrow(/closed/);
    h.mgr.admin(t, "mgr", { op: "unlock" });
    const e = h.mgr.join(t, "Late", "late");
    expect(e.joinedRound).toBe(2);
    playRound(h, t);
    h.advance(60_000);
    expect(current(t).series.some((s) => s.a === e.id || s.b === e.id)).toBe(true);
    expect(h.mgr.publicState(t).standings.find((s) => s.id === e.id)!.points).toBeLessThanOrEqual(1);
  });

  it("manager: pause stops auto-advance; next_round cuts the countdown; set_rounds adds a round", () => {
    const t = withPlayers(h, 4, { rounds: 2 });
    h.mgr.admin(t, "mgr", { op: "start" });
    h.mgr.admin(t, "mgr", { op: "pause" });
    playRound(h, t);
    h.advance(120_000);
    expect(t.rounds.length).toBe(1);
    h.mgr.admin(t, "mgr", { op: "next_round" });
    expect(t.rounds.length).toBe(2);
    h.mgr.admin(t, "mgr", { op: "resume" });
    h.mgr.admin(t, "mgr", { op: "set_rounds", rounds: 3 });
    expect(() => h.mgr.admin(t, "mgr", { op: "set_rounds", rounds: 1 })).toThrow(/between 2/);
    playRound(h, t);
    h.advance(60_000);
    expect(t.rounds.length).toBe(3);
  });

  it("manager: re-pair only before any match starts; set_result adjudicates or replays", () => {
    const t = withPlayers(h, 4, { rounds: 2 });
    h.mgr.admin(t, "mgr", { op: "start" });
    h.mgr.admin(t, "mgr", { op: "repair" });
    expect(t.rounds.length).toBe(1);
    readyAll(h, t);
    expect(() => h.mgr.admin(t, "mgr", { op: "repair" })).toThrow(/already started/);
    const [s1, s2] = current(t).series;
    const m1 = s1.games[0].matchId!;
    h.mgr.admin(t, "mgr", { op: "set_result", round: 1, slot: 0, result: "draw" });
    expect([s1.result, s1.games[0].decided, h.stopped.includes(m1)]).toEqual(["draw", "adjudicated", true]);
    h.mgr.admin(t, "mgr", { op: "set_result", round: 1, slot: 1, result: "replay" });
    expect([s2.status, s2.games.length]).toEqual(["ready_check", 1]);
    // A past result can be corrected later.
    playRound(h, t);
    h.advance(60_000);
    h.mgr.admin(t, "mgr", { op: "set_result", round: 1, slot: 0, result: "a" });
    expect(t.rounds[0].series[0].result).toBe("a");
  });

  it("manager: finish early lets matches finish, or voids them", () => {
    const t = withPlayers(h, 4, { rounds: 3 });
    h.mgr.admin(t, "mgr", { op: "start" });
    readyAll(h, t);
    h.mgr.admin(t, "mgr", { op: "finish" });
    expect(t.status).toBe("running");
    for (const [id, m] of [...h.live]) h.end(id, m.blue);
    expect(t.status).toBe("finished");

    const t2 = withPlayers(h, 4, { rounds: 3 });
    h.mgr.admin(t2, "mgr", { op: "start" });
    readyAll(h, t2);
    h.mgr.admin(t2, "mgr", { op: "finish", void: true });
    expect([t2.status, current(t2).series.map((s) => s.result)]).toEqual(["finished", ["void", "void"]]);
  });

  it("manager: transfer, settings validation, manual seeding, cancel", () => {
    const t = withPlayers(h, 3);
    h.mgr.admin(t, "mgr", { op: "seed_order", ids: ["e3", "e1", "e2"] });
    expect(t.entrants.map((e) => e.id)).toEqual(["e3", "e1", "e2"]);
    expect(() => h.mgr.admin(t, "mgr", { op: "seed_order", ids: ["e1"] })).toThrow();
    h.mgr.admin(t, "mgr", { op: "settings", settings: { spectatorDelay: 5, readySeconds: 1000, bestOf: 5 } });
    expect([t.settings.spectatorDelay, t.settings.readySeconds, t.settings.bestOf]).toEqual([30, 300, 5]);
    expect(() => h.mgr.admin(t, "mgr", { op: "settings", settings: { bestOf: 2 as 1 } })).toThrow(/Bo1/);
    h.mgr.admin(t, "mgr", { op: "start" });
    expect(t.entrants.map((e) => e.seed)).toEqual([1, 2, 3]); // manual seeding is kept
    h.mgr.admin(t, "mgr", { op: "transfer", entrantId: "e2" });
    expect(() => h.mgr.admin(t, "mgr", { op: "pause" })).toThrow(/Only the manager/);
    h.mgr.admin(t, "tok2", { op: "cancel" });
    expect(t.status).toBe("cancelled");
  });

});

describe("TournamentManager formats", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });
  /** Plays rounds until the tournament ends, advancing through the countdowns. */
  const playOut = (t: Tournament) => {
    for (let guard = 0; guard < 40 && t.status === "running"; guard++) {
      playRound(h, t);
      if (t.status === "running") h.advance(60_000);
    }
  };

  it("defaults to single elimination", () => {
    const t = h.mgr.create("mgr", { name: "Cup" }, POOL);
    expect(t.settings.format).toBe("single");
  });

  it("single elimination: byes are walkovers, the bracket finishes with one champion", () => {
    const t = withPlayers(h, 5, { format: "single" });
    h.mgr.admin(t, "mgr", { op: "start" });
    expect(t.settings.rounds).toBe(3);
    // 8-slot bracket: seeds 1–3 walk over the empty seeds, so round 1 is 4 v 5 and already the 2 v 3 semi-final.
    expect(current(t).series.map((s) => s.label)).toEqual(["Quarter-final", "Semi-final"]);
    playOut(t);
    expect(t.status).toBe("finished");
    expect(t.rounds.length).toBe(3);
    expect(t.rounds.map((r) => r.series.map((s) => s.label))).toEqual([["Quarter-final", "Semi-final"], ["Semi-final"], ["Final"]]);
    const st = h.mgr.publicState(t).standings;
    expect(st.map((s) => s.rank)).toEqual([1, 2, 3, 3, 5]);
    expect(st[0].outIn).toBeUndefined();
    expect(st[1].outIn).toBe("Final");
    // Late joins and Swiss-only operations are refused.
    expect(() => h.mgr.admin(t, "mgr", { op: "set_rounds", rounds: 5 })).toThrow(TournamentError);
  });

  it("double elimination: a grand final, with the reset only when the losers-bracket player wins it", () => {
    const t = withPlayers(h, 4, { format: "double" });
    h.mgr.admin(t, "mgr", { op: "start" });
    playOut(t);
    expect(t.status).toBe("finished");
    const labels = t.rounds.flatMap((r) => r.series.map((s) => s.label));
    expect(labels).toContain("Grand final");
    // Blue always wins; the winners-bracket player is blue in the grand final, so no reset.
    expect(labels).not.toContain("Grand final reset");
    expect(h.mgr.publicState(t).standings.map((s) => s.rank)).toEqual([1, 2, 3, 4]);
  });

  it("elimination: a drawn series plays on until someone wins; draws can't be set by hand", () => {
    const t = withPlayers(h, 2, { format: "single" });
    h.mgr.admin(t, "mgr", { op: "start" });
    readyAll(h, t);
    const [m1] = [...h.live.keys()];
    h.end(m1, null);
    const s = current(t).series[0];
    expect(s.status).toBe("ready_check");
    expect(s.games.length).toBe(2);
    expect(() => h.mgr.admin(t, "mgr", { op: "set_result", round: 1, slot: 0, result: "draw" })).toThrow(TournamentError);
    readyAll(h, t);
    const [m2] = [...h.live.keys()];
    h.end(m2, s.games[1].blue);
    expect(t.status).toBe("finished");
  });

  it("elimination: a withdrawn player's opponent walks over them", () => {
    const t = withPlayers(h, 4, { format: "single" });
    h.mgr.admin(t, "mgr", { op: "start" });
    const loser = current(t).series[0].b!;
    playRound(h, t);
    const winner = current(t).series[1].a;
    h.mgr.leave(t, tok(t, winner));
    h.advance(60_000);
    // The final opens with one player gone: walked over, the tournament ends.
    expect(t.status).toBe("finished");
    expect(h.mgr.publicState(t).standings.find((s) => s.id === loser)!.rank).toBeGreaterThan(1);
  });

  it("round robin: everyone plays everyone once, then standings", () => {
    const t = withPlayers(h, 5, { format: "round_robin" });
    h.mgr.admin(t, "mgr", { op: "start" });
    expect(t.settings.rounds).toBe(5);
    playOut(t);
    expect(t.status).toBe("finished");
    const pairs = t.rounds.flatMap((r) => r.series.filter((s) => s.b !== null).map((s) => [s.a, s.b].sort().join("-")));
    expect(new Set(pairs).size).toBe(10);
    expect(pairs.length).toBe(10);
    expect(t.rounds.every((r) => r.series.filter((s) => s.b === null).length === 1)).toBe(true);
    expect(() => h.mgr.join(t, "Late", "late")).toThrow(TournamentError);
  });
});

describe("TournamentManager persistence", () => {
  it("saves every change and reloads; live matches become interrupted and the tournament pauses", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-tourn-"));
    try {
      const h = harness(dir);
      const t = withPlayers(h, 4, { rounds: 2 });
      h.mgr.admin(t, "mgr", { op: "start" });
      const s = current(t).series[0];
      h.mgr.ready(t, tok(t, s.a));
      h.mgr.ready(t, tok(t, s.b!));
      expect(readdirSync(dir)).toEqual([`${t.id}.json`]);

      const h2 = harness(dir); // server restart
      const t2 = h2.mgr.get(t.id)!;
      expect(t2.code).toBe(t.code);
      const [r1, r2] = current(t2).series;
      expect([r1.status, r1.games[0].matchId, t2.paused]).toEqual(["interrupted", undefined, true]);
      expect(r2.status).toBe("ready_check");
      h2.mgr.admin(t2, "mgr", { op: "set_result", round: 1, slot: 0, result: "replay" });
      expect(r1.status).toBe("ready_check");
      h2.mgr.ready(t2, tok(t2, r1.a));
      h2.mgr.ready(t2, tok(t2, r1.b!));
      expect(r1.status).toBe("playing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
