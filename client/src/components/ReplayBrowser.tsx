import { useEffect, useMemo, useState, useCallback } from "react";
import { FCT, FctFrame, FctPanel, HEX_CLIP, FctBtn } from "../design/facet";

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

// ── constants ────────────────────────────────────────────────────────────────

const STARRED_KEY = "crystalfront_starred_replays";
const LIMIT_OPTIONS = [10, 30, 50, 100] as const;
type SortField = "timestamp" | "seed" | "ticks" | "winner";

// ── localStorage helpers ──────────────────────────────────────────────────────

function loadStarred(): Set<string> {
  try {
    const raw = localStorage.getItem(STARRED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveStarred(s: Set<string>): void {
  try { localStorage.setItem(STARRED_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

// ── helpers ───────────────────────────────────────────────────────────────────

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
  if (wt === "combat")   return { text: "⚔ Combat",  color: FCT.red };
  if (wt === "resource") return { text: "💰 Econ",   color: FCT.amber };
  if (wt === "timeout")  return { text: "⏳ Time",   color: FCT.inkDim };
  return { text: wt, color: FCT.inkFaint };
}

function flagBadge(flag: string): { text: string; color: string } {
  switch (flag) {
    case "fast":         return { text: "⚡ Fast",     color: FCT.green };
    case "lopsided":     return { text: "⚔ Lopsided", color: FCT.red };
    case "resource_win": return { text: "💰 Econ Win", color: FCT.amber };
    case "scrappy":      return { text: "💀 Scrappy",  color: "#cc44ff" };
    default:             return { text: flag,           color: FCT.inkFaint };
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

// ── component ─────────────────────────────────────────────────────────────────

export default function ReplayBrowser({ onBack, onWatch }: ReplayBrowserProps) {
  const [replays, setReplays] = useState<ReplayMeta[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [limit, setLimit]     = useState<number>(50);
  const [starred, setStarred] = useState<Set<string>>(() => loadStarred());

  // Filters
  const [filterWinner,  setFilterWinner]  = useState("all");
  const [filterWinType, setFilterWinType] = useState("all");
  const [filterBot,     setFilterBot]     = useState("");
  const [filterStarred, setFilterStarred] = useState(false);

  // Sort
  const [sortField, setSortField] = useState<SortField>("timestamp");
  const [sortAsc,   setSortAsc]   = useState(false);

  // Fetch when limit changes
  useEffect(() => {
    const fetchLimit = filterStarred ? 1000 : limit;
    setLoading(true);
    fetch(`/api/replays?limit=${fetchLimit}`)
      .then(r => r.json())
      .then(d => {
        setReplays(d.replays ?? []);
        setTotal(d.total ?? (d.replays ?? []).length);
        setLoading(false);
      })
      .catch(() => { setError("Could not load replays."); setLoading(false); });
  }, [limit, filterStarred]);

  const toggleStar = useCallback((id: string) => {
    setStarred(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveStarred(next);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    let list = [...replays];

    if (filterStarred) list = list.filter(r => starred.has(r.id));
    if (filterWinner === "blue") list = list.filter(r => r.outcome.winner?.includes("blue"));
    else if (filterWinner === "red")  list = list.filter(r => r.outcome.winner?.includes("red"));
    else if (filterWinner === "draw") list = list.filter(r => !r.outcome.winner);

    if (filterWinType !== "all") {
      list = list.filter(r => (r.winType ?? r.outcome.winType) === filterWinType);
    }
    if (filterBot.trim()) {
      const q = filterBot.trim().toLowerCase();
      list = list.filter(r => r.blue.toLowerCase().includes(q) || r.red.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      let va: number, vb: number;
      switch (sortField) {
        case "seed":    va = a.seed;          vb = b.seed; break;
        case "ticks":   va = a.outcome.ticks; vb = b.outcome.ticks; break;
        case "winner":
          va = a.outcome.winner?.includes("blue") ? 1 : a.outcome.winner?.includes("red") ? 2 : 0;
          vb = b.outcome.winner?.includes("blue") ? 1 : b.outcome.winner?.includes("red") ? 2 : 0;
          break;
        default: va = a.timestamp; vb = b.timestamp; break;
      }
      return sortAsc ? va - vb : vb - va;
    });

    return list;
  }, [replays, filterWinner, filterWinType, filterBot, filterStarred, starred, sortField, sortAsc]);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(false); }
  }
  function sortArrow(field: SortField): string {
    return sortField === field ? (sortAsc ? " ▴" : " ▾") : "";
  }

  const hasFilters = filterWinner !== "all" || filterWinType !== "all" || filterBot.trim() || filterStarred;

  const COLS = "30px 80px 60px 100px 100px 130px 80px 90px 1fr 60px 60px";

  return (
    <FctFrame top="BOT REPLAYS">
      <div style={{
        position: "absolute", top: 36, left: 0, right: 0, bottom: 0,
        padding: 20, display: "flex", flexDirection: "column", gap: 12,
      }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: FCT.mono, fontSize: 11, color: FCT.inkDim, letterSpacing: "0.28em" }}>
            ▰ HEADLESS MATCH REPLAYS · {filtered.length} shown / {total} total
          </div>
          <FctBtn sub="ESC" onClick={onBack} style={{ padding: "6px 18px" }}>← Back</FctBtn>
        </div>

        {/* Filter bar */}
        <div style={{
          display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
          fontFamily: FCT.mono, fontSize: 11, color: FCT.inkFaint,
        }}>
          {/* Starred toggle */}
          <button
            onClick={() => setFilterStarred(v => !v)}
            style={{
              background: filterStarred ? FCT.amber + "22" : "transparent",
              color: filterStarred ? FCT.amber : FCT.inkFaint,
              border: `1px solid ${filterStarred ? FCT.amber : FCT.lineHi}`,
              borderRadius: 4, padding: "4px 10px",
              fontFamily: FCT.mono, fontSize: 11, cursor: "pointer",
            }}
          >
            {filterStarred ? "★ Starred" : "☆ Starred"}
          </button>

          <span>Winner:</span>
          <select value={filterWinner} onChange={e => setFilterWinner(e.target.value)} style={selectStyle}>
            <option value="all">All</option>
            <option value="blue">Blue</option>
            <option value="red">Red</option>
            <option value="draw">Draw</option>
          </select>

          <span>Type:</span>
          <select value={filterWinType} onChange={e => setFilterWinType(e.target.value)} style={selectStyle}>
            <option value="all">All</option>
            <option value="combat">Combat</option>
            <option value="resource">Resource</option>
            <option value="timeout">Timeout</option>
          </select>

          <span>Bot:</span>
          <input
            type="text" placeholder="idle, rush, ppo…"
            value={filterBot} onChange={e => setFilterBot(e.target.value)}
            style={{ ...selectStyle, width: 110 }}
          />

          <span>Show:</span>
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            style={selectStyle}
          >
            {LIMIT_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>

          {hasFilters && (
            <FctBtn style={{ padding: "3px 10px", fontSize: 10 }}
              onClick={() => { setFilterWinner("all"); setFilterWinType("all"); setFilterBot(""); setFilterStarred(false); }}>
              Clear
            </FctBtn>
          )}
        </div>

        {/* Table */}
        <FctPanel clip={HEX_CLIP} style={{ flex: 1, overflow: "hidden", padding: 0 }}>
          {/* Column headers */}
          <div style={{
            display: "grid", gridTemplateColumns: COLS,
            padding: "8px 14px", borderBottom: `1px solid ${FCT.lineHi}`,
            fontFamily: FCT.mono, fontSize: 10, color: FCT.inkFaint, letterSpacing: "0.26em",
          }}>
            <span title="Star to mark interesting replays">☆</span>
            <SortHeader label="SEED"    field="seed"   {...{sortField, sortAsc, toggleSort, sortArrow}} />
            <SortHeader label="DUR"     field="ticks"  {...{sortField, sortAsc, toggleSort, sortArrow}} />
            <span>BLUE</span>
            <span>RED</span>
            <SortHeader label="OUTCOME" field="winner" {...{sortField, sortAsc, toggleSort, sortArrow}} />
            <span>TYPE</span>
            <span>UNITS</span>
            <span>FLAGS</span>
            <span>VER</span>
            <span style={{ textAlign: "right" }}>WATCH</span>
          </div>

          {/* Rows */}
          <div style={{ overflowY: "auto", maxHeight: "calc(100% - 40px)" }}>
            {loading && (
              <div style={{ padding: 24, textAlign: "center", fontFamily: FCT.mono, fontSize: 12, color: FCT.inkFaint }}>
                Loading…
              </div>
            )}
            {error && (
              <div style={{ padding: 24, textAlign: "center", fontFamily: FCT.mono, fontSize: 12, color: FCT.red }}>
                {error}
              </div>
            )}
            {!loading && !error && replays.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", fontFamily: FCT.mono, fontSize: 12, color: FCT.inkFaint }}>
                No replays yet. Run the CLI to generate some:
                <br />
                <span style={{ color: FCT.ice, fontSize: 11, marginTop: 8, display: "block" }}>
                  tsx headless/src/cli.ts --blue rush --red idle
                </span>
              </div>
            )}
            {filtered.map((r, i) => {
              const { text: outcomeText, color: outcomeColor } = outcomeLabel(r);
              const { text: wtText,     color: wtColor }      = winTypeBadge(r.winType ?? r.outcome.winType);
              const isStarred = starred.has(r.id);
              const rFlags = r.flags ?? [];
              return (
                <div
                  key={r.id}
                  style={{
                    display: "grid", gridTemplateColumns: COLS,
                    padding: "9px 14px",
                    borderBottom: i < filtered.length - 1 ? `1px solid ${FCT.line}` : undefined,
                    alignItems: "center",
                    background: i % 2 === 0 ? "transparent" : FCT.bgPanelHi,
                    minHeight: 40,
                  }}
                >
                  {/* Star */}
                  <button
                    onClick={() => toggleStar(r.id)}
                    title={isStarred ? "Unstar" : "Star this replay"}
                    style={{
                      background: "none", border: "none", cursor: "pointer", padding: 0,
                      fontSize: 14, color: isStarred ? FCT.amber : FCT.inkFaint,
                      lineHeight: 1,
                    }}
                  >
                    {isStarred ? "★" : "☆"}
                  </button>

                  <span style={{ fontFamily: FCT.mono, fontSize: 11, color: FCT.inkDim }}>
                    {r.seed.toString().slice(-6).padStart(6, "0")}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 11, color: FCT.ink }}>
                    {formatDuration(r.durationSecs)}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 12, color: FCT.ice, textTransform: "capitalize" }}>
                    {r.blue}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 12, color: FCT.red, textTransform: "capitalize" }}>
                    {r.red}
                  </span>
                  <span style={{ fontFamily: FCT.ui, fontSize: 12, color: outcomeColor, fontWeight: 600 }}>
                    {outcomeText}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 11, color: wtColor }}>
                    {wtText}
                  </span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 10, color: FCT.inkDim, lineHeight: "1.3" }}>
                    <span style={{ color: FCT.ice }}>{unitsSummary(r.blueUnits)}</span>
                    <span style={{ color: FCT.inkFaint, margin: "0 2px" }}>vs</span>
                    <span style={{ color: FCT.red }}>{unitsSummary(r.redUnits)}</span>
                  </span>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                    {rFlags.map(f => {
                      const { text, color } = flagBadge(f);
                      return (
                        <span key={f} style={{
                          fontFamily: FCT.mono, fontSize: 10, color,
                          background: color + "18", borderRadius: 3, padding: "2px 5px",
                          whiteSpace: "nowrap",
                        }}>{text}</span>
                      );
                    })}
                  </div>
                  {/* Version */}
                  <span style={{ fontFamily: FCT.mono, fontSize: 9, color: FCT.inkFaint, opacity: 0.7 }}>
                    {r.version ?? "?"}
                  </span>
                  {/* Watch */}
                  <div style={{ textAlign: "right" }}>
                    <FctBtn
                      primary
                      style={{ padding: "3px 10px", fontSize: 11 }}
                      onClick={() => onWatch(r.id, r.outcome.ticks)}
                    >▶</FctBtn>
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

// ── sub-components ────────────────────────────────────────────────────────────

function SortHeader({ label, field, sortField, toggleSort, sortArrow }: {
  label: string; field: SortField;
  sortField: SortField; sortAsc: boolean;
  toggleSort: (f: SortField) => void; sortArrow: (f: SortField) => string;
}) {
  return (
    <span onClick={() => toggleSort(field)} style={{
      cursor: "pointer", userSelect: "none",
      color: sortField === field ? FCT.ice : FCT.inkFaint,
    }}>
      {label}{sortArrow(field)}
    </span>
  );
}

// ── shared styles ─────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  background: FCT.bgPanelHi, color: FCT.ink,
  border: `1px solid ${FCT.lineHi}`, borderRadius: 4,
  padding: "4px 8px", fontFamily: FCT.mono, fontSize: 11, outline: "none",
};

export type { ReplayMeta };
