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

  // Contested nodes are near middle
  for (const n of map.contestedNodes) {
    assert(Math.abs(n.x - midX) < 100, "Contested nodes are near the middle");
  }

  // Build zones
  assert(map.blueBuildZone.x2 < midX, "Blue build zone is on the left");
  assert(map.redBuildZone.x1 > midX, "Red build zone is on the right");

  // Lane corridor
  assert(map.laneCorridor.top < midY, "Lane corridor top is above center");
  assert(map.laneCorridor.bottom > midY, "Lane corridor bottom is below center");
}

// ---- Match Creation with Economy ----
console.log("\n--- Match Creation with Economy ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("ECON01", players);
  assert(match.id.length > 0, "Match has a UUID id");
  assert(match.lobbyCode === "ECON01", "Match has correct lobby code");
  assert(match.phase === "spawn", "Match starts in spawn phase");
  assert(match.tick === 0, "Match starts at tick 0");

  // Economy initialized
  assert(match.economy[0] !== null, "Blue economy exists");
  assert(match.economy[1] !== null, "Red economy exists");
  assertEqual(match.economy[0]!.resources, 50, "Blue starts with 50 resources");
  assertEqual(match.economy[1]!.resources, 50, "Red starts with 50 resources");
  assertEqual(match.economy[0]!.supply, 0, "Blue starts with 0 supply");
  assertEqual(match.economy[1]!.supply, 0, "Red starts with 0 supply");
  assertEqual(match.economy[0]!.maxSupply, 10, "Blue max supply is 10");
  assertEqual(match.economy[1]!.maxSupply, 10, "Red max supply is 10");

  // Resource nodes created
  assert(match.resourceNodes.length === 6, "6 resource nodes created (2 safe per player + 2 contested)");

  const blueNodes = match.resourceNodes.filter((n) => n.gathererSlots.size === 0);
  assert(blueNodes.length === 6, "All nodes start with no gatherers");

  // Check node capacities
  const safeNodes = match.resourceNodes.filter((n) => n.capacity === 300);
  const contestedNodes = match.resourceNodes.filter((n) => n.capacity === 500);
  assert(safeNodes.length === 4, "4 safe nodes with capacity 300");
  assert(contestedNodes.length === 2, "2 contested nodes with capacity 500");

  // 8 entities: 2 crystals + 6 workers
  assert(match.entities.size === 8, "8 entities spawned (2 crystals + 6 workers)");
}

// ---- Continuous Resource Gathering ----
console.log("\n--- Continuous Resource Gathering ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("GATH01", players);
  engine.startMatch(match.id);

  // Find a safe node for blue
  const blueNode = match.resourceNodes.find((n) => n.capacity === 300 && n.x < 600);
  assert(blueNode !== undefined, "Blue safe node exists");

  // Find a blue worker
  const blueWorker = Array.from(match.entities.values()).find(
    (e) => e.type === "worker" && e.ownerId === "p1"
  );
  assert(blueWorker !== undefined, "Blue worker exists");

  // Worker gathers from node
  const gatherResult = engine.processCommand(match.id, "p1", {
    type: "gather",
    entityId: blueWorker!.id,
    targetEntityId: blueNode!.id,
  });
  assert(gatherResult.success === true, "Gather command succeeds");

  // Node should have 1 gatherer
  assert(blueNode!.gathererSlots.size === 1, "Node has 1 gatherer");

  // Tick and verify resources increase
  engine.tick(match.id);
  const updatedMatch = engine.getMatch(match.id);
  assertEqual(updatedMatch!.economy[0]!.resources, 51, "Blue resources increased by 1 after 1 tick");

  // Tick 10 more times
  for (let i = 0; i < 10; i++) {
    engine.tick(match.id);
  }
  const updatedMatch2 = engine.getMatch(match.id);
  assertEqual(updatedMatch2!.economy[0]!.resources, 61, "Blue resources increased by 10 after 10 ticks");
}

