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
  resourceNodes: ResourceNodeDisplay[];
  createLobby: (username: string) => void;
  joinLobby: (code: string, username: string) => void;
  toggleReady: () => void;
  leaveLobby: () => void;
  debugWin: (winner: "player1" | "player2" | "self") => void;
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
  clearError: () => void;
}

export function useWebSocket(): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [lobbyState, setLobbyState] = useState<LobbyState | null>(null);
  const [matchState, setMatchState] = useState<MatchState | null>(null);
  const [matchEnd, setMatchEnd] = useState<{ winner: string } | null>(null);
  const [resourceNodes, setResourceNodes] = useState<ResourceNodeDisplay[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[useWebSocket] ws.onopen - connected");
      setConnected(true);
      setError(null);
    };

    ws.onerror = () => {
      console.log("[useWebSocket] ws.onerror");
      setError("Connection error.");
    };

    ws.onclose = (event) => {
      console.log("[useWebSocket] ws.onclose - code:", event.code, "reason:", event.reason, "wasClean:", event.wasClean);
      setConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        if (msg.type === "connected" && msg.payload?.playerId) {
          setPlayerId(msg.payload.playerId as string);
        }
        if (msg.type === "lobby_state" && msg.payload?.lobby) {
          console.log("[useWebSocket] lobby_state received, lobby:", JSON.stringify(msg.payload.lobby));
          setLobbyState(msg.payload.lobby as LobbyState);
        }
        if (msg.type === "error" && msg.payload?.message) {
          setError(msg.payload.message as string);
        }
        if (msg.type === "match_end" && msg.payload?.winner) {
          setMatchEnd({ winner: msg.payload.winner as string });
        }
        if (msg.type === "match_start" && msg.payload?.match) {
          const ms = msg.payload.match as MatchState;
          ms.attackLog = ms.attackLog ?? [];
          setMatchState(ms);
          setResourceNodes(
            ((msg.payload as unknown as Record<string, unknown>).match as Record<string, unknown>)?.resourceNodes
              ? (((msg.payload as unknown as Record<string, unknown>).match as Record<string, unknown>).resourceNodes as ResourceNodeDisplay[])
              : []
          );
        }
        if (msg.type === "game_state" && msg.payload?.match) {
          const ms = msg.payload.match as MatchState;
          ms.attackLog = ms.attackLog ?? [];
          setMatchState(ms);
          setResourceNodes(
            ((msg.payload as unknown as Record<string, unknown>).match as Record<string, unknown>)?.resourceNodes
              ? (((msg.payload as unknown as Record<string, unknown>).match as Record<string, unknown>).resourceNodes as ResourceNodeDisplay[])
              : []
          );
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
      console.warn("[useWebSocket] sendMessage failed - readyState:", wsRef.current?.readyState, "wsRef exists:", !!wsRef.current);
    }
  }, []);

  const createLobby = useCallback(
    (username: string) => {
      console.log("[useWebSocket] createLobby called, username:", username, "ws.readyState:", wsRef.current?.readyState);
      sendMessage({ type: "create_lobby", payload: { username } });
      console.log("[useWebSocket] createLobby sent");
    },
    [sendMessage]
  );

  const joinLobby = useCallback(
    (code: string, username: string) => {
      sendMessage({ type: "join_lobby", payload: { code: code.toUpperCase(), username } });
    },
    [sendMessage]
  );

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

  const sendGameCommand = useCallback(
    (command: {
      type: string;
      entityId?: string;
      targetX?: number;
      targetY?: number;
      targetEntityId?: string;
      buildingType?: BuildingType;
    }) => {
      console.log("[useWebSocket] sendGameCommand:", JSON.stringify(command), "wsReadyState:", wsRef.current?.readyState);
      sendMessage({ type: "game_command", payload: { ...command, tick: Date.now() } });
    },
    [sendMessage]
  );

  const clearMatchEnd = useCallback(() => {
    setMatchEnd(null);
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
    resourceNodes,
    createLobby,
    joinLobby,
    toggleReady,
    leaveLobby,
    debugWin,
    sendGameCommand,
    error,
    connected,
    clearMatchEnd,
    clearMatchState,
    clearError,
  };
}
