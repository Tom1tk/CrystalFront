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


Implement Stage 1 only.

Stage 1 goal:
Create the project scaffold and a working multiplayer lobby flow with usernames, host/join by lobby code, ready-up, rematch session shell, and persistent score tracking inside a lobby session. Do not implement gameplay yet. Also prepare the application for a single-process production deployment where the Node server serves the built frontend and WebSocket endpoints on port 3777.

Stage 1 scope:
- Create the single-repo TypeScript project with /client, /server, /shared
- Configure scripts so the project can be developed locally and built for deployment
- Build the client main menu UI:
  - username field
  - host button
  - join by lobby code field + button
  - settings panel placeholder
- Build the server lobby system:
  - create lobby
  - join lobby by code
  - store two players max per lobby
  - maintain per-lobby state in memory
  - usernames stored in session state
  - ready states per player
  - match score per player persists across rematches in the same lobby
- Build the lobby screen UI:
  - show lobby code
  - show both usernames when present
  - show ready states
  - ready button
  - leave lobby button
- When both players are ready, transition into a placeholder "match loading" or "game shell" state
- Add a placeholder end-of-match screen shell that can be triggered manually from debug controls for now:
  - winner display
  - rematch button
  - exit button
- Rematch in Stage 1 should:
  - keep same lobby and score state
  - reset ready states
  - return players to lobby ready-up
- Exit should:
  - remove the player from the lobby
  - if both leave, delete the lobby
- If a second player joins an already full lobby, reject it cleanly
- If a player refreshes, no reconnect support is needed yet
- Use WebSockets for client-server state sync from the beginning
- Add minimal shared message/event type definitions in /shared
- Add a simple debug control in the client lobby or shell to simulate "player 1 win" or "player 2 win" so the rematch and score flow can be verified before gameplay exists
- Configure the server so it can serve the built client in production
- Add environment-based configuration with PORT defaulting to 3777
- Ensure the server binds to 0.0.0.0 for container accessibility
- Add npm scripts for:
  - client development
  - server development
  - full development
  - production build
  - production start
- Add a minimal production server path that serves client static files after build
- Add a placeholder deployment note in README describing that the production service will run under systemd on port 3777

Implementation requirements:
- Keep code simple and explicit
- Use a small state machine for client screens if helpful
- Keep server lobby logic separate from any future match simulation
- Add clear TypeScript interfaces for lobby, player session, and messages
- Ensure the server is the source of truth for lobby membership, ready state, and scores
- Validate username and lobby code inputs
- Generate short readable lobby codes
- Do not implement the actual RTS map or combat in this stage

Acceptance criteria:
- Two browser tabs can connect to the same lobby using a code
- Both usernames are visible to both players
- Ready state synchronises correctly
- When both click ready, both clients transition to a placeholder game shell
- Debug win buttons update score correctly
- Rematch returns both players to the same lobby with score preserved and ready states reset
- Exit removes the player from the lobby
- Invalid join codes and full lobbies show clear errors
- Project runs cleanly with documented commands
- The server can be configured to run on port 3777
- The project includes a production build/start path suitable for one-process deployment
- The server is prepared to serve the built frontend in production

Testing requirements:
- Add automated tests for:
  - lobby creation
  - join valid code
  - reject invalid code
  - reject third player
  - ready state transitions
  - rematch score persistence
  - exit and lobby cleanup logic
- Add manual verification steps for:
  - two-browser host/join flow
  - ready-up flow
  - debug win and rematch flow
  - exit flow
  - production build completes
  - production server starts on port 3777
  - built frontend loads from the Node server

Important:
- Build the foundation that later stages can extend
- Do not start match simulation yet
- Stop after Stage 1

