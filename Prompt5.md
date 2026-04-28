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
  - IMPORTANT: The existing move command handler in server/src/match/matchEngine.ts processCommand() currently sets entity.x and entity.y to the target coordinates instantly. Remove this instant snap entirely. Instead, store a moveTarget field on the entity and resolve movement incrementally in tick() by advancing the entity toward moveTarget at its speed units per tick. Clear moveTarget when the entity arrives within 1 unit of the destination.
- Implement targeting:
  - right-click enemy unit/building to attack
  - right-click friendly damaged building with Worker to repair
  - right-click friendly damaged unit with Medic to attach and heal
  - IMPORTANT: The current client uses onClick (left-click) for both selection and commands. Migrate to the standard RTS pattern: left-click (onMouseDown with e.button === 0) handles selection only; right-click (onMouseDown with e.button === 2) issues contextual commands. Add an onContextMenu handler to the canvas that calls e.preventDefault() to suppress the browser right-click menu. Existing command-panel buttons for train and build remain left-click UI buttons and are unaffected.
- Implement idle auto-attack:
  - combat units and Turrets auto-acquire enemies that enter range
  - use the entity's existing range stat as the auto-attack detection radius; no separate aggro or vision radius is needed
  - a unit auto-acquires the nearest enemy within range and begins attacking; if no enemies are in range it remains idle
  - a unit may move to close into attack range of a detected enemy, but must not pursue beyond attack range + 50 units from its last commanded position; if the enemy escapes this leash, the unit stops and idles
  - Workers do not auto-attack under any circumstance
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
  - Medic has very low damage (retain the existing stat of 3 damage); it is a support unit, not a fighter
  - Turret applies the same counter multipliers as Gunner: effective against Bruiser, countered by Skirmisher
- Implement Medic behaviour:
  - manual heal targeting only
  - when assigned to a friendly target, Medic follows that target and stays within heal range
  - if the target dies, Medic becomes idle
  - if the target is full health, Medic should continue following but only heal when needed
- Implement Worker basic attack:
  - very weak, mostly irrelevant
  - Workers do not auto-attack; set autoAttackEnabled to false for Workers
  - Workers can only attack on explicit manual right-click command on an enemy
  - Workers must not interrupt gathering or construction to auto-attack nearby enemies
- Implement building and unit death handling
- Implement Crystal destruction as the match win condition
- Verify existing health bars render correctly for all entity types at correct world-space positions after the Stage 4.5 camera changes; add any entity types that are missing from the health bar rendering
- Add basic combat feedback sufficient for readability

Data model changes required:
- Add the following fields to MatchEntity in server/src/match/types.ts; update the shared Entity type in shared/src/types.ts to match:
  - moveTarget?: { x: number; y: number } — destination the entity is currently moving toward
  - attackTargetId?: EntityId — the entity currently being attacked (manual command or auto-acquired)
  - attackCooldown: number — ticks remaining until the next attack is allowed (initialise to 0)
  - healTargetId?: EntityId — Medic only; the friendly unit this Medic is following and healing
  - autoAttackEnabled: boolean — true for Skirmisher, Gunner, Bruiser, Medic, and Turret; false for Worker, Crystal, and all non-Turret buildings
- Add attackCooldown: number (ticks between attacks) to UnitDefinition and to all entries in UNIT_DEFS. Suggested values: worker 20, skirmisher 10, gunner 15, bruiser 8, medic 25
- Add damage?: number, range?: number, and attackCooldown?: number to BuildingDefinition. Set the Turret entry in BUILDING_DEFS to: damage 18, range 150, attackCooldown 12
- Extend CommandType in shared/src/types.ts and CommandEntry.type in server/src/match/types.ts to include "attack" and "heal". Ensure the game_command handler in server/src/index.ts forwards these types to processCommand()

Implementation requirements:
- Combat must be server-authoritative
- Counter multipliers should be data-driven constants
- Keep targeting and attack logic deterministic where practical
- Use clear ownership and allegiance rules
- Medic healing of units uses the "heal" command type; Worker repair of buildings uses the existing "repair" command type. These must not be conflated. Repair targets buildings only and costs resources. Heal targets units only and is free.
- Avoid over-engineered pathfinding for v1, but movement should be stable and readable
- Tune initial numbers for fast web matches, not long macro games
- Soft collision: after movement each tick, for every pair of mobile entities whose centre distance is less than the sum of their radii, push each entity directly away from the other by (radiusSum - distance) * 0.5 units. Apply to mobile units only, not buildings or Crystals. Run the separation pass at most twice per tick.
- Tick phase order inside tick(): (1) movement — advance all entities with a moveTarget toward their destination at their speed stat; (2) combat — resolve auto-attack acquisition and all attacks, including Turret attacks; (3) gathering; (4) construction and production; (5) repair and Medic healing; (6) death removal. Process all damage before any entity deletions within a single tick.
- Death handling: when an entity reaches 0 health during the combat phase, add its id to a local toRemove Set rather than deleting it immediately. After all combat, movement, and healing are resolved for the tick, delete each entry in toRemove from match.entities. When a unit dies, decrement the owning player's economy.supply by the unit's supplyCost. When a Supply Depot dies, decrement economy.maxSupply by the depot's supplyProvided and clamp economy.supply to the new max if it exceeds it.

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

