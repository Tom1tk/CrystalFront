/**
 * Balance report (G-8). Offline only.
 *
 *   npx tsx headless/src/balance.ts [--games 6] [--bots rush,macro,turtle,heavy]
 *       [--maps all|id,id] [--maxTicks 6000] [--jobs 12] [--json out.json]
 *       [--mirror]  (mirror pairings only)
 *
 * Runs every ordered bot pair (both sides) on every map, `games` seeds each,
 * spread over `jobs` worker processes. Prints:
 *   - the strategy matrix (row's win rate vs column, both sides pooled),
 *   - mirror-match blue score per map,
 *   - timeouts and win types.
 * Checks the G-8 acceptance criteria and prints PASS/FAIL for each.
 */
import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { runMatch } from "./runMatch.js";
import { HeavyBot, MacroBot, MediumRushBot, TurtleBot } from "./bots/index.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import { poolMaps } from "../../server/src/match/maps.js";
import type { Agent } from "./types.js";

const BOTS: Record<string, () => Agent> = {
  rush: () => new MediumRushBot(),
  macro: () => new MacroBot(),
  turtle: () => new TurtleBot(),
  heavy: () => new HeavyBot(),
};

interface Job { blue: string; red: string; map: string; seed: number; maxTicks: number }
interface Res extends Job { winner: "blue" | "red" | null; winType: string; ticks: number }

function play(j: Job): Res {
  const r = runMatch(BOTS[j.blue](), BOTS[j.red](), { seed: j.seed, maxTicks: j.maxTicks, config: { ...DEFAULT_CONFIG, mapId: j.map } });
  const winner = r.winner === "headless-blue" ? "blue" : r.winner === "headless-red" ? "red" : null;
  return { ...j, winner, winType: r.winType ?? (winner ? "combat" : "timeout"), ticks: r.ticks };
}