// ---- Node Slot Limits ----
console.log("\n--- Node Slot Limits ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("SLOT01", players);
  engine.startMatch(match.id);

  // Find a safe node for blue
  const blueNode = match.resourceNodes.find((n) => n.capacity === 300 && n.x < 600);
  assert(blueNode !== undefined, "Blue safe node exists");

  // Find all blue workers
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === "p1"
  );
  assert(blueWorkers.length === 3, "3 blue workers exist");

  // Assign 3 workers (max slots)
  for (const worker of blueWorkers) {
    const result = engine.processCommand(match.id, "p1", {
      type: "gather",
      entityId: worker.id,
      targetEntityId: blueNode!.id,
    });
    assert(result.success === true, `Worker ${worker.id.slice(0, 8)} assigned to node`);
  }

  assert(blueNode!.gathererSlots.size === 3, "Node has 3 gatherers (max)");

  // Try to assign a 4th worker (should fail - no more blue workers, but test the logic)
  // Create a 4th worker manually for testing
  const fourthWorker = {
    id: "fake_worker_4",
    type: "worker" as const,
    ownerId: "p1",
    x: 100,
    y: 300,
    health: 100,
    maxHealth: 100,
    radius: 10,
    color: "#6699ff",
  };
  match.entities.set(fourthWorker.id, fourthWorker);

  const overflowResult = engine.processCommand(match.id, "p1", {
    type: "gather",
    entityId: fourthWorker.id,
    targetEntityId: blueNode!.id,
  });
  assert(overflowResult.success === false, "4th worker rejected (node full)");
  assert(overflowResult.message === "Node is full", "Rejection message is 'Node is full'");
  assert(blueNode!.gathererSlots.size === 3, "Node still has 3 gatherers");
}

// ---- Node Depletion ----
console.log("\n--- Node Depletion ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("DEPL01", players);
  engine.startMatch(match.id);

  // Find a safe node (capacity 300)
  const safeNode = match.resourceNodes.find((n) => n.capacity === 300);
  assert(safeNode !== undefined, "Safe node exists");

  // Assign 3 workers to the node
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === "p1"
  );
  for (const worker of blueWorkers) {
    engine.processCommand(match.id, "p1", {
      type: "gather",
      entityId: worker.id,
      targetEntityId: safeNode!.id,
    });
  }

  // Each tick with 3 workers: 3 resources gathered, 3 depleted
  // 300 / 3 = 100 ticks to deplete
  for (let i = 0; i < 100; i++) {
    engine.tick(match.id);
  }

  assert(safeNode!.remaining === 0, "Node is depleted (0 remaining)");
  assert(safeNode!.gathererSlots.size === 0, "Gatherers removed from depleted node");

  // Workers should be idle (removed from node)
  const gatherResult = engine.processCommand(match.id, "p1", {
    type: "gather",
    entityId: blueWorkers[0]!.id,
    targetEntityId: safeNode!.id,
  });
  assert(gatherResult.success === false, "Cannot gather from depleted node");
  assert(gatherResult.message === "Node is depleted", "Rejection message is 'Node is depleted'");
}

// ---- Worker Training Cost and Supply ----
console.log("\n--- Worker Training Cost and Supply ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("TRN001", players);
  engine.startMatch(match.id);

  // Find blue crystal
  const blueCrystal = Array.from(match.entities.values()).find(
    (e) => e.type === "crystal" && e.ownerId === "p1"
  );
  assert(blueCrystal !== undefined, "Blue crystal exists");

  // Try to train without enough resources (need 25, have 50 - should work)
  const trainResult = engine.processCommand(match.id, "p1", {
    type: "train_worker",
    entityId: blueCrystal!.id,
  });
  assert(trainResult.success === true, "Worker training succeeds with enough resources");

  const updatedMatch = engine.getMatch(match.id);
  assertEqual(updatedMatch!.economy[0]!.resources, 25, "Resources decreased by 25 after training");
  assertEqual(updatedMatch!.economy[0]!.supply, 1, "Supply increased by 1 after training");

  // Count entities - should now have 9 (8 + 1 new worker)
  assert(updatedMatch!.entities.size === 9, "New worker spawned (9 entities total)");

  // Train another worker
  const trainResult2 = engine.processCommand(match.id, "p1", {
    type: "train_worker",
    entityId: blueCrystal!.id,
  });
  assert(trainResult2.success === true, "Second worker training succeeds");
  assertEqual(updatedMatch!.economy[0]!.resources, 0, "Resources at 0 after second training");
  assertEqual(updatedMatch!.economy[0]!.supply, 2, "Supply at 2 after second training");

  // Cannot train third worker (no resources)
  const trainResult3 = engine.processCommand(match.id, "p1", {
    type: "train_worker",
    entityId: blueCrystal!.id,
  });
  assert(trainResult3.success === false, "Third worker training fails (no resources)");
  assert(trainResult3.message === "Not enough resources", "Rejection message is 'Not enough resources'");
}

