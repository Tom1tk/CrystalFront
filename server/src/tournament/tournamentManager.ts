/**
 * Tournaments (docs/TOURNAMENT_SPEC.md): Swiss, round robin, single and double elimination: lifecycle, ready checks, series, manager operations and
 * saving to disk. No sockets or engine here: the server calls the methods, drives time with `tick(now)`
 * and starts and stops matches through the hooks.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_TOURNAMENT_SETTINGS, LOBBY_CODE_CHARS, LOBBY_CODE_LENGTH, TOURNAMENT_LIMITS,
  bracketRounds, buildBracket, defaultRounds, eliminationRanks, finalNode, nextMap, pairRound, resolveBracket, roundRobin,
  seriesBlue, seriesMaps, seriesState, standings,
  type BracketNode, type GameOutcome, type NodeSeries, type TournamentFormat, type SeriesLength, type SwissPlayer, type SwissRound, type TournamentEntrant,
  type TournamentPublicState, type TournamentRound, type TournamentSeries, type TournamentSettings,
  type TournamentSummary, type TournamentViewer,
} from "@crystalfront/shared";

export interface Tournament extends Omit<TournamentPublicState, "standings"> {
  managerToken: string;
  /** Entrant id → player token (humans only). */
  tokens: Record<string, string>;
  /** Finish when the current round is done (finish early, letting matches finish). */
  finishing?: boolean;
  nextEntrant: number;
  /** Elimination formats: the bracket, fixed at the start. */
  bracket?: BracketNode[];
  /** Round robin: entrant ids of each round's pairs (null = sits out), fixed at the start. */
  schedule?: [string, string | null][][];
}

export interface TournamentHooks {
  /** Start a game: create the match; return its id, or null if it could not start. */
  startGame(t: Tournament, round: TournamentRound, series: TournamentSeries, game: number): string | null;
  /** Stop a live match without reporting back (forfeits, voids, adjudications). `winner`: entrant id, null = none. */
  stopGame(matchId: string, winner: string | null): void;
  /** The tournament changed: push the state. */
  changed(t: Tournament): void;
  /** A ready check opened for a series game. */
  readyCheck?(t: Tournament, series: TournamentSeries, game: number): void;
}

export class TournamentError extends Error {}

const fail = (message: string): never => { throw new TournamentError(message); };
const SERIES: SeriesLength[] = [1, 3, 5];
const FORMATS: TournamentFormat[] = ["single", "double", "round_robin", "swiss"];
const isBracket = (t: Tournament) => t.settings.format === "single" || t.settings.format === "double";

export type AdminOp =
  | { op: "lock" } | { op: "unlock" }
  | { op: "kick"; entrantId: string }
  | { op: "seed_order"; ids: string[] }
  | { op: "start" }
  | { op: "set_rounds"; rounds: number }
  | { op: "finish"; void?: boolean }
  | { op: "withdraw"; entrantId: string }
  | { op: "add_bot"; bot: string }
  | { op: "pause" } | { op: "resume" }
  | { op: "next_round" }
  | { op: "repair" }
  | { op: "set_result"; round: number; slot: number; result: "a" | "b" | "draw" | "both_lose" | "void" | "replay" }
  | { op: "settings"; settings: Partial<TournamentSettings> }
  | { op: "transfer"; entrantId: string }
  | { op: "cancel" };

export interface ManagerOptions {
  /** Where tournaments are saved; null keeps them in memory (tests). */
  dir?: string | null;
  now?: () => number;
  random?: () => number;
  /** Known bots: id → display name (with version). Used for bot entrants. */
  botName?: (bot: string) => string | null;
  /** Known map ids, for validating map pools. */
  isMap?: (map: string) => boolean;
}

export class TournamentManager {
  private byId = new Map<string, Tournament>();
  private hooks: TournamentHooks;
  private dir: string | null;
  private now: () => number;
  private random: () => number;
  private botName: (bot: string) => string | null;
  private isMap: (map: string) => boolean;

  constructor(hooks: TournamentHooks, opts: ManagerOptions = {}) {
    this.hooks = hooks;
    this.dir = opts.dir === undefined ? resolve(process.cwd(), "tournaments") : opts.dir;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.botName = opts.botName ?? (() => null);
    this.isMap = opts.isMap ?? (() => true);
    if (this.dir) this.load();
  }

