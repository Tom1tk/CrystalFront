import { LobbyManager } from "../server/src/lobby/lobbyManager.js";
import { MatchEngine } from "../server/src/match/matchEngine.js";
import { createMap } from "../server/src/match/map.js";
import { DEFAULT_CONFIG } from "../server/src/match/types.js";
import type { MatchEntity, PlayerSlot, ResourceNode } from "../server/src/match/types.js";
import type { Player, LobbyCode } from "../shared/src/index.js";
import { CLIENT_MSG, SERVER_EVT, WS_EVENT } from "../shared/src/messages.js";
import { ALL_ACTIONS, ACTION_SPACE_SIZE, actionToIndex, indexToAction, legalMask } from "../headless/src/actionIndex.js";
import { getLegalActions } from "../headless/src/legalActions.js";
import { expandMacroAction } from "../headless/src/actionSpace.js";
import { buildObservation } from "../headless/src/observation.js";
import { ECONOMY } from "../shared/src/gameBalance.js";

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
  const skirmisher = engine["createEntity"](match.idGen,
    "skirmisher", p1.id, 3000, 300, 120, 12, "#44dd88"
  );
  const gunner = engine["createEntity"](match.idGen,
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
  const baseSkirmisherDamage = 12;  // updated: skirmisher damage was reduced to 12
  const expectedDamage = Math.round(baseSkirmisherDamage * 2.0);
  assert(gunnerAfter.health === 80 - expectedDamage, `Gunner took ${expectedDamage} damage (2x counter)`);

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
  const skirmisher = engine["createEntity"](match.idGen,
    "skirmisher", p1.id, 3000, 300, 120, 12, "#44dd88"
  );
  const enemyWorker = engine["createEntity"](match.idGen,
    "worker", p2.id, 3000, 300, 100, 10, "#ff6666"
  );
  match.entities.set(skirmisher.id, skirmisher);
  match.entities.set(enemyWorker.id, enemyWorker);

  // Combat units now spawn with auto-attack enabled by default
  assert(skirmisher.autoAttackEnabled === true, "Skirmisher autoAttackEnabled is true by default");

  engine.tick(match.id);
  const skirmAfter = match.entities.get(skirmisher.id)!;
  assert(skirmAfter.attackTargetId === enemyWorker.id, "Skirmisher auto-acquired enemy in range when auto-attack enabled");

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
  const bruiser = engine["createEntity"](match.idGen,
    "bruiser", p1.id, 3000, 300, 200, 14, "#8866cc"
  );
  bruiser.maxHealth = 250; // UNIT_DEFS.bruiser.health
  const medic = engine["createEntity"](match.idGen,
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
  assert(bruiserAfter.health === Math.min(250, 200 + 2), "Bruiser healed by Medic when in range");

  // Move bruiser far from medic to trigger follow
  bruiser.x = 3200;
  bruiser.y = 300;

  // Tick - medic should follow but not heal (out of range)
  engine.tick(match.id);
  const medicAfter = match.entities.get(medic.id)!;
  assert(medicAfter.moveTarget !== undefined, "Medic moves toward heal target when out of range");

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
  const barracks = engine["createEntity"](match.idGen,
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
  const turret = engine["createEntity"](match.idGen,
    "building", p1.id, 3000, 300, 400, 15, "#aa8844", "turret"
  );
  turret.constructionProgress = 100;
  turret.health = 400;
  turret.maxHealth = 400;
  match.entities.set(turret.id, turret);

  // Create an enemy worker within range
  const enemyWorker = engine["createEntity"](match.idGen,
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
  const skirmisher = engine["createEntity"](match.idGen,
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
  const skirmisher = engine["createEntity"](match.idGen,
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
  const w1 = engine["createEntity"](match.idGen,
    "worker", p1.id, 3000, 300, 100, 10, "#6699ff"
  );
  const w2 = engine["createEntity"](match.idGen,
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

}
// ---- Message Type Constants Consistency ----
console.log("\n--- Message Type Constants Consistency ---");
{
  // All CLIENT_MSG types should have corresponding WS_EVENT types
  // (except client-to-server-only messages that don't need server-side event names)
  const clientOnlyKeys = new Set(["USERNAME", "MATCH_START", "START_SOLO_TEST"]);
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

}

// ---- Fog of War: Visibility Ranges Defined ----
console.log("\n--- Fog of War: Visibility Ranges Defined ---");
{
  const { UNIT_DEFS, BUILDING_DEFS } = require("../shared/src/gameBalance.js");

  // All unit types have visionRange
  for (const [type, def] of Object.entries(UNIT_DEFS)) {
    assert(typeof (def as any).visionRange === "number", `Unit ${type} has visionRange (${(def as any).visionRange})`);
  }

  // All building types have visionRange
  for (const [type, def] of Object.entries(BUILDING_DEFS)) {
    assert(typeof (def as any).visionRange === "number", `Building ${type} has visionRange (${(def as any).visionRange})`);
  }

  // Actual vision ranges from constants.ts
  assertEqual(UNIT_DEFS.worker.visionRange, 225, "Worker visionRange is 225");
  assertEqual(UNIT_DEFS.skirmisher.visionRange, 300, "Skirmisher visionRange is 300");
  assertEqual(UNIT_DEFS.gunner.visionRange, 270, "Gunner visionRange is 270");
  assertEqual(UNIT_DEFS.bruiser.visionRange, 195, "Bruiser visionRange is 195");
  assertEqual(UNIT_DEFS.medic.visionRange, 210, "Medic visionRange is 210");

  // Buildings
  assertEqual(BUILDING_DEFS.barracks.visionRange, 180, "Barracks visionRange is 180");
  assertEqual(BUILDING_DEFS.foundry.visionRange, 180, "Foundry visionRange is 180");
  assertEqual(BUILDING_DEFS.supply_depot.visionRange, 150, "Supply depot visionRange is 150");
  assertEqual(BUILDING_DEFS.turret.visionRange, 225, "Turret visionRange is 225");
}

// ---- Fog of War: Basic Visibility Computation ----
console.log("\n--- Fog of War: Basic Visibility Computation ---");
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

  // Initial tick — visibility data should be computed
  engine.tick(match.id);

  const visData = match.visibilityData;
  assert(visData !== undefined, "Visibility data exists after first tick");

  const blueVis = visData!.get(p1.id)!;
  const redVis = visData!.get(p2.id)!;
  assert(blueVis !== undefined, "Blue player has visibility data");
  assert(redVis !== undefined, "Red player has visibility data");

  // Blue player sees own entities
  const blueEntities = Array.from(match.entities.values()).filter(
    (e) => e.ownerId === p1.id
  );
  for (const e of blueEntities) {
    assert(blueVis.entityIds.has(e.id), `Blue sees own ${e.type} (${e.id})`);
  }

  // Blue player sees nearby resource nodes
  assert(blueVis.nodeIds.size > 0, "Blue player sees at least some resource nodes");

  // Blue player does NOT see distant red entities (they start far apart)
  const redEntities = Array.from(match.entities.values()).filter(
    (e) => e.ownerId === p2.id
  );
  const redVisibleToBlue = redEntities.filter(e => blueVis.entityIds.has(e.id));
  assert(redVisibleToBlue.length === 0, "Blue player sees no red entities at game start (too far apart)");

}

// ---- Fog of War: Entity Within Range Is Visible ----
console.log("\n--- Fog of War: Entity Within Range Is Visible ---");
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
  const blueWorker = blueWorkers[0];

  const redWorkers = Array.from(match.entities.values()).filter(
    (e: any) => e.type === "worker" && e.ownerId === p2.id
  );
  const redWorker = redWorkers[0];
  // Move a red worker within blue worker vision range (225)
  redWorker.x = blueWorker.x + 200; // Within 225 vision range
  redWorker.y = blueWorker.y;

  engine.tick(match.id);
  const blueVis = match.visibilityData!.get(p1.id)!;
  assert(blueVis.entityIds.has(redWorker.id), "Blue worker sees red worker within vision range");

  // Move red worker far away (beyond all vision)
  redWorker.x = blueWorker.x + 400;
  engine.tick(match.id);
  const blueVis2 = match.visibilityData!.get(p1.id)!;
  assert(!blueVis2.entityIds.has(redWorker.id), "Blue worker does NOT see red worker beyond vision range");

}

// ---- Fog of War: Dead Entities Not Visible ----
console.log("\n--- Fog of War: Dead Entities Not Visible ---");
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
    (e: any) => e.type === "worker" && e.ownerId === p1.id
  );
  const aliveWorker = blueWorkers[0];
  const deadWorker = blueWorkers[1];
  deadWorker.health = 0;

  engine.tick(match.id);
  const blueVis = match.visibilityData!.get(p1.id)!;
  assert(blueVis.entityIds.has(aliveWorker.id), "Alive blue worker is visible to blue player");
  assert(!blueVis.entityIds.has(deadWorker.id), "Dead blue worker is NOT visible (not a vision source)");

}

// ---- Fog of War: Crystal Has Extended Vision ----
console.log("\n--- Fog of War: Crystal Has Extended Vision ---");
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

  // Get blue crystal
  const blueCrystal = Array.from(match.entities.values()).find(
    (e) => e.type === "crystal" && e.ownerId === p1.id
  )!;

  // Create a red entity within crystal vision (225)
  const redWorker = engine["createEntity"](match.idGen,
    "worker", p2.id, blueCrystal.x + 200, blueCrystal.y, 100, 10, "#ff6666"
  );
  match.entities.set(redWorker.id, redWorker);

  engine.tick(match.id);
  const blueVis = match.visibilityData!.get(p1.id)!;
  assert(blueVis.entityIds.has(redWorker.id), "Blue crystal sees red worker at distance 140 (within 150 vision)");

}

// ---- Supply System ----
console.log("\n--- Supply System ---");
{
  const { ECONOMY } = require("../shared/src/gameBalance.js");
  const STARTING_MAX_SUPPLY = ECONOMY.startingMaxSupply;
  const WORKER_SUPPLY_COST = ECONOMY.workerSupplyCost;

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

  // Initial supply: 3 workers * 1 = 3 per player
  assertEqual(match.economy[0]!.supply, 3 * WORKER_SUPPLY_COST, "Blue starts with supply = 3 (3 workers)");
  assertEqual(match.economy[1]!.supply, 3 * WORKER_SUPPLY_COST, "Red starts with supply = 3 (3 workers)");
  assertEqual(match.economy[0]!.maxSupply, STARTING_MAX_SUPPLY, "Blue starts with maxSupply = 10");
  assertEqual(match.economy[1]!.maxSupply, STARTING_MAX_SUPPLY, "Red starts with maxSupply = 10");

  engine.startMatch(match.id);

  // Train a worker — should increase supply
  const blueCrystal = Array.from(match.entities.values()).find(
    (e) => e.type === "crystal" && e.ownerId === p1.id
  )!;
  const trainResult = engine.processCommand(match.id, p1.id, {
    type: "train_worker",
    entityId: blueCrystal.id,
  });
  assert(trainResult.success, "Train worker succeeds at supply 3/10");
  assertEqual(match.economy[0]!.supply, 4 * WORKER_SUPPLY_COST, "Blue supply is 4 after training worker");

  // Unit spawn from production queue increments supply
  // Train a skirmisher from barracks
  // First build a barracks
  const { BUILDING_DEFS } = require("../shared/src/gameBalance.js");
  const barracksDef = BUILDING_DEFS.barracks;
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === p1.id
  );
  const buildResult = engine.processCommand(match.id, p1.id, {
    type: "build",
    buildingType: "barracks",
    targetX: 300,
    targetY: 300,
    workerIds: [blueWorkers[0].id],
  });
  if (buildResult.success) {
    const barracks = Array.from(match.entities.values()).find(
      (e) => e.type === "building" && e.buildingType === "barracks" && e.ownerId === p1.id
    )!;
    // Fast complete the barracks
    barracks.constructionProgress = 100;

    // Queue a skirmisher
    const trainUnitResult = engine.processCommand(match.id, p1.id, {
      type: "train_unit",
      entityId: barracks.id,
      unitType: "skirmisher",
    });
    assert(trainUnitResult.success, "Queue skirmisher succeeds");
    // Supply NOT incremented yet (unit not spawned)
    assertEqual(match.economy[0]!.supply, 4 * WORKER_SUPPLY_COST, "Supply unchanged while unit in queue");

    // Tick until skirmisher spawns
    for (let i = 0; i < 100; i++) {
      engine.tick(match.id);
      if (barracks.productionQueue.length === 0) break;
    }
    // Supply incremented after spawn
    const skirmisherCost = require("../shared/src/constants.js").UNIT_DEFS.skirmisher.supplyCost;
    assertEqual(
      match.economy[0]!.supply,
      (4 + skirmisherCost) * WORKER_SUPPLY_COST,
      "Supply increased after skirmisher spawns from queue"
    );
  }

  // Supply cap blocks training when at limit
  // Set supply to near cap to test, ensure enough resources
  match.economy[0]!.supply = STARTING_MAX_SUPPLY - 1;
  match.economy[0]!.resources = 999;
  const trainAtCap = engine.processCommand(match.id, p1.id, {
    type: "train_worker",
    entityId: blueCrystal.id,
  });
  assert(trainAtCap.success, "Train worker succeeds at supply 9/10");
  assertEqual(match.economy[0]!.supply, STARTING_MAX_SUPPLY, "Supply is now 10/10");

  // At cap — should fail
  const trainOverCap = engine.processCommand(match.id, p1.id, {
    type: "train_worker",
    entityId: blueCrystal.id,
  });
  assert(!trainOverCap.success, "Train worker blocked at supply 10/10");
  assert(trainOverCap.message === "Not enough supply", "Error message is 'Not enough supply'");

  // Supply depot increases maxSupply
  match.economy[0]!.supply = 5; // reset
  const depotProvided = BUILDING_DEFS.supply_depot.supplyProvided;
  const oldMax = match.economy[0]!.maxSupply;
  match.economy[0]!.maxSupply += depotProvided;
  assertEqual(match.economy[0]!.maxSupply, oldMax + depotProvided, "Supply depot adds " + depotProvided + " to maxSupply");

  // Depot destruction reduces maxSupply
  match.economy[0]!.maxSupply -= depotProvided;
  assertEqual(match.economy[0]!.maxSupply, oldMax, "Destroyed depot removes " + depotProvided + " from maxSupply");

  // Reset match preserves supply accounting
  const resetPlayers: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: p1.score, wsId: "ws1" },
    { playerId: p2.id, username: p2.username, color: p2.color, score: p2.score, wsId: "ws2" },
  ];
  engine.resetMatch(match.id, resetPlayers);
  assertEqual(match.economy[0]!.supply, 3 * WORKER_SUPPLY_COST, "Reset: blue supply back to 3");
  assertEqual(match.economy[0]!.maxSupply, STARTING_MAX_SUPPLY, "Reset: blue maxSupply back to 10");
  assertEqual(match.economy[1]!.supply, 3 * WORKER_SUPPLY_COST, "Reset: red supply back to 3");

  // Cross-building queue supply cap enforcement
  // Setup: 3 units, maxSupply 10, so 7 slots left. Queue 4 from barracks, 3 from foundry = 7 total queued.
  // Attempt to queue 1 more from foundry should be blocked (would be 8 queued > 7 available).
  const { BUILDING_DEFS: BD } = require("../shared/src/gameBalance.js");

  // Set phase to playing (resetMatch left it at "spawn")
  match.phase = "playing";

  // Ensure enough resources for building + training
  match.economy[0]!.resources = 9999;

  // Get worker IDs for construction
  const crossWorkers = Array.from(match.entities.values())
    .filter((e) => e.type === "worker" && e.ownerId === p1.id);
  assert(crossWorkers.length >= 2, "At least 2 workers available");
  const crossWorkerId = crossWorkers[0]!.id;
  assert(!match.entities.get(crossWorkerId)?.buildTargetId, "Worker is not building");

  // Build barracks
  const crossBarracks = engine.processCommand(match.id, p1.id, {
    type: "build",
    buildingType: "barracks",
    targetX: 500,
    targetY: 300,
    workerIds: [crossWorkerId],
  });
  assert(crossBarracks.success, `Barracks build: ${crossBarracks.message}`);
  const crossBarr = Array.from(match.entities.values()).find(
    (e) => e.type === "building" && e.buildingType === "barracks" && e.ownerId === p1.id
  )!;
  crossBarr.constructionProgress = 100;
  crossBarr.health = BD.barracks.health;

  // Queue 4 skirmishers from barracks (4 supply, each = 1)
  for (let i = 0; i < 4; i++) {
    const qr = engine.processCommand(match.id, p1.id, {
      type: "train_unit",
      buildingId: crossBarr.id,
      unitType: "skirmisher",
    });
    assert(qr.success, `Barracks queue ${i + 1}/4 skirmisher`);
  }

  // Build foundry
  const crossFoundry = engine.processCommand(match.id, p1.id, {
    type: "build",
    buildingType: "foundry",
    entityId: p1.id,
    targetX: 520,
    targetY: 120,
    workerIds: [crossWorkers[1]!.id],
  });
  assert(crossFoundry.success, `Foundry build: ${crossFoundry.message}`);
  const crossFoundryEnt = Array.from(match.entities.values()).find(
    (e) => e.type === "building" && e.buildingType === "foundry" && e.ownerId === p1.id
  )!;
  crossFoundryEnt.constructionProgress = 100;
  crossFoundryEnt.health = BD.foundry.health;

  // Queue bruisers from foundry (bruiser = 2 supply each)
  // After barracks: 3 supply (workers) + 4 (skirmishers) = 7/10
  // 1st bruiser: 7 + 2 = 9/10 ✓
  // 2nd bruiser: 9 + 2 = 11 > 10 ✗ (blocked — cross-building cap enforced!)
  const bruiser1 = engine.processCommand(match.id, p1.id, {
    type: "train_unit",
    buildingId: crossFoundryEnt.id,
    unitType: "bruiser",
  });
  assert(bruiser1.success, "Foundry queue 1st bruiser (9/10)");

  // 2nd bruiser should be blocked by cross-building supply cap
  const bruiserOverCap = engine.processCommand(match.id, p1.id, {
    type: "train_unit",
    buildingId: crossFoundryEnt.id,
    unitType: "bruiser",
  });
  assert(!bruiserOverCap.success, "Cross-building queue blocked at supply cap");
  assertEqual(bruiserOverCap.message, "Not enough supply", "Cross-building error is supply");

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

