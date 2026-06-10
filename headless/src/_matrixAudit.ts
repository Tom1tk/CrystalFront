import { runMatch } from "./runMatch.js";
import { MediumRushBot } from "./bots/mediumRushBot.js";

const numSeeds = Number(process.argv[2] ?? 30);

let blueWins = 0, redWins = 0, draws = 0;
const flips: number[] = [];

for (let seed = 1; seed <= numSeeds; seed++) {
  const result = runMatch(new MediumRushBot(), new MediumRushBot(), { seed });
  if (result.winner === "headless-blue") blueWins++;
  else if (result.winner === "headless-red") redWins++;
  else draws++;
}

console.log(`rush_medium vs rush_medium, seeds 1-${numSeeds}`);
console.log(`Blue: ${blueWins}  Red: ${redWins}  Draw: ${draws}`);
console.log(`Blue WR: ${(blueWins / numSeeds * 100).toFixed(1)}%`);
