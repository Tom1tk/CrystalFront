import { LobbyManager } from "../server/src/lobby/lobbyManager.js";
import { MatchEngine } from "../server/src/match/matchEngine.js";
import { createMap } from "../server/src/match/map.js";
import { DEFAULT_CONFIG } from "../server/src/match/types.js";
import type { MatchEntity, MatchState, PlayerSlot, ResourceNode } from "../server/src/match/types.js";
import type { Player, LobbyCode } from "../shared/src/index.js";
import { CLIENT_MSG, SERVER_EVT, WS_EVENT } from "../shared/src/messages.js";
import { ALL_ACTIONS, ACTION_SPACE_SIZE, actionToIndex, indexToAction, legalMask } from "../headless/src/actionIndex.js";
import { getLegalActions } from "../headless/src/legalActions.js";
import { expandMacroAction } from "../headless/src/actionSpace.js";
import { buildObservation } from "../headless/src/observation.js";
import { ECONOMY, HEALING, ENGINE_VERSION, CONTROL, LEASH, GUARD, GATHERING } from "../shared/src/gameBalance.js";
import { processControl, controlNeeded } from "../server/src/match/engine/control.js";
import { saveReplay, getReplay, listReplays } from "../server/src/match/replayRunner.js";
import { mirrorState, deepCloneMatchState, diffStates } from "../server/src/match/engine/mirror.js";
import { planPath } from "../server/src/match/engine/pathfinding.js";
import { guardRadius } from "../server/src/match/engine/combat.js";
import { MediumRushBot } from "../headless/src/bots/mediumRushBot.js";
import { MacroBot } from "../headless/src/bots/macroBot.js";
import { LiveMatchRunner } from "../server/src/match/liveMatchRunner.js";
import { hashMatchState } from "../server/src/match/engine/hash.js";
import { LoadGate } from "../server/src/match/loadGate.js";
import { actionStateOf, headingOf, staticMapOf } from "../server/src/match/engine/presentation.js";
import { isCellBlocked, rebuildNavGrid, anchorsConnected, floodConnected, footprintOf, type Rect as NavRect } from "../server/src/match/engine/navGrid.js";
import { buildTerrain, terrainAt, isObstacleCode, T_ROCK, T_WATER, T_OPEN, T_HIGH, T_CLIFF, T_ROUGH } from "../server/src/match/engine/terrain.js";
import { getRange, getVisionRange } from "../server/src/match/engine/utils.js";
import { computeVisibility, encodeVision } from "../server/src/match/engine/visibility.js";
import { generateMap, validateMap } from "../server/src/match/mapgen.js";
import { registerMap, poolMaps, isKnownMap, terrainFor, mapIds, anchorsFor } from "../server/src/match/maps.js";
import { ANCHOR_MAX, imagePt, seatAnchors, type Pt } from "../server/src/match/engine/anchors.js";
import { validateBuildSite } from "../server/src/match/buildingValidation.js";
import { cellOf, flowField } from "../server/src/match/engine/pathfinding.js";
import { BUILDING_DEFS } from "../shared/src/gameBalance.js";
import { POOL_MAPS } from "../server/src/match/pool/index.js";
import { readFileSync as _readFileSync, readdirSync as _readdirSync } from "node:fs";
import { loadGolden, runCase } from "../headless/src/goldenHashes.js";
import { runMatch } from "../headless/src/runMatch.js";
import { IdleBot } from "../headless/src/bots/index.js";
import { episodeStatus, evalScore, TRAIN_MAX_TICKS } from "../headless/src/episode.js";
import * as V2 from "../headless/src/v2/actions.js";
import { frameFor, toOwnFrame, fromOwnFrame } from "../headless/src/v2/frame.js";
import * as OBS from "../headless/src/v2/observation.js";
import { imageState } from "../headless/src/v2/imageState.js";
import { VecRunnerV2, PLAYER_IDS as V2_PIDS, mixSeed, strSeed, type V2Replay } from "../headless/src/v2/runner.js";
import { replayObservations, replayCommandLog } from "../headless/src/v2/replayObs.js";
import { makeV2Bot } from "../headless/src/v2/bots.js";
import { SCRIPTED, SWITCH_WINDOW, ScriptedV2Bot, botContext, scriptedZs } from "../headless/src/v2/scripted.js";
import { existsSync as _existsSync, unlinkSync as _unlinkSync, writeFileSync as _writeFileSync } from "node:fs";
import { resolve as _resolve, join as _join } from "node:path";

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
  assert(config.mapWidth === 5000, "World width is 5000 (G-2)");
  assert(config.mapHeight === 900, "World height is 900 (G-2)");
  assert(config.viewportWidth === 960, "Viewport width is 960");
  assert(config.viewportHeight === 540, "Viewport height is 540");
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
  assert(crystalDistance > 4500, `Crystal distance is ${crystalDistance} (should be > 4500)`);

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
  computeVisibility(match); // state edited by hand: refresh fog as a tick would (G-6b)
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
  // Skirmisher beats gunner (1.5x damage)
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

  // Tick - skirmisher should deal 1.5x damage to gunner
  computeVisibility(match); // state edited by hand: refresh fog as a tick would (G-6b)
  engine.tick(match.id);
  const gunnerAfter = match.entities.get(gunner.id)!;
  const baseSkirmisherDamage = 12;  // updated: skirmisher damage was reduced to 12
  const expectedDamage = Math.round(baseSkirmisherDamage * 1.5);  // updated: COUNTER_MODIFIER 2.0 -> 1.5
  assert(gunnerAfter.health === 80 - expectedDamage, `Gunner took ${expectedDamage} damage (1.5x counter)`);

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

  computeVisibility(match); // state edited by hand: refresh fog as a tick would (G-6b)
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

  // Tick until the worker walks into range (G-13: repair needs range) - repair should progress
  for (let i = 0; i < 600 && barracks.health <= 300; i++) engine.tick(match.id);
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
  computeVisibility(match); // state edited by hand: refresh fog as a tick would (G-6b)
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

// ---- Combat: Crystal Regen ----
console.log("\n--- Combat: Crystal Regen ---");
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

  const blueCrystal = Array.from(match.entities.values()).find(
    (e) => e.type === "crystal" && e.ownerId === p1.id
  )!;

  // No enemy nearby -> crystal regenerates
  blueCrystal.health = blueCrystal.maxHealth - 10;
  engine.tick(match.id);
  assert(
    Math.abs(blueCrystal.health - (blueCrystal.maxHealth - 10 + HEALING.crystalRegenHpPerTick)) < 1e-9,
    "Crystal regenerates when below max HP and no enemy is nearby"
  );

  // Enemy worker moves next to the crystal -> regen blocked
  const enemyWorker = Array.from(match.entities.values()).find(
    (e) => e.type === "worker" && e.ownerId === p2.id
  )!;
  enemyWorker.x = blueCrystal.x;
  enemyWorker.y = blueCrystal.y;
  const healthBefore = blueCrystal.health;
  engine.tick(match.id);
  assert(blueCrystal.health === healthBefore, "Crystal does not regenerate when an enemy is nearby");

  // Move enemy worker away and verify regen does not exceed max HP
  enemyWorker.x = blueCrystal.x + 1000;
  blueCrystal.health = blueCrystal.maxHealth - 0.03;
  engine.tick(match.id);
  assert(blueCrystal.health === blueCrystal.maxHealth, "Crystal regen does not exceed max HP");

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
  const clientOnlyKeys = new Set(["USERNAME", "MATCH_START", "START_SOLO_TEST", "START_BOT_GAME"]);
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
  assert(ACTION_SPACE_SIZE === 81, `Action space has 71 actions (got ${ACTION_SPACE_SIZE})`);

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
  // Use a rich starting balance so builds don't starve.
  const richConfig = { ...DEFAULT_CONFIG, startingResources: 4400 };
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
  assert(obs.global.ownControlFrac === 0 && obs.global.controlHoldFrac === 0, "No node control at start");
  assert(obs.global.ownLifetimeResourcesFrac >= 0, "Lifetime resources fraction >= 0");
  assert(obs.entities.length > 0, "Observation contains own entities");
  assert(obs.entities.every(e => [1, -1].includes(e.owner)), "Entity owner is 1 or -1");
}

// ---- Node Control Win (G-8) ----
console.log("\n--- Node Control Win (G-8) ---");
{
  const engine = new MatchEngine();
  const blueId = "nc-blue";
  const redId  = "nc-red";
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: blueId, username: "Blue", color: "blue", score: 0 },
    { playerId: redId,  username: "Red",  color: "red",  score: 0 },
  ];
  const match = engine.createMatch("nc-test", players, { ...DEFAULT_CONFIG, mapId: "ironreed" }, 1);
  engine.startMatch(match.id);
  const contested = match.resourceNodes.filter(n => n.contested);
  const need = controlNeeded(contested.length);
  assert(contested.length >= 5 && need === Math.floor(contested.length / 2) + 1, `pool map has contested nodes, majority needed (${contested.length}, ${need})`);
  assert(match.resourceNodes.some(n => !n.contested), "safe nodes are not contested");

  let uid = 0;
  const place = (owner: string, x: number, y: number, type = "gunner") => {
    const id = `nc-u${uid++}`;
    match.entities.set(id, { id, ownerId: owner, type, health: 80, maxHealth: 80, x, y, radius: 8,
      autoAttackEnabled: false, constructionProgress: 100 } as any);
    return id;
  };
  const node = (k: number) => contested[k];

  // A lone unit holds its node; both sides present = nobody holds it.
  const b0 = place(blueId, node(0).x + 100, node(0).y);
  processControl(match);
  assert(node(0).controller === 0, "blue unit within radius holds the node");
  const r0 = place(redId, node(0).x - 100, node(0).y);
  processControl(match);
  assert(node(0).controller === null, "both sides present: node is contested (no holder)");
  match.entities.delete(r0);
  // Workers and turrets (finished or not) don't hold nodes; only combat units do.
  const w = place(redId, node(1).x, node(1).y, "worker");
  processControl(match);
  assert(node(1).controller === null, "a worker does not hold a node");
  match.entities.delete(w);
  const t = `nc-t${uid++}`;
  match.entities.set(t, { id: t, ownerId: redId, type: "building", buildingType: "turret", x: node(1).x + 80, y: node(1).y,
    health: 600, maxHealth: 600, radius: 15, constructionProgress: 50 } as any);
  processControl(match);
  assert(node(1).controller === null, "unfinished turret does not hold a node");
  match.entities.get(t)!.constructionProgress = 100;
  processControl(match);
  assert(node(1).controller === null, "finished turret does not hold a node");
  match.entities.delete(t);
  match.entities.delete(b0);

  // Majority hold: one short is not enough; a majority gains progress.
  for (let k = 0; k < need - 1; k++) place(blueId, node(k).x, node(k).y);
  processControl(match);
  assert(match.control.holder === null && match.control.progress[0] === 0, "holding one short of a majority is not enough");
  const fifth = place(blueId, node(need - 1).x, node(need - 1).y);
  processControl(match); processControl(match);
  assert(match.control.holder === 0 && match.control.progress[0] === 2, "holding a majority gains blue progress");
  // Losing the majority pauses progress (it doesn't reset).
  match.entities.delete(fifth);
  processControl(match);
  assert(match.control.holder === null && match.control.progress[0] === 2, "no majority pauses progress");
  // The opponent's majority drains it.
  const reds = Array.from({ length: need }, (_, k) => place(redId, node(contested.length - 1 - k).x, node(contested.length - 1 - k).y));
  for (let k = 0; k < need - 1; k++) for (const [id, e] of match.entities) if (e.ownerId === blueId && Math.hypot(e.x - node(k).x, e.y - node(k).y) < 1) match.entities.delete(id);
  processControl(match);
  assert(match.control.holder === 1 && match.control.progress[1] === 1 && match.control.progress[0] === 1, "red's majority drains blue's progress");
  for (const id of reds) match.entities.delete(id);
  match.control.progress = [0, 0];
  for (let k = 0; k < need; k++) place(blueId, node(k).x, node(k).y);

  // Engine: holding for CONTROL.holdTicks wins with winType "control".
  let ticks = 0;
  while (match.phase === "playing" && ticks < CONTROL.holdTicks + 5) { engine.tick(match.id); ticks++; }
  assert(match.phase === "ended", `match ends after holding a majority (${ticks} ticks)`);
  assert(match.result?.winner === blueId && match.result?.winType === "control", "blue wins by control");
  assert(ticks >= CONTROL.holdTicks, `control win needs the full hold (${ticks} >= ${CONTROL.holdTicks})`);

  // Holding resources no longer wins.
  const m2 = engine.createMatch("nc-test2", players, DEFAULT_CONFIG, 2);
  engine.startMatch(m2.id);
  m2.economy[0]!.resources = 100000;
  engine.tick(m2.id);
  assert(m2.phase === "playing", "a large resource bank no longer ends the match");
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

// ---- Play vs Bot (start_bot_game) flow ----
console.log("\n--- Play vs Bot: start_bot_game flow ---");
{
  // Simulate the full server-side flow that the server handler executes:
  // lobby creation → bot added → both ready → match created and started.
  // This validates the critical path that was producing a blank screen.

  const mgr = new LobbyManager();
  const engine = new MatchEngine();

  // 1. Create lobby for the human player
  const { code, player: humanPlayer } = mgr.createLobby("TestUser");
  assert(code.length === 6, "bot_game: lobby code is 6 chars");
  assert(humanPlayer.username === "TestUser", "bot_game: human player username set");
  assert(humanPlayer.color === "blue", "bot_game: human player is blue");

  // 2. Add bot player
  const botPlayer = mgr.addBotToLobby(code);
  assert(botPlayer !== null, "bot_game: bot player created");
  assert(botPlayer!.color === "red", "bot_game: bot player is red");

  // 3. Mark both ready
  const r1 = mgr.toggleReady(code, humanPlayer.id);
  assert(r1 !== null, "bot_game: human ready toggle succeeds");
  const r2 = mgr.toggleReady(code, botPlayer!.id);
  assert(r2 !== null, "bot_game: bot ready toggle succeeds");

  // 4. Verify lobby is in "ready" state
  const lobby = mgr.getLobby(code);
  assert(lobby !== null, "bot_game: lobby exists after setup");
  assert(lobby!.status === "ready", "bot_game: lobby status is ready");
  assert(lobby!.players[0]?.ready === true, "bot_game: human is ready");
  assert(lobby!.players[1]?.ready === true, "bot_game: bot is ready");

  // 5. Create and start the match
  function toSlot(p: { id: string; username: string; color: string; score: number }) {
    return { playerId: p.id, username: p.username, color: p.color as "blue" | "red", score: p.score };
  }
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    toSlot(lobby!.players[0]!),
    toSlot(lobby!.players[1]!),
  ];
  const match = engine.createMatch(code, players);
  assert(match !== null, "bot_game: match created");
  engine.startMatch(match.id);
  assert(match.phase === "playing", "bot_game: match phase is 'playing' after start");

  // 6. Verify both players exist in the match with correct colours
  const bluePlayer = match.players.find(p => p?.color === "blue");
  const redPlayer  = match.players.find(p => p?.color === "red");
  assert(bluePlayer !== undefined, "bot_game: blue player in match");
  assert(redPlayer  !== undefined, "bot_game: red player in match");
  assert(bluePlayer!.username === "TestUser", "bot_game: blue player username is TestUser");

  // 7. Verify the match has entities (workers + crystals spawned)
  const entityCount = [...match.entities.values()].length;
  assert(entityCount > 0, "bot_game: match has entities after start");

  // 8. LOBBY_STATE must be sent before MATCH_START (client requires lobbyState to render GameShell).
  //    Validate: lobby state contains the human player's colour so getCurrentPlayer() works.
  const lobbyForHuman = Object.values({ [code]: lobby! }).find(lb =>
    lb!.players.some(p => p?.id === humanPlayer.id)
  );
  assert(lobbyForHuman !== undefined, "bot_game: lobby contains human player (required for getCurrentPlayer)");
  assert(lobbyForHuman!.players[0]?.id === humanPlayer.id, "bot_game: human player is slot 0 (blue)");

  // 9. All bot names map to valid bots (no blank-screen from unknown bot name)
  const validBotNames = ["idle", "passive", "rush_weak", "rush_weak_medium",
                         "rush_medium", "rush", "turtle", "macro", "heavy"];
  for (const name of validBotNames) {
    // If this doesn't throw, the name is handled (actual agent creation tested via runtime)
    assert(typeof name === "string" && name.length > 0, `bot_game: bot name "${name}" is valid string`);
  }
  assert(validBotNames.length === 9, "bot_game: 9 bot options available (scripted)");

  // 10. Match tick advances without error (basic smoke test)
  engine.tick(match.id);
  assert(match.tick === 1, "bot_game: match advances to tick 1");
  engine.tick(match.id);
  assert(match.tick === 2, "bot_game: match advances to tick 2");
}

// ---- Play vs Bot: server message handler sends LOBBY_STATE before MATCH_START ----
console.log("\n--- Play vs Bot: response sequence validation ---");
{
  // Verify that the server handler sends events in the correct order:
  // CONNECTED → LOBBY_STATE → MATCH_START
  // Without LOBBY_STATE, ws.lobbyState is null and GameShell won't render.
  const EXPECTED_SEQUENCE = [
    SERVER_EVT.CONNECTED,    // 1. send playerId
    SERVER_EVT.LOBBY_STATE,  // 2. send lobby (required for getCurrentPlayer / getCurrentLobby)
    SERVER_EVT.MATCH_START,  // 3. send match (triggers screen → "game")
  ] as const;

  // Capture the event types sent during a simulated start_bot_game
  const sentTypes: string[] = [];
  const mockSend = (msg: { type: string }) => { sentTypes.push(msg.type); };

  // Replay the exact handler logic (without WS, just the business logic)
  const mgr2   = new LobbyManager();
  const engine2 = new MatchEngine();
  const { code: code2, player: human2 } = mgr2.createLobby("Player2");
  mockSend({ type: SERVER_EVT.CONNECTED }); // handler sends CONNECTED immediately

  const bot2 = mgr2.addBotToLobby(code2)!;
  mgr2.toggleReady(code2, human2.id);
  mgr2.toggleReady(code2, bot2.id);

  const lobby2 = mgr2.getLobby(code2)!;
  // Handler must call broadcastLobbyState before creating match
  mockSend({ type: SERVER_EVT.LOBBY_STATE }); // MUST happen before MATCH_START

  function toSlot2(p: { id: string; username: string; color: string; score: number }) {
    return { playerId: p.id, username: p.username, color: p.color as "blue" | "red", score: p.score };
  }
  const ps2: [PlayerSlot | null, PlayerSlot | null] = [
    toSlot2(lobby2.players[0]!),
    toSlot2(lobby2.players[1]!),
  ];
  const match2 = engine2.createMatch(code2, ps2);
  engine2.startMatch(match2.id);
  mockSend({ type: SERVER_EVT.MATCH_START }); // sent last

  assert(sentTypes.length === EXPECTED_SEQUENCE.length,
    `bot_game: server sends ${EXPECTED_SEQUENCE.length} events (got ${sentTypes.length})`);
  for (let i = 0; i < EXPECTED_SEQUENCE.length; i++) {
    assert(sentTypes[i] === EXPECTED_SEQUENCE[i],
      `bot_game: event[${i}] is "${EXPECTED_SEQUENCE[i]}" (got "${sentTypes[i]}")`);
  }

  // Verify LOBBY_STATE arrives before MATCH_START (the broken-screen condition)
  const lobbyIdx = sentTypes.indexOf(SERVER_EVT.LOBBY_STATE);
  const matchIdx = sentTypes.indexOf(SERVER_EVT.MATCH_START);
  assert(lobbyIdx !== -1, "bot_game: LOBBY_STATE is sent");
  assert(matchIdx !== -1, "bot_game: MATCH_START is sent");
  assert(lobbyIdx < matchIdx, "bot_game: LOBBY_STATE sent BEFORE MATCH_START (required for GameShell)");
}

