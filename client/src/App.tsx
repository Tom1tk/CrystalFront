import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket } from "./hooks/useWebSocket";
import MainMenu from "./components/MainMenu";
import LobbyScreen from "./components/LobbyScreen";
import GameShell, { initialView3d, saveView3d } from "./components/GameShell";
import MatchEndScreen from "./components/MatchEndScreen";
import ReplayBrowser from "./components/ReplayBrowser";
import type { Screen, Player, MatchState } from "./types";
import MenuBackdrop from "./components/MenuBackdrop";
import BootScreen from "./components/BootScreen";
import SettingsModal from "./components/SettingsModal";
import { fetchMaps, type MapInfo } from "./components/MapPicker";
import { SoundToggle, IconBtn, setAccent } from "./design/glass";
import { setMusic } from "./audio";
import { themeFor } from "./mapThemes";

function useScreenFlow() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [isHost, setIsHost] = useState(false);
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
    if (ws.matchState && (ws.matchState.phase === "spawn" || ws.matchState.phase === "playing")) {
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
    (name: string, mapId?: string) => {
      ws.startSoloTest(name, mapId);
      setIsHost(true);
    },
    [ws.startSoloTest]
  );

  const handleBotGame = useCallback(
    (name: string, bot: string, mapId?: string) => {
      ws.startBotGame(name, bot, mapId);
      setIsHost(true);
    },
    [ws.startBotGame]
  );

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
    (command: { type: string; entityId?: string; targetX?: number; targetY?: number; targetEntityId?: string; buildingType?: string; queued?: boolean }) => {
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
  } = useScreenFlow();

  const player = getCurrentPlayer();
  const lobby = getCurrentLobby();

  // ─── G-12: boot screen, live 3D backdrop, music, settings ─────
  const [view3d, setView3d] = useState(initialView3d);
  const [maps, setMaps] = useState<MapInfo[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [backdropReady, setBackdropReady] = useState(false);
  const [bootDone, setBootDone] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    void fetchMaps().then((list) => {
      setMaps(list);
      const pool = list.filter((m) => m.pool);
      const from = pool.length ? pool : list;
      const pick = from[Math.floor(Math.random() * from.length)];
      if (pick) setPreviewId(pick.mapId);
      else setBackdropReady(true);
    });
  }, []);
  // The boot screen stays at least 0.8 s (no flash) and at most 8 s (slow GPU or network).
  useEffect(() => {
    const t = setTimeout(() => setBootDone(true), backdropReady ? Math.max(0, 800 - performance.now()) : 8000);
    return () => clearTimeout(t);
  }, [backdropReady]);
  const menuScreen = screen === "menu" || screen === "replays" || screen === "lobby";
  const inMatch = screen === "game" || screen === "watching_replay";
  const backdropId = screen === "lobby" && lobby?.mapId && lobby.mapId !== "random" ? lobby.mapId : previewId;
  const backdropMap = maps.find((m) => m.mapId === backdropId) ?? null;
  useEffect(() => { setAccent(themeFor(backdropMap?.mapId).id); }, [backdropMap?.mapId]);
  useEffect(() => { setMusic(inMatch ? "match" : "menu"); }, [inMatch]);
  const changeView3d = (v: boolean) => { setView3d(v); saveView3d(v); };

  return (
    <div style={styles.container}>
      <BootScreen done={bootDone} status={backdropReady ? "Ready" : "Loading battlefield"} />
      {!inMatch && screen !== "matchEnd" && (
        <MenuBackdrop map={backdropMap} use3d={view3d} onReady={() => setBackdropReady(true)} />
      )}
      {!inMatch && (
        <div className="g-corner">
          <SoundToggle />
          {menuScreen && bootDone && <IconBtn icon="gear" title="Settings" onClick={() => setSettingsOpen(true)} />}
        </div>
      )}
      {settingsOpen && !inMatch && (
        <SettingsModal onClose={() => setSettingsOpen(false)} view3d={view3d} onView3d={changeView3d} />
      )}
      {screen === "menu" && (
        <MainMenu onHost={handleHost} onJoin={handleJoin} onSoloTest={handleSoloTest} onBotGame={handleBotGame}
          onReplays={handleOpenReplays} onSettings={() => setSettingsOpen(true)}
          onPreviewMap={(id) => { if (id !== "random") setPreviewId(id); }} error={ws.error} />
      )}
      {screen === "replays" && (
        <ReplayBrowser onBack={handleBackFromReplays} onWatch={handleWatchReplay} />
      )}
      {screen === "watching_replay" && displayMatchState && (
        <GameShell
          lobby={{ code: "REPLAY", players: [null, null], status: "match", hostId: "", mapId: "" }}
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
          onSetMap={ws.setMap}
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
          onLoaded={ws.clientLoaded}
        />
      )}
      {screen === "matchEnd" && lobby && player && matchWinnerId && (
        <MatchEndScreen
          lobby={lobby}
          player={player}
          winnerId={matchWinnerId}
          winType={ws.matchEnd?.winType ?? ws.matchState?.result?.winType}
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
    background: "#05060a",
    position: "relative" as const,
    overflow: "hidden",
  },
};
