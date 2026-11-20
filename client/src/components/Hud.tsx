/**
 * In-match HUD (G-12, UI-6) in the "Facet, lit" glass style: the top bar, the clickable
 * command card with the selection panel, the first-match tip and the replay bar.
 * GameShell owns all game state; these components only draw it and report clicks.
 */
import BetaBadge from "./BetaBadge";
import { useState, type ReactNode } from "react";
import { Icon, IconBtn, SoundToggle, Wordmark } from "../design/glass";
import { tipsEnabled } from "./SettingsModal";

/** Height of the top bar; the map is drawn below it. */
export const HUD_BAR_HEIGHT = 52;

const TEAM = { blue: "var(--blue)", red: "var(--red)" } as const;
type Team = keyof typeof TEAM;

export function clock(tick: number): string {
  const s = Math.floor(tick / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Side({ name, score, team, right }: { name: string; score?: number; team: Team; right?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexDirection: right ? "row-reverse" : "row", minWidth: 0 }}>
      <span style={{ width: 4, height: 22, background: TEAM[team], flexShrink: 0 }} />
      <span className="g-title" style={{ fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{name}</span>
      {score !== undefined && <span className="g-title" style={{ fontSize: 18, color: TEAM[team] }}>{score}</span>}
    </div>
  );
}

function Stat({ label, value, tint, title }: { label: string; value: ReactNode; tint?: string; title?: string }) {
  return (
    <div title={title} style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1, minWidth: 64 }}>
      <span className="g-label" style={{ fontSize: 9, letterSpacing: "0.2em" }}>{label}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 15, fontWeight: 600, color: tint ?? "var(--ink)", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

export interface NodesInfo {
  mine: number; theirs: number; need: number; myPct: number; theirPct: number; holder: "me" | "them" | null;
  /** Beta: contested nodes in all, and ticks of hold the holder still needs at the current Surge rate. */
  total?: number; leftTicks?: number;
}

/** Beta: the next timed event and the ticks until it. */
export interface SurgeClock { next: string; inTicks: number }

/** Beta node-control readout: one bar per side, "Hold 3 of 5 nodes · 0:42 left to win". */
function ControlBars({ nodes, me, them }: { nodes: NodesInfo; me: Team; them: Team }) {
  const row = (team: Team, held: number, pct: number, holding: boolean) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, height: 17 }}>
      <div style={{ width: 70, height: 6, background: "rgba(255,255,255,0.08)", flexShrink: 0 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: TEAM[team], transition: "width 0.3s linear" }} />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: 11, whiteSpace: "nowrap", color: holding ? "var(--ink)" : "var(--ink-dim)" }}>
        Hold {held} of {nodes.total ?? nodes.need} nodes · {holding && nodes.leftTicks !== undefined ? `${clock(nodes.leftTicks)} left to win` : `${pct}%`}
      </span>
    </div>
  );
  return (
    <div title={`Hold ${nodes.need} or more contested nodes to fill your bar; a full bar wins. Losing the majority drains it. At 20:00 the fuller bar wins; equal bars draw.`}
      style={{ display: "flex", flexDirection: "column", minWidth: 220 }}>
      {row(me, nodes.mine, nodes.myPct, nodes.holder === "me")}
      {row(them, nodes.theirs, nodes.theirPct, nodes.holder === "them")}
    </div>
  );
}

const STAGE_TEXT: Record<number, [string, string]> = {
  1: ["Surge I", "Every unit moves 25% faster; gathering ×1.5"],
  2: ["Surge II", "Units deal ×1.5 damage to buildings and Crystals; hold 30 s to win"],
  3: ["Surge III", "Building damage ×2; hold 15 s to win. Hard cap at 20:00"],
};

