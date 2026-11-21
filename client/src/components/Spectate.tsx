/**
 * Delayed tournament spectating (docs/TOURNAMENT_SPEC.md §6): observer fog modes, the broadcast
 * fog overlay, the spectate bar and the per-player broadcast panels. The server sends the full,
 * delayed state with each seat's vision; everything here is presentation.
 */
import { UNIT_DEFS } from "@crystalfront/shared";
import type { MatchState, StaticMap } from "../types";
import { Icon } from "../design/glass";
import { HUD_BAR_HEIGHT } from "./Hud";

export type FogMode = "both" | "blue" | "red" | "none";
export interface SpectateInfo { delay: number; round?: number; game?: number; bestOf?: number; a?: string; b?: string }

const TEAM = { blue: "var(--blue)", red: "var(--red)" } as const;
/** Canvas tints for the vision edges (the --blue / --red tokens). */
const TEAM_RGB: Record<string, [number, number, number]> = { blue: [124, 232, 255], red: [255, 92, 243] };

/** The state as a fog mode shows it: Blue's / Red's view is that seat's true fog. */
export function spectatorView(ms: MatchState, mode: FogMode): MatchState {
  const seats = ms.visionBySeat ?? [];
  if (mode === "none") return { ...ms, vision: undefined, broadcastFog: undefined };
  if (mode === "both") return { ...ms, vision: undefined, broadcastFog: { vision: seats, colors: ms.players.map((p) => p?.color ?? "blue") } };
  const seat = ms.players.findIndex((p) => p?.color === mode);
  if (seat < 0) return ms;
  const bit = 1 << seat;
  const sees = (x: { seen?: number }) => ((x.seen ?? bit) & bit) !== 0;
  return { ...ms, entities: ms.entities.filter(sees), resourceNodes: ms.resourceNodes.filter(sees), vision: seats[seat] ?? undefined, broadcastFog: undefined };
}

let cache: { key: string; canvas: HTMLCanvasElement } | null = null;
/**
 * One pixel per vision cell: dimmed where neither seat sees, each seat's vision edge tinted in its
 * team colour, clear elsewhere. Drawn scaled up with smoothing, like the player fog.
 */
export function broadcastFogCanvas(fog: NonNullable<MatchState["broadcastFog"]>, sm: StaticMap | undefined): HTMLCanvasElement | null {
  if (!sm?.visionCols || !sm.visionRows || fog.vision.length === 0) return null;
  const key = fog.vision.join("|") + fog.colors.join();
  if (cache?.key === key) return cache.canvas;
  const cols = sm.visionCols, rows = sm.visionRows, n = cols * rows;
  const lit = fog.vision.map((v) => {
    const a = new Uint8Array(n);
    if (v) { const bits = atob(v); for (let i = 0; i < n; i++) a[i] = (bits.charCodeAt(i >> 3) >> (i & 7)) & 1; }
    return a;
  });
  // Off-grid counts as lit, so the map border isn't outlined.
  const at = (a: Uint8Array, x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? 1 : a[y * cols + x]);
  const canvas = cache?.canvas ?? document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const c = canvas.getContext("2d")!;
  const img = c.createImageData(cols, rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * cols + x, o = i * 4;
    const edge = lit.findIndex((a) => a[i] && (!at(a, x - 1, y) || !at(a, x + 1, y) || !at(a, x, y - 1) || !at(a, x, y + 1)));
    if (edge >= 0) {
      const [r, g, b] = TEAM_RGB[fog.colors[edge]] ?? TEAM_RGB.blue;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 90;
    } else if (!lit.some((a) => a[i])) {
      img.data[o] = 5; img.data[o + 1] = 8; img.data[o + 2] = 22; img.data[o + 3] = 80;
    }
  }
  c.putImageData(img, 0, 0);
  cache = { key, canvas };
  return canvas;
}

const FOG_MODES: Array<[FogMode, string]> = [["both", "Both"], ["blue", "Blue"], ["red", "Red"], ["none", "No fog"]];

