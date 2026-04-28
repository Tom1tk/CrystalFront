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

Implement Stage 4.5 only, using the completed Stage 4 codebase as the starting point.

Stage 4.5 goal:
Refactor the game from a one-screen map into a horizontally scrolling RTS world with a camera system and minimap foundation, while keeping the game as a single-lane map. This stage should establish the correct world-space, camera, and viewport architecture before combat and fog of war progress further. Also correct the Crystal so it is treated as a static building at the far end of each player's side, not as a movable unit, and prepare the world/input architecture for proper gradual unit movement in Stage 5.

Stage 4.5 scope:
- Expand the map from a one-screen layout to a world that is significantly wider than the viewport
- Target an initial world width of approximately 5 viewport widths, configurable for tuning between 4 and 6
- Keep the lane as a single horizontal battlefield
- Keep the gameplay area filling the available vertical space
- Camera movement should be horizontal only on the X axis
- Add a camera model with:
  - world-space viewport origin
  - clamped movement within map bounds
  - start-of-match position near the owning player's Crystal
- Refactor rendering so all entities and map features exist in world coordinates and are rendered through a camera transform
- Refactor input so clicks, drag selection, and contextual commands convert screen coordinates into world coordinates correctly
- Add horizontal edge scrolling:
  - moving the cursor near the left/right edges of the gameplay viewport scrolls the camera
  - edge thresholds and scroll speed should be configurable constants
- Add minimap foundation:
  - render a simple minimap representation of the full lane and major world objects
  - show the current viewport rectangle
  - clicking the minimap repositions the camera horizontally
  - no complex minimap interaction beyond click-to-pan is needed now
- Rebalance the map layout for the larger world:
  - increase starting distance between players significantly
  - reposition safe and contested resource nodes appropriately
  - preserve mirrored fairness
  - ensure travel time to first contact is noticeably longer than on the old one-screen map
- Keep all gameplay systems authoritative and world-based on the server
- Keep the renderer adaptable for future isometric presentation by isolating camera/render transforms
- Refactor the Crystal to be a static structure, not a mobile entity
- Place each player's Crystal at the far end of their side of the widened map
- Ensure the Crystal is handled as the player's HQ and win-condition structure
- Remove or reject any movement behaviour for the Crystal
- Ensure the camera start position and minimap representation treat the Crystal as a base structure
- Review entity typing so buildings and units are clearly separated before Stage 5 movement/combat work
- Prepare movement architecture so Stage 5 can implement gradual server-simulated movement rather than instant snapping
- Ensure input, world coordinates, and command handling distinguish between issuing orders and resolving motion over time

Implementation requirements:
- Do not change the core game rules beyond what is necessary for world size and camera support
- Keep map dimensions and camera values data-driven via constants/config
- Do not hard-code logic to a single viewport width
- Ensure drag selection and right-click orders still work after camera transform changes
- Keep minimap rendering simple and functional
- Ensure existing building placement and worker interactions still function correctly in the larger map
- Prepare this architecture so Stage 5 combat and Stage 6 fog of war can use it cleanly

Acceptance criteria:
- The game world is wider than the visible screen, targeting about 5 viewport widths by default
- The gameplay area remains vertically full while the camera scrolls only horizontally
- Edge scrolling works reliably left and right
- Clicking the minimap repositions the camera horizontally
- Selection and command input still work correctly with camera offset
- Players begin much farther apart than before
- Resource nodes and build zones remain valid and mirrored
- Existing systems from earlier stages still function after the refactor
- The Crystal is rendered and handled as a static building, not as a movable unit
- The Crystal is positioned at the far end of each player's side
- The Crystal cannot receive or perform movement
- The world and input architecture are prepared for gradual movement simulation in the next stage


Testing requirements:
- Add automated tests where practical for:
  - camera clamping
  - screen-to-world coordinate conversion
  - minimap click-to-camera mapping
  - mirrored map placement in larger world coordinates
- Add manual verification steps for:
  - pan camera left and right with screen-edge movement
  - click minimap to move camera
  - select units after moving camera
  - issue move/build/gather commands after camera movement
  - verify the map feels substantially wider and first contact takes longer

Important:
- This stage is architectural and should be completed before further combat/fog complexity
- Do not implement new combat systems here
- Stop after Stage 4.5

