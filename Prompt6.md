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

Implement Stage 6 only, using the completed Stage 5 codebase as the starting point.

Stage 6 goal:
Add server-authoritative fog of war, per-player visibility, remembered map data, and enforce hidden-entity targeting rules.

Stage 6 scope:
- Implement per-player visibility calculation on the server
- Vision should come from:
  - Crystal
  - buildings
  - units
- The client should only receive or render enemy entities that are currently visible, or receive redacted state for hidden enemies depending on your chosen implementation
- Terrain and discovered resource node positions can remain remembered after exploration
- Hidden enemy units and buildings must not be targetable
- Existing visible enemy units that leave vision should disappear from active rendering
- Friendly entities should always be visible to their owner
- Add visual presentation for fog of war in the client:
  - dark unexplored
  - dim explored-but-not-currently-visible, if implemented
  - clear currently visible
- Keep the implementation simple and robust for a lane map

Implementation requirements:
- Fog must be server-authoritative
- Do not trust the client with hidden information
- Keep visibility code separate from rendering code
- Decide and document whether the server sends:
  - filtered state per player
  - or full state with redaction, but the client still must not receive hidden details unnecessarily
- Make sure command validation rejects commands against hidden enemy targets
- Ensure rematch resets explored state properly

Acceptance criteria:
- Each player only sees enemy units/buildings when in vision
- Previously discovered terrain and resource nodes can remain remembered
- Hidden enemy units cannot be attacked or targeted directly
- Moving units into vision reveals them correctly
- Leaving vision hides them correctly
- Rematch resets fog and exploration for the new round

Testing requirements:
- Add automated tests for:
  - visibility from units and buildings
  - reveal and hide transitions
  - hidden target command rejection
  - remembered resource nodes after exploration
  - rematch reset of exploration state
- Add manual verification steps for:
  - scout into middle and reveal enemy movement
  - fall back and verify hidden enemies disappear
  - attempt to issue a command against a hidden target and verify rejection
  - start rematch and verify fresh fog state

Important:
- Do not add stealth, detectors, high ground, bushes, or line-of-sight blockers
- Stop after Stage 6