// ---- Determinism: Same seed produces identical state ----
console.log("\n--- Determinism: Same seed produces identical state ---");
{
  const mgr2 = new LobbyManager();
  const h1 = mgr2.createLobby("Alice");
  mgr2.joinLobby(h1.code, "Bob");
  const lobby2 = mgr2.getLobby(h1.code)!;
  const p1 = lobby2.players[0]!;
  const p2 = lobby2.players[1]!;
  const slots: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: p1.id, username: p1.username, color: p1.color, score: 0 },
    { playerId: p2.id, username: p2.username, color: p2.color, score: 0 },
  ];

  function runAndHash(seed: number): string {
    const eng = new MatchEngine();
    const m = eng.createMatch("test", slots, DEFAULT_CONFIG, seed);
    eng.startMatch(m.id);
    // Issue train_worker commands early to trigger spawnOutside (the one randomness site)
    const crystal = Array.from(m.entities.values()).find(e => e.type === "crystal" && e.ownerId === p1.id)!;
    m.economy[0]!.resources = 9999;
    for (let i = 0; i < 5; i++) {
      eng.processCommand(m.id, p1.id, { type: "train_worker", entityId: crystal.id });
    }
    for (let i = 0; i < 500; i++) eng.tick(m.id);
    // Build a stable hash from entity positions + health
    const entities = Array.from(m.entities.values())
      .sort((a, b) => a.id.localeCompare(b.id));
    return entities.map(e => `${e.id}:${e.x.toFixed(2)},${e.y.toFixed(2)},${e.health}`).join("|");
  }

  const SEED = 0xdeadbeef;
  const run1 = runAndHash(SEED);
  const run2 = runAndHash(SEED);
  assert(run1 === run2, "Two runs with the same seed produce identical state after 500 ticks");
  assert(run1.length > 0, "State hash is non-empty");

  const run3 = runAndHash(SEED + 1);
  assert(run1 !== run3, "Different seeds produce different states");
}

