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
Crystal requirements:
- The Crystal is a static building, not a unit
- It is positioned at the far end of each player's side of the map
- It acts as the player's HQ, worker production structure, and win-condition structure
- The Crystal cannot move and must never be handled as a mobile entity
- Destroying the enemy Crystal immediately wins the match
Movement requirements:
- Units must move gradually over time using server-authoritative movement simulation
- Unit positions must update incrementally based on movement speed, not snap instantly to destinations
- Buildings, including the Crystal, do not move
- Use simple lane-appropriate pathing and soft collision for v1 rather than complex full RTS pathfinding


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

Implement Stage 5 only, using the completed Stage 4 codebase as the starting point.

Stage 5 goal:
Add core unit movement, soft collision, targeting, combat, damage rules, counter relationships, turret attacks, Medic follow-heal behaviour, and Crystal destruction as the win condition.

Stage 5 scope:
- Implement unit movement commands:
  - right-click ground to move
  - selected units receive move orders
  - units move with simple pathing suitable for the lane map
  - use soft collision / light separation, not complex hard collision
  - Implement gradual server-authoritative unit movement over time
  - Units must not snap instantly to the destination on move order
  - Movement must use per-unit move speed and tick-based position updates
  - Buildings, including the Crystal, are static and never enter movement logic
  - Use simple lane-suitable movement/pathing with soft collision and light separation
- Implement targeting:
  - right-click enemy unit/building to attack
  - right-click friendly damaged building with Worker to repair
  - right-click friendly damaged unit with Medic to attach and heal
- Implement idle auto-attack:
  - combat units and Turrets auto-acquire enemies that enter range
  - they do not chase beyond sensible leash/order logic unless directly commanded
- Implement unit combat stats:
  - health
  - damage
  - attack speed
  - attack range
  - move speed
  - target filters where needed
- Implement strong counter logic:
  - Skirmisher beats Gunner
  - Gunner beats Bruiser
  - Bruiser beats Skirmisher
  - Medic low damage or no damage, dedicated healer
  - Turret uses ranged damage profile similar to Gunner
- Implement Medic behaviour:
  - manual heal targeting only
  - when assigned to a friendly target, Medic follows that target and stays within heal range
  - if the target dies, Medic becomes idle
  - if the target is full health, Medic should continue following but only heal when needed
- Implement Worker basic attack:
  - very weak, mostly irrelevant
- Implement building and unit death handling
- Implement Crystal destruction as the match win condition
- Add simple health bars and selected-entity info in the client
- Add basic combat feedback sufficient for readability

Implementation requirements:
- Combat must be server-authoritative
- Counter multipliers should be data-driven constants
- Keep targeting and attack logic deterministic where practical
- Use clear ownership and allegiance rules
- Ensure support and repair logic do not conflict
- Avoid over-engineered pathfinding for v1, but movement should be stable and readable
- Tune initial numbers for fast web matches, not long macro games

Acceptance criteria:
- Units can move and attack via commands
- Idle combat units auto-attack enemies in range but do not roam
- Counter relationships are visible in outcomes
- Medic can be assigned to a friendly unit and follows/heals correctly
- Workers can still repair buildings
- Turrets attack enemies in range
- Destroying the enemy Crystal ends the match and updates score
- Rematch resets combat state correctly
- Units visibly travel over time toward their commanded destinations
- Units do not teleport or instantly snap to move targets
- The Crystal remains static and functions only as a structure/HQ/win condition

Testing requirements:
- Add automated tests for:
  - move command application
  - attack command application
  - idle auto-attack in range
  - counter damage multipliers
  - Medic target-follow-heal behaviour
  - worker repair still functioning
  - turret attack behaviour
  - Crystal destruction ends match
  - rematch reset after combat
- Add manual verification steps for:
  - build army, move units, and attack manually
  - observe counter triangle effectiveness
  - assign Medic to a bruiser and verify follow-heal
  - use turret defence
  - destroy a Crystal and verify end-of-match flow

Important:
- Do not implement fog of war yet
- Stop after Stage 5

