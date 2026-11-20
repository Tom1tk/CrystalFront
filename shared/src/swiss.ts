/**
 * Swiss pairing, standings and series scoring for tournaments (docs/TOURNAMENT_SPEC.md §4, §8a).
 * Pure and deterministic: the same players and rounds always give the same pairing.
 */

export interface SwissPlayer {
  id: string;
  /** Seed order, 1 = top. The final tiebreak. */
  seed: number;
  /** Withdrawn players are not paired again; their past results stand. */
  withdrawn?: boolean;
}

/**
 * A series result. "a"/"b": that side won; "draw"; "both_lose": a double no-show, 0 to both;
 * "void": not counted (no points, not an opponent for tiebreaks, but still not a rematch).
 */
export type SwissResult = "a" | "b" | "draw" | "both_lose" | "void";

export interface SwissPairing {
  /** Blue in game 1. */
  a: string;
  /** Red in game 1; null = bye (1 point to `a`). */
  b: string | null;
  /** Unset while the series is being played. */
  result?: SwissResult;
  /** Game points [a, b] of the series (Bo3/Bo5). When unset, derived from `result`. */
  games?: [number, number];
}

export interface SwissRound {
  map: string;
  pairings: SwissPairing[];
}

export interface Standing {
  id: string;
  seed: number;
  rank: number;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  buchholz: number;
  sb: number;
  gameDiff: number;
  /** Points scored against the other players tied with this one on every earlier key. */
  h2h: number;
  /** Blue minus red series played. */
  sides: number;
  lastSide: "blue" | "red" | null;
  opponents: string[];
  withdrawn: boolean;
}

/** ⌈log₂ N⌉ rounds, at least 3, never more than N − 1. */
export function defaultRounds(n: number): number {
  if (n < 2) return 0;
  return Math.min(n - 1, Math.max(3, Math.ceil(Math.log2(n))));
}

function scores(result: SwissResult | undefined): [number, number] | null {
  switch (result) {
    case "a": return [1, 0];
    case "b": return [0, 1];
    case "draw": return [0.5, 0.5];
    case "both_lose": return [0, 0];
    default: return null;
  }
}

/** Standings after the given rounds, ranked: points, Buchholz Cut-1, SB, game difference, head-to-head, wins, seed. */
export function standings(players: SwissPlayer[], rounds: SwissRound[]): Standing[] {
  const by = new Map<string, Standing>();
  for (const p of players) {
    by.set(p.id, {
      id: p.id, seed: p.seed, rank: 0, points: 0, wins: 0, draws: 0, losses: 0, byes: 0, buchholz: 0, sb: 0,
      gameDiff: 0, h2h: 0, sides: 0, lastSide: null, opponents: [], withdrawn: !!p.withdrawn,
    });
  }
  // [player, opponent, points scored] for every counted series.
  const met: [string, string, number][] = [];
  for (const r of rounds) {
    for (const m of r.pairings) {
      const a = by.get(m.a);
      if (!a) continue;
      if (m.b === null) {
        if (m.result !== "void") { a.points += 1; a.byes += 1; }
        continue;
      }
      const b = by.get(m.b);
      if (!b) continue;
      a.opponents.push(b.id); b.opponents.push(a.id);
      a.sides += 1; b.sides -= 1; a.lastSide = "blue"; b.lastSide = "red";
      const s = scores(m.result);
      if (!s) continue;
      a.points += s[0]; b.points += s[1];
      for (const [p, x] of [[a, s[0]], [b, s[1]]] as const) {
        if (x === 1) p.wins++; else if (x === 0.5) p.draws++; else p.losses++;
      }
      const g = m.games ?? s;
      a.gameDiff += g[0] - g[1]; b.gameDiff += g[1] - g[0];
      met.push([a.id, b.id, s[0]], [b.id, a.id, s[1]]);
    }
  }
  const pts = (id: string) => by.get(id)!.points;
  for (const st of by.values()) {
    const opp = met.filter((m) => m[0] === st.id);
    const os = opp.map((m) => pts(m[1]));
    st.buchholz = os.reduce((x, y) => x + y, 0) - (os.length > 1 ? Math.min(...os) : 0);
    st.sb = opp.reduce((x, m) => x + m[2] * pts(m[1]), 0);
  }
  const keys = (s: Standing) => [s.points, s.buchholz, s.sb, s.gameDiff];
  const tied = (x: Standing, y: Standing) => keys(x).every((k, i) => k === keys(y)[i]);
  const all = [...by.values()];
  for (const st of all) {
    const group = new Set(all.filter((o) => o !== st && tied(o, st)).map((o) => o.id));
    st.h2h = met.filter((m) => m[0] === st.id && group.has(m[1])).reduce((x, m) => x + m[2], 0);
  }
  all.sort((x, y) => {
    const kx = [...keys(x), x.h2h, x.wins], ky = [...keys(y), y.h2h, y.wins];
    for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return ky[i] - kx[i];
    return x.seed - y.seed;
  });
  all.forEach((s, i) => { s.rank = i + 1; });
  return all;
}

export interface PairResult {
  pairings: SwissPairing[];
  /**
   * 0: every rule held. 1: sides could not all stay within 1 (no rematches, byes once).
   * 2: no rematch-free pairing exists, so rematches or a second bye were allowed.
   */
  relaxed: 0 | 1 | 2;
}

const SEARCH_BUDGET = 200_000;

/**
 * Pairs the next round (Dutch-style): players are ranked by the standings, score groups are paired top
 * half against bottom half, rematches are avoided, odd players float down. With an odd number of active
 * players, the lowest-ranked player without a bye gets it. The search backtracks, so it finds a valid
 * pairing whenever one exists (failed sub-problems are memoised; N ≤ 32 keeps it cheap).
 */
