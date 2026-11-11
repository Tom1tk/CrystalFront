/** Terrain run-length codec shared by the game view and map thumbnails (G-5/G-7); palettes are in mapThemes.ts. */

export function decodeTerrain(sm: { cols: number; rows: number; terrain?: string }): Uint8Array | null {
  if (!sm.terrain) return null;
  const out = new Uint8Array(sm.cols * sm.rows);
  let i = 0;
  for (const run of sm.terrain.split(",")) {
    const [code, count] = run.split(":").map(Number);
    out.fill(code, i, i + count);
    i += count;
  }
  return out;
}
