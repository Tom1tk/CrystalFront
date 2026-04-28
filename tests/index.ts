import { LobbyManager } from "../server/src/lobby/lobbyManager.js";
import { MatchEngine } from "../server/src/match/matchEngine.js";
import { createMap } from "../server/src/match/map.js";
import { DEFAULT_CONFIG } from "../server/src/match/types.js";
import type { MatchEntity, PlayerSlot, ResourceNode } from "../server/src/match/types.js";
import type { Player, LobbyCode } from "../shared/src/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---- Lobby Creation ----
console.log("\n--- Lobby Creation ---");
{
  const mgr = new LobbyManager();
  const result = mgr.createLobby("PlayerOne");
  assert(result.code.length === 6, "Lobby code is 6 characters");
  assert(result.player.username === "PlayerOne", "Player username is set");
  assert(result.player.color === "blue", "Host player is blue");
  assert(result.player.ready === false, "Host player starts not ready");
  assert(result.player.score === 0, "Host player starts with score 0");

  const lobby = mgr.getLobby(result.code);
  assert(lobby !== undefined, "Lobby exists after creation");
  assert(lobby!.players[0] !== null, "Host slot is filled");
  assert(lobby!.players[1] === null, "Opponent slot is empty");
  assert(lobby!.hostId === result.player.id, "Host ID is set");
  assert(lobby!.status === "waiting", "Lobby status is waiting");

  // Unique codes
  const result2 = mgr.createLobby("PlayerTwo");
  assert(result.code !== result2.code, "Different lobbies have different codes");
}

// ---- Join Lobby ----
console.log("\n--- Join Lobby ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  const joinResult = mgr.joinLobby(host.code, "JoinUser");

  assert(joinResult.success === true, "Join succeeds for valid code");
  assert(joinResult.success && joinResult.player.username === "JoinUser", "Joined player username is correct");
  assert(joinResult.success && joinResult.player.color === "red", "Joining player is red");

  const lobby = mgr.getLobby(host.code);
  assert(lobby!.players[1] !== null, "Opponent slot is filled after join");
  assert(lobby!.players[0]!.username === "HostUser", "Host username preserved");
  assert(lobby!.players[1]!.username === "JoinUser", "Joiner username set");
}

// ---- Reject Invalid Code ----
console.log("\n--- Reject Invalid Code ---");
{
  const mgr = new LobbyManager();
  const result = mgr.joinLobby("XXXXXX", "SomeUser");
  assert(result.success === false, "Join fails for non-existent lobby");
  assert(result.success === false && result.message === "Lobby not found.", "Error message is correct");
}

// ---- Reject Third Player ----
console.log("\n--- Reject Third Player ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");

  const thirdResult = mgr.joinLobby(host.code, "ThirdUser");
  assert(thirdResult.success === false, "Third player is rejected");
  assert(thirdResult.success === false && thirdResult.message === "Lobby is full.", "Error message is 'lobby is full'");
}

// ---- Ready State Transitions ----
console.log("\n--- Ready State Transitions ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");

  const lobby = mgr.getLobby(host.code)!;
  assert(lobby.players[0]!.ready === false, "Host starts not ready");
  assert(lobby.players[1]!.ready === false, "Joiner starts not ready");

  const r1 = mgr.toggleReady(host.code, lobby.players[0]!.id);
  assert(r1.success === true, "Toggle ready succeeds");
  assert(r1.lobby.players[0]!.ready === true, "Host is now ready");
  assert(r1.lobby.status === "waiting", "Lobby still waiting (only 1 ready)");

  const r2 = mgr.toggleReady(host.code, lobby.players[1]!.id);
  assert(r2.success === true, "Second toggle ready succeeds");
  assert(r2.lobby.players[1]!.ready === true, "Joiner is now ready");
  assert(r2.lobby.status === "ready", "Lobby status is ready when both ready");

  // Unready
  const r3 = mgr.toggleReady(host.code, lobby.players[0]!.id);
  assert(r3.lobby.players[0]!.ready === false, "Host unready");
  assert(r3.lobby.status === "waiting", "Lobby back to waiting");
}

