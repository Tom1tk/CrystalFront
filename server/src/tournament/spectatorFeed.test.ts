import { describe, it, expect } from "vitest";
import { MatchEngine } from "../match/matchEngine.js";
import { ScriptedBotPlayer, scriptedBotFor } from "../match/scriptedBotPlayer.js";
import { DEFAULT_CONFIG, type MatchState } from "../match/types.js";
import { SpectatorFeeds } from "./spectatorFeed.js";

const CONFIG = { ...DEFAULT_CONFIG, mapId: "shardfall", ruleset: "beta" as const };

function hash(m: MatchState): string {
  return [...m.entities.values()].map((e) => `${e.id}:${e.type}:${e.ownerId}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.health}`).sort().join("|")
    + `#${m.economy.map((e) => e?.resources).join(",")}`;
}

/** A live bot-v-bot match (as the server runs it: tick, then the bots act at the new tick). */
function liveGame() {
  const engine = new MatchEngine();
  const live = engine.createMatch("LIVE", [
    { playerId: "pb", username: "Blue", color: "blue", score: 0 },
    { playerId: "pr", username: "Red", color: "red", score: 0 },
  ], CONFIG);
  engine.startMatch(live.id);
  const bots = [
    new ScriptedBotPlayer(scriptedBotFor("v3_rush1")!, "pb", live.id, engine),
    new ScriptedBotPlayer(scriptedBotFor("v3_macro")!, "pr", live.id, engine),
  ];
  /** `snap` sees the state at the new tick before that tick's commands, as a replay has it. */
  const step = (snap?: () => void) => { engine.tick(live.id); snap?.(); for (const b of bots) b.tick(); };
  return { engine, live, step };
}

describe("SpectatorFeeds", () => {
  it("never shows a tick newer than live − D, and replays the live match exactly", () => {
    const { live, step } = liveGame();
    let now = 0;
    const sent: Array<Record<string, unknown>> = [];
    const feeds = new SpectatorFeeds<string>({ send: (_w, m) => sent.push(m), serialize: (m) => ({ tick: m.tick }), now: () => now });
    const delay = 30, delayTicks = (delay * 1000) / live.tickIntervalMs;
    const liveHashes = new Map<number, string>();
    // Start watching part-way through: the feed must catch up, still never past live − D.
    const snap = () => liveHashes.set(live.tick, hash(live));
    for (let i = 0; i < 500; i++) { step(snap); now += 100; }
    expect(feeds.watch("viewer", live, CONFIG, delay)).toBe(true);
    let checked = 0;
    for (let i = 0; i < 2500 && live.phase === "playing"; i++) {
      step(snap);
      now += 100;
      feeds.step();
      const t = feeds.simTick(live.id)!;
      expect(t).toBeLessThanOrEqual(live.tick - delayTicks);
      if (t > 0 && liveHashes.has(t)) { expect(hash(feeds.simOf(live.id)!)).toBe(liveHashes.get(t)); checked++; }
    }
    expect(checked).toBeGreaterThan(1500);
    expect(live.commandLog.length).toBeGreaterThan(100);
    expect(sent[0].type).toBe("match_start");
    expect(sent.some((m) => m.type === "game_state")).toBe(true);
  }, 60_000);

  it("plays out the last D seconds after the live match ends, then ends the feed", () => {
    const { engine, live, step } = liveGame();
    let now = 0;
    const sent: Array<Record<string, any>> = [];
    const feeds = new SpectatorFeeds<string>({ send: (_w, m) => sent.push(m), serialize: (m) => ({ tick: m.tick }), now: () => now });
    feeds.watch("viewer", live, CONFIG, 30);
    for (let i = 0; i < 600; i++) { step(); now += 100; feeds.step(); }
    const endTick = live.tick;
    engine.endMatch(live.id, "pr" as never, "forfeit");
    // Straight after the end the feed is still 30 s behind.
    for (let i = 0; i < 299; i++) {
      now += 100; feeds.step();
      expect(feeds.simTick(live.id)!).toBeLessThanOrEqual(endTick - 300 + i + 1);
    }
    for (let i = 0; i < 5; i++) { now += 100; feeds.step(); }
    const end = sent.find((m) => m.type === "replay_end");
    expect(end?.payload.ticks).toBe(endTick);
    expect(end?.payload.winner).toBe("pr");
    expect(feeds.simTick(live.id)).toBeUndefined();
    // A finished match can't be spectated.
    expect(feeds.watch("late", live, CONFIG, 30)).toBe(false);
  }, 30_000);

  it("stops the simulation when the last spectator leaves", () => {
    const { live, step } = liveGame();
    const feeds = new SpectatorFeeds<string>({ send: () => {}, serialize: () => ({}) });
    for (let i = 0; i < 400; i++) step();
    feeds.watch("a", live, CONFIG, 30);
    feeds.watch("b", live, CONFIG, 30);
    feeds.unwatch("a");
    expect(feeds.simTick(live.id)).toBeDefined();
    feeds.unwatch("b");
    expect(feeds.simTick(live.id)).toBeUndefined();
  });
});
