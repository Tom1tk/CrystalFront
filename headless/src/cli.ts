#!/usr/bin/env tsx
/**
 * headless match CLI
 * Usage: tsx headless/src/cli.ts [--seed N] [--blue BOT] [--red BOT] [--ticks N] [--output FILE]
 * Bots: idle | rush | turtle | macro (default: macro vs macro)
 */
import { writeFileSync } from "node:fs";
import { runMatch } from "./runMatch.js";
import { IdleBot, RushBot, TurtleBot, MacroBot } from "./bots/index.js";
import type { Agent } from "./types.js";

function parseArgs(): {
  seed: number | undefined;
  blue: string;
  red: string;
  ticks: number;
  output: string | undefined;
} {
  const args = process.argv.slice(2);
  let seed: number | undefined;
  let blue = "macro";
  let red = "macro";
  let ticks = 6000;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seed"   && args[i+1]) { seed = parseInt(args[++i], 10); }
    if (args[i] === "--blue"   && args[i+1]) { blue = args[++i]; }
    if (args[i] === "--red"    && args[i+1]) { red = args[++i]; }
    if (args[i] === "--ticks"  && args[i+1]) { ticks = parseInt(args[++i], 10); }
    if (args[i] === "--output" && args[i+1]) { output = args[++i]; }
  }

  return { seed, blue, red, ticks, output };
}

function makeBot(name: string): Agent {
  switch (name.toLowerCase()) {
    case "idle":   return new IdleBot();
    case "rush":   return new RushBot();
    case "turtle": return new TurtleBot();
    case "macro":  return new MacroBot();
    default:
      console.error(`Unknown bot: "${name}". Options: idle, rush, turtle, macro`);
      process.exit(1);
  }
}

const { seed, blue, red, ticks, output } = parseArgs();

console.log(`\nRunning: ${blue} (blue) vs ${red} (red) | seed=${seed ?? "random"} | maxTicks=${ticks}`);

const result = runMatch(makeBot(blue), makeBot(red), { seed, maxTicks: ticks });

const winnerLabel = result.winner ? (result.winner === "headless-blue" ? `${blue} (blue)` : `${red} (red)`) : "draw";
console.log(`\nResult:  ${winnerLabel} wins`);
console.log(`Ticks:   ${result.ticks} (${(result.durationMs).toFixed(0)}ms wall-clock)`);
console.log(`Entities: blue=${result.finalEntityCount[0]}  red=${result.finalEntityCount[1]}`);
console.log(`Commands logged: ${result.commandLog.length}`);

if (output) {
  const replay = {
    version: "1.0",
    seed: result.seed,
    blue,
    red,
    outcome: {
      winner: result.winner,
      ticks: result.ticks,
    },
    commandLog: result.commandLog,
  };
  writeFileSync(output, JSON.stringify(replay, null, 2));
  console.log(`\nReplay saved → ${output}`);
}
