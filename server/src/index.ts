import express, { Request, Response } from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, dirname as dirnameFn } from "node:path";

const _serverDir = dirnameFn(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(resolvePath(_serverDir, "../../package.json"), "utf8"));
const GAME_VERSION: string = _pkg.version ?? "unknown";
import { LobbyManager } from "./lobby/lobbyManager.js";
import { MatchEngine } from "./match/matchEngine.js";
import { LiveMatchRunner } from "./match/liveMatchRunner.js";
import { BotPlayer } from "./match/botPlayer.js";
import {
  MlBot, IdleBot, PassiveBot, WeakRushBot, WeakMediumRushBot,
  MediumRushBot, RushBot, TurtleBot, MacroBot, HeavyBot,
} from "../../headless/src/bots/index.js";
import type { Agent } from "../../headless/src/types.js";
import { ReplayRunner, listReplays, getReplay, ensureReplaysDir, saveReplay } from "./match/replayRunner.js";
import type { MatchEntity, MatchState, PlayerSlot, ResourceNode, PlayerEconomy } from "./match/types.js";
import {
  CLIENT_MSG,
  SERVER_EVT,
  type ClientToServerMsg,
  type ServerToClientMsg,
  type PlayerId,
  type EntityType,
  type BuildingType,
  type UnitType,
} from "@crystalfront/shared";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_REGEX,
} from "@crystalfront/shared";

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

// Pre-load MlBot ONNX session at startup so first game has no latency.
let mlBotSession: MlBot | null = null;
MlBot.create().then(bot => { mlBotSession = bot; console.log("[server] MlBot ONNX session ready"); }).catch(e => console.warn("[server] MlBot failed to load:", e));

