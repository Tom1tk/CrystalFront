Let me read the current codebase to understand what's been implemented and what's broken.

Now I have everything I need. The code is entirely Stage 4 — no camera, no minimap, no wider map. Let me produce the diagnostic report.

---

## CrystalFront Stage 4.5 — Bug Diagnosis for Local Model

The codebase on the repo is still the Stage 4 implementation. No camera, no minimap, no wider map are present in the committed code. Based on the symptoms you describe, here are the root causes and precise fixes, in the order the local model should apply them.

---

### BUG 1 — Canvas is blurry and clicks don't hit entities: Device Pixel Ratio (DPR) not handled

**Root cause:** The resize handler sets `canvas.width = parent.clientWidth` (CSS pixels). On any high-DPI display (devicePixelRatio > 1), the browser stretches this low-resolution canvas to fill the physical screen. Every pixel becomes blurry and the canvas resolution is effectively half or quarter what it should be.

The current click handler also computes `scaleX = canvas.width / rect.width`, which is used to convert screen coordinates to "world" coordinates. This was valid in Stage 4 when canvas pixels and CSS pixels were the same thing, but it breaks once DPR is accounted for or a camera offset is added.

**Fix — in the resize `useEffect` in `GameShell.tsx`:**

```typescript
const dprRef = useRef(window.devicePixelRatio || 1);

// In the resize handler:
const resize = () => {
  const parent = canvas.parentElement;
  if (!parent) return;
  const dpr = window.devicePixelRatio || 1;
  dprRef.current = dpr;
  const cssW = parent.clientWidth;
  const cssH = parent.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
};
```

**Fix — at the start of the render `useEffect`:**

```typescript
const dpr = dprRef.current;
ctx.save();
ctx.scale(dpr, dpr);
// ... all drawing code at logical CSS-pixel coordinates ...
ctx.restore();
```

After this change, all drawing coordinates are in logical CSS pixels. The canvas is native resolution — one canvas pixel = one physical screen pixel. No blurriness.

---

### BUG 2 — Map is too narrow and red crystal appears in the wrong position

**Root cause:** `DEFAULT_CONFIG.mapWidth = 1200` in `server/src/match/types.ts`. The viewport on most screens is around 1920px wide, so a 1200-wide world is narrower than the screen. The red crystal at `x = mapWidth - 120 = 1080` appears left of center on the canvas, not at the far right.

The Prompt 4.5 target is approximately 5 viewport widths. A safe starting value is 6000.

**Fix — in `server/src/match/types.ts`:**

```typescript
export const DEFAULT_CONFIG: MatchConfig = {
  // ...
  mapWidth: 6000,  // tunable between 4000–10000
  mapHeight: 600,
  // ...
};
```

The crystal, worker, and node positions in `map.ts` are already expressed relative to `mapWidth` (e.g., `x: mapWidth - 120`), so they reposition automatically. No changes needed in `map.ts`.

**Also fix the hardcoded `600` in `buildingValidation.ts` line 39:**

```typescript
// BEFORE (broken — will reject valid placements when mapHeight changes):
by2 > 600

// AFTER:
by2 > buildZone.y2
```

The `buildZone` already has a `y2` field set to `mapHeight` in `map.ts`. Use it.

---

### BUG 3 — No camera system: entities are drawn at raw world coordinates

**Root cause:** The render loop draws at `entity.x, entity.y` with no camera offset. With a 6000-wide world, everything beyond `viewportWidth` pixels from x=0 is invisible. The canvas has no concept of a scrollable viewport.

**Fix — add a `cameraXRef` ref (NOT useState) and apply it in the render loop:**

```typescript
const cameraXRef = useRef(0);
```

In the render `useEffect`, after `ctx.scale(dpr, dpr)`, apply the camera before drawing world objects, then restore before drawing HUD elements:

```typescript
const cameraX = cameraXRef.current;
const viewW = canvas.clientWidth;  // logical CSS pixels
const viewH = canvas.clientHeight;

// --- World-space drawing (camera transform applied) ---
ctx.save();
ctx.translate(-cameraX, 0);

// Draw lane background, build zones, resource nodes, entities here
// Use entity.x, entity.y directly — the translate handles offset

ctx.restore();

// --- Screen-space drawing (no camera offset) ---
// Draw HUD: tick counter, match phase bar, minimap
```

**Camera clamping — add this helper wherever camera X is changed:**

```typescript
const clampCamera = (x: number, mapWidth: number, viewW: number) =>
  Math.max(0, Math.min(mapWidth - viewW, x));
```

**Initial camera position** — the camera should start near the player's own crystal:

