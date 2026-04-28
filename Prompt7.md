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

Implement Stage 7 only, using the completed Stage 6 codebase as the starting point.

Stage 7 goal:
Add the proper RTS interaction layer and gameplay HUD so the prototype is fully playable by two humans without debug-only workflows.

Stage 7 scope:
- Implement full selection interactions:
  - left-click select single unit/building
  - drag-box select multiple units
  - unlimited selection
  - optional shift-add/remove selection if clean to add now
- Implement right-click contextual commands:
  - ground: move
  - enemy: attack
  - resource node with Worker selected: gather
  - damaged friendly building with Worker selected: repair
  - damaged friendly unit with Medic selected: heal-follow attach
- Implement command card / action panel:
  - Crystal: train Worker
  - Barracks: train Skirmisher, Gunner
  - Foundry: train Bruiser, Medic
  - Worker: build structure buttons
  - building placement mode entry
- Implement building placement ghost and feedback if not already done cleanly
- Implement rally points:
  - Crystal, Barracks, and Foundry can set rally points with right-click while selected
  - trained units move to rally point on spawn
- Implement gameplay HUD:
  - own username
  - opponent username
  - score within current lobby session
  - current resources
  - current and max supply
  - ready/match phase indicators where relevant
- Implement selected entity panel:
  - name/type
  - health
  - build/train progress if applicable
  - current order if useful
- Implement end-of-match UI:
  - winner/loser state
  - rematch button
  - exit button
  - score display
- Ensure the game can be fully played without debug controls

Implementation requirements:
- Keep controls responsive and clear
- Prevent accidental command conflicts between UI clicks and world clicks
- Keep UI functional and readable rather than ornate
- Maintain separation between React UI state and simulation state
- Make sure selection and command issuing behave correctly under fog rules

Acceptance criteria:
- Two players can play a complete match using only intended UI and RTS controls
- Drag-select works reliably
- Right-click actions are contextual and correct
- Build/train actions are accessible from the command card
- Rally points work
- HUD shows usernames, score, resources, and supply
- End screen rematch and exit work with the existing lobby session correctly

Testing requirements:
- Add automated tests for:
  - selection state logic where practical
  - contextual command generation where practical
  - rally point assignment
  - end screen rematch/exit flows
- Add manual verification steps for:
  - full match from lobby to victory
  - build structures, train units, gather resources, repair, and heal
  - use rally points
  - complete rematch and verify score persists
  - exit to menu and verify lobby cleanup

Important:
- Keep polish practical and focused
- Stop after Stage 7