  // ── Lookup and views ───────────────────────────────────────────────────────

  get(id: string): Tournament | undefined { return this.byId.get(id); }
  byCode(code: string): Tournament | undefined {
    const c = code.trim().toUpperCase();
    for (const t of this.byId.values()) if (t.code === c) return t;
    return undefined;
  }
  all(): Tournament[] { return [...this.byId.values()]; }

  /** The tournament and series a live match belongs to. */
  findMatch(matchId: string): { t: Tournament; round: TournamentRound; series: TournamentSeries; game: number } | null {
    for (const t of this.byId.values()) {
      const round = t.rounds[t.rounds.length - 1];
      if (!round) continue;
      for (const series of round.series) {
        const game = series.games.findIndex((g) => g.matchId === matchId);
        if (game >= 0) return { t, round, series, game };
      }
    }
    return null;
  }

  publicState(t: Tournament): TournamentPublicState {
    const { managerToken: _m, tokens: _t, finishing: _f, nextEntrant: _n, schedule: _s, ...pub } = t;
    let st = standings(this.swissPlayers(t), this.swissRounds(t)).map((s) => ({
      id: s.id, rank: s.rank, points: s.points, wins: s.wins, draws: s.draws, losses: s.losses,
      buchholz: s.buchholz, sb: s.sb, gameDiff: s.gameDiff, outIn: undefined as string | undefined,
    }));
    // Elimination: ranked by how far each player got; points are series won.
    if (t.bracket) {
      const by = new Map(st.map((s) => [s.id, s]));
      const ranks = eliminationRanks(t.bracket, this.bracketState(t), t.entrants.map((e) => e.id), (id) => this.entrant(t, id).seed,
        new Set(t.entrants.filter((e) => e.withdrawn).map((e) => e.id)));
      st = ranks.map((r) => ({ ...by.get(r.id)!, points: by.get(r.id)!.wins, rank: r.rank, outIn: r.outIn }));
    }
    return structuredClone({ ...pub, standings: st.map(({ outIn, ...s }) => (outIn ? { ...s, outIn } : s)) });
  }

  viewer(t: Tournament, token: string | undefined): TournamentViewer {
    const entrantId = token ? Object.keys(t.tokens).find((id) => t.tokens[id] === token) : undefined;
    return { isManager: !!token && token === t.managerToken, ...(entrantId ? { entrantId } : {}) };
  }

  summaries(): TournamentSummary[] {
    return this.all().sort((x, y) => y.createdAt - x.createdAt).map((t) => ({
      id: t.id, code: t.code, name: t.settings.name, status: t.status,
      entrants: t.entrants.filter((e) => !e.withdrawn).length, round: t.rounds.length, rounds: t.settings.rounds, format: t.settings.format, createdAt: t.createdAt,
    }));
  }

  // ── Player actions ─────────────────────────────────────────────────────────

  create(token: string, settings: Partial<TournamentSettings> & { name: string }, mapPool: string[]): Tournament {
    if (!token) fail("A player token is required.");
    const name = settings.name.trim().slice(0, 40);
    if (!name) fail("Give the tournament a name.");
    const t: Tournament = {
      id: crypto.randomUUID(),
      code: this.newCode(),
      status: "registering",
      settings: this.validSettings({ ...DEFAULT_TOURNAMENT_SETTINGS, rounds: 3, mapPool, ...settings, name }),
      entrants: [],
      locked: false,
      paused: false,
      rounds: [],
      createdAt: this.now(),
      managerToken: token,
      tokens: {},
      nextEntrant: 1,
    };
    this.byId.set(t.id, t);
    this.changed(t);
    return t;
  }

  /** Join with the code. The same token rejoins as the same entrant. Late joins need registration unlocked. */
  join(t: Tournament, name: string, token: string): TournamentEntrant {
    if (!token) fail("A player token is required.");
    const known = this.viewer(t, token).entrantId;
    if (known) return t.entrants.find((e) => e.id === known)!;
    if (t.status !== "registering" && t.status !== "running") fail("This tournament has ended.");
    if (t.locked) fail("Registration is closed.");
    if (t.status === "running" && !this.canAddLate(t)) fail(this.lateMessage(t));
    const e = this.addEntrant(t, name.trim().slice(0, 24) || "Player");
    t.tokens[e.id] = token;
    this.changed(t);
    return e;
  }

