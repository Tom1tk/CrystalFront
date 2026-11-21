import express, { Request, Response } from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve as resolvePath, dirname as dirnameFn } from "node:path";

const _serverDir = dirnameFn(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(resolvePath(_serverDir, "../../package.json"), "utf8"));
const GAME_VERSION: string = _pkg.version ?? "unknown";
import { LobbyManager } from "./lobby/lobbyManager.js";
import { MatchEngine } from "./match/matchEngine.js";
import { LiveMatchRunner } from "./match/liveMatchRunner.js";
import { LoadGate } from "./match/loadGate.js";
import { BotPlayer } from "./match/botPlayer.js";
import { NeuralBotPlayer, betaNeuralCheckpoints, loadNeuralModels, neuralModelFor } from "./match/neuralBotPlayer.js";
import {
  IdleBot, PassiveBot, WeakRushBot, WeakMediumRushBot,
  MediumRushBot, RushBot, TurtleBot, MacroBot, HeavyBot,
} from "../../headless/src/bots/index.js";
import type { Agent } from "../../headless/src/types.js";
import { actionStateOf, headingOf, staticMapOf, type ActionState } from "./match/engine/presentation.js";
import { encodeVision } from "./match/engine/visibility.js";
import { ScriptedBotPlayer, scriptedBotFor, SCRIPTED_PREFIX } from "./match/scriptedBotPlayer.js";
import { SCRIPTED } from "../../headless/src/v3/scripted.js";
import { TournamentManager, TournamentError, type Tournament, type AdminOp } from "./tournament/tournamentManager.js";
import { SpectatorFeeds } from "./tournament/spectatorFeed.js";
import { ReplayRunner, listReplays, getReplay, ensureReplaysDir, saveReplay } from "./match/replayRunner.js";
import type { MatchEntity, MatchState, PlayerSlot, ResourceNode, PlayerEconomy, MatchConfig } from "./match/types.js";
import { DEFAULT_CONFIG } from "./match/types.js";
import { DEFAULT_MAP_ID, isKnownMap, poolMaps, terrainFor, contestedNodesFor } from "./match/maps.js";
import { encodeTerrain } from "./match/engine/terrain.js";

/**
 * Live-match config for a requested map (G-7): a known map id is used as is;
 * "random" or anything else picks a random pool map. CF_MAP overrides a
 * random pick (dev). With an empty pool the default map is used.
 */
function liveConfig(requested?: string, ruleset?: Ruleset): MatchConfig {
  let mapId: string;
  if (requested && requested !== "random" && isKnownMap(requested)) mapId = requested;
  else if (process.env.CF_MAP && isKnownMap(process.env.CF_MAP)) mapId = process.env.CF_MAP;
  else {
    const pool = poolMaps();
    mapId = pool.length ? pool[Math.floor(Math.random() * pool.length)].mapId : DEFAULT_MAP_ID;
  }
  return { ...DEFAULT_CONFIG, mapId, ...(ruleset === "beta" ? { ruleset: "beta" as const } : {}) };
}
import {
  CLIENT_MSG,
  SERVER_EVT,
  type ClientToServerMsg,
  type ServerToClientMsg,
  type PlayerId,
  type WinType,
  type EntityType,
  type BuildingType,
  type UnitType,
  type Ruleset,
  type TournamentRound,
  type TournamentSeries,
} from "@crystalfront/shared";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_REGEX,
  CONTROL,
} from "@crystalfront/shared";
import { controlNeeded } from "./match/engine/control.js";

