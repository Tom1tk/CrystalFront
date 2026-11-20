/**
 * 0.9 freeze guard (mainline 0.10 plan §1): the 0.9 ruleset's v2 bots must play exactly as in
 * v0.9.1-ML while the beta ruleset is built.
 *
 *   npx tsx headless/src/golden09.ts --write   # record headless/golden/v09_hashes.json
 *   npx tsx headless/src/golden09.ts --check   # exit 1 on any mismatch
 *
 * Neural cases: each shipped model (models/policy-*) against a v2 scripted bot, hashing every
 * decision (action and per-head log-probabilities, rounded to 1e-4) and the final match state.
 * Scripted cases: v2 scripted bot pairs, hashing every 500 ticks. Golden engine hashes
 * (goldenHashes.ts) cover the v1 menu bots.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MatchEngine } from "../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type PlayerSlot } from "../../server/src/match/types.js";
import { hashMatchState } from "../../server/src/match/engine/hash.js";
import { episodeStatus } from "./episode.js";
import * as V2 from "./v2/actions.js";
import * as OBS from "./v2/observation.js";
import { makeV2Bot } from "./v2/bots.js";
import { botContext } from "./v2/scripted.js";
import { mixSeed, strSeed } from "./v2/runner.js";
import { loadModel } from "./v2/neural.js";
import { playGame } from "./v2/neuralGame.js";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "../golden/v09_hashes.json");
const CAP = 3000;
const EVERY = 500;

interface Case { kind: "neural" | "scripted"; a: string; b: string; map: string; seed: number; side: 0 | 1 }
const CASES: Case[] = [
  { kind: "neural", a: "easy", b: "swarm", map: "shardfall", seed: 11, side: 0 },
  { kind: "neural", a: "normal", b: "turtle", map: "twin-spires", seed: 12, side: 1 },
  { kind: "neural", a: "hard", b: "backdoor", map: "basalt-run", seed: 13, side: 0 },
  { kind: "neural", a: "hard", b: "rush2", map: "cinder-flats", seed: 14, side: 1 },
  { kind: "scripted", a: "rush1", b: "macro", map: "shardfall", seed: 21, side: 0 },
  { kind: "scripted", a: "sw_turtle_grab", b: "swarm", map: "glimmerfen", seed: 22, side: 0 },
  { kind: "scripted", a: "backdoor", b: "gunline", map: "saltmarsh", seed: 23, side: 0 },
  { kind: "scripted", a: "heavy", b: "outrider", map: "ironreed", seed: 24, side: 0 },
];

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

async function runNeural(c: Case): Promise<string[]> {
  const model = await loadModel(`models/policy-${c.a}`);
  const h = createHash("sha256");
  const r = await playGame(model, c.b, c.map, c.seed, c.side, CAP, (rec) => {
    const x = rec as { tick: number; action: unknown; logp: Record<string, number> };
    const lp = Object.keys(x.logp).sort().map((k) => `${k}:${r4(x.logp[k])}`).join(",");
    h.update(`${x.tick}|${JSON.stringify(x.action)}|${lp}\n`);
  });
  return [h.digest("hex"), `${r.result}@${r.ticks}`];
}

function runScripted(c: Case): string[] {
  const ids = ["v2-blue", "v2-red"] as const;
  const engine = new MatchEngine();
  const players: [PlayerSlot, PlayerSlot] = [
    { playerId: ids[0], username: c.a, color: "blue", score: 0 },
    { playerId: ids[1], username: c.b, color: "red", score: 0 },
  ];
  const match = engine.createMatch(`g09-${c.seed}`, players, { ...DEFAULT_CONFIG, mapId: c.map, maxTicks: CAP }, c.seed);
  engine.startMatch(match.id);
  const seats = [V2.createSeatState(match, ids[0]), V2.createSeatState(match, ids[1])] as [V2.SeatState, V2.SeatState];
  const oss = [OBS.createObsState(match, seats[0]), OBS.createObsState(match, seats[1])];
  const bots = [c.a, c.b].map((n, i) => makeV2Bot(n, mixSeed(c.seed, strSeed(n + i)), botContext(match, seats[i], CAP)));
  const hashes: string[] = [];
  let st = episodeStatus(match, CAP);
  while (!st.terminated && !st.truncated) {
    for (const s of seats) V2.workerAutopilot(engine, match, s);
    const acts = [0, 1].map((i) => {
      const obs = OBS.observe(match, seats[i], oss[i], { z: bots[i].z ?? 0, cap: CAP });
      return bots[i].decide(obs, V2.computeMasks(match, seats[i]));
    }) as [V2.V2Action, V2.V2Action];
    V2.applyV2Pair(engine, match, seats, acts);
    for (let t = 0; t < V2.DECISION_TICKS && !st.terminated && !st.truncated; t++) {
      engine.tick(match.id);
      if (match.tick % EVERY === 0) hashes.push(hashMatchState(match));
      st = episodeStatus(match, CAP);
    }
  }
  hashes.push(hashMatchState(match));
  engine.destroyMatch(match.id);
  return hashes;
}

const run = (c: Case) => (c.kind === "neural" ? runNeural(c) : Promise.resolve(runScripted(c)));
const label = (c: Case) => `${c.kind.padEnd(8)} ${c.a}-${c.b} ${c.map} seed ${c.seed}`;

async function main() {
  if (process.argv.includes("--write")) {
    const out = [];
    for (const c of CASES) out.push({ ...c, hashes: await run(c) });
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(out, null, 1) + "\n");
    console.log(`wrote ${out.length} cases → ${FILE}`);
    return;
  }
  const golden = JSON.parse(readFileSync(FILE, "utf8")) as Array<Case & { hashes: string[] }>;
  let bad = 0;
  for (const g of golden) {
    const h = await run(g);
    const ok = h.length === g.hashes.length && h.every((x, i) => x === g.hashes[i]);
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "DIFF"} ${label(g)}`);
  }
  console.log(bad ? `${bad} case(s) differ` : "all 0.9 hashes match");
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
