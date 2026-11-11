/**
 * "Facet, lit" UI kit (G-12): small React wrappers around the classes in glass.css.
 * Panels are translucent glass over the live 3D scene; the accent colour follows the
 * current map theme (see setAccent).
 */
import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { audioPrefs, onAudioPrefs, setAudioPrefs } from "../audio";
import type { ThemeId } from "../mapThemes";

const ACCENT: Record<ThemeId, string> = {
  verdant: "#8fe36c",
  desert: "#ffc266",
  haunted: "#c6a6ff",
  frost: "#8fe6ff",
};

/** Set the UI accent colour (CSS `--accent`) to match a map theme. */
export function setAccent(theme: ThemeId) {
  document.documentElement.style.setProperty("--accent", ACCENT[theme]);
}

// ─── icons (inline SVG, 20 px, currentColor) ────────────────────
const P: Record<string, ReactNode> = {
  sound: <><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" /></>,
  mute: <><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" /></>,
  gear: <><circle cx="12" cy="12" r="3.2" fill="none" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" fill="none" /></>,
  back: <path d="M15 5l-7 7 7 7" fill="none" />,
  close: <path d="M6 6l12 12M18 6L6 18" fill="none" />,
  play: <path d="M7 5l12 7-12 7z" />,
  pause: <><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></>,
  rewind: <path d="M12 6l-8 6 8 6zM20 6l-8 6 8 6z" />,
  forward: <path d="M4 6l8 6-8 6zM12 6l8 6-8 6z" />,
  cube: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="none" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" /></>,
  flag: <><path d="M5 21V4M5 4h11l-2 4 2 4H5" fill="none" /></>,
  film: <><rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" /><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" fill="none" /></>,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  users: <><circle cx="9" cy="8" r="3.5" fill="none" /><path d="M2.5 20c.5-4 3-6 6.5-6s6 2 6.5 6M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.4c2 .8 3.2 2.6 3.5 5.6" fill="none" /></>,
  bot: <><rect x="4" y="8" width="16" height="11" rx="2" fill="none" /><path d="M12 4v4M9 13h.01M15 13h.01" fill="none" /></>,
  wrench: <path d="M14.5 4a4.5 4.5 0 0 0-4.2 6.1L3.5 17l3.5 3.5 6.9-6.8A4.5 4.5 0 0 0 20 9.5l-2.9 2.9-3-.5-.5-3L16.5 6A4.5 4.5 0 0 0 14.5 4z" fill="none" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" />,
  clock: <><circle cx="12" cy="12" r="8.5" fill="none" /><path d="M12 7v5l3.5 2" fill="none" /></>,
  crystal: <path d="M12 2.5l6 7-6 12-6-12z" fill="none" />,
  star: <path d="M12 3.5l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.8l-5.4 2.9 1.2-5.9-4.4-4.1 6-.7z" fill="none" />,
};
export type IconName = keyof typeof P;

export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }} aria-hidden>
      {P[name]}
    </svg>
  );
}

// ─── controls ───────────────────────────────────────────────────
export function IconBtn({ icon, title, onClick, on, small, onPointerDown, style }: {
  icon: IconName; title: string; onClick?: () => void; on?: boolean; small?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void; style?: CSSProperties;
}) {
  return (
    <button type="button" className={`g-icon-btn${on ? " on" : ""}${small ? " small" : ""}`} title={title}
      aria-label={title} onClick={onClick} onPointerDown={onPointerDown} style={style}>
      <Icon name={icon} size={small ? 16 : 20} />
    </button>
  );
}

/** The audio prefs as React state (re-renders when any screen changes them). */
export function useAudioPrefs() {
  const [p, setP] = useState(audioPrefs);
  useEffect(() => onAudioPrefs(() => setP(audioPrefs())), []);
  return p;
}

/** Mute toggle. Acts on pointer-down, before the same gesture can start the music. */
export function SoundToggle({ small, style }: { small?: boolean; style?: CSSProperties }) {
  const { muted } = useAudioPrefs();
  return (
    <IconBtn icon={muted ? "mute" : "sound"} title={muted ? "Sound off (click to turn on)" : "Sound on (click to mute)"}
      small={small} style={style}
      onPointerDown={(e) => { if (e.button === 0) setAudioPrefs({ muted: !muted }); }}
      onClick={() => { /* handled on pointer-down; keyboard activation lands here */ }}
    />
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`g-toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

/** One settings row: name and help text on the left, a control on the right. */
export function Row({ name, help, children }: { name: string; help?: string; children: ReactNode }) {
  return (
    <div className="g-row">
      <div className="g-row-text">
        <span className="g-row-name">{name}</span>
        {help && <span className="g-sub" style={{ fontSize: 12 }}>{help}</span>}
      </div>
      {children}
    </div>
  );
}

export function Slider({ value, onChange, label, disabled }: { value: number; onChange: (v: number) => void; label: string; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <input type="range" className="g-range" min={0} max={100} step={1} value={Math.round(value * 100)} aria-label={label}
        disabled={disabled} onChange={(e) => onChange(Number(e.target.value) / 100)} />
      <span className="g-label" style={{ width: 34, textAlign: "right" }}>{Math.round(value * 100)}</span>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, vertical, style }: {
  tabs: Array<{ id: T; label: string; icon?: IconName }>; value: T; onChange: (t: T) => void; vertical?: boolean; style?: CSSProperties;
}) {
  return (
    <div className={`g-tabs${vertical ? " vertical" : ""}`} role="tablist" style={style}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={`g-tab${t.id === value ? " on" : ""}`}
          onClick={() => onChange(t.id)} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {t.icon && <Icon name={t.icon} size={16} />}{t.label}
        </button>
      ))}
    </div>
  );
}

/** Centred modal over a dimmed scrim. Esc or a click on the scrim closes it. */
export function Modal({ title, onClose, children, width }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);
  return (
    <div className="g-modal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="g-glass strong g-modal g-enter" role="dialog" aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px 12px 22px" }}>
          <span className="g-title" style={{ fontSize: 22 }}>{title}</span>
          <IconBtn icon="close" title="Close (Esc)" small onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

/** Large page title with the small mono label above it. */
export function PageTitle({ label, title, right }: { label: string; title: string; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
      <div>
        <div className="g-label">{label}</div>
        <div className="g-title" style={{ fontSize: 34, marginTop: 4 }}>{title}</div>
      </div>
      {right}
    </div>
  );
}

/** "CrystalFront" word mark for the menus and boot screen. */
export function Wordmark({ size = 64 }: { size?: number }) {
  return (
    <div className="g-title" style={{ fontSize: size, lineHeight: 0.9, letterSpacing: "-0.045em", textTransform: "uppercase", textShadow: "0 2px 24px rgba(0,0,0,0.45)" }}>
      Crystal<span style={{ color: "var(--accent)", fontStyle: "italic" }}>Front</span>
    </div>
  );
}
