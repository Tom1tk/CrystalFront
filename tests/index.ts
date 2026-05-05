import { LobbyManager } from "../server/src/lobby/lobbyManager.js";
import { MatchEngine } from "../server/src/match/matchEngine.js";
import { createMap } from "../server/src/match/map.js";
import { DEFAULT_CONFIG } from "../server/src/match/types.js";
import type { MatchEntity, PlayerSlot, ResourceNode } from "../server/src/match/types.js";
import type { Player, LobbyCode } from "../shared/src/index.js";
import { CLIENT_MSG, SERVER_EVT, WS_EVENT } from "../shared/src/messages.js";

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
  assert(config.mapWidth === 6000, "World width is 6000");
  assert(config.mapHeight === 600, "World height is 600");
  assert(config.viewportWidth === 960, "Viewport width is 960");
  assert(config.viewportHeight === 540, "Viewport height is 540");
  assert(Math.abs(config.mapWidth / config.viewportWidth - 6.25) < 0.01, "World is ~6.25 viewport widths wide");
}

// ---- Camera Clamping Logic ----
console.log("\n--- Camera Clamping Logic ---");
{
  const mapWidth = 6000;
  const viewportWidth = 600;
  const maxCameraX = mapWidth - viewportWidth;

  const clamp = (x: number): number => Math.max(0, Math.min(maxCameraX, x));

  assert(clamp(-100) === 0, "Camera clamped to 0 when below minimum");
  assert(clamp(0) === 0, "Camera stays at 0");
  assert(clamp(1000) === 1000, "Camera stays at 1000 (within bounds)");
  assert(clamp(5400) === 5400, "Camera stays at 5400 (max)");
  assert(clamp(6000) === 5400, "Camera clamped to max when above maximum");
  assert(clamp(99999) === 5400, "Camera clamped to max for very large values");
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

  for (let worldX = 0; worldX < 6000; worldX += 100) {
    const screenX = worldToScreenX(worldX, cameraX);
    const backToWorldX = screenToWorldX(screenX, cameraX);
    assert(backToWorldX === worldX, `Round-trip consistent for world x=${worldX}`);
  }
}

// ---- Minimap Click-to-Camera Mapping ----
console.log("\n--- Minimap Click-to-Camera Mapping ---");
{
  const mapWidth = 6000;
  const minimapWidth = 150;
  const viewportWidth = 600;
  const maxCameraX = mapWidth - viewportWidth;

  const minimapScale = minimapWidth / mapWidth;
  assertEqual(minimapScale, 0.025, "Minimap scale is 0.025 (150/6000)");

  const clickX = minimapWidth / 2;
  const worldX = (clickX / minimapWidth) * mapWidth;
  const cameraX = worldX - viewportWidth / 2;
  assertEqual(cameraX, 2700, "Click at minimap center sets camera to 2700");

  const clickLeft = 0;
  const worldLeft = (clickLeft / minimapWidth) * mapWidth;
  const cameraLeft = worldLeft - viewportWidth / 2;
  const clampedLeft = Math.max(0, cameraLeft);
  assertEqual(clampedLeft, 0, "Click at minimap left edge clamps camera to 0");

  const clickRight = minimapWidth;
  const worldRight = (clickRight / minimapWidth) * mapWidth;
  const cameraRight = worldRight - viewportWidth / 2;
  const clampedRight = Math.min(maxCameraX, cameraRight);
  assertEqual(clampedRight, 5400, "Click at minimap right edge clamps camera to 5400");

  const clickThird = minimapWidth / 3;
  const worldThird = (clickThird / minimapWidth) * mapWidth;
  const cameraThird = worldThird - viewportWidth / 2;
  assertEqual(cameraThird, 1700, "Click at 1/3 minimap sets camera to 1700");
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
  assert(crystalDistance > 5000, `Crystal distance is ${crystalDistance} (should be > 5000)`);

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
  assert(contestedSorted[1].x >= midX - 200, "Second contested node is left of center but within 200px");
  assert(contestedSorted[2].x >= midX, "Center contested node is at or right of center line");
}

