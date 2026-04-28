import type { Lobby, Player } from "../types";

interface LobbyScreenProps {
  lobby: Lobby;
  player: Player;
  isHost: boolean;
  onReady: () => void;
  onLeave: () => void;
  error: string | null;
}

export default function LobbyScreen({
  lobby,
  player,
  isHost,
  onReady,
  onLeave,
  error,
}: LobbyScreenProps) {
  const bothReady = lobby.players[0]?.ready && lobby.players[1]?.ready;
  const opponent = lobby.players[0]?.id === player.id ? lobby.players[1] : lobby.players[0];

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h2 style={styles.title}>Lobby</h2>

        <div style={styles.codeBox}>
          <span style={styles.codeLabel}>Lobby Code</span>
          <span style={styles.codeValue}>{lobby.code}</span>
        </div>

        <div style={styles.playersSection}>
          <div style={styles.playerRow}>
            <span style={styles.playerInfo}>
              <span style={{ ...styles.colorDot, background: player.color === "blue" ? "#4488ff" : "#ff4444" }} />
              {player.username} {player.id === lobby.hostId && "(Host)"}
            </span>
            <span style={styles.readyBadge(player.ready)}>
              {player.ready ? "READY" : "NOT READY"}
            </span>
            <span style={styles.score}>Score: {player.score}</span>
          </div>

          <div style={styles.playerRow}>
            {opponent ? (
              <>
                <span style={styles.playerInfo}>
                  <span style={{ ...styles.colorDot, background: opponent.color === "blue" ? "#4488ff" : "#ff4444" }} />
                  {opponent.username}
                </span>
                <span style={styles.readyBadge(opponent.ready)}>
                  {opponent.ready ? "READY" : "NOT READY"}
                </span>
                <span style={styles.score}>Score: {opponent.score}</span>
              </>
            ) : (
              <span style={styles.waiting}>Waiting for opponent...</span>
            )}
          </div>
        </div>

        {error && <p style={styles.error}>{error}</p>}

        <div style={styles.buttonGroup}>
          <button
            style={bothReady ? styles.disabledButton : styles.primaryButton}
            onClick={onReady}
            disabled={bothReady}
          >
            {player.ready ? "Unready" : "Ready Up"}
          </button>
          <button style={styles.dangerButton} onClick={onLeave}>
            Leave Lobby
          </button>
        </div>

        {bothReady && (
          <p style={styles.bothReady}>Both players ready! Starting match...</p>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
  },
  card: {
    background: "rgba(20, 20, 40, 0.9)",
    border: "1px solid rgba(100, 100, 200, 0.3)",
    borderRadius: "12px",
    padding: "32px",
    width: "480px",
    maxWidth: "90vw",
    textAlign: "center" as const,
  },
  title: {
    fontSize: "24px",
    fontWeight: 600,
    color: "#8888ff",
    marginBottom: "16px",
  },
  codeBox: {
    background: "rgba(0, 0, 0, 0.3)",
    borderRadius: "8px",
    padding: "12px",
    marginBottom: "20px",
  },
  codeLabel: {
    display: "block",
    fontSize: "11px",
    color: "#888",
    textTransform: "uppercase" as const,
    letterSpacing: "1px",
  },
  codeValue: {
    display: "block",
    fontSize: "28px",
    fontWeight: 700,
    color: "#ffffff",
    letterSpacing: "6px",
    marginTop: "4px",
  },
  playersSection: {
    marginBottom: "20px",
  },
  playerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px",
    background: "rgba(0, 0, 0, 0.2)",
    borderRadius: "6px",
    marginBottom: "6px",
  },
  playerInfo: {
    fontSize: "14px",
    color: "#e0e0e0",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  colorDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    display: "inline-block",
  },
  readyBadge: (ready: boolean) => ({
    padding: "2px 10px",
    fontSize: "11px",
    fontWeight: 600,
    borderRadius: "4px",
    background: ready ? "rgba(68, 204, 68, 0.2)" : "rgba(200, 200, 200, 0.1)",
    color: ready ? "#44cc44" : "#888",
    textTransform: "uppercase" as const,
  }),
  score: {
    fontSize: "12px",
    color: "#888",
    marginLeft: "12px",
  },
  waiting: {
    fontSize: "13px",
    color: "#666",
    fontStyle: "italic",
  },
  error: {
    color: "#ff6666",
    fontSize: "13px",
    marginBottom: "12px",
  },
  buttonGroup: {
    display: "flex",
    gap: "8px",
  },
  primaryButton: {
    flex: 1,
    padding: "10px 16px",
    fontSize: "14px",
    fontWeight: 600,
    background: "#4444cc",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  },
  disabledButton: {
    flex: 1,
    padding: "10px 16px",
    fontSize: "14px",
    fontWeight: 600,
    background: "#333",
    color: "#666",
    border: "none",
    borderRadius: "6px",
    cursor: "default",
  },
  dangerButton: {
    padding: "10px 16px",
    fontSize: "14px",
    background: "rgba(200, 68, 68, 0.2)",
    color: "#cc6666",
    border: "1px solid rgba(200, 68, 68, 0.3)",
    borderRadius: "6px",
    cursor: "pointer",
  },
  bothReady: {
    marginTop: "12px",
    fontSize: "13px",
    color: "#44cc44",
  },
};
