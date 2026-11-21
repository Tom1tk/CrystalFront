import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WSMessage,
  LobbyState,
  Player,
  MatchState,
  ResourceNodeDisplay,
  BuildingType,
  Ruleset,
} from "../types";
import type { TournamentPublicState, TournamentViewer } from "@crystalfront/shared";
import type { SpectateInfo } from "../components/Spectate";

export interface TournamentView { state: TournamentPublicState; viewer: TournamentViewer }
export interface TournamentMatchReady { code: string; round: number; slot: number; game: number; opponent: string; map: string; side: "blue" | "red"; deadline: number }
export interface TournamentMatchStart { code: string; round: number; slot: number; game: number }

const TOKEN_KEY = "cf.tournamentToken";
/** This browser's tournament identity: registers, readies up and (for its creator) manages. */
export function tournamentToken(): string {
  try {
    let t = window.localStorage.getItem(TOKEN_KEY);
    if (!t) { t = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""); window.localStorage.setItem(TOKEN_KEY, t); }
    return t;
  } catch {
    // Storage blocked: a per-page token (lost on reload).
    const w = window as unknown as { __cfToken?: string };
    w.__cfToken ??= [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return w.__cfToken;
  }
}

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = `${protocol}//${window.location.host}`;

interface UseWebSocketReturn {
  playerId: string | null;
  lobbyState: LobbyState | null;
  matchState: MatchState | null;
  matchEnd: { winner: string | null; winType?: string; replayId?: string } | null;
  /** Players who have finished loading the new match (while it waits to start). */
  loadedPlayers: string[];
  replayEnd: { ticks: number; winner: string | null } | null;
  spectate: SpectateInfo | null;
  clearSpectate: () => void;
  resourceNodes: ResourceNodeDisplay[];
  createLobby: (username: string, ruleset?: Ruleset) => void;
  joinLobby: (code: string, username: string) => void;
  startSoloTest: (username: string, mapId?: string, ruleset?: Ruleset) => void;
  startBotGame: (username: string, bot: string, mapId?: string, ruleset?: Ruleset) => void;
  setMap: (mapId: string) => void;
  /** Tell the server this client finished loading the match. */
  clientLoaded: () => void;
  startReplay: (replayId: string) => void;
  stopReplay: () => void;
  setReplaySpeed: (speed: number) => void;
  toggleReady: () => void;
  leaveLobby: () => void;
  debugWin: (winner: "player1" | "player2" | "self") => void;
  debugSpawn: (entityType: string, x: number, y: number, buildingType?: string) => void;
  sendGameCommand: (command: {
    type: string;
    entityId?: string;
    targetX?: number;
    targetY?: number;
    targetEntityId?: string;
    buildingType?: BuildingType;
  }) => void;
  error: string | null;
  connected: boolean;
  clearMatchEnd: () => void;
  clearMatchState: () => void;
  clearReplayEnd: () => void;
  clearError: () => void;
  tournament: TournamentView | null;
  tournamentError: string | null;
  tournamentReady: TournamentMatchReady | null;
  tournamentStart: TournamentMatchStart | null;
  /** Watch a tournament (null = stop); the connection then reconnects by itself if it drops. */
  watchTournament: (code: string | null) => void;
  /** Send a tournament message; `code` and this browser's token are added. */
  tournamentSend: (type: string, payload?: Record<string, unknown>) => void;
  /** Enter (or re-enter) this player's live tournament game; kept across reconnects until `false`. */
  playTournament: (on: boolean) => void;
  clearTournamentStart: () => void;
}

