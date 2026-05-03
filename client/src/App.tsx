import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import MainMenu from "./components/MainMenu";
import LobbyScreen from "./components/LobbyScreen";
import GameShell from "./components/GameShell";
import MatchEndScreen from "./components/MatchEndScreen";
import type { Screen, Player } from "./types";

function useScreenFlow() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [isHost, setIsHost] = useState(false);
  const hasLobbyStateRef = useRef(false);

  const ws = useWebSocket();

  // Transition to lobby when lobby data arrives (using ref to avoid unstable ws dependency)
  useEffect(() => {
    console.log("[App] lobbyState change:", !!ws.lobbyState, "hasLobbyStateRef:", hasLobbyStateRef.current, "screen:", screen);
    if (ws.lobbyState && !hasLobbyStateRef.current) {
      hasLobbyStateRef.current = true;
      console.log("[App] transitioning to lobby");
      setScreen("lobby");
    }
  }, [ws.lobbyState]);

  // Transition to game when match starts, back to matchEnd when ended
  useEffect(() => {
    if (screen === "matchEnd") return;
    // Don't override menu transitions
    if (screen === "menu") return;
    // Transition to game when match starts
    if (ws.matchState && ws.matchState.phase === "playing") {
      setScreen("game");
      return;
    }
    // Transition to match end when match ends (MATCH_END event will populate winner)
    if (screen === "game" && ws.matchState && ws.matchState.phase === "ended") {
      setScreen("matchEnd");
      return;
    }
  }, [ws.matchState, screen]);

  // Transition to match end when match_end received
  useEffect(() => {
    if (ws.matchEnd) {
      setScreen("matchEnd");
    }
  }, [ws.matchEnd]);

  const handleHost = useCallback(
    (name: string) => {
      console.log("[App] handleHost called, name:", name, "ws.connected:", ws.connected);
      ws.createLobby(name);
      setIsHost(true);
      console.log("[App] setIsHost(true) called");
    },
    [ws]
  );

  const handleJoin = useCallback(
    (code: string, name: string) => {
      ws.joinLobby(code, name);
      setIsHost(false);
    },
    [ws]
  );

  const handleLeave = useCallback(() => {
    ws.leaveLobby();
    setScreen("menu");
  }, [ws]);

  const handleRematch = useCallback(() => {
    ws.clearMatchEnd();
    ws.clearMatchState();
    setScreen("lobby");
  }, [ws]);

  const handleExit = useCallback(() => {
    ws.clearMatchEnd();
    ws.clearMatchState();
    ws.leaveLobby();
    setScreen("menu");
  }, [ws]);

  const handleDebugWin = useCallback(
    (_player: "player1" | "player2") => {
      ws.debugWin("self");
    },
    [ws]
  );

  const handleGameCommand = useCallback(
    (command: { type: string; entityId?: string; targetX?: number; targetY?: number; targetEntityId?: string; buildingType?: string }) => {
      console.log("[App] handleGameCommand:", JSON.stringify(command), "playerId:", ws.playerId);
      ws.sendGameCommand(command as never);
    },
    [ws]
  );

  const getCurrentPlayer = (): Player | null => {
    if (!ws.lobbyState || !ws.playerId) return null;
    for (const lobby of Object.values(ws.lobbyState.lobbies)) {
      for (const p of lobby.players) {
        if (p?.id === ws.playerId) return p;
      }
    }
    return null;
  };

  const getCurrentLobby = () => {
    if (!ws.lobbyState) return null;
    for (const lobby of Object.values(ws.lobbyState.lobbies)) {
      for (const p of lobby.players) {
        if (p?.id === ws.playerId) return lobby;
      }
    }
    return null;
  };

  return {
    screen,
    isHost,
    ws,
    matchState: ws.matchState,
    matchWinnerId: ws.matchEnd?.winner ?? ws.matchState?.result?.winner ?? null,
    getCurrentPlayer,
    getCurrentLobby,
    handleHost,
    handleJoin,
    handleLeave,
    handleRematch,
    handleExit,
    handleDebugWin,
    handleGameCommand,
  };
}

export default function App() {
  const {
    screen,
    isHost,
    ws,
    matchState,
    matchWinnerId,
    getCurrentPlayer,
    getCurrentLobby,
    handleHost,
    handleJoin,
    handleLeave,
    handleRematch,
    handleExit,
    handleDebugWin,
    handleGameCommand,
  } = useScreenFlow();

  const player = getCurrentPlayer();
  const lobby = getCurrentLobby();

  return (
    <div style={styles.container}>
      {screen === "menu" && (
        <MainMenu onHost={handleHost} onJoin={handleJoin} />
      )}
      {screen === "lobby" && lobby && player && (
        <LobbyScreen
          lobby={lobby}
          player={player}
          isHost={isHost}
          onReady={ws.toggleReady}
          onLeave={handleLeave}
          error={ws.error}
        />
      )}
      {screen === "game" && lobby && player && (
        <GameShell
          lobby={lobby}
          player={player}
          matchState={matchState}
          resourceNodes={ws.resourceNodes}
          onDebugWin={handleDebugWin}
          onGameCommand={handleGameCommand}
          error={ws.error}
          onClearError={ws.clearError}
        />
      )}
      {screen === "matchEnd" && lobby && player && matchWinnerId && (
        <MatchEndScreen
          lobby={lobby}
          player={player}
          winnerId={matchWinnerId}
          onRematch={handleRematch}
          onExit={handleExit}
        />
      )}
    </div>
  );
}

const styles = {
  container: {
    width: "100vw",
    height: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #0a0a1a 0%, #1a1a3a 100%)",
  },
};