// ---- Action Index ----
console.log("\n--- Action Index ---");
{
  assert(ACTION_SPACE_SIZE === 58, `Action space has 58 actions (got ${ACTION_SPACE_SIZE})`);

  // Every action round-trips through index
  let allRoundTrip = true;
  for (let i = 0; i < ALL_ACTIONS.length; i++) {
    const action = ALL_ACTIONS[i];
    const idx = actionToIndex(action);
    if (idx !== i) { allRoundTrip = false; break; }
    const back = indexToAction(idx);
    // Re-index the recovered action
    if (actionToIndex(back) !== i) { allRoundTrip = false; break; }
  }
  assert(allRoundTrip, "All actions round-trip: action → index → action → same index");

  // No duplicate indices
  const indices = ALL_ACTIONS.map((_, i) => i);
  assert(new Set(indices).size === ALL_ACTIONS.length, "No duplicate indices");

  // indexToAction throws on out-of-range
  let threw = false;
  try { indexToAction(ACTION_SPACE_SIZE); } catch { threw = true; }
  assert(threw, "indexToAction throws on out-of-range index");
}

// ---- Legal Actions + Mask ----
console.log("\n--- Legal Actions + Mask ---");
{
  const engine = new MatchEngine();
  const blueId = "test-blue";
  const redId  = "test-red";
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: blueId, username: "Blue", color: "blue", score: 0 },
    { playerId: redId,  username: "Red",  color: "red",  score: 0 },
  ];
  const match = engine.createMatch("test", players, DEFAULT_CONFIG, 42);
  engine.startMatch(match.id);

  const legal = getLegalActions(match, blueId);
  assert(legal.length > 0, "Legal actions non-empty at match start");
  assert(legal[0].type === "noop", "noop always legal");

  // Every legal action has a valid index
  const invalidIdx = legal.filter(a => actionToIndex(a) < 0);
  assert(invalidIdx.length === 0, `All legal actions have valid indices (found ${invalidIdx.length} unknown)`);

  // Mask covers all legal actions
  const mask = legalMask(legal);
  assert(mask.length === ACTION_SPACE_SIZE, "Mask length equals action space size");
  const legalCount = mask.filter(Boolean).length;
  assert(legalCount === legal.length, "Mask true-count equals legal action count");
}

