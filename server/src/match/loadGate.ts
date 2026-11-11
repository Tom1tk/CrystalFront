/**
 * Holds a new match in its "spawn" phase until every human client reports that it has
 * finished loading (3D models, terrain), so both players see the first tick together.
 * A client that never reports in releases the match after `timeoutMs`.
 */
export class LoadGate {
  private pending = new Map<string, { waiting: Set<string>; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private onBegin: (matchId: string) => void,
    private timeoutMs = 30_000,
  ) {}

  /** Wait for `playerIds` to load before calling `onBegin(matchId)`. */
  wait(matchId: string, playerIds: string[]): void {
    if (playerIds.length === 0) { this.onBegin(matchId); return; }
    const timer = setTimeout(() => this.release(matchId), this.timeoutMs);
    this.pending.set(matchId, { waiting: new Set(playerIds), timer });
  }

  /** A client finished loading. Starts the match when it was the last one. */
  loaded(matchId: string, playerId: string): void {
    const p = this.pending.get(matchId);
    if (!p) return;
    p.waiting.delete(playerId);
    if (p.waiting.size === 0) this.release(matchId);
  }

  /** Start the match now (all loaded, timeout, or a player left while loading). */
  release(matchId: string): void {
    const p = this.pending.get(matchId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(matchId);
    this.onBegin(matchId);
  }

  isWaiting(matchId: string): boolean {
    return this.pending.has(matchId);
  }
}
