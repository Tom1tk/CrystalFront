/**
 * Settings (G-12, UI-4): a modal with sub-menus, opened from the main menu or in a match
 * (gear button or Esc). The Debug sub-menu only exists in a match.
 */
import { useState, type ReactNode } from "react";
import { Modal, Tabs, Row, Toggle, Slider, useAudioPrefs, type IconName } from "../design/glass";
import { setAudioPrefs } from "../audio";

type Tab = "general" | "audio" | "controls" | "debug";

const TIPS_KEY = "cf.tips";
export function tipsEnabled(): boolean {
  try { return window.localStorage.getItem(TIPS_KEY) !== "0"; } catch { return true; }
}

/** Edge-pan sensitivity, 0–1 (0 turns edge panning off). The camera moves 12 × this world px per frame at the screen edge; the default 0.5 (6 px) is double the old fixed speed. */
const EDGE_PAN_KEY = "cf.edgePan";
let edgePan: number = (() => {
  try { const v = window.localStorage.getItem(EDGE_PAN_KEY); return v === null ? 0.5 : Math.max(0, Math.min(1, Number(v) || 0)); } catch { return 0.5; }
})();
export function edgePanSpeed(): number { return edgePan * 12; }

const SHORTCUTS: Array<[string, string]> = [
  ["Left-click / drag", "Select units and buildings"],
  ["Right-click", "Move, gather, attack or repair"],
  ["Shift + right-click", "Queue an order"],
  ["Q W E R  ·  A S D F", "Commands for the selection (see the command card)"],
  ["A, then left-click", "Attack-move"],
  ["F, then left-click", "Guard a point (units hold a small area around it)"],
  ["F", "Set rally point (building selected)"],
  ["Ctrl + 1–9", "Assign control group"],
  ["Shift + 1–9", "Add to control group"],
  ["1–9 (twice)", "Select group (twice: centre camera)"],
  ["Screen edge / minimap", "Move the camera"],
  ["F3", "Switch 3D / 2D view"],
  ["Esc", "Cancel the current mode, or open Settings"],
];

export default function SettingsModal({ onClose, view3d, onView3d, debug, initialTab, onQuit, quitWarning }: {
  onClose: () => void;
  view3d: boolean;
  onView3d: (v: boolean) => void;
  /** In a match: the debug controls, shown under the Debug sub-menu. */
  debug?: ReactNode;
  initialTab?: Tab;
  /** In a live match: leave it and return to the menu. */
  onQuit?: () => void;
  /** When set, Quit asks for confirmation with this text first (PvP: the quit counts as a loss). */
  quitWarning?: string;
}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "general");
  const audio = useAudioPrefs();
  const [tips, setTips] = useState(tipsEnabled);
  const [pan, setPan] = useState(edgePan);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const tabs: Array<{ id: Tab; label: string; icon: IconName }> = [
    { id: "general", label: "General", icon: "gear" },
    { id: "audio", label: "Audio", icon: "sound" },
    { id: "controls", label: "Controls", icon: "bolt" },
  ];
  if (debug) tabs.push({ id: "debug", label: "Debug", icon: "wrench" });

  return (
    <Modal title="Settings" onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "170px 1fr", minHeight: 0, flex: 1, borderTop: "1px solid var(--edge)" }}>
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Tabs vertical tabs={tabs} value={tab} onChange={setTab} style={{ padding: "12px 0" }} />
          {onQuit && (
            <div style={{ marginTop: "auto", padding: "12px 14px 16px" }}>
              <button type="button" className="g-btn danger" style={{ width: "100%" }}
                onClick={() => (quitWarning ? setConfirmQuit(true) : onQuit())}>Quit match</button>
            </div>
          )}
        </div>
        <div className="g-scroll" style={{ padding: "8px 22px 18px", minHeight: 320 }}>
          {tab === "general" && (
            <>
              <Row name="3D view" help="The battlefield in 3D. Turn off for the classic top-down 2D view (F3 in a match).">
                <Toggle label="3D view" on={view3d} onChange={onView3d} />
              </Row>
              <Row name="Gameplay tips" help="A short tip at the start of a match.">
                <Toggle label="Gameplay tips" on={tips} onChange={(v) => {
                  setTips(v);
                  try { window.localStorage.setItem(TIPS_KEY, v ? "1" : "0"); } catch { /* storage blocked */ }
                }} />
              </Row>
            </>
          )}
          {tab === "audio" && (
            <>
              <Row name="Sound" help="Mutes all music and effects. Also the speaker icon, top right.">
                <Toggle label="Sound" on={!audio.muted} onChange={(v) => setAudioPrefs({ muted: !v })} />
              </Row>
              <Row name="Music" help="Menu and battle music.">
                <Slider label="Music volume" value={audio.music} disabled={audio.muted} onChange={(v) => setAudioPrefs({ music: v })} />
              </Row>
              <Row name="Effects" help="Combat, orders and alerts.">
                <Slider label="Effects volume" value={audio.sfx} disabled={audio.muted} onChange={(v) => setAudioPrefs({ sfx: v })} />
              </Row>
              <div className="g-sub" style={{ fontSize: 11, marginTop: 14, color: "var(--ink-faint)" }}>
                Music: “Flowing Rocks” and “Drumming Sticks” by Kenney (CC0).
              </div>
            </>
          )}
          {tab === "controls" && (
            <>
            <Row name="Edge panning" help="How fast the camera moves when the mouse is at the screen edge. 0 turns it off.">
              <Slider label="Edge panning sensitivity" value={pan} onChange={(v) => {
                setPan(v);
                edgePan = v;
                try { window.localStorage.setItem(EDGE_PAN_KEY, String(v)); } catch { /* storage blocked */ }
              }} />
            </Row>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 18, rowGap: 9, paddingTop: 14 }}>
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} style={{ display: "contents" }}>
                  <span className="g-kbd" style={{ justifySelf: "start" }}>{k}</span>
                  <span className="g-sub" style={{ color: "var(--ink)" }}>{d}</span>
                </div>
              ))}
            </div>
            </>
          )}
          {tab === "debug" && debug}
        </div>
      </div>
      {confirmQuit && onQuit && (
        <div role="alertdialog" aria-label="Quit match?" style={{ padding: "14px 22px 18px", borderTop: "1px solid var(--edge)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="g-sub" style={{ flex: 1, minWidth: 220, color: "var(--bad)" }}>{quitWarning}</span>
          <button type="button" className="g-btn" onClick={() => setConfirmQuit(false)}>Keep playing</button>
          <button type="button" className="g-btn danger" onClick={onQuit}>Quit and take the loss</button>
        </div>
      )}
    </Modal>
  );
}
