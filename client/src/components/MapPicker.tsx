import { useEffect, useRef, useState } from "react";
import { decodeTerrain } from "../terrainCodec";
import { themeFor } from "../mapThemes";

/** One entry of GET /api/maps. */
export interface MapInfo {
  mapId: string;
  name: string;
  version: number;
  /** Sign-off date, or null for a candidate (pool) / dev map. */
  approved: string | null;
  pool: boolean;
  cols: number;
  rows: number;
  width: number;
  height: number;
  terrain: string;
  nodes: Array<{ x: number; y: number }> | null;
}

let mapsCache: Promise<MapInfo[]> | null = null;
export function fetchMaps(): Promise<MapInfo[]> {
  mapsCache ??= fetch("/api/maps").then((r) => r.json()).catch(() => { mapsCache = null; return []; });
  return mapsCache;
}

/** Map thumbnail: terrain, contested nodes (gold) and the two crystals. */
export function MapThumb({ map, width = 250 }: { map: MapInfo; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const height = Math.round((width * map.height) / map.width);
  useEffect(() => {
    const c = ref.current?.getContext("2d");
    if (!c) return;
    const sx = width / map.cols, sy = height / map.rows;
    const theme = themeFor(map.mapId);
    c.fillStyle = theme.thumbBg;
    c.fillRect(0, 0, width, height);
    const cells = decodeTerrain(map);
    if (cells) {
      for (let r = 0; r < map.rows; r++) for (let col = 0; col < map.cols; col++) {
        const color = theme.terrain2d[cells[r * map.cols + col]];
        if (!color) continue;
        c.fillStyle = color;
        c.fillRect(Math.floor(col * sx), Math.floor(r * sy), Math.ceil(sx), Math.ceil(sy));
      }
    }
    const px = width / map.width;
    c.fillStyle = "#e8c547";
    for (const n of map.nodes ?? []) { c.beginPath(); c.arc(n.x * px, n.y * px, 2.5, 0, Math.PI * 2); c.fill(); }
    for (const [x, color] of [[100, "#4488ff"], [map.width - 100, "#ff4444"]] as const) {
      c.fillStyle = color;
      c.beginPath(); c.arc(x * px, (map.height / 2) * px, 3.5, 0, Math.PI * 2); c.fill();
    }
  }, [map, width, height]);
  return <canvas ref={ref} width={width} height={height} style={{ display: "block", width, height }} />;
}

/** Map choice as cards (G-12): "Random" plus the pool maps; `dev` also lists the dev maps (Solo test). */
export function MapCards({ value, onChange, disabled, columns = 2, dev = false }: { value: string; onChange: (mapId: string) => void; disabled?: boolean; columns?: number; dev?: boolean }) {
  const [maps, setMaps] = useState<MapInfo[]>([]);
  useEffect(() => { void fetchMaps().then(setMaps); }, []);
  const W = 196;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 8 }}>
      <button type="button" className={`g-card${value === "random" ? " on" : ""}`} disabled={disabled} onClick={() => onChange("random")}>
        <div style={{ height: Math.round(W * 0.18), display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.06)", fontFamily: "var(--display)", fontSize: 18, color: "var(--ink-dim)" }}>?</div>
        <span className="g-card-name">Random</span>
        <span className="g-card-meta">Any pool map</span>
      </button>
      {maps.filter((m) => dev || m.pool).map((m) => (
        <button key={m.mapId} type="button" className={`g-card${value === m.mapId ? " on" : ""}`} disabled={disabled} onClick={() => onChange(m.mapId)}>
          <div style={{ width: "100%", overflow: "hidden" }}><MapThumb map={m} width={W} /></div>
          <span className="g-card-name">{m.name}</span>
          <span className="g-card-meta">{themeFor(m.mapId).name}{m.pool && !m.approved ? " · candidate" : ""}</span>
        </button>
      ))}
    </div>
  );
}
