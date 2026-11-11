/**
 * Determinism guard for engine optimisation (G-10 T2 / P-5).
 *
 *   npx tsx headless/src/goldenHashes.ts --write   # record headless/golden/engine_hashes.json
 *   npx tsx headless/src/goldenHashes.ts --check   # replay every case; exit 1 on any mismatch
 *
 * 20 seeded bot matches over 3 maps (one classic, one mirror, one rotate), state hash
 * every 500 ticks and at the end. Any engine change that is meant to be a pure speed-up
 * must leave every hash identical. A deliberate rule change regenerates the file (say so
 * in the commit message).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMatch } from "./runMatch.js";
import { HeavyBot, MacroBot, MediumRushBot, TurtleBot, WeakRushBot } from "./bots/index.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import { hashMatchState } from "../../server/src/match/engine/hash.js";
import type { MatchState } from "../../server/src/match/types.js";
import type { Agent } from "./types.js";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "../golden/engine_hashes.json");
const BOTS: Record<string, () => Agent> = {
  rush: () => new MediumRushBot(), rush1: () => new WeakRushBot(),
  macro: () => new MacroBot(), turtle: () => new TurtleBot(), heavy: () => new HeavyBot(),
};
const PAIRS: Array<[string, string]> = [
  ["rush", "macro"], ["turtle", "rush"], ["macro", "heavy"], ["heavy", "turtle"],
  ["rush1", "turtle"], ["macro", "macro"], ["rush", "rush"],
];
const MAPS = ["classic", "shardfall", "prism-ridge"];
export const EVERY = 500;
export const CAP = 6000;

export interface GoldenCase { map: string; blue: string; red: string; seed: number; hashes: string[] }

/** The 20 cases: pairs cycled over maps, seeds 100… */
export function goldenCases(): Array<Omit<GoldenCase, "hashes">> {
  const out: Array<Omit<GoldenCase, "hashes">> = [];
  for (let i = 0; i < 20; i++) {
    const [blue, red] = PAIRS[i % PAIRS.length];
    out.push({ map: MAPS[i % MAPS.length], blue, red, seed: 100 + i });
  }
  return out;
}

export function runCase(c: Omit<GoldenCase, "hashes">): string[] {
  const hashes: string[] = [];
  let last: MatchState | null = null;
  runMatch(BOTS[c.blue](), BOTS[c.red](), {
    seed: c.seed, maxTicks: CAP, config: { ...DEFAULT_CONFIG, mapId: c.map },
    onTick: (m) => { last = m; if (m.tick % EVERY === 0) hashes.push(hashMatchState(m)); },
  });
  if (last) hashes.push(hashMatchState(last));
  return hashes;
}

export function loadGolden(): GoldenCase[] {
  return JSON.parse(readFileSync(FILE, "utf8")) as GoldenCase[];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes("--write") ? "write" : "check";
  if (mode === "write") {
    const all = goldenCases().map((c) => ({ ...c, hashes: runCase(c) }));
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(all, null, 1) + "\n");
    console.log(`wrote ${all.length} cases, ${all.reduce((t, c) => t + c.hashes.length, 0)} hashes → ${FILE}`);
  } else {
    let bad = 0;
    for (const g of loadGolden()) {
      const h = runCase(g);
      const i = h.findIndex((x, k) => x !== g.hashes[k]);
      const ok = i < 0 && h.length === g.hashes.length;
      if (!ok) bad++;
      console.log(`${ok ? "ok  " : "DIFF"} ${g.map.padEnd(12)} ${g.blue}-${g.red} seed ${g.seed}${ok ? "" : ` first mismatch at hash #${i < 0 ? h.length : i} (tick ${(i < 0 ? h.length : i + 1) * EVERY})`}`);
    }
    console.log(bad ? `${bad} case(s) differ` : "all golden hashes match");
    process.exit(bad ? 1 : 0);
  }
}
