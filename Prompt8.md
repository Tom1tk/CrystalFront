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

Implement Stage 8 only, using the completed Stage 7 codebase as the starting point.

Stage 8 goal:
Stabilise the prototype, fix edge cases, tune numbers for 8 to 12 minute matches, improve maintainability, and make the project ready to run reliably in a small self-hosted environment.

Stage 8 scope:
- Review and fix simulation and networking edge cases:
  - stale lobby or match state
  - rematch edge cases
  - disconnect handling
  - invalid command rejection
  - construction and production edge cases
  - fog state edge cases
- Improve performance where needed for a small number of matches
- Add configuration constants and centralise tuning data
- Add a light balance pass aimed at:
  - short web matches
  - early pressure being viable
  - eco play being viable
  - turrets useful but not oppressive
  - support meaningful but not mandatory
- Improve code comments and structure where it materially helps maintainability
- Keep systems adaptable for later isometric rendering:
  - avoid baking top-down assumptions into simulation logic
  - keep render transforms isolated
- Add deployment guidance for a Debian container:
  - install steps
  - build steps
  - run steps
  - environment variables if needed
- Add a final smoke test checklist and documented known limitations
- - Finalise production deployment for Debian systemd hosting
- Ensure the Node server serves the built frontend and WebSocket endpoint from the same process
- Add environment configuration with PORT defaulting to 3777
- Add a production-ready systemd service file example for Crystalfront
- Add deployment documentation for:
  - installing dependencies
  - building the project
  - starting the service
  - enabling the service on boot
  - checking logs with journalctl
  - restarting after updates

Implementation requirements:
- Do not redesign architecture without good reason
- Prioritise reliability over flashy polish
- Keep the codebase understandable
- If adding any small debug tooling for maintenance, keep it minimal and clearly separated from player UI
- Do not add new game features outside current scope

Acceptance criteria:
- Prototype runs through repeated matches and rematches without corruption
- No stale entities or stale lobbies accumulate during normal use
- Match flow is complete from menu to lobby to gameplay to rematch or exit
- Game feels broadly playable within the target match length
- Deployment steps are documented and practical
- A documented systemd service configuration is provided
- The production server runs correctly on port 3777
- The built frontend is served by the Node process
- WebSocket connections work through the same service/process

Testing requirements:
- Add or update automated tests for:
  - repeated rematch cycles
  - stale state cleanup
  - invalid command rejection
  - long-running match stability where practical
- Add a manual verification checklist for:
  - three separate matches on one server over time
  - repeated rematches in one lobby
  - disconnect during lobby and during match
  - full end-to-end gameplay loop
  - deployment on a Debian host
  - run the production build
  - start the service locally on port 3777
  - load the site from another device or browser using the host IP and port 3777
  - verify lobby and match WebSocket connectivity in production mode
  - verify restart behaviour via systemd

Important:
- This is the final stabilisation stage for the prototype
- Stop after Stage 8

