/**
 * Holds a new match in its "spawn" phase until every human client reports that it has
 * finished loading (3D models, terrain), so both players see the first tick together.
 * A client that never reports in releases the match after `timeoutMs`.
 */
export class LoadGate {
  private pending = new Map<string, { waiting: Set<string>; loaded: string[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private onBegin: (matchId: string) => void,
    private timeoutMs = 30_000,
    /** Called each time another player finishes loading, with everyone loaded so far. */
    private onProgress?: (matchId: string, loaded: string[]) => void,
  ) {}

  /** Wait for `playerIds` to load before calling `onBegin(matchId)`. */
  wait(matchId: string, playerIds: string[]): void {
    if (playerIds.length === 0) { this.onBegin(matchId); return; }
    const timer = setTimeout(() => this.release(matchId), this.timeoutMs);
    this.pending.set(matchId, { waiting: new Set(playerIds), loaded: [], timer });
  }

  /** A client finished loading. Starts the match when it was the last one. */
  loaded(matchId: string, playerId: string): void {
    const p = this.pending.get(matchId);
    if (!p || !p.waiting.delete(playerId)) return;
    p.loaded.push(playerId);
    if (p.waiting.size === 0) this.release(matchId);
    else this.onProgress?.(matchId, [...p.loaded]);
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