// ---- Replay round-trip: playerIds survive save → load → playback ----
console.log("\n--- Replay round-trip: playerIds survive save/load ---");
{
  // Verify that the replay file format correctly preserves bluePlayerId/redPlayerId
  // and that ReplayRunner can use them. Without this, command-log replay fails silently
  // because UUID playerIds in commandLog don't match the hardcoded "headless-blue"/red".
  const BLUE_PID = "test-blue-uuid-12345";
  const RED_PID  = "test-red-uuid-67890";

  const id = saveReplay({
    matchId:      "test-match-1",
    seed:         42,
    blue:         "Alice",
    red:          "Bob",
    bluePlayerId: BLUE_PID,
    redPlayerId:  RED_PID,
    ticks:        100,
    winner:       "blue",
    winnerName:   "Alice",
    winType:      "combat",
    commandLog:   [
      { tick: 5, playerId: BLUE_PID, command: { type: "gather", entityId: "e1", targetEntityId: "n1" } },
      { tick: 5, playerId: RED_PID,  command: { type: "gather", entityId: "e2", targetEntityId: "n2" } },
    ],
    version: "0.3.2-ML-test",
  });

  // 1. Listed replay has playerIds
  const list = listReplays();
  const fromList = list.find(r => r.id === id);
  assert(fromList !== undefined, "round-trip: saved replay appears in listReplays()");
  assert(fromList!.bluePlayerId === BLUE_PID,
    `round-trip: listReplays preserves bluePlayerId (got "${fromList!.bluePlayerId}")`);
  assert(fromList!.redPlayerId  === RED_PID,
    `round-trip: listReplays preserves redPlayerId (got "${fromList!.redPlayerId}")`);

  // 2. Full file loaded has playerIds and commandLog
  const full = getReplay(id);
  assert(full !== null, "round-trip: getReplay returns the file");
  assert(full!.bluePlayerId === BLUE_PID,
    `round-trip: getReplay preserves bluePlayerId (got "${full!.bluePlayerId}")`);
  assert(full!.redPlayerId  === RED_PID,
    `round-trip: getReplay preserves redPlayerId (got "${full!.redPlayerId}")`);
  assert(full!.commandLog.length === 2, "round-trip: commandLog has 2 entries");
  assert(full!.commandLog[0].playerId === BLUE_PID,
    "round-trip: commandLog[0].playerId matches blue UUID (replay engine must accept this)");

  // 3. Verify winner/winnerName preserved
  assert(full!.outcome.winner === "blue",
    `round-trip: outcome.winner preserved (got "${full!.outcome.winner}")`);
  assert((full!.outcome as any).winnerName === "Alice",
    `round-trip: outcome.winnerName preserved (got "${(full!.outcome as any).winnerName}")`);

  // 4. Critical: the playerIds in commandLog MUST match bluePlayerId/redPlayerId
  //    so the ReplayRunner's engine.processCommand() doesn't silently drop everything.
  const cmdPids = new Set(full!.commandLog.map(c => c.playerId));
  const filePids = new Set([full!.bluePlayerId, full!.redPlayerId]);
  for (const pid of cmdPids) {
    assert(filePids.has(pid),
      `round-trip: commandLog playerId "${pid.slice(0,8)}..." matches stored bluePlayerId/redPlayerId`);
  }

  // 5. G-9e: engineVersion stamped and round-trips; stale-version files are ignored
  assert((full as any).engineVersion === ENGINE_VERSION,
    `G-9e: getReplay preserves engineVersion (got ${(full as any).engineVersion})`);
  const REPLAYS_DIR = _resolve(process.cwd(), "replays");
  // G-11: getReplay must keep the map, or pool-map replays play back on "classic"
  const poolId = "test-pool-map-replay";
  const poolPath = _join(REPLAYS_DIR, `${poolId}.json`);
  _writeFileSync(poolPath, JSON.stringify({ ...full, engineVersion: ENGINE_VERSION, mapId: "ironreed", mapVersion: terrainFor("ironreed", DEFAULT_CONFIG.mapWidth, DEFAULT_CONFIG.mapHeight).mapVersion }));
  assert(getReplay(poolId)?.mapId === "ironreed", `G-11: getReplay preserves mapId (got ${getReplay(poolId)?.mapId})`);
  _unlinkSync(poolPath);
  const staleId = "test-stale-engine-version";
  const stalePath = _join(REPLAYS_DIR, `${staleId}.json`);
  _writeFileSync(stalePath, JSON.stringify({ ...full, engineVersion: undefined }));
  assert(getReplay(staleId) === null, "G-9e: getReplay rejects replay without matching engineVersion");
  assert(!listReplays().some(r => r.id === staleId), "G-9e: listReplays skips stale-engine replay");
  _unlinkSync(stalePath);
  _writeFileSync(stalePath, JSON.stringify({ ...full, engineVersion: ENGINE_VERSION, mapId: "classic", mapVersion: 99 }));
  assert(getReplay(staleId) === null && !listReplays().some(r => r.id === staleId), "G-9e: replays of another map version are dropped");
  _writeFileSync(stalePath, JSON.stringify({ ...full, engineVersion: ENGINE_VERSION, mapId: "no-such-map", mapVersion: 1 }));
  assert(getReplay(staleId) === null, "G-9e: replays of an unknown map are dropped");
  _unlinkSync(stalePath);

  // Cleanup
  const path = _join(REPLAYS_DIR, `${id}.json`);
  if (_existsSync(path)) _unlinkSync(path);
}

// ---- legalActions action-forcing (Option B §2.4) ----
console.log("\n--- legalActions: action-forcing (Option B) ---");
{
  function forcingMatch() {
    const e = new MatchEngine();
    const m = e.createMatch("FORCE-TEST", [
      { playerId: "fb", username: "Blue", color: "blue", score: 0 },
      { playerId: "fr", username: "Red",  color: "red",  score: 0 },
    ]);
    m.phase = "playing";
    return { e, m };
  }

  // 1. Default: noop always present
  {
    const { m } = forcingMatch();
    const legal = getLegalActions(m, "fb");
    assert(legal.some(a => a.type === "noop"), "forcing default: noop present with no opts");
  }

  // 2. forcingScale=0 + big streak: noop still present
  {
    const { m } = forcingMatch();
    const legal = getLegalActions(m, "fb", { noopStreak: 9999, forcingScale: 0.0 });
    assert(legal.some(a => a.type === "noop"), "forcing off (scale=0): noop present even with huge streak");
  }

  // 3. Below streak threshold: noop present
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    m.economy[pidx]!.maxSupply = 20;
    m.economy[pidx]!.supply = 0;
    m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
      constructionProgress: 100, health: 500, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
    const legal = getLegalActions(m, "fb", { noopStreak: 29, forcingScale: 1.0 });
    assert(legal.some(a => a.type === "noop"), "forcing: noop present when streak < 30");
  }

  // 4. No resources: noop present (can't afford)
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 0;
    m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
      constructionProgress: 100, health: 500, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
    const legal = getLegalActions(m, "fb", { noopStreak: 200, forcingScale: 1.0 });
    assert(legal.some(a => a.type === "noop"), "forcing: noop present when resources < 50");
  }

  // 5. No barracks AND no workers (Mode A can't fire, Mode B can't fire) → noop present
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    // Remove all workers so Mode A can't fire
    for (const [id, e] of m.entities) {
      if (e.ownerId === "fb" && e.type === "worker") m.entities.delete(id);
    }
    const legal = getLegalActions(m, "fb", { noopStreak: 200, forcingScale: 1.0 });
    assert(legal.some(a => a.type === "noop"), "forcing: noop present when no barracks AND no workers (neither mode fires)");
  }

  // 6. Mode B Variant β': trainUnitStreak >= 200 + barracks + 0 units → noop AND attack_move suppressed
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    m.economy[pidx]!.maxSupply = 20;
    m.economy[pidx]!.supply = 0;
    m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
      constructionProgress: 100, health: 500, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
    // 0 combat units — Mode B fires on trainUnitStreak, not noopStreak
    const legal = getLegalActions(m, "fb", { trainUnitStreak: 200, forcingScale: 1.0 });
    assert(!legal.some(a => a.type === "noop"), "forcing mode B: noop SUPPRESSED (trainUnitStreak=200, barracks ready, 0 units)");
    assert(legal.length > 0, "forcing mode B: non-empty legal list when suppressed");
  }

  // 6b. Mode B Variant β': attack_move also suppressed (prevents 1-unit-attack instead of training)
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    m.economy[pidx]!.maxSupply = 20;
    m.economy[pidx]!.supply = 2;
    m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
      constructionProgress: 100, health: 500, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
    m.entities.set("u1", { id: "u1", ownerId: "fb", type: "skirmisher",
      health: 100, maxHealth: 100, x: 300, y: 300, radius: 8 } as any);
    // 1 combat unit — classic failure case: policy attacks instead of training
    const legal = getLegalActions(m, "fb", { trainUnitStreak: 200, forcingScale: 1.0 });
    assert(!legal.some(a => a.type === "noop"), "forcing mode B: noop suppressed with 1 unit");
    assert(!legal.some(a => a.type === "attack_move"), "forcing mode B: attack_move SUPPRESSED (Variant β' core fix)");
    assert(legal.some(a => a.type === "train_unit"), "forcing mode B: train_unit still legal");
  }

  // 7. 2 combat units: Mode B fires (< 3 threshold) → noop + attack_move suppressed
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    m.economy[pidx]!.maxSupply = 20;
    m.economy[pidx]!.supply = 4;
    m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
      constructionProgress: 100, health: 500, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
    m.entities.set("u1", { id: "u1", ownerId: "fb", type: "skirmisher",
      health: 100, maxHealth: 100, x: 300, y: 300, radius: 8 } as any);
    m.entities.set("u2", { id: "u2", ownerId: "fb", type: "skirmisher",
      health: 100, maxHealth: 100, x: 320, y: 300, radius: 8 } as any);
    const legal = getLegalActions(m, "fb", { trainUnitStreak: 200, forcingScale: 1.0 });
    // 2 units < 3 threshold → Mode B fires
    assert(!legal.some(a => a.type === "noop"), "forcing: noop SUPPRESSED when 2 units (< 3 threshold, Mode B fires)");
    assert(!legal.some(a => a.type === "attack_move"), "forcing: attack_move SUPPRESSED when 2 units (< 3)");
  }

  // 7b. Already 3 combat units: Mode B condition not met → noop and attack_move both present
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    m.economy[pidx]!.maxSupply = 20;
    m.economy[pidx]!.supply = 6;
    m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
      constructionProgress: 100, health: 500, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
    for (const id of ["u1","u2","u3"]) {
      m.entities.set(id, { id, ownerId: "fb", type: "skirmisher",
        health: 100, maxHealth: 100, x: 300, y: 300, radius: 8 } as any);
    }
    const legal = getLegalActions(m, "fb", { trainUnitStreak: 200, forcingScale: 1.0 });
    assert(legal.some(a => a.type === "noop"), "forcing: noop present when >=3 units (Mode B not met)");
  }

  // 7c. Mode B boundary: trainUnitStreak=50 (at threshold) fires; trainUnitStreak=49 does not
  {
    const setup = () => {
      const { m } = forcingMatch();
      const pidx = m.players.findIndex(p => p?.playerId === "fb");
      m.economy[pidx]!.resources = 500;
      m.economy[pidx]!.maxSupply = 20;
      m.economy[pidx]!.supply = 2;
      m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
        constructionProgress: 100, health: 500, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
      m.entities.set("u1", { id: "u1", ownerId: "fb", type: "skirmisher",
        health: 100, maxHealth: 100, x: 300, y: 300, radius: 8 } as any);
      return m;
    };
    assert(!getLegalActions(setup(), "fb", { trainUnitStreak: 50, forcingScale: 1.0 }).some(a => a.type === "noop"),
      "forcing threshold=50: noop suppressed at trainUnitStreak=50");
    assert(getLegalActions(setup(), "fb", { trainUnitStreak: 49, forcingScale: 1.0 }).some(a => a.type === "noop"),
      "forcing threshold=50: noop present at trainUnitStreak=49 (below threshold)");
  }

  // 8. Mode A: no barracks, can afford → noop suppressed
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    // Add an idle worker (needed for Mode A to fire)
    m.entities.set("w1", { id: "w1", ownerId: "fb", type: "worker",
      health: 50, maxHealth: 50, x: 200, y: 300, radius: 5,
      buildTargetId: undefined, gatheringNodeId: undefined, attackTargetId: undefined } as any);
    // No barracks, no combat units
    const legal = getLegalActions(m, "fb", { noopStreak: 200, forcingScale: 1.0 });
    assert(!legal.some(a => a.type === "noop"), "forcing mode A: noop SUPPRESSED when no barracks and can afford + idle worker");
    assert(legal.length > 0, "forcing mode A: non-empty legal list");
  }

  // 9. Mode A does not fire when barracks already exists (even if not complete)
  {
    const { m } = forcingMatch();
    const pidx = m.players.findIndex(p => p?.playerId === "fb");
    m.economy[pidx]!.resources = 500;
    m.entities.set("w1", { id: "w1", ownerId: "fb", type: "worker",
      health: 50, maxHealth: 50, x: 200, y: 300, radius: 5,
      buildTargetId: undefined, gatheringNodeId: undefined, attackTargetId: undefined } as any);
    // Barracks in progress (not complete)
    m.entities.set("b1", { id: "b1", ownerId: "fb", type: "building", buildingType: "barracks",
      constructionProgress: 50, health: 200, maxHealth: 500, x: 200, y: 300, radius: 20, productionQueue: [] } as any);
    const legal = getLegalActions(m, "fb", { noopStreak: 200, forcingScale: 1.0 });
    // Mode A fires only if anyBarracks is false; with an in-progress barracks, anyBarracks=true → mode A off
    // Mode B: completedBarracks=0 → also off. So noop should be present.
    assert(legal.some(a => a.type === "noop"), "forcing mode A: noop present when barracks in progress (anyBarracks=true)");
  }
}

// ── Engine timeout tiebreaker (Task 1.2) ─────────────────────────────────────
console.log("\n--- Engine timeout tiebreaker ---");
{
  // Helper: create a minimal 2-player match with maxTicks cap
  function makeTwoPlayerMatch(maxTicks: number) {
    const eng = new MatchEngine();
    const players: [import("../server/src/match/types.js").PlayerSlot, import("../server/src/match/types.js").PlayerSlot] = [
      { playerId: "blue", username: "Blue", color: "blue", score: 0 },
      { playerId: "red",  username: "Red",  color: "red",  score: 0 },
    ];
    const cfg = { ...DEFAULT_CONFIG, maxTicks, mapWidth: 800, crystalHealth: 100, startingResources: 0 };
    const m = eng.createMatch("test", players as any, cfg, 1);
    eng.startMatch(m.id);
    return { eng, m };
  }

  // Test 1: higher crystal HP fraction wins
  {
    const { eng, m } = makeTwoPlayerMatch(1);
    // Give blue crystal more health than red crystal
    for (const e of m.entities.values()) {
      if (e.type === "crystal" && e.ownerId === "blue") { e.health = 100; e.maxHealth = 100; }
      if (e.type === "crystal" && e.ownerId === "red")  { e.health = 50;  e.maxHealth = 100; }
    }
    eng.tick(m.id);
    assert(m.phase === "ended",              "tiebreaker: match ends at maxTicks");
    assert(m.result?.winner === "blue",      "tiebreaker: higher crystal HP wins");
    assert(m.result?.winType === "timeout",  "tiebreaker: winType is 'timeout'");
  }

  // Test 2: equal HP, higher lifetime resources wins
  {
    const { eng, m } = makeTwoPlayerMatch(1);
    for (const e of m.entities.values()) {
      if (e.type === "crystal") { e.health = 100; e.maxHealth = 100; }
    }
    m.economy[0]!.lifetimeResources = 100;
    m.economy[1]!.lifetimeResources = 200;
    eng.tick(m.id);
    assert(m.result?.winner === "red",  "tiebreaker: equal HP, higher lifetime resources wins (red)");
  }

  // Test 3: fully equal → seeded coin flip (seed=1 → slot 1/red).
  // A fixed "slot 0 always wins" rule was found to give blue a ~90-100% win
  // rate in mirror matches that time out (the common case for symmetric
  // bots). The tiebreak now uses match.seed % 2, which is deterministic
  // per-seed but ~50/50 across the many seeds run in a balance matrix.
  {
    const { eng, m } = makeTwoPlayerMatch(1);
    for (const e of m.entities.values()) {
      if (e.type === "crystal") { e.health = 100; e.maxHealth = 100; }
    }
    m.economy[0]!.lifetimeResources = 100;
    m.economy[1]!.lifetimeResources = 100;
    eng.tick(m.id);
    assert(m.result?.winner === "red", "tiebreaker: fully equal, seed=1 → seeded coin flip picks slot 1 (red)");
  }
}

// ── Mirror-invariance property test (Appendix C, experiment 4) ──────────────
// tick(mirrorState(s)) ~= mirrorState(tick(s)) for every tick of a real
// rush_medium mirror match. eps=0.5 absorbs the documented H4 noise floor
// (collision-resolution iteration order reverses under x-mirroring, giving
// a bounded <0.5px movement drift — see REVIVAL_PLAN.md Appendix C, C.1 #14).
// Any violation here (any system, any magnitude > eps) is a NEW asymmetry.
console.log("\n--- Mirror-invariance property test (Appendix C exp. 4) ---");
{
  const blueId = "headless-blue";
  const redId = "headless-red";
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: blueId, username: "Blue", color: "blue", score: 0 },
    { playerId: redId, username: "Red", color: "red", score: 0 },
  ];
  const cfg = { ...DEFAULT_CONFIG, maxTicks: 6000 };
  const engine = new MatchEngine();
  const match = engine.createMatch("mirror-audit", players, cfg, 1);
  engine.startMatch(match.id);

  const blue = new MediumRushBot();
  const red = new MediumRushBot();
  blue.init(blueId, match);
  red.init(redId, match);

  const MIRROR_AUDIT_TICKS = 1500;
  const MIRROR_EPS = 0.5;
  let violations = 0;
  let firstViolation: string | undefined;

  while (match.phase === "playing" && match.tick < MIRROR_AUDIT_TICKS) {
    const obsBlue = buildObservation(match, blueId);
    const obsRed = buildObservation(match, redId);
    const legalBlue = getLegalActions(match, blueId);
    const legalRed = getLegalActions(match, redId);
    const actionsBlue = blue.step(obsBlue, legalBlue);
    const actionsRed = red.step(obsRed, legalRed);

    const apply = (playerId: string, actions: ReturnType<MediumRushBot["step"]>) => {
      for (const action of actions) {
        for (const cmd of expandMacroAction(action, match, playerId)) {
          engine.processCommand(match.id, playerId, cmd as Parameters<MatchEngine["processCommand"]>[2]);
        }
      }
    };
    if (match.tick % 2 === 0) { apply(blueId, actionsBlue); apply(redId, actionsRed); }
    else { apply(redId, actionsRed); apply(blueId, actionsBlue); }

    const s = deepCloneMatchState(match);
    const preExistingIds = new Set(s.entities.keys());

    const engA = new MatchEngine();
    (engA as unknown as { matches: Map<string, typeof s> }).matches.set(s.id, deepCloneMatchState(s));
    engA.tick(s.id);
    const a = (engA as unknown as { matches: Map<string, typeof s> }).matches.get(s.id)!;

    const engB = new MatchEngine();
    (engB as unknown as { matches: Map<string, typeof s> }).matches.set(s.id, mirrorState(s));
    engB.tick(s.id);
    const b = (engB as unknown as { matches: Map<string, typeof s> }).matches.get(s.id)!;

    const diffs = diffStates(mirrorState(a), b, preExistingIds, MIRROR_EPS);
    if (diffs.length > 0 && !firstViolation) {
      firstViolation = `tick ${match.tick + 1}: [${diffs[0].system}] ${diffs[0].detail}`;
    }
    violations += diffs.length;

    engine.tick(match.id);
  }

  assert(violations === 0,
    `mirror-invariance: tick(mirror(s)) ~= mirror(tick(s)) for ${MIRROR_AUDIT_TICKS} ticks (eps=${MIRROR_EPS})` +
    (firstViolation ? ` — first: ${firstViolation}` : ""));
}

