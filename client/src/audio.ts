/**
 * Game sound effects (Kenney CC0 impact, interface and RPG packs; see docs/VISUAL_PLAN.md)
 * and music (Kenney Music Loops, CC0), with the player's mute and volume settings.
 * Works in both the 2D and the 3D view. Sounds come only from what the client can
 * already see: attackLog events between visible entities, deaths, finished buildings
 * and the player's own commands.
 */
import type { AttackEvent } from "./types";
import { SIMULATION } from "@crystalfront/shared";

const BASE = `${import.meta.env.BASE_URL}assets/kenney/audio/`;
const SOUNDS = {
  sword: ["impactPlate_medium_000", "impactPlate_medium_001", "impactPlate_medium_002"],
  spear: ["knifeSlice", "knifeSlice2"],
  punch: ["impactPunch_medium_000", "impactPunch_medium_001"],
  shot: ["impactMetal_light_000", "impactMetal_light_001", "impactMetal_light_002"],
  turret: ["impactMetal_heavy_000", "impactMetal_heavy_001"],
  hitBuilding: ["impactWood_medium_000", "impactWood_medium_001"],
  hitCrystal: ["impactGlass_medium_000", "impactGlass_medium_001"],
  heal: ["maximize_004"],
  death: ["impactSoft_heavy_000", "impactSoft_heavy_001"],
  collapse: ["impactWood_heavy_000"],
  crystalDown: ["impactBell_heavy_000"],
  built: ["confirmation_002"],
  select: ["select_002"],
  order: ["click_002"],
  error: ["error_004"],
  mine: ["impactMining_000", "impactMining_001"],
} as const;
export type SoundName = keyof typeof SOUNDS;

const VOLUME: Partial<Record<SoundName, number>> = {
  shot: 0.35, spear: 0.45, punch: 0.5, sword: 0.45, turret: 0.45, heal: 0.25, hitBuilding: 0.4,
  hitCrystal: 0.5, death: 0.6, select: 0.5, order: 0.5, error: 0.5, built: 0.6, mine: 0.25,
};
/** Minimum gap between two plays of the same sound (ms), so big fights stay readable. */
const GAP_MS = 70;

// ─── Preferences (saved in the browser) ─────────────────────────
// `cf.mute` silences everything; music and effects each have a volume. The old `cf.sound`
// on/off key seeds the mute flag for players who switched sound off before 0.7.4.
export interface AudioPrefs { muted: boolean; music: number; sfx: number }
function readNum(k: string, d: number) {
  try { const v = window.localStorage.getItem(k); return v === null ? d : Math.max(0, Math.min(1, Number(v) || 0)); } catch { return d; }
}
function readPrefs(): AudioPrefs {
  let muted = false;
  try {
    const m = window.localStorage.getItem("cf.mute");
    muted = m === null ? window.localStorage.getItem("cf.sound") === "0" : m === "1";
  } catch { /* storage blocked */ }
  return { muted, music: readNum("cf.vol.music", 0.5), sfx: readNum("cf.vol.sfx", 0.8) };
}
let prefs: AudioPrefs = typeof window === "undefined" ? { muted: false, music: 0.5, sfx: 0.8 } : readPrefs();
const listeners = new Set<() => void>();

export function audioPrefs(): AudioPrefs { return prefs; }
export function setAudioPrefs(p: Partial<AudioPrefs>) {
  prefs = { ...prefs, ...p };
  try {
    window.localStorage.setItem("cf.mute", prefs.muted ? "1" : "0");
    window.localStorage.setItem("cf.vol.music", String(prefs.music));
    window.localStorage.setItem("cf.vol.sfx", String(prefs.sfx));
  } catch { /* storage blocked */ }
  applyGains();
  for (const l of listeners) l();
}
export function onAudioPrefs(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function soundEnabled(): boolean { return !prefs.muted && prefs.sfx > 0; }

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
const buffers = new Map<string, AudioBuffer | null>();
const lastPlayed = new Map<SoundName, number>();

function applyGains() {
  if (!ctx || !master || !sfxBus || !musicBus) return;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(prefs.muted ? 0 : 0.6, t, 0.03);
  sfxBus.gain.setTargetAtTime(prefs.sfx, t, 0.03);
  musicBus.gain.setTargetAtTime(prefs.music * 0.7, t, 0.03);
}

/** Browsers only allow audio after a user gesture; the context is created on the first one.
 *  Music starts a moment later, so a click on the mute icon (handled on pointer-down) wins. */
function unlock() {
  if (ctx) { void ctx.resume(); return; }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.connect(master);
    musicBus = ctx.createGain();
    musicBus.connect(master);
    applyGains();
  } catch { ctx = null; return; }
  for (const files of Object.values(SOUNDS)) for (const f of files) void loadBuffer(f);
  setTimeout(() => { if (wantTrack) void startTrack(wantTrack); }, 0);
}
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
}

// ─── Music (Kenney "Music Loops", CC0) ──────────────────────────
export type Track = "menu" | "match";
const MUSIC = `${import.meta.env.BASE_URL}assets/kenney/music/`;
let wantTrack: Track | null = null;
let playing: { track: Track; src: AudioBufferSourceNode; gain: GainNode } | null = null;
const trackBufs = new Map<Track, Promise<AudioBuffer | null>>();

