Assessment of Latest Commit
What you got right:

DPR resize handler correct — canvas.width = cssW * dpr, CSS style set, ctx.scale(dpr, dpr) applied. This is solid.
mapWidth expanded to 6000. Correct.
buildingValidation.ts hardcoded 600 replaced with buildZone.y2. Correct.
mapWidth/mapHeight added to shared types and serialised on the server in all four broadcast paths. Correct.
Crystal and building movement blocked in matchEngine.ts (commit b9508e0). Correct.
Click coordinate conversion: worldX = screenX + cameraXRef.current. Correct direction.
Crystal rendered as a building square with "HQ" label. Correct.
cameraXRef used as a ref, matchStateRef for the RAF loop. Correct concept.
renderTick state added to force redraws. Correct concept.
Score: 9 of 16 intended changes correct. Three architectural errors introduced that break everything that was working correctly in concept.

Root Cause of Every Snap-Back Issue
All three remaining problems (minimap snap, edge scroll jitter, wrong render positions when scrolled) share the same two root causes.

BUG 1 — CRITICAL: Camera reset fires every server tick
File: client/src/components/GameShell.tsx, lines 140–161.

useEffect(() => {
  if (!matchState) return;
  // ... sets cameraXRef.current to initial position ...
}, [matchState, player.id]);   // ← matchState is in the deps
matchState is replaced with a new object on every server game-state message, which arrives every 100ms. React sees a new object reference and re-runs this effect 10 times per second. Every time it runs, it writes the initial crystal-centred position back into cameraXRef.current.

The RAF edge-scroll loop writes to cameraXRef.current, the minimap click writes to cameraXRef.current — but within 100ms this effect fires and overwrites both. This is the sole cause of all snap-back behaviour.

Fix: Add a one-shot guard ref. The camera should only be positioned once per match, when matchState first becomes non-null.

const cameraInitializedRef = useRef(false);

// Reset the guard when leaving a match so the next match re-initialises
useEffect(() => {
  if (!matchState) {
    cameraInitializedRef.current = false;
  }
}, [matchState]);

// Initialise camera only once per match
useEffect(() => {
  if (!matchState || cameraInitializedRef.current) return;
  cameraInitializedRef.current = true;
  const canvas = canvasRef.current;
  if (!canvas) return;

  const viewW = canvas.clientWidth;
  const mapWidth = matchState.mapWidth ?? 6000;
  const myCrystal = matchState.entities.find(
    (e) => e.type === "crystal" && e.ownerId === player.id
  );
  if (myCrystal) {
    cameraXRef.current = Math.max(0, Math.min(myCrystal.x - viewW / 2, mapWidth - viewW));
  } else {
    const myIdx = matchState.players.findIndex((p) => p?.playerId === player.id);
    cameraXRef.current = myIdx === 0 ? 0 : Math.max(0, mapWidth - viewW);
  }
  cameraYRef.current = 0;
}, [matchState, player.id]);
BUG 2 — CRITICAL: Double camera offset in the render loop
File: client/src/components/GameShell.tsx, lines 451–560 (inside the render useEffect).

The code does ctx.translate(-cameraX, -cameraY) which shifts the canvas coordinate system so that world position X automatically renders at screen position X - cameraX. Then immediately, all drawing code also manually subtracts cameraX from every coordinate:

ctx.save();
ctx.translate(-cameraX, -cameraY);   // shift #1

// Background - subtracts again (shift #2):
ctx.fillRect(0 - cameraX, laneTop, cssW, ...);
// Screen position = (0 - cameraX) + (-cameraX) = -2*cameraX  ← WRONG

// Entities - subtracts again (shift #2):
const sx = entity.x - cameraX;
// Draws at (entity.x - cameraX) in translated space
// Screen position = (entity.x - cameraX) + (-cameraX) = entity.x - 2*cameraX  ← WRONG
At cameraX = 0 (which Bug 1 keeps it at) this is invisible — entity.x - 0 = entity.x. The moment cameraX becomes non-zero, every world object renders at twice the expected offset. This is why clicking works but things appear at the wrong position after any scroll.

Fix: Choose one approach and use it consistently. The idiomatic approach is to use world coordinates everywhere inside the translate block and let the transform do the work:

ctx.save();
ctx.translate(-cameraX, 0);   // one shift, applied once

// Lane background — draw in world coords, full map width:
ctx.fillStyle = "#111122";
ctx.fillRect(0, laneTop, mapWidth, laneBottom - laneTop);

// Combat zone — world coords:
ctx.fillStyle = "#151530";
ctx.fillRect(combatLeft, combatZoneTop, combatRight - combatLeft, combatZoneBottom - combatZoneTop);

// Blue build zone — world coords:
ctx.fillStyle = "rgba(68, 136, 255, 0.05)";
ctx.fillRect(0, 0, mapWidth * 0.3, mapHeight);

// Red build zone — world coords:
ctx.fillStyle = "rgba(255, 68, 68, 0.05)";
ctx.fillRect(mapWidth * 0.7, 0, mapWidth * 0.3, mapHeight);

// Lane lines — world coords:
ctx.moveTo(0, laneTop);
ctx.lineTo(mapWidth, laneTop);

// Center dashed line — already correct in world coords (midX, laneTop):
ctx.moveTo(midX, laneTop);
ctx.lineTo(midX, laneBottom);