const app = express();
app.use((_req, res, next) => {
  res.header("Cross-Origin-Opener-Policy", "same-origin");
  res.header("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, maxPayload: 1024 * 1024 });

const PORT = parseInt(process.env.PORT || "3777", 10);

ensureReplaysDir();

const lobbyManager = new LobbyManager();
const matchEngine = new MatchEngine();

function createBotAgent(name: string): Agent {
  switch (name) {
    case "idle":             return new IdleBot();
    case "passive":          return new PassiveBot();
    case "rush_weak":        return new WeakRushBot();
    case "rush_weak_medium": return new WeakMediumRushBot();
    case "rush_medium":      return new MediumRushBot();
    case "rush":             return new RushBot();
    case "turtle":           return new TurtleBot();
    case "macro":            return new MacroBot();
    case "heavy":            return new HeavyBot();
    default:                 return new MacroBot();
  }
}
const NEURAL_NAMES: Record<string, string> = { neural_easy: "Neural · Easy", neural_normal: "Neural · Normal", neural_hard: "Neural · Hard" };
const replayRunner = new ReplayRunner();

// Track which WS connection is watching which replay matchId
const replayWatchers = new Map<WebSocket, string>();

// Per-match bot players (for Solo Test mode)
const botPlayers = new Map<string, BotPlayer | NeuralBotPlayer | ScriptedBotPlayer>();

const liveRunner = new LiveMatchRunner(matchEngine, (matchId: string) => {
  // Step the bot (if any) before broadcasting so the bot's commands are included
  botPlayers.get(matchId)?.tick();
  secondBots.get(matchId)?.tick();
  const code = matchLobbyMap.get(matchId);
  if (code) {
    broadcastGameState(code);
  }
});

/** New matches wait in the "spawn" phase until every human client has loaded. */
const loadGate = new LoadGate((matchId: string) => {
  if (!matchEngine.startMatch(matchId)) return;
  liveRunner.start(matchId);
  const code = matchLobbyMap.get(matchId);
  if (code) broadcastGameState(code);
}, undefined, (matchId: string, loaded: string[]) => {
  const msg: ServerToClientMsg = { type: SERVER_EVT.LOAD_STATUS, payload: { loaded: loaded as PlayerId[] } };
  for (const session of playerLobbyMap.values()) {
    if (session.matchId === matchId && !session.isBot) sendWS(session.ws, msg);
  }
});

matchEngine.setMatchEndCallback((matchId: string, winner: string | null) => {
  liveRunner.stop(matchId);
  const endedBot = botPlayers.get(matchId);
  botPlayers.delete(matchId);
  const code = matchLobbyMap.get(matchId);
  if (code) {
    const lobby = lobbyManager.getLobby(code);
    if (lobby && winner) { // a beta draw scores for nobody
      const winnerSlot = winner === lobby.players[0]?.id ? "player1" : "player2";
      lobbyManager.recordWin(code, winnerSlot);
    }

    // Save replay for every completed match (pvp and vs-bot); its id goes out with MATCH_END.
    let replayId: string | undefined;
    try {
      const match = matchEngine.getMatch(matchId);
      if (match) {
        const bluePlayer = lobby?.players.find(p => p?.color === "blue");
        const redPlayer  = lobby?.players.find(p => p?.color === "red");
        const winnerPlayer = lobby?.players.find(p => p?.id === winner);
        replayId = saveReplay({
          matchId,
          seed:         match.seed ?? 0,
          blue:         bluePlayer?.username  ?? "Blue",
          red:          redPlayer?.username   ?? "Red",
          bluePlayerId: bluePlayer?.id  ?? "headless-blue",
          redPlayerId:  redPlayer?.id   ?? "headless-red",
          ticks:        match.tick,
          winner:       winnerPlayer?.color   ?? null,
          winnerName:   winnerPlayer?.username ?? null,
          winType:      match.result?.winType  ?? null,
          commandLog:   match.commandLog       ?? [],
          version:      GAME_VERSION,
          mapId:        match.terrain.mapId,
          mapVersion:   match.terrain.mapVersion,
          ruleset:      match.config.ruleset ?? "0.9",
          ...(endedBot instanceof NeuralBotPlayer ? { botReads: endedBot.reads } : {}),
        });
      }
    } catch (e) {
      console.error("[server] Failed to save replay:", e);
    }
    broadcastMatchEnd(code, winner, matchEngine.getMatch(matchId)?.result?.winType, replayId);
    tournamentMatchEnded(matchId, code, winner, matchEngine.getMatch(matchId)?.result?.winType, replayId);

    // Reset ready states and broadcast so both players see updated scores + un-ready status
    lobbyManager.resetReadyStates(code);
    broadcastLobbyStateForCode(code);
    lobbyMatchMap.delete(code);
    matchLobbyMap.delete(matchId);
  }
});

const playerLobbyMap = new Map<string, { playerId: string; code: string; ws: WebSocket; matchId?: string; isBot?: boolean }>();
const lobbyMatchMap = new Map<string, string>();
const matchLobbyMap = new Map<string, string>(); // matchId -> lobbyCode reverse lookup

// Rate limiting for game commands
const commandRateMap = new Map<string, { count: number; resetTime: number }>();
const MAX_COMMANDS_PER_SECOND = 100;

// ── Tournaments (docs/TOURNAMENT_SPEC.md) ────────────────────────────────────
/** A disconnected tournament player has this long to come back before forfeiting the game. */
const TOURNAMENT_GRACE_MS = 60_000;
type Bot = BotPlayer | NeuralBotPlayer | ScriptedBotPlayer;
/** Live tournament match → its tournament and the seats' lobby player ids. */
const tMatches = new Map<string, { tid: string; code: string; byPlayer: Record<string, string>; byEntrant: Record<string, string> }>();
/** Human tournament seat (lobby player id) → its grace timer while nobody is connected to it. */
const tGrace = new Map<string, ReturnType<typeof setTimeout>>();
/** Dashboard subscribers. */
const tWatchers = new Map<WebSocket, { tid: string; token?: string }>();
/** The red seat's bot in a bot-v-bot tournament match (botPlayers holds blue's). */
const secondBots = new Map<string, Bot>();

/** Bots a tournament manager can enter, with their version in the name. */
function tournamentBots(): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const cap = (l: string) => `${l[0].toUpperCase()}${l.slice(1)}`;
  // "neural_<level>" in a tournament is the 0.9 bot (through the adapter); the beta models are "neuralb_<level>".
  for (const level of ["easy", "normal", "hard"]) if (neuralModelFor(`neural09_${level}`)) out.push({ id: `neural_${level}`, name: `Neural ${cap(level)} (0.9)` });
  for (const [level, ckpt] of Object.entries(betaNeuralCheckpoints())) out.push({ id: `neuralb_${level}`, name: `Neural ${cap(level)} (beta ${ckpt})` });
  for (const name of Object.keys(SCRIPTED)) out.push({ id: `${SCRIPTED_PREFIX}${name}`, name: `Scripted ${name} (beta)` });
  for (const name of ["rush", "turtle", "macro", "heavy"]) out.push({ id: name, name: `Classic ${name} (0.9)` });
  return out;
}

function makeBot(bot: string, playerId: string, matchId: string): Bot {
  const neural = neuralModelFor(bot);
  if (neural) return new NeuralBotPlayer(neural, playerId, matchId, matchEngine);
  const scripted = scriptedBotFor(bot);
  if (scripted) return new ScriptedBotPlayer(scripted, playerId, matchId, matchEngine);
  const b = new BotPlayer(createBotAgent(bot), playerId, matchId, matchEngine);
  b.init();
  return b;
}

function tournamentSockets(tid: string, token: string | undefined): WebSocket[] {
  if (!token) return [];
  return [...tWatchers].filter(([, w]) => w.tid === tid && w.token === token).map(([ws]) => ws);
}

function pushTournament(t: Tournament): void {
  const state = tournaments.publicState(t);
  for (const [ws, w] of tWatchers) {
    if (w.tid === t.id) sendWS(ws, { type: SERVER_EVT.TOURNAMENT_STATE, payload: { state, viewer: tournaments.viewer(t, w.token) } });
  }
}

/** A human seat nobody is connected to: forfeit the game unless they (re)connect in time. */
function armGrace(playerId: string, matchId: string): void {
  clearTimeout(tGrace.get(playerId));
  tGrace.set(playerId, setTimeout(() => {
    tGrace.delete(playerId);
    const match = matchEngine.getMatch(matchId);
    if (!match || match.phase === "ended") return;
    loadGate.release(matchId);
    const other = match.players.find((p) => p && p.playerId !== playerId);
    if (other) { liveRunner.stop(matchId); matchEngine.endMatch(matchId, other.playerId, "forfeit"); }
  }, TOURNAMENT_GRACE_MS));
}

/** Create the lobby and match for a tournament game; bots join at once, humans via TOURNAMENT_PLAY. */
function startTournamentGame(t: Tournament, round: TournamentRound, s: TournamentSeries, game: number): string | null {
  const g = s.games[game];
  const blue = t.entrants.find((e) => e.id === g.blue);
  const red = t.entrants.find((e) => e.id === (g.blue === s.a ? s.b : s.a));
  if (!blue || !red) return null;
  const { code, player: p0 } = lobbyManager.createLobby(blue.name, "beta");
  const joined = red.bot ? lobbyManager.addBotToLobby(code, red.name) : (() => { const r = lobbyManager.joinLobby(code, red.name === blue.name ? `${red.name}_` : red.name); return r.success ? r.player : null; })();
  if (!joined) { lobbyManager.leaveLobby(code, p0.id); return null; }
  const match = matchEngine.createMatch(code, [toPlayerSlot(p0), toPlayerSlot(joined)], { ...DEFAULT_CONFIG, mapId: g.map, ruleset: "beta" });
  lobbyMatchMap.set(code, match.id);
  matchLobbyMap.set(match.id, code);
  tMatches.set(match.id, { tid: t.id, code, byPlayer: { [p0.id]: blue.id, [joined.id]: red.id }, byEntrant: { [blue.id]: p0.id, [red.id]: joined.id } });
  const humans: string[] = [];
  for (const [p, e] of [[p0, blue], [joined, red]] as const) {
    if (e.bot) {
      const bot = makeBot(e.bot, p.id, match.id);
      if (botPlayers.has(match.id)) secondBots.set(match.id, bot); else botPlayers.set(match.id, bot);
    } else {
      humans.push(p.id);
      armGrace(p.id, match.id);
      for (const ws of tournamentSockets(t.id, t.tokens[e.id])) {
        sendWS(ws, { type: SERVER_EVT.TOURNAMENT_MATCH_START, payload: { code: t.code, round: round.number, slot: s.slot, game } });
      }
    }
  }
  loadGate.wait(match.id, humans);
  return match.id;
}

const tournaments = new TournamentManager({
  startGame: startTournamentGame,
  stopGame: (matchId, winner) => {
    const tm = tMatches.get(matchId);
    const match = matchEngine.getMatch(matchId);
    if (!tm || !match || match.phase === "ended") return;
    loadGate.release(matchId);
    liveRunner.stop(matchId);
    matchEngine.endMatch(matchId, (winner ? tm.byEntrant[winner] ?? null : null) as PlayerId, "forfeit");
  },
  changed: pushTournament,
  readyCheck: (t, s, game) => {
    for (const [me, them] of [[s.a, s.b], [s.b, s.a]] as const) {
      if (!me || !them) continue;
      const opponent = t.entrants.find((e) => e.id === them)?.name ?? "?";
      for (const ws of tournamentSockets(t.id, t.tokens[me])) {
        sendWS(ws, { type: SERVER_EVT.TOURNAMENT_MATCH_READY, payload: {
          code: t.code, round: t.rounds.length, slot: s.slot, game, opponent, map: s.games[game].map,
          side: s.games[game].blue === me ? "blue" : "red", deadline: s.deadline ?? Date.now(),
        } });
      }
    }
  },
}, { botName: (bot) => tournamentBots().find((b) => b.id === bot)?.name ?? null, isMap: isKnownMap });
const tournamentTick = setInterval(() => tournaments.tick(), 1000);

/** Delayed spectator feeds (spec §6): full state plus each seat's vision; `seen` bit 1 = first seat, 2 = second. */
function spectatorPayload(match: MatchState, start: boolean) {
  const base = buildMatchStatePayload(match, start ? undefined : Date.now());
  const vis = match.players.map((p) => (p ? match.visibilityData?.get(p.playerId) : undefined));
  const ids = match.players.map((p) => p?.playerId);
  const seenBy = (owner: string | undefined, has: (v: NonNullable<(typeof vis)[number]>) => boolean) =>
    vis.reduce((m, v, i) => m | ((owner !== undefined && owner === ids[i]) || (v && has(v)) ? 1 << i : 0), 0);
  return {
    ...base,
    entities: base.entities.map((e) => ({ ...e, seen: seenBy(e.ownerId, (v) => v.entityIds.has(e.id)) })),
    resourceNodes: base.resourceNodes.map((n) => ({ ...n, seen: seenBy(undefined, (v) => v.nodeIds.has(n.id)) })),
    visionBySeat: vis.map((v) => (v ? encodeVision(v.cells) : null)),
  };
}
const feeds = new SpectatorFeeds<WebSocket>({
  send: (ws, msg) => sendWS(ws, msg as unknown as ServerToClientMsg),
  serialize: spectatorPayload,
});
const feedTick = setInterval(() => feeds.step(), 100);

/** After a tournament match ends: free its seats and report the result (deferred, so a forced stop can't re-enter). */
function tournamentMatchEnded(matchId: string, code: string, winner: string | null, winType?: string, replayId?: string): void {
  const tm = tMatches.get(matchId);
  if (!tm) return;
  tMatches.delete(matchId);
  secondBots.delete(matchId);
  for (const pid of Object.keys(tm.byPlayer)) {
    clearTimeout(tGrace.get(pid));
    tGrace.delete(pid);
    playerLobbyMap.delete(pid);
    lobbyManager.leaveLobby(code, pid);
  }
  lobbyMatchMap.delete(code);
  matchLobbyMap.delete(matchId);
  const winnerEntrant = winner ? tm.byPlayer[winner] ?? null : null;
  setImmediate(() => tournaments.gameEnded(matchId, winnerEntrant, winType, replayId));
}

function sendWS(ws: WebSocket, msg: ServerToClientMsg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastLobbyState(ws: WebSocket, code: string) {
  const state = { lobbies: lobbyManager.getAllLobbies() };
  const msg: ServerToClientMsg = { type: SERVER_EVT.LOBBY_STATE, payload: { lobby: state } };
  let count = 0;
  for (const session of playerLobbyMap.values()) {
    if (session.code === code) {
      sendWS(session.ws, msg);
      count++;
    }
  }
}

function broadcastLobbyStateForCode(code: string) {
  const state = { lobbies: lobbyManager.getAllLobbies() };
  const msg: ServerToClientMsg = { type: SERVER_EVT.LOBBY_STATE, payload: { lobby: state } };
  for (const session of playerLobbyMap.values()) {
    if (session.code === code) {
      sendWS(session.ws, msg);
    }
  }
}

function serializeEntities(match: MatchState): Array<{
  id: string;
  type: EntityType;
  ownerId: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  radius: number;
  color: string;
  buildingType?: BuildingType;
  constructionProgress?: number;
  buildWorkerIds?: string[];
  buildTargetId?: string;
  gatheringNodeId?: string;
  productionQueue?: Array<{
    unitType: UnitType;
    cost: number;
    supplyCost: number;
    buildTime: number;
    remainingTicks: number;
  }>;
  repairTargetId?: string;
  moveTarget?: { x: number; y: number };
  attackTargetId?: string;
  attackCooldown: number;
  healTargetId?: string;
  coverTargetId?: string;
  autoAttackEnabled: boolean;
  rallyPoint?: { x: number; y: number };
  heading?: number;
  actionState: ActionState;
  path?: Array<{ x: number; y: number }>;
  queue?: Array<{ x: number; y: number; type: string }>;
}> {
  return Array.from(match.entities.values()).map((e) => ({
    id: e.id,
    type: e.type,
    ownerId: e.ownerId,
    x: e.x,
    y: e.y,
    health: e.health,
    maxHealth: e.maxHealth,
    radius: e.radius,
    color: e.color,
    buildingType: e.buildingType,
    constructionProgress: e.constructionProgress,
    buildWorkerIds: e.buildWorkerIds ? Array.from(e.buildWorkerIds) : undefined,
    buildTargetId: e.buildTargetId,
    gatheringNodeId: e.gatheringNodeId,
    productionQueue: e.productionQueue.map((q) => ({
      unitType: q.unitType,
      cost: q.cost,
      supplyCost: q.supplyCost,
      buildTime: q.buildTime,
      remainingTicks: q.remainingTicks,
    })),
    repairTargetId: e.repairTargetId,
    moveTarget: e.moveTarget,
    attackTargetId: e.attackTargetId,
    attackCooldown: e.attackCooldown,
    healTargetId: e.healTargetId,
    coverTargetId: e.coverTargetId,
    autoAttackEnabled: e.autoAttackEnabled,
    rallyPoint: e.rallyPoint,
    heading: headingOf(e, match),
    actionState: actionStateOf(e),
    // G-4: remaining route waypoints (stripped from other players' units below).
    path: e.route && e.route.waypoints.length > 0
      ? e.route.waypoints.map((w) => ({ x: Math.round(w.x), y: Math.round(w.y) }))
      : undefined,
    // G-9f: queued order destinations (attack orders point at the target).
    queue: e.orderQueue?.map((o) => {
      const t = o.targetEntityId ? match.entities.get(o.targetEntityId) : undefined;
      return { x: Math.round(t ? t.x : o.targetX ?? e.x), y: Math.round(t ? t.y : o.targetY ?? e.y), type: o.type };
    }),
  }));
}

function serializeResourceNodes(nodes: ResourceNode[]): Array<{
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  capacity: number;
  remaining: number;
}> {
  return nodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    radius: n.radius,
    color: n.color,
    capacity: n.capacity,
    remaining: n.remaining,
  }));
}