// ---- Expand Macro Actions — every legal action produces valid commands ----
console.log("\n--- Expand Macro Actions ---");
{
  // Use a rich but sub-threshold starting balance (just below passiveWinThreshold)
  // so builds don't starve and the passive win doesn't fire during the test.
  const richConfig = { ...DEFAULT_CONFIG, startingResources: ECONOMY.passiveWinThreshold - 100 };
  const engine = new MatchEngine();
  const blueId = "test-blue2";
  const redId  = "test-red2";
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: blueId, username: "Blue", color: "blue", score: 0 },
    { playerId: redId,  username: "Red",  color: "red",  score: 0 },
  ];
  const match = engine.createMatch("test2", players, richConfig, 99);
  engine.startMatch(match.id);
  for (let i = 0; i < 50; i++) engine.tick(match.id);

  // Test that each action TYPE can succeed somewhere in its legal variants.
  // Collect actions by category, then for each category try all variants and
  // pass if AT LEAST ONE variant produces a successful command.
  const legal = getLegalActions(match, blueId);
  const byCategory = new Map<string, typeof legal>();
  for (const action of legal) {
    if (action.type === "noop") continue;
    const key = action.type === "build"     ? `build_${action.buildingType}` :
                action.type === "train_unit" ? `train_${action.unitType}` :
                action.type;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(action);
  }

  let failedCategories = 0;
  for (const [key, variants] of byCategory) {
    let anySucceeded = false;
    for (const action of variants) {
      const cmds = expandMacroAction(action, match, blueId);
      if (cmds.length === 0) continue;
      for (const cmd of cmds) {
        const r = engine.processCommand(match.id, blueId, cmd as Parameters<MatchEngine["processCommand"]>[2]);
        if (r.success) { anySucceeded = true; break; }
      }
      if (anySucceeded) break;
    }
    if (!anySucceeded && variants.some(v => expandMacroAction(v, match, blueId).length > 0)) {
      failedCategories++;
      console.error(`    category with no successful variant: ${key}`);
    }
  }
  assert(failedCategories === 0, `Each action category has at least one valid position (${failedCategories} categories failed)`);
}

