# CrystalFront Game Update Plan ("v0.6 refresh")

**Status:** APPROVED. All items signed off after review rounds 1–2 (see the decision log). Nothing is implemented yet; U0 is ready to start.
**Created:** 2026-11-10 · **Last updated:** 2026-11-10 (round 2 feedback incorporated)

## Project goal (set 2026-11-10)

> **Build an AI opponent that thinks on the fly: one that reacts to the player's decisions and changes its plan mid-match, instead of replaying a memorised "best path".**

That needs three things, and this whole plan exists to make them possible:

1. **Memory.** A policy that keeps track of what has happened earlier in the match: what it scouted, what it lost, what the opponent built.
2. **Varied opponents.** Training against many different, changing opponents (self-play league), so that no single memorised answer works.
3. **Hidden information worth reasoning about.** Line of sight, high ground and brush make scouting and remembering valuable. This game update supplies it.

There is also an option to evaluate in the later retraining plan: **a language model sets the high-level strategy and the trained RL policy carries it out.**

Every game-design choice below should be checked against this goal: does it create decisions worth adapting to?
**Supersedes:** `REVIVAL_PLAN.md` Task 3.2 onward. Training is paused, and Iteration 27's Option B is shelved. The bot will be retrained from scratch on the updated game, under a new ML plan written after this update ships (G-10).
**Follow-on:** a separate **3D visual skin plan** (`VISUAL_PLAN.md`, G-11) comes after this update. This plan only has to keep the engine "skinnable".

## How to use this document

Each proposal has a **Decision** line:

- `⬜ pending`: not yet reviewed
- `✅ approved`: implement as written
- `✏️ revise`: discuss and redesign
- `❌ rejected`: dropped, with the reason kept

Items marked **✅ (detail to confirm)** are approved in direction but have one or more specific sub-choices still open. These are listed under **Open questions** at the end.

The guiding principle: **fix the game first, then train on it.** The game has a structurally dominant strategy (rush down a single lane), and no reward shaping will make an agent find a counter the game doesn't offer.

### Ground rules from round 1 (apply everywhere)

- **No legacy obligations.** There are no live users. Break compatibility freely: the old ONNX bot, old replays, the old action table, old balance snapshots. No "Classic mode", no dual engines.
- **The game stays left-to-right, with horizontal scrolling only.** No vertical camera panning, ever.
- **One engine, two speeds.** Training runs the engine as fast as the CPU allows. Live play runs the identical engine paced to real time.
- **The engine stays renderer-agnostic.** Today's 2D canvas client and the future 3D skin (G-11) are both views of the same state stream.

---

## Findings from the code review that shape this plan

From reading the engine on 2026-11-10:

1. **The map is a 6000×600 corridor (10:1)** with no obstacles. There's one route, no flanking and no defender's advantage.
2. **Units move in straight lines and pass through buildings** (`engine/movement.ts`). Soft collision only applies between mobile units.
3. **Live games and training simulate different movement speeds.** Live (`liveMatchRunner.ts`) runs 4 sub-steps of `speed/5` plus `tick()`. `tick()` calls `processMovement(match, 100)` **twice** (before and after combat). So live moves units **2.8 × speed** per tick, while headless, training and replays move them **2.0 × speed**. Live units are about 40% faster than in every balance matrix and training run.
4. **A "move" order cannot disengage.** `commandedTicks = 1` is consumed in the same tick's `processCombat`, which auto-acquires an enemy in range and overrides the move. To be confirmed with a test in G-1.
5. **The client draws at 1:1 pixel scale.** The camera pans on X only, the 600 px map height fits the view, and a minimap already exists (X-axis drag only).
6. **(Found in U0.1) Training ran a stale engine.** Compiled Jun-9 `.js` copies committed next to the `.ts` sources were what `headless/dist/stdioVecRunner.js` imported at runtime. Tests and balance tools used the current `.ts` via tsx, so the trained bot and the balance matrix were measuring different engines. Fixed in U0.1 (stale files deleted, runner bundled from source, staleness guard widened). See diary 2026-11-10.
7. **The ML policy has no memory.** `training/ppo/policy.py` is a set-transformer over the *current* observation only (no GRU/LSTM/history). It reacts to what it sees this decision, but cannot remember what it scouted earlier or infer what the opponent is planning. That matters for the "thinking bot" goal (G-10).