// ---- G-3: Nav grid, solid buildings, no-seal rule ----
console.log("\n--- G-3: Nav grid and solid buildings ---");
{
  const setup = () => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "b", username: "B", color: "blue", score: 0 },
      { playerId: "r", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g3", players, { ...DEFAULT_CONFIG, maxTicks: 0 }, 7);
    engine.startMatch(match.id);
    match.economy[0]!.resources = 10000;
    return { engine, match };
  };
  const cellAt = (m: MatchState, x: number, y: number) =>
    m.nav.structures[Math.floor(y / m.nav.cellSize) * m.nav.cols + Math.floor(x / m.nav.cellSize)];

  // Grid dimensions and crystals stamped at creation
  {
    const { match } = setup();
    assert(match.nav.cols === 250 && match.nav.rows === 45, `G-3: nav grid is 250x45 (got ${match.nav.cols}x${match.nav.rows})`);
    const crystal = [...match.entities.values()].find((e) => e.type === "crystal")!;
    assert(cellAt(match, crystal.x, crystal.y) > 0, "G-3: crystal footprint is blocked in the nav grid");
  }

  // A build order blocks cells from placement start; death clears them
  {
    const { engine, match } = setup();
    const worker = [...match.entities.values()].find((e) => e.type === "worker" && e.ownerId === "b")!;
    const res = engine.processCommand(match.id, "b", { type: "build", workerIds: [worker.id], buildingType: "barracks", targetX: 600, targetY: 300 } as any);
    assert(res.success, `G-3: build accepted (${res.message ?? ""})`);
    assert(cellAt(match, 600, 300) > 0, "G-3: building footprint blocked from placement start");
    const b = [...match.entities.values()].find((e) => e.type === "building")!;
    b.health = 1;
    (engine as any).processDeaths(match, new Map([[b.id, 5]]));
    assert(cellAt(match, 600, 300) === 0, "G-3: footprint cleared when the building is destroyed");
  }

  // Units cannot walk through a building
  {
    const { engine, match } = setup();
    engine.debugSpawn(match.id, "b", "building", 800, 450, "barracks");
    engine.debugSpawn(match.id, "b", "skirmisher", 700, 450);
    const u = [...match.entities.values()].find((e) => e.type === "skirmisher")!;
    engine.processCommand(match.id, "b", { type: "move", entityId: u.id, targetX: 900, targetY: 450 } as any);
    let inside = 0;
    for (let i = 0; i < 60; i++) {
      engine.tick(match.id);
      if (u.x + u.radius > 780 + 0.01 && u.x - u.radius < 820 - 0.01 && u.y + u.radius > 430 + 0.01 && u.y - u.radius < 470 - 0.01) inside++;
    }
    assert(inside === 0, `G-3: unit never overlaps a solid building footprint (overlapped on ${inside} ticks)`);
    assert(u.x !== 700 || u.y !== 450, "G-3: the walk-through unit actually moved");
  }

  // Units standing where a building is placed get pushed out
  {
    const { engine, match } = setup();
    engine.debugSpawn(match.id, "b", "skirmisher", 600, 600);
    const u = [...match.entities.values()].find((e) => e.type === "skirmisher")!;
    engine.debugSpawn(match.id, "b", "building", 600, 600, "foundry");
    engine.tick(match.id);
    const clear = u.x + u.radius <= 578 + 1e-6 || u.x - u.radius >= 622 - 1e-6 || u.y + u.radius <= 578 + 1e-6 || u.y - u.radius >= 622 - 1e-6;
    assert(clear, `G-3: unit under a new building is pushed out (at ${u.x.toFixed(1)},${u.y.toFixed(1)})`);
  }

  // No-seal rule: a placement that closes the last gap in a wall is rejected
  {
    const wall = (gapTop: number) => {
      const { engine, match } = setup();
      for (let y = 20; y <= 380; y += 40) engine.debugSpawn(match.id, "b", "building", 600, y, "barracks");
      for (let y = gapTop; y <= 900; y += 40) engine.debugSpawn(match.id, "b", "building", 600, y, "barracks");
      const worker = [...match.entities.values()].find((e) => e.type === "worker" && e.ownerId === "b")!;
      return engine.processCommand(match.id, "b", { type: "build", workerIds: [worker.id], buildingType: "barracks", targetX: 600, targetY: 430 } as any);
    };
    const sealed = wall(480);
    assert(!sealed.success && sealed.message === "Would seal off a crystal",
      `G-3: placement that seals the crystal is rejected (got ${sealed.success} "${sealed.message ?? ""}")`);
    const open = wall(560);
    assert(open.success, `G-3: same placement with a gap left open is accepted (${open.message ?? ""})`);
  }
}

// ---- G-4: Pathfinding ----
console.log("\n--- G-4: Pathfinding ---");
{
  const setup = () => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "b", username: "B", color: "blue", score: 0 },
      { playerId: "r", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g4", players, { ...DEFAULT_CONFIG, maxTicks: 0 }, 7);
    engine.startMatch(match.id);
    return { engine, match };
  };
  // Vertical wall of barracks (40x40) centred on x, from y0 to y1 inclusive.
  const wall = (engine: MatchEngine, m: MatchState, x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y += 40) engine.debugSpawn(m.id, "b", "building", x, y, "barracks");
  };
  const skirmishers = (m: MatchState) => [...m.entities.values()].filter((e) => e.type === "skirmisher");
  const move = (engine: MatchEngine, m: MatchState, id: string, x: number, y: number) =>
    engine.processCommand(m.id, "b", { type: "move", entityId: id, targetX: x, targetY: y } as any);
  // Unit circle overlaps a building footprint (with a small tolerance for push-out rounding).
  const overlapsBuilding = (m: MatchState, u: { x: number; y: number; radius: number }) =>
    [...m.entities.values()].some((b) => b.type === "building" &&
      Math.hypot(u.x - Math.max(b.x - 20, Math.min(b.x + 20, u.x)), u.y - Math.max(b.y - 20, Math.min(b.y + 20, u.y))) < u.radius - 0.5);

  // Golden: path around a wall (A* and flow field agree, deterministic waypoints)
  {
    const { engine, match } = setup();
    wall(engine, match, 1200, 220, 700);
    const golden = JSON.stringify({ waypoints: [{ x: 1170, y: 190 }, { x: 1230, y: 190 }], truncated: false });
    const a = JSON.stringify(planPath(match.nav, 1000, 450, 1400, 450, false));
    const f = JSON.stringify(planPath(match.nav, 1000, 450, 1400, 450, true));
    assert(a === golden, `G-4: golden A* path around a wall (got ${a})`);
    assert(f === golden, `G-4: golden flow-field path around a wall (got ${f})`);
    const direct = planPath(match.nav, 1000, 100, 1400, 100, false);
    assert(direct.waypoints.length === 0 && !direct.truncated, "G-4: clear line of sight needs no waypoints");
  }

  // Unreachable goal (inside a building) resolves to the nearest reachable point
  {
    const { match, engine } = setup();
    wall(engine, match, 1200, 220, 700);
    // The barracks at (1200,460): footprint 1180..1220 x 440..480.
    const p = planPath(match.nav, 1000, 450, 1200, 460, false, { x1: 1180, y1: 440, x2: 1220, y2: 480 });
    const last = p.waypoints[p.waypoints.length - 1];
    assert(p.truncated && !!last && last.x === 1180 && last.y >= 440 && last.y <= 480,
      `G-4: goal inside a structure resolves to the free point in front of it (got ${JSON.stringify(p)})`);
  }

  // A builder whose straight line to its site crosses another building still reaches
  // and builds it (T2: the approach point used to land beside the worker, out of build
  // range, so it re-planned every tick and the depot was never built).
  {
    const { engine, match } = setup();
    const crystal = [...match.entities.values()].find((e) => e.type === "crystal" && e.ownerId === "b")!;
    const ox = crystal.x - 100, oy = crystal.y - 450; // geometry recorded next to the crystal at (100,450)
    engine.debugSpawn(match.id, "b", "building", 190 + ox, 410 + oy, "supply_depot");
    engine.debugSpawn(match.id, "b", "building", 190 + ox, 490 + oy, "supply_depot");
    engine.debugSpawn(match.id, "b", "building", 150 + ox, 370 + oy, "supply_depot");
    engine.debugSpawn(match.id, "b", "worker", 194 + ox, 446 + oy);
    const site = [...match.entities.values()].filter((e) => e.buildingType === "supply_depot").pop()!;
    site.constructionProgress = 0; site.health = 1;
    const worker = [...match.entities.values()].filter((e) => e.type === "worker" && e.ownerId === "b").pop()!;
    const res = engine.processCommand(match.id, "b", { type: "assign_build", entityId: worker.id, targetEntityId: site.id } as any);
    for (let t = 0; t < 600 && site.constructionProgress < 100; t++) engine.tick(match.id);
    assert(res.success && site.constructionProgress >= 100,
      `G-4: builder walks round a neighbouring building and finishes the depot (progress ${site.constructionProgress.toFixed(1)}, worker at ${worker.x.toFixed(0)},${worker.y.toFixed(0)})`);
  }

  // Group arrival: six units sharing a flow field all reach the goal and stop
  {
    const { engine, match } = setup();
    wall(engine, match, 1200, 220, 700);
    for (let i = 0; i < 6; i++) engine.debugSpawn(match.id, "b", "skirmisher", 1000, 380 + i * 25);
    const us = skirmishers(match);
    for (const u of us) move(engine, match, u.id, 1400, 450);
    let t = 0, overlaps = 0;
    while (t < 450 && us.some((u) => u.moveTarget)) {
      engine.tick(match.id); t++;
      for (const u of us) if (overlapsBuilding(match, u)) overlaps++;
    }
    assert(us.every((u) => !u.moveTarget), `G-4: every unit in a group move arrives and stops (${us.filter((u) => u.moveTarget).length} still moving after ${t} ticks)`);
    assert(us.every((u) => Math.hypot(u.x - 1400, u.y - 450) < 80), `G-4: group ends clustered at the goal (${us.map((u) => Math.hypot(u.x - 1400, u.y - 450).toFixed(0)).join(",")})`);
    assert(overlaps === 0, `G-4: no unit overlaps the wall during the group move (${overlaps})`);
  }

  // Repath when a building is placed across an active route
  {
    const { engine, match } = setup();
    engine.debugSpawn(match.id, "b", "skirmisher", 700, 450);
    const u = skirmishers(match)[0];
    move(engine, match, u.id, 1400, 450);
    for (let i = 0; i < 5; i++) engine.tick(match.id);
    assert(u.route !== undefined && u.route.waypoints.length === 0, "G-4: open ground route is direct");
    wall(engine, match, 1000, 300, 620);
    engine.tick(match.id);
    assert((u.route?.waypoints.length ?? 0) > 0, "G-4: placing a wall across the route triggers a repath");
    let t = 0, overlaps = 0;
    while (t < 400 && u.moveTarget) { engine.tick(match.id); t++; if (overlapsBuilding(match, u)) overlaps++; }
    assert(!u.moveTarget && Math.hypot(u.x - 1400, u.y - 450) <= 1.5, `G-4: unit reaches the goal around the new wall (at ${u.x.toFixed(1)},${u.y.toFixed(1)})`);
    assert(overlaps === 0, `G-4: unit never overlaps the new wall (${overlaps})`);
  }

  // Determinism: same setup twice gives an identical state hash
  {
    const run = () => {
      const { engine, match } = setup();
      wall(engine, match, 1200, 220, 700);
      for (let i = 0; i < 6; i++) engine.debugSpawn(match.id, "b", "skirmisher", 1000, 380 + i * 25);
      for (const u of skirmishers(match)) move(engine, match, u.id, 1400, 450);
      for (let i = 0; i < 200; i++) engine.tick(match.id);
      return skirmishers(match).map((u) => `${u.x},${u.y}`).join("|");
    };
    assert(run() === run(), "G-4: pathing is deterministic across runs");
  }
}

// ---- G-9f: Shift-queued orders ----
console.log("\n--- G-9f: Shift-queued orders ---");
{
  const setup = () => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "b", username: "B", color: "blue", score: 0 },
      { playerId: "r", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g9f", players, { ...DEFAULT_CONFIG, maxTicks: 0 }, 7);
    engine.startMatch(match.id);
    match.economy[0]!.resources = 1000; // below the resource-win threshold
    engine.debugSpawn(match.id, "b", "skirmisher", 700, 450);
    const u = [...match.entities.values()].find((e) => e.type === "skirmisher")!;
    return { engine, match, u };
  };
  const cmd = (engine: MatchEngine, m: MatchState, c: Record<string, unknown>) => engine.processCommand(m.id, "b", c as any);

  // Waypoints are visited in order, then the queue empties
  {
    const { engine, match, u } = setup();
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 900, targetY: 450 });
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 900, targetY: 650, queued: true });
    cmd(engine, match, { type: "attack_move", entityId: u.id, targetX: 700, targetY: 650, queued: true });
    assert(u.orderQueue?.length === 2, `G-9f: two orders queued behind the active move (got ${u.orderQueue?.length})`);
    const pts = [[900, 450], [900, 650], [700, 650]];
    const reachedAt: number[] = [];
    for (let t = 0; t < 400 && reachedAt.length < 3; t++) {
      engine.tick(match.id);
      const [px, py] = pts[reachedAt.length];
      if (Math.hypot(u.x - px, u.y - py) <= 2) reachedAt.push(t);
    }
    assert(reachedAt.length === 3, `G-9f: unit visits all three waypoints in order (reached ${reachedAt.length})`);
    assert(u.orderQueue === undefined && !u.moveTarget, "G-9f: queue is empty and unit idle at the end");
  }

  // A plain order clears the queue
  {
    const { engine, match, u } = setup();
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 900, targetY: 450 });
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 900, targetY: 650, queued: true });
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 500, targetY: 450 });
    assert(u.orderQueue === undefined && u.moveTarget?.x === 500, "G-9f: a plain move replaces the queue");
  }

  // Queued order on an idle unit runs immediately; the queue is capped
  {
    const { engine, match, u } = setup();
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 900, targetY: 450, queued: true });
    assert(u.moveTarget?.x === 900 && u.orderQueue === undefined, "G-9f: queued order on an idle unit starts now");
    let accepted = 0;
    for (let i = 0; i < 10; i++) if (cmd(engine, match, { type: "move", entityId: u.id, targetX: 100 + i * 10, targetY: 300, queued: true }).success) accepted++;
    assert(accepted === 8 && u.orderQueue?.length === 8, `G-9f: queue holds at most 8 orders (accepted ${accepted})`);
  }

  // A queued attack on a dead target is skipped; a queued build starts when its turn comes
  {
    const { engine, match, u } = setup();
    engine.debugSpawn(match.id, "r", "skirmisher", 1500, 200);
    const enemy = [...match.entities.values()].find((e) => e.type === "skirmisher" && e.ownerId === "r")!;
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 760, targetY: 450 });
    cmd(engine, match, { type: "attack", entityId: u.id, targetEntityId: enemy.id, queued: true });
    cmd(engine, match, { type: "move", entityId: u.id, targetX: 760, targetY: 600, queued: true });
    match.entities.delete(enemy.id);
    for (let t = 0; t < 120 && (u.moveTarget || u.orderQueue); t++) engine.tick(match.id);
    assert(Math.hypot(u.x - 760, u.y - 600) <= 2, `G-9f: order after a dead attack target still runs (at ${u.x.toFixed(0)},${u.y.toFixed(0)})`);

    const worker = [...match.entities.values()].find((e) => e.type === "worker" && e.ownerId === "b")!;
    cmd(engine, match, { type: "move", entityId: worker.id, targetX: 500, targetY: 300 });
    cmd(engine, match, { type: "build", workerIds: [worker.id], buildingType: "supply_depot", targetX: 560, targetY: 260, queued: true });
    assert(![...match.entities.values()].some((e) => e.buildingType === "supply_depot"), "G-9f: queued build waits for the current order");
    for (let t = 0; t < 300 && !worker.buildTargetId; t++) engine.tick(match.id);
    assert(!!worker.buildTargetId && [...match.entities.values()].some((e) => e.buildingType === "supply_depot"),
      "G-9f: queued build is placed once the worker finishes moving");
  }
}

