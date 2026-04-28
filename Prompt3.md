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


Implement Stage 3 only, using the completed Stage 2 codebase as the starting point.

Stage 3 goal:
Add the lane map layout, resource nodes, worker gathering, supply, and basic economy. Keep the Crystal as the HQ and worker production source. Do not implement military production or building placement yet.

Stage 3 scope:
- Implement the actual v1 map layout data:
  - single lane
  - wider middle combat zone
  - mirrored layout
  - per-player build zones near each base
  - lane corridor marked as non-buildable
  - two safe resource nodes near each base
  - two contested resource nodes near the middle
- Represent resource nodes as finite entities with:
  - total capacity
  - remaining amount
  - max gatherer slots, configurable, default 3
  - owner-neutral
- Implement Worker gather behaviour:
  - player selects workers and right-clicks a resource node
  - worker claims a slot if available
  - worker gathers continuously at a fixed rate
  - income is added instantly to the player's resource balance
  - no drop-off mechanic
  - when node is depleted, assigned workers idle
  - if all slots are occupied, additional workers cannot gather that node
- Implement Crystal worker production:
  - Crystal can train Workers
  - Workers consume supply
- Implement supply cap:
  - player has current supply and max supply
  - training a unit requires available supply
  - Supply Depot will be added in the next stage, but the supply system itself must exist now
  - for this stage, give a sensible starting max supply constant
- Add simple client rendering for:
  - lane
  - build zones
  - resource nodes
  - workers
  - crystals
  - player resource total
  - player supply
- Add basic command support needed for this stage:
  - select worker
  - right-click resource node to gather
  - select Crystal
  - train Worker from Crystal via command panel button
- Tune starting economy for short web matches:
  - 3 starting workers
  - small starting resource bank
  - enough to support an early choice later, not an instant snowball

Implementation requirements:
- Resource income must be server-authoritative
- Node slot assignment must be enforced on the server
- Keep gather rates, node capacities, and slot limits in constants for easy balance changes
- Keep map geometry and build zones data-driven, not hard-coded into rendering only
- Design the supply system to work for later military units
- Ensure mirrored starting positions

Acceptance criteria:
- Both players spawn on mirrored ends with three workers and one Crystal
- Resource nodes appear in the correct locations
- Workers can be assigned to gather from nodes
- Gather income increases the correct player's balance over time
- Slot limits are enforced
- Depleted nodes stop gathering and idle workers
- Crystal can train workers if the player has resources and supply
- Supply and resource values render correctly in the client UI
- Rematch resets nodes, workers, resources, and supply state correctly while keeping score

Testing requirements:
- Add automated tests for:
  - mirrored map setup
  - node slot limits
  - continuous resource gathering
  - node depletion
  - worker idling after depletion
  - worker training cost and supply checks
  - rematch reset of economy state
- Add manual verification steps for:
  - gather from safe and contested nodes
  - attempt to overfill a node and verify rejection
  - deplete a node and verify workers idle
  - train workers from Crystal
  - verify UI resource and supply updates

Important:
- Do not implement barracks, foundry, turrets, combat, or fog of war yet
- Stop after Stage 3