When the match starts and `matchState` first arrives, set initial camera:
```typescript
// Find the player's crystal from matchState.entities
// Blue player: cameraX starts at ~0 (crystal is at x=120)
// Red player: cameraX starts at mapWidth - viewW (crystal is far right)
const myCrystal = matchState.entities.find(e => e.type === "crystal" && e.ownerId === player.id);
if (myCrystal) {
  const viewW = canvasRef.current?.clientWidth ?? 1200;
  const mapWidth = matchState.config?.mapWidth ?? 6000; // add mapWidth to MatchConfig type if missing
  cameraXRef.current = clampCamera(myCrystal.x - viewW / 2, mapWidth, viewW);
}
```

Do this in a `useEffect` that triggers when `matchState` changes from null to non-null.

---

### BUG 4 — Edge scrolling absent or broken via stale closure

**Root cause:** If the local model implemented edge scrolling using `setInterval` or `useEffect` that reads from a `cameraX` useState, the interval captures the initial `cameraX = 0` value and never sees updates — the classic React stale closure problem. The camera always reads as 0 from inside the interval.

**Correct pattern — use `requestAnimationFrame` and refs only, never React state inside the loop:**

```typescript
const mousePosRef = useRef<{ x: number; y: number } | null>(null);
const animFrameRef = useRef(0);
const [renderTick, setRenderTick] = useState(0); // used only to trigger re-draws

const EDGE_THRESHOLD = 60;  // px from edge to start scrolling
const EDGE_SCROLL_SPEED = 8; // px per frame at 60fps

useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;

  const onMouseMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const loop = () => {
    const pos = mousePosRef.current;
    if (pos && matchState) {
      const viewW = canvas.clientWidth;
      const mapWidth = matchState.config?.mapWidth ?? 6000;
      let dx = 0;
      if (pos.x < EDGE_THRESHOLD) dx = -EDGE_SCROLL_SPEED;
      else if (pos.x > viewW - EDGE_THRESHOLD) dx = EDGE_SCROLL_SPEED;
      if (dx !== 0) {
        cameraXRef.current = clampCamera(cameraXRef.current + dx, mapWidth, viewW);
        setRenderTick(t => t + 1); // trigger canvas re-draw
      }
    }
    animFrameRef.current = requestAnimationFrame(loop);
  };

  canvas.addEventListener("mousemove", onMouseMove);
  animFrameRef.current = requestAnimationFrame(loop);

  return () => {
    canvas.removeEventListener("mousemove", onMouseMove);
    cancelAnimationFrame(animFrameRef.current);
  };
}, [matchState]); // re-run when matchState arrives so mapWidth is available
```

The render `useEffect` must include `renderTick` in its dependency array so it redraws when the camera moves:
```typescript
useEffect(() => {
  // all canvas drawing
}, [matchState, player.id, selectedEntityId, hoverPos, resourceNodes, buildMode, selectedBuildingType, myCrystal, renderTick]);
```

---

### BUG 5 — Minimap snaps back: camera state is split between ref and React state

**Root cause:** If `cameraX` exists as both a `useRef` and a `useState`, or if the minimap click sets the state while the edge-scroll loop sets the ref, they contradict each other. On the next frame the edge-scroll loop overwrites the minimap's chosen position back to whatever the ref holds.

**Fix:** Use ONE source of truth — the ref. Delete any `cameraX` useState entirely. Only `cameraXRef` exists. The minimap click writes to the ref and then calls `setRenderTick(t => t + 1)` to force a redraw:

```typescript
const handleMinimapClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
  const canvas = canvasRef.current;
  if (!canvas || !matchState) return;
  const rect = canvas.getBoundingClientRect();
  const mapWidth = matchState.config?.mapWidth ?? 6000;
  const viewW = canvas.clientWidth;

  // minimap occupies, e.g., the bottom-right 200x40px of the screen
  const minimapLeft = viewW - 210; // wherever the minimap is rendered
  const minimapWidth = 200;
  const clickX = e.clientX - rect.left;
  const fraction = (clickX - minimapLeft) / minimapWidth;
  cameraXRef.current = clampCamera(fraction * mapWidth, mapWidth, viewW);
  setRenderTick(t => t + 1);
};
```

The minimap itself should be drawn in the screen-space section (after `ctx.restore()` removes the camera transform). The viewport rectangle shown on the minimap:
```typescript
const minimapScale = minimapWidth / mapWidth;
// Viewport rect on minimap:
const vpLeft = minimapLeft + cameraX * minimapScale;
const vpWidth = viewW * minimapScale;
ctx.strokeStyle = "#ffffff";
ctx.strokeRect(vpLeft, minimapTop, vpWidth, minimapHeight);
```

---

### BUG 6 — Click coordinates don't hit entities after camera is added

**Root cause:** The current `handleClick` uses:
```typescript
const scaleX = canvas.width / rect.width;
const worldX = x * scaleX;
```

