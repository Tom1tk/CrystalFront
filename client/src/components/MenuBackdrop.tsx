/**
 * Live 3D backdrop for the menus (G-12, UI-2): a real pool map with both bases, rendered
 * by World3D with a slow drifting, gently orbiting camera. With the 2D view selected, or
 * if WebGL fails, a still themed map image is shown instead.
 */
import { useEffect, useRef, useState } from "react";
import type { MatchEntity, ResourceNodeDisplay, StaticMap } from "../types";
import { MapThumb, type MapInfo } from "./MapPicker";
import { themeFor } from "../mapThemes";
import { SAFE_NODE_OFFSETS } from "@crystalfront/shared";

type World = import("../three/World3D").World3D;

function ent(id: string, type: MatchEntity["type"], owner: string, x: number, y: number, heading: number, extra: Partial<MatchEntity> = {}): MatchEntity {
  return {
    id, type, ownerId: owner, x, y, health: 100, maxHealth: 100, radius: type === "crystal" ? 30 : 12, color: "",
    constructionProgress: 100, productionQueue: [], attackCooldown: 0, autoAttackEnabled: true, heading, actionState: "idle", ...extra,
  };
}

/** Both bases at rest: crystal, a barracks, a turret, workers and a small army, mirrored. */
function scene(map: MapInfo): { entities: MatchEntity[]; nodes: ResourceNodeDisplay[] } {
  const W = map.width, H = map.height, mid = H / 2;
  const entities: MatchEntity[] = [];
  const nodes: ResourceNodeDisplay[] = [];
  const army: Array<[MatchEntity["type"], number, number]> = [
    ["bruiser", 420, -40], ["bruiser", 420, 40], ["skirmisher", 470, -90], ["skirmisher", 470, 0], ["skirmisher", 470, 90],
    ["gunner", 380, -110], ["gunner", 380, 110], ["medic", 360, 0],
  ];
  for (const side of [0, 1] as const) {
    const owner = side ? "red" : "blue";
    const X = (dx: number) => (side ? W - dx : dx);
    const face = side ? Math.PI : 0;
    entities.push(ent(`${owner}-crystal`, "crystal", owner, X(100), mid, face));
    entities.push(ent(`${owner}-barracks`, "building", owner, X(330), mid - 230, face, { buildingType: "barracks", radius: 30 }));
    entities.push(ent(`${owner}-turret`, "building", owner, X(560), mid + 170, face, { buildingType: "turret", radius: 18 }));
    SAFE_NODE_OFFSETS.forEach((n, i) => {
      nodes.push({ id: `${owner}-safe-${i}`, x: X(100 + n.dx), y: mid + n.dy, radius: n.radius, color: "", capacity: 100, remaining: 100 });
      if (i < 3) entities.push(ent(`${owner}-w${i}`, "worker", owner, X(100 + n.dx - 34), mid + n.dy + 6, face, { actionState: "gathering" }));
    });
    army.forEach(([t, dx, dy], i) => entities.push(ent(`${owner}-a${i}`, t, owner, X(dx), mid + dy, face)));
  }
  (map.nodes ?? []).forEach((n, i) => nodes.push({ id: `c${i}`, x: n.x, y: n.y, radius: 22, color: "", capacity: 150, remaining: 150 }));
  return { entities, nodes };
}

export default function MenuBackdrop({ map, use3d, onReady }: { map: MapInfo | null; use3d: boolean; onReady?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const mapRef = useRef(map);
  mapRef.current = map;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const [failed, setFailed] = useState(false);
  const live = use3d && !failed;

  // Without 3D, the still image is ready at once.
  useEffect(() => { if (!live && map) readyRef.current?.(); }, [live, map]);

  useEffect(() => {
    if (!live) return;
    let raf = 0, stop = false, reported = false;
    const t0 = performance.now();
    let built: { id: string; sm: StaticMap; scene: ReturnType<typeof scene> } | null = null;
    import("../three/World3D").then(async ({ World3D }) => {
      if (stop) return;
      const w = new World3D();
      worldRef.current = w;
      w.canvas.style.display = "block";
      hostRef.current?.appendChild(w.canvas);
      await w.load();
      const loop = () => {
        if (stop) return;
        raf = requestAnimationFrame(loop);
        const m = mapRef.current;
        if (!m) return;
        if (built?.id !== m.mapId) {
          built = { id: m.mapId, sm: { cellSize: m.width / m.cols, cols: m.cols, rows: m.rows, mapId: m.mapId, mapVersion: m.version, terrain: m.terrain }, scene: scene(m) };
        }
        const cssW = window.innerWidth, cssH = window.innerHeight;
        const scale = cssH / (m.height * 0.82);
        const span = Math.max(0, m.width - cssW / scale);
        const t = (performance.now() - t0) / 1000;
        // Ease back and forth across the whole map (about two minutes each way), with a slow sway.
        const cameraX = span * (0.5 - 0.5 * Math.cos(t * 0.026));
        const orbit = Math.sin(t * 0.11) * 0.07;
        w.frame({ cssW, cssH, cameraX, scale, hudTop: cssH / 2 - (scale * m.height) / 2, orbit }, built.scene.entities, built.scene.nodes, built.sm, m.width, m.height, (o) => (o === "red" ? 1 : 0));
        if (!reported) { reported = true; requestAnimationFrame(() => readyRef.current?.()); }
      };
      loop();
    }).catch(() => setFailed(true));
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      worldRef.current?.dispose();
      worldRef.current = null;
    };
  }, [live]);

  const theme = themeFor(map?.mapId);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, background: theme.background, overflow: "hidden" }} aria-hidden>
      {live ? <div ref={hostRef} style={{ position: "absolute", inset: 0 }} /> : map && (
        <div style={{ position: "absolute", inset: "-4%", display: "flex", alignItems: "center", justifyContent: "center", filter: "blur(6px) saturate(120%)", opacity: 0.8 }}>
          <div style={{ transform: `scale(${Math.max(window.innerWidth / 1200, window.innerHeight / 216) * 1.1})` }}><MapThumb map={map} width={1200} /></div>
        </div>
      )}
      {/* Shade the left side, where the menus sit, so text stays readable over a bright map. */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(4,6,12,0.62) 0%, rgba(4,6,12,0.3) 42%, rgba(4,6,12,0.05) 70%, rgba(4,6,12,0) 100%)" }} />
    </div>
  );
}