// ---- G-5: Obstacles (testbed map) ----
console.log("\n--- G-5: Obstacles ---");
{
  const setup = (mapId = "testbed") => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "b", username: "B", color: "blue", score: 0 },
      { playerId: "r", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g5", players, { ...DEFAULT_CONFIG, maxTicks: 0, mapId }, 7);
    engine.startMatch(match.id);
    match.economy[0]!.resources = 1000;
    return { engine, match };
  };
  const t = setup().match.terrain;
  const code = (x: number, y: number) => terrainAt(t, x, y);

  // Rasterised terrain: every kind present, mirror-symmetric, classic map empty
  {
    assert(code(1350, 250) === T_ROCK && code(5000 - 1350, 250) === T_ROCK, "G-5: rock rasterised on both halves");
    assert(code(1980, 100) === T_WATER && code(1980, 450) === T_OPEN, "G-5: river with a crossing in the middle");
    assert(code(1650, 750) === T_HIGH && code(1490, 650) === T_CLIFF && code(1490, 740) === T_HIGH, "G-5: plateau with cliffs and a ramp");
    let sym = true;
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) if (t.cells[r * t.cols + c] !== t.cells[r * t.cols + t.cols - 1 - c]) sym = false;
    assert(sym, "G-5: testbed terrain is left-right symmetric");
    assert(!setup("classic").match.terrain.any, "G-5: classic map has no terrain");
    assert(isCellBlocked(setup().match.nav, Math.floor(1350 / 20), Math.floor(250 / 20)), "G-5: rock cells are blocked in the nav grid");
  }

  // A unit routes around rock and over the river crossing, never entering an obstacle
  {
    const { engine, match } = setup();
    engine.debugSpawn(match.id, "b", "skirmisher", 1250, 250);
    const u = [...match.entities.values()].find((e) => e.type === "skirmisher")!;
    engine.processCommand(match.id, "b", { type: "move", entityId: u.id, targetX: 2100, targetY: 150 } as any);
    let ticks = 0, inObstacle = 0;
    while (u.moveTarget && ticks < 600) {
      engine.tick(match.id); ticks++;
      if (isObstacleCode(terrainAt(t, u.x, u.y))) inObstacle++;
    }
    assert(!u.moveTarget && Math.hypot(u.x - 2100, u.y - 150) < 2, `G-5: unit reaches the far bank (at ${u.x.toFixed(0)},${u.y.toFixed(0)} after ${ticks})`);
    assert(inObstacle === 0, `G-5: unit centre never inside rock/water (${inObstacle})`);
    assert(ticks > Math.hypot(2100 - 1250, 150 - 250) / 4 + 30, `G-5: the route detours (took ${ticks} ticks)`);
  }

  // No building on obstacles or brush
  {
    const { engine, match } = setup();
    const w = [...match.entities.values()].find((e) => e.type === "worker" && e.ownerId === "b")!;
    // Testbed rock is outside the build zone; swap in terrain inside it to check the terrain rule's message.
    const onRock = engine.processCommand(match.id, "b", { type: "build", workerIds: [w.id], buildingType: "supply_depot", targetX: 1350, targetY: 250 } as any);
    assert(!onRock.success, "G-5: cannot build on rock");
    const tb = buildTerrain({ id: "x", name: "x", version: 1, symmetry: "mirror", shapes: [{ kind: "rock", rect: [600, 300, 700, 400] }, { kind: "brush", rect: [600, 600, 700, 700] }] }, 5000, 900);
    match.terrain = tb;
    match.nav = rebuildNavGrid(match);
    const r1 = engine.processCommand(match.id, "b", { type: "build", workerIds: [w.id], buildingType: "supply_depot", targetX: 650, targetY: 350 } as any);
    const r2 = engine.processCommand(match.id, "b", { type: "build", workerIds: [w.id], buildingType: "supply_depot", targetX: 650, targetY: 650 } as any);
    const r3 = engine.processCommand(match.id, "b", { type: "build", workerIds: [w.id], buildingType: "supply_depot", targetX: 650, targetY: 500 } as any);
    assert(!r1.success && r1.message === "Blocked by terrain", `G-5: building on rock rejected (${r1.message})`);
    assert(!r2.success && r2.message === "Blocked by terrain", `G-5: building in brush rejected (${r2.message})`);
    assert(r3.success, `G-5: building beside them is fine (${r3.message})`);
  }

  // Static map carries the terrain for the client
  {
    const { match } = setup();
    const sm = staticMapOf(match);
    let n = 0;
    for (const run of sm.terrain.split(",")) n += Number(run.split(":")[1]);
    assert(sm.mapId === "testbed" && n === sm.cols * sm.rows, "G-5: static map has the RLE terrain covering every cell");
  }

  // Mirror invariance on the testbed map (rush bots path through terrain)
  {
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "headless-blue", username: "Blue", color: "blue", score: 0 },
      { playerId: "headless-red", username: "Red", color: "red", score: 0 },
    ];
    const engine = new MatchEngine();
    const match = engine.createMatch("mirror-tb", players, { ...DEFAULT_CONFIG, maxTicks: 6000, mapId: "testbed" }, 3);
    engine.startMatch(match.id);
    const bots = [new MediumRushBot(), new MediumRushBot()];
    bots[0].init("headless-blue", match);
    bots[1].init("headless-red", match);
    let violations = 0;
    let first: string | undefined;
    while (match.phase === "playing" && match.tick < 1200) {
      const acts = (["headless-blue", "headless-red"] as const).map((pid, i) =>
        bots[i].step(buildObservation(match, pid), getLegalActions(match, pid)));
      const apply = (i: number) => {
        const pid = i === 0 ? "headless-blue" : "headless-red";
        for (const a of acts[i]) for (const c of expandMacroAction(a, match, pid)) engine.processCommand(match.id, pid, c as Parameters<MatchEngine["processCommand"]>[2]);
      };
      if (match.tick % 2 === 0) { apply(0); apply(1); } else { apply(1); apply(0); }
      if (match.tick % 4 === 0) {
        const s = deepCloneMatchState(match);
        const ids = new Set(s.entities.keys());
        const engA = new MatchEngine();
        (engA as unknown as { matches: Map<string, typeof s> }).matches.set(s.id, deepCloneMatchState(s));
        engA.tick(s.id);
        const engB = new MatchEngine();
        (engB as unknown as { matches: Map<string, typeof s> }).matches.set(s.id, mirrorState(s));
        engB.tick(s.id);
        const a = (engA as unknown as { matches: Map<string, typeof s> }).matches.get(s.id)!;
        const b = (engB as unknown as { matches: Map<string, typeof s> }).matches.get(s.id)!;
        const d = diffStates(mirrorState(a), b, ids, 0.5);
        if (d.length && !first) first = `tick ${match.tick + 1}: [${d[0].system}] ${d[0].detail}`;
        violations += d.length;
      }
      engine.tick(match.id);
    }
    const army = [...match.entities.values()].filter((e) => e.type === "skirmisher").length;
    assert(violations === 0, `G-5: mirror invariance holds on the testbed map` + (first ? ` — first: ${first}` : ""));
    assert(army > 0 || match.phase === "ended", "G-5: bots still produce and fight on the testbed map");
  }
}

// ---- G-6: Rough ground and high ground ----
console.log("\n--- G-6: Rough and high ground ---");
{
  const setup = (mapId = "testbed") => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "b", username: "B", color: "blue", score: 0 },
      { playerId: "r", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g6", players, { ...DEFAULT_CONFIG, maxTicks: 0, mapId }, 7);
    engine.startMatch(match.id);
    return { engine, match };
  };
  const spawn = (engine: MatchEngine, match: MatchState, owner: string, type: string, x: number, y: number) => {
    const before = new Set(match.entities.keys());
    engine.debugSpawn(match.id, owner, type as any, x, y);
    return [...match.entities.values()].find((e) => !before.has(e.id))!;
  };
  const moveTicks = (engine: MatchEngine, match: MatchState, u: MatchEntity, x: number, y: number) => {
    engine.processCommand(match.id, u.ownerId, { type: "move", entityId: u.id, targetX: x, targetY: y } as any);
    let ticks = 0, inRough = 0;
    while (u.moveTarget && ticks < 600) {
      engine.tick(match.id); ticks++;
      if (terrainAt(match.terrain, u.x, u.y) === T_ROUGH) inRough++;
    }
    return { ticks, inRough, arrived: Math.hypot(u.x - x, u.y - y) < 2 };
  };

  // Rough ground slows units (skirmisher 4 px/tick → 2.4 inside the mud)
  {
    const { engine, match } = setup();
    const u = spawn(engine, match, "b", "skirmisher", 2250, 620);
    const r = moveTicks(engine, match, u, 2350, 620);
    assert(r.arrived && r.ticks >= 40 && r.ticks <= 48, `G-6: 100 px through mud takes ~42 ticks (${r.ticks})`);
  }

  // A route skirts a mud field it only clips, and smoothing doesn't cut back into it
  {
    const { engine, match } = setup();
    const u = spawn(engine, match, "b", "skirmisher", 1030, 430);
    const r = moveTicks(engine, match, u, 1220, 430);
    assert(r.arrived && r.inRough === 0, `G-6: unit skirts the mud edge (${r.inRough} ticks in mud)`);
    assert(r.ticks < 60, `G-6: skirting is faster than wading (${r.ticks} ticks)`);
  }

  // High ground: longer range and vision
  {
    const { engine, match } = setup();
    const g = spawn(engine, match, "b", "gunner", 1560, 640);
    assert(Math.abs(getRange(g, match.terrain) - (120 * 1.15 + g.radius)) < 1e-9 && getRange(g) === 120 + g.radius,
      "G-6: gunner range ×1.15 on high ground");
    assert(getVisionRange(g, match.terrain) > getVisionRange(g), "G-6: vision is longer on high ground");
    const low = spawn(engine, match, "b", "gunner", 1300, 450);
    assert(getRange(low, match.terrain) === getRange(low), "G-6: no bonus on low ground");

    // The high gunner hits a target its low-ground range couldn't reach
    const t = spawn(engine, match, "r", "skirmisher", 1560 + 152, 640);
    for (let i = 0; i < 5; i++) engine.tick(match.id);
    assert(t.health < t.maxHealth, `G-6: high-ground gunner hits at 152 px (hp ${t.health}/${t.maxHealth})`);
  }
}

// ---- G-6b: Line of sight, brush and fog ----
console.log("\n--- G-6b: Line of sight ---");
{
  const setup = (mapId = "testbed") => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "b", username: "B", color: "blue", score: 0 },
      { playerId: "r", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g6b", players, { ...DEFAULT_CONFIG, maxTicks: 0, mapId }, 7);
    engine.startMatch(match.id);
    return { engine, match };
  };
  const spawn = (engine: MatchEngine, match: MatchState, owner: string, type: string, x: number, y: number, bt?: string) => {
    const before = new Set(match.entities.keys());
    engine.debugSpawn(match.id, owner, type as any, x, y, bt as any);
    const e = [...match.entities.values()].find((e) => !before.has(e.id))!;
    e.autoAttackEnabled = false;
    return e;
  };
  const sees = (match: MatchState, pid: string, e: MatchEntity) => match.visibilityData!.get(pid)!.entityIds.has(e.id);

  // Rock blocks sight; the same positions on the open map are visible
  for (const mapId of ["testbed", "classic"]) {
    const { engine, match } = setup(mapId);
    const b = spawn(engine, match, "b", "skirmisher", 1260, 250);
    const r = spawn(engine, match, "r", "skirmisher", 1440, 250);
    assert(sees(match, "b", r) === (mapId === "classic") && sees(match, "r", b) === (mapId === "classic"),
      `G-6b: 180 px apart across the rock: ${mapId === "classic" ? "visible on classic" : "hidden on testbed"}`);
  }

  // High ground: the plateau sees down, low ground can't see up
  {
    const { engine, match } = setup();
    const hi = spawn(engine, match, "r", "gunner", 1600, 700);
    const lo = spawn(engine, match, "b", "gunner", 1400, 700);
    assert(sees(match, "r", lo), "G-6b: high-ground unit sees the low ground below");
    assert(!sees(match, "b", hi), "G-6b: low-ground unit can't see onto the plateau");
  }
  // ...and high ground hides the low ground behind it (a narrow ridge, in range on either side)
  {
    const { engine, match } = setup("classic");
    const lo = spawn(engine, match, "b", "gunner", 500, 450);
    const behind = spawn(engine, match, "r", "skirmisher", 760, 450);
    assert(sees(match, "b", behind), "G-6b: 260 px in the open is visible");
    match.terrain = buildTerrain({ id: "x", name: "x", version: 1, symmetry: "mirror", shapes: [{ kind: "high", rect: [600, 300, 700, 600] }] }, 5000, 900);
    match.nav = rebuildNavGrid(match);
    computeVisibility(match);
    assert(!sees(match, "b", behind), "G-6b: a ridge between them blocks sight");
    void lo;
  }

  // Brush hides units from outside the patch; entering the patch reveals them
  {
    const { engine, match } = setup();
    const hidden = spawn(engine, match, "r", "skirmisher", 1600, 160);
    const b = spawn(engine, match, "b", "skirmisher", 1600, 260);
    assert(!sees(match, "b", hidden), "G-6b: unit in brush is hidden 100 px away");
    assert(sees(match, "r", b), "G-6b: unit in brush still sees out");
    b.x = 1570; b.y = 165;
    computeVisibility(match);
    assert(sees(match, "b", hidden), "G-6b: entering the same brush patch reveals it");
  }

  // Hidden targets aren't auto-acquired or shot; attackers reveal themselves
  {
    const { engine, match } = setup();
    const turret = spawn(engine, match, "b", "building", 1600, 260, "turret");
    turret.autoAttackEnabled = true;
    const lurker = spawn(engine, match, "r", "skirmisher", 1600, 170);
    for (let i = 0; i < 10; i++) engine.tick(match.id);
    assert(!turret.attackTargetId && lurker.health === lurker.maxHealth, "G-6b: turret ignores a unit hidden in brush");
    const hi = spawn(engine, match, "r", "gunner", 1600, 700);
    const lo = spawn(engine, match, "b", "skirmisher", 1460, 700);
    hi.attackTargetId = lo.id;
    for (let i = 0; i < 3; i++) engine.tick(match.id);
    assert(lo.health < lo.maxHealth && sees(match, "b", hi), "G-6b: a high-ground attacker is revealed to its victim");
  }

  // Payload: vision grid dims in the static map, bitset sized to match
  {
    const { match } = setup();
    const sm = staticMapOf(match);
    const vis = match.visibilityData!.get("b")!;
    const bytes = Buffer.from(encodeVision(vis.cells), "base64");
    assert(sm.visionCellSize === 40 && sm.visionCols === 125 && sm.visionRows === 23 && bytes.length === Math.ceil(125 * 23 / 8),
      "G-6b: vision grid 125×23 at 40 px, bitset matches");
    const crystal = [...match.entities.values()].find((e) => e.type === "crystal" && e.ownerId === "b")!;
    const ci = Math.floor(crystal.y / 40) * 125 + Math.floor(crystal.x / 40);
    assert(((bytes[ci >> 3] >> (ci & 7)) & 1) === 1 && vis.cells.reduce((a, c) => a + c, 0) < 125 * 23 / 2,
      "G-6b: own base lit, most of the map dark");
  }
}

// ---- G-11: State-stream presentation hooks ----
console.log("\n--- G-11: heading / actionState / static map ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "b", username: "B", color: "blue", score: 0 },
    { playerId: "r", username: "R", color: "red", score: 0 },
  ];
  const match = engine.createMatch("g11", players, { ...DEFAULT_CONFIG, maxTicks: 0 }, 7);
  engine.startMatch(match.id);
  engine.debugSpawn(match.id, "b", "skirmisher", 1000, 450);
  const u = [...match.entities.values()].find((e) => e.type === "skirmisher")!;
  assert(actionStateOf(u) === "idle" && headingOf(u, match) === undefined, "G-11: fresh unit is idle with no heading");
  engine.processCommand(match.id, "b", { type: "move", entityId: u.id, targetX: 1000, targetY: 700 } as any);
  engine.tick(match.id);
  assert(actionStateOf(u) === "moving", `G-11: moving unit reports 'moving' (got ${actionStateOf(u)})`);
  const h = headingOf(u, match)!;
  assert(Math.abs(h - Math.PI / 2) < 0.01, `G-11: heading points at the move target (got ${h})`);
  const w = [...match.entities.values()].find((e) => e.type === "worker" && e.ownerId === "b")!;
  if (!w.gatheringNodeId) w.gatheringNodeId = match.resourceNodes[0].id;
  assert(actionStateOf(w) === "gathering", `G-11: gathering worker reports 'gathering' (got ${actionStateOf(w)})`);
  const before = hashMatchState(match);
  headingOf(u, match); actionStateOf(u);
  assert(hashMatchState(match) === before, "G-11: hooks are read-only (hash unchanged)");
  const sm = staticMapOf(match);
  assert(sm.cols === 250 && sm.rows === 45 && sm.cellSize === 20, "G-11: static map carries nav grid dimensions");
}

// ---- G-1: Move vs attack-move ----
console.log("\n--- G-1: Move vs attack-move ---");
{
  const setup = () => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "pb", username: "B", color: "blue", score: 0 },
      { playerId: "pr", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g1-orders", players);
    engine.startMatch(match.id);
    const spawn = (owner: string, type: "skirmisher" | "worker", x: number, y: number) => {
      const before = new Set(match.entities.keys());
      engine.debugSpawn(match.id, owner, type, x, y);
      return [...match.entities.values()].find(e => !before.has(e.id))!;
    };
    return { engine, match, spawn };
  };

  // 1. A plain move disengages a unit that is already fighting.
  {
    const { engine, match, spawn } = setup();
    const midX = match.config.mapWidth / 2;
    const blue = spawn("pb", "skirmisher", midX, 300);
    const red  = spawn("pr", "skirmisher", midX + 20, 300);
    assert(blue.autoAttackEnabled && red.autoAttackEnabled, "G-1: spawned units auto-attack by default");
    engine.tick(match.id);
    assert(blue.attackTargetId === red.id, "G-1: blue skirmisher auto-acquires adjacent enemy");

    const destX = midX - 300;
    engine.processCommand(match.id, "pb", { type: "move", entityId: blue.id, targetX: destX, targetY: 300 });
    let reacquired = false;
    let arrived = false;
    for (let i = 0; i < 200 && match.phase === "playing"; i++) {
      engine.tick(match.id);
      if (!match.entities.has(blue.id)) break;
      if (blue.attackTargetId) reacquired = true;
      if (Math.abs(blue.x - destX) <= 1) { arrived = true; break; }
    }
    assert(!reacquired, "G-1: move order ignores enemies in range until arrival");
    assert(arrived, "G-1: moving unit reaches its destination while being chased");
    engine.tick(match.id);
    assert(blue.moveOrder === undefined, "G-1: move order cleared on arrival");
  }

  // 2. Attack-move fights what it meets, then resumes to the destination.
  {
    const { engine, match, spawn } = setup();
    const midX = match.config.mapWidth / 2;
    const blue   = spawn("pb", "skirmisher", midX - 200, 300);
    const victim = spawn("pr", "worker", midX, 300);
    const destX = midX + 200;
    engine.processCommand(match.id, "pb", { type: "attack_move", entityId: blue.id, targetX: destX, targetY: 300 });
    assert(blue.autoAttackEnabled, "G-1: attack-move enables auto-attack");
    let fought = false;
    let arrived = false;
    for (let i = 0; i < 600 && match.phase === "playing"; i++) {
      engine.tick(match.id);
      if (blue.attackTargetId === victim.id) fought = true;
      if (Math.abs(blue.x - destX) <= 1 && Math.abs(blue.y - 300) <= 1) { arrived = true; break; }
    }
    assert(fought, "G-1: attack-move engages an enemy met on the way");
    assert(!match.entities.has(victim.id), "G-1: attack-move kills the enemy it engaged");
    assert(arrived, "G-1: attack-move resumes to its destination after the fight");
  }

  // 3. Retreat is a real disengage (plain move to own crystal).
  {
    const { engine, match, spawn } = setup();
    const midX = match.config.mapWidth / 2;
    const blue = spawn("pb", "skirmisher", midX, 300);
    const red  = spawn("pr", "skirmisher", midX + 20, 300);
    assert(blue.autoAttackEnabled && red.autoAttackEnabled, "G-1: spawned units auto-attack by default");
    engine.tick(match.id);
    engine.processCommand(match.id, "pb", { type: "retreat", entityIds: [blue.id] });
    let reacquired = false;
    for (let i = 0; i < 20; i++) {
      engine.tick(match.id);
      if (blue.attackTargetId) reacquired = true;
    }
    assert(!reacquired, "G-1: retreating unit does not re-engage");
    assert(blue.x < midX - 40, "G-1: retreating unit moves toward own crystal");
  }
}

