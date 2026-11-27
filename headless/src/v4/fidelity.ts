// Rebuild R1 S11 (docs/REBUILD_R1_PLAN.md): does a strategy-forced exploiter play its bot's plan?
// Replay-based, from an evaluation's saved replays.
//
//   npx tsx headless/src/v4/fidelity.ts <eval.json> --strategy backdoor|flank
//       [--seat policy|opponent] [--replays replays] [--out fidelity.json]
//
// Per game, for one seat (`policy`: the evaluated network; `opponent`: the other seat):
//   backdoor  an own building within 900 px of the enemy crystal by 6:00.
//   flank     before the first attack (≥ 3 own combat units within 700 px of the enemy crystal), the own
//             combat units in the enemy half (≥ 3 of them) were at some point, on average, ≥ 0.25 of the map
//             height off the line between the two crystals. Scored on FLANK_MAPS only, the maps whose
//             natural lanes run down the middle; on the others every bot's army goes round the side.
// No attack counts as a miss. The plan holds in ≥ 60% of the scored games (PASS_RATE): below the scripted
// bots' own rates (0.7–1.0), well above the other bots' (≤ 0.1).
//
// Calibrated on the scripted bots: this tool on evaluate.py --checkpoint bot:<b> --z <z> --maps train
// --save-replays, vs macro,gunline (1 seed) / vs idle (2 seeds); 32 games each, 19–21 scored for flank.
//                backdoor      flank
//   backdoor z23  0.75 / 0.75   0.1 / 0
//   flank z27     0    / 0      0.7 / 1.0
//   hidden z11    0    / 0      0   / 0
//   gunline       0    / 0      0   / 0
//   macro         0    / 0      0   / 0
//   rush2         0    / 0      0   / 0
// The backdoor misses are maps where the bot places no outposts (saltmarsh, twin-spires; vs macro/gunline
// also basalt-run, glimmerfen).
// "hidden" has no check: the hidden bot (z11) stages beside brush, not in it, and neither brush time nor
// time unseen by the opponent separates it from the other bots, so no criterion could be calibrated.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replayCommandLog } from "./replayObs.js";
import { frameFor, toOwnFrame } from "./frame.js";

const TPS = 10;
const COMBAT = new Set(["skirmisher", "gunner", "bruiser", "medic", "bulwark"]);
export const STRATEGIES = ["backdoor", "flank"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const PASS_RATE = 0.6;
/** Maps whose natural lanes run down the middle (flank is scored only there; see the header). */
export const FLANK_MAPS = new Set(["hollow-crown", "cinder-flats", "ironreed", "saltmarsh", "glimmerfen"]);
const SAMPLE = 10; // ticks between samples
const FLANK_OFF = 0.25; // army off the crystal line, in map heights
type P = { x: number; y: number };
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Whether `seat` played `strategy` in replay `r`; null when the game is not scored (flank off FLANK_MAPS). */
export function fidelity(r: any, seat: "blue" | "red", strategy: Strategy): boolean | null {
  if (strategy === "flank" && !FLANK_MAPS.has(r.mapId)) return null;
  const P = seat === "blue" ? r.bluePlayerId : r.redPlayerId, E = seat === "blue" ? r.redPlayerId : r.bluePlayerId;
  let enemyHome: any = null, ownHome: any = null, frame: ReturnType<typeof frameFor> | null = null;
  let hit = false, done = false, off = 0;
  replayCommandLog(r, (m: any) => {
    if (done || m.tick % SAMPLE) return;
    frame ??= frameFor(m, P);
    const ents = [...m.entities.values()] as any[];
    enemyHome ??= ents.find((e) => e.type === "crystal" && e.ownerId === E);
    ownHome ??= ents.find((e) => e.type === "crystal" && e.ownerId === P);
    if (!enemyHome || !ownHome) return;
    if (strategy === "backdoor") {
      if (m.tick > 360 * TPS) { done = true; return; }
      if (ents.some((e) => e.ownerId === P && e.type === "building" && dist(e, enemyHome) < 900)) { hit = true; done = true; }
      return;
    }
    const army = ents.filter((e) => e.ownerId === P && COMBAT.has(e.type));
    if (army.filter((e) => dist(e, enemyHome) < 700).length >= 3) { hit = off >= FLANK_OFF; done = true; return; }
    const far = army.map((e) => toOwnFrame(frame!, e)).filter((p) => p.x > frame!.W / 2);
    if (far.length < 3) return;
    const a = toOwnFrame(frame, ownHome), b = toOwnFrame(frame, enemyHome);
    const c = { x: far.reduce((s, p) => s + p.x, 0) / far.length, y: far.reduce((s, p) => s + p.y, 0) / far.length };
    off = Math.max(off, Math.abs((b.x - a.x) * (a.y - c.y) - (a.x - c.x) * (b.y - a.y)) / dist(a, b) / frame.H);
  });
  return hit;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const strategy = opt("--strategy", "") as Strategy, which = opt("--seat", "policy"), dir = opt("--replays", "replays"), out = opt("--out", "");
  if (!STRATEGIES.includes(strategy)) throw new Error(`--strategy: one of ${STRATEGIES.join(", ")}`);
  const games = JSON.parse(readFileSync(argv[0], "utf8")).games.filter((g: any) => g.replayId);
  if (!games.length) throw new Error("no games with replays (evaluate with --save-replays)");
  const per = games.map((g: any) => {
    const side = which === "policy" ? g.side : g.side === "blue" ? "red" : "blue";
    return { replayId: g.replayId, opp: g.opp, map: g.map, side, result: g.result, hit: fidelity(JSON.parse(readFileSync(join(dir, `${g.replayId}.json`), "utf8")), side, strategy) };
  });
  const scored = per.filter((x: any) => x.hit !== null);
  const rate = scored.length ? scored.filter((x: any) => x.hit).length / scored.length : 0;
  const res = { strategy, seat: which, games: scored.length, rate, pass: scored.length > 0 && rate >= PASS_RATE, perGame: per };
  if (out) writeFileSync(out, JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ strategy, seat: which, games: scored.length, rate: Math.round(rate * 1000) / 1000, pass: res.pass }));
}

if (process.argv[1]?.endsWith("fidelity.ts")) main();
