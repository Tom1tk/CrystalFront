/**
 * Tournaments (docs/TOURNAMENT_SPEC.md §5, §7): the public list, the create form and the live
 * dashboard at /t/<CODE> — standings, rounds, live games, the player's own status and, for the
 * manager's browser, the manager panel. The server pushes the whole state on every change.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon, IconBtn, PageTitle, Tabs, Toggle } from "../design/glass";
import type { MapInfo } from "./MapPicker";
import type { TournamentView, TournamentMatchReady } from "../hooks/useWebSocket";
import { FORMAT_LABEL, type TournamentSeries, type TournamentSummary, type TournamentSettings, type TournamentEntrant, type SeriesLength, type TournamentFormat, type TournamentStanding } from "@crystalfront/shared";

interface BotChoice { id: string; name: string }

interface Props {
  /** Dashboard code, or null for the list. */
  code: string | null;
  view: TournamentView | null;
  error: string | null;
  ready: TournamentMatchReady | null;
  maps: MapInfo[];
  onOpen: (code: string | null) => void;
  onBack: () => void;
  send: (type: string, payload?: Record<string, unknown>) => void;
  /** Enter this player's live game. */
  onPlay: () => void;
  onWatchReplay: (replayId: string) => void;
  /** Watch a live series (delayed by the spectator delay). */
  onSpectate: (slot: number) => void;
}

const FORMATS: TournamentFormat[] = ["single", "double", "round_robin", "swiss"];
const FORMAT_HELP: Record<TournamentFormat, string> = {
  single: "Lose a series and you're out. Byes for the top seeds when the field isn't a power of 2.",
  double: "Out after two series losses: a winners and a losers bracket, then a grand final (with a reset if the losers-bracket player wins it).",
  round_robin: "Everyone plays everyone once.",
  swiss: "A set number of rounds; each round pairs players on the same score.",
};
const isBracket = (f: TournamentFormat) => f === "single" || f === "double";

const STATUS_LABEL: Record<string, string> = { registering: "Registering", running: "Running", finished: "Finished", cancelled: "Cancelled" };

