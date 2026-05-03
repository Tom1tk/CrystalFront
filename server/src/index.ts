import express, { Request, Response } from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LobbyManager } from "./lobby/lobbyManager.js";
import { MatchEngine } from "./match/matchEngine.js";
import type { MatchEntity, PlayerSlot, ResourceNode, PlayerEconomy } from "./match/types.js";
import {
  CLIENT_MSG,
  SERVER_EVT,
  type ClientToServerMsg,
  type ServerToClientMsg,
  type PlayerId,
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

const lobbyManager = new LobbyManager();
const matchEngine = new MatchEngine();

matchEngine.setBroadcastCallback((matchId: string) => {
  for (const session of playerLobbyMap.values()) {
    if (session.matchId === matchId) {
      broadcastGameState(session.code);
      break;
    }
  }
});

matchEngine.setMatchEndCallback((matchId: string, winner: string) => {
  for (const session of playerLobbyMap.values()) {
    if (session.matchId === matchId) {
      broadcastMatchEnd(session.code, winner);
      lobbyManager.resetReadyStates(session.code);
      break;
    }
  }
});

const playerLobbyMap = new Map<string, { playerId: string; code: string; ws: WebSocket; matchId?: string }>();
const lobbyMatchMap = new Map<string, string>();

function sendWS(ws: WebSocket, msg: ServerToClientMsg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastLobbyState(ws: WebSocket, code: string) {
  console.log("[Server] broadcastLobbyState called for code:", code, "total sessions:", playerLobbyMap.size);
  const state = { lobbies: lobbyManager.getAllLobbies() };
  const msg: ServerToClientMsg = { type: SERVER_EVT.LOBBY_STATE, payload: { lobby: state } };
  let count = 0;
  for (const session of playerLobbyMap.values()) {
    if (session.code === code) {
      sendWS(session.ws, msg);
      count++;
    }
  }
  console.log("[Server] broadcastLobbyState sent to", count, "sessions");
}

function serializeEntities(entities: Map<string, MatchEntity>): Array<{
  id: string;
  type: string;
  ownerId: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  radius: number;
  color: string;
  buildingType?: string;
  constructionProgress?: number;
  buildWorkerIds?: string[];
  buildTargetId?: string;
  gatheringNodeId?: string;
  productionQueue?: Array<{
    unitType: string;
    cost: number;
    supplyCost: number;
    buildTime: number;
    remainingTicks: number;
  }>;
  repairTargetId?: string;
  moveTarget?: { x: number; y: number };
  attackTargetId?: string;
  attackCooldown?: number;
  healTargetId?: string;
  autoAttackEnabled?: boolean;
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

function serializeBuildings(entities: Map<string, MatchEntity>): Array<{
  id: string;
  type: string;
  ownerId: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  radius: number;
  color: string;
  buildingType?: string;
  constructionProgress?: number;
  productionQueue?: Array<{
    unitType: string;
    cost: number;
    supplyCost: number;
    buildTime: number;
    remainingTicks: number;
  }>;
  repairTargetId?: string;
}> {
  return Array.from(entities.values())
    .filter((e) => e.type === "building")
    .map((e) => ({
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
      productionQueue: e.productionQueue.map((q) => ({
        unitType: q.unitType,
        cost: q.cost,
        supplyCost: q.supplyCost,
        buildTime: q.buildTime,
        remainingTicks: q.remainingTicks,
      })),
      repairTargetId: e.repairTargetId,
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

function broadcastGameState(code: string) {
  const matchId = lobbyMatchMap.get(code);
  if (!matchId) return;
  const match = matchEngine.getMatch(matchId);
  if (!match) return;

const allEntities = serializeEntities(match.entities);

   const msg: ServerToClientMsg = {
          type: SERVER_EVT.GAME_STATE,
          payload: {
            match: {
             id: match.id,
             lobbyCode: match.lobbyCode,
             phase: match.phase,
             tick: match.tick,
             tickIntervalMs: match.tickIntervalMs,
             players: match.players,
             entities: allEntities as any,
             attackLog: match.attackLog,
             result: match.result,
             startedAt: match.startedAt,
             endedAt: match.endedAt,
             economy: serializeEconomy(match.economy),
             resourceNodes: serializeResourceNodes(match.resourceNodes),
             config: {
               mapWidth: match.config.mapWidth,
               mapHeight: match.config.mapHeight,
               viewportWidth: match.config.viewportWidth,
               viewportHeight: match.config.viewportHeight,
             },
             mapWidth: match.config.mapWidth,
             mapHeight: match.config.mapHeight,
           },
         },
       };
  for (const session of playerLobbyMap.values()) {
    if (session.code === code && session.matchId === matchId) {
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
           const allEntities = serializeEntities(match.entities);
            const matchStartMsg: ServerToClientMsg = {
              type: SERVER_EVT.MATCH_START,
              payload: {
                match: {
                  id: match.id,
                  lobbyCode: match.lobbyCode,
                  phase: match.phase,
                  tick: match.tick,
                  tickIntervalMs: match.tickIntervalMs,
                  players: match.players,
                entities: allEntities as any,
                   attackLog: match.attackLog,
                   result: match.result,
                   startedAt: match.startedAt,
                  endedAt: match.endedAt,
                  economy: serializeEconomy(match.economy),
                  resourceNodes: serializeResourceNodes(match.resourceNodes),
                  config: {
                    mapWidth: match.config.mapWidth,
                    mapHeight: match.config.mapHeight,
                    viewportWidth: match.config.viewportWidth,
                    viewportHeight: match.config.viewportHeight,
                  },
                  mapWidth: match.config.mapWidth,
                  mapHeight: match.config.mapHeight,
                },
              },
            };
            sendWS(ws, matchStartMsg);
          }
        }
        break;
      }

    case CLIENT_MSG.CREATE_LOBBY: {
        console.log("[Server] create_lobby received, username:", msg.payload.username);
        const { code, player } = lobbyManager.createLobby(msg.payload.username);
        console.log("[Server] lobby created, code:", code, "playerId:", player.id);

        playerId = player.id;
        playerLobbyMap.set(playerId, {
          playerId,
          code,
          ws,
        });

        broadcastLobbyState(ws, code);
        console.log("[Server] broadcastLobbyState sent");

        // Send the player's real ID back so client can identify itself
        sendWS(ws, { type: SERVER_EVT.CONNECTED, payload: { playerId: player.id } });
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

          // Update player sessions with matchId
          for (const p of result.lobby.players) {
            if (p) {
              const s = playerLobbyMap.get(p.id);
              if (s) s.matchId = match.id;
            }
          }

          // Notify both players of match start
          const allEntities = serializeEntities(match.entities);
          const matchStartMsg: ServerToClientMsg = {
            type: SERVER_EVT.MATCH_START,
            payload: {
              match: {
                id: match.id,
                lobbyCode: match.lobbyCode,
                phase: match.phase,
                tick: match.tick,
                tickIntervalMs: match.tickIntervalMs,
                players: match.players,
               entities: allEntities as any,
                   attackLog: match.attackLog,
                   result: match.result,
                   startedAt: match.startedAt,
                endedAt: match.endedAt,
                economy: serializeEconomy(match.economy),
                resourceNodes: serializeResourceNodes(match.resourceNodes),
                config: {
                  mapWidth: match.config.mapWidth,
                  mapHeight: match.config.mapHeight,
                  viewportWidth: match.config.viewportWidth,
                  viewportHeight: match.config.viewportHeight,
                },
                mapWidth: match.config.mapWidth,
                mapHeight: match.config.mapHeight,
              },
            },
          };
          for (const s of playerLobbyMap.values()) {
            if (s.code === session.code) {
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

        const allEntities = serializeEntities(match.entities);
        const matchStartMsg: ServerToClientMsg = {
          type: SERVER_EVT.MATCH_START,
          payload: {
            match: {
              id: match.id,
              lobbyCode: match.lobbyCode,
              phase: match.phase,
              tick: match.tick,
              tickIntervalMs: match.tickIntervalMs,
              players: match.players,
               entities: allEntities as any,
                   attackLog: match.attackLog,
                   result: match.result,
                   startedAt: match.startedAt,
              endedAt: match.endedAt,
              economy: serializeEconomy(match.economy),
              resourceNodes: serializeResourceNodes(match.resourceNodes),
              config: {
                mapWidth: match.config.mapWidth,
                mapHeight: match.config.mapHeight,
                viewportWidth: match.config.viewportWidth,
                viewportHeight: match.config.viewportHeight,
              },
              mapWidth: match.config.mapWidth,
              mapHeight: match.config.mapHeight,
            },
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
        console.log("[Server] GAME_COMMAND - playerId:", playerId, "type:", (msg.payload as unknown as Record<string, unknown>)?.type);
        if (!playerId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not connected." } });
          return;
        }
        const session = playerLobbyMap.get(playerId);
        console.log("[Server] GAME_COMMAND - session found:", !!session, "matchId:", session?.matchId, "playerId:", playerId);
        if (!session) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Not in a lobby." } });
          return;
        }

        const matchId = session.matchId;
        if (!matchId) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "No active match." } });
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
        };
        const result = matchEngine.processCommand(matchId, playerId, {
          type: cmd.type as "move" | "deselect" | "gather" | "train_worker" | "train_unit" | "build" | "assign_build" | "repair" | "attack" | "heal",
          entityId: cmd.entityId,
          entityIds: cmd.entityIds,
          targetX: cmd.targetX,
          targetY: cmd.targetY,
          targetEntityId: cmd.targetEntityId,
          buildingType: cmd.buildingType as "barracks" | "foundry" | "supply_depot" | "turret" | undefined,
          workerIds: cmd.workerIds,
        });

        if (!result.success) {
          sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: result.message ?? "Command rejected." } });
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

      default: {
        sendWS(ws, { type: SERVER_EVT.ERROR, payload: { message: "Unknown message type." } });
        break;
      }
    }
  });

  ws.on("close", () => {
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

// API routes
app.get("/api/lobbies", (_req: Request, res: Response) => {
  res.json({ lobbies: lobbyManager.getAllLobbies() });
});

app.get("/api/matches", (_req: Request, res: Response) => {
  res.json({ matches: matchEngine.getAllMatches() });
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

export { app, httpServer, lobbyManager, matchEngine };
