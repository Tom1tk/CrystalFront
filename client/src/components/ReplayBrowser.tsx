import { useEffect, useMemo, useState } from "react";
import { FCT, FctFrame, FctPanel, FctBtn, HEX_CLIP } from "../design/facet";

// ── types ────────────────────────────────────────────────────────────────────

interface ReplayMeta {
  id: string;
  seed: number;
  blue: string;
  red: string;
  outcome: { winner: string | null; winType?: string | null; ticks: number };
  durationSecs: number;
  version: string;
  timestamp: number;
  // Phase 5 — enriched metadata
  winType?: string | null;
  blueUnits?: Record<string, number>;
  redUnits?: Record<string, number>;
  blueBuildings?: Record<string, number>;
  redBuildings?: Record<string, number>;
  buildOrderBlue?: string[];
  buildOrderRed?: string[];
  firstCombatTick?: number;
  flags?: string[];
}

interface ReplayBrowserProps {
  onBack: () => void;
  onWatch: (replayId: string, totalTicks: number) => void;
}

// ── sort ─────────────────────────────────────────────────────────────────────

type SortField = "timestamp" | "seed" | "ticks" | "winner";

// ── helpers ──────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

function outcomeLabel(meta: ReplayMeta): { text: string; color: string } {
  const w = meta.outcome.winner;
  if (!w) return { text: "Draw", color: FCT.inkDim };
  if (w.includes("blue")) return { text: `${meta.blue} wins`, color: FCT.ice };
  return { text: `${meta.red} wins`, color: FCT.red };
}

function winTypeBadge(wt: string | null | undefined): { text: string; color: string } {
  if (!wt) return { text: "—", color: FCT.inkFaint };
  if (wt === "combat") return { text: "⚔ Combat", color: FCT.red };
  if (wt === "resource") return { text: "💰 Econ", color: FCT.amber };
  if (wt === "timeout") return { text: "⏳ Time", color: FCT.inkDim };
  return { text: wt, color: FCT.inkFaint };
}

function flagBadge(flag: string): { text: string; color: string } {
  switch (flag) {
    case "fast":         return { text: "⚡ Fast", color: FCT.green };
    case "lopsided":     return { text: "⚔ Lopsided", color: FCT.red };
    case "resource_win": return { text: "💰 Econ Win", color: FCT.amber };
    default:             return { text: flag, color: FCT.inkFaint };
  }
}

function unitsSummary(units: Record<string, number> | undefined): string {
  if (!units || Object.keys(units).length === 0) return "—";
  const parts: string[] = [];
  if (units.worker)     parts.push(`W${units.worker}`);
  if (units.skirmisher) parts.push(`S${units.skirmisher}`);
  if (units.gunner)     parts.push(`G${units.gunner}`);
  if (units.bruiser)    parts.push(`B${units.bruiser}`);
  if (units.medic)      parts.push(`M${units.medic}`);
  return parts.join(" ") || "—";
}

// ── component ────────────────────────────────────────────────────────────────