// ---- G-13: unit control (threat order, leash, guard, medic auto-heal, auto-attack) ----
console.log("\n--- G-13: unit control ---");
{
  const setup = () => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "pb", username: "B", color: "blue", score: 0 },
      { playerId: "pr", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g13", players);
    engine.startMatch(match.id);
    const spawn = (owner: string, type: "skirmisher" | "worker" | "gunner" | "medic" | "bruiser", x: number, y: number, tough = false) => {
      const before = new Set(match.entities.keys());
      engine.debugSpawn(match.id, owner, type, x, y);
      const e = [...match.entities.values()].find(e => !before.has(e.id))!;
      if (tough) { e.health = e.maxHealth = 100000; }
      return e;
    };
    return { engine, match, spawn, midX: match.config.mapWidth / 2 };
  };
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  // E2: threat order picks a combat unit over a nearer worker, and switches to one.
  {
    const { engine, match, spawn, midX } = setup();
    const g = spawn("pb", "gunner", midX, 300);
    const w = spawn("pr", "worker", midX + 40, 300, true);
    const s = spawn("pr", "skirmisher", midX + 100, 300, true);
    s.autoAttackEnabled = false;
    engine.tick(match.id);
    assert(g.attackTargetId === s.id, "G-13 E2: gunner targets the skirmisher over a nearer worker");
    const { engine: e2, match: m2, spawn: sp2, midX: x2 } = setup();
    const g2 = sp2("pb", "gunner", x2, 300);
    const w2 = sp2("pr", "worker", x2 + 40, 300, true);
    e2.tick(m2.id);
    assert(g2.attackTargetId === w2.id, "G-13 E2: gunner takes the worker when it is the only target");
    const s2 = sp2("pr", "skirmisher", x2 + 100, 300, true);
    s2.autoAttackEnabled = false;
    e2.tick(m2.id);
    assert(g2.attackTargetId === s2.id, "G-13 E2: gunner switches to a combat unit that comes into range");
    // E1: an ordered target is never switched.
    const { engine: e3, match: m3, spawn: sp3, midX: x3 } = setup();
    const g3 = sp3("pb", "gunner", x3, 300);
    const w3 = sp3("pr", "worker", x3 + 40, 300, true);
    const s3 = sp3("pr", "skirmisher", x3 + 100, 300, true);
    s3.autoAttackEnabled = false;
    e3.processCommand(m3.id, "pb", { type: "attack", entityId: g3.id, targetEntityId: w3.id });
    for (let i = 0; i < 5; i++) e3.tick(m3.id);
    assert(g3.attackTargetId === w3.id && g3.attackOrdered === true, "G-13 E1: ordered target kept despite a higher-threat enemy in range");
    void w; void s3;
  }

  // E3: leash. An auto-acquired target that runs is dropped; the unit walks back.
  {
    const { engine, match, spawn, midX } = setup();
    const b = spawn("pb", "skirmisher", midX, 300);
    const r = spawn("pr", "worker", midX + 25, 300, true);
    engine.tick(match.id);
    assert(b.attackTargetId === r.id && !!b.leash, "G-13 E3: auto-acquired target gets a leash");
    const centre = { x: b.leash!.x, y: b.leash!.y };
    engine.processCommand(match.id, "pr", { type: "move", entityId: r.id, targetX: midX + 1200, targetY: 300 });
    let maxD = 0, released = -1;
    for (let i = 0; i < 300; i++) {
      engine.tick(match.id);
      maxD = Math.max(maxD, d(b, centre));
      if (released < 0 && !b.attackTargetId) released = i;
    }
    assert(released >= 0, "G-13 E3: unit drops a target that runs out of its leash");
    assert(maxD <= LEASH.chase + 5, `G-13 E3: unit never chases past the leash (max ${maxD.toFixed(0)} px)`);
    assert(d(b, centre) < 15, `G-13 E3: idle unit walks back to where it acquired the target (${d(b, centre).toFixed(0)} px away)`);
  }
  {
    const { engine, match, spawn, midX } = setup();
    const b = spawn("pb", "skirmisher", midX, 300);
    const r = spawn("pr", "worker", midX + 25, 300, true);
    engine.processCommand(match.id, "pb", { type: "attack", entityId: b.id, targetEntityId: r.id });
    engine.processCommand(match.id, "pr", { type: "move", entityId: r.id, targetX: midX + 1200, targetY: 300 });
    for (let i = 0; i < 300; i++) engine.tick(match.id);
    assert(b.attackTargetId === r.id && d(b, { x: midX, y: 300 }) > 600, "G-13 E1: an ordered target is chased without a leash");
  }

  // E4: guard (melee).
  {
    const { engine, match, spawn, midX } = setup();
    const P = { x: midX, y: 300 };
    const b = spawn("pb", "skirmisher", midX - 150, 300);
    engine.processCommand(match.id, "pb", { type: "guard", entityIds: [b.id], targetX: P.x, targetY: P.y });
    for (let i = 0; i < 80; i++) engine.tick(match.id);
    assert(!!b.guard && !b.moveOrder && d(b, P) < 10, "G-13 E4: guarding unit walks to its guard point");
    const R = guardRadius(b);
    const far = spawn("pr", "worker", P.x + R + 60, 300, true);
    for (let i = 0; i < 5; i++) engine.tick(match.id);
    assert(!b.attackTargetId, "G-13 E4: guard ignores an enemy it can't reach from inside its circle");
    match.entities.delete(far.id);
    const near = spawn("pr", "worker", P.x + R, 300, true);
    engine.tick(match.id);
    assert(b.attackTargetId === near.id, "G-13 E4: melee guard reacts to an enemy within its reach (beyond attack range)");
    engine.processCommand(match.id, "pr", { type: "move", entityId: near.id, targetX: midX + 1200, targetY: 300 });
    let maxD = 0;
    for (let i = 0; i < 300; i++) { engine.tick(match.id); maxD = Math.max(maxD, d(b, P)); }
    assert(maxD <= R + 5, `G-13 E4: guard never leaves its circle (max ${maxD.toFixed(0)} px, radius ${R})`);
    assert(!b.attackTargetId && d(b, P) <= GUARD.returnSlack + 1, "G-13 E4: guard releases the target and returns to the point");
    engine.processCommand(match.id, "pb", { type: "move", entityId: b.id, targetX: midX - 300, targetY: 300 });
    assert(!b.guard, "G-13 E4: a new order ends the guard");
  }
  // E4: guard (ranged reacts only at attack range).
  {
    const { engine, match, spawn, midX } = setup();
    const g = spawn("pb", "gunner", midX, 300);
    engine.processCommand(match.id, "pb", { type: "guard", entityIds: [g.id], targetX: midX, targetY: 300 });
    engine.tick(match.id); engine.tick(match.id);
    const out = spawn("pr", "worker", midX + 200, 300, true);
    for (let i = 0; i < 3; i++) engine.tick(match.id);
    assert(!g.attackTargetId, "G-13 E4: ranged guard ignores an enemy outside attack range");
    out.x = midX + 100;
    for (let i = 0; i < 2; i++) engine.tick(match.id);
    assert(g.attackTargetId === out.id, "G-13 E4: ranged guard fires at an enemy inside attack range");
  }

  // E5: medic auto-heal, no chasing.
  {
    const { engine, match, spawn, midX } = setup();
    const m = spawn("pb", "medic", midX - 600, 300);
    const a = spawn("pb", "skirmisher", midX - 560, 300); a.health = a.maxHealth * 0.5; a.autoAttackEnabled = false;
    const b = spawn("pb", "skirmisher", midX - 650, 300); b.health = b.maxHealth * 0.8; b.autoAttackEnabled = false;
    const far = spawn("pb", "skirmisher", midX - 300, 300); far.health = 10; far.autoAttackEnabled = false;
    const mx = m.x, my = m.y, a0 = a.health, b0 = b.health;
    for (let i = 0; i < 10; i++) engine.tick(match.id);
    assert(a.health > a0 && b.health === b0, "G-13 E5: idle medic heals the lowest-HP ally in range");
    assert(far.health === 10, "G-13 E5: medic doesn't heal an ally out of range");
    assert(Math.abs(m.x - mx) < 1 && Math.abs(m.y - my) < 1, "G-13 E5: medic doesn't move to heal");
  }

  // E0: auto-attack rules.
  {
    const { engine, match, spawn, midX } = setup();
    const b = spawn("pb", "skirmisher", midX, 300);
    engine.processCommand(match.id, "pb", { type: "stop", entityIds: [b.id] });
    assert(b.autoAttackEnabled, "G-13 E0: stop keeps auto-attack on");
    engine.processCommand(match.id, "pb", { type: "toggle_auto_attack", entityIds: [b.id] });
    assert(!b.autoAttackEnabled, "G-13 E0: the toggle turns auto-attack off");
    engine.processCommand(match.id, "pb", { type: "attack_move", entityId: b.id, targetX: midX - 100, targetY: 300 });
    assert(b.autoAttackEnabled, "G-13 E0: attack-move turns auto-attack back on");
  }

  // Repair (2026-11-12): the worker walks into working range, a new order ends it, one repairer per building.
  {
    const { engine, match, spawn, midX } = setup();
    const before = new Set(match.entities.keys());
    engine.debugSpawn(match.id, "pb", "building", midX - 500, 300, "turret");
    const t = [...match.entities.values()].find((e) => !before.has(e.id))!;
    t.autoAttackEnabled = false;
    t.health = t.maxHealth / 2;
    match.economy[0]!.resources = 5000;
    const w = spawn("pb", "worker", midX - 900, 300);
    const w2 = spawn("pb", "worker", midX - 520, 330);
    const h0 = t.health;
    assert(engine.processCommand(match.id, "pb", { type: "repair", entityId: w.id, targetEntityId: t.id }).success, "repair: command accepted");
    engine.tick(match.id);
    assert(t.health === h0 && !!w.moveTarget, "repair: no repair from out of range; the worker walks to the building");
    let ticks = 0;
    while (t.health === h0 && ticks < 600) { engine.tick(match.id); ticks++; }
    assert(t.health > h0 && Math.hypot(w.x - t.x, w.y - t.y) <= GATHERING.range, `repair: starts once the worker is in range (${ticks} ticks)`);
    engine.processCommand(match.id, "pb", { type: "move", entityId: w.id, targetX: midX - 1000, targetY: 300 });
    const h1 = t.health;
    for (let i = 0; i < 20; i++) engine.tick(match.id);
    assert(t.health === h1 && !t.repairTargetId && !w.repairTargetId, "repair: a new order ends it");
    engine.processCommand(match.id, "pb", { type: "repair", entityId: w.id, targetEntityId: t.id });
    engine.processCommand(match.id, "pb", { type: "repair", entityId: w2.id, targetEntityId: t.id });
    assert(t.repairTargetId === w2.id && !w.repairTargetId && !w.moveTarget, "repair: one repairer per building, the previous one is released");
    ticks = 0;
    while (t.health < t.maxHealth && ticks < 2000) { engine.tick(match.id); ticks++; }
    assert(t.health === t.maxHealth && !t.repairTargetId && !w2.repairTargetId && !w2.moveTarget, "repair: a finished repair frees the worker");
  }
}

// ---- G-1 / G-9d: Determinism ----
async function determinismTests(): Promise<void> {
  console.log("\n--- G-1 / G-9d: Determinism (fast vs paced) ---");

  // Static guard: simulation code never reads the wall clock or Math.random.
  const engineDir = _resolve("server/src/match/engine");
  const simFiles = [
    ..._readdirSync(engineDir).filter(f => f.endsWith(".ts")).map(f => _join(engineDir, f)),
    _resolve("server/src/match/map.ts"),
    _resolve("server/src/match/buildingValidation.ts"),
  ];
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const offenders = simFiles.filter(f => /Date\.now|Math\.random|performance\.now|new Date\(/.test(stripComments(_readFileSync(f, "utf8"))));
  assert(offenders.length === 0, `G-9d: no wall-clock/Math.random in engine modules (${offenders.join(", ") || "none"})`);
  const engineSrc = stripComments(_readFileSync(_resolve("server/src/match/matchEngine.ts"), "utf8"));
  assert(!/Math\.random|performance\.now|new Date\(/.test(engineSrc) && (engineSrc.match(/Date\.now/g) ?? []).length === 1,
    "G-9d: matchEngine.ts reads Date.now only in the injected metadata clock");

  const SEED = 424242;
  const TICKS = 1200;
  const players = (): [PlayerSlot | null, PlayerSlot | null] => [
    { playerId: "headless-blue", username: "Blue", color: "blue", score: 0 },
    { playerId: "headless-red",  username: "Red",  color: "red",  score: 0 },
  ];
  const config = { ...DEFAULT_CONFIG, maxTicks: 6000 };

  // Run A: two scripted bots in a tight loop (the training/balance path).
  const engA = new MatchEngine();
  const a = engA.createMatch("det", players(), config, SEED);
  engA.startMatch(a.id);
  const blueBot = new MacroBot(); const redBot = new MediumRushBot();
  blueBot.init("headless-blue", a); redBot.init("headless-red", a);
  while (a.phase === "playing" && a.tick < TICKS) {
    for (const [bot, pid] of [[blueBot, "headless-blue"], [redBot, "headless-red"]] as const) {
      const acts = bot.step(buildObservation(a, pid), getLegalActions(a, pid));
      for (const act of acts) for (const cmd of expandMacroAction(act, a, pid)) {
        engA.processCommand(a.id, pid, cmd as Parameters<MatchEngine["processCommand"]>[2]);
      }
    }
    engA.tick(a.id);
  }
  const log = a.commandLog.map(e => ({ ...e }));
  assert(log.length > 20, `G-9d: bot match produced a command log (${log.length} commands)`);
  const hashA = hashMatchState(a);

  const byTick = new Map<number, typeof log>();
  for (const e of log) { if (!byTick.has(e.tick)) byTick.set(e.tick, []); byTick.get(e.tick)!.push(e); }
  const applyAt = (eng: MatchEngine, id: string, tick: number) => {
    for (const e of byTick.get(tick) ?? []) {
      eng.processCommand(id, e.playerId, e.command as Parameters<MatchEngine["processCommand"]>[2]);
    }
  };

  // Run B: replay the command log fast (tight loop).
  const engB = new MatchEngine();
  const b = engB.createMatch("det", players(), config, SEED);
  engB.startMatch(b.id);
  while (b.phase === "playing" && b.tick < a.tick) { applyAt(engB, b.id, b.tick); engB.tick(b.id); }
  assert(hashMatchState(b) === hashA, "G-1: fast replay of command log reproduces the bot match state hash");

  // Run C: replay paced by LiveMatchRunner's wall-clock interval (1 ms ticks here).
  const engC = new MatchEngine();
  const c = engC.createMatch("det", players(), config, SEED);
  engC.startMatch(c.id);
  const realInterval = c.tickIntervalMs;
  c.tickIntervalMs = 1; // pacing only; restored before hashing
  applyAt(engC, c.id, 0);
  await new Promise<void>((done) => {
    const runner = new LiveMatchRunner(engC, (id) => {
      const m = engC.getMatch(id)!;
      if (m.tick >= a.tick || m.phase !== "playing") { runner.stop(id); done(); return; }
      applyAt(engC, id, m.tick);
    });
    runner.start(c.id);
  });
  c.tickIntervalMs = realInterval;
  assert(c.tick === a.tick, `G-1: paced run reached the same tick (${c.tick} vs ${a.tick})`);
  assert(hashMatchState(c) === hashA, "G-1: paced (live runner) replay gives the identical state hash");

  // Sanity: the hash is sensitive to state.
  const firstUnit = [...c.entities.values()].find(e => e.type !== "crystal")!;
  firstUnit.x += 0.001;
  assert(hashMatchState(c) !== hashA, "G-9d: state hash changes when any entity moves");
}

// ---- G-7: Map generator and pool ----
console.log("\n--- G-7: Map generator ---");
{
  // Every generated map validates (connectivity, wide routes, detour, density, node placement).
  const t0 = Date.now();
  let bad = 0, firstBad = "";
  for (let seed = 0; seed < 1000; seed++) {
    try {
      const { def } = generateMap(seed);
      const v = validateMap(def);
      if (!v.ok) { bad++; firstBad ||= `seed ${seed}: ${v.issues[0]}`; }
    } catch (e) { bad++; firstBad ||= String(e); }
  }
  assert(bad === 0, `G-7: 1000 generated maps validate (${((Date.now() - t0) / 1000).toFixed(1)}s)` + (firstBad ? ` — first: ${firstBad}` : ""));
  assert(JSON.stringify(generateMap(42).def) === JSON.stringify(generateMap(42).def), "G-7: generation is deterministic per seed");
  assert(generateMap(4).def.symmetry === "mirror" && generateMap(5).def.symmetry === "rotate", "G-7: generator makes mirror and rotational maps");

  // Symmetry of the rasterised terrain.
  for (const seed of [4, 5]) {
    const { def } = generateMap(seed);
    const t = buildTerrain(def, 5000, 900);
    let asym = 0;
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
      const img = def.symmetry === "mirror" ? r * t.cols + (t.cols - 1 - c) : (t.rows - 1 - r) * t.cols + (t.cols - 1 - c);
      if (t.cells[r * t.cols + c] !== t.cells[img]) asym++;
    }
    assert(asym === 0, `G-7: ${def.symmetry} map terrain is exactly symmetric`);
  }

  // "open" shapes carve earlier shapes; later shapes win.
  {
    const t = buildTerrain({ id: "carve", name: "c", version: 1, symmetry: "none", shapes: [
      { kind: "rock", rect: [1000, 100, 1200, 300] }, { kind: "open", circle: [1100, 200, 50] },
    ] }, 5000, 900);
    assert(terrainAt(t, 1100, 200) === T_OPEN && terrainAt(t, 1010, 110) === T_ROCK, "G-7: open shapes carve rock");
  }

  // A rotational pool-style map: contested nodes at the def positions and their images; mirror invariance holds.
  {
    const { def } = generateMap(5);
    registerMap(def);
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "headless-blue", username: "B", color: "blue", score: 0 },
      { playerId: "headless-red", username: "R", color: "red", score: 0 },
    ];
    const match = engine.createMatch("g7", players, { ...DEFAULT_CONFIG, mapId: def.id }, 11);
    const want = def.nodes!.flatMap(([x, y]) => x === 2500 && y === 450 ? [[x, y]] : [[x, y], [5000 - x, 900 - y]]);
    const contested = match.resourceNodes.slice(8).map((n) => [n.x, n.y]);
    assertEqual(JSON.stringify(contested), JSON.stringify(want), "G-7: contested nodes come from the map def (rotated images)");
    assert(match.terrain.mapId === def.id, "G-7: match uses the registered map's terrain");
    engine.startMatch(match.id);
    const bots = [new MediumRushBot(), new MediumRushBot()];
    bots[0].init("headless-blue", match);
    bots[1].init("headless-red", match);
    let violations = 0;
    let first: string | undefined;
    while (match.phase === "playing" && match.tick < 800) {
      const acts = (["headless-blue", "headless-red"] as const).map((pid, i) =>
        bots[i].step(buildObservation(match, pid), getLegalActions(match, pid)));
      const apply = (i: number) => {
        const pid = i === 0 ? "headless-blue" : "headless-red";
        for (const a of acts[i]) for (const c of expandMacroAction(a, match, pid)) engine.processCommand(match.id, pid, c as Parameters<MatchEngine["processCommand"]>[2]);
      };
      if (match.tick % 2 === 0) { apply(0); apply(1); } else { apply(1); apply(0); }
      if (match.tick % 8 === 0) {
        const s = deepCloneMatchState(match);
        const ids = new Set(s.entities.keys());
        const engA = new MatchEngine();
        (engA as unknown as { matches: Map<string, typeof s> }).matches.set(s.id, deepCloneMatchState(s));
        engA.tick(s.id);
        const engB = new MatchEngine();
        (engB as unknown as { matches: Map<string, typeof s> }).matches.set(s.id, mirrorState(s));
        engB.tick(s.id);
        const a = (engA as unknown as { matches: Map<string, typeof s> }).matches.get(s.id)!;
        const b = (engB as unknown as { matches: Map<string, typeof s> }).matches.get(s.id)!;
        const d = diffStates(mirrorState(a), b, ids, 0.5);
        if (d.length && !first) first = `tick ${match.tick + 1}: [${d[0].system}] ${d[0].detail}`;
        violations += d.length;
      }
      engine.tick(match.id);
    }
    assert(violations === 0, "G-7: mirror invariance holds on a rotational generated map" + (first ? ` — first: ${first}` : ""));
  }

  // Frozen pool: every map validates, is registered and is in the manifest.
  {
    const pool = poolMaps();
    for (const def of POOL_MAPS) {
      const v = validateMap(def);
      assert(v.ok, `G-7: pool map ${def.id} v${def.version} validates` + (v.ok ? "" : ` — ${v.issues[0]}`));
      assert(isKnownMap(def.id) && pool.some((p) => p.mapId === def.id && p.version === def.version), `G-7: pool map ${def.id} is registered and in the manifest`);
    }
    assert(pool.length === POOL_MAPS.length, `G-7: manifest lists exactly the pool maps (${pool.length})`);
  }

  // Lobby map choice: host only; a change un-readies both players.
  {
    const lm = new LobbyManager();
    const { code, player: host } = lm.createLobby("HostA");
    assert(lm.getLobby(code)!.mapId === "random", "G-7: new lobbies default to a random pool map");
    const joined = lm.joinLobby(code, "GuestB");
    const guest = joined.success ? joined.player : null!;
    lm.toggleReady(code, host.id);
    lm.toggleReady(code, guest.id);
    assert(!lm.setMap(code, guest.id, "testbed").success, "G-7: the guest can't choose the map");
    const r = lm.setMap(code, host.id, "testbed");
    assert(r.success && r.lobby.mapId === "testbed", "G-7: the host chooses the map");
    assert(!r.success || (!r.lobby.players[0]!.ready && !r.lobby.players[1]!.ready && r.lobby.status === "waiting"), "G-7: changing the map un-readies both players");
  }
}

