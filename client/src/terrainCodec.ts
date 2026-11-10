/** Terrain run-length codec and palette shared by the game view and map thumbnails (G-5/G-7). */

/** Fill colours per terrain code; open ground (0) is left transparent. */
export const TERRAIN_COLORS: Record<number, string> = {
  1: "#3a2e1a", // rough
  2: "#1f3326", // high ground
  3: "#1f5a2e", // brush
  4: "#55566a", // rock
  5: "#7a6244", // cliff
  6: "#1d4f8a", // water
};

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
