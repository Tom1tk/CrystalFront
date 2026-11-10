#!/usr/bin/env tsx
/**
 * G-9d headless throughput benchmark.
 * Runs a fixed set of seeded scripted-bot matches and reports simulated ticks/sec.
 * Usage: npm run bench [-- --matches N]
 * Compare against the baseline recorded in docs/GAME_UPDATE_PLAN.md (G-4 budget: <10% loss).
 */
import { runMatch } from "./runMatch.js";
import { MacroBot, MediumRushBot, TurtleBot } from "./bots/index.js";

const argIdx = process.argv.indexOf("--matches");
const matches = argIdx > 0 ? parseInt(process.argv[argIdx + 1], 10) : 12;
const pairings = [
  () => [new MacroBot(), new MediumRushBot()],
  () => [new MacroBot(), new TurtleBot()],
  () => [new MediumRushBot(), new MediumRushBot()],
] as const;

let ticks = 0;
const t0 = performance.now();
for (let i = 0; i < matches; i++) {
  const [b, r] = pairings[i % pairings.length]();
  ticks += runMatch(b, r, { seed: 1000 + i, maxTicks: 6000 }).ticks;
}
const sec = (performance.now() - t0) / 1000;
console.log(`matches=${matches} ticks=${ticks} wall=${sec.toFixed(2)}s ticks/sec=${(ticks / sec).toFixed(0)}`);