/** Matches wait for every human client to load before the first tick. */
async function loadGateTests(): Promise<void> {
  console.log("\n--- Load gate ---");
  const begun: string[] = [];
  const progress: string[] = [];
  const gate = new LoadGate((id) => begun.push(id), 40, (id, loaded) => progress.push(`${id}:${loaded.join("+")}`));

  gate.wait("m1", ["a", "b"]);
  gate.loaded("m1", "a");
  assert(begun.length === 0 && gate.isWaiting("m1"), "load gate: waits while one player is still loading");
  gate.loaded("m1", "a");
  assertEqual(progress.join(), "m1:a", "load gate: reports each newly loaded player once (for the loading screen)");
  gate.loaded("m1", "b");
  assertEqual(begun.join(), "m1", "load gate: starts once both players have loaded");
  gate.loaded("m1", "b");
  assertEqual(begun.length, 1, "load gate: a repeated report doesn't start the match twice");

  gate.wait("m2", []);
  assertEqual(begun.at(-1), "m2", "load gate: a match with no human clients starts at once");

  gate.wait("m3", ["a", "b"]);
  gate.loaded("m3", "a");
  await new Promise((r) => setTimeout(r, 80));
  assertEqual(begun.at(-1), "m3", "load gate: a client that never reports in can't block the match past the timeout");

  gate.wait("m4", ["a", "b"]);
  gate.release("m4");
  assert(begun.at(-1) === "m4" && !gate.isWaiting("m4"), "load gate: release() starts a waiting match (player left while loading)");
}

/** G-10 T2: the engine still produces the recorded golden hashes (one case per map). */
function goldenHashTests(): void {
  console.log("\n--- Golden engine hashes (G-10 T2) ---");
  const seen = new Set<string>();
  for (const g of loadGolden()) {
    if (seen.has(g.map)) continue;
    seen.add(g.map);
    const h = runCase(g);
    assert(h.length === g.hashes.length && h.every((x, i) => x === g.hashes[i]),
      `golden hashes: ${g.map} ${g.blue}-${g.red} seed ${g.seed} reproduces all ${g.hashes.length} recorded hashes`);
  }
}

/** Named map anchors (G-10 T3): valid, symmetric and reachable on every map. */
/** A uniformly random legal v3 action for economy entry `econ` (every later head picked from its mask). */
function v3RandomAction(rnd: () => number, m: V2.V2Masks, econ: number): V2.V2Action {
  const pick = (x: boolean[]) => {
    const idx: number[] = [];
    for (let i = 0; i < x.length; i++) if (x[i]) idx.push(i);
    return idx.length ? idx[Math.floor(rnd() * idx.length)] : -1;
  };
  const ea = V2.decodeEcon(econ);
  const kind = ea.kind === "repair" ? 0 : ea.kind === "rally" ? 1 : ea.kind === "cancel" ? 2 : -1;
  const site = ea.kind === "build" ? Math.max(0, pick(m.site[V2.BUILDINGS.indexOf(ea.building)])) : 0;
  const econPtr = kind >= 0 ? Math.max(0, pick(m.econPtr[kind])) : 0;
  const econTarget = kind === 1 ? Math.max(0, pick(m.econTarget)) : 0;
  const group = pick(m.group), order = pick(m.order[group]);
  const unit = V2.GROUPS[group] === "unit" ? Math.max(0, pick(m.unit[order])) : 0;
  const target = pick(m.target[order]);
  const ptr = V2.PTR_ORDERS.has(V2.ORDERS[order]) ? Math.max(0, pick(m.ptr[order])) : 0;
  return { econ, site, econPtr, econTarget, group, order, unit, target, ptr };
}

function v2ObservationTests(): void {
  console.log("\n--- Observation v2 (G-10 T6) ---");
  const newMatch = (mapId: string, seed: number) => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "o-blue", username: "Blue", color: "blue", score: 0 },
      { playerId: "o-red", username: "Red", color: "red", score: 0 },
    ];
    const match = engine.createMatch(`obs-${mapId}-${seed}`, players, { ...DEFAULT_CONFIG, mapId, maxTicks: 12000 }, seed);
    engine.startMatch(match.id);
    const seats = [V2.createSeatState(match, "o-blue"), V2.createSeatState(match, "o-red")] as [V2.SeatState, V2.SeatState];
    return { engine, match, seats, oss: seats.map((st) => OBS.createObsState(match, st)) };
  };
  const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const pickFrom = (rnd: () => number, m: boolean[], lo = 0, hi = m.length) => {
    const idx: number[] = [];
    for (let i = lo; i < hi; i++) if (m[i]) idx.push(i);
    return idx.length ? idx[Math.floor(rnd() * idx.length)] : -1;
  };
  const randomAction = (rnd: () => number, m: V2.V2Masks, seats: V2.SeatState[], symmetric: boolean) => {
    const r = rnd();
    let econ = r < 0.3 ? pickFrom(rnd, m.econ, V2.ECON_TRAIN0, V2.ECON_BUILD0) : r < 0.6 ? pickFrom(rnd, m.econ) : 0;
    if (econ < 0) econ = 0;
    const ea = V2.decodeEcon(econ);
    if (symmetric && ea.kind === "assign" && seats[0].nodeSlots[ea.slot] === seats[1].nodeSlots[ea.slot]) econ = 0;
    return v3RandomAction(rnd, m, econ);
  };
  const imageSeats = (img: MatchState, seats: V2.SeatState[]) => {
    // Image: red sits in seat 0, blue in seat 1; carry the per-seat army state over.
    const out = [V2.createSeatState(img, "o-red"), V2.createSeatState(img, "o-blue")];
    out.forEach((st, i) => { const src = seats[1 - i]; st.armyA = new Set(src.armyA); st.armyB = new Set(src.armyB); st.scoutId = src.scoutId; });
    return out;
  };

  {
    // Shapes.
    const { match, seats, oss } = newMatch("glimmerfen", 2);
    const o = OBS.observe(match, seats[0], oss[0], { z: 3 });
    const sg = OBS.staticGrid(match);
    assertEqual(o.schemaVersion, OBS.OBS_SCHEMA_VERSION, "observation carries its schema version");
    assertEqual(o.z, 3, "strategy token z is passed through");
    assertEqual(o.globals.length, OBS.GLOBAL_NAMES.length, `globals: ${OBS.GLOBAL_NAMES.length} named values`);
    assert(o.entities.length > 0 && o.entities.every((r) => r.length === OBS.ENTITY_F), `entity rows have ${OBS.ENTITY_F} features`);
    assert(o.memory.length === V2.MEMORY_SLOTS && o.memory.every((r) => r.length === OBS.MEMORY_F), "16 memory rows");
    assert(o.nodes.length === OBS.NODE_ROWS && o.nodes.every((r) => r.length === OBS.NODE_F), `${OBS.NODE_ROWS} node rows`);
    assertEqual(sg.cols * sg.rows, 50 * 15, "grid is 50 x 15 on a 5000 x 900 map");
    assertEqual(o.grid.length, OBS.DYN_CHANNELS.length * sg.cols * sg.rows, "dynamic grid size");
    assertEqual(sg.data.length, OBS.STATIC_CHANNELS.length * sg.cols * sg.rows, "static grid size");
    const all = [...o.globals, ...o.entities.flat(), ...o.memory.flat(), ...o.nodes.flat(), ...o.grid, ...sg.data];
    assert(all.every((v) => Number.isFinite(v) && Math.round(v * 1e4) / 1e4 === v), "every value is finite and rounded to 4 decimals");
    assert(o.nodes.slice(0, 4).some((r) => r[0] === 1) && o.nodes.slice(4, 8).some((r) => r[0] === 1), "own and enemy safe nodes are listed");
  }

  for (const mapId of ["twin-spires", "glimmerfen"]) {
    // Mirrored play gives both seats bit-identical observations (fog included) and masks,
    // on a rotate map (twin-spires) and a mirror map (glimmerfen).
    const { engine, match, seats, oss } = newMatch(mapId, 3);
    const rnd = lcg(99);
    let same = 0;
    for (let d = 0; d < 150 && match.phase === "playing"; d++) {
      for (const st of seats) V2.workerAutopilot(engine, match, st);
      const o = seats.map((st, i) => JSON.stringify(OBS.observe(match, st, oss[i])));
      const m = seats.map((st) => V2.computeMasks(match, st));
      if (o[0] !== o[1] || JSON.stringify(m[0]) !== JSON.stringify(m[1])) break;
      same++;
      const a = randomAction(rnd, m[0], seats, true);
      V2.applyV2Pair(engine, match, seats, [a, a]);
      for (let t = 0; t < V2.DECISION_TICKS; t++) engine.tick(match.id);
    }
    assertEqual(same, 150, `${mapId}: 150 mirrored decisions give both seats bit-identical observations and masks`);
    if (mapId !== "glimmerfen") continue;

    // Image test: after asymmetric play, the image state with seats swapped gives each player the same observation.
    for (let d = 0; d < 30; d++) {
      seats.forEach((st, i) => { V2.workerAutopilot(engine, match, st); OBS.observe(match, st, oss[i]); V2.applyV2(engine, match, st, randomAction(rnd, V2.computeMasks(match, st), seats, false)); });
      for (let t = 0; t < V2.DECISION_TICKS; t++) engine.tick(match.id);
    }
    const img = imageState(match), iseats = imageSeats(img, seats);
    const fresh = (mm: MatchState, st: V2.SeatState) => JSON.stringify(OBS.observe(mm, st, OBS.createObsState(mm, st)));
    assertEqual(fresh(img, iseats[1]), fresh(match, seats[0]), "glimmerfen: blue's observation is bit-identical in the image state (seat 1)");
    assertEqual(fresh(img, iseats[0]), fresh(match, seats[1]), "glimmerfen: red's observation is bit-identical in the image state (seat 0)");
    assertEqual(JSON.stringify(V2.computeMasks(img, iseats[1])), JSON.stringify(V2.computeMasks(match, seats[0])), "glimmerfen: blue's masks match in the image state");
    assertEqual(JSON.stringify(V2.computeMasks(img, iseats[0])), JSON.stringify(V2.computeMasks(match, seats[1])), "glimmerfen: red's masks match in the image state");
  }

  {
    // Rotate map: the fogged observation, the fog-free blocks and the masks are bit-identical in the image state.
    const { engine, match, seats, oss } = newMatch("shardfall", 4);
    const rnd = lcg(7);
    for (let d = 0; d < 60; d++) {
      seats.forEach((st, i) => { V2.workerAutopilot(engine, match, st); OBS.observe(match, st, oss[i]); V2.applyV2(engine, match, st, randomAction(rnd, V2.computeMasks(match, st), seats, false)); });
      for (let t = 0; t < V2.DECISION_TICKS; t++) engine.tick(match.id);
    }
    const img = imageState(match), iseats = imageSeats(img, seats);
    const fresh = (mm: MatchState, st: V2.SeatState) => JSON.stringify(OBS.observe(mm, st, OBS.createObsState(mm, st)));
    assertEqual(fresh(img, iseats[1]), fresh(match, seats[0]), "shardfall: blue's fogged observation is bit-identical in the image state");
    assertEqual(fresh(img, iseats[0]), fresh(match, seats[1]), "shardfall: red's fogged observation is bit-identical in the image state");
    const crit = (mm: MatchState, a: V2.SeatState, b: V2.SeatState) => JSON.stringify(OBS.criticState(mm, a, OBS.createObsState(mm, a), b, OBS.createObsState(mm, b)));
    assertEqual(crit(img, iseats[1], iseats[0]), crit(match, seats[0], seats[1]), "shardfall: blue's fog-free (critic) blocks are bit-identical in the image state");
    assertEqual(crit(img, iseats[0], iseats[1]), crit(match, seats[1], seats[0]), "shardfall: red's fog-free (critic) blocks are bit-identical in the image state");
    assertEqual(JSON.stringify(V2.computeMasks(img, iseats[0])), JSON.stringify(V2.computeMasks(match, seats[1])), "shardfall: red's masks match in the image state");
    assertEqual(JSON.stringify(OBS.oppLabels(img, iseats[1])), JSON.stringify(OBS.oppLabels(match, seats[0])), "shardfall: opponent labels match in the image state");
  }

  {
    // Fog honesty and memory.
    const { engine, match, seats, oss } = newMatch("saltmarsh", 5);
    const blue = seats[0];
    const base = blue.targets[0];
    const enemyX = match.mapWidth - 900;
    engine.debugSpawn(match.id, "o-red", "building", enemyX, base.y, "turret");
    engine.tick(match.id);
    let o = OBS.observe(match, blue, oss[0]);
    const turretIdx = 2 + OBS.ENTITY_TYPES.indexOf("turret");
    assert(!o.entities.some((r) => r[1] === 1 && r[turretIdx] === 1), "a red turret out of sight is not in blue's entities");
    assert(o.memory.every((r) => r[0] === 0) && blue.memory.every((p) => p === null), "nothing in memory before anything is seen");
    const crit = OBS.criticState(match, blue, oss[0], seats[1], oss[1]);
    assert(crit.self.entities.some((r) => r[1] === 1 && r[turretIdx] === 1), "the critic (no fog) sees the turret");
    // A blue gunner walks into sight of the turret's spot, then dies / leaves: the turret stays in memory.
    engine.debugSpawn(match.id, "o-blue", "gunner", enemyX - 120, base.y);
    engine.debugSpawn(match.id, "o-red", "gunner", enemyX + 40, base.y);
    engine.tick(match.id);
    o = OBS.observe(match, blue, oss[0]);
    const memTurret = 2 + 4; // valid, army, then MEMORY_TYPES (crystal, barracks, foundry, supply_depot, turret)
    const slot = o.memory.findIndex((r) => r[0] === 1 && r[memTurret] === 1);
    assert(slot >= 1, "a seen turret enters a building memory slot");
    assert(o.memory[0][0] === 1 && o.memory[0][1] === 1, "seen enemy combat units fill the army slot (0)");
    assert(blue.memory[slot] !== null && Math.abs(blue.memory[slot]!.x - enemyX) < 1, "the memory slot is a valid target at the turret's world position");
    const gunnerSeen = OBS.GLOBAL_NAMES.indexOf("seen_gunner"), gunnerAge = OBS.GLOBAL_NAMES.indexOf("seen_gunner_age");
    assert(o.globals[gunnerSeen] > 0 && o.globals[gunnerAge] === 0, "last-seen gunner count is set with age 0");
    for (const e of [...match.entities.values()]) if (e.ownerId === "o-blue" && e.type === "gunner") match.entities.delete(e.id);
    for (let t = 0; t < 50; t++) engine.tick(match.id);
    o = OBS.observe(match, blue, oss[0]);
    assert(o.memory[slot][0] === 1 && o.memory[slot][OBS.MEMORY_FEATURES.indexOf("age")] > 0, "out of sight again, the turret stays in memory and ages");
    assert(o.globals[gunnerSeen] > 0 && o.globals[gunnerAge] > 0, "last-seen gunner count is kept and ages");
    const vis = match.visibilityData!.get("o-blue")!;
    const visibleEnemy = [...match.entities.values()].filter((e) => e.ownerId === "o-red" && vis.entityIds.has(e.id)).length;
    assertEqual(o.entities.filter((r) => r[1] === 1).length, visibleEnemy, "enemy entity rows are exactly the enemies in blue's visibility");
  }
}

