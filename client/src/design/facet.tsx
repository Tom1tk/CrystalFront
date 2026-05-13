// ═══════════════════════════════════════════════════════════════
// CrystalFront FACET Design System
//   Palette · Fonts · Clip paths · Reusable UI primitives
// Derived from direction-facet.jsx design handoff
// ═══════════════════════════════════════════════════════════════

import { CSSProperties, ReactNode } from "react";

// ─── PALETTE ─────────────────────────────────────────────────
// PRISM cold-crystalpunk: deep bg, ice cyan, magenta enemy
export const FCT = {
  bg: "#05060a",
  bgPanel: "#0a0c14",
  bgPanelHi: "#0f1320",
  bgEnemy: "#1a0e18",
  ink: "#e8ecf5",
  inkDim: "#7c83a3",
  inkFaint: "#3a3f55",
  line: "rgba(180,200,255,0.10)",
  lineHi: "rgba(180,200,255,0.22)",
  ice: "#7ce8ff",
  iceDeep: "#3aa8c8",
  red: "#ff5cf3",
  amber: "#ffb86b",
  green: "#7cffb0",
  display: '"Space Grotesk", system-ui, sans-serif',
  ui: '"Inter Tight", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
} as const;

// ─── CLIP PATHS ──────────────────────────────────────────────
export const HEX_CLIP = "polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)";
export const NOTCH_R = "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)";
export const NOTCH_L = "polygon(0 0, 100% 0, 100% 100%, 18px 100%, 0 calc(100% - 18px))";

// ─── ANIMATION CSS INJECTION ────────────────────────────────
// Injects keyframes + utility classes once per FctFrame mount.
// Classes: fct-glow (stat counters), fct-breathe (friendly auras),
//   fct-furnace (foundry hearth), fct-ready (ready badge pulse),
//   fct-vp (minimap viewport scan), fct-svg-pulse / fct-svg-pulse-fast.
// fct-flicker / fct-shimmer-c / fct-shimmer-m are reserved for
// the wordmark/headlines via the Refract flicker prop (disabled).
export function FctStyles() {
  return (
    <style>{`
@keyframes fct-flicker {
  0%, 6%, 11%, 38%, 43%, 70%, 71.4%, 73%, 100% { opacity: 1; filter: brightness(1); }
  8%, 10%      { opacity: 0.72; filter: brightness(0.82); }
  40%          { opacity: 0.58; filter: brightness(0.7); }
  70.6%, 71%   { opacity: 0.42; filter: brightness(0.6); }
  72%          { opacity: 0.86; filter: brightness(0.9); }
}
@keyframes fct-shimmer-c {
  0%, 100% { transform: translate(-1.5px, 0); opacity: 0.85; }
  50%      { transform: translate(-3px,   0); opacity: 1;    }
}
@keyframes fct-shimmer-m {
  0%, 100% { transform: translate(1.5px, 0); opacity: 0.85; }
  50%      { transform: translate(3px,   0); opacity: 1;    }
}
@keyframes fct-breathe { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.95; } }
@keyframes fct-furnace { 0%, 100% { opacity: 0.7;  } 50% { opacity: 1;    } }
@keyframes fct-glow {
  0%, 100% { text-shadow: 0 0 6px  rgba(124,232,255,0);    }
  50%      { text-shadow: 0 0 14px rgba(124,232,255,0.42); }
}
@keyframes fct-vp {
  0%, 100% { box-shadow: 0 0 6px  rgba(124,232,255,0.30), inset 0 0 4px rgba(124,232,255,0.15); }
  50%      { box-shadow: 0 0 14px rgba(124,232,255,0.62), inset 0 0 8px rgba(124,232,255,0.38); }
}
@keyframes fct-ready { 0%, 100% { opacity: 0.75; } 50% { opacity: 1; } }
@keyframes fct-svg-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
.fct-glow   { animation: fct-glow   4s   ease-in-out infinite; }
.fct-breathe{ animation: fct-breathe 4s   ease-in-out infinite; }
.fct-furnace{ animation: fct-furnace 1.8s ease-in-out infinite; }
.fct-ready  { animation: fct-ready  1.6s ease-in-out infinite; }
.fct-vp     { animation: fct-vp     3.2s ease-in-out infinite; }
.fct-svg-pulse     { animation: fct-svg-pulse 4s   ease-in-out infinite; }
.fct-svg-pulse-fast{ animation: fct-svg-pulse 2.4s ease-in-out infinite; }
`}</style>
  );
}