// ── worker mode ──
if (process.env.BALANCE_WORKER) {
  process.on("message", (jobs: Job[]) => {
    for (const j of jobs) process.send!(play(j));
    process.send!("done");
  });
} else {
  void main();
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

async function main(): Promise<void> {
  const games = Number(arg("games", "6"));
  const bots = arg("bots", "rush,macro,turtle,heavy").split(",");
  const mapArg = arg("maps", "all");
  const maps = mapArg === "all" ? poolMaps().map((m) => m.mapId) : mapArg.split(",");
  const maxTicks = Number(arg("maxTicks", "6000"));
  const jobsN = Number(arg("jobs", "12"));
  const mirrorOnly = process.argv.includes("--mirror");

  const jobs: Job[] = [];
  for (const map of maps) for (const blue of bots) for (const red of bots) for (let g = 0; g < games; g++) {
    if (mirrorOnly && blue !== red) continue;
    jobs.push({ blue, red, map, seed: 9000 + g, maxTicks });
  }
  const t0 = Date.now();
  const results: Res[] = [];
  await new Promise<void>((resolve) => {
    let live = 0;
    for (let w = 0; w < jobsN; w++) {
      const slice = jobs.filter((_, i) => i % jobsN === w);
      if (!slice.length) continue;
      live++;
      const child = fork(process.argv[1], [], { env: { ...process.env, BALANCE_WORKER: "1" }, execArgv: process.execArgv });
      child.on("message", (m: Res | "done") => {
        if (m === "done") { child.kill(); if (--live === 0) resolve(); return; }
        results.push(m);
        if (results.length % 100 === 0) process.stderr.write(`${results.length}/${jobs.length}\n`);
      });
      child.send(slice);
    }
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  report(results, bots, maps, games, secs);
  const out = arg("json", "");
  if (out) writeFileSync(out, JSON.stringify(results));
}

function report(rs: Res[], bots: string[], maps: string[], games: number, secs: string): void {
  const pct = (x: number) => (x * 100).toFixed(0).padStart(4) + "%";
  console.log(`${rs.length} matches, ${maps.length} maps, ${games} seeds per side, ${secs}s\n`);

  // Strategy matrix: A's score vs B (A on either side), excluding mirrors.
  const score = (a: string, b: string) => {
    let s = 0, n = 0;
    for (const r of rs) {
      if (r.blue === a && r.red === b) { s += r.winner === "blue" ? 1 : r.winner === "red" ? 0 : 0.5; n++; }
      else if (r.blue === b && r.red === a) { s += r.winner === "red" ? 1 : r.winner === "blue" ? 0 : 0.5; n++; }
    }
    return n ? s / n : NaN;
  };
  console.log("Strategy matrix (row's score vs column, both sides, all maps):");
  console.log("        " + bots.map((b) => b.padStart(7)).join(""));
  for (const a of bots) console.log(a.padEnd(8) + bots.map((b) => (a === b ? "    -  " : pct(score(a, b)) + "  ")).join(""));

  // Mirror per map.
  console.log("\nMirror matches, blue score per map (all bots):");
  const mirrorScores: Record<string, number> = {};
  for (const m of maps) {
    const ms = rs.filter((r) => r.map === m && r.blue === r.red);
    const s = ms.reduce((t, r) => t + (r.winner === "blue" ? 1 : r.winner === "red" ? 0 : 0.5), 0) / ms.length;
    mirrorScores[m] = s;
    const per = bots.map((b) => {
      const bs = ms.filter((r) => r.blue === b);
      return `${b} ${(bs.reduce((t, r) => t + (r.winner === "blue" ? 1 : r.winner === "red" ? 0 : 0.5), 0) / bs.length).toFixed(2)}`;
    }).join("  ");
    console.log(`  ${m.padEnd(14)} ${s.toFixed(2)}   (${per})`);
  }

  // Timeouts and win types.
  const types: Record<string, number> = {};
  for (const r of rs) types[r.winType] = (types[r.winType] ?? 0) + 1;
  const timeouts = (types.timeout ?? 0) / rs.length;
  console.log(`\nWin types: ${Object.entries(types).map(([k, v]) => `${k} ${v} (${pct(v / rs.length).trim()})`).join(", ")}`);
  const avgTicks = rs.filter((r) => r.winType !== "timeout").reduce((t, r) => t + r.ticks, 0) / Math.max(1, rs.filter((r) => r.winType !== "timeout").length);
  console.log(`Average length of decided games: ${avgTicks.toFixed(0)} ticks`);
  console.log("Timeouts per pairing: " + bots.flatMap((a) => bots.map((b) => {
    const p = rs.filter((r) => r.blue === a && r.red === b);
    return `${a}-${b} ${p.filter((r) => r.winType === "timeout").length}/${p.length}`;
  })).join(", "));

  // Acceptance criteria.
  console.log("\nG-8 acceptance:");
  if (rs.some((r) => r.blue !== r.red)) {
    const dominant = bots.filter((a) => bots.every((b) => a === b || score(a, b) > 0.7));
    console.log(`  [${dominant.length ? "FAIL" : "PASS"}] no strategy wins >70% vs every other${dominant.length ? ` (${dominant.join(", ")})` : ""}`);
    if (bots.includes("rush")) {
      const best = Math.max(...bots.filter((b) => b !== "rush").map((b) => score(b, "rush")));
      console.log(`  [${best >= 0.4 ? "PASS" : "FAIL"}] rush beatable at >=40% (best counter ${pct(best).trim()})`);
    }
  }
  const bad = maps.filter((m) => Math.abs(mirrorScores[m] - 0.5) > 0.1);
  console.log(`  [${bad.length ? "FAIL" : "PASS"}] mirror 50% ± 10% on every map${bad.length ? ` (${bad.join(", ")})` : ""}`);
  console.log(`  [${timeouts < 0.15 ? "PASS" : "FAIL"}] timeouts < 15% (${pct(timeouts).trim()})`);
}
