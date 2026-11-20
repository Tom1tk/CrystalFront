/** "DEV BETA 0.9.x" marker for beta-ruleset matches and lobbies (mainline 0.10 plan §1). */
declare const __APP_VERSION__: string;

export const BETA_LABEL = `DEV BETA ${__APP_VERSION__.replace(/-ML$/, "")}`;

export default function BetaBadge({ style }: { style?: React.CSSProperties }) {
  return (
    <span className="g-label" title="Beta rules: the next version, for dev testing only" style={{
      padding: "3px 8px", borderRadius: 6, background: "rgba(255, 170, 40, 0.18)", border: "1px solid rgba(255, 170, 40, 0.6)",
      color: "#ffc766", whiteSpace: "nowrap", ...style,
    }}>{BETA_LABEL}</span>
  );
}