---

## G-1: One engine, fast-forward training, real-time play, real move vs attack-move ✅ approved

**Simulation core:**
- `tick()` is the only thing that advances game state: one movement phase, then combat, and so on.
- Remove the second `processMovement` from `tick()`. Chase/follow movement is handled inside the single movement phase.
- Remove server-side `subStepMovement` from state advancement.

**Two clocks, same engine:**

| Mode | How ticks are driven |
|---|---|
| **Training / balance harness / replays (verification)** | `tick()` in a tight loop, unthrottled. The headless runners already do this; it just needs protecting as a guarantee (no wall-clock reads anywhere in engine code; add a lint/test guard) |
| **Live play** | `liveMatchRunner` calls `tick()` every 100 ms (10 Hz). The client **interpolates** positions between the last two ticks for smooth motion, so the server needs no sub-steps |
| **Replay viewer** | real time by default, with playback speed controls (0.5× / 1× / 2× / 4× / skip-to). Same `tick()` |

A determinism test asserts that the same seed and command log give an identical state hash in fast mode and paced mode.

**Order types:**
- **Move** ignores enemies until the unit arrives (needed for retreat and repositioning).
- **Attack-move** fights anything met on the way.
- **Right-click on an enemy** is an attack order.

The ML macro actions map onto these explicitly. Today's `retreat` becomes a real disengage.

**Retune:** set unit speeds once so real speed (now 1 × `speed` per tick) feels right, then confirm in a live game.

**Effort:** S–M.

---

## G-2: Map layout: horizontal map, dense "jungle" middle, embedded resource nodes ✅ approved (5000×900)

**Constraints (from round 1):**
- **Left-to-right only.** The whole map height is always visible, and the camera scrolls horizontally only.
- **No true lanes.** No corridor runs the length of the map. Movement choices come from **short, winding paths through obstacle clusters**, like the jungle areas of a MOBA, not from parallel highways.
- **Not a maze.** Any two points must connect without big detours. The generator enforces a **detour ratio**: shortest path ÷ straight-line distance ≤ ~1.35 for base-to-base and base-to-node routes. That number is to be tuned.
- **Density gradient:**
  - open ground around each base (room to build and defend)
  - obstacles thickening toward the centre
  - the **middle third is the densest**, made of pockets, short paths and chokepoints where fights over resources happen
- **Resource nodes are placed on purpose, not in the open.** Contested nodes sit **inside jungle pockets**: small clearings with 2–3 entrances, near a chokepoint, or on high ground overlooking a path. Holding a node means holding a position. Safe nodes stay near each base, slightly sheltered.

**Size: more vertical room without vertical panning.** The client switches from 1:1 drawing to **fit-to-height scaling**: render scale = view height ÷ map height. A taller map just draws slightly smaller.

**Chosen size: 5000×900** (Option B; the rejected alternatives were 6000×600 as now, and 6000×1000). That gives 45 nav rows at 20 px cells: room for 2–3 stacked pockets. The shorter width cuts travel time, which means faster matches and better RL credit assignment.

**16:9 requirement (round 2): the full map height must fit on any 16:9 display with zero vertical scrolling.**
- The render scale is computed from the **canvas area left after HUD space** at that resolution, and re-computed on window resize. Vertical scrolling is therefore impossible by construction.
- HUD panels must not eat so much height that units become tiny. Target: map scale ≥ ~0.65 at 1280×720 and ≈ 1.0 at 1920×1080. Prefer HUD overlays along the bottom edge over a reserved strip.
- At ~1.0 scale on 1920×1080, the visible horizontal slice is about 1900 of 5000 px. The minimap covers the rest.
- Test resolutions: 1280×720, 1366×768, 1600×900, 1920×1080 and 2560×1440. Also check non-16:9 windows (e.g. a snapped half-screen), which must still never scroll vertically; they just show a narrower horizontal slice.

