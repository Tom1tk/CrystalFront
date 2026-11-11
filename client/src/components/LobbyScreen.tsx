/**
 * Online lobby (G-12, UI-5): glass panel over the live 3D backdrop (which shows the chosen
 * map). Lobby code with copy, one card per team, host-only map choice, Ready / Leave.
 */
import { useState } from "react";
import type { Lobby, Player } from "../types";
import { Icon, IconBtn, PageTitle } from "../design/glass";
import { MapCards } from "./MapPicker";

interface LobbyScreenProps {
  lobby: Lobby;
  player: Player;
  isHost: boolean;
  onReady: () => void;
  onLeave: () => void;
  onSetMap: (mapId: string) => void;
  error: string | null;
}

const TEAM = { blue: "var(--blue)", red: "var(--red)" } as const;

function PlayerCard({ p, slot, you, host }: { p: Player | null; slot: 0 | 1; you?: boolean; host?: boolean }) {
  const colour = p ? TEAM[p.color] : "var(--edge)";
  return (
    <div className="g-glass flat" style={{ flex: 1, minWidth: 0, padding: "14px 16px", background: "rgba(255,255,255,0.04)", borderLeft: `3px solid ${colour}` }}>
      <div className="g-label" style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-faint)" }}>
        <span>Player {slot + 1}</span>
        <span>{[you && "You", host && "Host"].filter(Boolean).join(" · ")}</span>
      </div>
      {p ? (
        <>
          <div className="g-title" style={{ fontSize: 20, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.username}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
            <span className="g-label" style={{ display: "flex", alignItems: "center", gap: 6, color: p.ready ? "var(--good)" : "var(--ink-dim)" }}>
              {p.ready ? <><Icon name="check" size={14} />Ready</> : "Not ready"}
            </span>
            <span className="g-label">Wins {p.score}</span>
          </div>
        </>
      ) : (
        <>
          <div className="g-title g-pulse" style={{ fontSize: 20, marginTop: 6, color: "var(--ink-faint)" }}>Waiting…</div>
          <div className="g-label" style={{ marginTop: 10, color: "var(--ink-faint)" }}>Share the code to invite</div>
        </>
      )}
    </div>
  );
}

export default function LobbyScreen({ lobby, player, isHost, onReady, onLeave, onSetMap, error }: LobbyScreenProps) {
  const [copied, setCopied] = useState(false);
  const [p0, p1] = lobby.players;
  const bothReady = !!(p0?.ready && p1?.ready);
  const opponent = p0?.id === player.id ? p1 : p0;
  const status = bothReady
    ? "Both ready, starting…"
    : !opponent
      ? "Waiting for an opponent to join"
      : !player.ready
        ? "Ready up when you are set"
        : `Waiting on ${opponent.username}`;

  const copy = () => {
    void navigator.clipboard?.writeText(lobby.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard blocked */ });
  };

  return (
    <div style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", display: "flex", padding: "clamp(20px, 4vh, 48px) clamp(20px, 4vw, 64px)" }}>
      <div className="g-glass g-enter" style={{ width: 640, maxWidth: "100%", display: "flex", flexDirection: "column", minHeight: 0, alignSelf: "stretch" }}>
        <div style={{ padding: "18px 22px 0" }}>
          <PageTitle label="Online match" title="Lobby" right={<IconBtn icon="back" title="Leave lobby" small onClick={onLeave} />} />
        </div>

        <div className="g-scroll" style={{ flex: 1, minHeight: 0, padding: "16px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
          <section>
            <div className="g-label" style={{ marginBottom: 8 }}>Lobby code</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="g-title" style={{ fontFamily: "var(--mono)", fontSize: 40, letterSpacing: "0.2em", color: "var(--accent)" }}>{lobby.code}</span>
              <button type="button" className="g-btn ghost" onClick={copy}>
                {copied ? <><Icon name="check" size={16} />Copied</> : "Copy"}
              </button>
            </div>
          </section>

          <section style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <PlayerCard p={p0} slot={0} you={p0?.id === player.id} host={!!p0 && p0.id === lobby.hostId} />
            <PlayerCard p={p1} slot={1} you={p1?.id === player.id} host={!!p1 && p1.id === lobby.hostId} />
          </section>

          <section>
            <div className="g-label" style={{ marginBottom: 8 }}>Map{isHost ? "" : " · chosen by the host"}</div>
            <MapCards value={lobby.mapId ?? "random"} onChange={onSetMap} disabled={!isHost || bothReady} columns={3} />
          </section>
        </div>

        <div style={{ padding: "14px 22px 18px", borderTop: "1px solid var(--edge)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            {error ? <span className="g-error">{error}</span> : <span className={`g-sub${bothReady ? " g-pulse" : ""}`} style={{ color: bothReady ? "var(--good)" : undefined }}>{status}</span>}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="g-btn danger" onClick={onLeave}>Leave</button>
            <button type="button" className={`g-btn big${player.ready ? "" : " primary"}`} disabled={bothReady} onClick={onReady}>
              {player.ready ? "Unready" : <><Icon name="check" size={18} />Ready</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
