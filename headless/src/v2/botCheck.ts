/**
 * G-10 M0 T8 acceptance check for the v2 scripted bots. Offline only.
 *
 *   npx tsx headless/src/v2/botCheck.ts [--games 5] [--maps all|id,id] [--maxTicks 12000] [--jobs 12]
 *
 * Every scripted bot plays `games` games on every pool map (as blue; its
 * opponents cycle through the other scripted bots, seeds 500…) and must finish
 * each without an exception and with zero ineffective or illegal actions on
 * both seats. The first game of each bot and map is then replayed with the same
 * seed and must end identically (winner, win type, ticks, final state hash).
 * Exits 1 on any failure.
 */
import { fork } from "node:child_process";
import { poolMaps } from "../../../server/src/match/maps.js";
import { hashMatchState } from "../../../server/src/match/engine/hash.js";
import { VecRunnerV2 } from "./runner.js";
import { SCRIPTED } from "./scripted.js";

interface Job { blue: string; red: string; map: string; seed: number; maxTicks: number; repeat: boolean }
interface Res extends Job { error: string | null; winner: string | null; winType: string | null; ticks: number; hash: string; ineffective: number; z: number; again?: string }

function playOnce(j: Job): Omit<Res, keyof Job> {
  let last: Parameters<typeof hashMatchState>[0] | null = null;
  const r = new VecRunnerV2({ onTick: (_s, m) => { last = m; } });
  try {
    let res = r.handle({ type: "reset_all", max_ticks: j.maxTicks, critic: false, slots: [{ seed: j.seed, map: j.map, blue: `bot:${j.blue}`, red: `bot:${j.red}` }] }) as Record<string, any>;
    for (;;) {
      if (res.type === "error") throw new Error(res.message);
      const s = res.slots?.[0];
      if (s && (s.done || s.truncated)) {
        const i = s.info;
        let ineffective = 0;
        for (const side of ["blue", "red"]) ineffective += i.stats[side].econIneffective + i.stats[side].armyIneffective + i.stats[side].illegal;
        const botErrors = i.stats.blue.botErrors + i.stats.red.botErrors;
        if (botErrors) throw new Error(`${botErrors} bot exceptions (see stderr)`);
        // Final state of the finished match (the runner keeps no reference to it, but the object is intact).
        const hash = last ? hashMatchState(last) : "";
        return { error: null, winner: i.winner, winType: i.winType, ticks: i.ticks, hash, ineffective, z: i.episode.botZ.blue };
      }
      res = r.handle({ type: "step", actions: [{}] }) as Record<string, any>;
    }
  } catch (e) {
    return { error: (e as Error).stack ?? String(e), winner: null, winType: null, ticks: 0, hash: "", ineffective: 0, z: 0 };
  }
}

function play(j: Job): Res {
  const a = playOnce(j);
  const out: Res = { ...j, ...a };
  if (j.repeat && !a.error) {
    const b = playOnce(j);
    const key = (x: typeof a) => `${x.winner}/${x.winType}/${x.ticks}/${x.hash}`;
    if (key(a) !== key(b)) out.again = key(b);
  }
  return out;
}

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

if (process.env.BOTCHECK_WORKER) {
  process.on("message", (jobs: Job[]) => {
    for (const j of jobs) process.send!(play(j));
    process.send!("done");
  });
} else {
  void main();
}

async function main(): Promise<void> {
  const games = Number(arg("games", "5"));
  const mapArg = arg("maps", "all");
  const maps = mapArg === "all" ? poolMaps().map((m) => m.mapId) : mapArg.split(",");
  const maxTicks = Number(arg("maxTicks", "12000"));
  const jobsN = Number(arg("jobs", "12"));
  const bots = Object.keys(SCRIPTED);
  const jobs: Job[] = [];
  for (const map of maps) bots.forEach((blue, bi) => {
    for (let g = 0; g < games; g++) {
      const red = bots[(bi + 1 + g) % bots.length];
      jobs.push({ blue, red: red === blue ? bots[(bi + 2 + g) % bots.length] : red, map, seed: 500 + g, maxTicks, repeat: g === 0 });
    }
  });
  const t0 = Date.now();
  const results: Res[] = [];
  await new Promise<void>((resolve) => {
    let live = 0;
    for (let w = 0; w < jobsN; w++) {
      const slice = jobs.filter((_, i) => i % jobsN === w);
      if (!slice.length) continue;
      live++;
      const child = fork(process.argv[1], [], { env: { ...process.env, BOTCHECK_WORKER: "1" }, execArgv: process.execArgv });
      child.on("message", (m: Res | "done") => {
        if (m === "done") { child.kill(); if (--live === 0) resolve(); return; }
        results.push(m);
        if (results.length % 50 === 0) process.stderr.write(`${results.length}/${jobs.length}\n`);
      });
      child.send(slice);
    }
  });

  const errors = results.filter((r) => r.error), ineff = results.filter((r) => r.ineffective > 0), nondet = results.filter((r) => r.again);
  console.log(`${results.length} games (${bots.length} bots × ${maps.length} maps × ${games}), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const b of bots) {
    const rs = results.filter((r) => r.blue === b);
    const w = rs.filter((r) => r.winner === "blue").length, l = rs.filter((r) => r.winner === "red").length;
    const zs = [...new Set(rs.map((r) => r.z))].sort((x, y) => x - y).join("/");
    const avg = rs.reduce((t, r) => t + r.ticks, 0) / Math.max(1, rs.length);
    console.log(`  ${b.padEnd(18)} z ${zs.padEnd(6)} W${w} L${l} T${rs.length - w - l}  avg ${avg.toFixed(0)} ticks`);
  }
  const show = (label: string, rs: Res[], f: (r: Res) => string) => {
    console.log(`[${rs.length ? "FAIL" : "PASS"}] ${label}${rs.length ? `: ${rs.length}` : ""}`);
    for (const r of rs.slice(0, 5)) console.log(`    ${r.blue} v ${r.red} on ${r.map} seed ${r.seed}: ${f(r)}`);
  };
  show("no exceptions", errors, (r) => r.error!.split("\n").slice(0, 3).join(" | "));
  show("ineffective-action rate 0", ineff, (r) => `${r.ineffective} ineffective`);
  show("identical seeds → identical games", nondet, (r) => `${r.winner}/${r.winType}/${r.ticks}/${r.hash} vs ${r.again}`);
  process.exit(errors.length || ineff.length || nondet.length ? 1 : 0);
}