/** Replaces the replay bar while spectating: no seek or speed, just the fog modes. */
export function SpectateBar({ info, fog, onFog, onExit }: { info: SpectateInfo; fog: FogMode; onFog: (m: FogMode) => void; onExit: () => void }) {
  return (
    <div className="g-glass strong" style={{ position: "absolute", top: HUD_BAR_HEIGHT + 10, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", pointerEvents: "auto", zIndex: 8, whiteSpace: "nowrap" }}>
      <span className="g-label" style={{ color: "var(--accent)", marginRight: 4 }}>Spectating</span>
      {info.round != null && (
        <span className="g-label" style={{ color: "var(--ink-dim)", marginRight: 6 }}>
          R{info.round} · G{info.game}{info.bestOf && info.bestOf > 1 ? `/Bo${info.bestOf}` : ""}
        </span>
      )}
      {FOG_MODES.map(([m, label]) => (
        <button key={m} type="button" onClick={() => onFog(m)} className={`g-btn small${fog === m ? " primary" : ""}`}
          title={m === "both" ? "Everything, with both players' fog" : m === "none" ? "Everything, no fog" : `Only what ${label.toLowerCase()} sees`}
          style={{ padding: "6px 10px", gap: 6 }}>
          {(m === "blue" || m === "red") && <span style={{ width: 8, height: 8, borderRadius: 4, background: TEAM[m] }} />}
          {label}
        </button>
      ))}
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-dim)", margin: "0 6px" }} title="The feed runs this far behind the live game">
        −{info.delay}s
      </span>
      <button type="button" className="g-btn small" onClick={onExit}><Icon name="close" size={14} />Exit</button>
    </div>
  );
}

const name = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** One panel per player: economy, army value, nodes held and what is in production. */
export function BroadcastPanels({ match }: { match: MatchState }) {
  const c = match.control;
  return (
    <>
      {match.players.map((p, seat) => {
        if (!p) return null;
        const eco = match.economy[seat];
        const own = match.entities.filter((e) => e.ownerId === p.playerId && e.health > 0);
        const army = own.reduce((s, e) => s + (e.type !== "worker" && UNIT_DEFS[e.type] ? UNIT_DEFS[e.type].cost : 0), 0);
        const workers = own.filter((e) => e.type === "worker").length;
        const nodes = c ? c.nodes.filter((n) => n.controller === seat).length : 0;
        const holding = c && c.holder === seat ? Math.floor((100 * c.progress[seat]) / c.holdTicks) : null;
        const queue = own.flatMap((e) => e.productionQueue.map((q, i) => ({ type: q.unitType, secs: i === 0 ? Math.ceil(q.remainingTicks / 10) : null })));
        const team = p.color === "red" ? "red" : "blue";
        return (
          <div key={seat} className="g-glass" style={{
            position: "absolute", top: HUD_BAR_HEIGHT + 64, [seat === 0 ? "left" : "right"]: 10, width: 210, padding: "10px 12px",
            borderLeft: `3px solid ${TEAM[team]}`, pointerEvents: "none", zIndex: 6, fontSize: 12,
          }}>
            <div className="g-title" style={{ fontSize: 14, color: TEAM[team], whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.username}</div>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 2, marginTop: 6, fontFamily: "var(--mono)" }}>
              <span className="g-label">Crystal</span><span>{eco?.resources ?? 0}</span>
              <span className="g-label">Supply</span><span>{eco?.supply ?? 0}/{eco?.maxSupply ?? 0}</span>
              <span className="g-label">Workers</span><span>{workers}</span>
              <span className="g-label">Army</span><span>{army}</span>
              {c && c.nodes.length > 0 && <><span className="g-label">Nodes</span><span>{nodes}/{c.nodes.length}{holding !== null ? ` · ${holding}%` : ""}</span></>}
            </div>
            {queue.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                {queue.slice(0, 8).map((q, i) => (
                  <span key={i} className="g-label" style={{ padding: "2px 6px", border: "1px solid var(--edge)", borderRadius: 3, color: q.secs !== null ? "var(--ink)" : "var(--ink-faint)" }}>
                    {name(q.type)}{q.secs !== null ? ` ${q.secs}s` : ""}
                  </span>
                ))}
                {queue.length > 8 && <span className="g-label">+{queue.length - 8}</span>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
