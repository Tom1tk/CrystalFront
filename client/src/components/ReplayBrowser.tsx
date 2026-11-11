import { useEffect, useState, useCallback } from "react";
import { Icon, IconBtn, PageTitle } from "../design/glass";
import { fetchMaps, MapThumb, type MapInfo } from "./MapPicker";

// ── types ─────────────────────────────────────────────────────────────────────

interface ReplayMeta {
  id: string;
  seed: number;
  blue: string;
  red: string;
  outcome: { winner: string | null; winnerName?: string | null; winType?: string | null; ticks: number };
  durationSecs: number;
  version: string;
  mapId?: string;
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

const KNOWN_FLAGS: { id: string; label: string }[] = [
  { id: "fast",        label: "Fast" },
  { id: "lopsided",    label: "Lopsided" },
  { id: "control_win", label: "Control win" },
  { id: "scrappy",     label: "Scrappy" },
];
const SORTS: Array<{ id: string; label: string; field: SortField; asc: boolean }> = [
  { id: "new",   label: "Newest",   field: "timestamp", asc: false },
  { id: "old",   label: "Oldest",   field: "timestamp", asc: true },
  { id: "long",  label: "Longest",  field: "ticks",     asc: false },
  { id: "short", label: "Shortest", field: "ticks",     asc: true },
  { id: "seed",  label: "Seed",     field: "seed",      asc: true },
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

const TEAM = { blue: "var(--blue)", red: "var(--red)" } as const;
const WIN_TYPE: Record<string, string> = { combat: "Crystal destroyed", control: "Node control", timeout: "Time" };

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function formatDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function winnerSide(r: ReplayMeta): "blue" | "red" | null {
  const w = r.outcome.winner;
  if (!w) return null;
  return w === "blue" || w.includes("blue") ? "blue" : "red";
}
function flagLabel(id: string) {
  return KNOWN_FLAGS.find(f => f.id === id)?.label ?? id;
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
  const [replays,  setReplays]  = useState<ReplayMeta[]>([]);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [starred,  setStarred]  = useState<Set<string>>(() => loadStarred());

  // Filters
  const [filterWinner,  setFilterWinner]  = useState("all");
  const [filterWinType, setFilterWinType] = useState("all");
  const [filterBot,     setFilterBot]     = useState("");
  const [filterStarred, setFilterStarred] = useState(false);
  const [filterFlags,   setFilterFlags]   = useState<Set<string>>(new Set());

  // Sort + page
  const [sortField, setSortField] = useState<SortField>("timestamp");
  const [sortAsc,   setSortAsc]   = useState(false);
  const [pageSize,  setPageSize]  = useState<number>(30);
  const [page,      setPage]      = useState(1);

  // Debounce bot input — only trigger a fetch after 300 ms of no typing
  const [debouncedBot, setDebouncedBot] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedBot(filterBot), 300);
    return () => clearTimeout(t);
  }, [filterBot]);

  // Reset to page 1 whenever any filter or sort changes
  useEffect(() => { setPage(1); }, [filterWinner, filterWinType, debouncedBot, filterStarred, filterFlags, sortField, sortAsc, pageSize]);

  // Fetch one page from the server whenever page / filters / sort change
  useEffect(() => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      page:     String(page),
      pageSize: String(pageSize),
      sort:     sortField,
      asc:      String(sortAsc),
      winner:   filterWinner,
      winType:  filterWinType,
    });
    if (debouncedBot)         params.set("bot",     debouncedBot);
    if (filterFlags.size > 0) params.set("flags",   [...filterFlags].join(","));
    if (filterStarred && starred.size > 0) params.set("starred", [...starred].join(","));
    // If starred filter is on but nothing is starred, short-circuit to empty result
    if (filterStarred && starred.size === 0) {
      setReplays([]); setTotal(0); setLoading(false); return;
    }

    // Ignore a response that arrives after a newer request (filters changed meanwhile).
    let stale = false;
    fetch(`/api/replays?${params}`)
      .then(r => r.json())
      .then(d => { if (stale) return; setReplays(d.replays ?? []); setTotal(d.total ?? 0); setLoading(false); })
      .catch(() => { if (stale) return; setError("Could not load replays."); setLoading(false); });
    return () => { stale = true; };
  }, [page, pageSize, sortField, sortAsc, filterWinner, filterWinType, debouncedBot, filterFlags, filterStarred, starred]);

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

  const totalPages  = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters  = filterWinner !== "all" || filterWinType !== "all"
    || filterBot.trim() || filterStarred || filterFlags.size > 0;

  const [maps, setMaps] = useState<MapInfo[]>([]);
  useEffect(() => { void fetchMaps().then(setMaps); }, []);
  const sortId = SORTS.find(o => o.field === sortField && o.asc === sortAsc)?.id ?? "new";

  return (
    <div style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", display: "flex", padding: "clamp(20px, 4vh, 48px) clamp(20px, 4vw, 64px)" }}>
      <div className="g-glass g-enter" style={{ width: 1000, maxWidth: "100%", display: "flex", flexDirection: "column", minHeight: 0, alignSelf: "stretch" }}>
        <div style={{ padding: "18px 22px 0", display: "flex", flexDirection: "column", gap: 14 }}>
          <PageTitle label={`${total} match${total === 1 ? "" : "es"}`} title="Replays" right={<IconBtn icon="back" title="Back" small onClick={onBack} />} />

          {/* Filters */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input className="g-input" type="text" placeholder="Search player or bot" aria-label="Search player or bot"
              value={filterBot} onChange={e => setFilterBot(e.target.value)} style={{ width: 190, padding: "7px 10px" }} />
            <Seg value={filterWinner} onChange={setFilterWinner} options={[["all", "Any winner"], ["blue", "Blue"], ["red", "Red"], ["draw", "Draw"]]} />
            <Seg value={filterWinType} onChange={setFilterWinType} options={[["all", "Any result"], ["combat", "Crystal"], ["control", "Nodes"], ["timeout", "Time"]]} />
            <button type="button" className={`g-btn small${filterStarred ? " primary" : ""}`} onClick={() => setFilterStarred(v => !v)}>
              <Icon name="star" size={14} />Starred
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="g-label">Flags</span>
            {KNOWN_FLAGS.map(f => (
              <button key={f.id} type="button" className={`g-btn small ghost${filterFlags.has(f.id) ? " primary" : ""}`} onClick={() => toggleFlag(f.id)}>{f.label}</button>
            ))}
            <span style={{ flex: 1 }} />
            <label className="g-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>Sort
              <select className="g-input" value={sortId} style={{ width: "auto", padding: "5px 8px" }}
                onChange={e => { const o = SORTS.find(x => x.id === e.target.value)!; setSortField(o.field); setSortAsc(o.asc); }}>
                {SORTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            <label className="g-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>Show
              <select className="g-input" value={pageSize} style={{ width: "auto", padding: "5px 8px" }} onChange={e => setPageSize(Number(e.target.value))}>
                {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {hasFilters && (
              <button type="button" className="g-btn small ghost" onClick={() => {
                setFilterWinner("all"); setFilterWinType("all");
                setFilterBot(""); setFilterStarred(false);
                setFilterFlags(new Set());
              }}>Clear</button>
            )}
          </div>
        </div>

        {/* List */}
        <div className="g-scroll" style={{ flex: 1, minHeight: 0, padding: "14px 22px", display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--edge)", marginTop: 14 }}>
          {loading && <div className="g-sub g-pulse">Loading…</div>}
          {error && <div className="g-error">{error}</div>}
          {!loading && !error && total === 0 && replays.length === 0 && <div className="g-sub">No replays yet. Every finished match is saved here.</div>}
          {!loading && !error && total > 0 && replays.length === 0 && <div className="g-sub">No replays match these filters.</div>}
          {!loading && replays.map(r => {
            const win = winnerSide(r);
            const wt = r.winType ?? r.outcome.winType;
            const map = maps.find(m => m.mapId === r.mapId);
            const isStarred = starred.has(r.id);
            const side = (team: "blue" | "red", name: string) => (
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{ width: 3, height: 16, background: TEAM[team], flexShrink: 0 }} />
                <span className="g-title" style={{ fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: win && win !== team ? 0.6 : 1 }}>{name}</span>
                {win === team && <Icon name="crystal" size={14} style={{ color: "var(--accent)" }} />}
              </span>
            );
            return (
              <div key={r.id} className="g-glass flat" style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 12px", background: "rgba(255,255,255,0.04)" }}>
                <div style={{ width: 132, flexShrink: 0, overflow: "hidden" }}>
                  {map ? <MapThumb map={map} width={132} /> : <div className="g-label" style={{ height: 24, display: "flex", alignItems: "center" }}>{r.mapId ?? "?"}</div>}
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    {side("blue", r.blue)}
                    <span className="g-label" style={{ color: "var(--ink-faint)" }}>vs</span>
                    {side("red", r.red)}
                  </div>
                  <div className="g-label" style={{ display: "flex", gap: 12, flexWrap: "wrap", letterSpacing: "0.12em" }}>
                    <span>{map?.name ?? r.mapId ?? "Unknown map"}</span>
                    <span>{formatDuration(r.durationSecs)}</span>
                    <span>{win ? (wt ? WIN_TYPE[wt] ?? wt : "Win") : "Draw"}</span>
                    <span title="Units at the end, blue vs red">{unitsSummary(r.blueUnits)} · {unitsSummary(r.redUnits)}</span>
                    {(r.flags ?? []).map(f => <span key={f} style={{ color: "var(--accent)" }}>{flagLabel(f)}</span>)}
                  </div>
                </div>
                <div className="g-label" style={{ textAlign: "right", color: "var(--ink-faint)", flexShrink: 0, lineHeight: 1.6 }}>
                  <div>{formatDate(r.timestamp)}</div>
                  <div>v{r.version ?? "?"}</div>
                </div>
                <IconBtn icon="star" title={isStarred ? "Unstar" : "Star"} small on={isStarred} onClick={() => toggleStar(r.id)} />
                <button type="button" className="g-btn primary small" onClick={() => onWatch(r.id, r.outcome.ticks, r.version)}>
                  <Icon name="play" size={14} />Watch
                </button>
              </div>
            );
          })}
        </div>

        {/* Pages */}
        {!loading && total > pageSize && (
          <div style={{ padding: "12px 22px 16px", borderTop: "1px solid var(--edge)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <button type="button" className="g-btn small" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</button>
            <span className="g-label">Page {page} of {totalPages} · {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
            <button type="button" className="g-btn small" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Segmented choice (one of a few values). */
function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div style={{ display: "flex" }}>
      {options.map(([id, label]) => (
        <button key={id} type="button" className={`g-btn small${value === id ? " primary" : " ghost"}`} style={{ marginLeft: -1 }} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

export type { ReplayMeta };