// ---- Combat: Move Command (Incremental Movement) ----
console.log("\n--- Combat: Move Command (Incremental Movement) ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;
  const p2 = lobby.players[1]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Get a blue worker
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === p1.id
  );
  const worker = blueWorkers[0];
  const startX = worker.x;
  const startY = worker.y;

  // Issue move command
  const moveResult = engine.processCommand(match.id, p1.id, {
    type: "move",
    entityId: worker.id,
    targetX: startX + 100,
    targetY: startY,
  });
  assert(moveResult.success, "Move command succeeds");

  // Verify entity has moveTarget set (not snapped)
  assert(worker.moveTarget !== undefined, "Entity has moveTarget set after move command");
  assert(worker.x === startX, "Entity position hasn't changed instantly (no snap)");

  // Tick once - entity should move toward target
  engine.tick(match.id);
  const movedWorker = match.entities.get(worker.id)!;
  assert(movedWorker.x > startX, "Entity moved toward target after tick");
  assert(movedWorker.x < startX + 100, "Entity hasn't reached target yet (gradual movement)");

  // Tick multiple times until arrival
  let arrived = false;
  for (let i = 0; i < 60; i++) {
    engine.tick(match.id);
    const w = match.entities.get(worker.id);
    if (!w) break;
    const dx = Math.abs(w.x - (startX + 100));
    if (dx <= 1) {
      assert(w.moveTarget === undefined, "MoveTarget cleared on arrival");
      arrived = true;
      break;
    }
  }
  assert(arrived, "Worker arrived at destination");

  engine.stopMatch(match.id);
}

// ---- Combat: Attack Command ----
console.log("\n--- Combat: Attack Command ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;
  const p2 = lobby.players[1]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Get a blue worker and a red worker
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === p1.id
  );
  const redWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === p2.id
  );
  const blueWorker = blueWorkers[0];
  const redWorker = redWorkers[0];

  // Place blue worker at same position as red worker (within range, no soft-collision push)
  blueWorker.x = redWorker.x;
  blueWorker.y = redWorker.y;

  // Issue attack command
  const attackResult = engine.processCommand(match.id, p1.id, {
    type: "attack",
    entityId: blueWorker.id,
    targetEntityId: redWorker.id,
  });
  assert(attackResult.success, "Attack command succeeds");
  assert(blueWorker.attackTargetId === redWorker.id, "Attack target is set");

  // Reset attack cooldown so worker can attack immediately
  blueWorker.attackCooldown = 0;

  // Tick - damage should be dealt
  engine.tick(match.id);
  const redAfter = match.entities.get(redWorker.id)!;
  assert(redAfter.health < redWorker.maxHealth, "Red worker took damage");

  // Can't attack friendly
  const blueAttackBlue = engine.processCommand(match.id, p1.id, {
    type: "attack",
    entityId: blueWorker.id,
    targetEntityId: blueWorkers[1].id,
  });
  assert(!blueAttackBlue.success, "Cannot attack friendly units");

  engine.stopMatch(match.id);
}

// ---- Combat: Counter Damage Multipliers ----
console.log("\n--- Combat: Counter Damage Multipliers ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;
  const p2 = lobby.players[1]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Create a skirmisher for blue and a gunner for red
  // Skirmisher beats gunner (2x damage)
  const skirmisher = engine["createEntity"](
    "skirmisher", p1.id, 3000, 300, 120, 12, "#44dd88"
  );
  const gunner = engine["createEntity"](
    "gunner", p2.id, 3000, 300, 80, 11, "#ddaa44"
  );
  match.entities.set(skirmisher.id, skirmisher);
  match.entities.set(gunner.id, gunner);

  // Set attack target
  skirmisher.attackTargetId = gunner.id;
  skirmisher.attackCooldown = 0;

  // Tick - skirmisher should deal 2x damage to gunner
  engine.tick(match.id);
  const gunnerAfter = match.entities.get(gunner.id)!;
  const baseSkirmisherDamage = 15;
  const expectedDamage = Math.round(baseSkirmisherDamage * 2.0);
  assert(gunnerAfter.health === 80 - expectedDamage, `Gunner took ${expectedDamage} damage (2x counter)`);

  engine.stopMatch(match.id);
}