/** Beta: a banner for a few seconds when a Surge starts. */
export function SurgeBanner({ stage }: { stage: number }) {
  const t = STAGE_TEXT[stage];
  if (!t) return null;
  return (
    <div key={stage} style={{ position: "absolute", left: 0, right: 0, top: HUD_BAR_HEIGHT + 56, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 11 }}>
      <div className="g-glass strong g-enter" style={{ padding: "10px 22px", textAlign: "center" }}>
        <div className="g-title" style={{ fontSize: 26, color: "var(--accent)" }}>{t[0]}</div>
        <div className="g-sub" style={{ color: "var(--ink)", marginTop: 2 }}>{t[1]}</div>
      </div>
    </div>
  );
}

const NODE_TIP_SEEN = "cf.tip.nodes";
/** Beta: shown once (per browser) the first time a contested node is held. */
export function nodeTipWanted(): boolean {
  try { return tipsEnabled() && window.localStorage.getItem(NODE_TIP_SEEN) !== "1"; } catch { return false; }
}
export function NodeTip({ onClose }: { onClose: () => void }) {
  const close = () => {
    try { window.localStorage.setItem(NODE_TIP_SEEN, "1"); } catch { /* storage blocked */ }
    onClose();
  };
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: HUD_BAR_HEIGHT + 10, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 12 }}>
      <div className="g-glass strong g-enter" style={{ padding: "8px 10px 8px 16px", display: "flex", gap: 10, alignItems: "center", pointerEvents: "auto" }}>
        <span className="g-sub" style={{ color: "var(--ink)" }}>A combat unit next to a contested node holds it. Hold most of them to fill your bar; a full bar wins.</span>
        <IconBtn icon="close" title="Got it" small onClick={close} />
      </div>
    </div>
  );
}

export function HudTopBar({ me, them, tick, resources, supply, maxSupply, nodes, beta, surge, view3d, onToggle3d, onSettings }: {
  me: { name: string; score?: number; team: Team };
  them: { name: string; score?: number; team: Team };
  tick: number;
  /** Economy is left out for replays (observer). */
  resources?: number;
  supply?: number;
  maxSupply?: number;
  nodes: NodesInfo | null;
  /** Beta-ruleset match: shows the DEV BETA badge and the per-side control bars. */
  beta?: boolean;
  /** Beta: countdown to the next Surge or the hard cap. */
  surge?: SurgeClock | null;
  view3d: boolean;
  onToggle3d: () => void;
  onSettings: () => void;
}) {
  const nodesTint = nodes?.holder === "me" ? "var(--good)" : nodes?.holder === "them" ? "var(--bad)" : undefined;
  return (
    <div className="g-glass strong" style={{
      position: "absolute", top: 0, left: 0, right: 0, height: HUD_BAR_HEIGHT, clipPath: "none", borderWidth: "0 0 1px 0",
      display: "grid", gridTemplateColumns: "minmax(0,1fr) auto minmax(0,1fr)", alignItems: "center", gap: 16, padding: "0 10px 0 18px",
      pointerEvents: "auto", zIndex: 5,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, minWidth: 0 }}>
        <Side {...me} />
        <span className="g-label" style={{ color: "var(--ink-faint)" }}>vs</span>
        <Side {...them} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        {resources !== undefined && <Stat label="Crystal" value={resources} tint="var(--accent)" />}
        {supply !== undefined && <Stat label="Supply" value={`${supply}/${maxSupply ?? 0}`} tint={supply >= (maxSupply ?? 0) ? "var(--warn)" : undefined} />}
        {nodes && beta && <ControlBars nodes={nodes} me={me.team} them={them.team} />}
        {nodes && !beta && (
          <Stat label="Nodes" tint={nodesTint}
            title={`Contested nodes held: you ${nodes.mine}, opponent ${nodes.theirs}. Hold ${nodes.need} to start the countdown. Countdown: you ${nodes.myPct}%, opponent ${nodes.theirPct}%.`}
            value={<>{nodes.mine}:{nodes.theirs}<span style={{ color: "var(--ink-faint)", fontSize: 12 }}> /{nodes.need}</span>{nodes.holder && <span style={{ fontSize: 12 }}> · {nodes.holder === "me" ? nodes.myPct : nodes.theirPct}%</span>}</>} />
        )}
        <Stat label="Time" value={clock(tick)} />
        {surge && <Stat label={`${surge.next} in`} value={clock(surge.inTicks)} tint={surge.inTicks <= 600 ? "var(--warn)" : "var(--ink-dim)"} />}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
        {beta && <BetaBadge style={{ marginRight: 6 }} />}
        <button type="button" className="g-btn small" title="Switch 3D / 2D view (F3)" onClick={onToggle3d} style={{ minWidth: 44 }}>
          {view3d ? "3D" : "2D"}
        </button>
        <SoundToggle small />
        <IconBtn icon="gear" title="Settings (Esc)" small onClick={onSettings} />
      </div>
    </div>
  );
}

