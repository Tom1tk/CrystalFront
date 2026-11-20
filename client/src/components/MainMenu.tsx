/**
 * Main menu and Play screen (G-12, UI-3): glass panels on the left over the live 3D
 * backdrop. Play has three tabs: vs Bot, Online (host / join) and Solo test.
 */
import { useState } from "react";
import { Icon, Tabs, PageTitle, Wordmark, IconBtn } from "../design/glass";
import { MapCards } from "./MapPicker";
import type { Ruleset } from "../types";

declare const __APP_VERSION__: string;

const BOTS: Array<{ name: string; label: string; sub: string }> = [
  { name: "idle", label: "Idle", sub: "Does nothing. For learning the controls." },
  { name: "passive", label: "Passive", sub: "Builds an economy, never attacks." },
  { name: "rush_weak", label: "Weak Rush", sub: "Attacks with 4 units at about 40 s." },
  { name: "rush_weak_medium", label: "Weak-Med Rush", sub: "Attacks with 6 units at about 30 s." },
  { name: "rush_medium", label: "Medium Rush", sub: "Keeps attacking from about 20 s." },
  { name: "rush", label: "Rush", sub: "Fast, aggressive pushes." },
  { name: "turtle", label: "Turtle", sub: "Heavy defence." },
  { name: "macro", label: "Macro", sub: "Economy first." },
  { name: "heavy", label: "Heavy", sub: "Bruiser-heavy army." },
];

/** Trained neural opponents (G-10): three snapshots of the same policy, further into training. */
const NEURAL: Array<{ name: string; label: string; sub: string }> = [
  { name: "neural_easy", label: "Easy", sub: "Learned by copying the scripted bots." },
  { name: "neural_normal", label: "Normal", sub: "After one round of self-play." },
  { name: "neural_hard", label: "Hard", sub: "After three rounds of self-play." },
];

/**
 * Beta scripted opponents (mainline 0.10 plan §2a): the v2 training bots, which see only what
 * their own units see. Sent as "v3_<name>".
 */
const BETA_SCRIPTED: Array<{ group: string; bots: Array<{ name: string; label: string; sub: string }> }> = [
  { group: "Rush", bots: [
    { name: "rush1", label: "Light Rush", sub: "Five skirmishers at about 1:30; raids your workers." },
    { name: "rush2", label: "Rush", sub: "Early skirmisher or gunner pushes." },
    { name: "rush3", label: "Double Rush", sub: "Two barracks, constant skirmishers." },
    { name: "rush_post", label: "Outpost Rush", sub: "Rush with outposts at home." },
  ] },
  { group: "Defensive", bots: [
    { name: "turtle", label: "Turtle", sub: "Turrets, then a control win." },
    { name: "gunline", label: "Gunline", sub: "Economy, then massed gunners." },
    { name: "phalanx", label: "Phalanx", sub: "Gunners behind bulwarks." },
    { name: "siege", label: "Siege", sub: "Turtle, then outposts at your door." },
  ] },
  { group: "Macro", bots: [
    { name: "macro", label: "Macro", sub: "Economy first, then a mixed army." },
    { name: "heavy", label: "Heavy", sub: "Foundry first, slow heavy push." },
    { name: "swarm", label: "Swarm", sub: "Skirmisher and medic swarm." },
    { name: "swarm_mass", label: "Mass", sub: "Twenty skirmishers at once." },
    { name: "swarm_tide", label: "Tide", sub: "Turrets at home, late swarm." },
  ] },
  { group: "Switchers", bots: [
    { name: "sw_rush_turtle", label: "Rush → Turtle", sub: "Rushes, then digs in." },
    { name: "sw_macro_bruiser", label: "Macro → Bruisers", sub: "Economy, then a bruiser timing." },
    { name: "sw_fake_brush", label: "Fake Expand", sub: "Fakes an expansion, strikes through brush." },
    { name: "sw_turtle_grab", label: "Turtle → Grab", sub: "Turtles, then grabs the nodes." },
    { name: "sw_read_macro", label: "Scout → Macro", sub: "Scouts you, then answers what it saw." },
    { name: "sw_read_turtle", label: "Scout → Turtle", sub: "Turtles; grabs the nodes if you look weak." },
  ] },
  { group: "Specialists", bots: [
    { name: "hidden", label: "Hidden", sub: "Masses out of sight, then attacks." },
    { name: "backdoor", label: "Backdoor", sub: "Sneaks outposts behind your Crystal." },
    { name: "vanguard", label: "Vanguard", sub: "Swarm with escorted forward outposts." },
  ] },
];

