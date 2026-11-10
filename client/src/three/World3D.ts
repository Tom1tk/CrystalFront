/**
 * G-11: optional 3D view of a match, built from Kenney CC0 models (see docs/VISUAL_PLAN.md).
 *
 * Purely cosmetic: it reads the same interpolated entities the 2D view draws and holds
 * no gameplay logic. The 2D canvas stays on top as a transparent overlay (input,
 * selection, bars, fog, minimap), so the 3D camera is set up to put every ground point
 * on exactly the screen pixel the 2D view uses:
 *   world (x, height, y / sin(pitch)) seen by an orthographic camera tilted `pitch`
 *   below the horizon projects to screen (x, y), with height lifting a point by
 *   height * cos(pitch).
 */
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { MatchEntity, ResourceNodeDisplay, StaticMap } from "../types";
import { decodeTerrain } from "../terrainCodec";

const PITCH = (55 * Math.PI) / 180;
const SIN = Math.sin(PITCH);
const COS = Math.cos(PITCH);
/** Plateau height of high-ground cells (world px). */
const HIGH_Y = 8;
const TEAM_HEX = [0x7ce8ff, 0xff5cf3];
const BASE = `${import.meta.env.BASE_URL}assets/kenney/`;

const MODELS = {
  worker: "mini-characters/character-worker",
  skirmisher: "mini-characters/character-raider",
  gunner: "mini-characters/character-soldier",
  bruiser: "mini-characters/character-knight",
  medic: "mini-characters/character-female-e",
  sword: "mini-characters/weapon-sword",
  spear: "mini-characters/weapon-spear",
  shooter: "mini-characters/weapon-shooter",
  shield: "mini-characters/shield-rectangle",
  defib: "mini-characters/aid-defibrillator-red",
  towerBase: "tower-defense-kit/tower-round-base",
  towerBottom: "tower-defense-kit/tower-round-bottom-a",
  towerCrystals: "tower-defense-kit/tower-round-crystals",
  turretGun: "tower-defense-kit/weapon-turret",
  nodeCrystal: "tower-defense-kit/detail-crystal-large",
  pebbles: "tower-defense-kit/detail-rocks",
  platform: "mini-forest/building-platform",
  tent: "mini-forest/tent",
  frame: "mini-forest/building-structure",
  roof: "mini-forest/building-roof",
  flag: "mini-forest/flag",
  chimney: "fantasy-town-kit/chimney",
  stall: "fantasy-town-kit/stall-red",
  cart: "fantasy-town-kit/cart-high",
  rockA: "nature-kit/rock_largeA",
  rockB: "nature-kit/rock_tallA",
  rockC: "nature-kit/rock_tallB",
  stoneA: "nature-kit/stone_tallA",
  stoneB: "nature-kit/stone_largeA",
  cliff: "nature-kit/cliff_block_rock",
  bushA: "nature-kit/plant_bushLarge",
  bushB: "nature-kit/plant_bushDetailed",
  tallGrass: "nature-kit/grass_large",
  grass: "nature-kit/grass",
  flower: "nature-kit/flower_redA",
} as const;
type ModelKey = keyof typeof MODELS;

/** 0/1 = team recolour, "r0"/"r1" = team recolour that also takes reds, "gold" = neutral resource, null = original colours. */
type Variant = 0 | 1 | "r0" | "r1" | "gold" | null;

// Ground colours per terrain code (open, rough, high, brush, rock, cliff, water).
const GROUND = ["#6cae4e", "#a08052", "#86c25e", "#4f9a3c", "#8f8a80", "#8a7458", "#3d86c9"];

interface UnitSpec { model: ModelKey; height: number; right?: ModelKey; left?: ModelKey }
const UNITS: Record<string, UnitSpec> = {
  worker: { model: "worker", height: 4.1 },
  skirmisher: { model: "skirmisher", height: 4.1, right: "spear" },
  gunner: { model: "gunner", height: 4.1, right: "shooter" },
  bruiser: { model: "bruiser", height: 4.1, right: "sword", left: "shield" },
  medic: { model: "medic", height: 4.1, right: "defib" },
};

interface Obj {
  root: THREE.Object3D;
  kind: string;
  team: 0 | 1;
  mixer?: THREE.AnimationMixer;
  actions?: Map<string, THREE.AnimationAction>;
  anim?: string;
  yaw: number;
  px: number;
  py: number;
  speed: number;
  body?: THREE.Object3D;
  gun?: THREE.Object3D;
  gem?: THREE.Object3D;
  baseScale?: number;
}

