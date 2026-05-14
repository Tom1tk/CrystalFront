import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WSMessage,
  LobbyState,
  Player,
  MatchState,
  ResourceNodeDisplay,
  BuildingType,
} from "../types";

const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = `${protocol}//${window.location.host}`;

interface UseWebSocketReturn {
  playerId: string | null;
  lobbyState: LobbyState | null;
  matchState: MatchState | null;
  matchEnd: { winner: string } | null;
  replayEnd: { ticks: number; winner: string | null } | null;
  resourceNodes: ResourceNodeDisplay[];
  createLobby: (username: string) => void;
  joinLobby: (code: string, username: string) => void;
  startSoloTest: (username: string) => void;
  startReplay: (replayId: string) => void;
  stopReplay: () => void;
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
}

export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [lobbyState, setLobbyState] = useState<LobbyState | null>(null);
  const [matchState, setMatchState] = useState<MatchState | null>(null);
  const [matchEnd, setMatchEnd] = useState<{ winner: string } | null>(null);
  const [replayEnd, setReplayEnd] = useState<{ ticks: number; winner: string | null } | null>(null);
  const [resourceNodes, setResourceNodes] = useState<ResourceNodeDisplay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onerror = () => {
      setError("Connection error.");
      setTimeout(() => setError(null), 4000);
    };

    ws.onclose = (event) => {
      setConnected(false);
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
        if (msg.type === "match_end" && msg.payload?.winner) {
          setMatchEnd({ winner: msg.payload.winner as string });
        }
        if (msg.type === "match_start" && msg.payload?.match) {
          const ms = msg.payload.match as MatchState;
          ms.attackLog = ms.attackLog ?? [];
          setMatchState(ms);
          setResourceNodes(ms.resourceNodes ?? []);
        }
        if (msg.type === "game_state" && msg.payload?.match) {
          const ms = msg.payload.match as MatchState;
          ms.attackLog = ms.attackLog ?? [];
          setMatchState(ms);
          setResourceNodes(ms.resourceNodes ?? []);
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

    return () => {
      ws.close();
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
    (username: string) => {
      sendMessage({ type: "create_lobby", payload: { username } });
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
    (username: string) => {
      sendMessage({ type: "start_solo_test", payload: { username } });
    },
    [sendMessage]
  );

  const startReplay = useCallback(
    (replayId: string) => {
      sendMessage({ type: "start_replay", payload: { replayId } });
    },
    [sendMessage]
  );

  const stopReplay = useCallback(() => {
    sendMessage({ type: "stop_replay" });
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

  return {
    playerId,
    lobbyState,
    matchState,
    matchEnd,
    replayEnd,
    resourceNodes,
    createLobby,
    joinLobby,
    startSoloTest,
    startReplay,
    stopReplay,
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
  };
}