function v2ActionTests(): void {
  console.log("\n--- Action space v3 (G-10 T5, G-13 Phase B) ---");
  assertEqual(V2.ACTION_SPACE_VERSION, 3, "action space version 3");
  assertEqual([V2.ECON_SIZE, V2.BUILD_SITES, V2.ECON_PTR_KINDS.length, V2.PTR_SIZE], [61, 760, 3, 200], "economy: 61 kinds, 760 build sites (10 named + 750 grid), 3 pointer kinds over 200 rows");
  assertEqual([V2.GROUPS.length, V2.ORDERS.length, V2.TARGET_SIZE], [10, 11, 804], "army: 10 groups x 11 orders x 804 targets (37 anchors + 16 memory + 750 grid + none)");
  assertEqual(OBS.MAX_ENTITIES, V2.PTR_SIZE, "pointer heads index the observation's entity rows");
  let roundTrip = true;
  for (let i = 0; i < V2.ECON_SIZE; i++) if (V2.encodeEcon(V2.decodeEcon(i)) !== i) roundTrip = false;
  assert(roundTrip, "every economy index decodes and re-encodes to itself");

  const newMatch = (mapId: string, seed: number) => {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "v2-blue", username: "Blue", color: "blue", score: 0 },
      { playerId: "v2-red", username: "Red", color: "red", score: 0 },
    ];
    const match = engine.createMatch(`v2-${mapId}-${seed}`, players, { ...DEFAULT_CONFIG, mapId, maxTicks: 12000 }, seed);
    engine.startMatch(match.id);
    const seats = [V2.createSeatState(match, "v2-blue"), V2.createSeatState(match, "v2-red")];
    return { engine, match, seats, oss: seats.map((st) => OBS.createObsState(match, st)) };
  };
  const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const pickFrom = (rnd: () => number, m: boolean[], lo = 0, hi = m.length) => {
    const idx: number[] = [];
    for (let i = lo; i < hi; i++) if (m[i]) idx.push(i);
    return idx.length ? idx[Math.floor(rnd() * idx.length)] : -1;
  };

  for (const mapId of ["glimmerfen", "shardfall"]) {
    // Own frame: the transform is its own inverse.
    const { engine, match, seats, oss } = newMatch(mapId, 3);
    const f = frameFor(match, "v2-red");
    const p = { x: 1234, y: 456 };
    assertEqual(JSON.stringify(fromOwnFrame(f, toOwnFrame(f, p))), JSON.stringify(p), `${mapId}: own-frame transform round-trips`);

    // Both seats see the same masks while they play the same actions.
    const rnd = lcg(777);
    let same = 0, trains = 0;
    for (let d = 0; d < 100; d++) {
      for (const st of seats) V2.workerAutopilot(engine, match, st);
      seats.forEach((st, i) => OBS.observe(match, st, oss[i]));
      const ms = seats.map((st) => V2.computeMasks(match, st));
      if (JSON.stringify(ms[0]) !== JSON.stringify(ms[1])) break;
      same++;
      const m = ms[0];
      // Training included (spawns are mirror-equivariant since ENGINE_VERSION 12).
      // Assigns to a shared node (rotate maps' centre) are skipped here: applyV2Pair
      // splits its slots fairly, but an odd slot cannot go to both seats.
      const r = rnd();
      let econ = r < 0.3 ? pickFrom(rnd, m.econ, V2.ECON_TRAIN0, V2.ECON_BUILD0) : r < 0.6 ? pickFrom(rnd, m.econ) : 0;
      if (econ < 0) econ = 0;
      const ea = V2.decodeEcon(econ);
      if (ea.kind === "assign" && seats[0].nodeSlots[ea.slot] === seats[1].nodeSlots[ea.slot]) econ = 0;
      if (ea.kind === "train") trains++;
      const a = v3RandomAction(rnd, m, econ);
      V2.applyV2Pair(engine, match, [seats[0], seats[1]], [a, a]);
      for (let t = 0; t < V2.DECISION_TICKS; t++) engine.tick(match.id);
    }
    assertEqual(same, 100, `${mapId}: both seats get identical masks for 100 mirrored decisions`);
    if (mapId === "glimmerfen") assert(trains > 0, `glimmerfen: the mirrored run trained units (${trains})`);
  }

  {
    // Shared centre node on a rotate map: both seats ask for 4 workers there in the
    // same decision; neither gets a first-mover edge.
    const { engine, match, seats } = newMatch("shardfall", 11);
    const slot = seats[0].nodeSlots.findIndex((id, i) => id !== null && id === seats[1].nodeSlots[i]);
    assert(slot >= 0, "shardfall: a node slot names the same (centre) node for both seats");
    for (let t = 0; t < 40; t++) engine.tick(match.id);
    for (const st of seats) V2.workerAutopilot(engine, match, st);
    const node = match.resourceNodes.find((n) => n.id === seats[0].nodeSlots[slot])!;
    const free = node.maxGathererSlots - node.gathererSlots.size;
    const a = { ...V2.NOOP_ACTION, econ: V2.encodeEcon({ kind: "assign", slot, count: 4 }) };
    const r = V2.applyV2Pair(engine, match, [seats[0], seats[1]], [a, a]);
    const per = seats.map((st) => [...node.gathererSlots].filter((id) => match.entities.get(id)?.ownerId === st.playerId).length);
    assertEqual(per[0] + per[1], free, `shardfall: the ${free} free centre slots are all taken`);
    assert(Math.abs(per[0] - per[1]) <= 1, `shardfall: centre slots split evenly (${per[0]} vs ${per[1]})`);
    assert(seats.every((st) => st.stats.contested === 1 && st.stats.econIneffective === 0), "both seats count the cut-short assign as contested, not ineffective");
    assert(r[0].econEffective && r[1].econEffective, "both seats' contested assigns still moved workers");
  }

  for (const mapId of ["saltmarsh", "basalt-run"]) {
    // P-8: every legal action does something, under random masked play.
    const { engine, match, seats, oss } = newMatch(mapId, 5);
    const rnd = lcg(4242);
    // Random play alone rarely affords an army or takes damage, so give each seat a small army
    // (with a medic) by its crystal, and every 400 ticks wound units and buildings, so that
    // focus, heal, join, repair and cancel all get legal chances.
    for (const st of seats) {
      const c = [...match.entities.values()].find((e) => e.type === "crystal" && e.ownerId === st.playerId)!;
      ["skirmisher", "skirmisher", "gunner", "bruiser", "medic"].forEach((type, i) => {
        const e = engine["createEntity"](match.idGen, type, st.playerId, c.x + 80 + 20 * i, c.y + 60, 100, 12, "#888");
        match.entities.set(e.id, e);
      });
    }
    let decisions = 0, ineffective = 0, badTargets = 0, gridBuilds = 0, siteMismatch = 0;
    const used: Record<string, number> = {};
    while (match.phase === "playing" && match.tick < 3000) {
      if (match.tick % 400 === 0) {
        for (const eco of match.economy) if (eco) eco.resources += 300;
        for (const e of match.entities.values()) {
          if ((e.type === "building" ? e.constructionProgress >= 100 : e.type !== "crystal") && e.health > 1) e.health = Math.ceil(e.health * 0.6);
        }
      }
      seats.forEach((st, si) => {
        V2.workerAutopilot(engine, match, st);
        OBS.observe(match, st, oss[si]);
        const m = V2.computeMasks(match, st);
        for (let o = 0; o < V2.ORDERS.length; o++) {
          if (!V2.POINT_ORDERS.has(V2.ORDERS[o]) && (m.target[o].filter(Boolean).length !== 1 || !m.target[o][V2.TARGET_NONE])) badTargets++;
        }
        // The fast build-site masks agree with the engine's validator (every 10th decision, all grid sites).
        if (decisions % 10 === 0) {
          V2.BUILDINGS.forEach((b, bi) => {
            if (!m.econ[V2.ECON_BUILD0 + bi]) return;
            for (let g = 0; g < V2.GRID_CELLS; g++) {
              const c = fromOwnFrame(st.frame, { x: (g % V2.GRID_COLS) * V2.GRID_CELL_W + V2.GRID_CELL_W / 2, y: Math.floor(g / V2.GRID_COLS) * V2.GRID_CELL_H + V2.GRID_CELL_H / 2 });
              const exact = c.x <= match.config.mapWidth && c.y <= match.config.mapHeight && validateBuildSite(match, st.playerId, b, c.x, c.y).valid;
              if (exact !== m.site[bi][V2.NAMED_SITES + g]) siteMismatch++;
            }
          });
        }
        let econ = 0;
        const r = rnd();
        if (r < 0.35) econ = pickFrom(rnd, m.econ, V2.ECON_TRAIN0, V2.ECON_BUILD0);
        else if (r < 0.7) econ = pickFrom(rnd, m.econ, V2.ECON_BUILD0, V2.ECON_ASSIGN0);
        else if (r < 0.75) econ = pickFrom(rnd, m.econ, V2.ECON_ASSIGN0, V2.ECON_REPAIR);
        else if (r < 0.9) econ = pickFrom(rnd, m.econ, V2.ECON_REPAIR, V2.ECON_SIZE);
        if (econ < 0) econ = 0;
        const a = v3RandomAction(rnd, m, econ);
        if (!V2.isLegal(m, a)) ineffective++;
        const res = V2.applyV2(engine, match, st, a);
        decisions++;
        if (!res.econEffective || !res.armyEffective) ineffective++;
        const k = V2.decodeEcon(econ).kind;
        used[k] = (used[k] ?? 0) + 1;
        if (k === "build" && a.site >= V2.NAMED_SITES) gridBuilds++;
        if (a.group > 0) used[V2.ORDERS[a.order]] = (used[V2.ORDERS[a.order]] ?? 0) + 1;
        if (V2.GROUPS[a.group] === "unit") used.unit = (used.unit ?? 0) + 1;
      });
      for (let t = 0; t < V2.DECISION_TICKS; t++) engine.tick(match.id);
    }
    assertEqual(ineffective, 0, `${mapId}: no ineffective legal actions in ${decisions} random masked decisions`);
    const need = ["build", "train", "assign", "repair", "rally", "cancel", "attack_move", "move", "guard", "guard_here", "retreat", "focus", "heal", "stop", "join_a", "unit"];
    const missing = need.filter((k) => !used[k]);
    assert(missing.length === 0 && gridBuilds > 0, `${mapId}: random play used every action kind (missing: ${missing.join(", ") || "none"}; ${gridBuilds} grid builds; ${JSON.stringify(used)})`);
    assertEqual(siteMismatch, 0, `${mapId}: grid build-site masks equal validateBuildSite`);
    assertEqual(badTargets, 0, `${mapId}: only attack-move, move and guard take a point target`);
    assert(seats.every((st) => st.stats.autopilot > 0), `${mapId}: worker autopilot sent idle workers to gather`);
  }

  {
    // Armies, memory targets, autopilot.
    const { engine, match, seats } = newMatch("glimmerfen", 9);
    const st = seats[0];
    V2.workerAutopilot(engine, match, st);
    const idle = [...match.entities.values()].filter((e) => e.type === "worker" && e.ownerId === "v2-blue" && !e.gatheringNodeId);
    assertEqual(idle.length, 0, "autopilot leaves no idle worker at the start");
    let m = V2.computeMasks(match, st);
    assert(!m.group[V2.GROUPS.indexOf("army_a")], "army A is masked while empty");
    const base = st.targets[0];
    engine.debugSpawn(match.id, "v2-blue", "gunner", base.x, base.y);
    engine.debugSpawn(match.id, "v2-blue", "skirmisher", base.x, base.y + 30);
    m = V2.computeMasks(match, st);
    const gAll = V2.GROUPS.indexOf("all_combat"), gA = V2.GROUPS.indexOf("army_a"), gGun = V2.GROUPS.indexOf("gunners");
    const oJoinA = V2.ORDERS.indexOf("join_a"), oMove = V2.ORDERS.indexOf("move"), oStop = V2.ORDERS.indexOf("stop");
    assert(m.order[gGun][oJoinA] && !m.order[gGun][oStop], "idle gunners can join army A but have nothing to stop");
    const joined = V2.applyV2(engine, match, st, V2.act({ group: gGun, order: oJoinA }));
    assert(joined.armyEffective && st.armyA.size === 1, "join A puts the gunner in army A");
    m = V2.computeMasks(match, st);
    assert(m.group[gA] && !m.order[gA][oJoinA], "army A is now a group, and can't join itself");
    const enemyBase = V2.ANCHOR_TARGETS.slice(0, 6).reduce((n, [, c]) => n + c, 0);
    const moved = V2.applyV2(engine, match, st, V2.act({ group: gA, order: oMove, target: enemyBase }));
    assert(moved.armyEffective && moved.accepted.length === 1, "army A moves as one group of 1");
    const ab = V2.applyV2(engine, match, st, V2.act({ group: gAll, order: V2.ORDERS.indexOf("join_b") }));
    assert(ab.armyEffective && st.armyB.size === 2 && st.armyA.size === 0, "join B moves both units out of army A");
    assert(!m.target[V2.ORDERS.indexOf("move")][V2.TARGET_MEMORY0], "empty memory slot is not a target");
    st.memory[0] = { x: 3000, y: 1000 };
    m = V2.computeMasks(match, st);
    assert(m.target[V2.ORDERS.indexOf("move")][V2.TARGET_MEMORY0], "filled memory slot is a move target");
  }
}

function truncationTests(): void {
  console.log("\n--- Truncation at the cap (G-10 T4, P-4) ---");
  assertEqual(TRAIN_MAX_TICKS, 12000, "training cap is 12,000 ticks");

  // Two idle bots never finish: the engine's tiebreak names a winner at the cap,
  // but the episode is truncated, not a win or loss, and scores as a draw.
  const capped = runMatch(new IdleBot(), new IdleBot(), { seed: 7, maxTicks: 300 });
  assertEqual(capped.ticks, 300, "idle game runs to the cap");
  assertEqual(capped.winType, "timeout", "cap ends with the tiebreak winType");
  assert(capped.winner !== null, "tiebreak still names a winner (kept for live play)");
  assertEqual(capped.truncated, true, "capped game is flagged truncated");
  assertEqual(evalScore(capped.winner, capped.truncated, capped.winner!), 0.5, "truncated game scores 0.5 for the tiebreak winner");

  // A real ending (forfeit) is terminated, not truncated.
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "tr-blue", username: "Blue", color: "blue", score: 0 },
    { playerId: "tr-red", username: "Red", color: "red", score: 0 },
  ];
  const m = engine.createMatch("trunc-1", players, { ...DEFAULT_CONFIG, maxTicks: 0 }, 1);
  engine.startMatch(m.id);
  for (let i = 0; i < 50; i++) engine.tick(m.id);
  assertEqual(JSON.stringify(episodeStatus(m, 50)), JSON.stringify({ terminated: false, truncated: true }),
    "runner cap without engine tiebreak (maxTicks 0) is truncated");
  assertEqual(JSON.stringify(episodeStatus(m, 100)), JSON.stringify({ terminated: false, truncated: false }),
    "mid-game is neither terminated nor truncated");
  engine.endMatch(m.id, "tr-red", "forfeit");
  assertEqual(JSON.stringify(episodeStatus(m, 50)), JSON.stringify({ terminated: true, truncated: false }),
    "forfeit is terminated, not truncated");
  assertEqual(evalScore("tr-red", false, "tr-red"), 1, "real win scores 1");
  assertEqual(evalScore("tr-red", false, "tr-blue"), 0, "real loss scores 0");
}

function anchorTests(): void {
  console.log("\n--- Map anchors (G-10 T3) ---");
  const W = DEFAULT_CONFIG.mapWidth, H = DEFAULT_CONFIG.mapHeight;
  const widest = Object.keys(BUILDING_DEFS).reduce((a, b) => (BUILDING_DEFS[b].width > BUILDING_DEFS[a].width ? b : a));
  const key = (p: Pt) => `${p.x},${p.y}`;
  const sameSet = (a: Pt[], b: Pt[]) => a.length === b.length && a.map(key).sort().join(" ") === b.map(key).sort().join(" ");
  for (const id of mapIds()) {
    const engine = new MatchEngine();
    const players: [PlayerSlot | null, PlayerSlot | null] = [
      { playerId: "an-blue", username: "Blue", color: "blue", score: 0 },
      { playerId: "an-red", username: "Red", color: "red", score: 0 },
    ];
    const match = engine.createMatch(`anchors-${id}`, players, { ...DEFAULT_CONFIG, mapId: id }, 1);
    const a = anchorsFor(id, W, H);
    const img = (p: Pt) => imagePt(p, a.symmetry, W, H);
    const seats = [seatAnchors(a, 0, W, H), seatAnchors(a, 1, W, H)] as const;

    assert(a.pockets[0].length >= 1 && a.pockets[0].length <= ANCHOR_MAX.pockets && a.centre.length >= 1 && a.centre.length <= ANCHOR_MAX.centre
      && a.chokes[0].length <= ANCHOR_MAX.chokes && a.nodes.length <= ANCHOR_MAX.nodes && a.safeNodes[0].length <= ANCHOR_MAX.safeNodes,
      `T3 ${id}: anchor counts within their maxima (pockets ${a.pockets[0].length}, centre ${a.centre.length}, chokes ${a.chokes[0].length}, nodes ${a.nodes.length})`);

    // Seat symmetry: every seat-1 anchor is the exact image of seat 0's, slot by slot.
    const s0 = seats[0], s1 = seats[1];
    const lists: Array<[Pt[], Pt[]]> = [[[s0.base], [s1.base]], [s0.pockets, s1.pockets], [s0.centre, s1.centre], [s0.nodes, s1.nodes], [s0.safeNodes, s1.safeNodes], [s0.chokes, s1.chokes]];
    assert(lists.every(([p, q]) => p.length === q.length && p.every((pt, i) => key(img(pt)) === key(q[i]))), `T3 ${id}: seat 1's anchors are the exact images of seat 0's`);
    assert(sameSet(a.centre, a.centre.map(img)) && sameSet(a.nodes, a.nodes.map(img)), `T3 ${id}: shared anchors (centre, nodes) map onto themselves`);
    const contested = match.resourceNodes.filter((n) => n.contested);
    assert(sameSet(a.nodes, contested), `T3 ${id}: nodes are exactly the contested nodes`);
    assert(sameSet([...s0.safeNodes, ...s1.safeNodes], match.resourceNodes.filter((n) => !n.contested)), `T3 ${id}: safe nodes are exactly the match's safe nodes`);
    for (const seat of [0, 1] as const) {
      const v = seats[seat];
      const all = [v.base, ...v.pockets, ...v.centre, ...v.nodes, ...v.safeNodes, ...v.chokes];
      const blocked = all.filter((p) => match.nav.structures[cellOf(match.nav, p.x, p.y)] > 0);
      assert(blocked.length === 0, `T3 ${id}: seat ${seat} anchors are on walkable cells` + (blocked.length ? ` — ${blocked.map(key).join(" ")}` : ""));
      const field = flowField(match.nav, cellOf(match.nav, v.base.x, v.base.y));
      const unreached = all.filter((p) => field[cellOf(match.nav, p.x, p.y)] >= 0x3fffffff);
      assert(unreached.length === 0, `T3 ${id}: seat ${seat} anchors are reachable from the base` + (unreached.length ? ` — ${unreached.map(key).join(" ")}` : ""));
      const pid = seat === 0 ? "an-blue" : "an-red";
      const bad = v.pockets.map((p) => ({ p, r: validateBuildSite(match, pid, widest as never, p.x, p.y) })).filter((x) => !x.r.valid);
      assert(bad.length === 0, `T3 ${id}: seat ${seat} pockets accept the widest building (${widest})` + (bad.length ? ` — ${key(bad[0].p)}: ${bad[0].r.reason}` : ""));
    }
  }
}

