/**
 * Map pool tool (G-7). Offline only.
 *
 *   npx tsx headless/src/mapPool.ts survey --start 0 --count 12 [--games 12]
 *       Generate candidates for seeds start..start+count-1, validate them and run a
 *       scripted fairness check (rush and macro mirror matches, `games` seeds
 *       each). Prints one line per candidate.
 *
 *   npx tsx headless/src/mapPool.ts freeze <seed>:<Name> [<seed>:<Name> ...] [--games 12]
 *       Freeze candidates into server/src/match/pool/ (one JSON per map), add them to
 *       pool/manifest.json with approved: null (pending the user's sign-off) and
 *       regenerate pool/index.ts. Re-freezing a map id bumps its version.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateMap, type Validation } from "../../server/src/match/mapgen.js";
import type { MapDef } from "../../server/src/match/engine/terrain.js";
import { registerMap } from "../../server/src/match/maps.js";
import { runMatch } from "./runMatch.js";
import { MacroBot, MediumRushBot } from "./bots/index.js";
import { DEFAULT_CONFIG } from "../../server/src/match/types.js";
import type { Agent } from "./types.js";

const POOL_DIR = join(import.meta.dirname, "../../server/src/match/pool");

export interface ManifestEntry {
  mapId: string;
  name: string;
  version: number;
  seed: number;
  symmetry: string;
  generated: string;
  /** Date the user signed the map off, or null while it is a candidate. */
  approved: string | null;
  fairness: { games: number; blueScore: number; timeouts: number };
  metrics: Validation["metrics"];
  notes: string;
}

/**
 * Mirror-match bots for the fairness check. Turtle is left out: turtle mirrors end
 * in the "hold 4500 resources" win, decided by tick parity rather than the map
 * (6/8 blue on the open classic map too). Revisit when U5 replaces that win.
 */
const BOTS: Record<string, () => Agent> = {
  rush: () => new MediumRushBot(),
  macro: () => new MacroBot(),
};

/** Mirror matches on an unregistered map def (the def is registered for the run). */
function fairness(def: MapDef, games: number): ManifestEntry["fairness"] & { perBot: Record<string, number> } {
  registerMap(def); // the engine resolves maps by id
  let score = 0, n = 0, timeouts = 0;
  const perBot: Record<string, number> = {};
  for (const [name, mk] of Object.entries(BOTS)) {
    let s = 0;
    for (let g = 0; g < games; g++) {
      const r = runMatch(mk(), mk(), { seed: 9000 + g, maxTicks: 6000, config: { ...DEFAULT_CONFIG, mapId: def.id } });
      const v = r.winner === "headless-blue" ? 1 : r.winner === "headless-red" ? 0 : 0.5;
      s += v;
      if (r.winType === "timeout" || !r.winner) timeouts++;
    }
    perBot[name] = s / games;
    score += s;
    n += games;
  }
  return { games: n, blueScore: +(score / n).toFixed(3), timeouts, perBot };
}

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
}

const fmt = (v: Validation) =>
  `det ${v.metrics.detourBase.toFixed(2)}/${v.metrics.detourNodeMax.toFixed(2)} dens ${v.metrics.density.approach.toFixed(2)}/${v.metrics.density.middle.toFixed(2)} shelter ${v.metrics.nodeShelterMin.toFixed(2)}`;

function survey(): void {
  const start = arg("start", 0), count = arg("count", 12), games = arg("games", 12);
  for (let seed = start; seed < start + count; seed++) {
    const { def, validation } = generateMap(seed);
    const f = fairness(def, games);
    const ok = Math.abs(f.blueScore - 0.5) <= 0.1;
    console.log(`seed ${seed} ${def.symmetry.padEnd(6)} ${fmt(validation)} | blue ${f.blueScore.toFixed(2)} ${ok ? "FAIR" : "UNFAIR"} (rush ${f.perBot.rush.toFixed(2)} macro ${f.perBot.macro.toFixed(2)}) timeouts ${f.timeouts}/${f.games}`);
  }
}

function freeze(): void {
  const games = arg("games", 12);
  const specs = process.argv.slice(3).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1] === "--games"));
  if (!existsSync(POOL_DIR)) mkdirSync(POOL_DIR, { recursive: true });
  const manifestPath = join(POOL_DIR, "manifest.json");
  const manifest: ManifestEntry[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  for (const spec of specs) {
    const [seedStr, name] = spec.split(":");
    const seed = Number(seedStr);
    const { def, validation } = generateMap(seed);
    const mapId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const prev = manifest.find((m) => m.mapId === mapId);
    const version = prev ? prev.version + 1 : 1;
    const frozen: MapDef = { ...def, id: mapId, name, version };
    const f = fairness(frozen, games);
    if (Math.abs(f.blueScore - 0.5) > 0.1) console.warn(`warning: ${mapId} mirror score ${f.blueScore} is outside 50% ± 10%`);
    writeFileSync(join(POOL_DIR, `${mapId}.json`), JSON.stringify(frozen, null, 1) + "\n");
    const entry: ManifestEntry = {
      mapId, name, version, seed, symmetry: def.symmetry,
      generated: new Date().toISOString().slice(0, 10),
      approved: null,
      fairness: { games: f.games, blueScore: f.blueScore, timeouts: f.timeouts },
      metrics: validation.metrics,
      notes: prev?.notes ?? "",
    };
    if (prev) manifest[manifest.indexOf(prev)] = entry; else manifest.push(entry);
    console.log(`froze ${mapId} v${version} (seed ${seed}) blue ${f.blueScore} timeouts ${f.timeouts}/${f.games}`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const ids = manifest.map((m) => m.mapId);
  const v = (id: string) => "m_" + id.replace(/-/g, "_");
  writeFileSync(join(POOL_DIR, "index.ts"),
    "// Generated by headless/src/mapPool.ts freeze. Do not edit by hand.\n" +
    'import type { MapDef } from "../engine/terrain.js";\n' +
    ids.map((id) => `import ${v(id)} from "./${id}.json" with { type: "json" };\n`).join("") +
    "\nexport const POOL_MAPS = [" + ids.map(v).join(", ") + "] as MapDef[];\n");
}

const cmd = process.argv[2];
if (cmd === "survey") survey();
else if (cmd === "freeze") freeze();
else console.log("usage: mapPool.ts survey|freeze (see the header comment)");
