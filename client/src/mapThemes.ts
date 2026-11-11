/**
 * Cosmetic colour themes per map (2D palette, 3D ground, foliage and light). Gameplay is
 * unaffected. Maps that share a theme share a terrain makeup or a name that suggests it.
 * A map with no entry here (the classic map, dev maps) uses "verdant".
 */
export type ThemeId = "verdant" | "desert" | "haunted" | "frost";

export interface MapTheme {
  id: ThemeId;
  name: string;
  /** 2D view: fill per terrain code 1–6 (open ground is the lane colour). */
  terrain2d: Record<number, string>;
  lane2d: string;
  combat2d: string;
  thumbBg: string;
  /** 3D ground colour per terrain code 0–6 (open, rough, high, brush, rock, cliff, water). */
  ground: string[];
  highTop: string;
  water: string;
  skirt: string;
  background: string;
  sky: string;
  earth: string;
  sun: string;
  sunIntensity: number;
  /** HSL hue (degrees), saturation and lightness multipliers for nature-kit foliage. */
  foliage: { h: number; s: number; l: number };
  /** Tint mixed into nature-kit rocks and cliffs (0 = untouched). */
  rock: { color: string; mix: number };
  /** Open-ground decorations: grass tufts and flowers, or pebbles only. */
  decor: "lush" | "sparse";
}

export const THEMES: Record<ThemeId, MapTheme> = {
  verdant: {
    id: "verdant", name: "Verdant",
    terrain2d: { 1: "#3a2e1a", 2: "#1f3326", 3: "#1f5a2e", 4: "#55566a", 5: "#7a6244", 6: "#1d4f8a" },
    lane2d: "#0a0c14", combat2d: "#0d1020", thumbBg: "#16241b",
    ground: ["#6cae4e", "#a08052", "#86c25e", "#4f9a3c", "#8f8a80", "#8a7458", "#3d86c9"],
    highTop: "#8cc865", water: "#4a9be0", skirt: "#3d6b33", background: "#141a14",
    sky: "#e4efff", earth: "#4a4030", sun: "#fff1d6", sunIntensity: 2.4,
    foliage: { h: 100, s: 0.75, l: 0.8 }, rock: { color: "#8f8a80", mix: 0 }, decor: "lush",
  },
  desert: {
    id: "desert", name: "Desert",
    terrain2d: { 1: "#4a3216", 2: "#4a3a1e", 3: "#3e4a1c", 4: "#6a5440", 5: "#8a5a32", 6: "#1d5a7a" },
    lane2d: "#140f08", combat2d: "#1c140a", thumbBg: "#2a1e10",
    ground: ["#d9a55c", "#b9824a", "#e6b86c", "#9c9a4a", "#b08a66", "#a86c42", "#3fa0b8"],
    highTop: "#ecc078", water: "#4cb4c8", skirt: "#a8783e", background: "#2a1c10",
    sky: "#fff0d8", earth: "#7a5030", sun: "#ffe2b0", sunIntensity: 2.7,
    foliage: { h: 62, s: 0.55, l: 0.85 }, rock: { color: "#c08850", mix: 0.45 }, decor: "sparse",
  },
  haunted: {
    id: "haunted", name: "Haunted",
    terrain2d: { 1: "#2e1e34", 2: "#2a1e3a", 3: "#2a1a44", 4: "#4a4460", 5: "#5a3e5e", 6: "#2a2a7a" },
    lane2d: "#0e0814", combat2d: "#150c20", thumbBg: "#1e1428",
    ground: ["#6a5a86", "#6e5470", "#7e6c9c", "#4e3c72", "#6c6880", "#5e4a66", "#4a58c0"],
    highTop: "#8a78aa", water: "#5a62d8", skirt: "#3a2e4e", background: "#0e0a16",
    sky: "#b8b0ff", earth: "#2a2038", sun: "#d8ccff", sunIntensity: 1.9,
    foliage: { h: 275, s: 0.7, l: 0.75 }, rock: { color: "#6a6488", mix: 0.4 }, decor: "lush",
  },
  frost: {
    id: "frost", name: "Frost",
    terrain2d: { 1: "#26323e", 2: "#1e3040", 3: "#1a3a3e", 4: "#55606e", 5: "#5a6a7a", 6: "#1a3a6a" },
    lane2d: "#080c12", combat2d: "#0c1220", thumbBg: "#18222c",
    ground: ["#d6e2ec", "#a8b4c0", "#eef4fa", "#7aa4a4", "#9aa4b0", "#8a96a8", "#4a8ac8"],
    highTop: "#f4f8fc", water: "#6aaee8", skirt: "#a4b4c4", background: "#101820",
    sky: "#e8f4ff", earth: "#607080", sun: "#f0f6ff", sunIntensity: 2.2,
    foliage: { h: 200, s: 0.35, l: 1.9 }, rock: { color: "#a0acbc", mix: 0.6 }, decor: "sparse",
  },
};

/** Theme per map id (see the comment at the top). */
const MAP_THEME: Record<string, ThemeId> = {
  // green: plateaus and fens
  "ironreed": "verdant",
  "twin-spires": "verdant",
  "glimmerfen": "verdant",
  // desert: the three maps with no water
  "basalt-run": "desert",
  "saltmarsh": "desert",
  "cinder-flats": "desert",
  // haunted: dusk lowlands
  "duskvale": "haunted",
  "hollow-crown": "haunted",
  // frost: crystal ridges
  "shardfall": "frost",
  "prism-ridge": "frost",
};

export function themeFor(mapId: string | undefined): MapTheme {
  return THEMES[(mapId && MAP_THEME[mapId]) || "verdant"];
}