function savedName() {
  try { return window.localStorage.getItem("cf.name") ?? ""; } catch { return ""; }
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function TournamentScreen(props: Props) {
  return (
    <div style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", display: "flex", padding: "clamp(20px, 4vh, 48px) clamp(20px, 4vw, 64px)" }}>
      <div className="g-glass g-enter" style={{ width: 900, maxWidth: "100%", display: "flex", flexDirection: "column", minHeight: 0, alignSelf: "stretch" }}>
        {props.code ? <Dashboard {...props} code={props.code} /> : <List {...props} />}
      </div>
    </div>
  );
}

// ── list + create ─────────────────────────────────────────────────────────────

function List({ onOpen, onBack, send, maps, error }: Props) {
  const [items, setItems] = useState<TournamentSummary[] | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => fetch("/api/tournaments").then((r) => r.json()).then((d) => { if (live) setItems(d.tournaments); }).catch(() => { if (live) setItems([]); });
    void load();
    const id = setInterval(load, 5000);
    return () => { live = false; clearInterval(id); };
  }, []);
  const sorted = useMemo(() => {
    const order = { running: 0, registering: 1, finished: 2, cancelled: 3 } as Record<string, number>;
    return [...(items ?? [])].sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
  }, [items]);

  if (creating) return <CreateForm maps={maps} error={error} onCancel={() => setCreating(false)} onCreate={(settings) => send("tournament_create", { settings })} />;

  return (
    <>
      <div style={{ padding: "18px 22px 0", display: "flex", flexDirection: "column", gap: 14 }}>
        <PageTitle label="Beta rules" title="Tournaments" right={<IconBtn icon="back" title="Back" small onClick={onBack} />} />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="g-btn primary" onClick={() => setCreating(true)}><Icon name="flag" size={16} />Create</button>
          <input className="g-input" value={joinCode} maxLength={6} placeholder="CODE" aria-label="Tournament code"
            style={{ width: 150, fontFamily: "var(--mono)", letterSpacing: "0.3em", textTransform: "uppercase" }}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
            onKeyDown={(e) => { if (e.key === "Enter" && joinCode.length === 6) onOpen(joinCode); }} />
          <button type="button" className="g-btn" disabled={joinCode.length !== 6} onClick={() => onOpen(joinCode)}>Open</button>
        </div>
      </div>
      <div className="g-scroll" style={{ flex: 1, minHeight: 0, padding: "16px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
        {items === null && <div className="g-sub">Loading…</div>}
        {items?.length === 0 && <div className="g-sub">No tournaments yet. Create one and share its code.</div>}
        {sorted.map((t) => (
          <button key={t.id} type="button" className="g-card" onClick={() => onOpen(t.code)}
            style={{ padding: "12px 14px", display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
              <span className="g-card-name">{t.name}</span>
              <span className="g-card-meta">{t.code} · {FORMAT_LABEL[t.format ?? "swiss"]} · {t.entrants} entrants · {new Date(t.createdAt).toLocaleDateString()}</span>
            </span>
            <span className="g-card-meta" style={{ color: t.status === "running" ? "var(--accent)" : undefined }}>
              {STATUS_LABEL[t.status]}{t.status === "running" ? ` · round ${t.round}${isBracket(t.format ?? "swiss") ? "" : `/${t.rounds}`}` : ""}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function CreateForm({ maps, error, onCancel, onCreate }: { maps: MapInfo[]; error: string | null; onCancel: () => void; onCreate: (s: Partial<TournamentSettings> & { name: string }) => void }) {
  const pool = maps.filter((m) => m.pool);
  const [name, setName] = useState(`${savedName() || "Open"} Cup`);
  const [settings, setSettings] = useState<Omit<TournamentSettings, "name" | "roundBestOf">>({
    format: "single", rounds: 3, seeding: "random", bestOf: 1, mapPool: pool.map((m) => m.mapId),
    readySeconds: 60, autoAdvance: true, advanceSeconds: 60, spectatorDelay: 45,
  });
  useEffect(() => { if (!settings.mapPool.length && pool.length) setSettings((s) => ({ ...s, mapPool: pool.map((m) => m.mapId) })); }, [pool.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div style={{ padding: "18px 22px 0" }}>
        <PageTitle label="New tournament" title="Create" right={<IconBtn icon="back" title="Back" small onClick={onCancel} />} />
      </div>
      <div className="g-scroll" style={{ flex: 1, minHeight: 0, padding: "16px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
        <label><span className="g-label">Name</span>
          <input className="g-input" style={{ marginTop: 6 }} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <SettingsFields settings={settings} onChange={(p) => setSettings((s) => ({ ...s, ...p }))} maps={pool} withFormat withSeeding />
        <p className="g-sub" style={{ margin: 0 }}>Games use the beta rules (Surges, 20:00 cap, draws). You manage the tournament from this browser; you can also enter it yourself.</p>
      </div>
      <div style={{ padding: "14px 22px 18px", borderTop: "1px solid var(--edge)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span className="g-error">{error}</span>
        <button type="button" className="g-btn primary big" disabled={!name.trim() || !settings.mapPool.length} onClick={() => onCreate({ ...settings, name: name.trim() })}>
          <Icon name="flag" size={18} />Create tournament
        </button>
      </div>
    </>
  );
}

type EditableSettings = Omit<TournamentSettings, "name" | "roundBestOf">;

function SettingsFields({ settings, onChange, maps, withFormat, withSeeding }: {
  settings: EditableSettings; onChange: (p: Partial<EditableSettings>) => void; maps: MapInfo[]; withFormat?: boolean; withSeeding?: boolean;
}) {
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
  const togglePool = (id: string) => onChange({ mapPool: settings.mapPool.includes(id) ? settings.mapPool.filter((m) => m !== id) : [...settings.mapPool, id] });
  return (
    <>
      {withFormat && (
        <div><span className="g-label">Format</span>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {FORMATS.map((f) => (
              <button key={f} type="button" className={`g-btn small${settings.format === f ? " primary" : ""}`} onClick={() => onChange({ format: f })}>{FORMAT_LABEL[f]}</button>
            ))}
          </div>
          <p className="g-sub" style={{ margin: "6px 0 0" }}>{FORMAT_HELP[settings.format]}</p>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        {withFormat && settings.format === "swiss" && (
          <label><span className="g-label">Rounds</span>
            <input className="g-input" style={{ marginTop: 6 }} type="number" min={1} max={32} value={settings.rounds} onChange={(e) => onChange({ rounds: num(e.target.value, 1, 32) })} />
          </label>
        )}
        <div><span className="g-label">Series</span>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {([1, 3, 5] as SeriesLength[]).map((n) => (
              <button key={n} type="button" className={`g-btn small${settings.bestOf === n ? " primary" : ""}`} onClick={() => onChange({ bestOf: n })}>Bo{n}</button>
            ))}
          </div>
        </div>
        {withSeeding && (
          <div><span className="g-label">Seeding</span>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {(["random", "manual"] as const).map((s) => (
                <button key={s} type="button" className={`g-btn small${settings.seeding === s ? " primary" : ""}`} onClick={() => onChange({ seeding: s })}>{s}</button>
              ))}
            </div>
          </div>
        )}
        <label><span className="g-label">Ready check (s)</span>
          <input className="g-input" style={{ marginTop: 6 }} type="number" min={15} max={300} value={settings.readySeconds} onChange={(e) => onChange({ readySeconds: num(e.target.value, 15, 300) })} />
        </label>
        <label><span className="g-label">Spectator delay (s)</span>
          <input className="g-input" style={{ marginTop: 6 }} type="number" min={30} max={60} value={settings.spectatorDelay} onChange={(e) => onChange({ spectatorDelay: num(e.target.value, 30, 60) })} />
        </label>
        <div><span className="g-label">Next round</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
            <Toggle on={settings.autoAdvance} onChange={(v) => onChange({ autoAdvance: v })} label="Start the next round automatically" />
            {settings.autoAdvance
              ? <input className="g-input" type="number" min={0} max={600} value={settings.advanceSeconds} style={{ width: 90 }} aria-label="Seconds before the next round"
                  onChange={(e) => onChange({ advanceSeconds: num(e.target.value, 0, 600) })} />
              : <span className="g-sub">manager starts it</span>}
          </div>
        </div>
      </div>
      <div>
        <span className="g-label">Map pool · one map per round, no repeats until the pool runs out</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {maps.map((m) => (
            <button key={m.mapId} type="button" className={`g-btn small${settings.mapPool.includes(m.mapId) ? " primary" : ""}`} onClick={() => togglePool(m.mapId)}>{m.name}</button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── dashboard ────────────────────────────────────────────────────────────────

type DashTab = "standings" | "rounds" | "manage";

function Dashboard({ code, view, error, ready, maps, onOpen, send, onPlay, onWatchReplay, onSpectate }: Props & { code: string }) {
  const now = useNow();
  const [tab, setTab] = useState<DashTab>("standings");
  const [roundTab, setRoundTab] = useState<number | null>(null);
  const [name, setName] = useState(savedName);
  const state = view?.state.code === code ? view.state : null;
  const viewer = state ? view!.viewer : null;
  if (!state || !viewer) {
    return (
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
        <PageTitle label={code} title="Tournament" right={<IconBtn icon="back" title="Back" small onClick={() => onOpen(null)} />} />
        {error ? <div className="g-error">{error}</div> : <div className="g-sub">Loading…</div>}
      </div>
    );
  }
  const ent = (id: string | null | undefined) => state.entrants.find((e) => e.id === id);
  const nameOf = (id: string | null | undefined) => (id ? ent(id)?.name ?? "?" : "Bye");
  const mapName = (id: string) => maps.find((m) => m.mapId === id)?.name ?? id;
  const round = state.rounds[state.rounds.length - 1];
  const me = viewer.entrantId ? ent(viewer.entrantId) : undefined;
  const mySeries = round && me ? round.series.find((s) => s.a === me.id || s.b === me.id) : undefined;
  const playing = round?.series.filter((s) => s.status !== "done").length ?? 0;
  const shownRound = state.rounds.find((r) => r.number === roundTab) ?? round;

  const statusOf = (e: TournamentEntrant): string => {
    if (e.withdrawn) return "withdrawn";
    const s = round?.series.find((x) => x.a === e.id || x.b === e.id);
    if (!s || state.status !== "running") return "";
    if (s.b === null) return "bye";
    if (s.status === "playing") return "playing";
    if (s.status === "ready_check") return (s.a === e.id ? s.ready.a : s.ready.b) ? "ready" : "ready check";
    if (s.status === "interrupted") return "interrupted";
    return "waiting";
  };

  return (
    <>
      <div style={{ padding: "18px 22px 0", display: "flex", flexDirection: "column", gap: 12 }}>
        <PageTitle label={`${state.code} · ${STATUS_LABEL[state.status]}${state.paused ? " · paused" : ""}`} title={state.settings.name}
          right={<IconBtn icon="back" title="All tournaments" small onClick={() => onOpen(null)} />} />
        <div className="g-card-meta" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>{FORMAT_LABEL[state.settings.format]}</span>
          <span>Round {state.rounds.length}{isBracket(state.settings.format) ? "" : ` / ${state.settings.rounds}`}</span>
          {round && <span>Map: {mapName(round.map)}</span>}
          <span>Bo{round?.bestOf ?? state.settings.bestOf}</span>
          <span>{state.entrants.filter((e) => !e.withdrawn).length} entrants</span>
          {state.nextRoundAt && <span style={{ color: "var(--accent)" }}>Next round in {clock(state.nextRoundAt - now)}</span>}
        </div>
        <YourStatus state={state} me={me} series={mySeries} ready={ready} now={now} playing={playing} nameOf={nameOf} mapName={mapName}
          name={name} setName={setName} send={send} onPlay={onPlay} />
        {error && <div className="g-error">{error}</div>}
        <Tabs<DashTab> value={tab} onChange={setTab} tabs={[
          { id: "standings", label: "Standings", icon: "star" },
          { id: "rounds", label: "Rounds", icon: "flag" },
          ...(viewer.isManager ? [{ id: "manage" as const, label: "Manage", icon: "wrench" as const }] : []),
        ]} />
      </div>

      <div className="g-scroll" style={{ flex: 1, minHeight: 0, padding: "14px 22px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
        {tab === "standings" && (
          <>
            {round && round.series.some((s) => s.status === "playing") && (
              <section>
                <div className="g-label" style={{ marginBottom: 8 }}>Live</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
                  {round.series.filter((s) => s.status === "playing").map((s) => (
                    <div key={s.slot} className="g-card" style={{ padding: "10px 12px", cursor: "default", display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <span className="g-card-name">{nameOf(s.a)} <span style={{ color: "var(--ink-dim)" }}>vs</span> {nameOf(s.b)}</span>
                        <span className="g-card-meta">{s.label ? `${s.label} · ` : ""}Game {s.games.length} · {mapName(s.games[s.games.length - 1]?.map ?? round.map)} · {seriesScore(s)}</span>
                      </div>
                      <button type="button" className="g-btn small" title={`Watch, ${state.settings.spectatorDelay} s behind live`} onClick={() => onSpectate(s.slot)}>
                        <Icon name="play" size={12} />Spectate
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <StandingsTable state={state} statusOf={statusOf} meId={me?.id} />
          </>
        )}

        {tab === "rounds" && (
          state.rounds.length === 0 ? <div className="g-sub">Pairings appear when the tournament starts.</div> : (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {state.rounds.map((r) => (
                  <button key={r.number} type="button" className={`g-btn small${r.number === shownRound?.number ? " primary" : ""}`} onClick={() => setRoundTab(r.number)}>Round {r.number}</button>
                ))}
              </div>
              {shownRound && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="g-card-meta">{mapName(shownRound.map)} · Bo{shownRound.bestOf}</div>
                  {shownRound.series.map((s) => (
                    <SeriesRow key={s.slot} s={s} nameOf={nameOf} mapName={mapName} onWatchReplay={onWatchReplay}
                      manage={viewer.isManager && state.status === "running" && (!isBracket(state.settings.format) || shownRound === round) ? (result) => {
                        if (result !== "replay" || window.confirm("Replay this series from the start?")) send("tournament_admin", { op: "set_result", round: shownRound.number, slot: s.slot, result });
                      } : undefined} />
                  ))}
                </div>
              )}
            </>
          )
        )}

        {tab === "manage" && viewer.isManager && <ManagerPanel state={state} maps={maps} send={send} />}
      </div>
    </>
  );
}

function seriesScore(s: TournamentSeries): string {
  let a = 0, b = 0;
  for (const g of s.games) { if (g.result === "a") a++; else if (g.result === "b") b++; else if (g.result === "draw") { a += 0.5; b += 0.5; } }
  return `${a}–${b}`;
}

const RESULT_TEXT: Record<string, string> = { a: "", b: "", draw: "Draw", both_lose: "Both lose (no-show)", void: "Void" };

function SeriesRow({ s, nameOf, mapName, onWatchReplay, manage }: {
  s: TournamentSeries; nameOf: (id: string | null) => string; mapName: (id: string) => string;
  onWatchReplay: (id: string) => void; manage?: (result: string) => void;
}) {
  const winner = s.result === "a" ? s.a : s.result === "b" ? s.b : null;
  const label = s.b === null ? "Bye" : s.status === "done" ? (winner ? `${nameOf(winner)} wins` : RESULT_TEXT[s.result ?? ""] ?? "") : s.status.replace("_", " ");
  return (
    <div className="g-row" style={{ alignItems: "flex-start" }}>
      <div className="g-row-text" style={{ minWidth: 0 }}>
        {s.label && <span className="g-label">{s.label}</span>}
        <span className="g-row-name">
          <span style={{ color: "var(--blue, #6aa7ff)" }}>{nameOf(s.a)}</span>
          {s.b !== null && <> <span style={{ color: "var(--ink-dim)" }}>vs</span> <span style={{ color: "var(--red, #ff7a6a)" }}>{nameOf(s.b)}</span></>}
          {s.b !== null && s.bestOf > 1 && <span className="g-card-meta" style={{ marginLeft: 8 }}>{seriesScore(s)}</span>}
        </span>
        {s.games.length > 0 && s.b !== null && (
          <span className="g-sub" style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
            {s.games.map((g, i) => (
              <span key={i}>
                G{i + 1} {mapName(g.map)}: {g.result ? (g.result === "draw" ? "draw" : nameOf(g.result === "a" ? s.a : s.b)) : g.matchId ? "live" : "—"}
                {g.decided ? ` (${g.decided.replace("_", "-")})` : ""}
                {g.replayId && <> · <a href="#" style={{ color: "var(--accent)" }} onClick={(e) => { e.preventDefault(); onWatchReplay(g.replayId!); }}>replay</a></>}
              </span>
            ))}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span className="g-card-meta">{label}</span>
        {manage && s.b !== null && (
          <select className="g-input" style={{ width: 130, padding: "4px 6px", fontSize: 12 }} value="" aria-label="Set result"
            onChange={(e) => { if (e.target.value) manage(e.target.value); }}>
            <option value="">Set result…</option>
            <option value="a">{nameOf(s.a)} wins</option>
            <option value="b">{nameOf(s.b)} wins</option>
            {!s.node && <option value="draw">Draw</option>}
            <option value="both_lose">Both lose</option>
            {!s.node && <option value="void">Void</option>}
            <option value="replay">Replay series</option>
          </select>
        )}
      </div>
    </div>
  );
}

function StandingsTable({ state, statusOf, meId }: { state: TournamentView["state"]; statusOf: (e: TournamentEntrant) => string; meId?: string }) {
  if (state.entrants.length === 0) return <div className="g-sub">Nobody has joined yet. Share the code <b style={{ fontFamily: "var(--mono)" }}>{state.code}</b>.</div>;
  const byId = new Map(state.entrants.map((e) => [e.id, e]));
  const rows: TournamentStanding[] = state.standings.length ? state.standings : state.entrants.map((e, i) => ({ id: e.id, rank: i + 1, points: 0, wins: 0, draws: 0, losses: 0, buchholz: 0, sb: 0, gameDiff: 0 }));
  const th = { textAlign: "left" as const, padding: "6px 8px", fontWeight: 500 };
  const td = { padding: "7px 8px", borderTop: "1px solid rgba(255,255,255,0.06)" };
  const bracket = isBracket(state.settings.format);
  const finished = state.status === "finished";
  // Elimination: a rank is final once the player is out (or the bracket is over).
  const placed = (r: TournamentStanding) => finished || !!r.outIn;
  const result = (r: TournamentStanding) => {
    if (r.rank === 1 && finished) return "Champion";
    if (r.outIn) return `Out: ${r.outIn}`;
    return state.status === "running" ? "Still in" : "";
  };
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--ui)", fontSize: 13 }}>
      <thead className="g-card-meta"><tr>
        <th style={th}>#</th><th style={th}>Name</th>
        {bracket ? <><th style={th}>W-L</th><th style={th}>Result</th></> : <>
          <th style={th}>Pts</th><th style={th}>W-D-L</th>
          <th style={th} title="Buchholz Cut-1: opponents' points minus the lowest">Buch</th><th style={th} title="Sonneborn-Berger">SB</th>
        </>}
        <th style={th}>Status</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => {
          const e = byId.get(r.id);
          if (!e) return null;
          return (
            <tr key={r.id} style={{ color: e.withdrawn ? "var(--ink-faint)" : undefined, background: r.id === meId ? "rgba(255,255,255,0.06)" : undefined }}>
              <td style={td}>{state.status === "registering" || (bracket && !placed(r)) ? "" : r.rank}</td>
              <td style={td}>{e.bot && <Icon name="bot" size={13} style={{ verticalAlign: -2, marginRight: 5 }} />}{e.name}{r.id === meId ? " (you)" : ""}</td>
              {bracket ? <>
                <td style={td}>{r.wins}-{r.losses}</td>
                <td style={td}>{result(r)}</td>
              </> : <>
                <td style={td}>{r.points}</td>
                <td style={td}>{r.wins}-{r.draws}-{r.losses}</td>
                <td style={td}>{r.buchholz}</td>
                <td style={td}>{r.sb}</td>
              </>}
              <td style={{ ...td, color: statusOf(e) === "playing" ? "var(--accent)" : "var(--ink-dim)" }}>{statusOf(e)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function YourStatus({ state, me, series, ready, now, playing, nameOf, mapName, name, setName, send, onPlay }: {
  state: TournamentView["state"]; me?: TournamentEntrant; series?: TournamentSeries; ready: TournamentMatchReady | null; now: number; playing: number;
  nameOf: (id: string | null) => string; mapName: (id: string) => string; name: string; setName: (n: string) => void;
  send: (type: string, payload?: Record<string, unknown>) => void; onPlay: () => void;
}) {
  const box = (children: React.ReactNode, hot = false) => (
    <div className="g-glass flat" style={{ padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
      background: hot ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)", borderColor: hot ? "var(--accent)" : undefined }}>{children}</div>
  );
  const open = state.status === "registering" || (state.status === "running" && state.settings.format === "swiss");
  if (!me) {
    if (!open || state.locked) return null;
    return box(<>
      <span className="g-sub">{state.status === "running" ? "Late entries start on 0 points." : "Enter this tournament:"}</span>
      <span style={{ display: "flex", gap: 8 }}>
        <input className="g-input" value={name} maxLength={20} placeholder="Player name" style={{ width: 180 }} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="g-btn primary" disabled={!name.trim()} onClick={() => send("tournament_join", { username: name.trim() })}>Join</button>
      </span>
    </>);
  }
  if (me.withdrawn) return box(<span className="g-sub">You have withdrawn from this tournament.</span>);
  if (state.status === "registering") return box(<>
    <span className="g-sub">Registered as <b>{me.name}</b>. Waiting for the manager to start.</span>
    <button type="button" className="g-btn small danger" onClick={() => send("tournament_leave")}>Leave</button>
  </>);
  if (state.status !== "running" || !series) return null;
  const opp = nameOf(series.a === me.id ? series.b : series.a);
  const game = series.games[series.games.length - 1];
  if (series.b === null) return box(<span className="g-sub">You have a bye this round (1 point).</span>);
  const stage = series.label ? `${series.label}: ` : "";
  if (series.status === "ready_check") {
    const mine = series.a === me.id ? series.ready.a : series.ready.b;
    const side = game?.blue === me.id ? "blue" : "red";
    return box(<>
      <span className="g-sub" style={{ color: "var(--ink)" }}>
        {stage}Round {state.rounds.length}{series.bestOf > 1 || series.games.length > 1 ? `, game ${series.games.length}` : ""} vs <b>{opp}</b> on {mapName(game?.map ?? ready?.map ?? "")} as {side}
        {series.deadline ? ` · ${clock(series.deadline - now)}` : ""}
      </span>
      {mine ? <span className="g-card-meta">Ready · waiting for {opp}</span>
        : <button type="button" className="g-btn primary g-pulse" onClick={() => send("tournament_ready")}><Icon name="check" size={16} />Ready</button>}
    </>, !mine);
  }
  if (series.status === "playing") return box(<>
    <span className="g-sub" style={{ color: "var(--ink)" }}>Your game vs <b>{opp}</b> is live.</span>
    <button type="button" className="g-btn primary" onClick={onPlay}><Icon name="play" size={16} />Enter game</button>
  </>, true);
  if (series.status === "interrupted") return box(<span className="g-sub">Your game was interrupted by a server restart. The manager will replay or adjudicate it.</span>);
  return box(<>
    <span className="g-sub">{playing > 0 ? `Waiting for round ${state.rounds.length} to finish (${playing} ${playing === 1 ? "match" : "matches"} still playing).` : "Waiting for the next round."}</span>
    <button type="button" className="g-btn small danger" onClick={() => { if (window.confirm("Withdraw from the tournament? Your results so far stand.")) send("tournament_leave"); }}>Withdraw</button>
  </>);
}

// ── manager panel (§7) ───────────────────────────────────────────────────────

function ManagerPanel({ state, maps, send }: { state: TournamentView["state"]; maps: MapInfo[]; send: (type: string, payload?: Record<string, unknown>) => void }) {
  const admin = (op: string, args: Record<string, unknown> = {}) => send("tournament_admin", { op, ...args });
  const [bots, setBots] = useState<BotChoice[]>([]);
  const [bot, setBot] = useState("");
  const [rounds, setRounds] = useState(state.settings.rounds);
  const [settings, setSettings] = useState<EditableSettings>(state.settings);
  useEffect(() => { void fetch("/api/tournaments").then((r) => r.json()).then((d) => { setBots(d.bots ?? []); setBot(d.bots?.[0]?.id ?? ""); }).catch(() => {}); }, []);
  useEffect(() => { setRounds(state.settings.rounds); }, [state.settings.rounds]);
  const reg = state.status === "registering", running = state.status === "running", open = reg || running;
  const swiss = state.settings.format === "swiss";
  const round = state.rounds[state.rounds.length - 1];
  const roundBusy = !!round && round.series.some((s) => s.status !== "done");
  const canRepair = !!round && round.series.every((s) => s.b === null || s.games.length === 0 || s.status === "ready_check");
  const active = state.entrants.filter((e) => !e.withdrawn);
  const move = (i: number, d: number) => {
    const ids = active.map((e) => e.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    admin("seed_order", { ids });
  };
  const section = (title: string, children: React.ReactNode) => (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}><div className="g-label">{title}</div>{children}</section>
  );
  if (!open) return <div className="g-sub">This tournament is {state.status}. It stays viewable, read-only.</div>;
  return (
    <>
      {section("Tournament", (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {reg && <button type="button" className="g-btn primary" disabled={active.length < 2} onClick={() => admin("start")}><Icon name="play" size={16} />Start ({active.length})</button>}
          <button type="button" className="g-btn small" onClick={() => admin(state.locked ? "unlock" : "lock")}>{state.locked ? "Open registration" : "Lock registration"}</button>
          {running && <button type="button" className="g-btn small" onClick={() => admin(state.paused ? "resume" : "pause")}>{state.paused ? "Resume" : "Pause"}</button>}
          {running && !roundBusy && state.rounds.length < state.settings.rounds && <button type="button" className="g-btn small primary" onClick={() => admin("next_round")}>Start next round now</button>}
          {running && swiss && canRepair && <button type="button" className="g-btn small" onClick={() => admin("repair")}>Re-pair this round</button>}
          {swiss && <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="g-sub">Rounds</span>
            <input className="g-input" type="number" min={Math.max(1, state.rounds.length)} max={32} value={rounds} style={{ width: 70 }} onChange={(e) => setRounds(Number(e.target.value))} />
            <button type="button" className="g-btn small" disabled={rounds === state.settings.rounds} onClick={() => admin("set_rounds", { rounds })}>Set</button>
          </span>}
        </div>
      ))}

      {section("Entrants", (
        <>
          {(reg || swiss) && <div style={{ display: "flex", gap: 8 }}>
            <select className="g-input" value={bot} onChange={(e) => setBot(e.target.value)} style={{ flex: 1 }} aria-label="Bot">
              {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button type="button" className="g-btn small" disabled={!bot} onClick={() => admin("add_bot", { bot })}><Icon name="bot" size={14} />Add bot</button>
          </div>}
          {state.entrants.map((e) => {
            const i = active.indexOf(e);
            return (
              <div key={e.id} className="g-row" style={{ padding: "6px 0" }}>
                <span className="g-row-name" style={{ color: e.withdrawn ? "var(--ink-faint)" : undefined }}>
                  {reg && state.settings.seeding === "manual" && i >= 0 ? `${i + 1}. ` : ""}{e.name}{e.withdrawn ? " (withdrawn)" : ""}{state.managerEntrant === e.id ? " · manager" : ""}
                </span>
                <span style={{ display: "flex", gap: 6 }}>
                  {reg && state.settings.seeding === "manual" && i >= 0 && <>
                    <button type="button" className="g-btn small ghost" disabled={i === 0} onClick={() => move(i, -1)} title="Seed up">▲</button>
                    <button type="button" className="g-btn small ghost" disabled={i === active.length - 1} onClick={() => move(i, 1)} title="Seed down">▼</button>
                  </>}
                  {!e.bot && !e.withdrawn && state.managerEntrant !== e.id && (
                    <button type="button" className="g-btn small ghost" onClick={() => { if (window.confirm(`Make ${e.name} the manager? You lose the manager controls.`)) admin("transfer", { entrantId: e.id }); }}>Make manager</button>
                  )}
                  {!e.withdrawn && (
                    <button type="button" className="g-btn small danger" onClick={() => {
                      if (reg) admin("kick", { entrantId: e.id });
                      else if (window.confirm(`Withdraw ${e.name}? Their current series is forfeited; past results stand.`)) admin("withdraw", { entrantId: e.id });
                    }}>{reg ? "Kick" : "Withdraw"}</button>
                  )}
                </span>
              </div>
            );
          })}
        </>
      ))}

      {section("Settings for future rounds", (
        <>
          <SettingsFields settings={settings} onChange={(p) => setSettings((s) => ({ ...s, ...p }))} maps={maps.filter((m) => m.pool)} withSeeding={reg} withFormat={reg} />
          <div><button type="button" className="g-btn small primary" onClick={() => admin("settings", { settings: { ...settings, rounds: undefined, ...(reg ? {} : { format: undefined }) } })}>Save settings</button></div>
        </>
      ))}

      {section("End", (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {running && <button type="button" className="g-btn small" onClick={() => { if (window.confirm("Finish now? Games in progress may finish, then the standings are final.")) admin("finish"); }}>Finish early</button>}
          {running && roundBusy && <button type="button" className="g-btn small" onClick={() => { if (window.confirm("Finish now and void the games in progress?")) admin("finish", { void: true }); }}>Finish, void live games</button>}
          <button type="button" className="g-btn small danger" onClick={() => { if (window.confirm("Cancel the tournament? It is kept, marked cancelled.")) admin("cancel"); }}>Cancel tournament</button>
        </div>
      ))}
    </>
  );
}