**Minimap:** already exists. Update it to draw terrain, obstacles and fog (G-9b).

**Effort:** M.

---

## G-3: Navigation grid and solid buildings ✅ approved

- **Nav grid** at 20 px cells (5000×900 → 250×45 ≈ 11k cells). It stores walkability and movement cost.
- **What fills cells:**
  - static obstacles and terrain are written in at match start
  - **buildings are solid**: their footprint is blocked when placement starts and cleared when destroyed
- **Placement rule:** a building may not completely seal a crystal off from the enemy. Placement validation runs a flood-fill connectivity check. Partial walls, chokepoints and funnels are allowed.
- **Push-out:** units standing on newly blocked cells are pushed out (reuse `spawnOutside`).

**Effort:** M.

---

## G-4: Auto-navigation (pathfinding) ✅ approved

| Layer | Design |
|---|---|
| Global path | A* on the nav grid (8-connected, terrain-weighted), then **path smoothing** (line-of-sight string pulling) so units walk natural diagonals |
| Groups | one **flow field** per shared destination, followed by every unit in the group |
| Local avoidance | existing soft unit collision, plus a "steer around a blocked neighbour" nudge so chokepoints don't deadlock |
| Repathing | only when the target moves, the nav grid changes on the path, or a unit is stuck for N ticks |
| Unreachable targets | path to the nearest reachable cell |
| Determinism | integer costs, fixed neighbour order, stable tie-breaking, golden tests |
| Performance budget | flow fields cached per (target cell, nav-grid version). Under 10% throughput loss in `stdioVecRunner` |

**Player UX:** right-click → units path, with a short-lived path line on command. Shift-queue waypoints are deferred (G-9f).

**Effort:** M–L.

---

## G-5: Obstacles ✅ approved

Rock formations, cliffs/ridges and water all share one mechanic: blocked for movement and building. Rock and cliffs also **block line of sight** (G-6b); water does not, so you can see across a river but not walk across it. That gives each obstacle type a gameplay meaning, not just a look.

The generator rules from G-2 apply: open bases, dense middle, no lanes, no maze, every node reachable.

**Effort:** S on top of G-3/G-4.

---

## G-6: Terrain types ✅ approved

| Terrain | Movement | Effect |
|---|---|---|
| Open ground | 1.0× | none |
| **Rough** (mud / forest floor) | **0.6×** | none in v1 (a "brush" variant is an open question, see G-6b) |
| **High ground** | 1.0× (reached by ramps) | buildings on it get **+25% range and +25% vision**. **Units on it get +15% range and +15% vision** (approved round 2) |
| **Brush** (see G-6b) | 1.0× | concealment: units inside are hidden from enemies outside |

- Modifiers go in a new `TERRAIN` block in `shared/src/gameBalance.ts`.
- Pathfinding uses movement multipliers as edge costs.
- All numbers are starting hypotheses for G-8.

### G-6b: Line of sight and brush (moved here from G-9c, built alongside terrain) ✅ approved

| Rule | Behaviour |
|---|---|
| **Vision blockers** | rock and cliff cells block sight. Each vision source reveals only the cells it has an unobstructed line to |
| **High ground** | units on low ground **cannot see onto high ground** unless they have their own unit on it (or are attacked from it, which briefly reveals the attacker). Units on high ground see down normally. This is the classic defender's/ambusher's advantage and pairs with the building bonus above |
| **Implementation** | vision computed on a coarser **vision grid (40 px cells)** using per-source shadowcasting, once per tick per player. Fog of war (`engine/visibility.ts`) already filters observations per player, so LOS plugs into the same place. Deterministic, budgeted with G-4's benchmark |
| **Rendering** | fog drawn per vision cell, with soft edges in the client |

