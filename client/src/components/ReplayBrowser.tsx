import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { FCT, FctFrame, FctPanel, HEX_CLIP, FctBtn } from "../design/facet";

// ── types ─────────────────────────────────────────────────────────────────────

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
  onWatch: (replayId: string, totalTicks: number, version?: string) => void;
}

// ── constants ─────────────────────────────────────────────────────────────────

const STARRED_KEY  = "crystalfront_starred_replays";
const PAGE_SIZES   = [10, 30, 50, 100] as const;
type SortField     = "timestamp" | "seed" | "ticks" | "winner";

const KNOWN_FLAGS: { id: string; label: string; color: string }[] = [
  { id: "fast",         label: "⚡ Fast",     color: FCT.green  },
  { id: "lopsided",     label: "⚔ Lopsided", color: FCT.red    },
  { id: "resource_win", label: "💰 Econ Win", color: FCT.amber  },
  { id: "scrappy",      label: "💀 Scrappy",  color: "#cc44ff"  },
];

// ── localStorage ──────────────────────────────────────────────────────────────

function loadStarred(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(STARRED_KEY) ?? "[]")); }
  catch { return new Set(); }
}
function saveStarred(s: Set<string>) {
  try { localStorage.setItem(STARRED_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

// ── display helpers ───────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}
function outcomeLabel(r: ReplayMeta) {
  const w = r.outcome.winner;
  if (!w) return { text: "Draw", color: FCT.inkDim };
  return w.includes("blue")
    ? { text: `${r.blue} wins`, color: FCT.ice }
    : { text: `${r.red} wins`,  color: FCT.red };
}
function winTypeBadge(wt: string | null | undefined) {
  if (!wt)               return { text: "—",          color: FCT.inkFaint };
  if (wt === "combat")   return { text: "⚔ Combat",   color: FCT.red      };
  if (wt === "resource") return { text: "💰 Econ",    color: FCT.amber    };
  if (wt === "timeout")  return { text: "⏳ Time",    color: FCT.inkDim   };
  return { text: wt, color: FCT.inkFaint };
}
function flagStyle(id: string) {
  return KNOWN_FLAGS.find(f => f.id === id) ?? { label: id, color: FCT.inkFaint };
}
function unitsSummary(units?: Record<string, number>) {
  if (!units || !Object.keys(units).length) return "—";
  const p: string[] = [];
  if (units.worker)     p.push(`W${units.worker}`);
  if (units.skirmisher) p.push(`S${units.skirmisher}`);
  if (units.gunner)     p.push(`G${units.gunner}`);
  if (units.bruiser)    p.push(`B${units.bruiser}`);
  if (units.medic)      p.push(`M${units.medic}`);
  return p.join(" ") || "—";
}

// ── component ─────────────────────────────────────────────────────────────────

export default function ReplayBrowser({ onBack, onWatch }: ReplayBrowserProps) {
  const [allReplays, setAllReplays] = useState<ReplayMeta[]>([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [starred,    setStarred]    = useState<Set<string>>(() => loadStarred());

  // Filters
  const [filterWinner,  setFilterWinner]  = useState("all");
  const [filterWinType, setFilterWinType] = useState("all");
  const [filterBot,     setFilterBot]     = useState("");
  const [filterStarred, setFilterStarred] = useState(false);
  const [filterFlags,   setFilterFlags]   = useState<Set<string>>(new Set());
  const [flagMenuOpen,  setFlagMenuOpen]  = useState(false);
  const flagMenuRef = useRef<HTMLDivElement>(null);

  // Sort + page
  const [sortField, setSortField] = useState<SortField>("timestamp");
  const [sortAsc,   setSortAsc]   = useState(false);
  const [pageSize,  setPageSize]  = useState<number>(50);
  const [page,      setPage]      = useState(1);

  // Fetch all metadata once (server returns newest-first, up to 500)
  useEffect(() => {
    setLoading(true);
    fetch("/api/replays?limit=500")
      .then(r => r.json())
      .then(d => { setAllReplays(d.replays ?? []); setTotal(d.total ?? 0); setLoading(false); })
      .catch(() => { setError("Could not load replays."); setLoading(false); });
  }, []);

  // Close flag dropdown when clicking outside
  useEffect(() => {
    if (!flagMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (flagMenuRef.current && !flagMenuRef.current.contains(e.target as Node)) {
        setFlagMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [flagMenuOpen]);

  // Reset to page 1 when any filter changes
  useEffect(() => { setPage(1); }, [filterWinner, filterWinType, filterBot, filterStarred, filterFlags, sortField, sortAsc, pageSize]);

  const toggleStar = useCallback((id: string) => {
    setStarred(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveStarred(next);
      return next;
    });
  }, []);

  const toggleFlag = useCallback((id: string) => {
    setFilterFlags(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Apply filters + sort to the full loaded set
  const filtered = useMemo(() => {
    let list = [...allReplays];
    if (filterStarred) list = list.filter(r => starred.has(r.id));
    if (filterWinner === "blue") list = list.filter(r =>  r.outcome.winner?.includes("blue"));
    else if (filterWinner === "red")  list = list.filter(r =>  r.outcome.winner?.includes("red"));
    else if (filterWinner === "draw") list = list.filter(r => !r.outcome.winner);
    if (filterWinType !== "all")
      list = list.filter(r => (r.winType ?? r.outcome.winType) === filterWinType);
    if (filterBot.trim()) {
      const q = filterBot.trim().toLowerCase();
      list = list.filter(r => r.blue.toLowerCase().includes(q) || r.red.toLowerCase().includes(q));
    }
    if (filterFlags.size > 0) {
      // ALL selected flags must be present (AND logic)
      list = list.filter(r => {
        const rf = new Set(r.flags ?? []);
        return [...filterFlags].every(f => rf.has(f));
      });
    }
    list.sort((a, b) => {
      let va: number, vb: number;
      switch (sortField) {
        case "seed":   va = a.seed;          vb = b.seed;          break;
        case "ticks":  va = a.outcome.ticks; vb = b.outcome.ticks; break;
        case "winner":
          va = a.outcome.winner?.includes("blue") ? 1 : a.outcome.winner?.includes("red") ? 2 : 0;
          vb = b.outcome.winner?.includes("blue") ? 1 : b.outcome.winner?.includes("red") ? 2 : 0;
          break;
        default: va = a.timestamp; vb = b.timestamp; break;
      }
      return sortAsc ? va - vb : vb - va;
    });
    return list;
  }, [allReplays, filterStarred, filterWinner, filterWinType, filterBot, filterFlags, starred, sortField, sortAsc]);

  const totalPages  = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems   = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function toggleSort(field: SortField) {
    if (sortField === field) setSortAsc(a => !a);
    else { setSortField(field); setSortAsc(false); }
  }

  const hasFilters = filterWinner !== "all" || filterWinType !== "all"
    || filterBot.trim() || filterStarred || filterFlags.size > 0;

  const COLS = "30px 80px 60px 100px 100px 130px 80px 90px 1fr 60px 60px";

  return (
    <FctFrame top="BOT REPLAYS">
      <div style={{
        position: "absolute", top: 36, left: 0, right: 0, bottom: 0,
        padding: 20, display: "flex", flexDirection: "column", gap: 10,
      }}>

        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: FCT.mono, fontSize: 11, color: FCT.inkDim, letterSpacing: "0.28em" }}>
            ▰ BOT REPLAYS · {filtered.length} matching / {total} total
          </div>
          <FctBtn sub="ESC" onClick={onBack} style={{ padding: "6px 18px" }}>← Back</FctBtn>
        </div>

        {/* ── Filter bar ── */}
        <div style={{
          display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
          fontFamily: FCT.mono, fontSize: 11, color: FCT.inkFaint,
        }}>

          {/* Starred */}
          <button onClick={() => setFilterStarred(v => !v)} style={filterToggleStyle(filterStarred, FCT.amber)}>
            {filterStarred ? "★ Starred" : "☆ Starred"}
          </button>

          {/* Winner */}
          <span>Winner:</span>
          <select value={filterWinner} onChange={e => setFilterWinner(e.target.value)} style={selectStyle}>
            <option value="all">All</option>
            <option value="blue">Blue</option>
            <option value="red">Red</option>
            <option value="draw">Draw</option>
          </select>

          {/* Win type */}
          <span>Type:</span>
          <select value={filterWinType} onChange={e => setFilterWinType(e.target.value)} style={selectStyle}>
            <option value="all">All</option>
            <option value="combat">Combat</option>
            <option value="resource">Resource</option>
            <option value="timeout">Timeout</option>
          </select>

          {/* Bot name search */}
          <span>Bot:</span>
          <input
            type="text" placeholder="idle, rush, ppo…"
            value={filterBot} onChange={e => setFilterBot(e.target.value)}
            style={{ ...selectStyle, width: 110 }}
          />

          {/* Flag multi-select dropdown */}
          <div ref={flagMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setFlagMenuOpen(v => !v)}
              style={filterToggleStyle(filterFlags.size > 0, "#cc44ff")}
            >
              {filterFlags.size > 0
                ? `Flags: ${[...filterFlags].map(f => flagStyle(f).label).join(", ")}`
                : `Flags ▾`}
            </button>
            {flagMenuOpen && (
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
                background: FCT.bgPanel, border: `1px solid ${FCT.lineHi}`,
                borderRadius: 6, padding: "6px 0", minWidth: 160,
                boxShadow: "0 4px 16px #0006",
              }}>
                {KNOWN_FLAGS.map(f => (
                  <label
                    key={f.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 14px", cursor: "pointer",
                      fontFamily: FCT.mono, fontSize: 11, color: f.color,
                      background: filterFlags.has(f.id) ? f.color + "18" : "transparent",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={filterFlags.has(f.id)}
                      onChange={() => toggleFlag(f.id)}
                      style={{ accentColor: f.color, cursor: "pointer" }}
                    />
                    {f.label}
                  </label>
                ))}
                {filterFlags.size > 0 && (
                  <div
                    onClick={() => setFilterFlags(new Set())}
                    style={{
                      padding: "5px 14px", borderTop: `1px solid ${FCT.line}`,
                      fontFamily: FCT.mono, fontSize: 10, color: FCT.inkFaint,
                      cursor: "pointer", marginTop: 4,
                    }}
                  >
                    Clear flags
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Page size */}
          <span>Show:</span>
          <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={selectStyle}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>

          {hasFilters && (
            <FctBtn style={{ padding: "3px 10px", fontSize: 10 }} onClick={() => {
              setFilterWinner("all"); setFilterWinType("all");
              setFilterBot(""); setFilterStarred(false);
              setFilterFlags(new Set());
            }}>Clear all</FctBtn>
          )}
        </div>

        {/* ── Table ── */}
        <FctPanel clip={HEX_CLIP} style={{ flex: 1, overflow: "hidden", padding: 0 }}>
          {/* Column headers */}
          <div style={{
            display: "grid", gridTemplateColumns: COLS,
            padding: "8px 14px", borderBottom: `1px solid ${FCT.lineHi}`,
            fontFamily: FCT.mono, fontSize: 10, color: FCT.inkFaint, letterSpacing: "0.26em",
          }}>
            <span title="Star to bookmark this replay">☆</span>
            <SortHdr label="SEED"    field="seed"   sf={sortField} sa={sortAsc} ts={toggleSort} />
            <SortHdr label="DUR"     field="ticks"  sf={sortField} sa={sortAsc} ts={toggleSort} />
            <span>BLUE</span>
            <span>RED</span>
            <SortHdr label="OUTCOME" field="winner" sf={sortField} sa={sortAsc} ts={toggleSort} />
            <span>TYPE</span>
            <span>UNITS</span>
            <span>FLAGS</span>
            <span>VER</span>
            <span style={{ textAlign: "right" }}>WATCH</span>
          </div>

          {/* Rows */}
          <div style={{ overflowY: "auto", height: "calc(100% - 88px)" }}>
            {loading && <Msg text="Loading…" color={FCT.inkFaint} />}
            {error   && <Msg text={error}    color={FCT.red} />}
            {!loading && !error && allReplays.length === 0 && (
              <Msg text="No replays yet — run: tsx headless/src/cli.ts --blue rush --red idle" color={FCT.inkFaint} />
            )}
            {!loading && !error && allReplays.length > 0 && filtered.length === 0 && (
              <Msg text="No replays match the current filters." color={FCT.inkFaint} />
            )}
            {pageItems.map((r, i) => {
              const { text: outcomeText, color: outcomeColor } = outcomeLabel(r);
              const { text: wtText,     color: wtColor }      = winTypeBadge(r.winType ?? r.outcome.winType);
              const isStarred = starred.has(r.id);
              return (
                <div key={r.id} style={{
                  display: "grid", gridTemplateColumns: COLS,
                  padding: "9px 14px",
                  borderBottom: i < pageItems.length - 1 ? `1px solid ${FCT.line}` : undefined,
                  alignItems: "center",
                  background: i % 2 === 0 ? "transparent" : FCT.bgPanelHi,
                  minHeight: 40,
                }}>
                  <button onClick={() => toggleStar(r.id)}
                    style={{ background: "none", border: "none", cursor: "pointer",
                      padding: 0, fontSize: 14, color: isStarred ? FCT.amber : FCT.inkFaint }}>
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
                  <span style={{ fontFamily: FCT.mono, fontSize: 11, color: wtColor }}>{wtText}</span>
                  <span style={{ fontFamily: FCT.mono, fontSize: 10, color: FCT.inkDim }}>
                    <span style={{ color: FCT.ice }}>{unitsSummary(r.blueUnits)}</span>
                    <span style={{ color: FCT.inkFaint, margin: "0 2px" }}>vs</span>
                    <span style={{ color: FCT.red }}>{unitsSummary(r.redUnits)}</span>
                  </span>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {(r.flags ?? []).map(f => {
                      const { label, color } = flagStyle(f);
                      return (
                        <span key={f} style={{
                          fontFamily: FCT.mono, fontSize: 10, color,
                          background: color + "18", borderRadius: 3, padding: "2px 5px", whiteSpace: "nowrap",
                        }}>{label}</span>
                      );
                    })}
                  </div>
                  <span style={{ fontFamily: FCT.mono, fontSize: 9, color: FCT.inkFaint }}>
                    {r.version ?? "?"}
                  </span>
                  <div style={{ textAlign: "right" }}>
                    <FctBtn primary style={{ padding: "3px 10px", fontSize: 11 }}
                      onClick={() => onWatch(r.id, r.outcome.ticks, r.version)}>▶</FctBtn>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Pagination footer ── */}
          {!loading && filtered.length > 0 && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 14px", borderTop: `1px solid ${FCT.lineHi}`,
              fontFamily: FCT.mono, fontSize: 10, color: FCT.inkFaint,
            }}>
              <FctBtn
                style={{ padding: "3px 12px", fontSize: 10 }}
                onClick={() => setPage(p => Math.max(1, p - 1))}
              >
                ← Prev
              </FctBtn>
              <span>
                Page {currentPage} of {totalPages}
                &nbsp;·&nbsp;
                {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length}
                {filtered.length < total ? ` (${total} total)` : ""}
              </span>
              <FctBtn
                style={{ padding: "3px 12px", fontSize: 10 }}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              >
                Next →
              </FctBtn>
            </div>
          )}
        </FctPanel>
      </div>
    </FctFrame>
  );
}

// ── small helpers ─────────────────────────────────────────────────────────────

function Msg({ text, color }: { text: string; color: string }) {
  return (
    <div style={{ padding: 24, textAlign: "center", fontFamily: FCT.mono, fontSize: 12, color }}>
      {text}
    </div>
  );
}

function SortHdr({ label, field, sf, sa, ts }: {
  label: string; field: SortField;
  sf: SortField; sa: boolean;
  ts: (f: SortField) => void;
}) {
  return (
    <span onClick={() => ts(field)} style={{
      cursor: "pointer", userSelect: "none",
      color: sf === field ? FCT.ice : FCT.inkFaint,
    }}>
      {label}{sf === field ? (sa ? " ▴" : " ▾") : ""}
    </span>
  );
}

function filterToggleStyle(active: boolean, accentColor: string): React.CSSProperties {
  return {
    background: active ? accentColor + "22" : "transparent",
    color: active ? accentColor : FCT.inkFaint,
    border: `1px solid ${active ? accentColor : FCT.lineHi}`,
    borderRadius: 4, padding: "4px 10px",
    fontFamily: FCT.mono, fontSize: 11, cursor: "pointer",
  };
}

const selectStyle: React.CSSProperties = {
  background: FCT.bgPanelHi, color: FCT.ink,
  border: `1px solid ${FCT.lineHi}`, borderRadius: 4,
  padding: "4px 8px", fontFamily: FCT.mono, fontSize: 11, outline: "none",
};

export type { ReplayMeta };