  /** Before the start: leave. After: withdraw. */
  leave(t: Tournament, token: string): void {
    const id = this.viewer(t, token).entrantId ?? fail("You are not in this tournament.");
    if (t.status === "registering") this.remove(t, id);
    else this.withdraw(t, id);
    this.changed(t);
  }

  ready(t: Tournament, token: string): void {
    const id = this.viewer(t, token).entrantId ?? fail("You are not in this tournament.");
    const series = this.currentSeriesOf(t, id);
    if (!series || series.status !== "ready_check") fail("You have no match waiting.");
    if (series!.a === id) series!.ready.a = true; else series!.ready.b = true;
    if (series!.ready.a && series!.ready.b) this.launch(t, series!);
    this.changed(t);
  }

  /** A game finished. `winner` is an entrant id, null for a draw. Ignored for matches the tournament no longer tracks. */
  gameEnded(matchId: string, winner: string | null, winType?: string, replayId?: string): void {
    const found = this.findMatch(matchId);
    if (!found || found.series.status !== "playing") return;
    const { t, series, game } = found;
    const g = series.games[game];
    g.result = winner === null ? "draw" : winner === series.a ? "a" : "b";
    g.winType = winType;
    g.replayId = replayId;
    delete g.matchId;
    this.afterGame(t, series);
    this.changed(t);
  }

  /** Ready-check deadlines and the auto-advance countdown. Call about once a second. */
  tick(): void {
    const now = this.now();
    for (const t of this.byId.values()) {
      if (t.status !== "running") continue;
      let dirty = false;
      const round = t.rounds[t.rounds.length - 1];
      for (const s of round?.series ?? []) {
        if (s.status !== "ready_check" || s.deadline === undefined || now < s.deadline) continue;
        const g = s.games[s.games.length - 1];
        g.decided = "no_show";
        if (!s.ready.a && !s.ready.b) this.endSeries(t, s, "both_lose");
        else this.endSeries(t, s, s.ready.a ? "a" : "b");
        dirty = true;
      }
      if (dirty) this.roundProgress(t);
      if (t.nextRoundAt !== undefined && now >= t.nextRoundAt && !t.paused) {
        delete t.nextRoundAt;
        this.advance(t);
        dirty = true;
      }
      if (dirty) this.changed(t);
    }
  }

  // ── Manager operations (§7) ────────────────────────────────────────────────