// ---- Rematch Score Persistence ----
console.log("\n--- Rematch Score Persistence ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;

  // Record wins
  mgr.recordWin(host.code, "player1");
  mgr.recordWin(host.code, "player2");
  mgr.recordWin(host.code, "player1");

  assertEqual(lobby.players[0]!.score, 2, "Host score is 2 after 2 wins");
  assertEqual(lobby.players[1]!.score, 1, "Joiner score is 1 after 1 win");

  // Reset ready states for rematch
  const resetResult = mgr.resetReadyStates(host.code);
  assert(resetResult.success === true, "Reset ready states succeeds");
  assert(resetResult.lobby.status === "waiting", "Lobby status resets to waiting");
  assert(resetResult.lobby.players[0]!.ready === false, "Host ready reset");
  assert(resetResult.lobby.players[1]!.ready === false, "Joiner ready reset");

  // Scores preserved
  assertEqual(resetResult.lobby.players[0]!.score, 2, "Host score preserved after reset");
  assertEqual(resetResult.lobby.players[1]!.score, 1, "Joiner score preserved after reset");
}

// ---- Exit and Lobby Cleanup ----
console.log("\n--- Exit and Lobby Cleanup ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const joinUserId = lobby.players[1]!.id;

  // Host leaves
  const hostLeave = mgr.leaveLobby(host.code, lobby.players[0]!.id);
  assert(hostLeave.success === true, "Host leave succeeds");
  assert(hostLeave.lobby !== null, "Lobby still exists after host leaves (other player present)");
  assert(hostLeave.lobby!.hostId === joinUserId, "New host is the remaining player");

  // Other player leaves
  const otherLeave = mgr.leaveLobby(host.code, joinUserId);
  assert(otherLeave.success === true, "Other player leave succeeds");
  assert(otherLeave.lobby === null, "Lobby is deleted when both leave");
  assert(mgr.getLobby(host.code) === undefined, "Lobby no longer exists");
}

// ---- Host Leaves, Lobby Persists ----
console.log("\n--- Host Leaves, Lobby Persists ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const joinUserId = lobby.players[1]!.id;

  const leaveResult = mgr.leaveLobby(host.code, lobby.players[0]!.id);
  assert(leaveResult.success === true, "Host leaves");
  assert(leaveResult.lobby !== null, "Lobby persists");
  assert(leaveResult.lobby!.hostId === joinUserId, "Ownership transferred");
  assert(leaveResult.lobby!.players[0] !== null, "Remaining player is in slot 0");
  assert(leaveResult.lobby!.players[1] === null, "Slot 1 is empty");
}

// ---- Username Validation ----
console.log("\n--- Username Validation ---");
{
  const mgr = new LobbyManager();
  const emptyResult = mgr.createLobby("");
  // Empty username creates a player (validation happens at WS layer, not LobbyManager)
  // This tests that the LobbyManager itself doesn't validate
  assert(emptyResult.player.username === "", "LobbyManager accepts empty username (validation at WS layer)");
}