// ---- Combat: Auto-Attack in Range ----
console.log("\n--- Combat: Auto-Attack in Range ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;
  const p2 = lobby.players[1]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Create a skirmisher for blue and a worker for red, within range
  const skirmisher = engine["createEntity"](
    "skirmisher", p1.id, 3000, 300, 120, 12, "#44dd88"
  );
  const enemyWorker = engine["createEntity"](
    "worker", p2.id, 3000, 300, 100, 10, "#ff6666"
  );
  match.entities.set(skirmisher.id, skirmisher);
  match.entities.set(enemyWorker.id, enemyWorker);

  // Verify autoAttackEnabled is false by default for units
  assert(skirmisher.autoAttackEnabled === false, "Skirmisher autoAttackEnabled is false by default");

  // Enable auto-attack manually, skirmisher should auto-acquire target
  skirmisher.autoAttackEnabled = true;
  match.entities.set(skirmisher.id, skirmisher);
  engine.tick(match.id);
  const skirmAfter = match.entities.get(skirmisher.id)!;
  assert(skirmAfter.attackTargetId === enemyWorker.id, "Skirmisher auto-acquired enemy in range when auto-attack enabled");

  engine.stopMatch(match.id);
}

// ---- Combat: Medic Follow-Heal ----
console.log("\n--- Combat: Medic Follow-Heal ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    null,
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Create a medic and a bruiser for blue (bruiser maxHealth=250 from UNIT_DEFS)
  const bruiser = engine["createEntity"](
    "bruiser", p1.id, 3000, 300, 200, 14, "#8866cc"
  );
  bruiser.maxHealth = 250; // UNIT_DEFS.bruiser.health
  const medic = engine["createEntity"](
    "medic", p1.id, 3000, 300, 90, 11, "#44ccdd"
  );
  match.entities.set(bruiser.id, bruiser);
  match.entities.set(medic.id, medic);

  // Assign heal target
  const healResult = engine.processCommand(match.id, p1.id, {
    type: "heal",
    entityId: medic.id,
    targetEntityId: bruiser.id,
  });
  assert(healResult.success, "Heal command succeeds");
  assert(medic.healTargetId === bruiser.id, "Medic has heal target set");

  // Tick - medic should heal bruiser (both at same position, in range)
  engine.tick(match.id);
  const bruiserAfter = match.entities.get(bruiser.id)!;
  assert(bruiserAfter.health === Math.min(250, 200 + 5), "Bruiser healed by Medic when in range");

  // Move bruiser far from medic to trigger follow
  bruiser.x = 3200;
  bruiser.y = 300;

  // Tick - medic should follow but not heal (out of range)
  engine.tick(match.id);
  const medicAfter = match.entities.get(medic.id)!;
  assert(medicAfter.moveTarget !== undefined, "Medic moves toward heal target when out of range");

  engine.stopMatch(match.id);
}

// ---- Combat: Worker Repair ----
console.log("\n--- Combat: Worker Repair ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    null,
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Get a blue worker
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === p1.id
  );
  const worker = blueWorkers[0];

  // Create a damaged barracks for blue
  const barracks = engine["createEntity"](
    "building", p1.id, 200, 300, 500, 20, "#4488cc", "barracks"
  );
  barracks.constructionProgress = 100;
  barracks.health = 300;
  barracks.maxHealth = 500;
  match.entities.set(barracks.id, barracks);

  // Issue repair command
  const repairResult = engine.processCommand(match.id, p1.id, {
    type: "repair",
    entityId: worker.id,
    targetEntityId: barracks.id,
  });
  assert(repairResult.success, "Repair command succeeds");
  assert(barracks.repairTargetId === worker.id, "Building has repair worker assigned");

  // Tick - repair should progress
  engine.tick(match.id);
  const barracksAfter = match.entities.get(barracks.id)!;
  assert(barracksAfter.health > 300, "Building health increased from repair");

  engine.stopMatch(match.id);
}

// ---- Combat: Turret Auto-Attack ----
console.log("\n--- Combat: Turret Auto-Attack ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;
  const p2 = lobby.players[1]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Create a turret for blue
  const turret = engine["createEntity"](
    "building", p1.id, 3000, 300, 400, 15, "#aa8844", "turret"
  );
  turret.constructionProgress = 100;
  turret.health = 400;
  turret.maxHealth = 400;
  match.entities.set(turret.id, turret);

  // Create an enemy worker within range
  const enemyWorker = engine["createEntity"](
    "worker", p2.id, 3100, 300, 100, 10, "#ff6666"
  );
  match.entities.set(enemyWorker.id, enemyWorker);

  // Tick - turret should auto-attack
  engine.tick(match.id);
  const turretAfter = match.entities.get(turret.id)!;
  assert(turretAfter.autoAttackEnabled === true, "Turret has autoAttackEnabled");
  assert(turretAfter.attackTargetId === enemyWorker.id, "Turret auto-acquired enemy in range");

  const workerAfter = match.entities.get(enemyWorker.id)!;
  assert(workerAfter.health < 100, "Enemy worker took turret damage");

  engine.stopMatch(match.id);
}

