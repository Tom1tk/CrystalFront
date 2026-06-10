import { runMatch } from "./runMatch.js";
import { MediumRushBot } from "./bots/mediumRushBot.js";
import { WeakRushBot } from "./bots/weakRushBot.js";
import { MacroBot } from "./bots/macroBot.js";

// argv: [startSeed endSeed botName] or [numSeeds botName] (legacy: seeds 1..numSeeds)
const arg1 = Number(process.argv[2] ?? 30);
const arg2raw = process.argv[3];
const arg2 = arg2raw !== undefined && !isNaN(Number(arg2raw)) ? Number(arg2raw) : undefined;
const startSeed = arg2 !== undefined ? arg1 : 1;
const endSeed = arg2 !== undefined ? arg2 : arg1;
const numSeeds = endSeed - startSeed + 1;
const botName = process.argv[arg2 !== undefined ? 4 : 3] ?? "rush_medium";

const BOT_FACTORIES: Record<string, () => InstanceType<typeof MediumRushBot> | InstanceType<typeof WeakRushBot> | InstanceType<typeof MacroBot>> = {
  rush_medium: () => new MediumRushBot(),
  rush_weak: () => new WeakRushBot(),
  macro: () => new MacroBot(),
};

const makeBot = BOT_FACTORIES[botName];
if (!makeBot) {
  console.error(`Unknown bot: "${botName}". Options: ${Object.keys(BOT_FACTORIES).join(", ")}`);
  process.exit(1);
}

let blueWins = 0, redWins = 0, draws = 0;

for (let seed = startSeed; seed <= endSeed; seed++) {
  const result = runMatch(makeBot(), makeBot(), { seed });
  if (result.winner === "headless-blue") blueWins++;
  else if (result.winner === "headless-red") redWins++;
  else draws++;
}

console.log(`${botName} vs ${botName}, seeds ${startSeed}-${endSeed}`);
console.log(`Blue: ${blueWins}  Red: ${redWins}  Draw: ${draws}`);
console.log(`Blue WR: ${(blueWins / numSeeds * 100).toFixed(1)}%`);
