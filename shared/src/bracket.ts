/**
 * Round-robin schedules and elimination brackets for tournaments. Pure and deterministic, like swiss.ts.
 *
 * A bracket is a list of nodes (one series each). A node's two players come from a seed or from the
 * winner or loser of an earlier node, so the bracket is fixed at the start and every round plays
 * the nodes whose players are both known. A missing player (an empty seed, a withdrawal, a double
 * no-show) gives the other a walkover, played as no game.
 */

export type TournamentFormat = "single" | "double" | "round_robin" | "swiss";

export const FORMAT_LABEL: Record<TournamentFormat, string> = {
  single: "Single elimination",
  double: "Double elimination",
  round_robin: "Round robin",
  swiss: "Swiss",
};

export type BracketSource = { seed: number } | { winner: string } | { loser: string };

export interface BracketNode {
  id: string;
  label: string;
  src: [BracketSource, BracketSource];
  /** Players knocked out here finish in this stage; a higher stage is a better finish. */
  stage: number;
  /** Grand final reset: played only if the losers-bracket player won the grand final. */
  reset?: boolean;
}

/** Seeds in bracket order for a bracket of `size` (a power of 2): 1 v size, 2 v size−1, … with 1 and 2 in opposite halves. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2;
    order = order.flatMap((s) => [s, m + 1 - s]);
  }
  return order;
}

const roundName = (fromEnd: number, r: number) => (fromEnd === 0 ? "Final" : fromEnd === 1 ? "Semi-final" : fromEnd === 2 ? "Quarter-final" : `Round ${r}`);

/** The bracket for `n` entrants (seeds 1..n; the bracket is filled to a power of 2 with empty seeds). */
export function buildBracket(format: "single" | "double", n: number): BracketNode[] {
  const size = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(2, n))));
  const k = Math.log2(size);
  const order = seedOrder(size);
  const nodes: BracketNode[] = [];
  const double = format === "double";
  // Winners bracket (the whole bracket in single elimination).
  for (let r = 1; r <= k; r++) {
    const count = size / 2 ** r;
    for (let i = 0; i < count; i++) {
      const src: [BracketSource, BracketSource] = r === 1
        ? [{ seed: order[2 * i] }, { seed: order[2 * i + 1] }]
        : [{ winner: `W${r - 1}-${2 * i + 1}` }, { winner: `W${r - 1}-${2 * i + 2}` }];
      const label = double ? (r === k ? "Winners final" : `Winners R${r}`) : roundName(k - r, r);
      nodes.push({ id: `W${r}-${i + 1}`, label, src, stage: double ? 0 : r });
    }
  }
  if (!double) return nodes;

  // Losers bracket: round 1 pairs the winners-round-1 losers; then each winners round's losers drop in
  // against the survivors (in reverse order every other round, to put off rematches), and the
  // survivors play each other between drops.
  let lb = 0;
  let survivors: BracketSource[] = [];
  const lbRound = (pairs: [BracketSource, BracketSource][], last: boolean) => {
    lb++;
    survivors = pairs.map((src, i) => {
      const id = `L${lb}-${i + 1}`;
      nodes.push({ id, label: last ? "Losers final" : `Losers R${lb}`, src, stage: lb });
      return { winner: id };
    });
  };
  if (k === 1) survivors = [{ loser: "W1-1" }];
  else {
    const first: [BracketSource, BracketSource][] = [];
    for (let i = 0; i < size / 4; i++) first.push([{ loser: `W1-${2 * i + 1}` }, { loser: `W1-${2 * i + 2}` }]);
    lbRound(first, false);
    for (let r = 2; r <= k; r++) {
      const count = size / 2 ** r;
      const drop = Array.from({ length: count }, (_, i) => ({ loser: `W${r}-${r % 2 === 0 ? count - i : i + 1}` }));
      lbRound(survivors.map((s, i) => [s, drop[i]]), r === k);
      if (r < k) lbRound(Array.from({ length: survivors.length / 2 }, (_, i) => [survivors[2 * i], survivors[2 * i + 1]]), false);
    }
  }
  nodes.push({ id: "GF", label: "Grand final", src: [{ winner: `W${k}-1` }, survivors[0]], stage: lb + 1 });
  nodes.push({ id: "GF2", label: "Grand final reset", src: [{ winner: "GF" }, { loser: "GF" }], stage: lb + 2, reset: true });
  return nodes;
}

/** The node that decides the champion. */
export const finalNode = (nodes: BracketNode[]): BracketNode => nodes[nodes.length - 1];

/** Upper bound on the rounds a bracket takes: a node is played at the latest in round 1 + the longest chain of nodes before it. */
export function bracketRounds(nodes: BracketNode[]): number {
  const depth = new Map<string, number>();
  for (const n of nodes) {
    const d = n.src.map((s) => ("seed" in s ? 0 : depth.get("winner" in s ? s.winner : s.loser)!));
    depth.set(n.id, 1 + Math.max(...d));
  }
  return Math.max(...depth.values());
}

