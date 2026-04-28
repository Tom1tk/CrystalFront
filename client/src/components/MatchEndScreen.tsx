import type { Lobby, Player } from "../types";

interface MatchEndScreenProps {
  lobby: Lobby;
  player: Player;
  winnerId: string;
  onRematch: () => void;
  onExit: () => void;
}

export default function MatchEndScreen({
  lobby,
  player,
  winnerId,
  onRematch,
  onExit,
}: MatchEndScreenProps) {
  const isWinner = player.id === winnerId;
  const winnerName =
    lobby.players[0]?.id === winnerId
      ? lobby.players[0]?.username
      : lobby.players[1]?.username;

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h2
          style={{
            ...styles.title,
            color: isWinner ? "#44cc44" : "#cc4444",
          }}
        >
          {isWinner ? "Victory!" : "Defeat"}
        </h2>
        <p style={styles.subtitle}>
          {winnerName} wins this match.
        </p>

        <div style={styles.scoreboard}>
          <div style={styles.scoreRow}>
            <span style={styles.playerName}>
              <span
                style={{
                  ...styles.colorDot,
                  background: player.color === "blue" ? "#4488ff" : "#ff4444",
                }}
              />
              {player.username}
            </span>
            <span style={styles.scoreValue}>{player.score}</span>
          </div>
          <div style={styles.divider} />
          <div style={styles.scoreRow}>
            <span style={styles.playerName}>
              <span
                style={{
                  ...styles.colorDot,
                  background:
                    lobby.players[0]?.id === player.id
                      ? lobby.players[1]?.color === "blue"
                        ? "#4488ff"
                        : "#ff4444"
                      : lobby.players[0]?.color === "blue"
                        ? "#4488ff"
                        : "#ff4444",
                }}
              />
              {lobby.players[0]?.id === player.id
                ? lobby.players[1]?.username
                : lobby.players[0]?.username}
            </span>
            <span style={styles.scoreValue}>
              {lobby.players[0]?.id === player.id
                ? lobby.players[1]?.score
                : lobby.players[0]?.score}
            </span>
          </div>
        </div>

        <div style={styles.buttonGroup}>
          <button style={styles.primaryButton} onClick={onRematch}>
            Rematch
          </button>
          <button style={styles.secondaryButton} onClick={onExit}>
            Exit to Menu
          </button>
        </div>
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
    width: "400px",
    maxWidth: "90vw",
    textAlign: "center" as const,
  },
  title: {
    fontSize: "28px",
    fontWeight: 700,
    marginBottom: "4px",
  },
  subtitle: {
    fontSize: "14px",
    color: "#888",
    marginBottom: "24px",
  },
  scoreboard: {
    background: "rgba(0, 0, 0, 0.3)",
    borderRadius: "8px",
    padding: "16px",
    marginBottom: "24px",
  },
  scoreRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 0",
  },
  playerName: {
    fontSize: "14px",
    color: "#e0e0e0",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  scoreValue: {
    fontSize: "20px",
    fontWeight: 700,
    color: "#8888ff",
  },
  divider: {
    height: "1px",
    background: "rgba(100, 100, 200, 0.15)",
    margin: "8px 0",
  },
  colorDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    display: "inline-block",
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
  secondaryButton: {
    flex: 1,
    padding: "10px 16px",
    fontSize: "14px",
    background: "rgba(100, 100, 200, 0.2)",
    color: "#aaa",
    border: "1px solid rgba(100, 100, 200, 0.3)",
    borderRadius: "6px",
    cursor: "pointer",
  },
};