**Brush (concealment terrain), approved round 2: "used sparingly and not too close to resource nodes".**
- **Mechanics:**
  - normal movement speed
  - units inside are invisible to enemies outside it
  - a unit inside is revealed for ~2 s when it attacks, and to any enemy unit that is also inside the same brush patch
  - brush does not block sight *through* it (you can see past brush, just not into it)
  - buildings cannot be placed in brush
- **Generator rules:**
  - **Sparse:** total brush ≤ ~4% of map area, in a few small patches (≈ 3–6 per side), each no bigger than about a small squad's footprint.
  - **Away from nodes:** every brush cell is ≥ ~200 px from every resource node, so you can't camp a node unseen. Fights at nodes stay visible, and brush is for ambushing *routes* between them.
  - Never inside build zones or within ~300 px of a crystal.
  - Exact numbers are tuned during U4 map review.

---

## G-7: Map pool ✅ approved

- **Ship a fixed pool of tested maps.** There are no random maps in the lobby.
- The seeded generator is an **offline tool** that proposes candidates:
  1. generate a candidate
  2. validate it (G-2 rules: connectivity, detour ratio, density gradient, node placement, build-zone space)
  3. run a scripted-bot fairness check (mirror match 50% ± 10%)
  4. **the user manually plays and signs off every pool map** (round 2). The detour-ratio limit (~1.35) and the brush/density numbers are tuned from that feedback, not fixed in advance
  5. freeze it into the pool as a versioned JSON map file in the repo

A map enters the pool only with the user's sign-off, recorded in a pool manifest (`mapId`, `version`, date approved, notes).
- **Symmetry:** every pool map is **mirror-symmetric (left↔right reflection)** or **rotationally symmetric (180° around the centre)**. Rotational symmetry gives more variety, because blue's top pocket is red's bottom pocket, and it is just as fair. The generator supports both.
- **Pool size:** about 8–12 maps to start.
- **The lobby** picks a map (random from the pool, or chosen) and shows a thumbnail.
- **Replays** store `mapId` and `mapVersion`.

**Effort:** M–L.

---

## G-8: Balance pass (after G-1 to G-7 land) ✅ approved

Reuse Phase 1's tooling (`balance_report.py`, 9-bot round robin). Scripted bots need build placement that respects terrain; pathing comes free.

**Acceptance criteria:**
- No strategy wins over 70% against every other strategy.
- Rush is beatable by at least one non-rush strategy at ≥40%.
- Mirror matches are 50% ± 10% on **every** pool map.
- Under 15% of games time out.

**Approved levers to test:**
- **Replace the "hold 4500 resources" win.** Candidates:
  - (a) remove it and rely on the timeout tiebreak only
  - (b) node-control objective: hold ≥N contested nodes for T ticks

  Option (b) suits the "fight over embedded nodes" design. To be decided from data.
- **Crystal self-defence:** a short-range, low-DPS weapon so a lone early raider can't chip the crystal freely.
- **Supply per depot:** +3 → candidate +5.

Plus rush timing and the counter triangle, checked on real terrain.

**Effort:** M (iterative loop).

---

## G-9: Extras

| Item | Decision |
|---|---|
| G-9a: Classic mode for the old bot | ❌ rejected: no live users, no legacy to keep. The old ONNX bot and `MlBot` are retired until the new bot ships. Remove the dead paths during U0 |
| G-9b: Minimap with terrain, obstacles and fog | ✅ |
| G-9c: Line of sight | ✅ moved into **G-6b** (built with terrain, not deferred) |
| G-9d: Determinism and performance suite | ✅ golden replays covering pathing/LOS; connectivity property test over 1000 generated maps; fast-mode vs paced-mode hash test; headless throughput benchmark |
| G-9e: Replay version stamps | ✅ replays carry `engineVersion` + `mapId`/`mapVersion`. Old replays are simply dropped (no compatibility layer) |
| G-9f: Shift-queue waypoints and control groups | ✅ approved round 2, details below |