// ---- Supply Cap Enforcement ----
console.log("\n--- Supply Cap Enforcement ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("SUPP01", players);
  engine.startMatch(match.id);

  const blueCrystal = Array.from(match.entities.values()).find(
    (e) => e.type === "crystal" && e.ownerId === "p1"
  );

  // Train 10 workers (max supply = 10, each costs 1 supply)
  // Starting resources: 50, each worker costs 25
  // Can only train 2 workers (50 - 25 - 25 = 0)
  // So we need to give more resources for this test
  // Actually let's just test with the default config

  // First, gather some resources by assigning workers to a node
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === "p1"
  );
  const node = match.resourceNodes.find((n) => n.capacity === 300 && n.x < 600);
  if (node) {
    for (const worker of blueWorkers) {
      engine.processCommand(match.id, "p1", {
        type: "gather",
        entityId: worker.id,
        targetEntityId: node.id,
      });
    }
    // Gather 100 ticks worth of resources
    for (let i = 0; i < 100; i++) {
      engine.tick(match.id);
    }
  }

  const updatedMatch = engine.getMatch(match.id);
  const currentResources = updatedMatch!.economy[0]!.resources;
  const currentSupply = updatedMatch!.economy[0]!.supply;

  // Train workers until supply cap is hit
  let trainedCount = 0;
  for (let i = 0; i < 20; i++) {
    const result = engine.processCommand(match.id, "p1", {
      type: "train_worker",
      entityId: blueCrystal!.id,
    });
    if (result.success) {
      trainedCount++;
    }
  }

  assert(currentSupply + trainedCount <= 10, `Supply cap enforced (trained ${trainedCount}, max 10)`);

  // Verify supply cap
  const finalMatch = engine.getMatch(match.id);
  assert(finalMatch!.economy[0]!.supply <= 10, "Supply never exceeds maxSupply of 10");
}

// ---- Rematch Reset of Economy State ----
console.log("\n--- Rematch Reset of Economy State ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("RESET01", players);
  engine.startMatch(match.id);

  // Gather resources
  const blueWorkers = Array.from(match.entities.values()).filter(
    (e) => e.type === "worker" && e.ownerId === "p1"
  );
  const node = match.resourceNodes.find((n) => n.capacity === 300 && n.x < 600);
  if (node) {
    for (const worker of blueWorkers) {
      engine.processCommand(match.id, "p1", {
        type: "gather",
        entityId: worker.id,
        targetEntityId: node.id,
      });
    }
    for (let i = 0; i < 50; i++) {
      engine.tick(match.id);
    }
  }

  // Train a worker
  const blueCrystal = Array.from(match.entities.values()).find(
    (e) => e.type === "crystal" && e.ownerId === "p1"
  );
  engine.processCommand(match.id, "p1", {
    type: "train_worker",
    entityId: blueCrystal!.id,
  });

  // Deplete a node
  const depletedNode = match.resourceNodes.find((n) => n.remaining < n.capacity);
  if (depletedNode) {
    for (let i = 0; i < 100; i++) {
      engine.tick(match.id);
    }
  }

  // Verify modified state
  const modifiedMatch = engine.getMatch(match.id);
  assert(modifiedMatch!.economy[0]!.resources !== 50, "Resources changed from starting value");
  assert(modifiedMatch!.economy[0]!.supply > 0, "Supply increased from starting value");
  assert(depletedNode!.remaining === 0, "Node was depleted");

  // Reset match
  const reset = engine.resetMatch(match.id, players);
  assert(reset !== null, "Match can be reset");

  // Economy should be reset
  assertEqual(reset.economy[0]!.resources, 50, "Resources reset to 50");
  assertEqual(reset.economy[1]!.resources, 50, "Red resources reset to 50");
  assertEqual(reset.economy[0]!.supply, 0, "Supply reset to 0");
  assertEqual(reset.economy[1]!.supply, 0, "Red supply reset to 0");

  // Nodes should be reset (full capacity)
  for (const node of reset.resourceNodes) {
    assertEqual(node.remaining, node.capacity, `Node ${node.id.slice(0, 8)} reset to full capacity`);
    assert(node.gathererSlots.size === 0, `Node ${node.id.slice(0, 8)} has no gatherers`);
  }

  // Entity count back to 8
  assert(reset.entities.size === 8, "Entity count reset to 8");

  // Scores preserved
  assertEqual(reset.players[0]?.score, 0, "Player 1 score preserved");
  assertEqual(reset.players[1]?.score, 0, "Player 2 score preserved");
}