// ---- Combat: Crystal Destruction Ends Match ----
console.log("\n--- Combat: Crystal Destruction Ends Match ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;
  const p2 = lobby.players[1]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Get red crystal
  const crystals = Array.from(match.entities.values()).filter(
    (e) => e.type === "crystal"
  );
  const redCrystal = crystals.find((c) => c.ownerId === p2.id)!;

  // Create a powerful skirmisher near the red crystal
  const skirmisher = engine["createEntity"](
    "skirmisher", p1.id, redCrystal.x - 10, redCrystal.y, 120, 12, "#44dd88"
  );
  match.entities.set(skirmisher.id, skirmisher);

  // Attack the crystal multiple times until it dies
  skirmisher.attackTargetId = redCrystal.id;
  for (let i = 0; i < 100; i++) {
    engine.tick(match.id);
    const crystal = match.entities.get(redCrystal.id);
    if (!crystal || crystal.health <= 0) {
      break;
    }
    // Reset cooldown for faster testing
    skirmisher.attackCooldown = 0;
  }

  // Check that the match has ended
  const finalMatch = engine.getMatch(match.id);
  assert(finalMatch!.phase === "ended", "Match ended when crystal was destroyed");
  assert(finalMatch!.result!.winner === p1.id, "Blue player wins when red crystal is destroyed");

  engine.stopMatch(match.id);
}

// ---- Combat: Rematch Reset After Combat ----
console.log("\n--- Combat: Rematch Reset After Combat ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;
  const p2 = lobby.players[1]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Create a skirmisher and set some combat state
  const skirmisher = engine["createEntity"](
    "skirmisher", p1.id, 3000, 300, 120, 12, "#44dd88"
  );
  skirmisher.attackTargetId = "some-target";
  skirmisher.moveTarget = { x: 5000, y: 300 };
  skirmisher.attackCooldown = 5;
  match.entities.set(skirmisher.id, skirmisher);

  // Reset match for rematch
  const newPlayers: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  const resetMatch = engine.resetMatch(match.id, newPlayers);
  assert(resetMatch !== null, "Reset succeeds");
  assert(resetMatch!.phase === "spawn", "Phase reset to spawn");
  assert(resetMatch!.tick === 0, "Tick reset to 0");
  assert(resetMatch!.result === null, "Result cleared");

  // Check that new entities don't have stale combat state
  const newWorkers = Array.from(resetMatch!.entities.values()).filter(
    (e) => e.type === "worker"
  );
  for (const w of newWorkers) {
    assert(w.attackTargetId === undefined, "New worker has no attack target");
    assert(w.moveTarget === undefined, "New worker has no move target");
    assert(w.attackCooldown === 0, "New worker has reset attack cooldown");
  }

  engine.stopMatch(match.id);
}