function trackBuffer(t: Track): Promise<AudioBuffer | null> {
  let p = trackBufs.get(t);
  if (!p) {
    p = fetch(`${MUSIC}${t}.ogg`).then((r) => r.arrayBuffer()).then((d) => ctx!.decodeAudioData(d)).catch(() => null);
    trackBufs.set(t, p);
  }
  return p;
}

async function startTrack(t: Track) {
  if (!ctx || !musicBus || playing?.track === t) return;
  const buf = await trackBuffer(t);
  if (!buf || !ctx || !musicBus || wantTrack !== t || playing?.track === t) return;
  const now = ctx.currentTime;
  if (playing) {
    const old = playing;
    old.gain.gain.setTargetAtTime(0, now, 0.4);
    setTimeout(() => { try { old.src.stop(); } catch { /* already stopped */ } }, 2500);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.gain.setTargetAtTime(1, now, 0.6);
  src.connect(gain).connect(musicBus);
  src.start();
  playing = { track: t, src, gain };
}

/** Which music should play now (null: none). Safe to call before the first user gesture. */
export function setMusic(t: Track | null) {
  wantTrack = t;
  if (!ctx) return;
  if (t) { void startTrack(t); return; }
  if (playing) {
    const old = playing;
    playing = null;
    old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    setTimeout(() => { try { old.src.stop(); } catch { /* already stopped */ } }, 2000);
  }
}

async function loadBuffer(f: string) {
  if (buffers.has(f) || !ctx) return;
  buffers.set(f, null);
  try {
    const data = await (await fetch(`${BASE}${f}.ogg`)).arrayBuffer();
    buffers.set(f, await ctx.decodeAudioData(data));
  } catch { /* missing or undecodable: stay silent */ }
}

/** Play `name`; `pan` is -1 (left) … 1 (right). */
export function play(name: SoundName, opts: { volume?: number; pan?: number } = {}) {
  if (!ctx || !sfxBus || !soundEnabled() || ctx.state !== "running") return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -1e9) < GAP_MS) return;
  const files = SOUNDS[name];
  const buf = buffers.get(files[Math.floor(Math.random() * files.length)]);
  if (!buf) return;
  lastPlayed.set(name, now);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.92 + Math.random() * 0.16;
  const gain = ctx.createGain();
  gain.gain.value = (VOLUME[name] ?? 0.5) * (opts.volume ?? 1);
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));
  src.connect(gain).connect(pan).connect(sfxBus);
  src.start();
}

interface SfxEntity {
  id: string;
  type: string;
  ownerId: string;
  x: number;
  y: number;
  health: number;
  actionState?: string;
  buildingType?: string;
  constructionProgress?: number;
}

/**
 * Turns match state into sounds once per frame. Each attackLog event plays once; after a
 * jump (joining a game, seeking a replay) the log is marked as heard without sounds.
 */
export class MatchSfx {
  private heard = new Set<string>();
  private dying = new Set<string>();
  private building = new Set<string>();
  private lastTick = -1;

  update(
    tick: number,
    attackLog: AttackEvent[],
    entities: SfxEntity[],
    myId: string,
    view: { left: number; width: number },
  ) {
    const jump = this.lastTick < 0 || tick < this.lastTick || tick - this.lastTick > SIMULATION.attackLogRetention;
    if (tick < this.lastTick) { this.heard.clear(); this.dying.clear(); this.building.clear(); }
    this.lastTick = tick;
    const byId = new Map(entities.map((e) => [e.id, e]));
    const where = (x: number) => {
      const t = (x - view.left) / view.width;
      if (t < -0.15 || t > 1.15) return null; // off screen: silent
      return { pan: (t - 0.5) * 1.2, volume: t < 0 || t > 1 ? 0.4 : 1 };
    };

    for (const evt of attackLog) {
      const key = `${evt.tick}:${evt.attackerId}:${evt.targetId}`;
      if (this.heard.has(key)) continue;
      this.heard.add(key);
      if (jump) continue;
      const a = byId.get(evt.attackerId), t = byId.get(evt.targetId);
      if (!a || !t) continue;
      const at = where(t.x);
      if (!at) continue;
      if (evt.isHeal) { play("heal", at); continue; }
      const weapon: SoundName = a.type === "gunner" ? "shot"
        : a.buildingType === "turret" ? "turret"
        : a.type === "bruiser" ? "sword"
        : a.type === "skirmisher" ? "spear" : "punch";
      play(weapon, at);
      if (t.type === "crystal") play("hitCrystal", at);
      else if (t.type === "building") play("hitBuilding", { ...at, volume: at.volume * 0.7 });
    }
    if (this.heard.size > 4000) this.heard.clear();

    for (const e of entities) {
      const dead = e.actionState === "dying" || e.health <= 0;
      if (dead && !this.dying.has(e.id)) {
        this.dying.add(e.id);
        const at = where(e.x);
        if (at) play(e.type === "crystal" ? "crystalDown" : e.type === "building" ? "collapse" : "death", at);
      }
      if (e.type === "building" && e.ownerId === myId) {
        const done = (e.constructionProgress ?? 100) >= 100;
        if (!done) this.building.add(e.id);
        else if (this.building.delete(e.id)) play("built");
      }
    }
  }
}