function serializeControl(match: MatchState) {
  const contested = match.resourceNodes.filter((n) => n.contested);
  return {
    holder: match.control.holder,
    progress: match.control.progress,
    holdTicks: CONTROL.holdTicks,
    need: controlNeeded(contested.length),
    radius: CONTROL.radius,
    nodes: contested.map((n) => ({ id: n.id, x: n.x, y: n.y, controller: n.controller ?? null })),
  };
}

function serializeEconomy(economy: [PlayerEconomy | null, PlayerEconomy | null]): [
  { resources: number; supply: number; maxSupply: number } | null,
  { resources: number; supply: number; maxSupply: number } | null,
] {
  return [
    economy[0]
      ? {
          resources: economy[0].resources,
          supply: economy[0].supply,
          maxSupply: economy[0].maxSupply,
        }
      : null,
    economy[1]
      ? {
          resources: economy[1].resources,
          supply: economy[1].supply,
          maxSupply: economy[1].maxSupply,
        }
      : null,
  ];
}

/**
 * Build a serialized match state payload from the internal MatchState.
 * stateTimestamp is optional — included for GAME_STATE broadcasts but omitted for MATCH_START.
 */
/**
 * Build a serialized match state payload from the internal MatchState.
 * When playerId is provided, filter entities and resource nodes by fog-of-war visibility.
 * stateTimestamp is optional — included for GAME_STATE broadcasts but omitted for MATCH_START.
 */