export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [lobbyState, setLobbyState] = useState<LobbyState | null>(null);
  const [matchState, setMatchState] = useState<MatchState | null>(null);
  const staticMapRef = useRef<MatchState["staticMap"]>(undefined);
  const [matchEnd, setMatchEnd] = useState<{ winner: string | null; winType?: string; replayId?: string } | null>(null);
  const [replayEnd, setReplayEnd] = useState<{ ticks: number; winner: string | null } | null>(null);
  /** Set by a match_start from a tournament spectator feed. */
  const [spectate, setSpectate] = useState<SpectateInfo | null>(null);
  const [resourceNodes, setResourceNodes] = useState<ResourceNodeDisplay[]>([]);
  const [loadedPlayers, setLoadedPlayers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [tournament, setTournament] = useState<TournamentView | null>(null);
  const [tournamentError, setTournamentError] = useState<string | null>(null);
  const [tournamentReady, setTournamentReady] = useState<TournamentMatchReady | null>(null);
  const [tournamentStart, setTournamentStart] = useState<TournamentMatchStart | null>(null);
  const tWatchRef = useRef<string | null>(null);
  const tPlayRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
      const code = tWatchRef.current;
      if (code) {
        ws.send(JSON.stringify({ type: "tournament_watch", payload: { code, token: tournamentToken() } }));
        if (tPlayRef.current) ws.send(JSON.stringify({ type: "tournament_play", payload: { code, token: tournamentToken() } }));
      }
    };

    ws.onerror = () => {
      setError("Connection error.");
      setTimeout(() => setError(null), 4000);
    };

    ws.onclose = () => {
      setConnected(false);
      // Only tournament pages reconnect: a tournament seat survives a short drop (60 s grace).
      if (!disposed && tWatchRef.current) retry = setTimeout(connect, 2000);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        if (msg.type === "connected" && msg.payload?.playerId) {
          setPlayerId(msg.payload.playerId as string);
        }
        if (msg.type === "lobby_state" && msg.payload?.lobby) {
          setLobbyState(msg.payload.lobby as LobbyState);
        }
        if (msg.type === "error" && msg.payload?.message) {
          setError(msg.payload.message as string);
          // Auto-clear after 4 seconds
          setTimeout(() => setError(null), 4000);
        }
        if (msg.type === "match_end" && (msg.payload?.winner || msg.payload?.winType === "draw")) {
          setMatchEnd({ winner: (msg.payload.winner as string | null) ?? null, winType: msg.payload.winType as string | undefined, replayId: msg.payload.replayId as string | undefined });
        }
        if (msg.type === "match_start" && msg.payload?.match) {
          const ms = msg.payload.match as MatchState;
          ms.attackLog = ms.attackLog ?? [];
          staticMapRef.current = ms.staticMap;
          setSpectate((msg.payload.spectate as SpectateInfo | undefined) ?? null);
          setLoadedPlayers([]);
          setMatchState(ms);
          setResourceNodes(ms.resourceNodes ?? []);
        }
        if (msg.type === "game_state" && msg.payload?.match) {
          const ms = msg.payload.match as MatchState;
          ms.attackLog = ms.attackLog ?? [];
          // Static map arrives once with match_start; carry it on every state (G-5).
          if (ms.staticMap) staticMapRef.current = ms.staticMap;
          else ms.staticMap = staticMapRef.current;
          setMatchState(ms);
          setResourceNodes(ms.resourceNodes ?? []);
        }
        if (msg.type === "load_status" && Array.isArray(msg.payload?.loaded)) {
          setLoadedPlayers(msg.payload.loaded as string[]);
        }
        if (msg.type === "tournament_state" && msg.payload?.state) {
          const view = msg.payload as unknown as TournamentView;
          tWatchRef.current ??= view.state.code;
          setTournament(view);
        }
        if (msg.type === "tournament_error" && msg.payload?.message) {
          setTournamentError(msg.payload.message as string);
          setTimeout(() => setTournamentError(null), 5000);
        }
        if (msg.type === "tournament_match_ready" && msg.payload) {
          setTournamentReady(msg.payload as unknown as TournamentMatchReady);
        }
        if (msg.type === "tournament_match_start" && msg.payload) {
          setTournamentStart(msg.payload as unknown as TournamentMatchStart);
        }
        if (msg.type === "replay_end") {
          setReplayEnd(msg.payload as { ticks: number; winner: string | null });
          setMatchState(null);
          setResourceNodes([]);
        }
      } catch {
        // ignore parse errors
      }
    };

    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const sendMessage = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      // silently fail if not connected
    }
  }, []);

  const createLobby = useCallback(
    (username: string, ruleset?: Ruleset) => {
      sendMessage({ type: "create_lobby", payload: { username, ruleset } });
    },
    [sendMessage]
  );

  const joinLobby = useCallback(
    (code: string, username: string) => {
      sendMessage({ type: "join_lobby", payload: { code: code.toUpperCase(), username } });
    },
    [sendMessage]
  );

  const startSoloTest = useCallback(
    (username: string, mapId?: string, ruleset?: Ruleset) => {
      sendMessage({ type: "start_solo_test", payload: { username, mapId, ruleset } });
    },
    [sendMessage]
  );

  const startBotGame = useCallback(
    (username: string, bot: string, mapId?: string, ruleset?: Ruleset) => {
      sendMessage({ type: "start_bot_game", payload: { username, bot, mapId, ruleset } });
    },
    [sendMessage]
  );

  const setMap = useCallback(
    (mapId: string) => {
      sendMessage({ type: "set_map", payload: { mapId } });
    },
    [sendMessage]
  );

  const clientLoaded = useCallback(() => {
    sendMessage({ type: "client_loaded" });
  }, [sendMessage]);

  const startReplay = useCallback(
    (replayId: string) => {
      sendMessage({ type: "start_replay", payload: { replayId } });
    },
    [sendMessage]
  );

  const clearSpectate = useCallback(() => setSpectate(null), []);

  const stopReplay = useCallback(() => {
    sendMessage({ type: "stop_replay" });
  }, [sendMessage]);

  const setReplaySpeed = useCallback((speed: number) => {
    sendMessage({ type: "replay_speed", payload: { speed } });
  }, [sendMessage]);

  const toggleReady = useCallback(() => {
    sendMessage({ type: "ready_toggle" });
  }, [sendMessage]);

  const leaveLobby = useCallback(() => {
    sendMessage({ type: "leave_lobby" });
  }, [sendMessage]);

  const debugWin = useCallback(
    (winner: "player1" | "player2" | "self") => {
      sendMessage({ type: "debug_win", payload: { winner } });
    },
    [sendMessage]
  );

  const debugSpawn = useCallback(
    (entityType: string, x: number, y: number, buildingType?: string) => {
      sendMessage({ type: "debug_spawn", payload: { entityType, x, y, buildingType } });
    },
    [sendMessage]
  );

  const sendGameCommand = useCallback(
    (command: {
      type: string;
      entityId?: string;
      targetX?: number;
      targetY?: number;
      targetEntityId?: string;
      buildingType?: BuildingType;
    }) => {
      sendMessage({ type: "game_command", payload: { ...command, tick: Date.now() } });
    },
    [sendMessage]
  );

  const clearMatchEnd = useCallback(() => {
    setMatchEnd(null);
  }, []);

  const clearReplayEnd = useCallback(() => {
    setReplayEnd(null);
  }, []);

  const clearMatchState = useCallback(() => {
    setMatchState(null);
    setResourceNodes([]);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const watchTournament = useCallback((code: string | null) => {
    if (tWatchRef.current && tWatchRef.current !== code) sendMessage({ type: "tournament_unwatch" });
    tWatchRef.current = code;
    setTournament(null);
    setTournamentReady(null);
    if (code) sendMessage({ type: "tournament_watch", payload: { code, token: tournamentToken() } });
  }, [sendMessage]);

  const tournamentSend = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    sendMessage({ type, payload: { code: tWatchRef.current ?? undefined, ...payload, token: tournamentToken() } });
  }, [sendMessage]);

  const playTournament = useCallback((on: boolean) => {
    tPlayRef.current = on;
    if (on && tWatchRef.current) sendMessage({ type: "tournament_play", payload: { code: tWatchRef.current, token: tournamentToken() } });
  }, [sendMessage]);

  const clearTournamentStart = useCallback(() => setTournamentStart(null), []);

  return {
    playerId,
    lobbyState,
    matchState,
    matchEnd,
    loadedPlayers,
    replayEnd,
    spectate,
    clearSpectate,
    resourceNodes,
    createLobby,
    joinLobby,
    startSoloTest,
    startBotGame,
    setMap,
    clientLoaded,
    startReplay,
    stopReplay,
    setReplaySpeed,
    toggleReady,
    leaveLobby,
    debugWin,
    debugSpawn,
    sendGameCommand,
    error,
    connected,
    clearMatchEnd,
    clearMatchState,
    clearReplayEnd,
    clearError,
    tournament,
    tournamentError,
    tournamentReady,
    tournamentStart,
    watchTournament,
    tournamentSend,
    playTournament,
    clearTournamentStart,
  };
}