// ---- Match Start ----
console.log("\n--- Match Start ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("TEST01", players);
  assert(match.phase === "spawn", "Match starts in spawn");

  const started = engine.startMatch(match.id);
  assert(started !== null, "Match can be started");
  assert(started.phase === "playing", "Match phase is playing after start");
}

// ---- Deterministic Tick ----
console.log("\n--- Deterministic Tick ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("DETER01", players);
  engine.startMatch(match.id);

  // Tick 10 times
  for (let i = 0; i < 10; i++) {
    const result = engine.tick(match.id);
    assert(result !== null, `Tick ${i + 1} returns match state`);
    assert(result.tick === i + 1, `Tick ${i + 1} has correct tick count`);
  }

  const finalMatch = engine.getMatch(match.id);
  assert(finalMatch.tick === 10, "After 10 ticks, tick count is 10");
}

// ---- Command Processing ----
console.log("\n--- Command Processing ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("CMND01", players);
  engine.startMatch(match.id);

  const entity = Array.from(match.entities.values())[0];

  // Move command
  const moved = engine.processCommand(match.id, "p1", {
    type: "move",
    entityId: entity.id,
    targetX: 500,
    targetY: 300,
  });
  assert(moved.success === true, "Move command succeeds");

  const updated = engine.getMatch(match.id);
  const movedEntity = updated?.entities.get(entity.id);
  assert(movedEntity !== undefined, "Entity still exists after move");
  assert(movedEntity!.x === 500, "Entity x position updated to 500");
  assert(movedEntity!.y === 300, "Entity y position updated to 300");

  // Command on non-existent entity
  const badMove = engine.processCommand(match.id, "p1", {
    type: "move",
    entityId: "nonexistent",
    targetX: 100,
    targetY: 100,
  });
  assert(badMove.success === false, "Command on non-existent entity fails");

  // Command from wrong player
  const wrongPlayer = engine.processCommand(match.id, "p2", {
    type: "move",
    entityId: entity.id,
    targetX: 200,
    targetY: 200,
  });
  assert(wrongPlayer.success === false, "Command from wrong player fails");
}

// ---- Match End ----
console.log("\n--- Match End ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("END001", players);
  engine.startMatch(match.id);

  const ended = engine.endMatch(match.id, "p2");
  assert(ended !== null, "Match can be ended");
  assert(ended.phase === "ended", "Match phase is ended");
  assert(ended.result?.winner === "p2", "Winner is p2");
  assert(ended.endedAt !== null, "Match has end timestamp");

  // Cannot tick an ended match
  const tickResult = engine.tick(match.id);
  assert(tickResult === null, "Tick returns null for ended match");
}

// ---- Match Reset on Rematch ----
console.log("\n--- Match Reset on Rematch ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("RESET01", players);
  engine.startMatch(match.id);

  // Move an entity
  const entity = Array.from(match.entities.values())[0];
  engine.processCommand(match.id, "p1", {
    type: "move",
    entityId: entity.id,
    targetX: 999,
    targetY: 999,
  });

  // Tick a few times
  engine.tick(match.id);
  engine.tick(match.id);
  engine.tick(match.id);

  assert(match.tick === 3, "Match has advanced to tick 3");

  // Reset the match
  const newPlayers: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 5, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 3, wsId: "ws2" },
  ];

  const reset = engine.resetMatch(match.id, newPlayers);
  assert(reset !== null, "Match can be reset");
  assert(reset.phase === "spawn", "Match resets to spawn phase");
  assert(reset.tick === 0, "Match tick resets to 0");
  assert(reset.result === null, "Match result is cleared");
  assert(reset.endedAt === null, "Match end timestamp is cleared");
  assert(reset.players[0]?.score === 5, "Score preserved for player 1");
  assert(reset.players[1]?.score === 3, "Score preserved for player 2");

  // Entity positions reset (new entities spawned)
  const entities = Array.from(reset.entities.values());
  const movedEntity = entities.find((e) => e.id === entity.id);
  assert(movedEntity === undefined, "Old entity positions cleared (new entities)");
}

