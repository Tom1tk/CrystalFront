// G-10 M4: headless games of the ONNX policy (neural.ts) against v2 bots.
//
//   npx tsx headless/src/v3/neuralGame.ts --model models/policy-hard --bots rush2,turtle --maps shardfall --seeds 2 [--cap 12000] [--log out.jsonl]
//
// Plays like the training runner (worker autopilot → observe → masks → both
// decisions → applyV2Pair → 8 ticks), the policy in blue or red alternately.
// Prints one line per game and the win rate. --log writes every policy decision
// (obs, static grid, masks, action, per-head log-probs) for
// training/v2/test_onnx_parity.py.
import { createWriteStream } from "node:fs";
import { MatchEngine } from "../../../server/src/match/matchEngine.js";
import { DEFAULT_CONFIG, type PlayerSlot } from "../../../server/src/match/types.js";
import { episodeStatus, TRAIN_MAX_TICKS } from "../episode.js";
import * as V2 from "./actions.js";
import * as OBS from "./observation.js";
import { makeV2Bot } from "./bots.js";
import { botContext } from "./scripted.js";
import { encodeMasks, mixSeed, strSeed, toWire } from "./runner.js";
import { loadModel, NeuralPolicy, type NeuralModel } from "./neural.js";

const IDS = ["v2-blue", "v2-red"] as const;

export async function playGame(model: NeuralModel, bot: string, map: string, seed: number, side: 0 | 1, cap: number, log?: (rec: object) => void) {
  const engine = new MatchEngine();
  const players: [PlayerSlot, PlayerSlot] = [
    { playerId: IDS[0], username: side === 0 ? "policy" : bot, color: "blue", score: 0 },
    { playerId: IDS[1], username: side === 1 ? "policy" : bot, color: "red", score: 0 },
  ];
  const match = engine.createMatch(`ng-${seed}-${side}`, players, { ...DEFAULT_CONFIG, mapId: map, maxTicks: cap }, seed);
  engine.startMatch(match.id);
  const seats = [V2.createSeatState(match, IDS[0]), V2.createSeatState(match, IDS[1])] as [V2.SeatState, V2.SeatState];
  const oss = [OBS.createObsState(match, seats[0]), OBS.createObsState(match, seats[1])];
  const b = 1 - side;
  const opp = makeV2Bot(bot, mixSeed(seed, strSeed(bot)), botContext(match, seats[b], cap));
  const pol = new NeuralPolicy(model, mixSeed(seed, 7));
  const stat = OBS.staticGrid(match).data;
  let st = episodeStatus(match, cap), illegal = 0, step = 0;
  while (!st.terminated && !st.truncated) {
    for (const s of seats) V2.workerAutopilot(engine, match, s);
    const obs = [0, 1].map((i) => OBS.observe(match, seats[i], oss[i], { z: i === side ? 0 : opp.z ?? 0, cap }));
    const masks = [V2.computeMasks(match, seats[0]), V2.computeMasks(match, seats[1])];
    const botAct = opp.decide(obs[b], masks[b]);
    const d = await pol.decide(obs[side], stat, masks[side]);
    let a = d.action;
    if (!V2.isLegal(masks[side], a)) { illegal++; a = { ...V2.NOOP_ACTION }; }
    log?.({ step, tick: match.tick, obs: obs[side], ...(step === 0 ? { static: stat } : {}), masks: encodeMasks(masks[side]), action: toWire(d.action), logp: d.logp });
    const acts = (side === 0 ? [a, botAct] : [botAct, a]) as [V2.V2Action, V2.V2Action];
    V2.applyV2Pair(engine, match, seats, acts);
    for (let t = 0; t < V2.DECISION_TICKS && !st.terminated && !st.truncated; t++) {
      engine.tick(match.id);
      st = episodeStatus(match, cap);
    }
    step++;
  }
  const w = match.result?.winner;
  const result = st.truncated || !w ? "draw" : w === IDS[side] ? "win" : "loss";
  engine.destroyMatch(match.id);
  return { result, ticks: match.tick, illegal, decisions: step };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const model = await loadModel(opt("model", "models/policy-hard"));
  const bots = opt("bots", "rush2").split(","), maps = opt("maps", "shardfall").split(",");
  const seeds = Number(opt("seeds", "1")), cap = Number(opt("cap", String(TRAIN_MAX_TICKS)));
  const logPath = opt("log", "");
  const out = logPath ? createWriteStream(logPath) : null;
  let wins = 0, n = 0;
  for (const bot of bots) for (const map of maps) for (let s = 0; s < seeds; s++) {
    const seed = mixSeed(1000 + s, strSeed(map + bot)), side = (s % 2) as 0 | 1;
    const t0 = Date.now();
    const r = await playGame(model, bot, map, seed, side, cap, out ? (rec) => out.write(JSON.stringify({ game: n, ...rec }) + "\n") : undefined);
    n++; if (r.result === "win") wins++; else if (r.result === "draw") wins += 0.5;
    console.log(`${bot} ${map} seed=${seed} side=${side ? "red" : "blue"}: ${r.result} ticks=${r.ticks} decisions=${r.decisions} illegal=${r.illegal} (${((Date.now() - t0) / r.decisions).toFixed(1)} ms/decision)`);
  }
  out?.end();
  console.log(`score ${wins}/${n} = ${(wins / n).toFixed(2)}`);
}

if (process.argv[1]?.endsWith("neuralGame.ts")) main().catch((e) => { console.error(e); process.exit(1); });