function createBotAgent(name: string): Agent {
  switch (name) {
    case "ml":               return mlBotSession ?? new IdleBot(); // fallback if still loading
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
const replayRunner = new ReplayRunner();

// Track which WS connection is watching which replay matchId
const replayWatchers = new Map<WebSocket, string>();

// Per-match bot players (for Solo Test mode)
const botPlayers = new Map<string, BotPlayer>();

const liveRunner = new LiveMatchRunner(matchEngine, (matchId: string) => {
  // Step the bot (if any) before broadcasting so the bot's commands are included
  botPlayers.get(matchId)?.tick();
  const code = matchLobbyMap.get(matchId);
  if (code) {
    broadcastGameState(code);
  }
});

matchEngine.setMatchEndCallback((matchId: string, winner: string) => {
  liveRunner.stop(matchId);
  botPlayers.delete(matchId);
  const code = matchLobbyMap.get(matchId);
  if (code) {
    broadcastMatchEnd(code, winner);
    const lobby = lobbyManager.getLobby(code);
    if (lobby) {
      const winnerSlot = winner === lobby.players[0]?.id ? "player1" : "player2";
      lobbyManager.recordWin(code, winnerSlot);
    }

    // Save replay for every completed match (pvp and vs-bot).
    try {
      const match = matchEngine.getMatch(matchId);
      if (match) {
        const bluePlayer = lobby?.players.find(p => p?.color === "blue");
        const redPlayer  = lobby?.players.find(p => p?.color === "red");
        const winnerPlayer = lobby?.players.find(p => p?.id === winner);
        saveReplay({
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
        });
      }
    } catch (e) {
      console.error("[server] Failed to save replay:", e);
    }

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

function serializeEntities(entities: Map<string, MatchEntity>): Array<{
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
  autoAttackEnabled: boolean;
  rallyPoint?: { x: number; y: number };
}> {
  return Array.from(entities.values()).map((e) => ({
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
    autoAttackEnabled: e.autoAttackEnabled,
    rallyPoint: e.rallyPoint,
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
  let allEntities = serializeEntities(match.entities);
  let allNodes = serializeResourceNodes(match.resourceNodes);

  // Fog of war: filter by visibility when playerId is provided and visibility data exists
  if (playerId && match.visibilityData) {
    const vis = match.visibilityData.get(playerId);
    if (vis) {
      allEntities = allEntities.filter(e => vis.entityIds.has(e.id));
      allNodes = allNodes.filter(n => vis.nodeIds.has(n.id));
    }
  }

  return {
    id: match.id,
    lobbyCode: match.lobbyCode,
    phase: match.phase,
    tick: match.tick,
    tickIntervalMs: match.tickIntervalMs,
    ...(stateTimestamp !== undefined ? { stateTimestamp } : {}),
    players: match.players,
    entities: allEntities,
    attackLog: match.attackLog,
    result: match.result,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    economy: serializeEconomy(match.economy),
    resourceNodes: allNodes,
    config: {
      mapWidth: match.config.mapWidth,
      mapHeight: match.config.mapHeight,
      viewportWidth: match.config.viewportWidth,
      viewportHeight: match.config.viewportHeight,
    },
    mapWidth: match.config.mapWidth,
    mapHeight: match.config.mapHeight,
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

function broadcastMatchEnd(code: string, winner: string) {
  const matchId = lobbyMatchMap.get(code);
  if (!matchId) return;

  const msg: ServerToClientMsg = {
    type: SERVER_EVT.MATCH_END,
    payload: { winner: winner as PlayerId },
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
        const { code, player } = lobbyManager.createLobby(msg.payload.username);

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
        const { code, player } = lobbyManager.createLobby(msg.payload.username);
        
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
          
          const match = matchEngine.createMatch(code, players);
          lobbyMatchMap.set(code, match.id);
          matchEngine.startMatch(match.id);
          liveRunner.start(match.id);
          matchLobbyMap.set(match.id, code);

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
        const { username: bgUsername, bot: botName } = msg.payload as { username: string; bot: string };
        const { code, player } = lobbyManager.createLobby(bgUsername);

        playerId = player.id;
        playerLobbyMap.set(playerId, { playerId, code, ws });
        sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: player.id } });

        const botPlayer = lobbyManager.addBotToLobby(code);
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
          const match = matchEngine.createMatch(code, players);
          lobbyMatchMap.set(code, match.id);
          matchEngine.startMatch(match.id);
          liveRunner.start(match.id);
          matchLobbyMap.set(match.id, code);

          const botAgent = createBotAgent(botName);
          const bot = new BotPlayer(botAgent, botPlayer.id, match.id, matchEngine);
          bot.init();
          botPlayers.set(match.id, bot);

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

          const match = matchEngine.createMatch(session.code, players);
          lobbyMatchMap.set(session.code, match.id);

          // Start the match immediately
          matchEngine.startMatch(match.id);
          liveRunner.start(match.id);

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
        };
        const result = matchEngine.processCommand(matchId, playerId, {
          type: cmd.type as "move" | "deselect" | "gather" | "train_worker" | "train_unit" | "cancel_queue" | "build" | "assign_build" | "repair" | "attack" | "heal" | "set_rally" | "toggle_auto_attack" | "retreat" | "stop" | "debug_move_node" | "debug_save_layout" | "debug_mirror_nodes",
          entityId: cmd.entityId,
          entityIds: cmd.entityIds,
          targetX: cmd.targetX,
          targetY: cmd.targetY,
          targetEntityId: cmd.targetEntityId,
          buildingType: cmd.buildingType as "barracks" | "foundry" | "supply_depot" | "turret" | undefined,
          workerIds: cmd.workerIds,
          buildingId: cmd.buildingId,
          unitType: cmd.unitType,
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

        // If there's an active match, end it (leaver loses)
        if (session.matchId) {
          const match = matchEngine.getMatch(session.matchId);
          if (match && match.phase === "playing") {
            const otherPlayer = match.players.find((p) => p?.playerId !== leavePlayerId);
            if (otherPlayer) {
              liveRunner.stop(session.matchId);
              matchEngine.endMatch(session.matchId, otherPlayer.playerId);

              // Record the win in lobby manager
              const lobby = lobbyManager.getLobby(session.code);
              if (lobby) {
                const winnerSlot = otherPlayer.playerId === lobby.players[0]?.id ? "player1" : "player2";
                lobbyManager.recordWin(session.code, winnerSlot);
              }

              // Notify both players
              const matchEndMsg: ServerToClientMsg = { type: SERVER_EVT.MATCH_END, payload: { winner: otherPlayer.playerId } };
              for (const s of playerLobbyMap.values()) {
                if (s.code === session.code && s.matchId === session.matchId) {
                  sendWS(s.ws, matchEndMsg);
                }
              }

              // Reset ready states for rematch
              lobbyManager.resetReadyStates(session.code);
              lobbyMatchMap.delete(session.code);
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

        const winResult = lobbyManager.recordWin(session.code, slotKey as "player1" | "player2");
        if (!winResult.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: winResult.message } });
          return;
        }

        const winnerId =
          slotKey === "player1"
            ? winResult.lobby.players[0]!.id
            : winResult.lobby.players[1]!.id;

        // If there's an active match, end it
        if (session.matchId) {
          const match = matchEngine.getMatch(session.matchId);
          if (match && match.phase === "playing") {
            liveRunner.stop(session.matchId);
            matchEngine.endMatch(session.matchId, winnerId);
            lobbyManager.resetReadyStates(session.code);
            lobbyMatchMap.delete(session.code);
          }
        }

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
          spawnPayload.entityType as "worker" | "skirmisher" | "gunner" | "bruiser" | "medic" | "building",
          spawnPayload.x,
          spawnPayload.y,
          spawnPayload.buildingType as "barracks" | "foundry" | "supply_depot" | "turret" | undefined
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
        const watchingMatchId = replayWatchers.get(ws);
        if (watchingMatchId) {
          replayRunner.stop(watchingMatchId);
          replayWatchers.delete(ws);
        }
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

    if (playerId) {
      const session = playerLobbyMap.get(playerId);
      if (session) {
        // Handle disconnect during active match
        if (session.matchId) {
          const match = matchEngine.getMatch(session.matchId);
          if (match && match.phase === "playing") {
            const otherPlayer = match.players.find((p) => p?.playerId !== playerId);
            if (otherPlayer) {
              // Record the win
              const lobby = lobbyManager.getLobby(session.code);
              if (lobby) {
                const winnerSlot = otherPlayer.playerId === lobby.players[0]?.id ? "player1" : "player2";
                lobbyManager.recordWin(session.code, winnerSlot);
              }

              // End the match
              liveRunner.stop(session.matchId);
              matchEngine.endMatch(session.matchId, otherPlayer.playerId);

              // Notify the other player
              const otherSession = [...playerLobbyMap.values()].find(
                (s) => s.code === session.code && s.playerId !== playerId
              );
              if (otherSession) {
                sendWS(otherSession.ws, {
                  type: SERVER_EVT.MATCH_END,
                  payload: { winner: otherPlayer.playerId },
                });
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
});

// API routes
app.get("/api/lobbies", (_req: Request, res: Response) => {
  res.json({ lobbies: lobbyManager.getAllLobbies() });
});

app.get("/api/matches", (_req: Request, res: Response) => {
  res.json({ matches: matchEngine.getAllMatches() });
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
  const bot      = ((req.query.bot    as string) || "").toLowerCase().trim();
  const flags    = ((req.query.flags  as string) || "").split(",").filter(Boolean);
  const starred  = new Set(((req.query.starred as string) || "").split(",").filter(Boolean));

  let list = listReplays();

  if (winner === "blue")   list = list.filter(r => r.outcome.winner?.includes("blue"));
  else if (winner === "red")   list = list.filter(r => r.outcome.winner?.includes("red"));
  else if (winner === "draw")  list = list.filter(r => !r.outcome.winner);

  if (winType !== "all") list = list.filter(r => (r.winType ?? r.outcome.winType) === winType);
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

// Catch-all for SPA routing
app.get("{*path}", (_req: Request, res: Response) => {
  res.sendFile(path.join(clientBuildPath, "index.html"));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`CrystalFront RTS server running on http://0.0.0.0:${PORT}`);
});

export { app, httpServer, lobbyManager, matchEngine, liveRunner };