export interface CommandSlot { key: string; label: string; cost?: number; enabled: boolean }
export interface SelectionInfo { name: string; count: number; hp?: number; maxHp?: number; status?: string; enemy?: boolean }

/** Selection panel plus the QWER / ASDF command card. Slots can be clicked as well as keyed. */
export function CommandCard({ slots, selection, flash, resources, onPress }: {
  slots: CommandSlot[];
  selection: SelectionInfo | null;
  flash: string | null;
  resources: number;
  onPress: (key: string) => void;
}) {
  if (!selection) return null;
  const hpFrac = selection.hp !== undefined && selection.maxHp ? Math.max(0, Math.min(1, selection.hp / selection.maxHp)) : null;
  const anyCommand = slots.some((s) => s.enabled);
  return (
    <div className="g-glass strong g-enter" style={{ position: "absolute", left: 10, bottom: 10, width: 372, padding: 12, pointerEvents: "auto", zIndex: 10 }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span className="g-title" style={{ fontSize: 16, color: selection.enemy ? "var(--bad)" : "var(--ink)" }}>
          {selection.count > 1 ? `${selection.count} selected` : selection.name}
        </span>
        {selection.status && <span className="g-label" style={{ color: "var(--accent)", letterSpacing: "0.12em" }}>{selection.status}</span>}
      </div>
      {hpFrac !== null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.1)" }}>
            <div style={{ width: `${hpFrac * 100}%`, height: "100%", background: hpFrac > 0.5 ? "var(--good)" : hpFrac > 0.25 ? "var(--warn)" : "var(--bad)" }} />
          </div>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-dim)" }}>{Math.floor(selection.hp!)}/{selection.maxHp}</span>
        </div>
      )}
      {anyCommand && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 5, marginTop: 10 }}>
          {slots.map((s) => {
            const short = s.cost !== undefined && s.cost > resources;
            return (
              <button key={s.key} type="button" disabled={!s.enabled} onClick={() => onPress(s.key)}
                title={s.enabled ? `${s.label}${s.cost !== undefined ? ` · ${s.cost} crystal` : ""} (${s.key.toUpperCase()})` : undefined}
                style={{
                  position: "relative", height: 54, padding: "5px 6px", textAlign: "left", cursor: s.enabled ? "pointer" : "default",
                  display: "flex", flexDirection: "column", justifyContent: "space-between",
                  background: flash === s.key ? "var(--accent)" : s.enabled ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.02)",
                  color: flash === s.key ? "var(--accent-ink)" : "var(--ink)",
                  border: `1px solid ${s.enabled ? "var(--edge)" : "rgba(255,255,255,0.05)"}`, clipPath: "var(--notch-s)",
                  opacity: s.enabled ? (short ? 0.55 : 1) : 0.5,
                }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: flash === s.key ? "inherit" : "var(--accent)" }}>{s.key.toUpperCase()}</span>
                <span style={{ fontFamily: "var(--ui)", fontSize: 11.5, fontWeight: 600, lineHeight: 1.1 }}>{s.label}</span>
                {s.cost !== undefined && (
                  <span style={{ position: "absolute", top: 5, right: 6, fontFamily: "var(--mono)", fontSize: 10, color: short ? "var(--bad)" : "var(--ink-dim)" }}>{s.cost}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TIP_SEEN = "cf.tipSeen";

/** One-time tip for a player's first match (off when tips are disabled in Settings). */
export function FirstMatchTip() {
  const [show, setShow] = useState(() => {
    try { return tipsEnabled() && window.localStorage.getItem(TIP_SEEN) !== "1"; } catch { return false; }
  });
  if (!show) return null;
  const close = () => {
    setShow(false);
    try { window.localStorage.setItem(TIP_SEEN, "1"); } catch { /* storage blocked */ }
  };
  return (
    // Centred by a wrapper: the enter animation owns the panel's transform.
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 112, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 12 }}>
    <div className="g-glass strong g-enter" style={{ width: "min(480px, 92%)", padding: "12px 14px 12px 18px", display: "flex", gap: 12, alignItems: "flex-start", pointerEvents: "auto" }}>
      <div className="g-sub" style={{ color: "var(--ink)", flex: 1 }}>
        <b>Left-drag</b> to select. <b>Right-click</b> to move, gather or attack. Workers build with <span className="g-kbd">Q W E R</span>.
        Hold most contested nodes, or destroy the enemy Crystal. <span className="g-kbd">Esc</span> opens Settings.
      </div>
      <IconBtn icon="close" title="Got it" small onClick={close} />
    </div>
    </div>
  );
}

const SPEEDS: Array<[number, ReactNode, string]> = [
  [-8, <><Icon name="rewind" size={14} />8×</>, "8× reverse"],
  [-1, <Icon name="rewind" size={14} />, "Reverse"],
  [0, <Icon name="pause" size={14} />, "Pause"],
  [1, <Icon name="play" size={14} />, "Play"],
  [4, <><Icon name="forward" size={14} />4×</>, "4× forward"],
  [8, <><Icon name="forward" size={14} />8×</>, "8× forward"],
];

export function ReplayBar({ speed, onSpeed, frame, total, buffered, onSeek, onStop }: {
  speed: number;
  onSpeed?: (s: number) => void;
  frame: number;
  total?: number;
  buffered: number;
  onSeek?: (f: number) => void;
  onStop?: () => void;
}) {
  const live = buffered > 0 && frame >= buffered - Math.abs(speed) - 1;
  return (
    <div className="g-glass strong" style={{ position: "absolute", top: HUD_BAR_HEIGHT + 10, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", pointerEvents: "auto", zIndex: 8 }}>
      <span className="g-label" style={{ color: "var(--accent)", marginRight: 6 }}>Replay</span>
      {SPEEDS.map(([s, icon, title]) => (
        <button key={s} type="button" title={title} onClick={() => onSpeed?.(s)} className={`g-btn small${speed === s ? " primary" : ""}`}
          style={{ minWidth: 38, padding: "6px 8px", gap: 3 }}>{icon}</button>
      ))}
      {total != null && total > 1 && onSeek && (
        <input type="range" className="g-range" min={0} max={total - 1} value={frame} title="Scrub"
          // Seeking is clamped to the frames already streamed from the server.
          onChange={(e) => { onSpeed?.(0); onSeek(Math.max(0, Math.min(Number(e.target.value), buffered - 1))); }}
          style={{ width: 200, margin: "0 6px" }} />
      )}
      <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-dim)", minWidth: 40, textAlign: "right" }}>
        {total ? `${Math.round((100 * frame) / Math.max(1, total - 1))}%` : frame}
      </span>
      <span className="g-label" style={{ color: "var(--accent)", width: 40, opacity: live ? 1 : 0 }}>Live</span>
      <button type="button" className="g-btn small" onClick={onStop}><Icon name="close" size={14} />Exit</button>
    </div>
  );
}

/** Synchronised loading screen (G-12, UI-5): both players, each Loading or Ready. */
export function MatchLoading({ visible, title, mapName, players }: {
  visible: boolean;
  title: string;
  mapName: string;
  players: Array<{ name: string; team: Team; ready: boolean; you?: boolean }>;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000, background: "radial-gradient(ellipse at 50% 40%, #0d1220 0%, #05060a 70%)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 28,
      opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none", transition: "opacity 0.6s ease",
    }}>
      <Wordmark size={44} />
      <div style={{ textAlign: "center" }}>
        <div className="g-label">{mapName}</div>
        <div className="g-title g-pulse" style={{ fontSize: 22, marginTop: 8 }}>{title}</div>
      </div>
      {players.length > 0 && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center" }}>
          {players.map((p, i) => (
            <div key={i} className="g-glass" style={{ width: 230, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, borderLeft: `3px solid ${TEAM[p.team]}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="g-title" style={{ fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                <div className="g-label" style={{ marginTop: 3, color: "var(--ink-faint)" }}>{p.you ? "You" : "Opponent"}</div>
              </div>
              <span className="g-label" style={{ display: "flex", alignItems: "center", gap: 6, color: p.ready ? "var(--good)" : "var(--ink-dim)" }}>
                {p.ready ? <><Icon name="check" size={14} />Ready</> : <span className="g-pulse">Loading</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A neural opponent's read of its opponent (server: headless/src/v2/neural.ts `readOpponent`). */
export interface BotRead {
  tick: number;
  units: Record<string, number>;
  buildings: Record<string, number>;
  army: { anchor: string; p: number };
}

const READ_NAMES: Record<string, [string, string]> = {
  worker: ["worker", "workers"], skirmisher: ["skirmisher", "skirmishers"], gunner: ["gunner", "gunners"], bruiser: ["bruiser", "bruisers"],
  medic: ["medic", "medics"], bulwark: ["bulwark", "bulwarks"], outrider: ["outrider", "outriders"], barracks: ["barracks", "barracks"], foundry: ["foundry", "foundries"],
  supply_depot: ["depot", "depots"], turret: ["turret", "turrets"], outpost: ["outpost", "outposts"],
};

/** Anchor names are in the bot's frame ("own_base" is the bot's base). */
function armyWhere(anchor: string, your: string): string {
  const a = anchor.replace(/\[\d+\]$/, "");
  switch (a) {
    case "own_base": case "own_pockets": return "near the bot's base";
    case "own_chokes": return "at the bot's chokepoints";
    case "own_safe": return "at the bot's safe nodes";
    case "centre": return "mid-map";
    case "nodes": return "at the contested nodes";
    case "enemy_base": case "enemy_pockets": return `near ${your} base`;
    case "enemy_chokes": return `at ${your} chokepoints`;
    case "enemy_safe": return `at ${your} safe nodes`;
    default: return "not seen";
  }
}

function countList(xs: Record<string, number>): string {
  const parts = Object.entries(xs).filter(([, v]) => v >= 0.5).map(([k, v]) => {
    const n = Math.round(v);
    const [one, many] = READ_NAMES[k] ?? [k, k];
    return `${n} ${n === 1 ? one : many}`;
  });
  return parts.length ? parts.join(", ") : "none";
}

/** What a neural bot believes about its opponent (live: Settings toggle; replays: always). */
export function BotReadPanel({ read, you }: { read: BotRead; you: boolean }) {
  const your = you ? "your" : "the player's";
  return (
    <div className="g-glass strong" style={{ position: "absolute", top: HUD_BAR_HEIGHT + 10, right: 10, width: 260, padding: "10px 14px", zIndex: 6, pointerEvents: "none" }}>
      <div className="g-label" style={{ marginBottom: 6 }}>{you ? "Bot's read of you" : "Bot's read of the player"}</div>
      <div className="g-sub" style={{ color: "var(--ink)", fontSize: 12, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 4 }}>
        <span className="g-label" style={{ fontSize: 9 }}>Units</span><span>{countList(read.units)}</span>
        <span className="g-label" style={{ fontSize: 9 }}>Buildings</span><span>{countList(read.buildings)}</span>
        <span className="g-label" style={{ fontSize: 9 }}>Army</span>
        <span>{armyWhere(read.army.anchor, your)} <span style={{ color: "var(--ink-faint)" }}>({Math.round(read.army.p * 100)}%)</span></span>
      </div>
    </div>
  );
}