// ---- Disconnect Produces Immediate Loss ----
console.log("\n--- Disconnect Produces Immediate Loss ---");
{
  const engine = new MatchEngine();
  const players: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match = engine.createMatch("DISC01", players);
  engine.startMatch(match.id);

  // Simulate p1 disconnect: end match with p2 as winner
  const ended = engine.endMatch(match.id, "p2");
  assert(ended !== null, "Match ended on disconnect");
  assert(ended.result?.winner === "p2", "Disconnected player loses");
  assert(ended.phase === "ended", "Match phase is ended");

  // Verify entities still exist (no stale entity leakage)
  assert(ended.entities.size === 8, "All entities preserved after end");
}

// ---- No Stale Entity Leakage Across Rematches ----
console.log("\n--- No Stale Entity Leakage ---");
{
  const engine = new MatchEngine();
  const players1: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const match1 = engine.createMatch("LEAK01", players1);
  engine.startMatch(match1.id);

  // Record all entity IDs from first match
  const firstEntityIds = new Set(Array.from(match1.entities.keys()));
  const firstEntityPositions = new Map<string, { x: number; y: number }>();
  for (const [id, entity] of match1.entities) {
    firstEntityPositions.set(id, { x: entity.x, y: entity.y });
  }

  // End and reset
  engine.endMatch(match1.id, "p1");
  engine.resetMatch(match1.id, players1);

  // All entities should be new (cleared and respawned)
  const secondEntityIds = new Set(Array.from(match1.entities.keys()));
  assert(firstEntityIds.size === secondEntityIds.size, "Same number of entities after reset");

  // No entity IDs should leak
  let leakedCount = 0;
  for (const id of firstEntityIds) {
    if (secondEntityIds.has(id)) {
      leakedCount++;
    }
  }
  assert(leakedCount === 0, "No entity IDs leak across reset");

  // Entities should be at spawn positions (not moved positions)
  for (const entity of match1.entities.values()) {
    const original = firstEntityPositions.get(entity.id);
    // Since entity IDs are new, positions should be at spawn
    assert(original === undefined, `New entity ${entity.id} has no stale position data`);
  }

  // Destroy and create new match
  engine.destroyMatch(match1.id);
  const match2 = engine.createMatch("LEAK01", players1);
  assert(match2.id !== match1.id, "New match has different ID after destroy");
  assert(match2.entities.size === 8, "New match has correct entity count");
}

// ---- Multiple Matches Coexistence ----
console.log("\n--- Multiple Matches Coexistence ---");
{
  const engine = new MatchEngine();

  const players1: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p1", username: "Blue", color: "blue", score: 0, wsId: "ws1" },
    { playerId: "p2", username: "Red", color: "red", score: 0, wsId: "ws2" },
  ];

  const players2: [PlayerSlot | null, PlayerSlot | null] = [
    { playerId: "p3", username: "Blue2", color: "blue", score: 0, wsId: "ws3" },
    { playerId: "p4", username: "Red2", color: "red", score: 0, wsId: "ws4" },
  ];

  const match1 = engine.createMatch("MULT01", players1);
  const match2 = engine.createMatch("MULT02", players2);

  engine.startMatch(match1.id);
  engine.startMatch(match2.id);

  // Tick each match independently
  engine.tick(match1.id);
  engine.tick(match2.id);
  engine.tick(match2.id);

  const m1 = engine.getMatch(match1.id);
  const m2 = engine.getMatch(match2.id);

  assert(m1!.tick === 1, "Match 1 tick is 1");
  assert(m2!.tick === 2, "Match 2 tick is 2");
  assert(m1!.id !== m2!.id, "Matches have different IDs");
}

// ---- Summary ----
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(40) + "\n");

if (failed > 0) {
  process.exit(1);
}
