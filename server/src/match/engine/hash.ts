import { createHash } from "node:crypto";
import type { MatchState } from "../types.js";

/** Wall-clock metadata — not simulation state, excluded from the hash. */
const EXCLUDED_KEYS = new Set(["startedAt", "endedAt", "stateTimestamp"]);

function canonical(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([k, v]) => [String(k), canonical(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (value instanceof Set) {
    return [...value].map(canonical).map((v) => JSON.stringify(v)).sort();
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (EXCLUDED_KEYS.has(key)) continue;
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || typeof v === "function") continue;
      out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic hash of the full simulation state (G-1 / G-9d).
 * Same seed + same command log ⇒ same hash, however ticks were driven.
 */
export function hashMatchState(match: MatchState): string {
  return createHash("sha256").update(JSON.stringify(canonical(match))).digest("hex");
}
