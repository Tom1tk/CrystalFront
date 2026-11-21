/**
 * Delayed spectating (docs/TOURNAMENT_SPEC.md §6). A spectated tournament match gets a second
 * simulation that replays the live match's command log, held D seconds behind it. Spectators get
 * the full, fog-free state of that simulation plus both players' vision. The delay is enforced
 * here: the simulation never runs past `liveTick − D`, so a second tab can't see through fog.
 *
 * Feeds start on the first spectator and stop when the last leaves. A late feed catches up
 * quickly to the delayed point. After the live match ends, the feed plays out the last D seconds
 * and then sends `replay_end`.
 */
import { MatchEngine } from "../match/matchEngine.js";
import { DEFAULT_CONFIG, type MatchConfig, type MatchState, type PlayerSlot } from "../match/types.js";

type Command = Parameters<MatchEngine["processCommand"]>[2];

/** Ticks a new feed may run per step to catch up (×10 steps/s). */
const CATCH_UP_TICKS = 200;

export interface FeedInfo { delay: number; [k: string]: unknown }

interface Feed<W> {
  live: MatchState;
  simId: string;
  delayTicks: number;
  /** Next command-log entry to apply. */
  cursor: number;
  watchers: Set<W>;
  info: FeedInfo;
  /** Wall clock when the live match was first seen ended. */
  liveEndedAt?: number;
}

export interface FeedHooks<W> {
  send: (w: W, msg: Record<string, unknown>) => void;
  /** Full match state payload; `start` = with the static map (match_start). */
  serialize: (match: MatchState, start: boolean) => Record<string, unknown>;
  now?: () => number;
}

export class SpectatorFeeds<W> {
  readonly engine = new MatchEngine();
  private feeds = new Map<string, Feed<W>>();
  private now: () => number;

  constructor(private hooks: FeedHooks<W>) {
    this.now = hooks.now ?? Date.now;
  }

  /** Start watching `live` with a delay of `delaySeconds`. Returns false if the match has ended. */
  watch(w: W, live: MatchState, config: MatchConfig, delaySeconds: number, info: Record<string, unknown> = {}): boolean {
    this.unwatch(w);
    let feed = this.feeds.get(live.id);
    if (!feed) {
      if (live.phase === "ended") return false;
      const players = live.players.map((p) => (p ? { ...p } : null)) as [PlayerSlot | null, PlayerSlot | null];
      const sim = this.engine.createMatch(`spectate:${live.lobbyCode}`, players, { ...DEFAULT_CONFIG, ...config }, live.seed);
      this.engine.startMatch(sim.id);
      const delayTicks = Math.ceil((delaySeconds * 1000) / live.tickIntervalMs);
      feed = { live, simId: sim.id, delayTicks, cursor: 0, watchers: new Set(), info: { ...info, delay: delaySeconds } };
      this.feeds.set(live.id, feed);
      this.advance(feed);
    }
    feed.watchers.add(w);
    const sim = this.engine.getMatch(feed.simId)!;
    this.hooks.send(w, { type: "match_start", payload: { match: this.hooks.serialize(sim, true), spectate: feed.info } });
    return true;
  }

  unwatch(w: W): void {
    for (const [id, feed] of this.feeds) {
      if (feed.watchers.delete(w) && feed.watchers.size === 0) this.close(id);
    }
  }

  /** The newest tick a spectator may see now. */
  allowedTick(feed: Feed<W>): number {
    let liveTick = feed.live.tick;
    if (feed.live.phase === "ended") {
      feed.liveEndedAt ??= this.now();
      // The game clock keeps running for the delay after the end, so the end is still D seconds late.
      liveTick += Math.floor((this.now() - feed.liveEndedAt) / feed.live.tickIntervalMs);
    }
    return liveTick - feed.delayTicks;
  }

  /** Advance every feed toward its delayed point; call every simulation tick. */
  step(): void {
    for (const [id, feed] of this.feeds) {
      const moved = this.advance(feed);
      const sim = this.engine.getMatch(feed.simId)!;
      const done = sim.phase !== "playing" || (feed.live.phase === "ended" && sim.tick >= feed.live.tick);
      if (moved || done) {
        const state = { type: "game_state", payload: { match: this.hooks.serialize(sim, false), isReplay: true } };
        for (const w of feed.watchers) this.hooks.send(w, state);
      }
      if (done) {
        const winner = feed.live.result?.winner ?? sim.result?.winner ?? null;
        for (const w of feed.watchers) this.hooks.send(w, { type: "replay_end", payload: { ticks: sim.tick, winner } });
        this.close(id);
      }
    }
  }

  /** Simulation tick of a feed (tests). */
  simTick(liveMatchId: string): number | undefined {
    const feed = this.feeds.get(liveMatchId);
    return feed && this.engine.getMatch(feed.simId)?.tick;
  }

  simOf(liveMatchId: string): MatchState | undefined {
    const feed = this.feeds.get(liveMatchId);
    return feed && this.engine.getMatch(feed.simId);
  }

  stopAll(): void {
    for (const id of [...this.feeds.keys()]) this.close(id);
  }

  private advance(feed: Feed<W>): boolean {
    const sim = this.engine.getMatch(feed.simId)!;
    const log = feed.live.commandLog;
    // Live has ended: stop at its last tick (a forfeit ends it without the simulation ending).
    const limit = Math.min(this.allowedTick(feed), feed.live.phase === "ended" ? feed.live.tick : Infinity);
    let n = 0;
    while (sim.phase === "playing" && sim.tick < limit && n < CATCH_UP_TICKS) {
      // Commands logged at tick T were applied before the live tick T → T+1, as in a replay.
      while (feed.cursor < log.length && log[feed.cursor].tick <= sim.tick) {
        const e = log[feed.cursor++];
        if (e.tick === sim.tick) this.engine.processCommand(sim.id, e.playerId, e.command as unknown as Command);
      }
      this.engine.tick(sim.id);
      n++;
    }
    return n > 0;
  }

  private close(id: string): void {
    const feed = this.feeds.get(id);
    if (!feed) return;
    this.engine.destroyMatch(feed.simId);
    this.feeds.delete(id);
  }
}