function buildMatchStatePayload(match: MatchState, stateTimestamp?: number, playerId?: PlayerId) {
  let allEntities = serializeEntities(match);
  let allNodes = serializeResourceNodes(match.resourceNodes);

  // Fog of war: filter by visibility when playerId is provided and visibility data exists
  let vision: string | undefined;
  if (playerId && match.visibilityData) {
    const vis = match.visibilityData.get(playerId);
    if (vis) {
      allEntities = allEntities.filter(e => vis.entityIds.has(e.id));
      allNodes = allNodes.filter(n => vis.nodeIds.has(n.id));
      vision = encodeVision(vis.cells);
    }
  }
  if (playerId) {
    for (const e of allEntities) if (e.ownerId !== playerId) { e.path = undefined; e.queue = undefined; }
  }

  return {
    id: match.id,
    lobbyCode: match.lobbyCode,
    phase: match.phase,
    tick: match.tick,
    tickIntervalMs: match.tickIntervalMs,
    // Static map goes out once, with MATCH_START (no stateTimestamp) — G-11.
    ...(stateTimestamp !== undefined ? { stateTimestamp } : { staticMap: staticMapOf(match) }),
    players: match.players,
    entities: allEntities,
    // Lit fog cells (G-6b): base64 bitset over staticMap.visionCols × visionRows.
    vision,
    attackLog: match.attackLog,
    result: match.result,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    economy: serializeEconomy(match.economy),
    resourceNodes: allNodes,
    // Node control (G-8) is public, so it ignores fog.
    control: serializeControl(match),
    config: {
      mapWidth: match.config.mapWidth,
      mapHeight: match.config.mapHeight,
      viewportWidth: match.config.viewportWidth,
      viewportHeight: match.config.viewportHeight,
    },
    mapWidth: match.config.mapWidth,
    mapHeight: match.config.mapHeight,
    ruleset: (match.config.ruleset ?? "0.9") as Ruleset,
    // Neural opponents: the bot's latest read of its opponent (the client shows it only if asked to).
    botRead: (() => { const b = botPlayers.get(match.id); return b instanceof NeuralBotPlayer ? b.latestRead : undefined; })(),
  };
}

function broadcastGameState(code: string) {
  const matchId = lobbyMatchMap.get(code);
  if (!matchId) return;
  const match = matchEngine.getMatch(matchId);
  if (!match) return;

  for (const session of playerLobbyMap.values()) {
    if (session.code === code && session.matchId === matchId && !session.isBot) {
      const msg: ServerToClientMsg = {
        type: SERVER_EVT.GAME_STATE,
        payload: {
          match: buildMatchStatePayload(match, Date.now(), session.playerId),
        },
      };
      sendWS(session.ws, msg);
    }
  }
}

function broadcastMatchEnd(code: string, winner: string | null, winType?: WinType, replayId?: string) {
  const matchId = lobbyMatchMap.get(code);
  if (!matchId) return;

  const msg: ServerToClientMsg = {
    type: SERVER_EVT.MATCH_END,
    payload: { winner: winner as PlayerId | null, winType, replayId },
  };
  for (const session of playerLobbyMap.values()) {
    if (session.code === code && session.matchId === matchId) {
      sendWS(session.ws, msg);
    }
  }
}

function validateUsername(username: string): string | null {
  if (username.length < USERNAME_MIN_LENGTH) {
    return "Username is required.";
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return `Username must be ${USERNAME_MAX_LENGTH} characters or less.`;
  }
  if (!USERNAME_REGEX.test(username)) {
    return "Username can only contain letters, numbers, underscores, and hyphens.";
  }
  return null;
}

function toPlayerSlot(player: { id: string; username: string; color: string; score: number }): PlayerSlot {
  return {
    playerId: player.id,
    username: player.username,
    color: player.color as "blue" | "red",
    score: player.score,
  };
}