export interface View3D {
  cssW: number;
  cssH: number;
  cameraX: number;
  scale: number;
  hudTop: number;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class World3D {
  readonly canvas: HTMLCanvasElement;
  ready = false;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000);
  private sun: THREE.DirectionalLight;
  private gltf = new Map<ModelKey, GLTF>();
  private mats = new Map<string, THREE.Material>();
  private terrain: THREE.Group | null = null;
  private terrainKey = "";
  private cells: Uint8Array | null = null;
  private sm: StaticMap | null = null;
  private objs = new Map<string, Obj>();
  private nodes = new Map<string, THREE.Object3D>();
  private ringGeo = new THREE.RingGeometry(0.86, 1, 40);
  private ringMats = TEAM_HEX.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false }));
  private last = performance.now();
  private size = { w: 0, h: 0, dpr: 0 };
  private disposed = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color("#141a14");
    this.scene.add(new THREE.HemisphereLight("#e4efff", "#4a4030", 1.5));
    this.sun = new THREE.DirectionalLight("#fff1d6", 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
  }

  async load(): Promise<void> {
    const loader = new GLTFLoader();
    await Promise.all((Object.keys(MODELS) as ModelKey[]).map(async (k) => {
      const g = await loader.loadAsync(`${BASE}${MODELS[k]}.glb`);
      // The nature kit exports metallicFactor 1, which renders near-black without an env map.
      g.scene.traverse((n) => {
        const m = (n as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!m || !("metalness" in m)) return;
        m.metalness = 0;
        // Pull the nature kit's teal greens toward the ground's grass green.
        if (!m.map) {
          const hsl = { h: 0, s: 0, l: 0 };
          m.color.getHSL(hsl);
          if (hsl.h * 360 > 140 && hsl.h * 360 < 190) m.color.setHSL(100 / 360, hsl.s * 0.75, hsl.l * 0.8);
        }
      });
      this.gltf.set(k, g);
    }));
    if (!this.disposed) this.ready = true;
  }

  dispose() {
    this.disposed = true;
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ─── materials ────────────────────────────────────────────────

  /** Copy of `m` whose colormap has its blue/violet swatches shifted to the variant's hue. */
  private variantMat(m: THREE.Material, v: Variant): THREE.Material {
    if (v === null) return m;
    const std = m as THREE.MeshStandardMaterial;
    const img = std.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!img) return m;
    const key = `${std.map!.uuid}:${v}`;
    let out = this.mats.get(key);
    if (out) return out;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const target = v === "gold" ? 44 : v === 0 || v === "r0" ? 188 : 308;
    const reds = v === "r0" || v === "r1";
    const col = new THREE.Color();
    const hsl = { h: 0, s: 0, l: 0 };
    for (let i = 0; i < d.data.length; i += 4) {
      col.setRGB(d.data[i] / 255, d.data[i + 1] / 255, d.data[i + 2] / 255);
      col.getHSL(hsl);
      const deg = hsl.h * 360;
      const red = reds && hsl.s >= 0.4 && (deg < 15 || deg > 340);
      if (!red && (hsl.s < 0.3 || deg < 195 || deg > 330)) continue;
      col.setHSL(target / 360, Math.min(1, hsl.s * (v === "gold" ? 1.1 : 1.15)), v === "gold" ? Math.min(0.75, hsl.l + 0.05) : hsl.l);
      d.data[i] = col.r * 255;
      d.data[i + 1] = col.g * 255;
      d.data[i + 2] = col.b * 255;
    }
    ctx.putImageData(d, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = std.map!.flipY;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = std.map!.magFilter;
    tex.minFilter = std.map!.minFilter;
    out = std.clone();
    (out as THREE.MeshStandardMaterial).map = tex;
    this.mats.set(key, out);
    return out;
  }

  private paint(o: THREE.Object3D, v: Variant) {
    o.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (v !== null) mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((mm) => this.variantMat(mm, v)) : this.variantMat(mesh.material, v);
    });
  }

  /** A fresh copy of a model, scaled so its largest horizontal side is `width`, base at y=0. */
  private place(k: ModelKey, width: number, v: Variant = null): THREE.Object3D {
    const src = this.gltf.get(k)!;
    const inner = src.animations.length ? cloneSkinned(src.scene) : src.scene.clone(true);
    this.paint(inner, v);
    const box = new THREE.Box3().setFromObject(src.scene);
    const size = box.getSize(new THREE.Vector3());
    const s = width / Math.max(size.x, size.z);
    inner.scale.setScalar(s);
    inner.position.set(-((box.min.x + box.max.x) / 2) * s, -box.min.y * s, -((box.min.z + box.max.z) / 2) * s);
    const g = new THREE.Group();
    g.add(inner);
    g.userData.height = size.y * s;
    return g;
  }

  // ─── terrain ──────────────────────────────────────────────────

  private cellAt(x: number, y: number): number {
    const sm = this.sm;
    if (!sm || !this.cells) return 0;
    const c = Math.floor(x / sm.cellSize), r = Math.floor(y / sm.cellSize);
    if (c < 0 || r < 0 || c >= sm.cols || r >= sm.rows) return 0;
    return this.cells[r * sm.cols + c];
  }

  private elev(x: number, y: number) {
    return this.cellAt(x, y) === 2 ? HIGH_Y : 0;
  }

  /** Instanced copies of model `k`: one per matrix, each normalised to a 1×1 footprint, base y=0. */
  private instanced(k: ModelKey, mats: THREE.Matrix4[]): THREE.Object3D {
    const g = new THREE.Group();
    if (mats.length === 0) return g;
    const src = this.gltf.get(k)!.scene;
    src.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(src);
    const size = box.getSize(new THREE.Vector3());
    const norm = new THREE.Matrix4().makeScale(1 / size.x, 1 / size.y, 1 / size.z)
      .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
    src.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Bake the model's own transform into the geometry so each instance matrix is a plain
      // translate·rotateY·scale (instanced normals are only correct for that form).
      const geo = mesh.geometry.clone().applyMatrix4(norm.clone().multiply(mesh.matrixWorld));
      const im = new THREE.InstancedMesh(geo, mesh.material, mats.length);
      mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    });
    return g;
  }

  private buildTerrain(sm: StaticMap, mapW: number, mapH: number) {
    if (this.terrain) this.scene.remove(this.terrain);
    const g = new THREE.Group();
    const cs = sm.cellSize, cols = sm.cols, rows = sm.rows;
    const cells = decodeTerrain(sm) ?? new Uint8Array(cols * rows);
    this.cells = cells;
    this.sm = sm;
    const rand = rng(hashStr(`${sm.mapId}:${sm.mapVersion}`));

    // Ground: painted canvas, 8 px per cell, softened.
    const PX = 8;
    const raw = document.createElement("canvas");
    raw.width = cols * PX;
    raw.height = rows * PX;
    const rc = raw.getContext("2d")!;
    const col = new THREE.Color();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const t = cells[r * cols + c];
      col.set(GROUND[t] ?? GROUND[0]).offsetHSL(0, 0, (rand() - 0.5) * 0.04);
      rc.fillStyle = `#${col.getHexString()}`;
      rc.fillRect(c * PX, r * PX, PX, PX);
    }
    for (let i = 0; i < cols * rows * 2; i++) {
      const x = rand() * raw.width, y = rand() * raw.height;
      const t = cells[Math.floor(y / PX) * cols + Math.floor(x / PX)];
      if (t === 6) continue;
      col.set(GROUND[t] ?? GROUND[0]).offsetHSL(0, 0, rand() < 0.5 ? -0.06 : 0.05);
      rc.fillStyle = `#${col.getHexString()}`;
      rc.fillRect(x, y, 2 + rand() * 3, 2 + rand() * 3);
    }
    const soft = document.createElement("canvas");
    soft.width = raw.width;
    soft.height = raw.height;
    const sc = soft.getContext("2d")!;
    sc.filter = "blur(2px)";
    sc.drawImage(raw, 0, 0);
    const tex = new THREE.CanvasTexture(soft);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const depth = mapH / SIN;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(mapW, depth), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(mapW / 2, 0, depth / 2);
    ground.receiveShadow = true;
    g.add(ground);
    // Skirt beyond the map edge (seen under the HUD strip).
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(mapW + 4000, depth + 4000), new THREE.MeshStandardMaterial({ color: "#3d6b33", roughness: 1 }));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.set(mapW / 2, -0.5, depth / 2);
    g.add(skirt);

    const M = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rot = 0) =>
      new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(sx, sy, sz));
    const lists: Partial<Record<ModelKey, THREE.Matrix4[]>> = {};
    const add = (k: ModelKey, m: THREE.Matrix4) => (lists[k] ??= []).push(m);
    const high: THREE.Matrix4[] = [];
    const water: THREE.Matrix4[] = [];
    const cz = cs / SIN;
    const rocks: ModelKey[] = ["rockA", "rockB", "rockC", "stoneA", "stoneB"];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const t = cells[r * cols + c];
      const x = (c + 0.5) * cs, z = (r + 0.5) * cz;
      const j = () => (rand() - 0.5) * cs * 0.5;
      const spin = rand() * Math.PI * 2;
      if (t === 2) high.push(M(x, HIGH_Y / 2, z, cs, HIGH_Y, cz));
      else if (t === 6) water.push(M(x, 0.6, z, cs, 1.2, cz));
      else if (t === 5) add("cliff", M(x, 0, z, cs, 26 + rand() * 10, cz));
      else if (t === 4) {
        if (rand() < 0.3) continue;
        const s = cs * (1.2 + rand() * 0.7);
        add(rocks[Math.floor(rand() * rocks.length)], M(x + j(), 0, z + j(), s, s * (0.8 + rand() * 0.6), s, spin));
      } else if (t === 3) {
        const s = cs * (1.3 + rand() * 0.5);
        add(rand() < 0.5 ? "bushA" : "bushB", M(x + j(), 0, z + j(), s, s * 0.7, s, spin));
        if (rand() < 0.5) add("tallGrass", M(x + j(), 0, z + j(), cs, cs * 0.6, cs, spin));
      } else if (t === 1) {
        if (rand() < 0.12) add("pebbles", M(x + j(), 0, z + j(), cs * 0.8, cs * 0.25, cs * 0.8, spin));
      } else if (t === 0) {
        const p = rand();
        if (p < 0.035) add("grass", M(x + j(), 0, z + j(), cs * 0.6, cs * 0.4, cs * 0.6, spin));
        else if (p < 0.042) add("flower", M(x + j(), 0, z + j(), cs * 0.35, cs * 0.6, cs * 0.35, spin));
      }
    }
    if (high.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#8cc865", roughness: 0.95 }), high.length);
      high.forEach((m, i) => im.setMatrixAt(i, m));
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    }
    if (water.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: "#4a9be0", roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }), water.length);
      water.forEach((m, i) => im.setMatrixAt(i, m));
      im.receiveShadow = true;
      g.add(im);
    }
    for (const k of Object.keys(lists) as ModelKey[]) g.add(this.instanced(k, lists[k]!));
    this.terrain = g;
    this.scene.add(g);
  }

  // ─── entities ─────────────────────────────────────────────────

  private ring(team: 0 | 1, r: number): THREE.Mesh {
    const m = new THREE.Mesh(this.ringGeo, this.ringMats[team]);
    m.rotation.x = -Math.PI / 2;
    m.scale.set(r, r / SIN, 1); // a circle on screen
    m.position.y = 0.4;
    m.renderOrder = 1;
    return m;
  }

  private makeUnit(e: MatchEntity, team: 0 | 1): Obj {
    const spec = UNITS[e.type];
    const src = this.gltf.get(spec.model)!;
    const body = cloneSkinned(src.scene);
    this.paint(body, team);
    const s = (e.radius * spec.height) / 0.8;
    body.scale.setScalar(s);
    const attach = (bone: string, k: ModelKey | undefined, left: boolean) => {
      if (!k) return;
      const arm = body.getObjectByName(bone);
      if (!arm) return;
      const w = this.gltf.get(k)!.scene.clone(true);
      this.paint(w, team);
      w.position.set(left ? 0.02 : -0.02, -0.11, 0.04);
      arm.add(w);
    };
    attach("arm-right", spec.right, false);
    attach("arm-left", spec.left, true);
    const root = new THREE.Group();
    root.add(body, this.ring(team, e.radius));
    const mixer = new THREE.AnimationMixer(body);
    const actions = new Map(src.animations.map((a) => [a.name, mixer.clipAction(a)]));
    return { root, kind: e.type, team, mixer, actions, yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2, px: e.x, py: e.y, speed: 0, body };
  }

  private makeBuilding(e: MatchEntity, team: 0 | 1): Obj {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const o: Obj = { root, kind: e.buildingType ?? e.type, team, yaw: 0, px: e.x, py: e.y, speed: 0, body };
    const w = e.radius * 2;
    const stack = (k: ModelKey, width: number, y: number, v: Variant = team) => {
      const m = this.place(k, width, v);
      m.position.y = y;
      body.add(m);
      return m;
    };
    if (e.type === "crystal") {
      const base = stack("towerBase", w * 1.5, 0);
      const crown = stack("towerCrystals", w * 1.05, base.userData.height);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(w * 0.26, 0), new THREE.MeshStandardMaterial({
        color: TEAM_HEX[team], emissive: TEAM_HEX[team], emissiveIntensity: 0.55, roughness: 0.25, metalness: 0.2, flatShading: true,
      }));
      gem.scale.y = 1.7;
      gem.position.y = base.userData.height + crown.userData.height + w * 0.55;
      gem.castShadow = true;
      body.add(gem);
      const glow = new THREE.PointLight(TEAM_HEX[team], 6000, w * 5, 2);
      glow.position.y = gem.position.y;
      body.add(glow);
      o.gem = gem;
    } else if (e.buildingType === "barracks") {
      const p = stack("platform", w * 1.25, 0, null);
      stack("tent", w * 1.0, p.userData.height * 0.75);
      const f = stack("flag", w * 0.45, p.userData.height * 0.75);
      f.position.set(w * 0.5, f.position.y, w * 0.45);
    } else if (e.buildingType === "foundry") {
      const p = stack("platform", w * 1.2, 0, null);
      const fr = stack("frame", w * 0.9, p.userData.height * 0.75, null);
      stack("roof", w * 1.05, p.userData.height * 0.75 + fr.userData.height * 0.92);
      const ch = stack("chimney", w * 0.22, p.userData.height * 0.75, null);
      ch.scale.y = 1.5;
      ch.position.set(-w * 0.32, ch.position.y, -w * 0.3);
      const f = stack("flag", w * 0.4, p.userData.height * 0.75);
      f.position.set(w * 0.5, f.position.y, w * 0.45);
    } else if (e.buildingType === "supply_depot") {
      stack("stall", w * 0.9, 0, team === 0 ? "r0" : "r1").position.x = -w * 0.15;
      const c = stack("cart", w * 0.55, 0, null);
      c.position.set(w * 0.42, 0, w * 0.2);
      c.rotation.y = 0.6;
      const f = stack("flag", w * 0.45, 0);
      f.position.set(-w * 0.55, 0, w * 0.4);
    } else if (e.buildingType === "turret") {
      const b = stack("towerBottom", w * 1.25, 0);
      const gun = stack("turretGun", w * 0.75, b.userData.height);
      o.gun = gun;
    }
    root.add(this.ring(team, e.radius * (e.type === "crystal" ? 1.25 : 1.05)));
    return o;
  }

  private playAnim(o: Obj, name: string) {
    if (o.anim === name || !o.actions) return;
    const next = o.actions.get(name);
    if (!next) return;
    const prev = o.anim ? o.actions.get(o.anim) : undefined;
    next.reset();
    if (name === "die") {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    }
    next.play();
    if (prev) prev.crossFadeTo(next, 0.15, false);
    o.anim = name;
  }

  private animFor(o: Obj, e: MatchEntity): string {
    if (e.actionState === "dying" || e.health <= 0) return "die";
    if (o.speed > 6) return o.kind === "skirmisher" ? "sprint" : "walk";
    const armed = !!UNITS[o.kind]?.right;
    switch (e.actionState) {
      case "attacking":
        return o.kind === "gunner" ? "holding-right-shoot" : o.kind === "medic" ? "interact-right" : "attack-melee-right";
      case "gathering":
      case "constructing":
        return "interact-right";
      default:
        return armed ? "holding-right" : "idle";
    }
  }

  // ─── per frame ────────────────────────────────────────────────

  frame(
    view: View3D,
    entities: MatchEntity[],
    resourceNodes: ResourceNodeDisplay[],
    sm: StaticMap | undefined,
    mapW: number,
    mapH: number,
    teamOf: (ownerId: string) => 0 | 1,
  ) {
    if (!this.ready) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    if (sm) {
      const key = `${sm.mapId}:${sm.mapVersion}:${sm.cols}x${sm.rows}:${sm.terrain?.length ?? 0}`;
      if (key !== this.terrainKey) {
        this.terrainKey = key;
        this.buildTerrain(sm, mapW, mapH);
      }
    }

    // Resource nodes (neutral gold crystals, shrinking as they deplete).
    const seenNodes = new Set<string>();
    for (const n of resourceNodes) {
      seenNodes.add(n.id);
      let m = this.nodes.get(n.id);
      if (!m) {
        m = this.place("nodeCrystal", n.radius * 2.4, "gold");
        m.position.set(n.x, this.elev(n.x, n.y), n.y / SIN);
        m.rotation.y = (hashStr(n.id) % 628) / 100;
        this.scene.add(m);
        this.nodes.set(n.id, m);
      }
      const k = 0.45 + 0.55 * Math.max(0, n.remaining / Math.max(1, n.capacity));
      m.scale.setScalar(k);
      m.visible = n.remaining > 0;
    }
    for (const [id, m] of this.nodes) if (!seenNodes.has(id)) { this.scene.remove(m); this.nodes.delete(id); }

    // Units and buildings.
    const seen = new Set<string>();
    for (const e of entities) {
      const isUnit = !!UNITS[e.type];
      if (!isUnit && e.type !== "building" && e.type !== "crystal") continue;
      seen.add(e.id);
      let o = this.objs.get(e.id);
      if (!o) {
        o = isUnit ? this.makeUnit(e, teamOf(e.ownerId)) : this.makeBuilding(e, teamOf(e.ownerId));
        this.objs.set(e.id, o);
        this.scene.add(o.root);
      }
      const dx = e.x - o.px, dy = e.y - o.py;
      const inst = Math.hypot(dx, dy) / Math.max(dt, 1e-3);
      o.speed += (inst - o.speed) * Math.min(1, dt * 8);
      o.px = e.x;
      o.py = e.y;
      o.root.position.set(e.x, this.elev(e.x, e.y), e.y / SIN);
      if (isUnit) {
        let want: number | undefined;
        if (o.speed > 6 && (dx || dy)) want = Math.atan2(dx, dy / SIN);
        else if (e.heading !== undefined) want = Math.atan2(Math.cos(e.heading), Math.sin(e.heading) / SIN);
        if (want !== undefined) {
          const diff = Math.atan2(Math.sin(want - o.yaw), Math.cos(want - o.yaw));
          o.yaw += diff * Math.min(1, dt * 10);
        }
        o.body!.rotation.y = o.yaw;
        this.playAnim(o, this.animFor(o, e));
        o.mixer!.update(dt);
      } else {
        const built = e.type === "building" ? Math.max(0.12, (e.constructionProgress ?? 100) / 100) : 1;
        o.body!.scale.y = built;
        if (o.gun && e.heading !== undefined) {
          const want = Math.atan2(Math.cos(e.heading), Math.sin(e.heading) / SIN);
          const diff = Math.atan2(Math.sin(want - o.yaw), Math.cos(want - o.yaw));
          o.yaw += diff * Math.min(1, dt * 8);
          o.gun.rotation.y = o.yaw;
        }
        if (o.gem) {
          o.gem.rotation.y += dt * 0.8;
          o.gem.position.y += Math.sin(now / 600) * 0.04;
        }
      }
    }
    for (const [id, o] of this.objs) if (!seen.has(id)) { this.scene.remove(o.root); this.objs.delete(id); }

    this.render(view);
  }

  private render(v: View3D) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.size.w !== v.cssW || this.size.h !== v.cssH || this.size.dpr !== dpr) {
      this.size = { w: v.cssW, h: v.cssH, dpr };
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(v.cssW, v.cssH, false);
      this.canvas.style.width = `${v.cssW}px`;
      this.canvas.style.height = `${v.cssH}px`;
    }
    const hw = v.cssW / v.scale / 2, hh = v.cssH / v.scale / 2;
    const cam = this.camera;
    cam.left = -hw;
    cam.right = hw;
    cam.top = hh;
    cam.bottom = -hh;
    cam.updateProjectionMatrix();
    const tx = v.cameraX + hw, tz = (v.cssH / 2 - v.hudTop) / v.scale / SIN;
    cam.position.set(tx, 3000 * SIN, tz + 3000 * COS);
    cam.lookAt(tx, 0, tz);
    // Sun from the upper left, shadow box following the view.
    this.sun.target.position.set(tx, 0, tz);
    this.sun.position.set(tx - 600, 1200, tz - 500);
    const sc = this.sun.shadow.camera;
    const ext = Math.max(hw, hh / SIN) + 200;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 1;
    sc.far = 4000;
    sc.updateProjectionMatrix();
    this.renderer.render(this.scene, cam);
  }
}