export default function ReplayBrowser({ onBack, onWatch }: ReplayBrowserProps) {
  const [replays, setReplays] = useState<ReplayMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterWinner, setFilterWinner] = useState<string>("all");
  const [filterWinType, setFilterWinType] = useState<string>("all");
  const [filterBot, setFilterBot] = useState<string>("");

  // Sort
  const [sortField, setSortField] = useState<SortField>("timestamp");
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    fetch("/api/replays")
      .then(r => r.json())
      .then(d => { setReplays(d.replays ?? []); setLoading(false); })
      .catch(() => { setError("Could not load replays."); setLoading(false); });
  }, []);

  const filtered = useMemo(() => {
    let list = [...replays];

    // Filter by winner
    if (filterWinner === "blue") {
      list = list.filter(r => r.outcome.winner?.includes("blue"));
    } else if (filterWinner === "red") {
      list = list.filter(r => r.outcome.winner?.includes("red"));
    } else if (filterWinner === "draw") {
      list = list.filter(r => !r.outcome.winner);
    }

    // Filter by win type
    if (filterWinType !== "all") {
      list = list.filter(r => (r.winType ?? r.outcome.winType) === filterWinType);
    }

    // Filter by bot name
    if (filterBot.trim()) {
      const q = filterBot.trim().toLowerCase();
      list = list.filter(r => r.blue.toLowerCase().includes(q) || r.red.toLowerCase().includes(q));
    }

    // Sort
    list.sort((a, b) => {
      let va: number, vb: number;
      switch (sortField) {
        case "seed":
          va = a.seed; vb = b.seed; break;
        case "ticks":
          va = a.outcome.ticks; vb = b.outcome.ticks; break;
        case "winner":
          va = a.outcome.winner?.includes("blue") ? 1 : a.outcome.winner?.includes("red") ? 2 : 0;
          vb = b.outcome.winner?.includes("blue") ? 1 : b.outcome.winner?.includes("red") ? 2 : 0;
          break;
        default: // timestamp
          va = a.timestamp; vb = b.timestamp; break;
      }
      return sortAsc ? va - vb : vb - va;
    });

    return list;
  }, [replays, filterWinner, filterWinType, filterBot, sortField, sortAsc]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(false); }
  }
  function sortArrow(field: SortField): string {
    if (sortField !== field) return "";
    return sortAsc ? " ▴" : " ▾";
  }

  return (
    <FctFrame top="BOT REPLAYS">
      <div style={{
        position: "absolute", top: 36, left: 0, right: 0, bottom: 0,
        padding: 20, display: "flex", flexDirection: "column", gap: 12,
      }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{
            fontFamily: FCT.mono, fontSize: 9, color: FCT.inkDim, letterSpacing: "0.28em",
          }}>
            ▰ HEADLESS MATCH REPLAYS · {filtered.length} / {replays.length} SHOWN
          </div>
          <FctBtn sub="ESC" onClick={onBack} style={{ padding: "6px 18px" }}>
            ← Back
          </FctBtn>
        </div>

        {/* ── Filter bar ──────────────────────────────────────────────────── */}
        <div style={{
          display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
          fontFamily: FCT.mono, fontSize: 9, color: FCT.inkFaint,
        }}>
          {/* Winner filter */}
          <span>Winner:</span>
          <select
            value={filterWinner}
            onChange={e => setFilterWinner(e.target.value)}
            style={selectStyle}
          >
            <option value="all">All</option>
            <option value="blue">Blue</option>
            <option value="red">Red</option>
            <option value="draw">Draw</option>
          </select>

          {/* Win type filter */}
          <span>Win type:</span>
          <select
            value={filterWinType}
            onChange={e => setFilterWinType(e.target.value)}
            style={selectStyle}
          >
            <option value="all">All</option>
            <option value="combat">Combat</option>
            <option value="resource">Resource</option>
            <option value="timeout">Timeout</option>
          </select>

          {/* Bot search */}
          <span>Bot:</span>
          <input
            type="text"
            placeholder="idle, rush, macro…"
            value={filterBot}
            onChange={e => setFilterBot(e.target.value)}
            style={{ ...inputStyle, width: 120 }}
          />

          {filtered.length < replays.length && (
            <FctBtn sub style={{ padding: "3px 10px", fontSize: 8 }}
              onClick={() => { setFilterWinner("all"); setFilterWinType("all"); setFilterBot(""); }}>
              Clear
            </FctBtn>
          )}
        </div>

        {/* ── Table ───────────────────────────────────────────────────────── */}
        <FctPanel clip={HEX_CLIP} style={{ flex: 1, overflow: "hidden", padding: 0 }}>
          {/* Column headers */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "80px 60px 90px 90px 110px 60px 70px 1fr",
            padding: "8px 12px",
            borderBottom: `1px solid ${FCT.lineHi}`,
            fontFamily: FCT.mono,
            fontSize: 8,
            color: FCT.inkFaint,
            letterSpacing: "0.26em",
          }}>
            <SortHeader label="SEED"    field="seed"      {...{sortField, sortAsc, toggleSort, sortArrow}} />
            <SortHeader label="DUR"     field="ticks"     {...{sortField, sortAsc, toggleSort, sortArrow}} />
            <span>BLUE</span>
            <span>RED</span>
            <SortHeader label="OUTCOME" field="winner"    {...{sortField, sortAsc, toggleSort, sortArrow}} />
            <span>TYPE</span>
            <span>UNITS</span>
            <span>FLAGS</span>
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
            {filtered.map((r, i) => {
              const { text: outcomeText, color: outcomeColor } = outcomeLabel(r);
              const { text: wtText, color: wtColor } = winTypeBadge(r.winType ?? r.outcome.winType);
              const rFlags = r.flags ?? [];
              return (
                <div
                  key={r.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "80px 60px 90px 90px 110px 60px 70px 1fr",
                    padding: "8px 12px",
                    borderBottom: i < filtered.length - 1 ? `1px solid ${FCT.line}` : undefined,
                    alignItems: "center",
                    background: i % 2 === 0 ? "transparent" : FCT.bgPanelHi,
                    transition: "background 0.1s",
                    minHeight: 36,
                  }}
                >
                  <span style={{ fontFamily: FCT.mono, fontSize: 9, color: FCT.inkDim }}>
                    {r.seed.toString().slice(-6).padStart(6, "0")}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 9, color: FCT.ink }}>
                    {formatDuration(r.durationSecs)}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 10, color: FCT.ice, textTransform: "capitalize" }}>
                    {r.blue}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 10, color: FCT.red, textTransform: "capitalize" }}>
                    {r.red}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 10, color: outcomeColor, fontWeight: 600 }}>
                    {outcomeText}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 8, color: wtColor }}>
                    {wtText}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 7, color: FCT.inkDim, lineHeight: "1.3" }}>
                    <span style={{ color: FCT.ice }}>{unitsSummary(r.blueUnits)}</span>
                    <span style={{ color: FCT.inkFaint, margin: "0 2px" }}>vs</span>
                    <span style={{ color: FCT.red }}>{unitsSummary(r.redUnits)}</span>
                  </span>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                    {rFlags.map(f => {
                      const { text, color } = flagBadge(f);
                      return (
                        <span key={f} style={{
                          fontFamily: FCT.mono, fontSize: 7, color,
                          background: color + "18", borderRadius: 3, padding: "1px 5px",
                          whiteSpace: "nowrap",
                        }}>
                          {text}
                        </span>
                      );
                    })}
                    <FctBtn
                      primary
                      style={{ padding: "2px 8px", fontSize: 8, marginLeft: "auto" }}
                      onClick={() => onWatch(r.id, r.outcome.ticks)}
                    >
                      ▶
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

// ── sub-components ───────────────────────────────────────────────────────────

function SortHeader({
  label, field, sortField, toggleSort, sortArrow,
}: {
  label: string; field: SortField;
  sortField: SortField; sortAsc: boolean;
  toggleSort: (f: SortField) => void; sortArrow: (f: SortField) => string;
}) {
  return (
    <span
      onClick={() => toggleSort(field)}
      style={{
        cursor: "pointer",
        userSelect: "none",
        color: sortField === field ? FCT.ice : FCT.inkFaint,
        transition: "color 0.15s",
      }}
    >
      {label}{sortArrow(field)}
    </span>
  );
}

// ── shared styles ────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  background: FCT.bgPanelHi,
  color: FCT.ink,
  border: `1px solid ${FCT.lineHi}`,
  borderRadius: 4,
  padding: "3px 6px",
  fontFamily: FCT.mono,
  fontSize: 9,
  outline: "none",
};

const inputStyle: React.CSSProperties = {
  ...selectStyle,
  width: 100,
};

// Re-export for the parent
export type { ReplayMeta };
