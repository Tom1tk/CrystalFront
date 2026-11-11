/**
 * Game sound effects (Kenney CC0 impact, interface and RPG packs; see docs/VISUAL_PLAN.md).
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
const PREF_KEY = "cf.sound";

export function soundEnabled(): boolean {
  try { return window.localStorage.getItem(PREF_KEY) !== "0"; } catch { return true; }
}
export function setSoundEnabled(on: boolean) {
  try { window.localStorage.setItem(PREF_KEY, on ? "1" : "0"); } catch { /* storage blocked */ }
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<string, AudioBuffer | null>();
const lastPlayed = new Map<SoundName, number>();

/** Browsers only allow audio after a user gesture; the context is created on the first one. */
function unlock() {
  if (ctx) { void ctx.resume(); return; }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
  } catch { ctx = null; return; }
  for (const files of Object.values(SOUNDS)) for (const f of files) void loadBuffer(f);
}
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
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
  if (!ctx || !master || !soundEnabled() || ctx.state !== "running") return;
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
  src.connect(gain).connect(pan).connect(master);
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