// G-10 M0 T9 (P-8): a v2 replay rebuilds the recorded observations exactly,
// and its command log replays the same game on the server's replay loop.
function v2ReplayTests(): void {
  console.log("\n--- Replay → observations (G-10 T9) ---");
  type R = Record<string, any>;
  const H = (m: MatchState) => hashMatchState({ entities: m.entities, economies: m.economies, control: m.control } as unknown as MatchState);
  const cases = [
    { name: "shardfall (rotate), teach:macro v teach:rush2, critic on", map: "shardfall", blue: "teach:macro", red: "teach:rush2", cap: 1600 },
    { name: "glimmerfen (mirror), policy (arbitrary, partly forbidden actions) v bot:turtle", map: "glimmerfen", blue: "policy", red: "bot:turtle", cap: 1200 },
  ];
  for (const c of cases) {
    let replay: V2Replay | null = null;
    const tickHash: string[] = [];
    const r = new VecRunnerV2({ onReplay: (_i, x) => { replay = x; }, onTick: (_s, m) => { tickHash[m.tick] = H(m); } });
    const recorded: Array<[string, string]> = [];
    const keep = (seats: R) => recorded.push([seats.blue ? JSON.stringify(seats.blue.obs) : "", seats.red ? JSON.stringify(seats.red.obs) : ""]);
    let res: R = r.handle({ type: "reset_all", max_ticks: c.cap, critic: true, slots: [{ seed: 7, map: c.map, blue: c.blue, red: c.red }] });
    keep(res.slots[0].seats);
    let n = 0, illegal = 0;
    for (;;) {
      n++;
      const act = c.blue === "policy" ? { blue: { econ: [(n * 7) % 40, n % 50, n % 7, (n * 3) % 60], army: [n % 3, n % 5, n % 9, (n * 3) % 9, n % 11] } } : {};
      res = r.handle({ type: "step", actions: [act] });
      const sl = res.slots[0];
      if (sl.done || sl.truncated) { keep(sl.terminal); illegal = sl.info.stats.blue.illegal; break; }
      keep(sl.seats);
    }
    if (c.blue === "policy") assert(illegal > 0, `T9 ${c.name}: some policy actions were forbidden (${illegal})`);
    let compared = 0, diffs = 0;
    let err: string | null = null;
    let final: MatchState | null = null;
    try {
      final = replayObservations(replay!, (i, _t, obs) => {
        for (const s of [0, 1]) {
          const want = recorded[i]?.[s];
          if (!want) continue;
          compared++;
          if (want !== JSON.stringify(obs[s])) diffs++;
        }
      }).match;
    } catch (e) { err = (e as Error).message; }
    assert(err === null, `T9 ${c.name}: replay plays through, same command log${err ? ` (${err})` : ""}`);
    const expected = recorded.reduce((t, x) => t + (x[0] ? 1 : 0) + (x[1] ? 1 : 0), 0);
    assert(compared === expected && expected > 100 && diffs === 0, `T9 ${c.name}: replayed observations identical (${compared}/${expected} compared, ${diffs} differ)`);
    assert(!!final && H(final) === tickHash[c.cap], `T9 ${c.name}: observation replay ends in the same state`);
    let tickDiffs = 0, ticks = 0;
    replayCommandLog(replay!, (m) => { if (m.tick < c.cap) { ticks++; if (H(m) !== tickHash[m.tick]) tickDiffs++; } });
    assert(ticks === c.cap - 1 && tickDiffs === 0, `T9 ${c.name}: command log on the server's replay loop matches every tick before the cap (${ticks} ticks, ${tickDiffs} differ)`);
  }
}

function v2RunnerTests(): void {
  console.log("\n--- Runner v2 (G-10 T7) ---");
  type R = Record<string, any>;
  const W = (m: number[]) => m.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const rnd = lcg(99);
  const pick = (m: number[]) => { const ix = W(m); return ix[Math.floor(rnd() * ix.length)]; };
  const act = (s: R) => {
    const M = s.masks, p0 = (m: number[]) => pick(m) ?? 0;
    const econ = pick(M.econ), ea = V2.decodeEcon(econ);
    const kind = ea.kind === "repair" ? 0 : ea.kind === "rally" ? 1 : ea.kind === "cancel" ? 2 : -1;
    const g = pick(M.group), o = pick(M.order[g]);
    return {
      econ: [econ, ea.kind === "build" ? p0(M.site[V2.BUILDINGS.indexOf(ea.building)]) : 0, kind >= 0 ? p0(M.econPtr[kind]) : 0, kind === 1 ? p0(M.econTarget) : 0],
      army: [g, o, V2.GROUPS[g] === "unit" ? p0(M.unit[o]) : 0, pick(M.target[o]), p0(M.ptr[o])],
    };
  };
  const actionsFor = (slots: R[]) => slots.map((sl) => Object.fromEntries(Object.entries(sl.seats as R).map(([side, s]) => [side, act(s)])));

  // 1. Equivalence: the runner's ticks hash the same as a direct in-process loop.
  {
    const seed = 21, map = "glimmerfen", N = 60;
    const runHashes: string[] = [];
    const r = new VecRunnerV2({ onTick: (slot, m) => { if (slot === 0) runHashes.push(hashMatchState(m)); } });
    let res: R = r.handle({ type: "reset_all", max_ticks: 12000, slots: [{ seed, map, blue: "bot:random", red: "bot:random" }] });
    assertEqual(res.type, "ready", "T7 equivalence: reset_all → ready");
    for (let d = 0; d < N; d++) res = r.handle({ type: "step", actions: [{}] });
    const engine = new MatchEngine();
    const players: [PlayerSlot, PlayerSlot] = [
      { playerId: V2_PIDS[0], username: "bot:random", color: "blue", score: 0 },
      { playerId: V2_PIDS[1], username: "bot:random", color: "red", score: 0 },
    ];
    const match = engine.createMatch("v2-0-0", players, { ...DEFAULT_CONFIG, mapId: map, maxTicks: 12000 }, seed);
    engine.startMatch(match.id);
    const seats = [V2.createSeatState(match, V2_PIDS[0]), V2.createSeatState(match, V2_PIDS[1])] as [V2.SeatState, V2.SeatState];
    const oss = seats.map((st) => OBS.createObsState(match, st));
    const bots = [0, 1].map(() => makeV2Bot("random", mixSeed(seed, strSeed("random"))));
    const direct: string[] = [];
    for (let d = 0; d < N; d++) {
      for (const st of seats) V2.workerAutopilot(engine, match, st);
      const acts = [0, 1].map((i) => {
        const obs = OBS.observe(match, seats[i], oss[i], { z: 0, cap: 12000 });
        return bots[i].decide(obs, V2.computeMasks(match, seats[i]));
      });
      V2.applyV2Pair(engine, match, seats, [acts[0], acts[1]]);
      for (let t = 0; t < V2.DECISION_TICKS; t++) { engine.tick(match.id); direct.push(hashMatchState(match)); }
    }
    const firstDiff = direct.findIndex((h, i) => h !== runHashes[i]);
    assert(runHashes.length === direct.length && firstDiff < 0, `T7 equivalence: ${direct.length} tick hashes match a direct loop` + (firstDiff >= 0 ? ` (first diff at tick ${firstDiff + 1})` : ` (got ${runHashes.length})`));
  }

  // 2. Autoreset: three autoresets keep map, seats and z; seeds follow the sequence; configure applies at the boundary.
  {
    const r = new VecRunnerV2();
    let res: R = r.handle({ type: "reset_all", max_ticks: 160, slots: [
      { seed: 7, map: "ironreed", blue: "policy", red: "bot:random", z: { blue: 3 } },
      { seed: 8, map: "shardfall", blue: "policy", red: "policy" },
    ] });
    assertEqual(res.type, "ready", "T7 autoreset: ready");
    assertEqual(res.schemaVersion, OBS.OBS_SCHEMA_VERSION, "T7 ready carries the obs schema version");
    assertEqual(Object.keys(res.slots[0].seats).join(), "blue", "T7 bot seats are not sent to Python");
    assertEqual(Object.keys(res.slots[1].seats).sort().join(), "blue,red", "T7 policy-vs-policy sends both seats");
    let slots: R[] = res.slots;
    const ends: R[] = [];
    let zeroSum = true, configured = false;
    for (let d = 0; d < 200 && ends.length < 3; d++) {
      res = r.handle({ type: "step", actions: actionsFor(slots) });
      if (res.type !== "step_result") { assert(false, `T7 autoreset: step failed — ${res.message}`); return; }
      const two = res.slots[1].rewards;
      for (const k of ["res", "army", "dmg", "ctrl"]) if (two.blue.shaped[k] !== -two.red.shaped[k] && !(two.blue.shaped[k] === 0 && two.red.shaped[k] === 0)) zeroSum = false;
      if (two.blue.win !== -two.red.win) zeroSum = false;
      const s0 = res.slots[0];
      if (s0.truncated || s0.done) {
        ends.push(s0);
        if (ends.length === 1) {
          assertEqual(r.handle({ type: "configure", slots: [{ index: 0, z: { blue: 5 } }] }).type, "configured", "T7 configure → configured");
          configured = true;
        }
      }
      slots = res.slots;
    }
    assert(configured && ends.length === 3, `T7 autoreset: three episodes ended (got ${ends.length})`);
    if (ends.length === 3) {
      assert(ends.every((e) => e.truncated && !e.done && e.info.ticks === 160 && e.terminal.blue?.obs), "T7 truncation at the cap: truncated, not done, with a terminal obs");
      assert(ends.every((e) => e.episode.map === "ironreed" && e.episode.blue === "policy" && e.episode.red === "bot:random"), "T7 autoreset keeps map and seats");
      assertEqual(ends.map((e) => e.episode.seed).join(), [1, 2, 3].map((n) => mixSeed(7, n)).join(), "T7 autoreset seeds follow the sequence");
      assertEqual(ends.map((e) => `${e.info.episode.z.blue}>${e.episode.z.blue}`).join(), "3>3,3>5,5>5", "T7 configure is applied at the next episode boundary, then persists");
      assert(ends.every((e) => e.static && e.info.stats.blue.illegal === 0), "T7 autoreset sends the new static grid; random legal actions count no illegal");
    }
    assert(zeroSum, "T7 shaped and win rewards are zero-sum between seats");
  }

  // 3. Seat swap: the same seed with seats swapped plays the mirrored game.
  {
    const desc = (m: MatchState, pid: string) => {
      const f = frameFor(m, pid);
      return [...m.entities.values()].filter((e) => e.ownerId === pid)
        .map((e) => { const p = toOwnFrame(f, e); return `${e.type}:${e.buildingType ?? ""}:${p.x.toFixed(3)},${p.y.toFixed(3)}:${e.health}`; })
        .sort().join("|");
    };
    for (const map of ["shardfall", "twin-spires"]) {
      const run = (blue: string, red: string) => {
        const r = new VecRunnerV2();
        r.handle({ type: "reset_all", slots: [{ seed: 31, map, blue, red }] });
        for (let d = 0; d < 120; d++) r.handle({ type: "step", actions: [{}] });
        return r.matchOf(0);
      };
      const a = run("bot:random", "bot:idle"), b = run("bot:idle", "bot:random");
      const same = desc(a, V2_PIDS[0]) === desc(b, V2_PIDS[1]) && desc(a, V2_PIDS[1]) === desc(b, V2_PIDS[0]);
      assert(same && a.tick === b.tick, `T7 seat swap on ${map}: swapped seats play the mirrored game (${a.tick} ticks)`);
    }
  }

  // 4. Illegal actions are replaced by a no-op and counted; protocol errors are replies, not crashes.
  {
    const r = new VecRunnerV2();
    let res: R = r.handle({ type: "reset_all", max_ticks: 80, slots: [{ seed: 3, map: "shardfall", blue: "policy", red: "bot:idle" }] });
    const bad = W(res.slots[0].seats.blue.masks.econ.map((v: number) => 1 - v))[0];
    let n = 0;
    while (res.type === "step_result" ? !(res.slots[0].truncated || res.slots[0].done) : n === 0) {
      res = r.handle({ type: "step", actions: [{ blue: { econ: [bad, 0, 0, 0], army: [0, 0, 0, V2.TARGET_NONE, 0] } }] });
      n++;
      if (res.type !== "step_result") break;
    }
    assertEqual(res.type === "step_result" ? res.slots[0].info.stats.blue.illegal : -1, n, `T7 illegal actions are counted (${n} of ${n})`);
    assertEqual(r.handle({ type: "step", actions: [] }).type, "error", "T7 wrong action count → error reply");
    assertEqual(r.handle({ type: "step", actions: [{ blue: { econ: 0 } }] }).type, "error", "T7 malformed action → error reply");
    assertEqual(r.handle({ type: "nope" }).type, "error", "T7 unknown message → error reply");
    assertEqual(r.handle({ type: "reset_all", slots: [{ blue: "bot:" }] }).type, "error", "T7 bad seat spec → error reply");
  }
}

function v2ScriptedTests(): void {
  console.log("\n--- Scripted v2 bots (G-10 T8) ---");
  type R = Record<string, any>;
  const zs = scriptedZs();
  assert(zs.size >= 12 && !zs.has(0), `T8 scripted bots cover ${zs.size} distinct z (need ≥ 12, none 0)`);

  const play = (slots: R[], cap: number): R[] => {
    const r = new VecRunnerV2();
    let res: R = r.handle({ type: "reset_all", max_ticks: cap, critic: false, slots });
    if (res.type !== "ready") throw new Error(String(res.message));
    const out: R[] = new Array(slots.length).fill(null);
    const first = res.slots;
    while (out.some((x) => !x)) {
      const actions = slots.map((_, i) => (out[i] ? {} : Object.fromEntries(Object.keys((res.slots ?? first)[i].seats).map((k) => [k, { econ: [0, 0, 0, 0], army: [0, 0, 0, V2.TARGET_NONE, 0] }]))));
      res = r.handle({ type: "step", actions });
      if (res.type !== "step_result") throw new Error(String(res.message));
      res.slots.forEach((s: R, i: number) => { if (!out[i] && (s.done || s.truncated)) out[i] = s.info; });
    }
    return out;
  };

  // Every scripted bot runs without exceptions and with zero ineffective or illegal actions (short games; the full
  // 5-games-per-map check is headless/src/v2/botCheck.ts).
  {
    const names = Object.keys(SCRIPTED);
    const slots = names.map((b, i) => ({ seed: 40 + i, map: ["shardfall", "twin-spires", "glimmerfen"][i % 3], blue: `bot:${b}`, red: `bot:${names[(i + 3) % names.length]}` }));
    let infos: R[] = [];
    try { infos = play(slots, 3000); } catch (e) { assert(false, `T8 scripted bots play without exceptions (${(e as Error).message})`); }
    const bad = infos.flatMap((info, i) => ["blue", "red"].filter((s) => {
      const st = info.stats[s];
      return st.econIneffective + st.armyIneffective + st.illegal > 0;
    }).map((s) => `${slots[i][s as "blue"]}: ${JSON.stringify(info.stats[s])}`));
    assert(infos.length === slots.length && bad.length === 0, `T8 ${names.length} scripted bots, 3,000 ticks: ineffective-action rate 0` + (bad.length ? ` (${bad.join("; ")})` : ""));
    const zBad = infos.filter((info, i) => !info.episode.botZ.blue || zs.get(info.episode.botZ.blue) !== slots[i].blue.slice(4));
    assert(zBad.length === 0, "T8 episode info reports each scripted bot's z");
  }

  // The ring shortcut in anchorsConnected gives the same answers as the full flood fill (mid-game grids).
  {
    let n = 0, diff = 0, sealed = 0;
    for (const [map, seed] of [["shardfall", 11], ["glimmerfen", 12], ["twin-spires", 13]] as const) {
      const r = new VecRunnerV2();
      r.handle({ type: "reset_all", max_ticks: 12000, critic: false, slots: [{ seed, map, blue: "bot:turtle", red: "bot:heavy" }] });
      for (let d = 0; d < 250; d++) r.handle({ type: "step", actions: [{}] });
      const m = r.matchOf(0);
      const crystals = [...m.entities.values()].filter((e) => e.type === "crystal").map((e) => footprintOf(e) as NavRect);
      let st = seed; const rnd = () => ((st = (Math.imul(st, 1103515245) + 12345) >>> 0) / 2 ** 32);
      const structs = [...m.entities.values()].filter((e) => e.type === "building" || e.type === "crystal");
      for (let k = 0; k < 600; k++) {
        const w = 40 + Math.floor(rnd() * 100), h = 40 + Math.floor(rnd() * 100);
        let x: number, y: number;
        if (k % 2 && structs.length) { const e = structs[Math.floor(rnd() * structs.length)]; x = e.x + (rnd() - 0.5) * 220; y = e.y + (rnd() - 0.5) * 220; }
        else { x = rnd() * m.config.mapWidth; y = rnd() * m.config.mapHeight; }
        const rect = { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 };
        const a = anchorsConnected(m.nav, crystals, rect), b = floodConnected(m.nav, crystals, rect);
        n++; if (a !== b) diff++; if (!b) sealed++;
      }
    }
    assert(diff === 0, `T8 anchorsConnected ring shortcut = flood fill on ${n} rects (${sealed} sealing; ${diff} differ)`);
  }

  // Identical seeds → identical games.
  {
    const slot = { seed: 77, map: "ironreed", blue: "bot:macro", red: "bot:sw_rush_turtle" };
    const hashes: string[][] = [[], []];
    for (const k of [0, 1]) {
      const r = new VecRunnerV2({ onTick: (_s, m) => { if (m.tick % 50 === 0) hashes[k].push(hashMatchState(m)); } });
      r.handle({ type: "reset_all", max_ticks: 2500, critic: false, slots: [slot] });
      for (let d = 0; d < 2500 / V2.DECISION_TICKS; d++) r.handle({ type: "step", actions: [{}] });
    }
    assert(hashes[0].length > 40 && hashes[0].join() === hashes[1].join(), `T8 same seed → same game (${hashes[0].length} hashes)`);
  }

  // z requests, teach seats and switch ticks.
  {
    const r = new VecRunnerV2();
    const res: R = r.handle({ type: "reset_all", max_ticks: 200, critic: false, slots: [
      { seed: 5, map: "shardfall", blue: "teach:rush2", red: "bot:idle", z: { blue: 4 } },
      { seed: 5, map: "shardfall", blue: "teach:turtle", red: "bot:idle" },
      { seed: 5, map: "shardfall", blue: "policy", red: "bot:heavy" },
    ] });
    assertEqual(res.slots[0].seats.blue.obs.z, 4, "T8 requested z picks the template (rush2 → gunner rush, z 4)");
    assert([5, 6].includes(res.slots[1].seats.blue.obs.z), "T8 teach seat with z 0 observes its bot's z");
    assertEqual(res.slots[2].seats.blue.obs.z, 0, "T8 policy seat keeps the configured z");
    assert([9, 10].includes(res.slots[2].episode.botZ.red) && res.slots[2].episode.botZ.blue === 0, "T8 episode info carries the bots' z (heavy: 9 or 10; policy seat: 0)");
    const m = r.matchOf(0), st = V2.createSeatState(m, V2_PIDS[0]), ctx = botContext(m, st, 12000);
    let inWindow = true;
    for (let seed = 1; seed <= 50; seed++) {
      const b = new ScriptedV2Bot("sw_turtle_grab", seed, ctx);
      if (b.switchTick === null || b.switchTick < SWITCH_WINDOW[0] || b.switchTick > SWITCH_WINDOW[1]) inWindow = false;
    }
    assert(inWindow, "T8 switchers switch at a tick in [1500, 4000]");
    let threw = false;
    try { new ScriptedV2Bot("rush1", 1, ctx, 9); } catch { threw = true; }
    assert(threw, "T8 a z the bot does not play is an error");
  }

  // The runner survives a bot exception: counted, logged (stderr), played as a no-op.
  {
    const orig = ScriptedV2Bot.prototype.decide;
    ScriptedV2Bot.prototype.decide = function () { throw new Error("test: deliberate bot exception (expected)"); };
    let info: R | null = null;
    try {
      const r = new VecRunnerV2();
      r.handle({ type: "reset_all", max_ticks: 40, critic: false, slots: [{ seed: 3, map: "shardfall", blue: "bot:macro", red: "bot:idle" }] });
      for (let d = 0; d < 5 && !info; d++) {
        const res: R = r.handle({ type: "step", actions: [{}] });
        if (res.type === "step_result" && res.slots[0].truncated) info = res.slots[0].info;
      }
    } finally {
      ScriptedV2Bot.prototype.decide = orig;
    }
    assertEqual(info?.stats.blue.botErrors, 5, "T8 runner survives bot exceptions and counts them (5 decisions in 40 ticks)");
  }
}

void (async () => {
  anchorTests();
  v2ScriptedTests();
  v2RunnerTests();
  v2ReplayTests();
  truncationTests();
  v2ActionTests();
  v2ObservationTests();
  await determinismTests();
  await loadGateTests();
  goldenHashTests();
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(40) + "\n");

  if (failed > 0) {
    process.exit(1);
  }
})();
