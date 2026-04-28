import { useState } from "react";

interface MainMenuProps {
  onHost: (username: string) => void;
  onJoin: (code: string, username: string) => void;
}

export default function MainMenu({ onHost, onJoin }: MainMenuProps) {
  const [username, setUsername] = useState("");
  const [lobbyCode, setLobbyCode] = useState("");
  const [error, setError] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const handleHost = () => {
    console.log("[MainMenu] handleHost called, username:", username);
    setError("");
    if (!username.trim()) {
      setError("Enter a username to continue.");
      return;
    }
    if (username.trim().length > 20) {
      setError("Username too long.");
      return;
    }
    console.log("[MainMenu] calling onHost with:", username.trim());
    onHost(username.trim());
    console.log("[MainMenu] onHost returned");
  };

  const handleJoinSubmit = () => {
    setError("");
    if (!username.trim()) {
      setError("Enter a username to continue.");
      return;
    }
    if (!lobbyCode.trim()) {
      setError("Enter a lobby code.");
      return;
    }
    onJoin(lobbyCode.trim(), username.trim());
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>CrystalFront RTS</h1>
        <p style={styles.subtitle}>Real-time strategy prototype</p>

        <div style={styles.inputGroup}>
          <label style={styles.label}>Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your username"
            style={styles.input}
            maxLength={20}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (showJoin) handleJoinSubmit();
                else handleHost();
              }
            }}
          />
        </div>

        {error && <p style={styles.error}>{error}</p>}

        <div style={styles.buttonGroup}>
          <button style={styles.primaryButton} onClick={handleHost}>
            Host Game
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              setShowJoin(!showJoin);
              setShowSettings(false);
            }}
          >
            {showJoin ? "Back" : "Join Game"}
          </button>
          <button
            style={styles.secondaryButton}
            onClick={() => {
              setShowSettings(!showSettings);
              setShowJoin(false);
            }}
          >
            Settings
          </button>
        </div>

        {showJoin && (
          <div style={styles.joinSection}>
            <input
              type="text"
              value={lobbyCode}
              onChange={(e) => setLobbyCode(e.target.value.toUpperCase())}
              placeholder="Lobby Code"
              style={styles.input}
              maxLength={6}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleJoinSubmit();
              }}
            />
            <button style={styles.primaryButton} onClick={handleJoinSubmit}>
              Join
            </button>
          </div>
        )}

        {showSettings && (
          <div style={styles.settingsSection}>
            <p style={styles.settingsText}>Settings panel (placeholder)</p>
            <p style={styles.settingsSubtext}>Audio, controls, and display options will appear here.</p>
          </div>
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
    padding: "40px",
    width: "400px",
    maxWidth: "90vw",
    textAlign: "center" as const,
  },
  title: {
    fontSize: "32px",
    fontWeight: 700,
    color: "#8888ff",
    marginBottom: "4px",
  },
  subtitle: {
    fontSize: "14px",
    color: "#8888aa",
    marginBottom: "24px",
  },
  inputGroup: {
    marginBottom: "16px",
    textAlign: "left" as const,
  },
  label: {
    display: "block",
    fontSize: "12px",
    color: "#aaa",
    marginBottom: "4px",
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    fontSize: "14px",
    background: "rgba(0, 0, 0, 0.3)",
    border: "1px solid rgba(100, 100, 200, 0.3)",
    borderRadius: "6px",
    color: "#e0e0e0",
    outline: "none",
  },
  error: {
    color: "#ff6666",
    fontSize: "13px",
    marginBottom: "12px",
  },
  buttonGroup: {
    display: "flex",
    gap: "8px",
    marginBottom: "16px",
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
  joinSection: {
    display: "flex",
    gap: "8px",
    marginBottom: "8px",
  },
  settingsSection: {
    background: "rgba(0, 0, 0, 0.2)",
    borderRadius: "6px",
    padding: "16px",
  },
  settingsText: {
    fontSize: "14px",
    color: "#aaa",
    marginBottom: "4px",
  },
  settingsSubtext: {
    fontSize: "12px",
    color: "#666",
  },
};
