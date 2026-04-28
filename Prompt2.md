You are implementing one stage of a multiplayer browser RTS prototype.

Project summary:
- 1v1 real-time browser RTS
- Single lane map with a slightly wider middle combat zone
- Two human players only per match
- Main menu with username, host, join, settings
- Host creates lobby code, second player joins by code
- Lobby shows usernames and ready states
- Match starts only when both players are present and ready
- Best of 1 per round, with Rematch and Exit after match end
- Same lobby persists across rematches
- Win/loss score persists across rematches within the same lobby session
- Full game state resets between rematches
- Immediate loss on disconnect
- Top-down 2D prototype now, but architecture must remain adaptable for future isometric rendering
- One resource only
- Finite resource nodes with high capacity
- Limited worker slots per node, configurable, default 3
- Workers gather continuously until node depletion, income is added instantly
- One base structure called Crystal that is also the HQ
- Crystal is the win condition and can train workers
- Buildings in v1: Crystal, Barracks, Foundry, Supply Depot, Turret
- Units in v1: Worker, Skirmisher, Gunner, Bruiser, Medic
- Strong counter triangle:
  - Skirmisher beats Gunner
  - Gunner beats Bruiser
  - Bruiser beats Skirmisher
  - Medic is a support healer, not part of the direct counter triangle
- Turret should use the ranged damage profile so it loosely follows the same counter logic as Gunner
- Supply cap exists
- Drag-select and right-click controls
- Unlimited selection
- Idle combat units auto-attack if enemies enter range, but do not chase unless commanded
- Manual targeting for attacks
- Manual heal targeting for Medic:
  - when assigned to a friendly unit, Medic follows that target and stays within heal range
  - if the target dies, Medic idles
- Workers can repair buildings
- Repairing costs resources proportional to health restored
- Soft collision / light separation, not hard blocking
- Free building placement, but only within a player's build zone
- No building can be placed in a way that blocks the lane
- Fog of war is required and must be server-authoritative
- Explored terrain and known resource node positions can remain remembered
- Hidden enemy units and buildings must not be targetable

Technical constraints:
- Use a single repository
- Use TypeScript throughout
- Prefer a simple all-in-one deployment shape suitable for a Debian container
- Prioritise ease and speed of implementation, but keep the simulation authoritative on the server because of fog of war and multiplayer fairness
- No database, keep lobby and match state in memory
- Maximum expected concurrency is very low, but do not hard-code exactly 6 players
- Keep gameplay simulation separate from rendering and UI
- Keep shared types and constants in a shared module
- Prefer simple, maintainable systems over clever abstractions
- Do not add features outside scope
- Do not add AI opponents, upgrades, factions, persistence, accounts, matchmaking, cosmetics, replays, chat, or attack-move unless explicitly asked
- Make the project runnable after this stage
- Include tests and manual verification steps
- If a requested feature depends on a missing prerequisite, implement only the smallest sensible prerequisite required for this stage
- Deployment constraints:
- The project will be deployed in a Proxmox LXC Debian container
- Use a simple all-in-one deployment model
- The Node server must serve the built frontend and the WebSocket API from the same process
- The application must bind to 0.0.0.0 on port 3777 by default
- Make the port configurable via environment variable, but default to 3777
- Prepare the project to run under a systemd service
- Avoid Docker as a requirement
- Do not require a database or external managed services

Recommended stack:
- Client: React + TypeScript + Vite
- Game rendering: HTML5 Canvas with a dedicated renderer module
- Server: Node.js + TypeScript + Express + ws
- Shared: TypeScript types/constants in a shared folder
- The Node server may serve the built client for a simple deployment model
- Server: Node.js + TypeScript + Express + ws, with Express also serving the built client for production

Repository shape:
- /client
- /server
- /shared

Output format for this stage:
1. Stage summary
2. Implementation plan
3. File tree changes
4. Code changes
5. Commands to install, run, and test
6. Automated tests added
7. Manual verification steps
8. Known limitations
9. Stop here, do not start the next stage


Implement Stage 2 only, using the completed Stage 1 codebase as the starting point.

Stage 2 goal:
Add the authoritative match simulation core on the server and connect it to the existing lobby flow. This stage should create the match lifecycle, deterministic update loop, entity model, command pipeline, and reset logic for rematches. Use placeholder entities and a placeholder map representation if necessary. Do not implement full economy, units, or buildings yet.

Stage 2 scope:
- Add a server-authoritative match simulation module
- Start a match instance when both lobby players are ready
- Maintain a fixed server tick loop suitable for RTS simulation
- Define shared entity and match state types
- Create the base simulation structures:
  - match id
  - player slots
  - simulation tick
  - match phase
  - entity registry
  - command queue
  - win/loss result
- Add a minimal map coordinate system suitable for a top-down lane RTS
- Spawn minimal placeholder entities for each player on match start:
  - one Crystal placeholder
  - three Worker placeholders
- Add a client-side "game shell" view that can render basic placeholder positions and current match phase from authoritative state
- Add a command message pipeline from client to server, even if only stubbed for now
- Implement clean match teardown and rematch reset:
  - same lobby persists
  - score persists
  - match state fully resets
  - ready-up required again before next round
- If either client disconnects during an active match, immediately award the other player the win and end the match
- Keep the simulation deterministic where practical
- Add a simple simulation snapshot or state broadcast model from server to clients

Implementation requirements:
- Keep simulation logic separate from networking code
- Keep render/UI code separate from simulation rules
- Prefer pure functions for state updates where practical
- Define clear enums or literal unions for match phases
- Design the entity model so later stages can add movement, combat, fog, and production without refactoring everything
- Use stable ids for entities, matches, lobbies, and players
- Add a lightweight serialisable game state shape that the client can consume

Acceptance criteria:
- A real server-side match instance is created when both players ready up
- Match state is broadcast to both clients
- Placeholder Crystals and Workers spawn for both players in mirrored starting positions
- Disconnect during match causes immediate loss for the disconnected player and updates score
- Rematch fully resets the match state but keeps lobby score
- No stale entities or match state remain after rematch
- The project remains runnable end-to-end

Testing requirements:
- Add automated tests for:
  - match creation from ready lobby
  - placeholder spawns
  - match reset on rematch
  - disconnect produces immediate loss
  - no stale entity leakage across rematches
  - deterministic behaviour for a fixed input sequence where applicable
- Add manual verification steps for:
  - observe match shell transition from lobby
  - inspect placeholder entities in both clients
  - disconnect one tab and verify immediate win for the other
  - rematch and verify full reset with preserved score

Important:
- Do not implement resource gathering, building placement, combat, or fog of war yet
- Stop after Stage 2

