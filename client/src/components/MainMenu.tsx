import { useState } from "react";
import { FCT, FctFrame, FctPanel, FctBtn, Refract, HEX_CLIP } from "../design/facet";

declare const __APP_VERSION__: string;

interface MainMenuProps {
  onHost: (username: string) => void;
  onJoin: (code: string, username: string) => void;
  onSoloTest: (username: string) => void;
  onReplays: () => void;
}

export default function MainMenu({ onHost, onJoin, onSoloTest, onReplays }: MainMenuProps) {
  const [username, setUsername] = useState("");
  const [lobbyCode, setLobbyCode] = useState("");
  const [error, setError] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const handleHost = () => {
    setError("");
    if (!username.trim()) {
      setError("Enter a username to continue.");
      return;
    }
    if (username.trim().length > 20) {
      setError("Username too long.");
      return;
    }
    onHost(username.trim());
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
    <FctFrame top="MAIN MENU" version={__APP_VERSION__}>
      <div
        style={{
          position: "absolute",
          top: 36,
          left: 0,
          right: 0,
          bottom: 0,
          padding: 56,
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr",
          gap: 56,
        }}
      >
        {/* ─── LEFT COLUMN ─────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FCT.mono,
                fontSize: 10,
                letterSpacing: "0.32em",
                color: FCT.inkDim,
              }}
            >
              ▰ CRYSTALFRONT RTS
            </div>
            <div
              style={{
                marginTop: 18,
                fontFamily: FCT.display,
                fontSize: 124,
                lineHeight: 0.85,
                letterSpacing: "-0.045em",
                textTransform: "uppercase",
                fontWeight: 700,
              }}
            >
              <Refract offset={2}>Crystal</Refract>
              <br />
              <Refract accent offset={2} style={{ fontStyle: "italic", fontWeight: 700 }}>
                Front.
              </Refract>
            </div>
            <div
              style={{
                marginTop: 22,
                fontSize: 16,
                color: FCT.inkDim,
                maxWidth: 420,
                lineHeight: 1.55,
              }}
            >
              Real-time strategy prototype. One lane, one resource,
              one Crystal each. Out-build, out-counter, shatter the
              opposing core.
            </div>
          </div>
          <div
            style={{
              fontFamily: FCT.mono,
              fontSize: 10,
              color: FCT.inkFaint,
              letterSpacing: "0.22em",
            }}
          >
            v{__APP_VERSION__}
          </div>
        </div>

        {/* ─── RIGHT COLUMN ────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            alignSelf: "center",
          }}
        >
          {/* ── Username panel ───────────────────────────── */}
          <FctPanel clip={HEX_CLIP} accent={FCT.ice} style={{ padding: "18px 22px 22px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontFamily: FCT.mono,
                fontSize: 9,
                color: FCT.ice,
                letterSpacing: "0.28em",
              }}
            >
              <span>▰ USERNAME</span>
              <span style={{ color: FCT.inkDim }}>
                {username.length.toString().padStart(2, "0")} / 20
              </span>
            </div>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                background: FCT.bg,
                padding: "10px 14px",
                border: `1px solid ${FCT.lineHi}`,
              }}
            >
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder=""
                maxLength={20}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (showJoin) handleJoinSubmit();
                    else handleHost();
                  }
                }}
                style={{
                  fontFamily: FCT.display,
                  fontSize: 32,
                  letterSpacing: "-0.02em",
                  color: FCT.ink,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  width: "100%",
                  flex: 1,
                }}
              />
              <span
                style={{
                  fontFamily: FCT.mono,
                  fontSize: 12,
                  color: FCT.ice,
                }}
              >
                ▮
              </span>
            </div>
            <div
              style={{
                fontFamily: FCT.mono,
                fontSize: 9,
                color: FCT.inkFaint,
                letterSpacing: "0.22em",
                marginTop: 8,
              }}
            >
              A–Z · 0–9 · _ –   ·   max 20 chars
            </div>
          </FctPanel>

          {/* ── Error message ────────────────────────────── */}
          {error && (
            <div
              style={{
                fontFamily: FCT.mono,
                fontSize: 10,
                color: FCT.red,
                letterSpacing: "0.15em",
                textAlign: "center",
              }}
            >
              {error}
            </div>
          )}

          {/* ── Main buttons ─────────────────────────────── */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginTop: 8,
            }}
          >
            <FctBtn primary sub="↵ ENTER" full onClick={handleHost}>
              ▷ Host Game
            </FctBtn>
            <FctBtn
              full
              sub="OPEN CODE FIELD"
              onClick={() => {
                setShowJoin(!showJoin);
                setShowSettings(false);
              }}
            >
              ▷ Join Game
            </FctBtn>
            <FctBtn
              full
              sub="OPEN PANEL"
              onClick={() => {
                setShowSettings(!showSettings);
                setShowJoin(false);
              }}
            >
              ▷ Settings
            </FctBtn>
            <FctBtn
              full
              sub="VIEW REPLAYS"
              onClick={onReplays}
            >
              ▶ Bot Replays
            </FctBtn>
          </div>

          {/* ── Join code panel (conditional) ────────────── */}
          {showJoin && (
            <FctPanel clip={HEX_CLIP} style={{ padding: 18, marginTop: 12 }}>
              <div
                style={{
                  fontFamily: FCT.mono,
                  fontSize: 9,
                  color: FCT.inkDim,
                  letterSpacing: "0.28em",
                  marginBottom: 10,
                }}
              >
                ▰ LOBBY CODE  ·  6 CHARS
              </div>
              <div style={{ position: "relative" }}>
                {/* Hidden input that captures keyboard input */}
                <input
                  type="text"
                  value={lobbyCode}
                  onChange={(e) => setLobbyCode(e.target.value.toUpperCase().slice(0, 6))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleJoinSubmit();
                  }}
                  maxLength={6}
                  style={{
                    position: "absolute",
                    inset: 0,
                    opacity: 0,
                    cursor: "text",
                    zIndex: 2,
                    width: "100%",
                    height: "100%",
                  }}
                  autoFocus
                />
                {/* Visual 6-char display */}
                <div style={{ display: "flex", gap: 6, pointerEvents: "none" }}>
                  {Array.from({ length: 6 }).map((_, i) => {
                    const char = lobbyCode[i] || "";
                    const isCursorPos = i === lobbyCode.length;
                    return (
                      <div
                        key={i}
                        style={{
                          flex: 1,
                          height: 44,
                          background: FCT.bgPanelHi,
                          border: `1px solid ${isCursorPos ? FCT.ice : FCT.lineHi}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: FCT.display,
                          fontSize: 22,
                          color: char ? FCT.ink : FCT.ice,
                          clipPath: HEX_CLIP,
                          fontWeight: 600,
                        }}
                      >
                        {char || (isCursorPos ? "▮" : "")}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                <FctBtn primary sub="↵ JOIN" onClick={handleJoinSubmit}>
                  ▷ Join
                </FctBtn>
              </div>
            </FctPanel>
          )}

          {/* ── Settings panel (conditional) ─────────────── */}
          {showSettings && (
            <FctPanel clip={HEX_CLIP} style={{ padding: 18, marginTop: 12 }}>
              <div
                style={{
                  fontFamily: FCT.mono,
                  fontSize: 9,
                  color: FCT.inkDim,
                  letterSpacing: "0.28em",
                  marginBottom: 6,
                }}
              >
                ▰ TEST MODE
              </div>
              <div
                style={{
                  fontFamily: FCT.ui,
                  fontSize: 12,
                  color: FCT.inkFaint,
                  marginBottom: 12,
                }}
              >
                Launch a solo game against a dummy opponent to test features.
              </div>
              <FctBtn
                primary
                full
                disabled={!username.trim()}
                onClick={() => {
                  setError("");
                  if (!username.trim()) {
                    setError("Enter a username to continue.");
                    return;
                  }
                  if (username.trim().length > 20) {
                    setError("Username too long.");
                    return;
                  }
                  onSoloTest(username.trim());
                }}
              >
                ◆ Solo Test
              </FctBtn>
            </FctPanel>
          )}
        </div>
      </div>
    </FctFrame>
  );
}