export function pairRound(players: SwissPlayer[], rounds: SwissRound[]): PairResult {
  const st = standings(players, rounds).filter((s) => !s.withdrawn);
  const n = st.length;
  // Position in score group and group size, for the "top half vs bottom half" preference.
  const gpos: number[] = [], gsize: number[] = [];
  for (let i = 0; i < n;) {
    let j = i;
    while (j < n && st[j].points === st[i].points) j++;
    for (let k = i; k < j; k++) { gpos[k] = k - i; gsize[k] = j - i; }
    i = j;
  }
  const metBefore = (i: number, j: number) => st[i].opponents.includes(st[j].id);
  const clash = (i: number, j: number) => st[i].sides !== 0 && Math.sign(st[i].sides) === Math.sign(st[j].sides);
  const prefer = (i: number, j: number): number[] => {
    const same = st[i].points === st[j].points;
    return [Math.abs(st[i].points - st[j].points), same ? Math.abs(gpos[j] - gpos[i] - Math.floor(gsize[i] / 2)) : 0, j];
  };

  for (const tier of [0, 1, 2] as const) {
    const allowed = (i: number, j: number) => tier === 2 || (!metBefore(i, j) && (tier === 1 || !clash(i, j)));
    const byeOrder = n % 2 === 0 ? [-1] : [...Array(n).keys()].reverse().filter((i) => tier === 2 || st[i].byes === 0);
    for (const bye of byeOrder) {
      const pairs = search(n, bye, allowed, prefer);
      if (!pairs) continue;
      const out: SwissPairing[] = pairs.map(([i, j]) => side(st[i], st[j]));
      if (bye >= 0) out.push({ a: st[bye].id, b: null, result: "a" });
      return { pairings: out, relaxed: tier };
    }
  }
  throw new Error("unreachable: tier 2 always pairs");
}

/** Pairs indices 0..n-1 (except `bye`) in rank order; null when impossible or over budget. */
function search(n: number, bye: number, allowed: (i: number, j: number) => boolean, prefer: (i: number, j: number) => number[]): [number, number][] | null {
  const free = new Array<boolean>(n).fill(true);
  if (bye >= 0) free[bye] = false;
  const failed = new Set<string>();
  const out: [number, number][] = [];
  let nodes = 0;
  const go = (): boolean => {
    const i = free.indexOf(true);
    if (i < 0) return true;
    const key = free.map((f) => (f ? 1 : 0)).join("");
    if (failed.has(key) || ++nodes > SEARCH_BUDGET) return false;
    free[i] = false;
    const cands: number[] = [];
    for (let j = i + 1; j < n; j++) if (free[j] && allowed(i, j)) cands.push(j);
    cands.sort((x, y) => {
      const px = prefer(i, x), py = prefer(i, y);
      for (let k = 0; k < px.length; k++) if (px[k] !== py[k]) return px[k] - py[k];
      return 0;
    });
    for (const j of cands) {
      free[j] = false; out.push([i, j]);
      if (go()) return true;
      free[j] = true; out.pop();
    }
    free[i] = true;
    failed.add(key);
    return false;
  };
  return go() ? out : null;
}

/** Sides for higher-ranked `p` and `q`: the one who played blue less gets blue; on a tie `p` alternates. */
function side(p: Standing, q: Standing): SwissPairing {
  let pBlue: boolean;
  if (p.sides !== q.sides) pBlue = p.sides < q.sides;
  else if (p.sides !== 0) pBlue = p.sides < 0;
  else pBlue = p.lastSide !== "blue";
  return pBlue ? { a: p.id, b: q.id } : { a: q.id, b: p.id };
}

/** The map for the next round: the pool map used least so far (pool order breaks ties), so none repeats until the pool runs out. */
export function nextMap(pool: string[], rounds: SwissRound[]): string {
  const used = (m: string) => rounds.filter((r) => r.map === m).length;
  return pool.reduce((best, m) => (used(m) < used(best) ? m : best), pool[0]);
}

/** Maps for every game of a series: game 1 is the round's map, later games take the next pool maps. */
export function seriesMaps(pool: string[], roundMap: string, bestOf: number): string[] {
  const k = Math.max(0, pool.indexOf(roundMap));
  return Array.from({ length: bestOf }, (_, g) => (g === 0 ? roundMap : pool[(k + g) % pool.length]));
}

/** Game g (0-based) of a series: side `a` is blue in even games. Returns the blue player's id. */
export function seriesBlue(pairing: SwissPairing, game: number): string {
  return game % 2 === 0 || pairing.b === null ? pairing.a : pairing.b;
}

/**
 * Series state from its game results ("a"/"b"/"draw" per game, in order). It ends when a player has
 * more than half the games (a draw is ½ each) or every game is played; level after all games = draw.
 */
export function seriesState(games: ("a" | "b" | "draw")[], bestOf: number): { done: boolean; score: [number, number]; result?: "a" | "b" | "draw" } {
  const score: [number, number] = [0, 0];
  for (const g of games) {
    if (g === "a") score[0] += 1; else if (g === "b") score[1] += 1; else { score[0] += 0.5; score[1] += 0.5; }
  }
  const win = score[0] > bestOf / 2 ? "a" : score[1] > bestOf / 2 ? "b" : null;
  if (win) return { done: true, score, result: win };
  if (games.length >= bestOf) return { done: true, score, result: score[0] > score[1] ? "a" : score[1] > score[0] ? "b" : "draw" };
  return { done: false, score };
}