wss.on("connection", (ws) => {
  let playerId: string | null = null;
  const wsId = crypto.randomUUID();

  sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: wsId } });

  ws.on("message", (data) => {
    let msg: ClientToServerMsg;
    try {
      msg = JSON.parse(data.toString()) as ClientToServerMsg;
    } catch {
      sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Invalid JSON." } });
      return;
    }

    switch (msg.type) {
      case CLIENT_MSG.JOIN_LOBBY: {
        const result = lobbyManager.joinLobby(msg.payload.code, msg.payload.username);
        if (!result.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: result.message } });
          return;
        }

        playerId = result.player.id;
        playerLobbyMap.set(playerId, {
          playerId,
          code: msg.payload.code,
          ws,
        });

        broadcastLobbyState(ws, msg.payload.code);

        // Send the player's real ID back so client can identify itself
        sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: result.player.id } });

        // If match is already running, send match state
        const matchId = lobbyMatchMap.get(msg.payload.code);
        if (matchId) {
          const match = matchEngine.getMatch(matchId);
          if (match) {
            const matchStartMsg: ServerToClientMsg = {
              type: SERVER_EVT.MATCH_START,
              payload: {
                match: buildMatchStatePayload(match, undefined, result.player.id),
              },
            };
            sendWS(ws, matchStartMsg);
          }
        }
        break;
      }

    case CLIENT_MSG.CREATE_LOBBY: {
        const { code, player } = lobbyManager.createLobby(msg.payload.username, msg.payload.ruleset);

        playerId = player.id;
        playerLobbyMap.set(playerId, {
          playerId,
          code,
          ws,
        });

        broadcastLobbyState(ws, code);

        // Send the player's real ID back so client can identify itself
        sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: player.id } });
        break;
      }

    case CLIENT_MSG.START_SOLO_TEST: {
        // Create a solo test lobby with a scripted bot opponent
        const difficulty = (msg.payload as { username: string; difficulty?: string }).difficulty ?? "medium";
        const soloMapId = (msg.payload as { mapId?: string }).mapId;
        const soloRuleset = msg.payload.ruleset;
        const { code, player } = lobbyManager.createLobby(msg.payload.username, soloRuleset);
        
        playerId = player.id;
        playerLobbyMap.set(playerId, {
          playerId,
          code,
          ws,
        });
        
        sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: player.id } });
        
        // Add a dummy bot player
        const botPlayer = lobbyManager.addBotToLobby(code);
        if (!botPlayer) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Failed to create test game." } });
          return;
        }
        
        // Register bot's fake connection (won't actually send anything)
        playerLobbyMap.set(botPlayer.id, {
          playerId: botPlayer.id,
          code,
          ws: ws, // reuse player's WS for bot's messages so game state reaches them
          isBot: true,
        });
        
        // Mark both ready
        lobbyManager.toggleReady(code, player.id);
        lobbyManager.toggleReady(code, botPlayer.id);
        
        broadcastLobbyState(ws, code);
        
        // Both are ready — start the match
        const lobby = lobbyManager.getLobby(code);
        if (lobby && lobby.players[0]?.ready && lobby.players[1]?.ready) {
          const p0 = lobby.players[0]!;
          const p1 = lobby.players[1]!;
          const players: [PlayerSlot | null, PlayerSlot | null] = [
            toPlayerSlot(p0),
            toPlayerSlot(p1),
          ];
          
          const match = matchEngine.createMatch(code, players, liveConfig(soloMapId, soloRuleset));
          lobbyMatchMap.set(code, match.id);
          matchLobbyMap.set(match.id, code);
          loadGate.wait(match.id, [playerId]);

          // Create the in-process scripted bot
          const botAgent = difficulty === "easy" ? new IdleBot()
            : difficulty === "hard" ? new MacroBot()
            : new RushBot();
          const bot = new BotPlayer(botAgent, botPlayer.id, match.id, matchEngine);
          bot.init();
          botPlayers.set(match.id, bot);

          // Update player sessions with matchId
          for (const p of lobby.players) {
            if (p) {
              const s = playerLobbyMap.get(p.id);
              if (s) s.matchId = match.id;
            }
          }

          const matchStartMsg: ServerToClientMsg = {
            type: SERVER_EVT.MATCH_START,
            payload: {
              match: buildMatchStatePayload(match, undefined, playerId),
            },
          };
          sendWS(ws, matchStartMsg);
        }
        break;
      }

    case CLIENT_MSG.START_BOT_GAME: {
        const { username: bgUsername, bot: botName, mapId: bgMapId, ruleset: bgRuleset } = msg.payload;
        const neural = botName.startsWith("neural_") ? neuralModelFor(botName, bgRuleset) : null;
        if (botName.startsWith("neural_") && !neural) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "That neural opponent is not available on this server." } });
          return;
        }
        const scripted = scriptedBotFor(botName);
        if (botName.startsWith(SCRIPTED_PREFIX) && (!scripted || bgRuleset !== "beta")) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "That scripted opponent is only available in the beta." } });
          return;
        }
        const { code, player } = lobbyManager.createLobby(bgUsername, bgRuleset);

        playerId = player.id;
        playerLobbyMap.set(playerId, { playerId, code, ws });
        sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: player.id } });

        const botPlayer = lobbyManager.addBotToLobby(code, neural ? NEURAL_NAMES[botName] ?? "Neural" : scripted ? `Bot · ${scripted}` : "Bot");
        if (!botPlayer) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Failed to create bot game." } });
          return;
        }
        playerLobbyMap.set(botPlayer.id, { playerId: botPlayer.id, code, ws, isBot: true });

        lobbyManager.toggleReady(code, player.id);
        lobbyManager.toggleReady(code, botPlayer.id);

        // Send LOBBY_STATE before creating the match — client requires ws.lobbyState
        // to be populated so getCurrentPlayer() and getCurrentLobby() return non-null,
        // which GameShell requires to render. Without this, screen transitions to "game"
        // but GameShell is blank because lobby && player are falsy.
        broadcastLobbyState(ws, code);

        const lobby = lobbyManager.getLobby(code);
        if (lobby?.players[0]?.ready && lobby?.players[1]?.ready) {
          const players: [PlayerSlot | null, PlayerSlot | null] = [
            toPlayerSlot(lobby.players[0]!),
            toPlayerSlot(lobby.players[1]!),
          ];
          const match = matchEngine.createMatch(code, players, liveConfig(bgMapId, bgRuleset));
          lobbyMatchMap.set(code, match.id);
          matchLobbyMap.set(match.id, code);
          loadGate.wait(match.id, [playerId]);

          if (neural) {
            botPlayers.set(match.id, new NeuralBotPlayer(neural, botPlayer.id, match.id, matchEngine));
          } else if (scripted) {
            botPlayers.set(match.id, new ScriptedBotPlayer(scripted, botPlayer.id, match.id, matchEngine));
          } else {
            const bot = new BotPlayer(createBotAgent(botName), botPlayer.id, match.id, matchEngine);
            bot.init();
            botPlayers.set(match.id, bot);
          }

          for (const p of lobby.players) {
            if (p) { const s = playerLobbyMap.get(p.id); if (s) s.matchId = match.id; }
          }

          sendWS(ws, {
            type: SERVER_EVT.MATCH_START,
            payload: { match: buildMatchStatePayload(match, undefined, playerId) },
          });
        }
        break;
      }

    case CLIENT_MSG.SET_MAP: {
        const session = playerId ? playerLobbyMap.get(playerId) : undefined;
        if (!playerId || !session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }
        const wanted = (msg.payload as { mapId: string }).mapId;
        if (wanted !== "random" && !isKnownMap(wanted)) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Unknown map." } });
          return;
        }
        const result = lobbyManager.setMap(session.code, playerId, wanted);
        if (!result.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: result.message } });
          return;
        }
        broadcastLobbyState(ws, session.code);
        break;
      }

    case CLIENT_MSG.READY_TOGGLE: {
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        if (!session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }

        const result = lobbyManager.toggleReady(session.code, playerId);
        if (!result.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: result.message } });
          return;
        }

        broadcastLobbyState(ws, session.code);

        // If both ready (check lobby status), start match
        if (result.lobby.status === "ready") {
          const p0 = result.lobby.players[0]!;
          const p1 = result.lobby.players[1]!;
          const players: [PlayerSlot | null, PlayerSlot | null] = [
            toPlayerSlot(p0),
            toPlayerSlot(p1),
          ];

          const match = matchEngine.createMatch(session.code, players, liveConfig(result.lobby.mapId, result.lobby.ruleset));
          lobbyMatchMap.set(session.code, match.id);

          // Start once both clients have loaded
          loadGate.wait(match.id, [p0.id, p1.id]);

          // Update player sessions with matchId
          for (const p of result.lobby.players) {
            if (p) {
              const s = playerLobbyMap.get(p.id);
              if (s) s.matchId = match.id;
            }
          }

          // Also record in reverse map for broadcast callback
          matchLobbyMap.set(match.id, session.code);

          // Notify both players of match start (per-player filtered)
          for (const s of playerLobbyMap.values()) {
            if (s.code === session.code) {
              const matchStartMsg: ServerToClientMsg = {
                type: SERVER_EVT.MATCH_START,
                payload: {
                  match: buildMatchStatePayload(match, undefined, s.playerId),
                },
              };
              sendWS(s.ws, matchStartMsg);
            }
          }
        }
        break;
      }

      case CLIENT_MSG.MATCH_START: {
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        if (!session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }

        const matchId = lobbyMatchMap.get(session.code);
        if (!matchId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "No match to start." } });
          return;
        }

        const match = matchEngine.startMatch(matchId);
        if (!match) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Match could not be started." } });
          return;
        }
        liveRunner.start(matchId);

        const matchStartMsg: ServerToClientMsg = {
          type: SERVER_EVT.MATCH_START,
          payload: {
            match: buildMatchStatePayload(match),
          },
        };
        for (const s of playerLobbyMap.values()) {
          if (s.code === session.code) {
            sendWS(s.ws, matchStartMsg);
          }
        }
        break;
      }

      case CLIENT_MSG.GAME_COMMAND: {
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        if (!session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }

        const matchId = session.matchId;
        if (!matchId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "No active match." } });
          return;
        }

        // Rate limiting: max MAX_COMMANDS_PER_SECOND commands per second per player
        const now = Date.now();
        let rateEntry = commandRateMap.get(playerId);
        if (!rateEntry || now - rateEntry.resetTime > 1000) {
          rateEntry = { count: 0, resetTime: now };
          commandRateMap.set(playerId, rateEntry);
        }
        rateEntry.count++;
        if (rateEntry.count > MAX_COMMANDS_PER_SECOND) {
          // Silently ignore rate-limited commands
          return;
        }

        const cmd = msg.payload as {
          tick?: number;
          type: string;
          entityId?: string;
          entityIds?: string[];
          targetX?: number;
          targetY?: number;
          targetEntityId?: string;
          buildingType?: string;
          workerIds?: string[];
          buildingId?: string;
          unitType?: string;
          queued?: boolean;
        };
        const result = matchEngine.processCommand(matchId, playerId, {
          type: cmd.type as "move" | "attack_move" | "deselect" | "gather" | "train_worker" | "train_unit" | "cancel_queue" | "build" | "assign_build" | "repair" | "attack" | "heal" | "cover" | "set_rally" | "toggle_auto_attack" | "retreat" | "stop" | "guard" | "debug_move_node" | "debug_save_layout" | "debug_mirror_nodes",
          entityId: cmd.entityId,
          entityIds: cmd.entityIds,
          targetX: cmd.targetX,
          targetY: cmd.targetY,
          targetEntityId: cmd.targetEntityId,
          buildingType: cmd.buildingType as "barracks" | "foundry" | "supply_depot" | "turret" | "outpost" | undefined,
          workerIds: cmd.workerIds,
          buildingId: cmd.buildingId,
          unitType: cmd.unitType,
          queued: cmd.queued === true ? true : undefined,
        });

        if (!result.success) {
          // Silently ignore debug command failures — they're expected during exploration
          if (!["debug_move_node", "debug_save_layout", "debug_mirror_nodes"].includes(cmd.type)) {
            sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: result.message ?? "Command rejected." } });
          }
          return;
        }

        broadcastGameState(session.code);
        break;
      }

      case CLIENT_MSG.LEAVE_LOBBY: {
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        if (!session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }

        const leavePlayerId = playerId;

        // If there's an active match, end it (leaver loses). Left while loading: start the
        // match first so the forfeit applies. The match-end callback records the win, saves
        // the replay and tells the remaining player; the leaver is dropped first so they
        // don't get a result screen for the match they just quit.
        if (session.matchId) {
          loadGate.release(session.matchId);
          const match = matchEngine.getMatch(session.matchId);
          if (match && match.phase === "playing") {
            const otherPlayer = match.players.find((p) => p?.playerId !== leavePlayerId);
            if (otherPlayer) {
              playerLobbyMap.delete(leavePlayerId);
              liveRunner.stop(session.matchId);
              matchEngine.endMatch(session.matchId, otherPlayer.playerId, "forfeit");
            }
          }
        }

        playerLobbyMap.delete(playerId);
        playerId = null;

        const result = lobbyManager.leaveLobby(session.code, leavePlayerId);
        if (!result.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: result.message } });
          return;
        }

        if (result.lobby === null) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Lobby was disbanded." } });
        } else {
          broadcastLobbyState(ws, session.code);
        }
        break;
      }

      case CLIENT_MSG.DEBUG_WIN: {
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        if (!session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }

        const winnerParam = msg.payload.winner as string;
        let slotKey: string;
        if (winnerParam === "self") {
          const currentSession = playerLobbyMap.get(playerId);
          if (!currentSession) {
            sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
            return;
          }
          const currentLobby = lobbyManager.getLobby(currentSession.code);
          if (!currentLobby) {
            sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Lobby not found." } });
            return;
          }
          const isPlayer1 = currentLobby.players[0]?.id === playerId;
          slotKey = isPlayer1 ? "player1" : "player2";
        } else {
          slotKey = winnerParam;
        }

        // In a running match, end it normally: the match-end callback records the win,
        // saves the replay and sends MATCH_END (with the replay id) to both players.
        const activeMatch = session.matchId ? matchEngine.getMatch(session.matchId) : undefined;
        const debugWinner = lobbyManager.getLobby(session.code)?.players[slotKey === "player1" ? 0 : 1]?.id;
        if (session.matchId && activeMatch?.phase === "playing" && debugWinner) {
          matchEngine.endMatch(session.matchId, debugWinner);
          break;
        }

        const winResult = lobbyManager.recordWin(session.code, slotKey as "player1" | "player2");
        if (!winResult.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: winResult.message } });
          return;
        }

        const winnerId =
          slotKey === "player1"
            ? winResult.lobby.players[0]!.id
            : winResult.lobby.players[1]!.id;

        const matchEndMsg: ServerToClientMsg = { type: SERVER_EVT.MATCH_END, payload: { winner: winnerId } };
        for (const s of playerLobbyMap.values()) {
          if (s.code === session.code) {
            sendWS(s.ws, matchEndMsg);
          }
        }
        broadcastLobbyState(ws, session.code);
        break;
      }

      case CLIENT_MSG.DEBUG_SPAWN: {
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        if (!session || !session.matchId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "No active match." } });
          return;
        }

        const spawnPayload = msg.payload as { entityType: string; buildingType?: string; x: number; y: number };
        const result = matchEngine.debugSpawn(
          session.matchId,
          playerId,
          spawnPayload.entityType as "worker" | "skirmisher" | "gunner" | "bruiser" | "medic" | "bulwark" | "building",
          spawnPayload.x,
          spawnPayload.y,
          spawnPayload.buildingType as "barracks" | "foundry" | "supply_depot" | "turret" | "outpost" | undefined
        );

        if (!result.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: result.message ?? "Spawn failed." } });
          return;
        }

        // Broadcast updated state
        broadcastGameState(session.code);
        break;
      }

      case CLIENT_MSG.USERNAME: {
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        if (!session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }
        const usernameError = validateUsername(msg.payload.username);
        if (usernameError) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: usernameError } });
          return;
        }
        const player = lobbyManager.getLobby(session.code)?.players.find(
          (p) => p?.id === playerId
        );
        if (player) {
          player.username = msg.payload.username;
          broadcastLobbyState(ws, session.code);
        }
        break;
      }

      case CLIENT_MSG.START_REPLAY: {
        const { replayId } = msg.payload;
        const replay = getReplay(replayId);
        if (!replay) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Replay not found." } });
          return;
        }
        // Stop any existing replay this client is watching
        const existingMatchId = replayWatchers.get(ws);
        if (existingMatchId) replayRunner.stop(existingMatchId);

        const matchId = replayRunner.start(replay, ws, (mid) => {
          replayWatchers.delete(ws);
        });
        replayWatchers.set(ws, matchId);
        break;
      }

      case CLIENT_MSG.STOP_REPLAY: {
        feeds.unwatch(ws);
        const watchingMatchId = replayWatchers.get(ws);
        if (watchingMatchId) {
          replayRunner.stop(watchingMatchId);
          replayWatchers.delete(ws);
        }
        break;
      }

      case CLIENT_MSG.TOURNAMENT_CREATE:
      case CLIENT_MSG.TOURNAMENT_JOIN:
      case CLIENT_MSG.TOURNAMENT_LEAVE:
      case CLIENT_MSG.TOURNAMENT_READY:
      case CLIENT_MSG.TOURNAMENT_WATCH:
      case CLIENT_MSG.TOURNAMENT_ADMIN:
      case CLIENT_MSG.TOURNAMENT_SPECTATE:
      case CLIENT_MSG.TOURNAMENT_PLAY: {
        const fail = (message: string) => sendWS(ws, { type: SERVER_EVT.TOURNAMENT_ERROR, payload: { message } });
        const p = msg.payload as { code?: string; token?: string };
        const token = typeof p.token === "string" && p.token.length >= 16 && p.token.length <= 128 ? p.token : undefined;
        if (msg.type !== CLIENT_MSG.TOURNAMENT_WATCH && msg.type !== CLIENT_MSG.TOURNAMENT_SPECTATE && !token) { fail("Missing or invalid token."); break; }
        try {
          if (msg.type === CLIENT_MSG.TOURNAMENT_CREATE) {
            const t = tournaments.create(token!, msg.payload.settings, poolMaps().map((m) => m.mapId));
            tWatchers.set(ws, { tid: t.id, token });
            pushTournament(t);
            break;
          }
          const t = tournaments.byCode(String(p.code ?? ""));
          if (!t) { fail("Tournament not found."); break; }
          switch (msg.type) {
            case CLIENT_MSG.TOURNAMENT_WATCH:
              tWatchers.set(ws, { tid: t.id, token });
              sendWS(ws, { type: SERVER_EVT.TOURNAMENT_STATE, payload: { state: tournaments.publicState(t), viewer: tournaments.viewer(t, token) } });
              break;
            case CLIENT_MSG.TOURNAMENT_JOIN:
              tWatchers.set(ws, { tid: t.id, token });
              tournaments.join(t, String(msg.payload.username ?? "").trim().slice(0, 20), token!);
              break;
            case CLIENT_MSG.TOURNAMENT_LEAVE: tournaments.leave(t, token!); break;
            case CLIENT_MSG.TOURNAMENT_READY: tournaments.ready(t, token!); break;
            case CLIENT_MSG.TOURNAMENT_ADMIN: {
              const { code: _c, token: _t, ...op } = msg.payload;
              tournaments.admin(t, token!, op as AdminOp);
              break;
            }
            case CLIENT_MSG.TOURNAMENT_SPECTATE: {
              const round = t.rounds[t.rounds.length - 1];
              const s = round?.series.find((x) => x.slot === Number(msg.payload.slot));
              const g = s?.status === "playing" ? s.games[s.games.length - 1] : undefined;
              const live = g?.matchId ? matchEngine.getMatch(g.matchId) : undefined;
              if (!s || !g || !live || live.phase !== "playing") { fail("That game isn't live."); break; }
              const name = (id: string | null) => t.entrants.find((e) => e.id === id)?.name ?? "?";
              const info = { code: t.code, round: round.number, slot: s.slot, game: s.games.length, bestOf: s.bestOf, a: name(s.a), b: name(s.b) };
              if (!feeds.watch(ws, live, { ...DEFAULT_CONFIG, mapId: g.map, ruleset: "beta" }, t.settings.spectatorDelay, info)) fail("That game isn't live.");
              break;
            }
            case CLIENT_MSG.TOURNAMENT_PLAY: {
              const entrantId = tournaments.viewer(t, token).entrantId;
              const live = entrantId ? [...tMatches].find(([, m]) => m.tid === t.id && m.byEntrant[entrantId]) : undefined;
              const match = live && matchEngine.getMatch(live[0]);
              if (!live || !match || match.phase === "ended") { fail("You have no game in progress."); break; }
              const [matchId, tm] = live;
              const seat = tm.byEntrant[entrantId!];
              clearTimeout(tGrace.get(seat));
              tGrace.delete(seat);
              // A second tab takes the seat over.
              const old = playerLobbyMap.get(seat);
              if (old && old.ws !== ws) sendWS(old.ws, { type: SERVER_EVT.TOURNAMENT_ERROR, payload: { message: "This game was opened in another window." } });
              playerId = seat;
              playerLobbyMap.set(seat, { playerId: seat, code: tm.code, ws, matchId });
              sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: seat } });
              broadcastLobbyState(ws, tm.code);
              sendWS(ws, { type: SERVER_EVT.MATCH_START, payload: { match: buildMatchStatePayload(match, undefined, seat) } });
              break;
            }
          }
        } catch (e) {
          if (e instanceof TournamentError) fail(e.message); else throw e;
        }
        break;
      }

      case CLIENT_MSG.TOURNAMENT_UNWATCH:
        tWatchers.delete(ws);
        break;

      case CLIENT_MSG.CLIENT_LOADED: {
        const matchId = playerId ? playerLobbyMap.get(playerId)?.matchId : undefined;
        if (matchId) loadGate.loaded(matchId, playerId!);
        break;
      }

      case CLIENT_MSG.REPLAY_SPEED: {
        const speedMatchId = replayWatchers.get(ws);
        if (speedMatchId) {
          const mult = Number(msg.payload?.speed ?? 1);
          replayRunner.setSpeed(speedMatchId, mult);
        }
        break;
      }

      default: {
        sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Unknown message type." } });
        break;
      }
    }
  });

  ws.on("close", () => {
    // Clean up any replay this client was watching
    const watchingMatchId = replayWatchers.get(ws);
    if (watchingMatchId) {
      replayRunner.stop(watchingMatchId);
      replayWatchers.delete(ws);
    }
    tWatchers.delete(ws);
    feeds.unwatch(ws);

    // A tournament seat survives a disconnect: the player has a grace period to rejoin with TOURNAMENT_PLAY.
    const tSession = playerId ? playerLobbyMap.get(playerId) : undefined;
    if (playerId && tSession?.matchId && tMatches.has(tSession.matchId)) {
      // Unless another window has taken the seat over.
      if (tSession.ws === ws) { playerLobbyMap.delete(playerId); armGrace(playerId, tSession.matchId); }
      playerId = null;
      return;
    }

    if (playerId) {
      const session = playerLobbyMap.get(playerId);
      if (session) {
        // Handle disconnect during active match
        if (session.matchId) {
          // Left while loading: start the match so the forfeit below applies.
          loadGate.release(session.matchId);
          const match = matchEngine.getMatch(session.matchId);
          if (match && match.phase === "playing") {
            const otherPlayer = match.players.find((p) => p?.playerId !== playerId);
            if (otherPlayer) {
              // The match-end callback records the win, saves the replay and sends MATCH_END.
              const otherSession = [...playerLobbyMap.values()].find(
                (s) => s.code === session.code && s.playerId !== playerId
              );
              playerLobbyMap.delete(playerId);
              liveRunner.stop(session.matchId);
              matchEngine.endMatch(session.matchId, otherPlayer.playerId, "forfeit");

              if (otherSession) {
                sendWS(otherSession.ws, {
                  type: SERVER_EVT.HOST_DISCONNECT,
                  payload: { message: "Opponent disconnected. You win by default." },
                });
              }

              // Reset ready states
              lobbyManager.resetReadyStates(session.code);
              lobbyMatchMap.delete(session.code);
            }
          }
        }

        // Handle host disconnect (existing logic)
        const lobby = lobbyManager.getLobby(session.code);
        if (lobby && lobby.hostId === playerId) {
          const otherSession = [...playerLobbyMap.values()].find(
            (s) => s.code === session.code && s.playerId !== playerId
          );
          if (otherSession && !session.matchId) {
            sendWS(otherSession.ws, {
              type: SERVER_EVT.HOST_DISCONNECT,
              payload: { message: "Host disconnected. You win by default." },
            });
          }
        }

        // Clean up from lobby
        lobbyManager.leaveLobby(session.code, playerId);
        playerLobbyMap.delete(playerId);
        playerId = null;
      }
    }
  });
});