// ---- Mirrored Map Setup ----
console.log("\n--- Mirrored Map Setup ---");
{
  const map = createMap(DEFAULT_CONFIG);
  const midY = DEFAULT_CONFIG.mapHeight / 2;
  const midX = DEFAULT_CONFIG.mapWidth / 2;

  // Blue spawn on left, red spawn on right
  assert(map.blueSpawn.x < midX, "Blue spawn is on the left side");
  assert(map.redSpawn.x > midX, "Red spawn is on the right side");

  // Blue crystal near blue spawn, red crystal near red spawn
  assert(map.blueCrystal.x < midX, "Blue crystal is on the left side");
  assert(map.redCrystal.x > midX, "Red crystal is on the right side");

  // Workers are near their respective crystals
  for (const wp of map.blueWorkers) {
    assert(wp.x < midX, "Blue workers are on the left side");
  }
  for (const wp of map.redWorkers) {
    assert(wp.x > midX, "Red workers are on the right side");
  }

  // Safe nodes: blue on left, red on right
  for (const n of map.blueSafeNodes) {
    assert(n.x < midX, "Blue safe nodes are on the left side");
  }
  for (const n of map.redSafeNodes) {
    assert(n.x > midX, "Red safe nodes are on the right side");
  }

  // Contested nodes are spread across the middle area
  for (const n of map.contestedNodes) {
    assert(Math.abs(n.x - midX) < 500, "Contested nodes are within the middle area");
  }

  // Build zones
  assert(map.blueBuildZone.x2 < midX, "Blue build zone is on the left");
  assert(map.redBuildZone.x1 > midX, "Red build zone is on the right");

 // Lane corridor
  assert(map.laneCorridor.top < midY, "Lane corridor top is above center");
  assert(map.laneCorridor.bottom > midY, "Lane corridor bottom is below center");
}

// ---- Camera Config Validation ----
console.log("\n--- Camera Config Validation ---");
{
  const config = DEFAULT_CONFIG;
  assert(config.mapWidth >= config.viewportWidth, "Map width >= viewport width");
  assert(config.mapHeight >= config.viewportHeight, "Map height >= viewport height");
  assert(config.mapWidth === 3000, "World width is 3000");
  assert(config.mapHeight === 600, "World height is 600");
  assert(config.viewportWidth === 600, "Viewport width is 600");
  assert(config.viewportHeight === 600, "Viewport height is 600");
  assert(config.mapWidth / config.viewportWidth === 5, "World is 5 viewport widths wide");
}

// ---- Camera Clamping Logic ----
console.log("\n--- Camera Clamping Logic ---");
{
  const mapWidth = 3000;
  const viewportWidth = 600;
  const maxCameraX = mapWidth - viewportWidth;

  const clamp = (x: number): number => Math.max(0, Math.min(maxCameraX, x));

  assert(clamp(-100) === 0, "Camera clamped to 0 when below minimum");
  assert(clamp(0) === 0, "Camera stays at 0");
  assert(clamp(1000) === 1000, "Camera stays at 1000 (within bounds)");
  assert(clamp(2400) === 2400, "Camera stays at 2400 (max)");
  assert(clamp(3000) === 2400, "Camera clamped to max when above maximum");
  assert(clamp(99999) === 2400, "Camera clamped to max for very large values");
}

// ---- Screen-to-World Coordinate Conversion ----
console.log("\n--- Screen-to-World Coordinate Conversion ---");
{
  const cameraX = 500;
  const viewportWidth = 600;

  const screenToWorldX = (screenX: number, camX: number): number => screenX + camX;

  assert(screenToWorldX(0, cameraX) === 500, "Screen x=0 maps to world x=500 (camera position)");
  assert(screenToWorldX(300, cameraX) === 800, "Screen x=300 maps to world x=800 (center of viewport)");
  assert(screenToWorldX(599, cameraX) === 1099, "Screen x=599 maps to world x=1099 (right edge)");

  const worldToScreenX = (worldX: number, camX: number): number => worldX - camX;

  assert(worldToScreenX(500, cameraX) === 0, "World x=500 maps to screen x=0");
  assert(worldToScreenX(800, cameraX) === 300, "World x=800 maps to screen x=300");
  assert(worldToScreenX(1099, cameraX) === 599, "World x=1099 maps to screen x=599");

  for (let worldX = 0; worldX < 3000; worldX += 100) {
    const screenX = worldToScreenX(worldX, cameraX);
    const backToWorldX = screenToWorldX(screenX, cameraX);
    assert(backToWorldX === worldX, `Round-trip consistent for world x=${worldX}`);
  }
}