// ---- Soft Collision ----
console.log("\n--- Soft Collision ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    null,
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  // Create two workers very close together (overlapping)
  const w1 = engine["createEntity"](
    "worker", p1.id, 3000, 300, 100, 10, "#6699ff"
  );
  const w2 = engine["createEntity"](
    "worker", p1.id, 3005, 300, 100, 10, "#6699ff"
  );
  match.entities.set(w1.id, w1);
  match.entities.set(w2.id, w2);

  // Set move targets to trigger movement pass
  w1.moveTarget = { x: 3100, y: 300 };
  w2.moveTarget = { x: 3100, y: 300 };

  // Tick - soft collision should push them apart
  engine.tick(match.id);
  const w1After = match.entities.get(w1.id)!;
  const w2After = match.entities.get(w2.id)!;
  const dx = Math.abs(w1After.x - w2After.x);
  assert(dx >= w1After.radius + w2After.radius - 1, "Soft collision pushes overlapping units apart");

  engine.stopMatch(match.id);
}
// ---- Message Type Constants Consistency ----
console.log("\n--- Message Type Constants Consistency ---");
{
  // All CLIENT_MSG types should have corresponding WS_EVENT types
  // (except client-to-server-only messages that don't need server-side event names)
  const clientOnlyKeys = new Set(["USERNAME", "MATCH_START"]);
  for (const [key, value] of Object.entries(CLIENT_MSG)) {
    if (clientOnlyKeys.has(key)) continue;
    const wsValue = (WS_EVENT as any)[key];
    assert(wsValue !== undefined, `WS_EVENT has ${key} (matches CLIENT_MSG.${key})`);
    assert(wsValue === value, `WS_EVENT.${key} === CLIENT_MSG.${key} ("${value}")`);
  }

  // CLIENT_MSG.DEBUG_SPAWN must exist and equal "debug_spawn"
  assert(CLIENT_MSG.DEBUG_SPAWN === "debug_spawn", "CLIENT_MSG.DEBUG_SPAWN === 'debug_spawn'");

  // SERVER_EVT should be a subset of WS_EVENT
  for (const [key, value] of Object.entries(SERVER_EVT)) {
    const wsValue = (WS_EVENT as any)[key];
    assert(wsValue !== undefined, `WS_EVENT has ${key} (matches SERVER_EVT.${key})`);
    assert(wsValue === value, `WS_EVENT.${key} === SERVER_EVT.${key} ("${value}")`);
  }

  // No duplicate values in CLIENT_MSG
  const clientMsgValues = Object.values(CLIENT_MSG);
  const uniqueClientMsgValues = new Set(clientMsgValues);
  assert(uniqueClientMsgValues.size === clientMsgValues.length, "CLIENT_MSG has no duplicate values");

  // No duplicate values in SERVER_EVT
  const serverEvtValues = Object.values(SERVER_EVT);
  const uniqueServerEvtValues = new Set(serverEvtValues);
  assert(uniqueServerEvtValues.size === serverEvtValues.length, "SERVER_EVT has no duplicate values");
}

// ---- Debug Spawn Functionality ----
console.log("\n--- Debug Spawn Functionality ---");
{
  const mgr = new LobbyManager();
  const host = mgr.createLobby("HostUser");
  mgr.joinLobby(host.code, "JoinUser");
  const lobby = mgr.getLobby(host.code)!;
  const p1 = lobby.players[0]!;

  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    null,
  ];
  const match = engine.createMatch(host.code, players);
  engine.startMatch(match.id);

  const initialEntityCount = match.entities.size;

  // Debug spawn a worker
  const workerResult = engine.debugSpawn(match.id, p1.id, "worker", 100, 100);
  assert(workerResult.success, "Debug spawn worker succeeds");

  // Debug spawn a skirmisher
  const skirmisherResult = engine.debugSpawn(match.id, p1.id, "skirmisher", 200, 200);
  assert(skirmisherResult.success, "Debug spawn skirmisher succeeds");

  // Debug spawn a building (barracks)
  const buildingResult = engine.debugSpawn(match.id, p1.id, "building", 300, 300, "barracks");
  assert(buildingResult.success, "Debug spawn building (barracks) succeeds");

  // Verify entities were added
  const newEntityCount = match.entities.size;
  assert(newEntityCount === initialEntityCount + 3, `3 entities added (${newEntityCount} - ${initialEntityCount} = ${newEntityCount - initialEntityCount})`);

  // Debug spawn with invalid entity type
  const invalidResult = engine.debugSpawn(match.id, p1.id, "nonexistent" as any, 400, 400);
  assert(!invalidResult.success, "Debug spawn with invalid entity type fails");

  // Debug spawn with invalid building type
  const invalidBuildingResult = engine.debugSpawn(match.id, p1.id, "building", 500, 500, "nonexistent" as any);
  assert(!invalidBuildingResult.success, "Debug spawn with invalid building type fails");

  engine.stopMatch(match.id);
}

// ---- Server Message Handler Coverage ----
console.log("\n--- Server Message Handler Coverage ---");
{
  // Read the server source and verify all CLIENT_MSG types are handled
  const fs = require("fs");
  const serverSrc = fs.readFileSync(require("path").resolve(__dirname, "../server/src/index.ts"), "utf-8");

  for (const [key, value] of Object.entries(CLIENT_MSG)) {
    const hasCase = serverSrc.includes(`CLIENT_MSG.${key}`);
    assert(hasCase, `Server switch handles CLIENT_MSG.${key} ("${value}")`);
  }
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(40) + "\n");

if (failed > 0) {
  process.exit(1);
}
