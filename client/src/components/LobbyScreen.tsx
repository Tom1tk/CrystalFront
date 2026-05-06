import type { Lobby, Player } from "../types";
import {
  FCT,
  Refract,
  FctFrame,
  FctBtn,
  FctPanel,
  FctMark,
  HEX_CLIP,
  NOTCH_L,
  NOTCH_R,
} from "../design/facet";

interface LobbyScreenProps {
  lobby: Lobby;
  player: Player;
  isHost: boolean;
  onReady: () => void;
  onLeave: () => void;
  error: string | null;
}

// ─── Player Panel ────────────────────────────────────────────────
function FctPlayer({
  name,
  slot,
  ready,
  score,
  accent,
  you,
  host,
  side,
  empty,
}: {
  name?: string;
  slot: string;
  ready?: boolean;
  score?: number;
  accent: string;
  you?: boolean;
  host?: boolean;
  side: "L" | "R";
  empty?: boolean;
}) {
  return (
    <FctPanel
      clip={side === "L" ? NOTCH_R : NOTCH_L}
      accent={empty ? FCT.line : accent}
      style={{ padding: 28, height: "100%" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: FCT.mono,
          fontSize: 10,
          color: FCT.inkDim,
          letterSpacing: "0.28em",
        }}
      >
        <span>
          ▰ SLOT {slot}
          {you ? " · YOU" : ""}
        </span>
        <span>{empty ? "OPEN" : host ? "HOST" : "GUEST"}</span>
      </div>
      {empty ? (
        <div
          style={{
            marginTop: 40,
            textAlign: "center",
            fontFamily: FCT.display,
            fontSize: 22,
            fontStyle: "italic",
            color: FCT.inkFaint,
          }}
        >
          Waiting for opponent…
        </div>
      ) : (
        <>
          <div
            style={{
              marginTop: 18,
              display: "flex",
              gap: 18,
              alignItems: "center",
            }}
          >
            <div style={{ width: 64, height: 72, flexShrink: 0 }}>
              <svg viewBox="0 0 64 74" width="64" height="72">
                <path
                  d="M32 2 L60 18 L60 52 L32 72 L4 52 L4 18 Z"
                  fill={accent}
                />
                <path
                  d="M32 2 L60 18 L32 36 L4 18 Z"
                  fill="rgba(255,255,255,0.18)"
                />
              </svg>
            </div>
            <div>
              <div
                style={{
                  fontFamily: FCT.display,
                  fontSize: 38,
                  lineHeight: 0.95,
                  letterSpacing: "-0.03em",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                {name}
              </div>
              <div
                style={{
                  fontFamily: FCT.mono,
                  fontSize: 10,
                  color: FCT.inkDim,
                  letterSpacing: "0.22em",
                  marginTop: 4,
                }}
              >
                {accent === FCT.ice
                  ? "BLUE TEAM · WEST SIDE"
                  : "RED TEAM · EAST SIDE"}
              </div>
            </div>
          </div>
          <div
            style={{
              marginTop: 22,
              padding: "10px 14px",
              background: FCT.bgPanelHi,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              clipPath: HEX_CLIP,
            }}
          >
            <span
              style={{
                fontFamily: FCT.mono,
                fontSize: 10,
                letterSpacing: "0.28em",
                color: ready ? FCT.green : FCT.inkDim,
              }}
            >
              {ready ? "◆ READY" : "◇ NOT READY"}
            </span>
            <span
              style={{
                fontFamily: FCT.display,
                fontSize: 22,
                fontWeight: 600,
              }}
            >
              SCORE {score}
            </span>
          </div>
        </>
      )}
    </FctPanel>
  );
}

// ─── Lobby Screen ────────────────────────────────────────────────
export default function LobbyScreen({
  lobby,
  player,
  isHost,
  onReady,
  onLeave,
  error,
}: LobbyScreenProps) {
  const bothReady = lobby.players[0]?.ready && lobby.players[1]?.ready;
  const opponent =
    lobby.players[0]?.id === player.id
      ? lobby.players[1]
      : lobby.players[0];

  const isPlayerSlot0 = lobby.players[0]?.id === player.id;
  const playerSlot = isPlayerSlot0 ? "01" : "02";
  const opponentSlot = isPlayerSlot0 ? "02" : "01";

  const playerAccent = FCT.ice;
  const opponentAccent = FCT.red;

  // Determine status text
  const statusText =
    bothReady
      ? "Both players ready!"
      : "Waiting for ready";

  const bottomStatusText =
    !player.ready
      ? "▰ YOU ARE NOT READY"
      : opponent && !opponent.ready
        ? `▰ YOU ARE READY · WAITING ON ${opponent.username.toUpperCase()}`
        : opponent && opponent.ready
          ? "▰ BOTH PLAYERS READY"
          : "▰ YOU ARE READY · WAITING FOR OPPONENT";

  return (
    <FctFrame top="LOBBY">
      {error && (
        <div
          style={{
            position: "absolute",
            top: 48,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 20,
            fontFamily: FCT.mono,
            fontSize: 11,
            color: FCT.red,
            background: FCT.bgEnemy,
            padding: "8px 18px",
            clipPath: HEX_CLIP,
            border: `1px solid ${FCT.red}`,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          top: 36,
          left: 0,
          right: 0,
          bottom: 0,
          padding: 48,
          display: "grid",
          gridTemplateRows: "auto 1fr auto",
          gap: 32,
        }}
      >
        {/* TOP ROW — code + status */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: FCT.mono,
                fontSize: 10,
                color: FCT.inkDim,
                letterSpacing: "0.32em",
              }}
            >
              ▰ LOBBY CODE  ·  SHARE TO INVITE
            </div>
            <div
              style={{
                fontFamily: FCT.display,
                fontSize: 76,
                letterSpacing: "0.18em",
                lineHeight: 0.95,
                fontWeight: 700,
                marginTop: 6,
              }}
            >
              {lobby.code.split("").map((char, i) => (
                <Refract key={i} accent={i % 2 === 1}>
                  {char}
                </Refract>
              ))}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontFamily: FCT.mono,
                fontSize: 10,
                color: FCT.inkDim,
                letterSpacing: "0.32em",
              }}
            >
              ▰ STATUS
            </div>
            <div
              style={{
                marginTop: 4,
                fontFamily: FCT.display,
                fontSize: 22,
                fontStyle: "italic",
                color: FCT.amber,
              }}
            >
              {statusText}
            </div>
            <div
              style={{
                fontFamily: FCT.mono,
                fontSize: 10,
                color: FCT.inkDim,
                letterSpacing: "0.22em",
                marginTop: 4,
              }}
            >
              BOTH PLAYERS MUST READY UP
            </div>
          </div>
        </div>

        {/* MIDDLE — player panels + VS */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            gap: 24,
            alignItems: "stretch",
          }}
        >
          {/* Player (you) panel */}
          <FctPlayer
            name={player.username}
            slot={playerSlot}
            ready={player.ready}
            score={player.score}
            accent={playerAccent}
            you
            host={isHost}
            side="L"
          />

          {/* VS divider */}
          <div style={{ alignSelf: "center", textAlign: "center" }}>
            <div
              style={{
                fontFamily: FCT.display,
                fontSize: 92,
                fontStyle: "italic",
                lineHeight: 1,
                color: FCT.inkFaint,
                fontWeight: 700,
              }}
            >
              vs
            </div>
          </div>

          {/* Opponent panel */}
          {opponent ? (
            <FctPlayer
              name={opponent.username}
              slot={opponentSlot}
              ready={opponent.ready}
              score={opponent.score}
              accent={opponentAccent}
              host={opponent.id === lobby.hostId}
              side="R"
            />
          ) : (
            <FctPlayer
              slot={opponentSlot}
              accent={FCT.line}
              side="R"
              empty
            />
          )}
        </div>

        {/* BOTTOM ROW — status + buttons */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontFamily: FCT.mono,
              fontSize: 11,
              color: FCT.inkDim,
              letterSpacing: "0.22em",
            }}
          >
            {bottomStatusText}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <FctBtn danger onClick={onLeave}>
              ◀ Leave Lobby
            </FctBtn>
            <FctBtn
              primary
              sub="TOGGLE"
              disabled={bothReady}
              onClick={bothReady ? undefined : onReady}
            >
              {player.ready ? "◆ Unready" : "◆ Ready Up"}
            </FctBtn>
          </div>
        </div>

        {/* BOTH READY BANNER */}
        {bothReady && (
          <div
            style={{
              position: "absolute",
              bottom: 120,
              left: "50%",
              transform: "translateX(-50%)",
              fontFamily: FCT.display,
              fontSize: 18,
              color: FCT.green,
              background: FCT.bgPanel,
              padding: "12px 32px",
              clipPath: HEX_CLIP,
              border: `1px solid ${FCT.green}`,
              letterSpacing: "0.04em",
              fontWeight: 600,
            }}
          >
            Both players ready! Starting match…
          </div>
        )}
      </div>
    </FctFrame>
  );
}
