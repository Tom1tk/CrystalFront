import type { Lobby, Player } from "../types";
import { FCT, HEX_CLIP, Refract, FctFrame, FctPanel, FctBtn } from "../design/facet";

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
  const opponent =
    lobby.players.find((p): p is Player => p !== null && p.id !== player.id) ??
    lobby.players[1] ?? player;
  const winnerName =
    lobby.players[0]?.id === winnerId
      ? lobby.players[0]?.username
      : lobby.players[1]?.username;

  const playerAccent = player.color === "blue" ? FCT.ice : FCT.red;
  const opponentAccent = opponent.color === "blue" ? FCT.ice : FCT.red;

  const rows = [
    {
      name: player.username,
      score: player.score,
      color: playerAccent,
      isYou: true,
      isWinner: isWinner,
    },
    {
      name: opponent.username,
      score: opponent.score,
      color: opponentAccent,
      isYou: false,
      isWinner: opponent.id === winnerId,
    },
  ];

  return (
    <FctFrame top="POST-MATCH">
      <div
        style={{
          position: "absolute",
          top: 36,
          left: 0,
          right: 0,
          bottom: 0,
          padding: 56,
          display: "grid",
          gridTemplateRows: "auto 1fr auto",
          gap: 32,
        }}
      >
        {/* TOP — huge result */}
        <div>
          <div
            style={{
              fontFamily: FCT.mono,
              fontSize: 10,
              color: FCT.inkDim,
              letterSpacing: "0.32em",
            }}
          >
            ▰ MATCH RESULT
          </div>
          <div
            style={{
              marginTop: 8,
              fontFamily: FCT.display,
              fontSize: 140,
              lineHeight: 0.85,
              letterSpacing: "-0.05em",
              textTransform: "uppercase",
              fontWeight: 700,
            }}
          >
            {isWinner ? (
              <Refract accent offset={2.5} style={{ fontStyle: "italic", fontWeight: 700 }}>
                Victory.
              </Refract>
            ) : (
              <span style={{ fontStyle: "italic", fontWeight: 700 }}>Defeat.</span>
            )}
          </div>
          <div
            style={{
              marginTop: 10,
              fontFamily: FCT.display,
              fontSize: 22,
              color: FCT.inkDim,
              fontStyle: "italic",
            }}
          >
            {winnerName} wins this match.
          </div>
        </div>

        {/* MIDDLE — scoreboard */}
        <div style={{ alignSelf: "start" }}>
          <FctPanel clip={HEX_CLIP} style={{ padding: 24 }}>
            <div
              style={{
                fontFamily: FCT.mono,
                fontSize: 10,
                color: FCT.inkDim,
                letterSpacing: "0.32em",
                marginBottom: 14,
              }}
            >
              ▰ SCOREBOARD
            </div>
            {rows.map((r, i) => (
              <div
                key={r.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "20px 1fr auto auto",
                  gap: 16,
                  alignItems: "center",
                  padding: "14px 0",
                  borderBottom:
                    i < rows.length - 1 ? `1px solid ${FCT.line}` : "none",
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    background: r.color,
                    transform: "rotate(45deg)",
                    display: "inline-block",
                  }}
                />
                <span
                  style={{
                    fontFamily: FCT.display,
                    fontSize: 28,
                    letterSpacing: "-0.02em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                  }}
                >
                  {r.name}
                  {r.isYou && (
                    <span
                      style={{
                        fontFamily: FCT.mono,
                        fontSize: 10,
                        color: FCT.inkDim,
                        marginLeft: 10,
                        letterSpacing: "0.22em",
                      }}
                    >
                      · YOU
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontFamily: FCT.mono,
                    fontSize: 10,
                    color: r.isWinner ? FCT.green : FCT.inkFaint,
                    letterSpacing: "0.22em",
                  }}
                >
                  {r.isWinner ? "◆ WINNER" : "◇ DEFEAT"}
                </span>
                <span
                  style={{
                    fontFamily: FCT.display,
                    fontSize: 36,
                    color: r.color,
                    fontWeight: 700,
                    minWidth: 40,
                    textAlign: "right",
                  }}
                >
                  {r.score}
                </span>
              </div>
            ))}
          </FctPanel>
        </div>

        {/* BOTTOM — actions */}
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
            ▰ REMATCH RETURNS TO LOBBY · EXIT CLOSES IT
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <FctBtn danger onClick={onExit}>
              ◀ Exit to Menu
            </FctBtn>
            <FctBtn primary sub="↵" onClick={onRematch}>
              ◆ Rematch
            </FctBtn>
          </div>
        </div>
      </div>
    </FctFrame>
  );
}