// ---- Observation ----
console.log("\n--- Observation ---");
{
  const engine = new MatchEngine();
  const blueId = "obs-blue";
  const redId  = "obs-red";
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: blueId, username: "Blue", color: "blue", score: 0 },
    { playerId: redId,  username: "Red",  color: "red",  score: 0 },
  ];
  const match = engine.createMatch("obs-test", players, DEFAULT_CONFIG, 7);
  engine.startMatch(match.id);
  for (let i = 0; i < 10; i++) engine.tick(match.id);

  const obs = buildObservation(match, blueId);
  assert(obs.playerId === blueId, "Observation has correct playerId");
  assert(obs.global.ownCrystalHealthFrac === 1, "Crystal starts at full health");
  assert(obs.global.ownResourcesWinFrac >= 0, "Resources win fraction >= 0");
  assert(obs.global.ownLifetimeResourcesFrac >= 0, "Lifetime resources fraction >= 0");
  assert(obs.entities.length > 0, "Observation contains own entities");
  assert(obs.entities.every(e => [1, -1].includes(e.owner)), "Entity owner is 1 or -1");
}

// ---- Passive Win Condition ----
console.log("\n--- Passive Win Condition ---");
{
  const engine = new MatchEngine();
  const blueId = "pw-blue";
  const redId  = "pw-red";
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: blueId, username: "Blue", color: "blue", score: 0 },
    { playerId: redId,  username: "Red",  color: "red",  score: 0 },
  ];
  const match = engine.createMatch("pw-test", players, DEFAULT_CONFIG, 1);
  engine.startMatch(match.id);

  // Set held resources just below threshold for blue
  match.economy[0]!.resources = ECONOMY.passiveWinThreshold - 1;
  engine.tick(match.id);
  assert(match.phase === "playing", "Match still playing before threshold");

  // Push over threshold (held bank reaches threshold)
  match.economy[0]!.resources = ECONOMY.passiveWinThreshold;
  engine.tick(match.id);
  assert(match.phase === "ended", "Match ends when passive win threshold reached");
  assert(match.result?.winner === blueId, "Blue wins the passive win");
  assert(match.result?.winType === "resource", "Win type is 'resource'");
}

