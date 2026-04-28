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

Implement Stage 4 only, using the completed Stage 3 codebase as the starting point.

Stage 4 goal:
Add free building placement within build zones, construction, production buildings, Supply Depot, Turret structure shell, and Worker repair. This stage should establish building rules and production infrastructure, but only minimal combat stubs where required. Full combat comes next.

Stage 4 scope:
- Implement buildings:
  - Barracks
  - Foundry
  - Supply Depot
  - Turret
- Crystal remains the HQ and worker producer
- Implement free placement:
  - building placement mode is entered from UI command buttons and optional hotkeys
  - a placement ghost/preview is shown
  - placement is only allowed inside the player's build zone
  - placement must not overlap existing entities
  - placement must not block the lane corridor or create an impassable wall
  - placement must respect minimum spacing rules
  - placement near the Crystal should respect a sensible no-build buffer if needed for clarity
- Implement construction:
  - Workers build structures
  - Buildings have cost and build time
  - Building is inactive until completed
  - Worker begins construction when assigned
  - Keep construction simple, one worker required, optional extra workers can be ignored for now
- Implement production:
  - Barracks trains Skirmisher and Gunner
  - Foundry trains Bruiser and Medic
  - Crystal trains Worker
  - Start with a simple single-item production queue per structure, unless an existing queue system is already cleanly in place
- Implement Supply Depot:
  - increases max supply when completed
- Implement Turret structure shell:
  - placeable and buildable
  - stats exist
  - targeting/combat can remain stubbed until Stage 5
- Implement Worker repair:
  - Workers can repair friendly buildings
  - repairing restores health over time
  - repairing costs resource proportional to health restored
  - if the player cannot afford the repair, repair pauses
- Add rally points for production buildings if practical in this stage, otherwise stub the data model and add the interaction in Stage 7

Implementation requirements:
- Building validation must be server-authoritative
- Add a pathing or lane-clear validation that prevents full lane blockage
- Keep building definitions data-driven
- Keep build costs, times, health, and footprint sizes in constants
- Make sure construction and repair are compatible with later fog and combat systems
- Add client rendering for under-construction buildings and completed buildings

Acceptance criteria:
- Player can enter build mode and place valid buildings in their build zone
- Invalid placements are rejected cleanly
- Buildings cannot be placed in the lane corridor or in a way that blocks movement
- Workers can construct buildings
- Completed Barracks and Foundry can train their respective units
- Supply Depot increases max supply when complete
- Workers can repair damaged friendly buildings and spend resources to do so
- Rematch fully resets all buildings and construction state

Testing requirements:
- Add automated tests for:
  - valid placement
  - rejection outside build zone
  - rejection on overlap
  - rejection for lane blockage
  - construction completion
  - production from completed buildings only
  - supply increase from Supply Depot
  - repair cost proportionality
  - rematch reset of building state
- Add manual verification steps for:
  - place each building type
  - attempt illegal placements
  - construct Barracks and Foundry
  - train units from them
  - damage and repair a building via debug or test hook
  - verify Supply Depot changes cap

Important:
- Do not implement full combat resolution yet
- Stop after Stage 4

