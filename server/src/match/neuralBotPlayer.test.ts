import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MatchEngine } from "./matchEngine.js";
import { ScriptedBotPlayer, scriptedBotFor } from "./scriptedBotPlayer.js";
import { DEFAULT_CONFIG } from "./types.js";
import { NeuralBotPlayer, loadNeuralModels, neuralModelFor } from "./neuralBotPlayer.js";

const ROOT = resolve(__dirname, "../../..");
const HAVE = existsSync(resolve(ROOT, "models/policy-hard.main.onnx")) && existsSync(resolve(ROOT, "models/beta/policy-hard.main.onnx"));

describe.runIf(HAVE)("neural bots", () => {
  beforeAll(() => loadNeuralModels(ROOT), 60_000);

  it("picks the beta model for beta matches and the 0.9 model otherwise", () => {
    expect(neuralModelFor("neural_hard", "beta")?.layout).toBe("v3");
    expect(neuralModelFor("neural_hard", "0.9")?.layout).toBe("v2");
    expect(neuralModelFor("neural_hard")?.layout).toBe("v2");
    expect(neuralModelFor("neural09_hard", "beta")?.layout).toBe("v2");
    expect(neuralModelFor("neuralb_hard")?.layout).toBe("v3");
    expect(neuralModelFor("neural_bogus")).toBeNull();
  });

  it("the beta Hard bot plays a beta match through its own layout", async () => {
    const engine = new MatchEngine();
    const match = engine.createMatch("NB", [
      { playerId: "pn", username: "Neural", color: "blue", score: 0 },
      { playerId: "ps", username: "Bot", color: "red", score: 0 },
    ], { ...DEFAULT_CONFIG, mapId: "shardfall", ruleset: "beta" }, 12345);
    engine.startMatch(match.id);
    const neural = new NeuralBotPlayer(neuralModelFor("neural_hard", "beta")!, "pn", match.id, engine);
    const bot = new ScriptedBotPlayer(scriptedBotFor("v3_macro")!, "ps", match.id, engine);
    for (let i = 0; i < 2400 && match.phase === "playing"; i++) {
      engine.tick(match.id);
      const before = neural.reads.length;
      neural.tick();
      bot.tick();
      // Wait for this tick's decision, as the server would before the next one.
      if ((neural as unknown as { pending: boolean }).pending) {
        while (neural.reads.length === before && !(neural as unknown as { failed: boolean }).failed) await new Promise((r) => setTimeout(r, 1));
      }
    }
    expect((neural as unknown as { failed: boolean }).failed).toBe(false);
    expect(neural.reads.length).toBeGreaterThan(250);
    const mine = match.commandLog.filter((c) => c.playerId === "pn");
    expect(mine.length).toBeGreaterThan(100);
    expect(neural.reads.at(-1)!.units).toHaveProperty("outrider");
  }, 120_000);
});