// ─── REFRACT EFFECT ──────────────────────────────────────────
// Chromatic-split headline: cyan left / magenta right offset.
// `flicker` adds slow brightness wobble (NOT applied — reserved
// for wordmark/headlines per user preference).
export function Refract({
  children,
  accent = false,
  offset = 1.5,
  style,
}: {
  children: ReactNode;
  accent?: boolean;
  offset?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        color: accent ? FCT.ice : FCT.ink,
        lineHeight: "inherit",
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          color: FCT.ice,
          transform: `translate(${-offset}px,0)`,
          mixBlendMode: "screen",
          opacity: 0.85,
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        {children}
      </span>
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          color: FCT.red,
          transform: `translate(${offset}px,0)`,
          mixBlendMode: "screen",
          opacity: 0.85,
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        {children}
      </span>
      <span style={{ position: "relative", userSelect: "text" }}>{children}</span>
    </span>
  );
}

// ─── WORDMARK SVG ───────────────────────────────────────────
export function FctMark({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 64 74" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id="fctmg" x1="0" y1="0" x2="0" y2="74">
          <stop offset="0" stopColor={FCT.ice} />
          <stop offset="1" stopColor={FCT.iceDeep} />
        </linearGradient>
      </defs>
      <path d="M32 2 L60 18 L60 52 L32 72 L4 52 L4 18 Z" fill="url(#fctmg)" />
      <path d="M32 2 L60 18 L32 36 L4 18 Z" fill="rgba(255,255,255,0.18)" />
      <path d="M32 36 L32 72 L4 52 Z" fill="rgba(0,0,0,0.25)" />
      <path d="M32 12 L48 22 L32 32 L16 22 Z" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
    </svg>
  );
}

