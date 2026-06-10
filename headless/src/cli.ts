#!/usr/bin/env tsx
/**
 * headless match CLI
 * Usage: tsx headless/src/cli.ts [--seed N] [--blue BOT] [--red BOT] [--ticks N] [--output FILE] [--no-save]
 * Bots: idle | rush | turtle | macro (default: macro vs macro)
 * Replays saved automatically to replays/ unless --no-save is passed.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMatch } from "./runMatch.js";
import { IdleBot, RushBot, WeakRushBot, WeakMediumRushBot, MediumRushBot, PassiveBot, TurtleBot, MacroBot, HeavyBot } from "./bots/index.js";
import type { Agent } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const REPLAYS_DIR = resolve(REPO_ROOT, "replays");

export function buildReplayPayload(
  result: Awaited<ReturnType<typeof runMatch>>,
  blue: string,
  red: string,
  version = "1.0"
) {
  return {
    version,
    seed: result.seed,
    blue,
    red,
    bluePlayerId: "headless-blue",
    redPlayerId: "headless-red",
    outcome: {
      winner: result.winner,
      winType: result.winType,
      ticks: result.ticks,
    },
    commandLog: result.commandLog,
    timestamp: Date.now(),
  };
}

function parseArgs(): {
  seed: number | undefined;
  blue: string;
  red: string;
  ticks: number;
  output: string | undefined;
  noSave: boolean;
} {
  const args = process.argv.slice(2);
  let seed: number | undefined;
  let blue = "macro";
  let red = "macro";
  let ticks = 6000;
  let output: string | undefined;
  let noSave = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seed"    && args[i+1]) { seed = parseInt(args[++i], 10); }
    if (args[i] === "--blue"    && args[i+1]) { blue = args[++i]; }
    if (args[i] === "--red"     && args[i+1]) { red = args[++i]; }
    if (args[i] === "--ticks"   && args[i+1]) { ticks = parseInt(args[++i], 10); }
    if (args[i] === "--output"  && args[i+1]) { output = args[++i]; }
    if (args[i] === "--no-save")               { noSave = true; }
  }

  return { seed, blue, red, ticks, output, noSave };
}

function makeBot(name: string): Agent {
  switch (name.toLowerCase()) {
    case "idle":           return new IdleBot();
    case "passive":        return new PassiveBot();
    case "rush":           return new RushBot();
    case "rush_weak":      return new WeakRushBot();
    case "rush_weak_medium": return new WeakMediumRushBot();
    case "rush_medium":    return new MediumRushBot();
    case "turtle":         return new TurtleBot();
    case "macro":          return new MacroBot();
    case "heavy":          return new HeavyBot();
    default:
      console.error(`Unknown bot: "${name}". Options: idle, passive, rush, rush_weak, rush_weak_medium, rush_medium, turtle, macro, heavy`);
      process.exit(1);
  }
}

const { seed, blue, red, ticks, output, noSave } = parseArgs();

console.log(`\nRunning: ${blue} (blue) vs ${red} (red) | seed=${seed ?? "random"} | maxTicks=${ticks}`);

const result = runMatch(makeBot(blue), makeBot(red), { seed, maxTicks: ticks });

const winnerLabel = result.winner
  ? (result.winner === "headless-blue" ? `${blue} (blue)` : `${red} (red)`)
  : "draw";
console.log(`\nResult:  ${winnerLabel} wins`);
console.log(`Ticks:   ${result.ticks} (${result.durationMs.toFixed(0)}ms wall-clock)`);
console.log(`Entities: blue=${result.finalEntityCount[0]}  red=${result.finalEntityCount[1]}`);
console.log(`Commands logged: ${result.commandLog.length}`);

const replay = buildReplayPayload(result, blue, red);

const savePath = output ?? (noSave ? null : (() => {
  if (!existsSync(REPLAYS_DIR)) mkdirSync(REPLAYS_DIR, { recursive: true });
  return resolve(REPLAYS_DIR, `${replay.timestamp}-${result.seed}.json`);
})());

if (savePath) {
  writeFileSync(savePath, JSON.stringify(replay));
  console.log(`\nReplay saved → ${savePath}`);
}