  admin(t: Tournament, token: string, a: AdminOp): void {
    if (token !== t.managerToken) fail("Only the manager can do that.");
    const ended = t.status === "finished" || t.status === "cancelled";
    if (ended && a.op !== "settings") fail("This tournament has ended.");
    const registering = t.status === "registering";
    switch (a.op) {
      case "lock": t.locked = true; break;
      case "unlock": t.locked = false; break;
      case "kick":
        this.entrant(t, a.entrantId);
        if (registering) this.remove(t, a.entrantId); else this.withdraw(t, a.entrantId);
        break;
      case "seed_order": {
        if (!registering) fail("Seeds are set before the start.");
        const ids = new Set(a.ids);
        if (ids.size !== t.entrants.length || t.entrants.some((e) => !ids.has(e.id))) fail("The seed order must list every entrant once.");
        a.ids.forEach((id, i) => { this.entrant(t, id).seed = i + 1; });
        t.entrants.sort((x, y) => x.seed - y.seed);
        t.settings.seeding = "manual";
        break;
      }
      case "start": this.start(t); break;
      case "set_rounds": {
        if (t.settings.format !== "swiss") fail("Only a Swiss tournament's rounds can be changed.");
        const min = Math.max(1, t.rounds.length);
        if (!Number.isInteger(a.rounds) || a.rounds < min || a.rounds > TOURNAMENT_LIMITS.maxEntrants) fail(`Rounds must be between ${min} and ${TOURNAMENT_LIMITS.maxEntrants}.`);
        t.settings.rounds = a.rounds;
        if (t.status === "running" && this.roundDone(t) && t.nextRoundAt === undefined && !t.paused && t.rounds.length < a.rounds && t.settings.autoAdvance) {
          t.nextRoundAt = this.now() + t.settings.advanceSeconds * 1000;
        }
        break;
      }
      case "finish":
        if (registering) fail("Start or cancel the tournament instead.");
        if (a.void) {
          for (const s of this.current(t)?.series ?? []) if (s.status !== "done") this.endSeries(t, s, "void");
          this.finish(t);
        } else if (this.roundDone(t)) this.finish(t);
        else { t.finishing = true; delete t.nextRoundAt; }
        break;
      case "withdraw":
        this.entrant(t, a.entrantId);
        if (registering) this.remove(t, a.entrantId); else this.withdraw(t, a.entrantId);
        break;
      case "add_bot": {
        const name = this.botName(a.bot) ?? fail("Unknown bot.");
        if (t.status === "running" && !this.canAddLate(t)) fail(this.lateMessage(t));
        const same = t.entrants.filter((e) => e.bot === a.bot).length;
        const e = this.addEntrant(t, same ? `${name} #${same + 1}` : name);
        e.bot = a.bot;
        if (same === 1) { const first = t.entrants.find((x) => x.bot === a.bot && x !== e)!; first.name = `${first.name} #1`; }
        break;
      }
      case "pause": t.paused = true; break;
      case "resume":
        t.paused = false;
        if (t.status === "running" && this.roundDone(t) && t.nextRoundAt === undefined) this.roundProgress(t);
        break;
      case "next_round":
        if (t.status !== "running" || !this.roundDone(t)) fail("The current round is still being played.");
        delete t.nextRoundAt;
        this.advance(t);
        break;
      case "repair": {
        if (t.settings.format !== "swiss") fail("Only Swiss rounds are re-paired.");
        const round = this.current(t) ?? fail("No round to re-pair.");
        if (round!.series.some((s) => s.b !== null && s.games.some((g) => g.matchId || g.result))) fail("A match of this round has already started.");
        t.rounds.pop();
        this.pairNext(t);
        break;
      }
      case "set_result": this.setResult(t, a.round, a.slot, a.result); break;
      case "settings": {
        if (!registering && a.settings.format !== undefined && a.settings.format !== t.settings.format) fail("The format can't be changed after the start.");
        t.settings = this.validSettings({ ...t.settings, ...a.settings, rounds: t.settings.rounds, name: t.settings.name });
        break;
      }
      case "transfer": {
        const tok = t.tokens[a.entrantId] ?? fail("Only a human entrant can become the manager.");
        t.managerToken = tok!;
        break;
      }
      case "cancel":
        for (const s of this.current(t)?.series ?? []) if (s.status !== "done") this.endSeries(t, s, "void");
        t.status = "cancelled";
        t.finishedAt = this.now();
        delete t.nextRoundAt;
        break;
      default: fail("Unknown operation.");
    }
    this.changed(t);
  }