### G-9f detail: shift-queue and control groups

- **Shift-queue (engine):**
  - Shift+right-click appends orders to a per-unit **order queue** (move / attack-move / attack target), up to ~8 entries.
  - Shift-queued **build orders** for workers are included too.
  - The queue lives in engine state, so it is deterministic and replays exactly. Each queued leg is pathed with G-4.
  - A plain (non-shift) order clears the queue.
  - The client draws queued waypoints as a faint path line while the units are selected.
- **Control groups (client only, no engine change):**
  - Ctrl+1…9 assigns the selection, Shift+1…9 adds to a group, and 1…9 selects it.
  - Double-tapping the number scrolls the camera to the group (horizontally only).
  - Groups whose units all die are emptied.
- **ML:** the bot doesn't need either one (its macro actions already work on groups). The order queue just has to not break observation building.
- **Phase:** shift-queue lands in U2 (needs pathing); control groups land in U1 (any time, client only).

---

## G-10: ML implications: toward a "thinking" bot ✅ approved (details after the update ships)

**This is the project goal** (see the top of this document): a bot that **reacts to the player's decisions and changes its plan mid-match**, not one that replays a memorised best build.

To be honest about how that works: an RL policy is still a learned function. It "thinks" on the fly to the extent that it (a) **remembers** what it has seen this match, (b) was trained against **many different, adapting opponents**, so no single fixed answer works, and (c) **sees enough** to notice that the opponent changed plans. The current setup fails all three:
- the policy is memoryless (Finding 7)
- it was trained against a fixed ladder of scripted bots
- its observation is a single snapshot

**What the game update must provide so that's achievable:**
- **Partial information worth reasoning about.** LOS and brush (G-6b) make scouting and memory valuable. A memoryless bot will lose to a hidden army, which is exactly the training pressure needed.
- **Map-generic macro actions.** The generator outputs **named zone anchors** in `MapLayout` (own base, own pockets, centre pockets, enemy pockets, enemy base, each contested node). Bots and the agent target anchors by name on any pool map. The action table is rebuilt from scratch (no legacy constraint now).
- **Observation hooks:**
  - a coarse terrain/LOS grid (e.g. 50×9 cells × {blocked, rough, high, brush, currently-visible})
  - "last seen" memory of enemy structures
  - per-entity terrain-under-me
- **Speed:** fast-forward headless mode (G-1) stays within the G-4 budget.

**Direction for the later `ML_RETRAIN_PLAN.md` (not decided now):**
- a **recurrent or history-attending policy** (GRU/transformer over recent decisions)
- **self-play with a population/league** (the existing `league.py` PFSP), including exploiter agents that punish fixed strategies, instead of a 21-stage scripted ladder
- training on the map pool with held-out maps for evaluation
- possibly a hybrid where an LLM strategist sets high-level intent and an RL policy executes it. That's worth evaluating against pure RL in that plan

---

## G-11: 3D visual skin (Three.js), separate plan, after this update ⬜ placeholder

The goal is a cosmetic 3D client in the spirit of classic MOBA/MMO art direction: simple colours, stylised textures, low-poly **original** models and lighting. It sits on top of the 2D engine and is never used for training. It gets its own `VISUAL_PLAN.md` and design iteration after U6.

**Constraints this update must respect now, so the skin is a drop-in:**
- **Match start:** the state stream sends the **full static map once** (terrain types, height level per cell, obstacle shapes and kinds) so a 3D client can build geometry.
- **Per tick, each entity carries:**
  - **facing/heading**
  - an **action state** (`idle | moving | attacking | gathering | constructing | dying`)
  - attack/heal events with source/target (`attackLog` already exists)