// ─── FRAME CHROME ───────────────────────────────────────────
// Top bar with wordmark + screen label
export function FctFrame({
  children,
  top,
  stage = "",
  version,
  style,
}: {
  children: ReactNode;
  top: string;
  stage?: string;
  version?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: FCT.bg,
        color: FCT.ink,
        fontFamily: FCT.ui,
        position: "relative",
        overflow: "hidden",
        backgroundImage: `radial-gradient(circle at 10% 0%, rgba(124,232,255,0.08), transparent 40%), radial-gradient(circle at 90% 100%, rgba(255,92,243,0.06), transparent 50%)`,
        ...style,
      }}
    >
      <FctStyles />
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "repeating-linear-gradient(135deg, rgba(140,180,220,0.025) 0 2px, transparent 2px 16px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 36,
          background: FCT.bgPanel,
          borderBottom: `1px solid ${FCT.lineHi}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
          fontFamily: FCT.mono,
          fontSize: 10,
          letterSpacing: "0.28em",
          color: FCT.inkDim,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <FctMark size={18} />
          <span style={{ color: FCT.ink }}>{top}</span>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          {stage && <span>{stage}</span>}
          <span>{version ?? ""}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

// ─── BUTTON ─────────────────────────────────────────────────
export function FctBtn({
  children,
  primary,
  danger,
  sub,
  full,
  disabled,
  onClick,
  style,
}: {
  children: ReactNode;
  primary?: boolean;
  danger?: boolean;
  sub?: string;
  full?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const bg = disabled
    ? FCT.bgPanel
    : primary
      ? FCT.ice
      : danger
        ? FCT.bgPanel
        : FCT.bgPanelHi;
  const fg = disabled
    ? FCT.inkFaint
    : primary
      ? "#00121b"
      : danger
        ? FCT.red
        : FCT.ink;
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        cursor: disabled ? "default" : "pointer",
        border: "none",
        clipPath: NOTCH_R,
        padding: "14px 22px 14px 18px",
        background: bg,
        color: fg,
        fontFamily: FCT.display,
        fontSize: 14,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
        width: full ? "100%" : "auto",
        boxShadow: primary && !disabled ? `inset 0 -3px 0 ${FCT.iceDeep}` : "none",
        fontWeight: 600,
        ...style,
      }}
    >
      <span>{children}</span>
      {sub && (
        <span
          style={{
            fontFamily: FCT.mono,
            fontSize: 9,
            opacity: 0.7,
            fontWeight: 400,
            letterSpacing: "0.2em",
          }}
        >
          {sub}
        </span>
      )}
    </button>
  );
}

// ─── PANEL ───────────────────────────────────────────────────
export function FctPanel({
  children,
  clip,
  accent,
  style,
}: {
  children: ReactNode;
  clip?: string;
  accent?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: FCT.bgPanel,
        clipPath: clip ?? HEX_CLIP,
        position: "relative",
        border: `1px solid ${FCT.line}`,
        ...style,
      }}
    >
      {accent && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: accent,
          }}
        />
      )}
      {children}
    </div>
  );
}

// ─── STAT DISPLAY (economy) ─────────────────────────────────
export function FctStat({
  icon,
  label,
  value,
  tint,
}: {
  icon: string;
  label: string;
  value: string | number;
  tint?: string;
}) {
  return (
    <div
      style={{
        background: FCT.bgPanel,
        padding: "6px 16px",
        clipPath: HEX_CLIP,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        border: `1px solid ${FCT.line}`,
      }}
    >
      <span
        style={{
          fontFamily: FCT.mono,
          fontSize: 9,
          color: FCT.inkDim,
          letterSpacing: "0.22em",
        }}
      >
        <span style={{ color: tint || FCT.ice, marginRight: 4 }}>{icon}</span>
        {label}
      </span>
      <span
        style={{
          fontFamily: FCT.display,
          fontSize: 20,
          letterSpacing: "-0.01em",
          color: tint || FCT.ink,
          fontWeight: 700,
          animation: "fct-glow 4s ease-in-out infinite",
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ─── DEBUG BUTTON ────────────────────────────────────────────
export function DbgBtn({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: 11,
        fontFamily: FCT.mono,
        background: active ? "rgba(124,232,255,0.22)" : "rgba(120,120,140,0.12)",
        color: active ? FCT.ice : FCT.inkDim,
        border: `1px solid ${active ? FCT.ice : "rgba(120,120,140,0.25)"}`,
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ─── TEAM COLOR HELPERS ─────────────────────────────────────
// Maps 'me'/'enemy' owner to the FACET ice/magenta palette.
export const teamFill = (owner: string) =>
  owner === "me" ? FCT.ice : FCT.red;
export const teamStroke = (owner: string) =>
  owner === "me" ? "rgba(124,232,255,0.85)" : "rgba(255,140,240,0.85)";
export const teamWash = (owner: string) =>
  owner === "me" ? "rgba(124,232,255,0.18)" : "rgba(255,92,243,0.18)";

// ─── SELECTION HALO ─────────────────────────────────────────
// Yellow pulse ring around selected entities (SVG-safe).
export function Halo({ r }: { r: number }) {
  return (
    <circle
      r={r}
      fill="none"
      stroke="#ffff44"
      strokeWidth="2"
      style={{ animation: "fct-svg-pulse 2.4s ease-in-out infinite" }}
    />
  );
}

// ─── UNIT/BUILDING SILHOUETTES (SVG reference) ──────────────
// These match the Sh* components from the FACET direction design.
// They are exported for potential future SVG-based rendering
// but serve primarily as the design specification for unit shapes.
// Current rendering is on Canvas 2D (see GameShell drawEntity).

export function ShCrystal({
  x,
  y,
  owner = "me",
}: {
  x: number;
  y: number;
  owner?: string;
}) {
  return (
    <g transform={`translate(${x},${y})`}>
      <polygon
        points="0,-30 22,-10 17,22 -17,22 -22,-10"
        fill={teamWash(owner)}
        style={{ animation: "fct-svg-pulse 4s ease-in-out infinite" }}
      />
      <polygon
        points="0,-22 18,-8 14,18 -14,18 -18,-8"
        fill={teamFill(owner)}
        stroke={teamStroke(owner)}
        strokeWidth="2"
      />
      <polygon points="0,-22 9,-4 -9,-4" fill="rgba(255,255,255,0.45)" />
      <line
        x1="-18" y1="-8" x2="18" y2="-8"
        stroke="#001321" strokeOpacity="0.55" strokeWidth="0.8"
      />
      <line
        x1="0" y1="-22" x2="0" y2="18"
        stroke="#001321" strokeOpacity="0.45" strokeWidth="0.8"
      />
      <line
        x1="-14" y1="18" x2="0" y2="-4"
        stroke="#001321" strokeOpacity="0.4" strokeWidth="0.6"
      />
      <line
        x1="14" y1="18" x2="0" y2="-4"
        stroke="#001321" strokeOpacity="0.4" strokeWidth="0.6"
      />
    </g>
  );
}