// ---- Minimap Click-to-Camera Mapping ----
console.log("\n--- Minimap Click-to-Camera Mapping ---");
{
  const mapWidth = 3000;
  const minimapWidth = 150;
  const viewportWidth = 600;
  const maxCameraX = mapWidth - viewportWidth;

  const minimapScale = minimapWidth / mapWidth;
  assertEqual(minimapScale, 0.05, "Minimap scale is 0.05 (150/3000)");

  const clickX = minimapWidth / 2;
  const worldX = (clickX / minimapWidth) * mapWidth;
  const cameraX = worldX - viewportWidth / 2;
  assertEqual(cameraX, 1200, "Click at minimap center sets camera to 1200");

  const clickLeft = 0;
  const worldLeft = (clickLeft / minimapWidth) * mapWidth;
  const cameraLeft = worldLeft - viewportWidth / 2;
  const clampedLeft = Math.max(0, cameraLeft);
  assertEqual(clampedLeft, 0, "Click at minimap left edge clamps camera to 0");

  const clickRight = minimapWidth;
  const worldRight = (clickRight / minimapWidth) * mapWidth;
  const cameraRight = worldRight - viewportWidth / 2;
  const clampedRight = Math.min(maxCameraX, cameraRight);
  assertEqual(clampedRight, 2400, "Click at minimap right edge clamps camera to 2400");

  const clickThird = minimapWidth / 3;
  const worldThird = (clickThird / minimapWidth) * mapWidth;
  const cameraThird = worldThird - viewportWidth / 2;
  assertEqual(cameraThird, 700, "Click at 1/3 minimap sets camera to 700");
}

// ---- Mirrored Map Placement in Larger World ----
console.log("\n--- Mirrored Map Placement in Larger World ---");
{
  const map = createMap(DEFAULT_CONFIG);
  const mapWidth = DEFAULT_CONFIG.mapWidth;
  const midX = mapWidth / 2;

  assert(map.blueCrystal.x < 200, `Blue crystal at x=${map.blueCrystal.x} (far left)`);
  assert(map.redCrystal.x > mapWidth - 200, `Red crystal at x=${map.redCrystal.x} (far right)`);

  const crystalDistance = map.redCrystal.x - map.blueCrystal.x;
  assert(crystalDistance > 2500, `Crystal distance is ${crystalDistance} (should be > 2500)`);

  const blueBuildZoneWidth = map.blueBuildZone.x2 - map.blueBuildZone.x1;
  const redBuildZoneWidth = map.redBuildZone.x2 - map.redBuildZone.x1;
  assertEqual(blueBuildZoneWidth, mapWidth * 0.2, "Blue build zone is 20% of map width");
  assertEqual(redBuildZoneWidth, mapWidth * 0.2, "Red build zone is 20% of map width");

  assert(map.blueBuildZone.x2 < midX, "Blue build zone is on the left side");
  assert(map.redBuildZone.x1 > midX, "Red build zone is on the right side");

  for (const wp of map.blueWorkers) {
    assert(wp.x > map.blueCrystal.x, "Blue workers are to the right of blue crystal");
    assert(wp.x < midX, "Blue workers are on the left side");
  }
  for (const wp of map.redWorkers) {
    assert(wp.x < map.redCrystal.x, "Red workers are to the left of red crystal");
    assert(wp.x > midX, "Red workers are on the right side");
  }

  for (const n of map.blueSafeNodes) {
    assert(n.x > map.blueCrystal.x, "Blue safe nodes are to the right of blue crystal");
    assert(n.x < midX, "Blue safe nodes are on the left side");
  }
  for (const n of map.redSafeNodes) {
    assert(n.x < map.redCrystal.x, "Red safe nodes are to the left of red crystal");
    assert(n.x > midX, "Red safe nodes are on the right side");
  }

  const contestedSorted = [...map.contestedNodes].sort((a, b) => a.x - b.x);
  assert(contestedSorted[0].x < midX, "Leftmost contested node is left of center");
  assert(contestedSorted[1].x >= midX - 50, "Center contested node is near center");
  assert(contestedSorted[2].x > midX, "Rightmost contested node is right of center");
}

// ---- Summary ----
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(40) + "\n");

if (failed > 0) {
  process.exit(1);
}