const NAME_KEY = "cf.name";
function savedName() {
  try { return window.localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
}
/** Remembered in this browser as it is typed, like the audio settings. */
function saveName(name: string) {
  try { window.localStorage.setItem(NAME_KEY, name.trim()); } catch { /* storage blocked */ }
}

type PlayTab = "bot" | "online" | "solo";

interface MainMenuProps {
  onHost: (username: string, ruleset: Ruleset) => void;
  onJoin: (code: string, username: string) => void;
  onSoloTest: (username: string, mapId: string, ruleset: Ruleset) => void;
  onBotGame: (username: string, bot: string, mapId: string, ruleset: Ruleset) => void;
  onReplays: () => void;
  onSettings: () => void;
  /** Show this map in the backdrop ("random": keep the current one). */
  onPreviewMap: (mapId: string) => void;
  error?: string | null;
}

export default function MainMenu({ onHost, onJoin, onSoloTest, onBotGame, onReplays, onSettings, onPreviewMap, error: serverError }: MainMenuProps) {
  const [page, setPage] = useState<"home" | "play">("home");
  const [tab, setTab] = useState<PlayTab>("bot");
  const [username, setUsername] = useState(savedName);
  const [code, setCode] = useState("");
  const [bot, setBot] = useState("neural_normal");
  const [mapId, setMapId] = useState("random");
  const [ruleset, setRuleset] = useState<Ruleset>("0.9");
  const [error, setError] = useState("");
  const beta = ruleset === "beta";
  const pickRuleset = (r: Ruleset) => {
    setRuleset(r);
    // Scripted lists differ between versions; the neural picks exist in both.
    if (!bot.startsWith("neural_")) setBot("neural_normal");
  };

  const name = username.trim();
  const pickMap = (id: string) => { setMapId(id); onPreviewMap(id); };
  /** Checks the name, then runs `go`. */
  const withName = (go: (n: string) => void) => {
    setError("");
    if (!name) { setError("Enter a player name first."); return; }
    go(name);
  };
  const shownError = error || serverError;

  return (
    <div style={{ position: "relative", zIndex: 1, width: "100%", height: "100%", display: "flex", padding: "clamp(20px, 4vh, 48px) clamp(20px, 4vw, 64px)" }}>
      {page === "home" && (
        <div className="g-enter" style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 28, width: 400, maxWidth: "100%" }}>
          <div>
            <div className="g-label" style={{ marginBottom: 12 }}>Real-time strategy · 1v1</div>
            <Wordmark size={76} />
            <p className="g-sub" style={{ fontSize: 15, marginTop: 16, maxWidth: 360, color: "var(--ink)", textShadow: "0 1px 8px rgba(0,0,0,0.6)" }}>
              Use terrain, fog and high ground. Hold the contested nodes, or shatter the enemy Crystal.
            </p>
          </div>
          <div className="g-glass" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ display: "block" }}>
              <span className="g-label">Player name</span>
              <input className="g-input" style={{ marginTop: 6 }} value={username} maxLength={20} placeholder="Commander"
                onChange={(e) => { setUsername(e.target.value); saveName(e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") withName(() => setPage("play")); }} />
            </label>
            {shownError && <div className="g-error">{shownError}</div>}
            <button type="button" className="g-btn primary big full left" style={{ marginTop: 6 }} onClick={() => withName(() => setPage("play"))}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}><Icon name="play" size={18} />Play</span>
              <span className="g-btn-sub">vs bot · online · solo</span>
            </button>
            <button type="button" className="g-btn full left" onClick={onReplays}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}><Icon name="film" size={18} />Replays</span>
            </button>
            <button type="button" className="g-btn full left" onClick={onSettings}>
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}><Icon name="gear" size={18} />Settings</span>
            </button>
          </div>
          <div className="g-label" style={{ color: "var(--ink-faint)" }}>v{__APP_VERSION__}</div>
        </div>
      )}

      {page === "play" && (
        <div className="g-glass g-enter" style={{ width: 640, maxWidth: "100%", display: "flex", flexDirection: "column", minHeight: 0, alignSelf: "stretch" }}>
          <div style={{ padding: "18px 22px 0", display: "flex", flexDirection: "column", gap: 14 }}>
            <PageTitle label={`Playing as ${name}`} title="Play" right={<IconBtn icon="back" title="Back" small onClick={() => { setPage("home"); setError(""); }} />} />
            <Tabs<PlayTab> value={tab} onChange={(t) => { setTab(t); setError(""); if (t !== "solo" && (mapId === "testbed" || mapId === "classic")) setMapId("random"); }} tabs={[
              { id: "bot", label: "vs Bot", icon: "bot" },
              { id: "online", label: "Online", icon: "users" },
              { id: "solo", label: "Solo test", icon: "wrench" },
            ]} />
          </div>

          <div className="g-scroll" style={{ flex: 1, minHeight: 0, padding: "16px 22px", display: "flex", flexDirection: "column", gap: 18 }}>
            <section>
              <div className="g-label" style={{ marginBottom: 8 }}>Game version{tab === "online" ? " · when you host" : ""}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                <button type="button" className={`g-card${!beta ? " on" : ""}`} onClick={() => pickRuleset("0.9")} style={{ padding: "10px 11px" }}>
                  <span className="g-card-name">0.9 (stable)</span>
                  <span className="g-sub" style={{ fontSize: 12 }}>The current game.</span>
                </button>
                <button type="button" className={`g-card${beta ? " on" : ""}`} onClick={() => pickRuleset("beta")} style={{ padding: "10px 11px" }}>
                  <span className="g-card-name">0.9.x beta</span>
                  <span className="g-sub" style={{ fontSize: 12 }}>Dev testing only: the next version, unfinished.</span>
                </button>
              </div>
            </section>
            {tab === "bot" && (
              <>
                <section>
                  <div className="g-label" style={{ marginBottom: 8 }}>Neural opponent{beta ? " · 0.9 models" : ""}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                    {NEURAL.map((b) => (
                      <button key={b.name} type="button" className={`g-card${bot === b.name ? " on" : ""}`} onClick={() => setBot(b.name)} style={{ padding: "10px 11px" }}>
                        <span className="g-card-name">{b.label}</span>
                        <span className="g-sub" style={{ fontSize: 12 }}>{beta ? "The 0.9 bot: it ignores the beta's new features." : b.sub}</span>
                      </button>
                    ))}
                  </div>
                </section>
                {!beta && (
                  <section>
                    <div className="g-label" style={{ marginBottom: 8 }}>Scripted opponent</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                      {BOTS.map((b) => (
                        <button key={b.name} type="button" className={`g-card${bot === b.name ? " on" : ""}`} onClick={() => setBot(b.name)} style={{ padding: "10px 11px" }}>
                          <span className="g-card-name">{b.label}</span>
                          <span className="g-sub" style={{ fontSize: 12 }}>{b.sub}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {beta && BETA_SCRIPTED.map((g) => (
                  <section key={g.group}>
                    <div className="g-label" style={{ marginBottom: 8 }}>Scripted · {g.group}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                      {g.bots.map((b) => {
                        const id = `v3_${b.name}`;
                        return (
                          <button key={id} type="button" className={`g-card${bot === id ? " on" : ""}`} onClick={() => setBot(id)} style={{ padding: "10px 11px" }}>
                            <span className="g-card-name">{b.label}</span>
                            <span className="g-sub" style={{ fontSize: 12 }}>{b.sub}</span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
                <section>
                  <div className="g-label" style={{ marginBottom: 8 }}>Map</div>
                  <MapCards value={mapId} onChange={pickMap} columns={3} />
                </section>
              </>
            )}

            {tab === "online" && (
              <>
                <section className="g-glass flat" style={{ padding: 16, background: "rgba(255,255,255,0.04)" }}>
                  <div className="g-title" style={{ fontSize: 18 }}>Host a match</div>
                  <p className="g-sub" style={{ margin: "6px 0 12px" }}>Creates a lobby with a code to share. You pick the map in the lobby.</p>
                  <button type="button" className="g-btn primary" onClick={() => withName((n) => onHost(n, ruleset))}>
                    <Icon name="flag" size={18} />Host
                  </button>
                </section>
                <section className="g-glass flat" style={{ padding: 16, background: "rgba(255,255,255,0.04)" }}>
                  <div className="g-title" style={{ fontSize: 18 }}>Join a match</div>
                  <p className="g-sub" style={{ margin: "6px 0 12px" }}>Enter the code from the host. You play the version the host picked.</p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="g-input" value={code} maxLength={6} placeholder="ABC123" aria-label="Lobby code"
                      style={{ width: 170, fontFamily: "var(--mono)", letterSpacing: "0.3em", textTransform: "uppercase" }}
                      onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                      onKeyDown={(e) => { if (e.key === "Enter" && code) withName((n) => onJoin(code, n)); }} />
                    <button type="button" className="g-btn" disabled={!code} onClick={() => withName((n) => onJoin(code, n))}>Join</button>
                  </div>
                </section>
                {shownError && <div className="g-error">{shownError}</div>}
              </>
            )}

            {tab === "solo" && (
              <section>
                <p className="g-sub" style={{ marginTop: 0 }}>A sandbox against an empty opponent. Debug tools are in Settings → Debug during the match.</p>
                <div className="g-label" style={{ margin: "12px 0 8px" }}>Map</div>
                <MapCards value={mapId} onChange={pickMap} columns={3} dev />
              </section>
            )}
          </div>

          {tab !== "online" && (
            <div style={{ padding: "14px 22px 18px", borderTop: "1px solid var(--edge)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span className="g-error">{shownError}</span>
              <button type="button" className="g-btn primary big" onClick={() => withName((n) => (tab === "bot" ? onBotGame(n, bot, mapId, ruleset) : onSoloTest(n, mapId, ruleset)))}>
                <Icon name="play" size={18} />{tab === "bot" ? "Start match" : "Start solo test"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