- **High ground** has a real elevation level in map data, not just a flag, so the 3D view can model plateaus and ramps.
- **No gameplay logic in the client.** The canvas client stays a pure view (it largely is today). The 3D client becomes a second view, selectable in settings.

**Asset sources (user-picked, 2026-11-10):** Kenney packs (kenney.nl, released as CC0; confirm the licence file in each download and credit Kenney anyway):
- Models/textures: [mini-characters](https://kenney.nl/assets/mini-characters), [fantasy-town-kit](https://kenney.nl/assets/fantasy-town-kit), [mini-forest](https://kenney.nl/assets/mini-forest), [tower-defense-kit](https://kenney.nl/assets/tower-defense-kit), [nature-kit](https://kenney.nl/assets/nature-kit), [3d-road-tiles](https://kenney.nl/assets/3d-road-tiles)
- Audio: [interface-sounds](https://kenney.nl/assets/interface-sounds), [impact-sounds](https://kenney.nl/assets/impact-sounds), [rpg-audio](https://kenney.nl/assets/rpg-audio)
- `VISUAL_PLAN.md` should map each unit, building, node and terrain type to a specific model in these packs. Audio can also land in the 2D client, since it needs no 3D work.

---

## Sequencing

| Phase | Items | Gate before the next phase |
|---|---|---|
| **U0: Foundation** | U0.1 single source of truth for engine code (done), G-1, G-9d harness, G-9e, retire old `MlBot`/ONNX paths | fast-mode = paced-mode hash test passes; move/attack-move tests; `npm test` green; one live smoke game |
| **U1: Space** | G-2 (size + fit-to-height client), G-3, G-11 state-stream hooks, G-9f control groups | new map size playable with no vertical scroll at all test resolutions; buildings solid; connectivity check enforced |
| **U2: Movement** | G-4, G-9f shift-queue | pathing and order-queue golden tests; throughput within budget |
| **U3: Terrain & sight** | G-5, G-6, G-6b (LOS + brush), G-9b | hand-authored test map with every terrain type, LOS rule and brush rule plays correctly; LOS within budget |
| **U4: Maps** | G-7 | 1000 generated maps validate; pool of 8–12 frozen, **each one manually tested and signed off by the user** |
| **U5: Balance** | G-8 + bot updates | acceptance criteria pass on every pool map |
| **U6: Ship game update** | release notes, deploy | then `ML_RETRAIN_PLAN.md` (G-10) and `VISUAL_PLAN.md` (G-11) |

**Project rules carried over:**
- bump all 5 `package.json` files (`0.6.0` for this update)
- rebuild headless dist after source edits
- `npm test` green after every task
- one task per commit, prefixed with the task ID (e.g. `feat(G-4): …`), pushed immediately
- a diary entry at each phase boundary

## Open questions

None blocking. The remaining numbers (detour ratio, brush amount and spacing, terrain modifiers, balance levers) are tuned during U4 map review and the U5 balance pass.

## Decision log

| Date | Item | Decision | Notes |
|---|---|---|---|
| 2026-11-10 | (plan created) | n/a | round 1 |
| 2026-11-10 | G-1 | ✅ | plus fast-forward training / real-time play (same engine), and "thinking bot" goal recorded in G-10 |
| 2026-11-10 | G-2 | ✏️→✅ | 4000×2400 rejected: left-to-right only, no vertical panning; jungle-style pockets, denser middle, no full-length lanes, not a maze; nodes embedded at strategic spots |
| 2026-11-10 | G-3, G-4 | ✅ | as proposed |
| 2026-11-10 | G-5, G-6 | ✅ | as proposed |
| 2026-11-10 | G-7 | ✅ | fixed tested pool only (no random lobby maps); mirrored or rotationally symmetric |
| 2026-11-10 | G-8 | ✅ | all three levers approved for testing |
| 2026-11-10 | G-9 | ✅ | all extras approved; G-9a dropped (no live users / no legacy); LOS moved into terrain work (G-6b) |
| 2026-11-10 | G-10 | ✅ | retrain plan to be worked out after the update goes live |
| 2026-11-10 | G-11 | new | 3D Three.js cosmetic skin, separate plan after this update |
| 2026-11-10 | Project goal | ✅ | "thinking" bot (memory + varied opponents + hidden information) set as the project goal |
| 2026-11-10 | G-2 size | ✅ | 5000×900; must fit any 16:9 display with zero vertical scrolling |
| 2026-11-10 | G-6b brush | ✅ | approved; used sparingly and kept away from resource nodes |
| 2026-11-10 | G-6 high ground | ✅ | units get +15% range **and** +15% vision (buildings +25%/+25%) |
| 2026-11-10 | G-7 review | ✅ | user manually tests and signs off every pool map; detour ratio tuned from that |
| 2026-11-10 | G-9f | ✅ | shift-queue waypoints and control groups included |
| 2026-11-10 | U5/U6 | ✅ shipped v0.6.6 | G-8 lever (b) node-control win; balance gates pass (mirror per `--mirror --games 24`); release notes `docs/RELEASE_NOTES_v0.6.6.md`; deployed. Pool maps still await user sign-off |
| 2026-11-11 | G-10 plan | ✅ approved, not started | `docs/ML_RETRAIN_PLAN.md` v2 (audited against AlphaStar / OpenAI Five research), every item approved; execution guide `docs/ML_RETRAIN_IMPLEMENTATION.md`; user asked that work not begin yet |
| 2026-11-11 | Map sign-off + G-11 polish | ✅ shipped v0.7.1 | User approved all 10 pool maps (manifest `approved` dates); 4 cosmetic map themes (verdant, desert, haunted, frost) in 2D and 3D; 3D team colour on skirmisher/gunner/medic; combat effects; Kenney sound with a Settings toggle. See `docs/VISUAL_PLAN.md` |
| 2026-11-11 | Synchronised match start | ✅ shipped v0.7.2 | Matches wait in "spawn" until every human client has loaded (30 s timeout; a disconnect releases it); full-screen loading overlay; 3D models cached per page and preloaded from the menu |
| 2026-11-11 | G-12 UI rehaul plan | 📝 draft, awaiting sign-off | `docs/UI_PLAN.md`: direction A/B/C choice plus work items UI-1…UI-9; nothing implemented |
| 2026-11-11 | 3D default + README screenshots | ✅ shipped v0.7.3 | Web players get the 3D view unless they choose 2D (new `cf.view` key; old `cf.view3d` ignored); README gains battle and map-theme screenshots (`docs/screenshots/`) and a current Features list |
| 2026-11-11 | G-12 UI rehaul (UI-1…UI-9) | ✅ shipped v0.7.4–v0.7.9 | Direction A "Facet, lit": glass UI kit, boot screen with mute icon, live 3D menu backdrop, menu/match music, Settings modal with sub-menus (Debug inside), glass HUD and command card, lobby + per-player loading status, result card (Rematch/Replay/Menu), replay browser cards + dev table; 1280×720, contrast and reduced-motion pass; README UI screenshots |
| 2026-11-11 | Quit match | ✅ shipped v0.7.10 | Settings (Esc) → Quit match; PvP asks first ("counts as a loss"); forfeits end via the match-end callback (fixes double-counted win on leave/disconnect) with `winType: "forfeit"` |
| 2026-11-11 | G-10 M0 T1 balance gate (turtle dominant) | ✅ user decision | No game change now; rerun the matrix at T10 with the v2 scripted bots and decide there (`docs/balance/2026-11-matrix.md`) |
| 2026-11-11 | Rotate-map symmetry (G-10 M0) | ✅ shipped v0.8.3-ML | User chose B ("fix them now, before T7"): centred fog grid, rotate-aware path tie-break and boundary goals, per-tick position snapping; all 10 maps exactly symmetric in mirrored play; ENGINE_VERSION 13 hides older replays |