// WebSocket ping/pong heartbeat — keep connections alive
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, 30000);

// Periodic cleanup of stale rate-limit entries (every 5 minutes)
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of commandRateMap.entries()) {
    if (now - entry.resetTime > 60000) {
      commandRateMap.delete(key);
    }
  }
}, 300000);

// Clean up intervals when server closes
httpServer.on("close", () => {
  clearInterval(pingInterval);
  clearInterval(rateLimitCleanup);
  clearInterval(tournamentTick);
  clearInterval(feedTick);
  feeds.stopAll();
});

// API routes
app.get("/api/lobbies", (_req: Request, res: Response) => {
  res.json({ lobbies: lobbyManager.getAllLobbies() });
});

app.get("/api/matches", (_req: Request, res: Response) => {
  res.json({ matches: matchEngine.getAllMatches() });
});

/** G-7: maps the lobby offers (pool first, then dev maps), with thumbnail data. */
app.get("/api/tournaments", (_req: Request, res: Response) => {
  res.json({ tournaments: tournaments.summaries(), bots: tournamentBots() });
});

// Server admin (server/src/tournamentAdmin.ts, spec §7): a fresh secret each start, in a file only this
// box can read; requests must also come from loopback.
const adminSecret = randomBytes(24).toString("hex");
{
  const dir = path.resolve(process.cwd(), "tournaments"), file = path.join(dir, ".admin-token");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, adminSecret, { mode: 0o600 });
  chmodSync(file, 0o600);
}
function isAdmin(req: Request): boolean {
  const given = Buffer.from(String(req.get("x-admin-token") ?? ""));
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  return loopback && given.length === adminSecret.length && timingSafeEqual(given, Buffer.from(adminSecret));
}

