/**
 * Match result (G-12, UI-7): a glass card over the frozen final frame of the match.
 * Victory / Defeat, how it was won, length, map and running score; then Rematch,
 * Watch replay (when the server saved one) or Main menu.
 */
import type { Lobby, Player } from "../types";
import { Icon } from "../design/glass";
import { clock } from "./Hud";

interface MatchEndScreenProps {
  lobby: Lobby;
  player: Player;
  winnerId: string;
  winType?: string;
  ticks: number;
  mapName: string;
  onRematch: () => void;
  onWatchReplay?: () => void;
  onExit: () => void;
}

const TEAM = { blue: "var(--blue)", red: "var(--red)" } as const;
const HOW: Record<string, string> = {
  combat: "by destroying the Crystal",
  control: "by holding the contested nodes",
  timeout: "on time",
};

export default function MatchEndScreen({ lobby, player, winnerId, winType, ticks, mapName, onRematch, onWatchReplay, onExit }: MatchEndScreenProps) {
  const won = player.id === winnerId;
  const players = lobby.players.filter((p): p is Player => p !== null);
  const winner = players.find((p) => p.id === winnerId);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      background: "radial-gradient(ellipse at 50% 50%, rgba(4,6,12,0.35) 0%, rgba(4,6,12,0.75) 100%)",
    }}>
      <div className="g-glass strong g-enter" style={{ width: 460, maxWidth: "100%", padding: "26px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <div className="g-label">Match over</div>
          <div className="g-title" style={{ fontSize: 56, lineHeight: 1.05, marginTop: 6, color: won ? "var(--good)" : "var(--bad)" }}>
            {won ? "Victory" : "Defeat"}
          </div>
          <p className="g-sub" style={{ margin: "8px 0 0", fontSize: 14 }}>
            {winner ? `${winner.username} wins` : "Match ended"}{winType && HOW[winType] ? ` ${HOW[winType]}` : ""}.
          </p>
        </div>

        <div style={{ display: "flex", gap: 24 }}>
          <div><div className="g-label">Length</div><div className="g-title" style={{ fontSize: 20, marginTop: 4 }}>{clock(ticks)}</div></div>
          <div style={{ minWidth: 0 }}><div className="g-label">Map</div><div className="g-title" style={{ fontSize: 20, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{mapName}</div></div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="g-label">Series</div>
          {players.map((p) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,0.04)", borderLeft: `3px solid ${TEAM[p.color]}` }}>
              <span className="g-title" style={{ fontSize: 16, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.username}</span>
              {p.id === player.id && <span className="g-label" style={{ color: "var(--ink-faint)" }}>You</span>}
              {p.id === winnerId && <Icon name="crystal" size={16} style={{ color: "var(--accent)" }} />}
              <span className="g-title" style={{ fontSize: 18, color: TEAM[p.color], width: 24, textAlign: "right" }}>{p.score}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button type="button" className="g-btn primary" style={{ flex: 1 }} onClick={onRematch}><Icon name="play" size={16} />Rematch</button>
          {onWatchReplay && <button type="button" className="g-btn" onClick={onWatchReplay}><Icon name="film" size={16} />Replay</button>}
          <button type="button" className="g-btn" onClick={onExit}>Menu</button>
        </div>
      </div>
    </div>
  );
}