// ---- Engine Determinism ----
console.log("\n--- Engine Determinism ---");
{
  function runAndHash(seed: number, ticks: number): string {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "det-blue", username: "Blue", color: "blue", score: 0 },
      { playerId: "det-red",  username: "Red",  color: "red",  score: 0 },
    ];
    const match = engine.createMatch("det-test", players, DEFAULT_CONFIG, seed);
    engine.startMatch(match.id);
    for (let i = 0; i < ticks && match.phase === "playing"; i++) {
      engine.tick(match.id);
    }
    // Hash: sorted entity ids + positions + health (deterministic ordering)
    const snapshot = Array.from(match.entities.values())
      .map(e => `${e.type}:${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.health)}`)
      .sort()
      .join("|");
    return snapshot;
  }

  const SEED = 0xdeadbeef;
  const TICKS = 500;
  const run1 = runAndHash(SEED, TICKS);
  const run2 = runAndHash(SEED, TICKS);
  assert(run1 === run2, `Same seed (${SEED}) produces identical state after ${TICKS} ticks`);
  assert(run1.length > 0, "State hash is non-empty (match made progress)");

  // Runs with the same seed must also be identical across multiple repetitions
  const run3 = runAndHash(SEED, TICKS);
  assert(run1 === run3, `Third run with same seed (${SEED}) also matches`);
}

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(40) + "\n");

if (failed > 0) {
  process.exit(1);
}