/** Give a tournament's manager role to a player's browser (`entrant`), a given token, or a new one. */
app.post("/api/admin/tournaments/:code/manager", express.json(), (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "Forbidden." }); return; }
  const t = tournaments.byCode(req.params.code);
  if (!t) { res.status(404).json({ error: "Tournament not found." }); return; }
  const body = (req.body ?? {}) as { entrant?: unknown; token?: unknown };
  let token: string;
  if (typeof body.entrant === "string") {
    const want = body.entrant.trim().toLowerCase();
    const e = t.entrants.find((x) => !x.bot && x.name.toLowerCase() === want);
    if (!e || !t.tokens[e.id]) { res.status(404).json({ error: `No human entrant named "${body.entrant}".` }); return; }
    token = t.tokens[e.id];
  } else if (body.token !== undefined) {
    if (typeof body.token !== "string" || body.token.length < 16 || body.token.length > 128) { res.status(400).json({ error: "A token is 16–128 characters." }); return; }
    token = body.token;
  } else token = randomBytes(16).toString("hex");
  tournaments.reassignManager(t, token);
  res.json({ code: t.code, name: t.settings.name, token });
});

app.get("/api/maps", (_req: Request, res: Response) => {
  const W = DEFAULT_CONFIG.mapWidth, H = DEFAULT_CONFIG.mapHeight;
  const describe = (mapId: string, name: string, version: number, approved: string | null, pool: boolean) => {
    const t = terrainFor(mapId, W, H);
    return { mapId, name, version, approved, pool, cols: t.cols, rows: t.rows, width: W, height: H, terrain: encodeTerrain(t), nodes: contestedNodesFor(mapId, W, H) ?? null };
  };
  res.json([
    ...poolMaps().map((m) => describe(m.mapId, m.name, m.version, m.approved, true)),
    describe("testbed", "Testbed (dev)", 1, null, false),
    describe("classic", "Classic (open, dev)", 1, null, false),
  ]);
});

