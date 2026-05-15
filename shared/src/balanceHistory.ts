/**
 * Balance snapshots for each game version.
 *
 * When replaying a saved match, the engine uses the snapshot for that
 * replay's version instead of the current live values.  This ensures
 * old replays remain accurate even after balance patches.
 *
 * Add a new entry here whenever a balance-affecting value changes.
 * Keys must match the version strings in package.json / replay files.
 */

export interface BalanceSnapshot {
  workerCost: number;
  workerSpeed: number;          // pixels per sub-step
  skirmisherSpeed: number;
  skirmisherDamage: number;
  passiveWinThreshold: number;  // held resources needed to win
}

export const BALANCE_HISTORY: Readonly<Record<string, BalanceSnapshot>> = {
  // ── 0.1.43-ML ──────────────────────────────────────────────────────────
  // Initial ML branch balance.  Workers cheap/fast; skirmisher hits harder;
  // passive win threshold lower.
  "0.1.43-ML": {
    workerCost:             25,
    workerSpeed:             2.0,
    skirmisherSpeed:         2.5,
    skirmisherDamage:       15,
    passiveWinThreshold:  2500,
  },

  // ── 0.1.44-ML ──────────────────────────────────────────────────────────
  // Worker cost doubled to discourage idle-spam strategy.
  // Workers 15% slower, skirmishers 20% faster / 20% less damage (raiders).
  // Passive win threshold raised.
  "0.1.44-ML": {
    workerCost:             50,
    workerSpeed:             1.7,
    skirmisherSpeed:         3.0,
    skirmisherDamage:       12,
    passiveWinThreshold:  3000,
  },
} as const;

/** Look up the balance snapshot for a given version string, or undefined if not registered. */
export function getBalanceForVersion(version: string): BalanceSnapshot | undefined {
  return BALANCE_HISTORY[version];
}
