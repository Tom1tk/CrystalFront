### Bug 1 (Immediate): Stale Build Artifact

The browser is serving an old `client/dist/` bundle. The `[App] render check` log was removed from `App.tsx` in source but the project was never rebuilt. Run from the project root:

```bash
npm run build
```

Then restart the server (`npm start`). The new Vite bundle will have a different content hash so browsers will fetch fresh code. Also purge Cloudflare's cache for the HTML page after rebuilding, as it may be caching the old HTML that references the old bundle.

---

### Bug 2 (Significant): Workers Ghost-Gather After Being Given Any Other Command

**File:** `server/src/match/matchEngine.ts`

When a `gather` command runs, `targetNode.gathererSlots.add(worker.id)` is called. Workers are **never removed** from a node's `gathererSlots` unless the node fully depletes. This directly violates Stage 3's design: workers gathering "continuously" should mean until reassigned or until depletion — not forever regardless of subsequent orders.

In practice, a worker issued a `move`, `build`, or `repair` command after gathering continues to silently earn resources from the original node every tick. A single worker assigned to gather then moved away will drain the node and generate income indefinitely.

**Fix:** Track each worker's current gathering assignment. Before any command that changes a worker's task (`move`, `build`, `repair`, `gather` to a new node), remove that worker from its current node's `gathererSlots`. The simplest approach is adding a `gatheringNodeId?: string` field to `MatchEntity` so the server can look up and clean up the old slot in O(1):

```typescript
// In gather handler, before adding to new node:
if (worker.gatheringNodeId) {
  const prev = match.resourceNodes.find(n => n.id === worker.gatheringNodeId);
  prev?.gathererSlots.delete(worker.id);
}
worker.gatheringNodeId = targetNode.id;
targetNode.gathererSlots.add(worker.id);

// In move, build, repair handlers, add:
if (worker.gatheringNodeId) {
  const prev = match.resourceNodes.find(n => n.id === worker.gatheringNodeId);
  prev?.gathererSlots.delete(worker.id);
  worker.gatheringNodeId = undefined;
}
```

`gatheringNodeId` is internal server state only — do not include it in the serialized game state broadcast to clients.

---

### Bug 3 (Significant): Game Command Errors Are Silently Dropped During Gameplay

**File:** `client/src/App.tsx`

`ws.error` is passed to `LobbyScreen` but the `GameShell` component receives no `error` prop:

```tsx
{screen === "game" && lobby && player && (
  <GameShell
    lobby={lobby}
    player={player}
    matchState={matchState}
    resourceNodes={ws.resourceNodes}
    onDebugWin={handleDebugWin}
    onGameCommand={handleGameCommand}
    // error is NOT passed here
  />
)}
```

When the server rejects a command — insufficient resources, invalid build placement, "Overlaps existing entity", "Too close to another building", etc. — the error message lands in `ws.error` and is immediately invisible to the player. This is directly in conflict with Stage 4's acceptance criterion: *"Invalid placements are rejected cleanly."* Cleanly implies the player receives feedback.

**Fix:** Pass `error` to `GameShell` and display it. Add `error: string | null` to `GameShell`'s props, and render a small dismissible error banner or toast over the canvas when it is non-null.

---

### Bug 4 (Moderate — Will Actively Break in Stage 4.5): Build Zone Height Hardcoded

**File:** `server/src/match/buildingValidation.ts`

```typescript
if (bx1 < buildZone.x1 || bx2 > buildZone.x2 || by1 < 0 || by2 > 600) {
```

The `600` is hardcoded rather than using `config.mapHeight`. Stage 4.5 will expand the map to roughly 5 viewport widths and explicitly rebalances the map layout. The vertical extent may also change. This hardcoded value will produce incorrect placement validation as soon as the map config changes.

**Fix:** Pass `config.mapHeight` into `validatePlacement` and replace `600` with it:

```typescript
// In validatePlacement signature:
export function validatePlacement(
  x, y, buildingDef, buildZone, laneCorridor, entities, resourceNodes,
  playerColor, crystals, playerId,
  mapHeight: number   // add this
): PlacementResult

// Replace the check:
if (bx1 < buildZone.x1 || bx2 > buildZone.x2 || by1 < 0 || by2 > mapHeight) {
```

Update the callsite in `matchEngine.ts` to pass `config.mapHeight`.

---

### Bug 5 (Minor): Both Player Slots Receive the Same `wsId`

**File:** `server/src/index.ts`, `READY_TOGGLE` handler

```typescript
const players: [PlayerSlot | null, PlayerSlot | null] = [
  toPlayerSlot(result.lobby.players[0]!, session.playerId),
  toPlayerSlot(result.lobby.players[1]!, session.playerId), // same value for both
];
```

`session.playerId` is the player ID of whoever triggered the ready toggle, not a WebSocket ID — and it is passed identically for both slots. `wsId` is unused in the engine currently so there is no visible impact, but Stage 6 (per-player fog state) will likely need to identify which WebSocket belongs to which player slot, at which point this corruption will matter.

**Fix:** Look up each player's session from `playerLobbyMap` to get their correct identifier:

```typescript
const p0 = result.lobby.players[0]!;
const p1 = result.lobby.players[1]!;
const players: [PlayerSlot | null, PlayerSlot | null] = [
  toPlayerSlot(p0, playerLobbyMap.get(p0.id)?.playerId ?? p0.id),
  toPlayerSlot(p1, playerLobbyMap.get(p1.id)?.playerId ?? p1.id),
];
```

---

## Priority Order

1. **Bug 1** — Rebuild the client. No code changes, just a shell command. Unblocks everything else.
2. **Bug 3** — Error feedback. Quick fix, immediately makes all command failures visible so development and testing are no longer flying blind.
3. **Bug 2** — Ghost gathering. Medium complexity fix that corrects the economy before Stage 4.5 work begins.
4. **Bug 4** — Hardcoded height. Small fix that must be done before Stage 4.5 or it will break build placement validation.
5. **Bug 5** — Wrong `wsId`. Low risk now, should be cleaned up before Stage 6.