// Resource nodes — draw at node.x, node.y (no subtraction):
ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);

// Entities — draw at entity.x, entity.y (no subtraction):
const bx = entity.x - w / 2;
const by = entity.y - h / 2;
ctx.fillRect(bx, by, w, h);
// etc.

// Hover line and build preview — hoverPos is already in world coords:
ctx.moveTo(entity.x, entity.y);
ctx.lineTo(hoverPos.x, hoverPos.y);

ctx.restore();   // removes translate; minimap and HUD draw in screen space after this
Remove every instance of - cameraX and - cameraY from coordinates within the translate block. The viewport culling checks (the if (sx < -hitRadius ... continue) guards) must also use world coords with the camera range: replace sx < -hitRadius*2 || sx > cssW + hitRadius*2 with entity.x < cameraX - hitRadius*2 || entity.x > cameraX + cssW + hitRadius*2.

BUG 3 — MEDIUM: React handleMouseMove silently kills the RAF edge scroll
File: client/src/components/GameShell.tsx, lines 383–391.

if (screenX < EDGE_SCROLL_THRESHOLD) {
  mousePosRef.current = { x: screenX, y: screenY };
} else if (screenX > canvas.clientWidth - EDGE_SCROLL_THRESHOLD) {
  mousePosRef.current = { x: screenX, y: screenY };
} else {
  mousePosRef.current = null;   // ← overwrites the RAF listener's value
}
The RAF edge-scroll loop has its own native canvas.addEventListener("mousemove", onMouseMove) which sets mousePosRef.current to the full mouse position on every move. Native listeners fire before React synthetic events. So the sequence each mouse-move is:

Native RAF listener sets mousePosRef.current = { x: screenX, y: screenY } ✓
React synthetic handleMouseMove fires — if mouse is in the center, sets mousePosRef.current = null ✗
RAF next frame: reads null, skips scrolling
The RAF loop already contains its own edge detection (if (pos.x < EDGE_SCROLL_THRESHOLD)), so the React handler's nulling is redundant and destructive.

Fix: Remove the conditional and always set the ref. Remove the else { mousePosRef.current = null; } branch entirely:

const handleMouseMove = useCallback(
  (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    mousePosRef.current = { x: screenX, y: screenY };   // always update

    setHoverPos({
      x: screenX + cameraXRef.current,
      y: screenY,
    });
  },
  []
);
The RAF loop's own listener is now redundant (React handler covers it) and can also be removed to avoid double-firing, but it is harmless to leave.

BUG 4 — MINOR: RAF loop leak — cancelAnimationFrame cancels the first frame, not the ongoing loop
File: client/src/components/GameShell.tsx, lines 218–222.

const animFrame = requestAnimationFrame(loop);   // ID of frame 0

return () => {
  cancelAnimationFrame(animFrame);   // cancels frame 0, which already ran
  // loop continues forever on frame 1, 2, 3...
};
This doesn't cause the visual snap-back but it means the loop runs indefinitely after the component unmounts, causing unnecessary setRenderTick calls.

Fix: Use a running flag:

let running = true;
const loop = () => {
  if (!running) return;
  const pos = mousePosRef.current;
  if (pos) {
    const viewW = canvas.clientWidth;
    let dx = 0;
    if (pos.x < EDGE_SCROLL_THRESHOLD) dx = -EDGE_SCROLL_SPEED;
    else if (pos.x > viewW - EDGE_SCROLL_THRESHOLD) dx = EDGE_SCROLL_SPEED;
    if (dx !== 0) {
      const mapWidth = matchStateRef.current?.mapWidth ?? 6000;
      cameraXRef.current = Math.max(0, Math.min(mapWidth - viewW, cameraXRef.current + dx));
      setRenderTick((t) => t + 1);
    }
  }
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

return () => {
  running = false;
  canvas.removeEventListener("mousemove", onMouseMove);
};
Note on red crystal position
The user's observation that "red crystal is at the right edge of initial camera bounds, not the right edge of the MAP" is actually correct and expected behaviour. The crystal is 120px from the right map edge (x = mapWidth - 120 = 5880). The red player's camera initialises to cameraX = mapWidth - viewW = 4080, placing the crystal at screen position 5880 - 4080 = 1800px on a 1920px screen. This is 120px from the screen's right edge — exactly mirroring the blue crystal being 120px from the screen's left edge. This is symmetric and correct. Do not change this. The user may be confused because they expect the crystal to be touching the absolute right pixel of the world, but 120px of breathing room is intentional.

Fix priority order for the local model
Apply in this order. Each is independent of the others except fix 2 depends on understanding fix 1 first.

GameShell.tsx — camera init guard (fixes all snap-back): add cameraInitializedRef, split the reset useEffect and the init useEffect, add the if (cameraInitializedRef.current) return guard.
GameShell.tsx — render loop: remove all manual - cameraX subtractions inside the ctx.translate block. Draw everything in world coords. Update the culling guards from sx < comparisons to entity.x < cameraX - margin comparisons.
GameShell.tsx — handleMouseMove: remove the else { mousePosRef.current = null } branch. Always set mousePosRef.current.
GameShell.tsx — RAF loop: replace cancelAnimationFrame(animFrame) cleanup with a running = false flag.
Fixing bugs 1 through 3 will make minimap, edge scroll, and rendering all work correctly together. Bug 4 is a cleanup improvement only.