After adding DPR support, `canvas.width = cssW * dpr` and `rect.width = cssW`, so `scaleX = dpr`. This multiplies the click by DPR, producing coordinates that are 2× too large on a Retina display. And it doesn't account for the camera offset at all.

**Fix — replace the coordinate conversion in `handleClick` and `handleMouseMove`:**

```typescript
// REMOVE:
const scaleX = canvas.width / rect.width;
const scaleY = canvas.height / rect.height;
const worldX = x * scaleX;
const worldY = y * scaleY;

// REPLACE WITH:
const cssX = e.clientX - rect.left;
const cssY = e.clientY - rect.top;
const worldX = cssX + cameraXRef.current;
const worldY = cssY;
```

The camera translate in the render loop places entity.x at screen position `entity.x - cameraX`. The reverse is: `worldX = screenX + cameraX`. This is the only conversion needed.

For `handleMouseMove` (used for the move-command hover line), same change:
```typescript
setHoverPos({
  x: (e.clientX - rect.left) + cameraXRef.current,
  y: e.clientY - rect.top,
});
```

**Important:** Minimap clicks are in screen space — do NOT add cameraX to them. The minimap handler should be a separate function (`handleMinimapClick`) that detects whether the click is inside the minimap rect before falling through to the world-space click handler.

---

### BUG 7 — Crystal drawn as a circle unit ("C"), not as a static building

**Root cause:** In the render loop, entities with `type === "crystal"` fall into the generic circle-drawing branch because the `if (isBuilding)` check only tests `entity.type === "building"`. The Crystal renders as a dot with a "C" label.

**Fix in the entity render section of `GameShell.tsx`:**

```typescript
// BEFORE:
const isBuilding = entity.type === "building";

// AFTER:
const isBuilding = entity.type === "building" || entity.type === "crystal";
```

Give the Crystal a distinctive appearance by checking `entity.type === "crystal"` inside the building branch and using a larger size and "CRYSTAL" label:
```typescript
const label = entity.type === "crystal"
  ? "HQ"
  : entity.buildingType ? BUILDING_LABELS[entity.buildingType] : "??";
const w = entity.type === "crystal" ? entity.radius * 2 : entity.radius * 2;
```

**On the server — block Crystal movement in `processCommand()`:**

```typescript
if (command.type === "move") {
  if (!entity) return { success: false };
  if (entity.type === "crystal") return { success: false, message: "Crystal cannot move" };
  // ... existing move logic
}
```

---

### BUG 8 — `matchState.config` may be missing from the shared type (mapWidth unavailable on client)

**Root cause:** The client-side `MatchState` type in `shared/src/types.ts` does not include a `config` field. The server serialises the match state but `config` (which contains `mapWidth`) may be stripped. The client has no way to know `mapWidth` for camera clamping or minimap scaling.

**Fix — add `mapWidth` and `mapHeight` to the shared `MatchState` type in `shared/src/types.ts`:**

```typescript
export interface MatchState {
  // ... existing fields ...
  mapWidth: number;
  mapHeight: number;
}
```

**On the server, include these in the serialised state** sent via `game_state` messages. In `server/src/index.ts`, wherever the match is serialised before being broadcast, add:
```typescript
mapWidth: match.config.mapWidth,
mapHeight: match.config.mapHeight,
```

The client can then read `matchState.mapWidth` directly without needing `config`.

---

### Fix order summary

Apply in this sequence to avoid compounding problems:

1. **`server/src/match/types.ts`** — Set `mapWidth: 6000`.
2. **`server/src/match/buildingValidation.ts`** — Replace `by2 > 600` with `by2 > buildZone.y2`.
3. **`shared/src/types.ts`** — Add `mapWidth: number; mapHeight: number` to `MatchState`.
4. **`server/src/index.ts`** — Include `mapWidth` and `mapHeight` in the serialised game state broadcast.
5. **`client/src/components/GameShell.tsx`** — In order:
   a. Add `dprRef`, `cameraXRef`, `mousePosRef`, `animFrameRef`, `renderTick` state.
   b. Fix resize handler to multiply by DPR; set CSS style width/height.
   c. Fix render effect: add `ctx.scale(dpr, dpr)`, `ctx.translate(-cameraX, 0)` around world drawing, then draw minimap after `ctx.restore()`.
   d. Fix click handler: remove `scaleX/scaleY`, use `cssX + cameraXRef.current`.
   e. Add RAF loop for edge scrolling (writes to `cameraXRef`, calls `setRenderTick`).
   f. Add minimap rendering and click handler (writes to `cameraXRef`, calls `setRenderTick`).
   g. Fix Crystal rendering to use the building branch.
   h. Set initial camera position when matchState first arrives.
6. **`server/src/match/matchEngine.ts`** — Block Crystal movement in `processCommand()`.
7. **Rebuild and restart:** `npm run build && npm start` from the repo root.