  /** Admin command: give the manager role to a new token (the old one is lost). */
  reassignManager(t: Tournament, token: string): void {
    t.managerToken = token;
    this.changed(t);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private start(t: Tournament): void {
    if (t.status !== "registering") fail("The tournament has already started.");
    if (t.entrants.length < TOURNAMENT_LIMITS.minEntrants) fail(`At least ${TOURNAMENT_LIMITS.minEntrants} players are needed.`);
    if (t.settings.seeding === "random") {
      const order = [...t.entrants];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      order.forEach((e, i) => { e.seed = i + 1; });
      t.entrants.sort((x, y) => x.seed - y.seed);
    }
    const n = t.entrants.length, f = t.settings.format;
    if (f === "single" || f === "double") {
      t.bracket = buildBracket(f, n);
      t.settings.rounds = bracketRounds(t.bracket);
    } else if (f === "round_robin") {
      const id = (seed: number) => t.entrants[seed - 1].id;
      t.schedule = roundRobin(n).map((r) => r.map(([x, y]) => [id(x), y === null ? null : id(y)] as [string, string | null]));
      t.settings.rounds = t.schedule.length;
    } else if (!t.settings.rounds) t.settings.rounds = defaultRounds(n);
    t.status = "running";
    t.locked = true;
    this.pairNext(t);
  }

  /** Pair the next round, or finish when the planned rounds are done or too few players are left. */
  private advance(t: Tournament): void {
    if (t.finishing || this.lastRoundDone(t)) return this.finish(t);
    if (t.entrants.filter((e) => !e.withdrawn).length < 2) return this.finish(t);
    this.pairNext(t);
  }

  private pairNext(t: Tournament): void {
    const number = t.rounds.length + 1;
    const swiss = this.swissRounds(t);
    const map = nextMap(t.settings.mapPool, swiss);
    const bestOf = t.settings.roundBestOf[number] ?? t.settings.bestOf;
    const pairings = this.pairings(t, number, swiss);
    const round: TournamentRound = {
      number, map, bestOf,
      series: pairings.map((p, slot) => ({
        slot, a: p.a, b: p.b, bestOf, status: "waiting", games: [], ready: { a: false, b: false },
        ...(p.node ? { node: p.node, label: p.label } : {}),
        ...(p.b === null ? { status: "done" as const, result: "a" as const } : {}),
      })),
    };
    t.rounds.push(round);
    for (const s of round.series) if (s.status !== "done") this.nextGame(t, s);
    this.roundProgress(t);
  }

  /** The next round's series, by format. Round robin and brackets skip pairs with a withdrawn player (the other gets a bye or walkover). */
  private pairings(t: Tournament, number: number, swiss: ReturnType<TournamentManager["swissRounds"]>): { a: string; b: string | null; node?: string; label?: string }[] {
    if (t.schedule) {
      const out = new Set(t.entrants.filter((e) => e.withdrawn).map((e) => e.id));
      return (t.schedule[number - 1] ?? []).flatMap(([x, y]) => {
        const px = out.has(x) ? null : x, py = y !== null && !out.has(y) ? y : null;
        if (!px && !py) return [];
        return [px && py ? { a: px, b: py } : { a: (px ?? py)!, b: null }];
      });
    }
    if (t.bracket) {
      const st = this.bracketState(t);
      return t.bracket.filter((n) => st.get(n.id)!.ready).map((n) => ({ a: st.get(n.id)!.a!, b: st.get(n.id)!.b!, node: n.id, label: n.label }));
    }
    return pairRound(this.swissPlayers(t), swiss).pairings;
  }

  /** Every bracket node's players and result, from the series played so far. */
  private bracketState(t: Tournament) {
    const series = new Map<string, NodeSeries>();
    for (const r of t.rounds) for (const s of r.series) if (s.node) series.set(s.node, { a: s.a, b: s.b, result: s.status === "done" ? s.result : undefined });
    const seeds = [...t.entrants].sort((x, y) => x.seed - y.seed).map((e) => e.id);
    return resolveBracket(t.bracket!, seeds, series, new Set(t.entrants.filter((e) => e.withdrawn).map((e) => e.id)));
  }

  /** No more rounds to play: the planned rounds are done, or the bracket has a champion. */
  private lastRoundDone(t: Tournament): boolean {
    if (t.bracket) return this.bracketState(t).get(finalNode(t.bracket).id)!.winner !== undefined;
    return t.rounds.length >= t.settings.rounds;
  }

  /** Open the next game of a series: ready check (bots are always ready). */
  private nextGame(t: Tournament, s: TournamentSeries): void {
    const round = this.current(t)!;
    const game = s.games.length;
    // An elimination series can run past its length (a level series plays on until someone wins).
    const maps = seriesMaps(t.settings.mapPool, round.map, Math.max(s.bestOf, game + 1));
    s.games.push({ map: maps[game], blue: seriesBlue({ a: s.a, b: s.b }, game) });
    s.ready = { a: this.isBot(t, s.a), b: this.isBot(t, s.b!) };
    if (s.ready.a && s.ready.b) return this.launch(t, s);
    s.status = "ready_check";
    s.deadline = this.now() + t.settings.readySeconds * 1000;
    this.hooks.readyCheck?.(t, s, game);
  }

  private launch(t: Tournament, s: TournamentSeries): void {
    const game = s.games.length - 1;
    delete s.deadline;
    s.status = "playing";
    const matchId = this.hooks.startGame(t, this.current(t)!, s, game);
    if (matchId) s.games[game].matchId = matchId;
    else { s.status = "interrupted"; t.paused = true; }
  }

  private afterGame(t: Tournament, s: TournamentSeries): void {
    const st = seriesState(s.games.filter((g) => g.result).map((g) => g.result as GameOutcome), s.bestOf);
    if (st.done && !(st.result === "draw" && s.node)) this.endSeries(t, s, st.result!);
    else this.nextGame(t, s);
    this.roundProgress(t);
  }

  private endSeries(t: Tournament, s: TournamentSeries, result: NonNullable<TournamentSeries["result"]>): void {
    const winner = result === "a" ? s.a : result === "b" ? s.b : null;
    for (const g of s.games) if (g.matchId) { const id = g.matchId; delete g.matchId; this.hooks.stopGame(id, winner); }
    s.status = "done";
    s.result = result;
    delete s.deadline;
  }

  /** After a series ends: if the round is done, count down to the next one (or finish). */
  private roundProgress(t: Tournament): void {
    if (t.status !== "running" || !this.roundDone(t)) return;
    if (t.finishing || this.lastRoundDone(t)) return this.finish(t);
    if (t.settings.autoAdvance && !t.paused) t.nextRoundAt ??= this.now() + t.settings.advanceSeconds * 1000;
  }

  private finish(t: Tournament): void {
    t.status = "finished";
    t.finishedAt = this.now();
    delete t.nextRoundAt;
    delete t.finishing;
  }

  private setResult(t: Tournament, roundNo: number, slot: number, result: Extract<AdminOp, { op: "set_result" }>["result"]): void {
    const round = t.rounds.find((r) => r.number === roundNo) ?? fail("No such round.");
    const s = round!.series.find((x) => x.slot === slot) ?? fail("No such match.");
    if (s!.b === null) fail("A bye has no result to set.");
    const live = round === this.current(t);
    if (s!.node && (result === "draw" || result === "void")) fail("An elimination match needs a winner (or both lose).");
    if (s!.node && !live) fail("Past bracket results can't be changed: later rounds were paired from them.");
    if (result === "replay") {
      if (!live || t.status !== "running") fail("Only a match of the current round can be replayed.");
      for (const g of s!.games) if (g.matchId) this.hooks.stopGame(g.matchId, null);
      s!.games = [];
      delete s!.result;
      s!.status = "waiting";
      this.nextGame(t, s!);
      return;
    }
    if (!live && result === "void") fail("Past results can be changed but not voided.");
    const g = s!.games[s!.games.length - 1];
    if (g && g.result === undefined) g.decided = "adjudicated";
    this.endSeries(t, s!, result);
    if (live) this.roundProgress(t);
  }

  private withdraw(t: Tournament, id: string): void {
    const e = this.entrant(t, id);
    if (e.withdrawn) return;
    e.withdrawn = true;
    if (t.status === "running") this.forfeitSeries(t, id);
  }

  private forfeitSeries(t: Tournament, id: string): void {
    const s = this.currentSeriesOf(t, id);
    if (!s || s.status === "done" || s.b === null) return;
    const g = s.games[s.games.length - 1];
    if (g && g.result === undefined) g.decided = "forfeit";
    this.endSeries(t, s, s.a === id ? "b" : "a");
    this.roundProgress(t);
  }

  private remove(t: Tournament, id: string): void {
    t.entrants = t.entrants.filter((e) => e.id !== id);
    delete t.tokens[id];
    t.entrants.forEach((e, i) => { e.seed = i + 1; });
  }

  private addEntrant(t: Tournament, name: string): TournamentEntrant {
    if (t.entrants.length >= TOURNAMENT_LIMITS.maxEntrants) fail(`The tournament is full (${TOURNAMENT_LIMITS.maxEntrants}).`);
    const e: TournamentEntrant = { id: `e${t.nextEntrant++}`, name, seed: t.entrants.length + 1, joinedRound: t.rounds.length + 1 };
    t.entrants.push(e);
    return e;
  }

  private canAddLate(t: Tournament): boolean {
    return t.status === "registering" || (t.status === "running" && t.settings.format === "swiss" && t.rounds.length < t.settings.rounds);
  }

  private lateMessage(t: Tournament): string {
    return t.settings.format === "swiss" ? "The last round has been paired; no more players can join." : "Players can only join before this tournament starts.";
  }

  private entrant(t: Tournament, id: string): TournamentEntrant {
    return t.entrants.find((e) => e.id === id) ?? fail("No such player.");
  }

  private isBot(t: Tournament, id: string): boolean { return !!t.entrants.find((e) => e.id === id)?.bot; }
  private current(t: Tournament): TournamentRound | undefined { return t.rounds[t.rounds.length - 1]; }
  private roundDone(t: Tournament): boolean { return (this.current(t)?.series ?? []).every((s) => s.status === "done"); }

  private currentSeriesOf(t: Tournament, id: string): TournamentSeries | undefined {
    return this.current(t)?.series.find((s) => (s.a === id || s.b === id) && s.status !== "done");
  }

  private swissPlayers(t: Tournament): SwissPlayer[] {
    return t.entrants.map((e) => ({ id: e.id, seed: e.seed, withdrawn: e.withdrawn }));
  }

  private swissRounds(t: Tournament): SwissRound[] {
    return t.rounds.map((r) => ({
      map: r.map,
      pairings: r.series.map((s) => {
        const games = s.games.reduce<[number, number]>((acc, g) => {
          if (g.result === "a") acc[0] += 1; else if (g.result === "b") acc[1] += 1; else if (g.result === "draw") { acc[0] += 0.5; acc[1] += 0.5; }
          return acc;
        }, [0, 0]);
        return { a: s.a, b: s.b, result: s.result, ...(s.bestOf > 1 && s.games.some((g) => g.result) ? { games } : {}) };
      }),
    }));
  }

  private validSettings(s: TournamentSettings): TournamentSettings {
    const L = TOURNAMENT_LIMITS;
    if (!SERIES.includes(s.bestOf)) fail("Series length must be Bo1, Bo3 or Bo5.");
    for (const v of Object.values(s.roundBestOf ?? {})) if (!SERIES.includes(v)) fail("Series length must be Bo1, Bo3 or Bo5.");
    const pool = [...new Set(s.mapPool)].filter((m) => this.isMap(m));
    if (!pool.length) fail("Pick at least one map.");
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
    if (!FORMATS.includes(s.format)) fail("Unknown tournament format.");
    return {
      name: s.name, format: s.format, rounds: Math.max(1, Math.round(s.rounds)), seeding: s.seeding === "manual" ? "manual" : "random",
      bestOf: s.bestOf, roundBestOf: { ...(s.roundBestOf ?? {}) }, mapPool: pool,
      readySeconds: clamp(s.readySeconds, L.readyMin, L.readyMax), autoAdvance: !!s.autoAdvance,
      advanceSeconds: clamp(s.advanceSeconds, 0, 600), spectatorDelay: clamp(s.spectatorDelay, L.delayMin, L.delayMax),
    };
  }

  private newCode(): string {
    for (;;) {
      let c = "";
      for (let i = 0; i < LOBBY_CODE_LENGTH; i++) c += LOBBY_CODE_CHARS[Math.floor(this.random() * LOBBY_CODE_CHARS.length)];
      if (!this.byCode(c)) return c;
    }
  }

  private changed(t: Tournament): void {
    this.save(t);
    this.hooks.changed(t);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private save(t: Tournament): void {
    if (!this.dir) return;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${t.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(t));
    renameSync(`${file}.tmp`, file);
  }

  /**
   * Reload saved tournaments. Matches that were live when the server stopped are lost: their series are
   * marked interrupted and the tournament pauses until the manager replays or adjudicates them. Open
   * ready checks restart their countdown.
   */
  private load(): void {
    if (!this.dir || !existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir).filter((x) => x.endsWith(".json"))) {
      try {
        const t = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Tournament;
        t.settings.format ??= "swiss";
        if (t.status === "running") {
          for (const s of this.current(t)?.series ?? []) {
            if (s.status === "playing") {
              s.status = "interrupted";
              t.paused = true;
              for (const g of s.games) delete g.matchId;
            } else if (s.status === "ready_check") s.deadline = this.now() + t.settings.readySeconds * 1000;
          }
          if (t.nextRoundAt !== undefined) t.nextRoundAt = Math.max(t.nextRoundAt, this.now() + 10_000);
        }
        this.byId.set(t.id, t);
      } catch (e) {
        console.error(`[tournaments] could not load ${f}:`, e);
      }
    }
  }
}
