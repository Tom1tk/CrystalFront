import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import MainMenu from "./components/MainMenu";
import BotSelectMenu from "./components/BotSelectMenu";
import LobbyScreen from "./components/LobbyScreen";
import GameShell from "./components/GameShell";
import MatchEndScreen from "./components/MatchEndScreen";
import ReplayBrowser from "./components/ReplayBrowser";
import type { Screen, Player, MatchState } from "./types";
import { FCT } from "./design/facet";

function useScreenFlow() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [isHost, setIsHost] = useState(false);
  const [botSelectUsername, setBotSelectUsername] = useState("");
  const [replayTotalTicks, setReplayTotalTicks] = useState<number | undefined>(undefined);
  const hasLobbyStateRef = useRef(false);

  // Replay playback state
  const replayBufferRef = useRef<MatchState[]>([]);
  const [replayFrame, setReplayFrame]       = useState(0);
  const [playbackSpeed, setPlaybackSpeed]   = useState<number>(1);
  const replayDoneRef = useRef(false);

  const ws = useWebSocket();

  // Transition to lobby when lobby data arrives (using ref to avoid unstable ws dependency)
  useEffect(() => {
    if (ws.lobbyState && !hasLobbyStateRef.current) {
      hasLobbyStateRef.current = true;
      setScreen("lobby");
    }
  }, [ws.lobbyState]);

  // Transition to game when match starts, back to matchEnd when ended
  useEffect(() => {
    if (screen === "matchEnd") return;
    if (screen === "menu") return;
    if (screen === "replays") return;
    if (screen === "watching_replay") return;
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

  // Transition to watching_replay when replay starts (MATCH_START from replay runner)
  useEffect(() => {
    if (ws.matchState && ws.matchState.phase === "playing" && screen === "replays") {
      setScreen("watching_replay");
    }
  }, [ws.matchState, screen]);

  // Buffer incoming frames during replay
  useEffect(() => {
    if (screen !== "watching_replay") return;
    if (!ws.matchState) return;
    replayBufferRef.current.push(ws.matchState);
  }, [ws.matchState, screen]);

  // Playback interval — advances or rewinds the frame pointer
  useEffect(() => {
    if (screen !== "watching_replay" || playbackSpeed === 0) return;
    const dir = playbackSpeed > 0 ? 1 : -1;
    const absSpeed = Math.abs(playbackSpeed);
    const id = setInterval(() => {
      setReplayFrame(f => Math.max(0, Math.min(f + dir * absSpeed, replayBufferRef.current.length - 1)));
    }, 100);
    return () => clearInterval(id);
  }, [screen, playbackSpeed]);

  // Sync server speed with forward playback speed (server doesn't do reverse)
  useEffect(() => {
    if (screen !== "watching_replay") return;
    ws.setReplaySpeed(playbackSpeed < 0 ? 0 : playbackSpeed);
  }, [playbackSpeed, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // When server finishes, pause and let user rewind freely
  useEffect(() => {
    if (ws.replayEnd && screen === "watching_replay") {
      ws.clearReplayEnd();
      replayDoneRef.current = true;
      setPlaybackSpeed(0);
    }
  }, [ws.replayEnd, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleHost = useCallback(
    (name: string) => {
      ws.createLobby(name);
      setIsHost(true);
    },
    [ws.createLobby]
  );

  const handleJoin = useCallback(
    (code: string, name: string) => {
      ws.joinLobby(code, name);
      setIsHost(false);
    },
    [ws.joinLobby]
  );

  const handleSoloTest = useCallback(
    (name: string) => {
      ws.startSoloTest(name);
      setIsHost(true);
    },
    [ws.startSoloTest]
  );

  const handleBotGame = useCallback(
    (name: string, bot: string) => {
      ws.startBotGame(name, bot);
      setIsHost(true);
    },
    [ws.startBotGame]
  );

  const handleShowBotSelect = useCallback(
    (name: string) => {
      setBotSelectUsername(name);
      setScreen("bot_select");
    },
    []
  );

  const handleBotSelectBack = useCallback(() => {
    setScreen("menu");
  }, []);

  const handleOpenReplays = useCallback(() => {
    setScreen("replays");
  }, []);

  const handleWatchReplay = useCallback(
    (replayId: string, totalTicks: number, _version?: string) => {
      replayBufferRef.current = [];
      setReplayFrame(0);
      setPlaybackSpeed(1);
      replayDoneRef.current = false;
      setReplayTotalTicks(totalTicks);
      ws.startReplay(replayId);
    },
    [ws.startReplay]
  );

  const handleStopReplay = useCallback(() => {
    ws.stopReplay();
    ws.clearMatchState();
    replayBufferRef.current = [];
    setReplayFrame(0);
    setPlaybackSpeed(1);
    replayDoneRef.current = false;
    setScreen("replays");
  }, [ws.stopReplay, ws.clearMatchState]);

  const handleBackFromReplays = useCallback(() => {
    setScreen("menu");
  }, []);

  const handleLeave = useCallback(() => {
    ws.leaveLobby();
    setScreen("menu");
  }, [ws.leaveLobby]);

  const handleRematch = useCallback(() => {
    ws.clearMatchEnd();
    ws.clearMatchState();
    setScreen("lobby");
  }, [ws.clearMatchEnd, ws.clearMatchState]);

  const handleExit = useCallback(() => {
    ws.clearMatchEnd();
    ws.clearMatchState();
    ws.leaveLobby();
    setScreen("menu");
  }, [ws.clearMatchEnd, ws.clearMatchState, ws.leaveLobby]);

  const handleDebugWin = useCallback(
    (_player: "player1" | "player2") => {
      ws.debugWin("self");
    },
    [ws.debugWin]
  );

  const handleDebugSpawn = useCallback(
    (entityType: string, x: number, y: number, buildingType?: string) => {
      ws.debugSpawn(entityType, x, y, buildingType);
    },
    [ws.debugSpawn]
  );

  const handleGameCommand = useCallback(
    (command: { type: string; entityId?: string; targetX?: number; targetY?: number; targetEntityId?: string; buildingType?: string }) => {
      ws.sendGameCommand(command as never);
    },
    [ws.sendGameCommand]
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

  const displayMatchState = screen === "watching_replay"
    ? (replayBufferRef.current[replayFrame] ?? ws.matchState)
    : ws.matchState;

  return {
    screen,
    setScreen,
    isHost,
    ws,
    matchState: ws.matchState,
    displayMatchState,
    matchWinnerId: ws.matchEnd?.winner ?? ws.matchState?.result?.winner ?? null,
    getCurrentPlayer,
    getCurrentLobby,
    handleHost,
    handleJoin,
    handleSoloTest,
    handleOpenReplays,
    handleWatchReplay,
    handleStopReplay,
    handleBackFromReplays,
    replayTotalTicks,
    replayBufferRef,
    replayFrame,
    setReplayFrame,
    playbackSpeed,
    setPlaybackSpeed,
    handleLeave,
    handleRematch,
    handleExit,
    handleDebugWin,
    handleDebugSpawn,
    handleGameCommand,
    handleBotGame,
    handleShowBotSelect,
    handleBotSelectBack,
    botSelectUsername,
  };
}

export default function App() {
  const {
    screen,
    isHost,
    ws,
    matchState,
    displayMatchState,
    matchWinnerId,
    getCurrentPlayer,
    getCurrentLobby,
    handleHost,
    handleJoin,
    handleSoloTest,
    handleOpenReplays,
    handleWatchReplay,
    handleStopReplay,
    handleBackFromReplays,
    replayTotalTicks,
    replayBufferRef,
    replayFrame,
    setReplayFrame,
    playbackSpeed,
    setPlaybackSpeed,
    handleLeave,
    handleRematch,
    handleExit,
    handleDebugWin,
    handleDebugSpawn,
    handleGameCommand,
    handleBotGame,
    handleShowBotSelect,
    handleBotSelectBack,
    botSelectUsername,
  } = useScreenFlow();

  const player = getCurrentPlayer();
  const lobby = getCurrentLobby();

  return (
    <div style={styles.container}>
      {screen === "menu" && (
        <MainMenu onHost={handleHost} onJoin={handleJoin} onSoloTest={handleSoloTest} onBotGame={handleBotGame} onBotSelect={handleShowBotSelect} onReplays={handleOpenReplays} />
      )}
      {screen === "bot_select" && (
        <BotSelectMenu
          username={botSelectUsername}
          onSelect={(bot) => handleBotGame(botSelectUsername, bot)}
          onBack={handleBotSelectBack}
        />
      )}
      {screen === "replays" && (
        <ReplayBrowser onBack={handleBackFromReplays} onWatch={handleWatchReplay} />
      )}
      {screen === "watching_replay" && displayMatchState && (
        <GameShell
          lobby={{ code: "REPLAY", players: [null, null], status: "match", hostId: "" }}
          player={{ id: "__observer__", username: "Replay", color: "blue", ready: false, score: 0 }}
          matchState={displayMatchState}
          resourceNodes={displayMatchState.resourceNodes ?? ws.resourceNodes}
          onDebugWin={handleDebugWin}
          onDebugSpawn={handleDebugSpawn}
          onGameCommand={handleGameCommand}
          error={ws.error}
          onClearError={ws.clearError}
          isReplay
          onStopReplay={handleStopReplay}
          replayTotalTicks={replayTotalTicks}
          playbackSpeed={playbackSpeed}
          onSetPlaybackSpeed={setPlaybackSpeed}
          replayFrame={replayFrame}
          replayBufferSize={replayBufferRef.current.length}
          onSeekReplay={setReplayFrame}
        />
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
          onDebugSpawn={handleDebugSpawn}
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
    background: FCT.bg,
  },
};