app.get("/api/version", (_req: Request, res: Response) => {
  res.json({ version: GAME_VERSION });
});

app.get("/api/replays", (req: Request, res: Response) => {
  const page     = Math.max(1, parseInt(req.query.page     as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 30));
  const sort     = (req.query.sort    as string) || "timestamp";
  const asc      = req.query.asc === "true";
  const winner   = (req.query.winner  as string) || "all";
  const winType  = (req.query.winType as string) || "all";
  const ruleset  = (req.query.ruleset as string) || "all";
  const bot      = ((req.query.bot    as string) || "").toLowerCase().trim();
  const flags    = ((req.query.flags  as string) || "").split(",").filter(Boolean);
  const starred  = new Set(((req.query.starred as string) || "").split(",").filter(Boolean));

  let list = listReplays();

  if (winner === "blue")   list = list.filter(r => r.outcome.winner?.includes("blue"));
  else if (winner === "red")   list = list.filter(r => r.outcome.winner?.includes("red"));
  else if (winner === "draw")  list = list.filter(r => !r.outcome.winner);

  if (winType !== "all") list = list.filter(r => (r.winType ?? r.outcome.winType) === winType);
  if (ruleset !== "all") list = list.filter(r => (r.ruleset ?? "0.9") === ruleset);
  if (bot)               list = list.filter(r => r.blue.toLowerCase().includes(bot) || r.red.toLowerCase().includes(bot));
  if (flags.length > 0)  list = list.filter(r => flags.every(f => (r.flags ?? []).includes(f)));
  if (starred.size > 0)  list = list.filter(r => starred.has(r.id));

  list.sort((a, b) => {
    let va: number, vb: number;
    switch (sort) {
      case "seed":   va = a.seed;          vb = b.seed;          break;
      case "ticks":  va = a.outcome.ticks; vb = b.outcome.ticks; break;
      case "winner":
        va = a.outcome.winner?.includes("blue") ? 1 : a.outcome.winner?.includes("red") ? 2 : 0;
        vb = b.outcome.winner?.includes("blue") ? 1 : b.outcome.winner?.includes("red") ? 2 : 0;
        break;
      default: va = a.timestamp; vb = b.timestamp; break;
    }
    return asc ? va - vb : vb - va;
  });

  const total = list.length;
  res.json({ replays: list.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize });
});

app.get("/api/replays/:id", (req: Request, res: Response) => {
  const replay = getReplay(req.params.id);
  if (!replay) { res.status(404).json({ error: "Not found" }); return; }
  res.json(replay);
});

// Serve built client in production
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, "..", "..");
const clientBuildPath = path.join(rootDir, "client", "dist");
app.use(express.static(clientBuildPath));

// Catch-all for SPA routes (/t/<CODE>); Express 4, so a regex. API and asset paths still 404.
app.get(/^\/(?!api\/)[^.]*$/, (_req: Request, res: Response) => {
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`CrystalFront RTS server running on http://0.0.0.0:${PORT}`);
  void loadNeuralModels();
  // Parse replay metadata once at boot so the first Replays visit isn't slow.
  setTimeout(() => { try { listReplays(); } catch { /* listed lazily instead */ } }, 1000);
});

export { app, httpServer, lobbyManager, matchEngine, liveRunner };
