import { useEffect, useState } from "react";
import { FCT, FctFrame, FctPanel, FctBtn, HEX_CLIP } from "../design/facet";

interface ReplayMeta {
  id: string;
  seed: number;
  blue: string;
  red: string;
  outcome: { winner: string | null; ticks: number };
  durationSecs: number;
  version: string;
  timestamp: number;
}

interface ReplayBrowserProps {
  onBack: () => void;
  onWatch: (replayId: string) => void;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

function outcomeLabel(meta: ReplayMeta): { text: string; color: string } {
  const w = meta.outcome.winner;
  if (!w) return { text: "Draw", color: FCT.inkDim };
  if (w.includes("blue")) return { text: `${meta.blue} (blue) wins`, color: FCT.ice };
  return { text: `${meta.red} (red) wins`, color: FCT.red };
}

export default function ReplayBrowser({ onBack, onWatch }: ReplayBrowserProps) {
  const [replays, setReplays] = useState<ReplayMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/replays")
      .then(r => r.json())
      .then(d => { setReplays(d.replays ?? []); setLoading(false); })
      .catch(() => { setError("Could not load replays."); setLoading(false); });
  }, []);

  return (
    <FctFrame top="BOT REPLAYS">
      <div style={{
        position: "absolute", top: 36, left: 0, right: 0, bottom: 0,
        padding: 40, display: "flex", flexDirection: "column", gap: 16,
      }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{
            fontFamily: FCT.mono, fontSize: 9, color: FCT.inkDim, letterSpacing: "0.28em",
          }}>
            ▰ HEADLESS MATCH REPLAYS · {replays.length} FILE{replays.length !== 1 ? "S" : ""}
          </div>
          <FctBtn sub="ESC" onClick={onBack} style={{ padding: "6px 18px" }}>
            ← Back
          </FctBtn>
        </div>

        {/* Table */}
        <FctPanel clip={HEX_CLIP} style={{ flex: 1, overflow: "hidden", padding: 0 }}>
          {/* Column headers */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "90px 80px 90px 90px 1fr 70px 70px",
            padding: "10px 16px",
            borderBottom: `1px solid ${FCT.lineHi}`,
            fontFamily: FCT.mono,
            fontSize: 8,
            color: FCT.inkFaint,
            letterSpacing: "0.26em",
          }}>
            <span>SEED</span>
            <span>DURATION</span>
            <span>BLUE</span>
            <span>RED</span>
            <span>OUTCOME</span>
            <span>VER</span>
            <span />
          </div>

          {/* Rows */}
          <div style={{ overflowY: "auto", maxHeight: "calc(100% - 40px)" }}>
            {loading && (
              <div style={{ padding: 24, textAlign: "center", fontFamily: FCT.mono, fontSize: 10, color: FCT.inkFaint }}>
                Loading…
              </div>
            )}
            {error && (
              <div style={{ padding: 24, textAlign: "center", fontFamily: FCT.mono, fontSize: 10, color: FCT.red }}>
                {error}
              </div>
            )}
            {!loading && !error && replays.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", fontFamily: FCT.mono, fontSize: 10, color: FCT.inkFaint }}>
                No replays yet. Run the CLI to generate some:
                <br />
                <span style={{ color: FCT.ice, fontSize: 9, marginTop: 8, display: "block" }}>
                  tsx headless/src/cli.ts --blue rush --red idle
                </span>
              </div>
            )}
            {replays.map((r, i) => {
              const { text: outcomeText, color: outcomeColor } = outcomeLabel(r);
              return (
                <div
                  key={r.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "90px 80px 90px 90px 1fr 70px 70px",
                    padding: "10px 16px",
                    borderBottom: i < replays.length - 1 ? `1px solid ${FCT.line}` : undefined,
                    alignItems: "center",
                    background: i % 2 === 0 ? "transparent" : FCT.bgPanelHi,
                    transition: "background 0.1s",
                  }}
                >
                  <span style={{ fontFamily: FCT.mono, fontSize: 10, color: FCT.inkDim }}>
                    {r.seed.toString().slice(-6).padStart(6, "0")}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 10, color: FCT.ink }}>
                    {formatDuration(r.durationSecs)}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 11, color: FCT.ice, textTransform: "capitalize" }}>
                    {r.blue}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 11, color: FCT.red, textTransform: "capitalize" }}>
                    {r.red}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 11, color: outcomeColor }}>
                    {outcomeText}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 8, color: FCT.inkFaint }}>
                    {r.version}
                  </span>
                  <div>
                    <FctBtn
                      primary
                      style={{ padding: "4px 12px", fontSize: 10 }}
                      onClick={() => onWatch(r.id)}
                    >
                      ▶ Watch
                    </FctBtn>
                  </div>
                </div>
              );
            })}
          </div>
        </FctPanel>
      </div>
    </FctFrame>
  );
}