/** A played node's series as the resolver needs it. */
export interface NodeSeries { a: string; b: string | null; result?: "a" | "b" | "draw" | "both_lose" | "void" }

export interface NodeState {
  /** Players, once known (null: nobody, a walkover for the other). */
  a?: string | null;
  b?: string | null;
  /** Set once decided. */
  winner?: string | null;
  loser?: string | null;
  /** Both players are known and the node needs a series that has not been opened yet. */
  ready?: boolean;
}

/**
 * Every node's state. `seeds[i]` is seed i+1's entrant id; `series` holds the node's series once one
 * was opened; `out` are withdrawn players, who forfeit any node not opened yet.
 */
export function resolveBracket(nodes: BracketNode[], seeds: string[], series: Map<string, NodeSeries>, out: Set<string>): Map<string, NodeState> {
  const st = new Map<string, NodeState>();
  const from = (s: BracketSource): string | null | undefined => {
    if ("seed" in s) return seeds[s.seed - 1] ?? null;
    const n = st.get("winner" in s ? s.winner : s.loser);
    return "winner" in s ? n?.winner : n?.loser;
  };
  for (const node of nodes) {
    const a = from(node.src[0]), b = from(node.src[1]);
    const ns: NodeState = { a, b };
    st.set(node.id, ns);
    if (a === undefined || b === undefined) continue;
    const s = series.get(node.id);
    if (s) {
      if (s.result === undefined) continue;
      const w = s.result === "a" ? s.a : s.result === "b" ? s.b : null;
      ns.winner = w;
      ns.loser = w === null ? null : w === s.a ? s.b : s.a;
      continue;
    }
    // The reset is only played if the grand final's losers-bracket player (its side b) won it.
    if (node.reset) {
      const gf = nodes.find((x) => "winner" in node.src[0] && x.id === node.src[0].winner)!;
      if (st.get(gf.id)!.a === a) { ns.winner = a; ns.loser = b; continue; }
    }
    const pa = a && !out.has(a) ? a : null, pb = b && !out.has(b) ? b : null;
    if (pa && pb) { ns.ready = true; continue; }
    ns.winner = pa ?? pb;
    ns.loser = pa ? b : pb ? a : null;
    if (ns.winner === null) ns.loser = null;
  }
  return st;
}

/**
 * Final positions in an elimination bracket: still in is best, then later knockouts. Players
 * knocked out in the same stage share a rank.
 */
export function eliminationRanks(nodes: BracketNode[], state: Map<string, NodeState>, ids: string[], seedOf: (id: string) => number, withdrawn: Set<string>): { id: string; rank: number; outIn?: string }[] {
  const outAt = new Map<string, BracketNode>();
  for (const n of nodes) {
    const ns = state.get(n.id)!;
    if (!ns.loser) continue;
    // In double elimination a winners-bracket loss drops to the losers bracket; it doesn't knock out.
    if (n.stage === 0) continue;
    outAt.set(ns.loser, n);
  }
  const champ = state.get(finalNode(nodes).id)?.winner;
  // Withdrawn players finish below the others knocked out in the same stage (last if never beaten: walked over both ways).
  const key = (id: string) => {
    if (id === champ) return Infinity;
    const at = outAt.get(id);
    if (!at) return withdrawn.has(id) ? -1 : Infinity;
    return at.stage - (withdrawn.has(id) ? 0.5 : 0);
  };
  const sorted = [...ids].sort((x, y) => key(y) - key(x) || seedOf(x) - seedOf(y));
  return sorted.map((id) => ({
    id,
    rank: 1 + sorted.filter((o) => key(o) > key(id)).length,
    ...(outAt.has(id) ? { outIn: outAt.get(id)!.label } : {}),
  }));
}

/**
 * Round-robin schedule (circle method) for seeds 1..n: n−1 rounds, or n with an odd count (each
 * player sits out once, null). Each pair meets once; sides alternate for the fixed player.
 */
export function roundRobin(n: number): [number, number | null][][] {
  const ring: (number | null)[] = Array.from({ length: n }, (_, i) => i + 1);
  if (n % 2) ring.push(null);
  const m = ring.length;
  const rounds: [number, number | null][][] = [];
  for (let r = 0; r < m - 1; r++) {
    const pairs: [number, number | null][] = [];
    for (let i = 0; i < m / 2; i++) {
      let x = ring[i], y = ring[m - 1 - i];
      if (i === 0 && r % 2 === 1) [x, y] = [y, x];
      if (x === null) [x, y] = [y, x];
      pairs.push([x!, y]);
    }
    rounds.push(pairs);
    // Keep the first, rotate the rest.
    ring.splice(1, 0, ring.pop()!);
  }
  return rounds;
}
