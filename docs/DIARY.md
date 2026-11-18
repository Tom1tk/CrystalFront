# CrystalFront development diary

Chronological, oldest first. One entry per shipped step: what changed, why, how it was checked, and what the user decided. Entries before 2026-11-10 (the v1 PPO bot, Phases 0–3 of the revival plan) are in `archive/ML_BOT_ACTION_PLAN_v1.md`.

Current plans: `GAME_UPDATE_PLAN.md` (game, decision log at the end), `ML_RETRAIN_PLAN.md` + `ML_RETRAIN_IMPLEMENTATION.md` (G-10 bot retrain).

### 2026-11-10 — v0.6.0: Game update plan approved; U0.1 finds training ran a stale Jun-9 engine

**Context.** The project pivoted from Task 3.2 training to a base-game refresh (`docs/GAME_UPDATE_PLAN.md`, approved after 2 review rounds). Training is paused, Iteration 27's Option B is shelved, and the bot will be retrained from scratch on the updated game. New project goal: an adaptive "thinking" bot (memory + varied self-play opponents + hidden information).

**Finding (U0.1): every Phase 3 training run used a stale engine.** Compiled `.js` copies of the engine, shared and headless sources had been committed next to the `.ts` files on 2026-06-09 (31 files under `server/src`, `shared/src`, `headless/src`). `build:headless` compiled only `headless/src` without bundling, so `headless/dist/stdioVecRunner.js` imported `../../server/src/match/matchEngine.js` at runtime: the **Jun-9 compiled copy**, not the current TypeScript. The Python staleness guard only checked `headless/src/*.ts`, so it never fired. tsx-based tools (`npm test`, `balance_report.py` via `cli.ts`) resolved to the current `.ts`. Consequences:
- **Balance matrices and tests (Phase 1) measured the current engine; training (Tasks 3.1/3.2, Iterations 19–26) ran a Jun-9 engine.** That engine was missing the Jun-10/11 engine changes: the Task 1.2 timeout tiebreaker, the Task 1.3 crystal regen (`repair.ts`), the gathering/movement fixes (including the H5 `entityIdNum` collision-order fix), and the Jun-10 `DEFAULT_CONFIG`.
- Balance *numbers* were current (they come via `@crystalfront/shared` → `shared/dist`, which was rebuilt Jun 11); only engine *logic* was stale.
- This may explain part of the Phase 3 behaviour gap versus balance-matrix expectations. It is moot now (full retrain on the new game), but it is recorded so that no future agent trusts Phase 3 curves as evidence about the current engine.

**Fix (commit `chore(U0.1)`):**
- deleted all 31 tracked `src/*.js` files
- `build:headless` now **bundles** `stdioVecRunner.ts` with esbuild, with `@crystalfront/shared` aliased to `shared/src`, so the runner always contains the current engine
- the staleness guard now covers `headless/src`, `server/src` and `shared/src`
- version 0.6.0 in all 5 `package.json`

Verified: `npm test` 470/470, `training.test_env` PASS, `test_config_persistence` PASS, and the bundled runner contains the tiebreaker code.

### 2026-11-10 — v0.6.1: U0 complete (foundations)

**Done (all on `CrystalFront-ML`, each pushed):**
- `chore(U0.1)`: stale compiled engine removed, headless bundle (entry above).
- `chore(U0.2)` `2125cb0`: v0.3.2 ML bot retired (MlBot, ONNX models, onnxruntime-node, menu entries). Python export/parity tooling kept for the future bot.
- `feat(G-1a)` `f0907da`: one movement step per 100 ms tick (sub-stepping removed); unit speeds doubled to px/tick so real-time speed is unchanged.
- `feat(G-1b)` `35d9fa6`: `moveOrder` replaces `commandedTicks`; plain move ignores enemies until arrival; new `attack_move` command; client A = attack-move, R = toggle auto-attack. Old engine failed all 7 G-1 checks.
- `test(G-1c/G-9d)` `b49ce31`: injectable clock, `hashMatchState()`, static wall-clock guard, fast-vs-paced (LiveMatchRunner) hash equality test.
- `feat(G-9e)` `ee56a74`: `ENGINE_VERSION` (=1) stamped in all replay writers; mismatched replays are ignored on list/load.
- `test(G-9d)`: `npm run bench` throughput benchmark. **Baseline: ~5,800 ticks/sec** (12 seeded matches, macro/rush/turtle mix, 61,689 ticks, this machine). G-4 budget = no worse than ~5,200.

**Balance (moved by G-1, left for G-8):** blue win rate rush-macro 0.50, rush-turtle 1.00, macro-turtle 0.85, turtle-macro 0.20 (20 games/pair).

**Deferred within G-9d:** golden pathing/LOS replays (U2/U3) and the 1000-map connectivity test (U4), since the features they cover don't exist yet.

### 2026-11-10 — v0.6.2: U1 complete (map size, solid buildings, stream hooks, control groups)

**Done (all on `CrystalFront-ML`, each pushed):**
- `feat(G-2)` `1537610`:
  - Map is now 5000×900 (`ENGINE_VERSION` 2), drawn fit-to-height with no vertical camera.
  - Soft collision is now order-independent (Jacobi). The size change had exposed a mirror-invariance failure.
  - Checked in headless Chromium: no vertical scroll at 1280×720, 1366×768, 1600×900, 1920×1080, 2560×1440 or 960×1000.
- `feat(G-3)` `0e2de58`:
  - 20 px nav grid (250×45).
  - Buildings and crystals are solid; units are pushed out of their footprints.
  - The no-seal placement rule ("Would seal off a crystal") is enforced through a 4-connected flood fill.
- `feat(G-11)` `59dc6d5`:
  - Each entity now carries `heading` and `actionState` (idle/moving/attacking/gathering/constructing/dying).
  - `staticMap` (nav grid dimensions) goes out once on MATCH_START.
  - Both values are derived at serialisation time, so the sim, hash and mirror are unaffected.
  - This commit also fixed the G-3 walk-through test. It sent `entityIds` and never actually moved the unit; it now moves and still passes.
- `feat(G-9f)`: control groups (client only). Checked in the browser: assign, recall, and double-tap camera jump.

**Gate:** no vertical scroll at any test resolution ✔; buildings solid ✔; connectivity check enforced ✔. `npm test` 506/506.

**Known / carried forward:**
- Bench after G-3 is ~5,100 ticks/sec. The workload changed: units now collide with buildings.
- Rush-vs-rush and macro-vs-turtle samples now time out at 6000 ticks. Units snag on buildings because there is no pathing yet; G-4 (U2) addresses this.
- The hotkey grid overlays the bottom-left of the map.

### 2026-11-10 — v0.6.3: U2 complete (pathfinding, shift-queue)

**Done (all on `CrystalFront-ML`, each pushed):**
- `feat(G-4)` `c86bba6`:
  - A* on the nav grid, using scratch buffers stamped by generation. A heap decrease-key bug that broke mirror invariance was fixed.
  - Flow fields for group moves.
  - A blocked goal is retargeted to the nearest free point.
  - Paths are compressed to turning points and then string-pulled.
  - Stuck detection is now progress-based.
  - Group arrival: a stuck unit near its goal that is touching an idle unit counts as arrived.
  - The path is sent only to the unit's owner. The client draws a dashed green line for 1.2 s after a move.
  - `ENGINE_VERSION` 3.
- `feat(G-9f)` `7ab8cf3`, shift-queued orders:
  - Shift+move, attack-move, attack or build on a busy unit appends to a per-unit queue (max 8). An order without Shift clears the queue.
  - Queues are drained in tick Phase 0 and are mirror-safe.
  - Shift+build keeps build mode.
  - Selected units show dotted queue lines.
  - `ENGINE_VERSION` 4.

**Gate:** pathing and order-queue golden tests ✔ (21 new, `npm test` 527/527). Throughput ✔: the bench runs at 5,315 ticks/sec, against ~5,100 before G-4.

**Balance check after G-4** (scripted 3×3, 20 matches per cell; blue win rate):

| blue \ red | rush | macro | turtle |
|---|---|---|---|
| rush   | 0.55 | 1.00 | 0.70 |
| macro  | 0.00 | 0.35 | 0.75 |
| turtle | 0.25 | 0.35 | 0.65 |

- Pathing removed the snag timeouts only partly:
  - Rush-vs-rush went from 15 timeouts to 12.
  - macro-vs-macro (18), macro-vs-turtle (19) and turtle-vs-macro (16) still mostly time out.
  - turtle-vs-turtle is still 20/20 resource wins.
- Rush got markedly stronger now that units path cleanly: it won 20/20 against macro, and rush-vs-macro games average about 2,150 ticks.
- These are U5 (G-8) problems, not pathing bugs. The fixes are the win-condition rework and the rush counter-levers.

### 2026-11-10 — v0.6.4: U3 complete (terrain, line of sight, minimap)

**Done (all on `CrystalFront-ML`, each pushed):**
- `feat(G-5)` `c243fda`, terrain grid and obstacles:
  - New `engine/terrain.ts` (per-nav-cell codes: open, rock, rough, high, cliff, brush) and `match/maps.ts` with the `classic` map (no terrain) and a mirror-symmetric `testbed` map that has every terrain type.
  - Rock and cliff cells block the nav grid. `CF_MAP=testbed` selects the map on the server; `bench.ts --map ID` does the same headlessly.
  - `ENGINE_VERSION` 5.
- `feat(G-6)` `4fc8a8d`, rough and high ground:
  - Rough: ×0.6 speed and a higher A* step cost (17/24 vs 10/14). Direct-line and string-pulled shortcuts may not cross rough cells the A* route avoided.
  - High ground: range ×1.15 for units and ×1.25 for buildings (on base range, not radius), and vision ×1.15.
  - `ENGINE_VERSION` 6.
- `feat(G-6b)` + G-9b `a5a25a1`, line-of-sight fog and minimap:
  - Vision is resolved on a 40 px grid with cached per-source LOS sets. Rock blocks every ray. Low-ground sources can't see elevated cells, and elevated cells block their rays. High-ground sources are blocked by rock only (cliffs don't block high-ground sight — a design choice).
  - Brush hides units from anyone without their own entity in the same brush patch. Attackers are always revealed to their victim's owner.
  - Combat respects visibility: auto-acquire skips hidden targets, buildings drop hidden targets, units chase but don't fire.
  - The server sends each player their lit cells as a base64 bitset. The client draws soft cell-based fog (old circle fog kept as fallback), and the minimap shows terrain and the same fog.
  - `ENGINE_VERSION` 7.

**Gate:** a test map containing every terrain type ✔ (`testbed`). Terrain, LOS and brush golden tests ✔ (36 new across G-5/G-6/G-6b; `npm test` 563/563). LOS within budget ✔: bench 4,901 ticks/sec on testbed vs 5,358 on classic (−8.5%, under the 10% budget).

**Testbed observations (scripted bots, 6 seeds, maxTicks 6000):**
- Most matches time out on testbed, including rush-vs-macro, which rush wins in ~2,100 ticks on classic.
- Not caused by the visibility gating: with gating turned off (temporary A/B hack, reverted) rush-vs-macro still mostly timed out.
- Death positions show a grinding front at x≈2,500–3,800 along the y≈350–400 lane: units reach the choke one at a time and trade evenly with the defender, who reinforces faster.
- This is a U5 (G-8) problem: the bots need to group up before attacking, and the map pool (U4) must avoid chokes that give the defender this much edge.

### 2026-11-10 — v0.6.5: U4 built (map generator and pool), pool awaiting sign-off

**Done (all on `CrystalFront-ML`, each pushed):**
- `feat(G-7)` `4431e1c`, generator, validator, pool tool, lobby picker:
  - Terrain gains "rotate" symmetry (180° about the centre), "open" shapes that carve, and per-map contested node positions.
  - `mapgen.ts`: a seeded generator with an open base, a sparse approach band, and a dense middle band (node pockets, an optional high-ground plateau, water, mud, brush). Failed candidates are retried with sub-seeds.
  - The validator checks clearance, enclosed pockets, 3-cell-wide routes, a detour of ≤ 1.35 (base and every node), the density gradient, an open build zone and node shelter.
  - `headless/src/mapPool.ts survey|freeze` writes `pool/*.json`, a manifest with `approved: null`, and a generated `pool/index.ts`.
  - The lobby host picks a map or "random pool" (`SET_MAP`, which un-readies both players). The bot menu has the same picker, and `GET /api/maps` serves thumbnails.
  - Replays stamp `mapVersion`, and replays from other map versions are dropped. `ENGINE_VERSION` 8.
- `feat(G-7)` `773cd3d`, user feedback on the first previews:
  - Terrain now starts 500 px from each crystal (only x < 600 is kept open; the 20% build zone must still be ≥ 95% open).
  - Twice as many contested nodes at half the size: 4 per side (a near and a far pair) plus an optional centre node, each holding `NODES.poolContestedCapacity` = 150. Classic and testbed are unchanged.
- `feat(G-7)` `608c0e3`, the candidate pool: 10 maps, 5 mirror (glimmerfen, saltmarsh, ironreed, duskvale, cinder-flats) and 5 rotate (shardfall, basalt-run, twin-spires, hollow-crown, prism-ridge). All have `approved: null`.

**Gate:** 1000 generated maps validate ✔ (test G-7, ~30 s). Pool of 8–12 frozen ✔ (10). **User sign-off of each map: pending.** `npm test` 602/602.

**Observations:**
- Fairness was measured with rush and macro mirror matches, 24 games per map. Pool maps score blue 0.42–0.58.
  - At this sample size the standard error is about ±0.1, so "unfair" seeds in the survey are mostly noise. Re-surveying the same seed moved scores by up to 0.16.
  - Across all seeds blue averages about 0.53, which looks like a small tick-order bias rather than a map effect.
- Turtle mirrors were left out of the fairness check. They end in the "hold 4500 resources" win, which tick parity decides (blue 6/8 even on classic). U5 replaces that win.
- 12–21 of 24 mirror games time out at 6,000 ticks on pool maps (the same grinding pattern as on testbed). This is U5 work: grouping up before attacking, and the win-condition rework.
- Node regen is still a flat 0.2/tick per node, so doubling the node count doubles passive regen on pool maps. This is a U5 balance lever.

### 2026-11-10 — v0.6.6: U5 complete (G-8 win condition and balance)

**Done (all on `main`, each pushed; `CrystalFront-ML` was merged into `main` and deleted):**
- `feat(G-8)` `017f201`: node control replaces the "hold 4500 resources" win.
  - Each contested node has a controller: the side with a unit in range when the other side has none. Holding a majority of the contested nodes fills a control bar, and a full bar wins.
  - New `headless/src/balance.ts`: the strategy matrix, per-map mirror scores, win types, and the 4 G-8 gates.
  - Pathing tie-breaks are now equivariant (mirror-safe). Fixes to scripted-bot production and attack logic.
  - Client: control rings on nodes, a NODES HUD stat, and the win type on the end screen. `match_end` carries `winType`.
- `docs(G-11)` `83f2975`: the user's Kenney asset packs are recorded for the 3D skin and audio.
- `feat(G-8)` `74e996a`: control progress is cumulative.
  - The holder gains +1 per tick and the opponent loses 1. Progress pauses when no side has a majority, and a side wins at `CONTROL.holdTicks` = 600.
  - Only combat units hold nodes (turrets defend but don't hold).
  - The timeout tiebreak order is: crystal HP fraction → nodes held → combat army supply → lifetime resources → seed parity.
  - The bots now contest nodes (`bots/controlTarget.ts`). They take the nearest unheld node until they have a majority, leave 2-unit garrisons on held nodes, and regroup at a stage node before pushing. TurtleBot and MacroBot build a second barracks. HeavyBot's duplicate-turret and retreat bugs are fixed.
- `fix(G-8)` `9553184`: on 180°-rotated maps, red's safe nodes and worker spawns are now rotated. Before this they were only x-mirrored, so the two sides' "nearest safe node" choices differed and mirror matches were biased.
- `chore(U5)`: v0.6.6, `ENGINE_VERSION` 10 (safe-node positions changed on rotate maps).

**Gate (balance.ts; 10 pool maps, maxTicks 6000):**
- Full matrix, 960 games, 6 seeds per side:
  - No strategy wins >70% against every other ✔ (turtle is 100/57/100, held below by macro).
  - Rush is beatable ✔ (turtle 100%, macro 63%, heavy 78%).
  - Timeouts 13% ✔ (<15%).
  - Win types: control 61%, combat 26%, timeout 13%.
- Mirror, 960 games, 24 seeds per side: blue scores 0.44–0.55 on every map ✔.
  - The full-matrix run has only 24 mirror games per map (standard error ≈ ±0.1); shardfall reads 0.33 there. The dedicated mirror run has 96 games per map and is the gate of record.
- `npm test` 613/613.

**Observations:**
- Matrix (row's score vs column): rush 38/0/22 vs macro/turtle/heavy; macro 63/43/92; turtle 100/57/100; heavy 78/8/0.
  - The counter triangle is only partly there: turtle beats rush and heavy outright, and only macro contests it.
  - Real players will also behave differently from these scripted bots. Treat the matrix as a smoke test for degenerate strategies, not a tuning target.
- Mirror-only timeouts are still high (rush-rush 45%, turtle-turtle 54%). Equal scripted bots stall each other on node majorities, while games between different strategies resolve.
- Spawn angles for trained units use each slot's own RNG, so mirror games diverge from the first worker trained. That is fair noise, not bias, and it averages out across seeds.
- Not changed: supply per depot (+3), crystal self-defence, and node regen (still 0.2/tick per node, so more nodes means more passive regen). None was needed to pass the gates. They remain levers if live play shows rush or turtle problems.

### 2026-11-10 — G-11: 3D skin, first pass (v0.7.0)
- `feat(G-11)` `58b0d84`: an optional Three.js view (`client/src/three/World3D.ts`), toggled with F3 or the 3D/2D button. Design and model mapping are in `docs/VISUAL_PLAN.md`.
  - **Rendering:** an orthographic camera at 55° that is pixel-aligned with the 2D view. The 2D canvas stays on top as the input/HUD/fog overlay. Kenney CC0 models, team colours from a colormap hue shift, animation from `actionState`/`heading`.
  - **Assets:** pruned to the 35 models in use (about 2.2 MB). The dev-only model gallery was removed.
- **Bug found while making showcase replays:** `getReplay()` dropped `mapId`, so every pool-map replay played back on `classic` and diverged. Fixed, with a regression test. `npm test` 614/614.
- **Showcase:** headless bot-vs-bot games were saved as replays (ironreed macro–turtle, shardfall rush–macro, twin-spires heavy–rush) and screenshotted in 3D under SwiftShader.
- **Open:**
  - performance on a real GPU;
  - audio packs;
  - ramps and effects;
  - team colour is weak on the skirmisher and gunner models (hair and helmet colours aren't in the recoloured hue range), so the rings carry team identity.

### 2026-11-11 — G-10: retrain plan v2 approved; hand-off prepared (no implementation yet)
- **What happened:**
  - `docs/ML_RETRAIN_PLAN.md` v1 was drafted, then audited at the user's request against the AlphaStar, OpenAI Five, ROA-Star and microRTS (RAISocketAI, UECD) literature and against the harness code. The audit found 14 problems (F-1…F-14 in the plan); v2 replaces v1.
  - The user approved every item (P-1…P-10, R-1…R-11) and answered the five open questions (plan §13).
  - The user asked that **work not begin yet**. This session was planning and research only.
  - `docs/ML_RETRAIN_IMPLEMENTATION.md` is the execution guide for the implementing agent.
  - `ML_AGENT.md`, `REVIVAL_PLAN.md` and `training/README.md` now carry stale/superseded banners.
- **Measured for the plan (no code changed):**
  - Bench: 3,232 ticks/s on classic, about 2,100 on pool maps (5,315 on classic at U2). Profile: `tick` self 25%, movement 19%, visibility 11%, pathfinding ~10%, observation 6%.
  - Game length with an 18,000 cap (5 bots, 3 maps, 4 games per pairing): 2,591–13,829 ticks, no timeouts. The 6,000 cap used so far cuts real games short.
  - Turtle won most pairings by control in that sample, consistent with the U5 gate matrix (turtle 100/57/100).
- **Facts that were wrong in earlier notes:** the harness has no self-play (the learner is hard-wired as blue; checkpoint opponents were never playable), and the live server has no neural inference (no `models/`, no ONNX runtime).
- **Next:** wait for the user's go-ahead, then M0 task T0 in the implementation guide. The 3D polish the user approved earlier is also still pending.

### 2026-11-11 — G-11 polish and map themes (v0.7.1); all maps signed off
- **The user signed off all 10 pool maps** and asked for colour themes so maps are easier to tell apart. Manifest `approved` dates are set, so P-10 is done. Re-freezing a map resets its approval, which is intended.
- **Map themes** (`client/src/mapThemes.ts`) are cosmetic only. There are four:
  - verdant: ironreed, twin-spires, glimmerfen;
  - desert: basalt-run, saltmarsh, cinder-flats (the maps with no water);
  - haunted: duskvale, hollow-crown;
  - frost: shardfall, prism-ridge.
  Each theme sets the 2D palette, map-picker thumbnails, 3D ground, lighting and foliage/rock tints.
- **3D polish** (approved earlier as "yes to all"):
  - team colour on the skirmisher, gunner and medic (green and grey gear recoloured);
  - muzzle flashes, tracers, hit sparks and heal motes from `attackLog`;
  - Kenney CC0 sound (`client/src/audio.ts`) in both views, with a Sound toggle in Settings.
- **Bugs found while verifying the effects** with a debug-spawned fight in Solo Test:
  1. Effects and sounds only played events at most 2 ticks old. At replay speed or a low frame rate, more ticks pass per frame, so almost everything was skipped. Now every unseen event plays, and a jump (first frame, seek) is skipped.
  2. Short-lived effects expired within a single slow frame. The effect timestep is now capped at 1/20 s.
  3. Sparks on crystals and buildings were hidden inside the model and tinted by the crystal glow. They now hit the near face and draw last.
- `npm test` passes; deployed.
- **Still open from the user's 3D audit:** performance on a real GPU, click alignment, a live 2-player game in 3D.
- **Next:** wait for the user's go-ahead on G-10 M0 (T0 in `docs/ML_RETRAIN_IMPLEMENTATION.md`).


### 2026-11-11 — Synchronised match start and UI plan (v0.7.2)
- **The user reported** that a match showed the old 2D graphics for a few seconds before the 3D view appeared. They asked for a loading screen that waits for both players before the match starts.
- **Load gate (server).** New matches now stay in the "spawn" phase, with no ticks, until every human client sends `client_loaded`. This lives in `server/src/match/loadGate.ts`. It covers Solo Test, bot games and PvP. Two cases release the match early: a 30 s timeout, and a player disconnecting while loading (the normal forfeit then applies). Unit tests are in `tests/index.ts` (`loadGateTests`).
- **Client.**
  - The game screen opens on the "spawn" phase.
  - `GameShell` shows a full-screen overlay: "Loading battlefield", then "Waiting for opponent". It reports `client_loaded` once the chosen view can draw: 2D at once; 3D after its models load, or after the load fails. The overlay then fades out when the first tick arrives.
  - 3D models load once per page (`preloadModels()` in `World3D.ts`). The menu starts the load early when 3D is the saved preference.
  - Replays show the overlay only until assets are ready. Replay frames keep streaming meanwhile.
- **Verified on the live build:**
  - Solo Test in 3D: overlay at SPAWN tick 0, then the match runs.
  - Two-browser PvP: both clients start on the same tick.
  - Raw-socket test: the match stays at spawn@0 while one client has not loaded, and starts (playing@14 on both) once both have.
- **Already existed (told the user):** the Sound on/off toggle in Settings, and the host's map picker in the lobby.
- **UI rehaul:** plan drafted in `docs/UI_PLAN.md`, waiting for the user's direction choice. Not started.
- **Next:** the user's answers on `docs/UI_PLAN.md`; G-10 M0 still waits for "start".

### 2026-11-11 — 3D by default and README screenshots (v0.7.3)
- **The user asked** for the README to be updated with "action" screenshots of two opponents and of the map variations, and for 3D to be the default for web users.
- **3D default.** The view preference now lives under a new key, `cf.view` ("3d" or "2d"); without it, players get 3D. The old key `cf.view3d` is ignored, because older builds wrote "0" there for every player who never chose. `?view=` still overrides. The Settings toggle now reads the same helper, so it shows ON when the page was opened with `?view=3d`.
- **Verified on the live build** in a fresh browser: Settings shows ON; it stays ON with a legacy `cf.view3d=0`; turning it off stores "2d" and survives a reload; `?view=3d` beats a stored "2d".
- **Screenshots.** Bot-vs-bot replays (heavy/macro bots) were generated on 8 maps; frames at the biggest fights were captured in 3D at 2560×1440 and cropped. They are in `docs/screenshots/`: four battles (shardfall, cinder-flats, glimmerfen, duskvale) and one map per theme (twin-spires, basalt-run, hollow-crown, prism-ridge). The 13 test replays were deleted afterwards.
- **README:** screenshots section, an up-to-date Features list (3D/F3, map pool and themes, fog of war, bots, replays, sound, synchronised start), and a refreshed project tree and Planned list.
- **Next:** the user's answers on `docs/UI_PLAN.md`; G-10 M0 still waits for "start".

### 2026-11-11 — G-12 UI rehaul shipped (v0.7.4–v0.7.9)
- **The user chose** direction A, "Facet, lit", in `docs/UI_PLAN.md` §7: live 3D menu backdrop, Debug tools in a Settings sub-menu, separate menu and match music with a mute icon from the first screen, and README screenshots of the result.
- **UI-1…4 (v0.7.4):** glass UI kit (`client/src/design/glass.css`, `glass.tsx`); boot screen that loads the 3D models with the mute icon visible; live 3D backdrop showing the selected map; new main menu and Play screen (opponent and map cards); Settings modal with General / Audio / Controls / Debug. Music: Kenney "Music Loops" (CC0), "Flowing Rocks" in menus and "Drumming Sticks" in matches, cross-faded. The tracks were chosen by title and description, not by listening, so they are easy to swap.
- **UI-6 (v0.7.5):** glass HUD with a slim top bar (score, crystal, supply, nodes, clock), a clickable command card with a selection panel, a first-match tip and a glass replay bar. Esc opens Settings; Debug tools live there, which fixes the off-screen debug buttons.
- **UI-5 (v0.7.6):** glass lobby (code with Copy, team cards, host-only map cards, Ready/Leave). The loading screen shows each player as Loading or Ready (the server broadcasts LOAD_STATUS).
- **UI-7 (v0.7.7):** result card over the frozen last frame, with Victory/Defeat, how the match was won, length, map and series score, and Rematch / Replay / Menu. The server saves the replay before MATCH_END so the card can link to it. Fixed: "Simulate win" ended the match twice (double score, no replay id), and a second game started after returning to the menu never left the menu.
- **UI-8 (v0.7.8):** replay browser as cards (map thumbnail, players, winner, length, result, flags, star, Watch) with segmented filters. Fixed: an older fetch response could overwrite newer filter results. Replay listing now caches parsed metadata by file mtime; it used to parse about 500 MB on every request (about 6 s), and now takes about 20 ms. Crystal kills now record `winType: "combat"` (it was missing, so replays showed only "Win"). Headless consumers already treated a missing winType as combat, so training is unaffected.
- **UI-9 (v0.7.9):** every screen checked at 1280×720 with nothing off-screen; contrast raised for the bright Frost maps (glass 0.66, `--ink-faint` #959fb8, about 4:1); `prefers-reduced-motion` respected; "Table" dev view in Replays as the plan specifies; replay metadata is warmed at server boot.
- **README:** new "interface" screenshots (`docs/screenshots/ui-*.jpg`): menu, Play, lobby, HUD, result card and replays.
- **Notes for later:** the Debug "Simulate opponent win" button also sends "self" (pre-existing); "Testbed (dev)" is listed in the Play and Lobby map cards; `server/src/match/matchEngine.test.ts` (vitest, not part of `npm test`) has 28 stale failures from older unit stats.
- **Next:** the user reviews the UI; G-10 M0 waits for their "start".

### 2026-11-11 — Quit from the in-game menu (v0.7.10)
- **The user asked** for a way to quit from the in-game Esc menu, especially in solo games, with a warning in PvP that abandoning counts as a loss.
- **Settings → Quit match** (live matches only, not replays). In bot games and Solo Test it quits straight to the menu. In online matches it first asks "Abandoning an online match counts as a loss." with Keep playing / Quit and take the loss.
- **Server:** leaving or disconnecting mid-match now ends it with `winType: "forfeit"` and lets the match-end callback do the bookkeeping once. Before, both paths also recorded the win themselves (the winner's series score went up by 2) and sent a second MATCH_END without a replay id. Leaving during the loading screen releases the load gate first, so it is a forfeit too. The quitter is dropped before the match ends, so they get no result screen; the opponent's card says "… wins by forfeit".
- **Verified on the live build:** bot game and Solo Test quit back to the menu, and a new game starts afterwards. In PvP, the warning appears, "Keep playing" closes it, and quitting returns the host to the menu while the joiner sees Victory by forfeit with a series score of 1. Each quit saved a replay marked forfeit; test replays deleted.

### 2026-11-11 — Player name remembered as typed (v0.7.11)
- **The user asked** for the player name to be saved like the audio preferences. It was already stored in `cf.name`, but only when a game started, so a name typed before a reload or a visit to Replays was lost. It is now saved on every change (trimmed). Verified: type a name, reload without playing, and the name is still there.

### 2026-11-11 — v0.7.12: loose ends after G-12

- Debug "Simulate opponent win" now ends the match for the opponent (the client always sent "self").
- Play and Lobby map cards list only the pool maps; Testbed and Classic stay in Solo test.
- An opponent who quits a PvP match keeps their name and score on the HUD and the result screen (the client remembers the match's players by id until you leave).
- Legacy vitest `server/src/match/matchEngine.test.ts` updated to current rules (counters 1.5×/0.75×, attacks land a tick after acquiring, retreat keeps auto-attack, 3 starting workers' supply); 85/85 pass and `npm test` now runs it.

### 2026-11-11 — G-10 M0 T2 (P-5), part 1: engine throughput without behaviour change
- **Change:** the movement separation pass uses numeric cell keys, index arrays and typed push buffers (same summation order); the attack-log prune trims from the front instead of filtering every tick; the unused `buildSpatialGrid` helper is removed.
- **Check:** all 156 golden engine hashes still match, so the simulation is unchanged.
- **Bench (12 matches, idle CPU), before → after:** classic 3,316 → 4,071 ticks/s; shardfall 2,312 → 2,736; prism-ridge 2,365 → 2,819.
- **Found while profiling:** about 10,000 of the ~10,700 A* searches in the bench came from workers sent to build a supply depot whose straight line to it crosses another building. The approach point lands next to the worker, out of build range, so the worker "arrives", gets re-sent, and re-plans every tick, and the depot is never built. Fixed separately in part 2 because it changes behaviour.

### 2026-11-11 — G-10 M0 T2 (P-5), part 2: stuck builders fixed, throughput target met (v0.8.1-ML, ENGINE_VERSION 11)
- **Diagnosis:** for a target inside a structure, `planPath` took the first free point on the straight line from the target back to the unit. When that line crossed a neighbouring building (for example a depot site behind two finished depots next to the crystal), the point landed beside the unit. The worker "arrived" out of build range, was re-sent next tick, re-planned with A* every tick, and the depot was never built. That accounted for about 10,000 of the ~10,700 A* searches in the bench. Separately, each skirmisher sent to the enemy crystal ran its own whole-map A* (about 3.6 ms each).
- **Change (behaviour):** movement passes the target structure's footprint to `planPath`. A* now stops at the first free cell touching that footprint. A group on the same order shares a flow field seeded with every free cell touching the footprint. The unit ends flush against the structure: the target centre clamped into that edge cell. The old straight-line approach is gone. New regression test: the recorded stuck-builder layout now finishes the depot (it failed on the old code).
- **Change (speed, no behaviour change, golden-checked):** flow-field Dijkstra uses a packed-key heap and an inlined neighbour loop (Dijkstra distances don't depend on tie order); the separation grid uses reused, generation-stamped bucket lists; the arrival check only scans structures; auto-attack candidates are built once per owner per tick; vision skips repeated lit-cell sets and keys its line-of-sight cache numerically.
- **Expected effect:** builders no longer stall, so macro and turtle openings get their supply on time. This changes balance numbers, so the T1 matrix was stopped and will be rerun on this engine. Old replays are no longer listed (ENGINE_VERSION 11, by design).
- **Checks:** 630/630 custom tests and 85/85 vitest pass; golden hashes were regenerated once for the behaviour change, and every speed-only step after it matched them; the mirror audit is clean.
- **Bench (12 matches, idle CPU), T0 → now:** classic 3,316 → 4,964 ticks/s; shardfall 2,312 → 4,013; prism-ridge 2,365 → 3,846. The bench includes the scripted bots' observation and legal-action building (about 15% of the time), so the engine alone is faster. Target ≥4,000 on pool maps: met on shardfall, prism-ridge 4% short; I'm stopping here because what's left is spread thinly (vision fill, observation building that v2 replaces in T6, A* for chases).

### 2026-11-11 — G-10 M0 T1 (P-6a): balance matrix on the fixed engine — gate FAILS (turtle)
- **Run:** 9 bots (idle, passive, four rush tiers, turtle, macro, heavy) × all 10 pool maps × 20 games per pairing per map, 8,100 games, cap 12,000 ticks. `balance.ts` now knows all nine bots. Full report: `docs/balance/2026-11-matrix.md`.
- **Result:** turtle scores 0.99–1.00 against every rush tier and heavy, and 0.71 against macro. The gate (no bot above ~0.80 against every other bot on a map) fails on 6 of 10 maps, all through turtle. Macro is the only counter and wins only on the open maps (cinder-flats, ironreed, shardfall, half of saltmarsh).
- **Flags:** timeouts 6% (above 10% only in mirror pairings); mirror seat shares all within 50 ± 10% (glimmerfen 0.39 rechecked with 168 games → 0.48, noise).
- **Levers tried offline (not committed, constants restored):** control hold 600 → 900 / 1200 ticks, turret HP 600 → 400, turret cooldown 6 → 8. None changes the picture (turtle 0.70–0.79 vs macro, ≥0.98 vs the rest).
- **Diagnosis (traces):** the rush bots lose on economy and attack shape, not to turret stats: skirmisher-only armies trickle into gunners and turrets and never contest nodes, while turtle masses gunners and wins on control.
- **Status:** stopped for the user's review (a plan checkpoint). Recommendation: no game change now; rerun at T10 with the v2 bots and decide there. No balance change without the user.

### 2026-11-11 — G-10 M0 T3 (P-1): named map anchors
- **Change:** new `server/src/match/engine/anchors.ts` computes, per map, the named places the v2 action protocol points at: each seat's base, up to 3 build pockets (by path distance from the crystal), up to 3 centre anchors, up to 3 chokes, the contested nodes and each seat's safe nodes. Seat 0 is computed from terrain and layout; seat 1 is the exact mirror/rotation image, so both seats see identical geometry. `maps.ts` exposes `anchorsFor(mapId, W, H)` with a cache (cleared when a map is registered).
- **Checks (new tests, all 12 maps, both seats):** slot counts, exact seat symmetry, centre and node lists closed under the image, nodes = contested nodes, safe nodes = the match's safe nodes, every anchor walkable and reachable from the base, every pocket accepts a foundry (the widest building) via `validateBuildSite`. 773/773 custom tests and 85/85 vitest pass.
- **Cost:** 12–130 ms per map, once.

### 2026-11-11 — T1 decision: no game change now (user)
- **The user agreed** with the recommendation: leave the game as it is, rerun the balance matrix at T10 with the v2 scripted bots, and decide there. Logged in `GAME_UPDATE_PLAN.md`.

### 2026-11-11 — G-10 M0 T4 (P-4): truncation at the cap
- **Change:** new `headless/src/episode.ts`: `TRAIN_MAX_TICKS = 12000`; `episodeStatus(match, cap)` returns `{terminated, truncated}`: a combat/control/forfeit end is terminated, the engine's cap tiebreak (winType "timeout") or a runner stopping at its own cap is truncated; `evalScore` gives 1/0, and 0.5 for a truncated game. `runMatch` results carry `truncated`. The engine's tiebreak winner is kept for the live game and `runMatch`.
- **Not changed:** the v1 stdio runners; the T7 two-seat runner uses `episodeStatus` and returns the terminal observation for bootstrapping. The balance tool still scores the tiebreak winner so T10 stays comparable with T1.
- **Checks:** 11 new tests (784/784 custom, 85/85 vitest); golden hashes unchanged.

### 2026-11-11 — G-10 M0 T5 (R-2): action space v2 and masks
- **Change:** new `headless/src/v2/frame.ts` (own frame: `toOwnFrame` / `fromOwnFrame`, own-frame offsets) and `headless/src/v2/actions.ts`. One decision every 8 ticks = one economy action + one army order.
  - Economy (94): noop; train worker/skirmisher/gunner/bruiser/medic; build 4 buildings × 10 sites (own base, 3 pockets, 3 chokes, 3 centre anchors); move workers to 16 node slots (4 own safe + 12 contested) × {1, 2, 4}.
  - Army: 9 groups (none, all combat, army A, army B, four unit types, scout) → 7 orders (none, attack-move, move, hold, retreat, join A, join B) → 54 targets (37 own-frame anchors, 16 enemy-memory slots, none).
  - Masks are sent as tables (`econ[E]`, `group[G]`, `order[G][O]`, `target[O][T]`). Placement is checked with the engine's `validateBuildSite` around the site anchor, using own-frame offsets so both seats pick matching spots. Training needs resources, supply and a finished producer with fewer than 2 queued. Army A/B, the scout and the memory slots are per-seat harness state.
  - Worker autopilot: each decision, idle workers go to the nearest own safe node with resources and a free slot (counted in `stats.autopilot`).
- **Deviations from the guide (allowed: "you may adjust entry lists"):** worker counts are {1, 2, 4} instead of {1, 2, all idle}, because the autopilot leaves no idle workers, so assign moves gathering workers. Orders gained `none` so the "no army order" choice has a legal order and target.
- **Checks (new tests):** sizes and index round-trip; own-frame round-trip; identical masks for both seats over 100 mirrored decisions on glimmerfen (mirror) and shardfall (rotate); random masked play on saltmarsh and basalt-run, 750 decisions each with 60–100 builds, 85–100 trains and 200+ moves: **0 ineffective legal actions**; army join/move; memory slots as targets. 808/808 custom, 85/85 vitest; golden hashes unchanged.
- **Found (engine, not changed):** (1) new units spawn at a random angle that is not mirrored between seats, so mirrored play stops being exactly symmetric after the first unit is trained (already noted in `engine/mirror.ts`); (2) on rotate maps the centre node is its own image, so when both seats order workers onto it, whoever is applied first takes the slots. The T7 runner alternates which seat is applied first, as `runMatch` does.
- **Cost:** masks take about 2 ms per seat per decision (mostly placement checks); to look at in T9 if throughput needs it.

### 2026-11-11 — Engine symmetry fixes (user: "let's fix these please")
- **Change (engine, v0.8.2-ML, ENGINE_VERSION 12):** both seats' spawn RNGs now share the match seed, and seat 1 spawns at the map-symmetry image of the angle it draws (mirror maps: π − a; rotate maps: a + π). Mirrored play now spawns mirrored units. `engine/mirror.ts` `diffStates` no longer skips units spawned during the tick. Old replays (ENGINE_VERSION 11) are hidden again.
- **Change (v2 harness):** new `applyV2Pair(engine, match, seats, actions)` resolves contention before applying either seat. When both seats send workers to the same node in one decision (the rotate maps' centre node), the free slots are split evenly. An odd slot goes to the seat with fewer own workers there, else to a coin from seed + tick. When both build and the second spot is blocked by the first, the coin decides which seat builds and in which order they are applied. A cut-short action counts in the new `stats.contested`, not as ineffective. The engine itself still claims slots at command time; that is harmless in live play and only mattered for the lock-step harness, so the fix lives there. The T7 runner uses `applyV2Pair`.
- **Checks:** mirror audit clean on seeds 1, 2, 3, 7 (2,000–3,000 ticks) with spawns compared; the mirrored-mask test now includes training (glimmerfen and shardfall, 100 decisions); new shardfall test: both seats ask for 4 workers on the centre node, the 3 free slots split 1/2, both count it as contested. 814/814 custom, 85/85 vitest; golden hashes regenerated (20 cases, 165 hashes).

### 2026-11-11 — G-10 M0 T6 (R-1): observation v2
- **Change:** new `headless/src/v2/observation.ts` (`OBS_SCHEMA_VERSION = 1`); everything is in the acting player's own frame and rounded to 4 decimals.
  - `observe(match, seat, obsState, {z})` (call once per decision, before the masks) returns: 51 named globals (economy, supply, control, tick, last-seen enemy counts by type with their age, z); up to 200 entity rows × 31 features (fog-honest: only entities in the seat's visibility; sorted by owner/type/position, so ids never matter); 16 memory rows × 13 (slot 0 = enemy army cluster, slots 1–15 = enemy buildings; new entries take the lowest free slot, a full table replaces the oldest destroyed entry, else the oldest; an entry is marked destroyed when its spot is lit, nothing is seen there and it is not in brush); 20 node rows × 13 (4 own safe, 4 enemy safe, 12 contested); a 50 × 15 dynamic grid (visible, ever seen, time since seen, own army, last-seen enemy army). Memory rows are also the v2 action targets (`seat.memory`, world positions).
  - `staticGrid(match)`: blocked, rough, high ground, water, brush, sent once per episode (the same for both seats).
  - `criticState(match, self, …, other, …)`: fog-free blocks for self and for the enemy in its own frame, for the centralised critic. `oppLabels(match, seat)`: the enemy's unit/building/queue counts and army anchor, for the opponent-modelling head.
  - New `headless/src/v2/imageState.ts` (tests): the symmetric image of a match with seats, economies, RNGs, control, node controllers and colours swapped.
- **Checks (31 new tests, 844/844 custom, 85/85 vitest; golden hashes unchanged):** sizes match the name lists, every value is finite and rounded; glimmerfen: 150 mirrored decisions give both seats bit-identical observations and masks, and after 30 decisions of asymmetric play the image state gives each player bit-identical observations and masks; shardfall image test: critic blocks, masks and opponent labels bit-identical; fog honesty (an unseen turret is not observed, the critic sees it; enemy rows equal the enemies in the seat's visibility); memory fills, keeps and ages after the turret is out of sight again.
- **Cost:** about 1–5 ms per seat per decision, about 10–12 KB JSON per observation (critic about 25 KB). To look at in T9 (binary encoding if the pipe is the bottleneck).
- **Found (engine, not changed, for the user to decide):** on rotate maps two things are not yet exactly symmetric. (1) Fog: the vision grid is 40 px, and 900 / 40 = 22.5 rows, so a seat's fog under rotation lands half a cell off; the fogged observation (and which entities/nodes count as visible) can differ between seats, so the shardfall image test leaves the fogged blocks out. (2) Movement: on twin-spires a mirrored pair of workers given mirrored move targets drifted 1.6 px apart after one tick, with no fog involved (likely a pathfinding/separation tie-break that depends on direction). Mirror maps (default, glimmerfen and the others) are exact.

### 2026-11-11 — G-10 M0: rotate maps exactly symmetric (user chose B, v0.8.3-ML, ENGINE_VERSION 13)
- **Change (fog):** the vision grid is now centred on the map (`offsetX/offsetY` in `VisionGrid`; a 900 px map has 23 rows starting 10 px above the top edge). A vision cell is elevated when at least half its area is high ground or cliff (overlapping nav cells weighted by area); `visionCellOf` sends boundary points toward the centre line on both axes. The client draws the fog (main view and minimap) with the new `visionOffsetX/Y` from the static map. 20 px vision cells were tried and rejected: −22–24% throughput.
- **Change (pathfinding):** on rotate maps the tie-break adds the side of the start→goal line after progress (a rotation keeps the side, a mirror swaps it), so a route around an obstacle symmetric about that line goes round the matching side for both seats instead of by cell index. A goal exactly on a cell boundary (a centre-line point is its own image) now uses the cell on the start's side, unless that cell is blocked. Mirror-map paths are unchanged except for boundary goals. `Terrain` has a new `rotate` flag.
- **Change (float rounding):** every entity position is snapped once per tick (before visibility) to a 2^-16 px grid measured from the map centre, rounding half away from it, and spawn offsets are negated exactly for seat 1. Cause: a builder at x = 1190.000000000001 and its image at 1189.999999999966 hit the 60 px arrive threshold one tick apart.
- **Checks:** engine symmetry sweep (scripted bots, both seats compared with the image every tick, tolerance 0): 100/100 runs exact over 3,200 ticks (10 maps × seeds 1–10; before: 29/40). Observation: 300 mirrored decisions bit-identical (obs, fog, masks) on shardfall, hollow-crown, twin-spires and glimmerfen. New tests: twin-spires 150 mirrored decisions; shardfall image test now includes the fogged observation (847/847 custom, 85/85 vitest; golden hashes regenerated, 20 cases, 162 hashes). Throughput unchanged (shardfall bench 3,870 vs 3,891 ticks/s at HEAD).
- **Note:** ENGINE_VERSION 13 hides older replays from listings again.

### 2026-11-12 — G-10 M0 T7 (P-2): two-seat runner and Python env (v0.8.4-ML)
- **Change (runner):** new `headless/src/v2/runner.ts` (`VecRunnerV2`, protocol v2 per the guide §5.8) with stdio entry `headless/src/v2/vecRunner.ts`; `npm run build:headless` now also builds `headless/dist/v2/vecRunner.js`.
  - Messages: `reset_all` → `ready` {schemaVersion, slots: {seats, static, episode}}; `step` → `step_result` {seats, rewards, done, truncated, terminal, info, and on a new episode static + episode}; `configure` (per slot, applied at the next episode boundary, then kept; a new seed restarts the seed sequence); bad input → `{type: "error"}` reply.
  - Seats: `policy`, `bot:<name>` (played in Node), `teach:<name>` (the bot plays; the stream gets the bot's choice as `teacher`, made from that same observation). Bots for now: `idle`, `random` (`headless/src/v2/bots.ts`; the scripted v2 bots are T8).
  - Per decision: worker autopilot for both seats, observe, masks, bot choices; policy actions that the masks forbid become a no-op and count in `stats.illegal`; both seats applied together with `applyV2Pair`; k = 8 ticks. Episode n of a slot uses seed `n == 0 ? base : mixSeed(base, n)`; a bot's seed comes from the episode seed and the bot's name (not the seat), so swapping seats with the same seed plays the mirrored game. The critic block is computed once and swapped for seat 1. Optional replays go to `<cwd>/replays` in the server's format.
  - **Deviation from the guide's sketch:** rewards are returned per slot as `rewards: {blue, red}` (learner seats only), not inside `seats`, because the reward belongs to the step just taken and `seats` already holds the next observation.
- **Change (rewards, `headless/src/v2/rewards.ts`):** raw components per seat `{win: ±1/0, shaped: {res, army, dmg, ctrl}}`, each shaped term zero-sum (mine minus the enemy's): lifetime resources /1000, army value (cost × health fraction) /1000, damage dealt minus taken /1000, control progress / holdTicks. Truncation gives win 0. Weights and schedules stay in Python. Measured (random play, 600 decisions): res mean |r| 0.004; army 0.067 when nonzero (spiky: a unit trained or killed is a whole unit's cost); dmg 0.012 when nonzero; ctrl 0 in that sample. Army may want a smaller weight than the others; that is a T11/M1 choice.
- **Change (engine, exact, no behaviour change):** `anchorsConnected` (the full-map flood fill in build-site validation) is memoised per nav-grid version (bumped by every structure add/remove). It was 51% of runner time through the build masks. Goldens unchanged.
- **Change (Python):** new `training/env/vec_env_v2.py` (`VecEnvV2`): spawns `n_procs` runners, splits slots between them, flattens non-bot seats into streams (slot, side) with roles learner / frozen (slot key `learner`) / teach; `step` returns transitions aligned with the streams before the step (reward, done, truncated, terminal, info) and the current streams after it (the layout can change at an episode boundary after `configure`). Asserts the obs schema version; refuses a stale `headless/dist` like the v1 env.
- **Checks:** 21 new TS tests (868/868 custom, 85/85 vitest; golden hashes unchanged): runner vs a direct in-process loop, 480 tick hashes identical; three autoresets keep map, seats and z, seeds follow the sequence, configure applies at the boundary; truncation returns a terminal obs; seat swap on shardfall (rotate) and twin-spires gives the mirrored game (own-frame entity states equal after 960 ticks); policy-vs-policy rewards zero-sum; illegal actions counted; error replies. New `training/test_vec_env_v2.py`: the same autoreset checks through Python with 2 processes, roles, teach labels, reconfiguring a slot's opponent drops its stream.
- **Throughput (random legal policy vs `bot:random`, through Python, this 12-core box):** 1 process × 1 slot 99 decisions/s; 1 × 4: 133; 4 × 8: 293; 8 × 16: 417; 12 × 24: 467. About 30 KB of JSON per decision. Python's JSON parsing is 3% of wall time on one process and 14–17% at 8–12 processes, which is at the guide's 15% line for a binary format. Not changed yet: Node time (observation, masks, engine ticks) still dominates per process; revisit in T9 together with batching the policy. Note: the pipes must be buffered (an unbuffered `readline` read the 30 KB lines byte by byte: 7 decisions/s per process).

### 2026-11-12 — G-10 M0 T8 (P-7): v2 scripted bots and switchers (v0.8.5-ML)
- **Change (bots):** new `headless/src/v2/scripted.ts`. Scripted bots use the v2 action space at the policy's rate (one econ + one army action per 8-tick decision), with the same masks, so they are fair opponents and exact teachers. A bot plays a `Template` (workers, contested-node workers, build order, unit mix, supply headroom, push timing/size/targets, optional brush route, staging, retreat threshold, optional late economy) chosen per episode; push tick (×0.8–1.2), push size (±1) and target are jittered from a seeded engine `Rng` (seed from the episode seed and bot name). 15 templates, each with its own strategy token `z` (1–15): light/medium/heavy/gunner rush, gunner and bruiser turtle, heavy and light macro, heavy, heavy + turret, hidden army, fake expansion, bruiser timing, control grab, brush strike. Bots (`SCRIPTED`): `rush1`, `rush2` (medium or gunner rush), `rush3`, `turtle`, `macro`, `heavy`, `hidden` (masses out of sight at a staging point, then attacks; for E-6) and four switchers that change template at a seeded tick in [1,500, 4,000]: `sw_rush_turtle` (z 12), `sw_macro_bruiser` (z 13), `sw_fake_brush` (z 14), `sw_turtle_grab` (z 15). `idle` and `random` remain. A requested `z` the bot does not play is an error.
- **Change (runner):** `bot:`/`teach:` seats get a `botContext` (map size, own-frame targets, brush) and the slot's `z`; episode info reports `botZ: {blue, red}`. A bot exception is logged (first 3 to stderr), played as a no-op and counted in `stats.botErrors`. **Deviation:** a `teach:` seat whose configured `z` is 0 observes its bot's own `z` (so imitation data carries the template label); a policy seat keeps the configured `z`.
- **Behaviour note:** control wins are rare for scripted play: holding more than half of 8–9 contested nodes needs about five separately ordered groups, which the v2 action space (one army order per decision) makes slow. The control-grab bots fall back to attacking the enemy base when their control progress has not improved for 1,500 ticks. Expect the same difficulty for the policy.
- **Change (engine, exact):** `anchorsConnected` returns the unblocked answer when the extra footprint keeps clear of every anchor's ring and the free cells around it form one run (going round it is always possible); a test compares it with the flood fill on 1,800 rects. The observation's dynamic grid caches its cell maps per seat. Turtle vs heavy, 3,000 ticks: 9.07 s → 7.56 s. Goldens unchanged.
- **Change (tools):** `headless/src/v2/botCheck.ts` (acceptance: every bot × every pool map × N games, parallel); `balance.ts` accepts `v2:<bot>` names (v2 bots only, not mixed with v1).
- **Checks:** botCheck, 5 games per bot per map (550 games, 332 s on 12 processes): no exceptions, ineffective-action rate 0, first game of each bot/map replayed identically. 12 new tests (880/880 custom, 85/85 vitest; golden hashes unchanged).
- **First look (botCheck, as blue vs cycling opponents, W/L/timeout of 50):** rush1 7/38/5, rush2 2/28/20, rush3 9/24/17, turtle 34/8/8, macro 26/12/12, heavy 29/19/2, hidden 15/28/7, sw_rush_turtle 29/15/6, sw_macro_bruiser 34/12/4, sw_fake_brush 2/37/11, sw_turtle_grab 38/4/8. Under v2 pacing, pure rushes are weak (as with v1, turtles hold); this is for the T10 matrix, not tuned further here.

### 2026-11-12 — G-10 M0 T9 (P-8): harness checks, replay → observations (v0.8.6-ML)
- **Change (replays):** a v2 replay now carries a `v2` block (obs schema version, decision interval, cap, each seat's z, every decision's applied actions with forbidden policy actions recorded as the no-op that was played); the server ignores it. The observation depends on army groups that only the v2 actions set, so the command log alone cannot rebuild it. New `headless/src/v2/replayObs.ts`: `replayObservations` replays an episode the way the runner played it and hands back every decision's observations, and fails unless the commands the engine accepts on the way equal the replay's command log; `replayCommandLog` replays only the command log on the server's replay loop. The runner has a new `onReplay` test hook.
- **Fixed:** the runner's replay command log listed each decision's commands seat by seat, but `applyV2Pair` interleaves the seats, so the server replayed them in a different order (found by the new test: a red `train_unit` and a blue `gather` at the same tick swapped). The log is now the engine's own `match.commandLog` (accepted commands in processing order). No v2 replay had been saved, so nothing was lost.
- **Checks (9 new tests, 889/889 custom, 85/85 vitest; golden hashes unchanged):** shardfall (rotate) teach:macro v teach:rush2 with critic, 200 decisions: 402/402 observations identical in the replay, same command log, same final state; the command log on the server's replay loop matches the runner every tick before the cap (the server config has no cap, so only the cap tick differs). Glimmerfen (mirror) policy with arbitrary actions (150 forbidden) v bot:turtle: 151/151 identical, same checks. The T5–T8 harness tests remain in the suite.
- **Throughput (policy with random legal actions v `bot:macro`, through Python):** 1 process × 4 slots 202–220 decisions/s; 4 × 8: 462–481; 8 × 16: 558–576; 12 × 24: 620–658 (T7, vs `bot:random`: 467). Python's JSON parsing is now 21–24% of wall time at 8–12 processes (above the guide's 15% line), but Python waits on the Node runners about 95% of the time, so it is not the bottleneck. **Tried and reverted:** grids (observation and both critic grids, three quarters of a step's 31 KB) as base64 float32: parsing fell to 10% of wall time, throughput did not change, and messages doubled in size because the grids are mostly zeros (2 bytes each as JSON text). JSON stays; revisit if Python becomes the bottleneck once it runs the policy (T11/M1). Per-process speed falls from about 200 to 52 decisions/s at 12 processes because this container has 12 of the host's 28 hardware threads (14 cores × 2): more threads for the container would help throughput more than any format change.

### 2026-11-12 — Spring clean and docs archive
- `replays_archive/` (7,505 May-era replays) dropped from the repo; `*.tsbuildinfo` untracked. v1 training leftovers moved out of the repo to `/root/archive/crystalfront-v1-training/`; TensorBoard emptied.
- Stale docs moved to `docs/archive/` (user: "We dont want an agent reading out of date info"): `ML_AGENT.md`, `REVIVAL_PLAN.md`, v0.3.2 release notes and eval, `balance/FINDINGS.md` and the v0.5 matrices, `training/README.md`, and the 2026-05/06 reports that lived in `/root` (diagnosis, ML review, training guide). This diary was split: entries before 2026-11-10 are in `archive/ML_BOT_ACTION_PLAN_v1.md`; this file (`DIARY.md`, previously `ML_BOT_ACTION_PLAN.md`) keeps 2026-11-10 onward.
- v1 code (`stdioRunner.ts`, `stdioVecRunner.ts`, `training/ppo/`) stays until v2 works, then goes.

### 2026-11-12 — v0.8.7-ML: edge-panning sensitivity setting
- Settings → Controls gains an "Edge panning" slider (0–100, saved in the browser as `cf.edgePan`). The camera moves 12 × setting world px per frame at the screen edge; the default 50 gives 6 px, double the old fixed 3 px (user: "double it for the default value, but allow a user to change it"). 0 turns edge panning off. Client only; no engine change.

### 2026-11-12 — G-10 M0 T10 (P-6b): balance matrix with the v2 bots — user checkpoint
- 14,400 games (12 v2 bots × 10 maps × 20 per pairing per map), write-up in `docs/balance/2026-11-matrix-v2.md`.
- Per-map gate passes on 9/10 (T1: 4/10), but only because the two turtle bots beat each other. `sw_turtle_grab` (turtle, then take nodes) beats every non-turtle bot above 0.80 on 6/10 maps and averages 0.88. Hollow-crown and twin-spires show real counter-play.
- Seats are even (mirror 0.50–0.51 on every map). Timeouts are up to 23% (T1 6%), mostly mirrors and weak-v-weak rush pairings.
- Stopped for the user's decision: lever sweep against v2 bots (recommended), accept and start M1, and/or fix bot timeouts.

### 2026-11-12 — G-13 Phase E: unit control engine fixes (v0.8.8-ML, ENGINE_VERSION 14)
Built per `docs/BOT_CONTROL_PLAN.md` §1 (user: "Implement this plan autonomously once the balance tests return"). Applies to humans and bots alike. **ENGINE_VERSION 13 → 14: older replays are hidden.**
- **E0 auto-attack:** `stop` no longer turns auto-attack off. Only the toggle (R) turns it off, and attack-move turns it back on.
- **E1 ordered targets:** `attack` sets `attackOrdered` (in the state hash). Ordered targets are never switched by priority and never leashed.
- **E2 threat order:** automatic targeting picks from class 0 (combat units, finished turrets), then 1 (workers), then 2 (other buildings, crystals). Nearest wins within a class. A unit on an auto target switches when a better class comes into range.
- **E3 leash:** an auto-acquired target records a leash `{x, y, r = LEASH.chase 200}` at the acquiring unit's position (not for buildings). The unit drops a target that can't be hit from inside the circle and walks back to the centre (or resumes its attack-move).
- **E4 Guard:** new command `guard {entityIds, targetX, targetY}`. Units attack-move to the point. Melee units acquire at 0.8 × vision and ranged units (range ≥ 60) at attack range, but only enemies hittable from inside the circle. The circle is 0.5 × vision, and units never leave it. They release the target and return to the point. Any other order ends the guard. Client: **F** on the unit command card (F stays Rally when a production building is selected); Settings → Controls lists it.
- **E5 medic auto-heal:** a medic with no heal order and no move heals the ally in range with the lowest HP fraction (then nearest). It does not move.
- **Client:** command card costs now come from `UNIT_DEFS`/`BUILDING_DEFS` (Worker showed 25, costs 35; Skirmisher 50 vs 60; Turret 60 vs 50). The pre-existing `UNIT_COSTS` table in `GameShell.tsx` is unused and also stale; left in place.
- **Bots:** the v2 harness's "hold" is still an attack-move in place (now leashed). Phase B makes it guard.
- **Checks:** 23 new G-13 tests (912/912 custom, 85/85 vitest), goldens regenerated (20 cases, 165 hashes), client type-checks. botCheck (550 games, 18 processes, 230 s): no exceptions, 0 ineffective actions, identical seeds → identical games. First look (as blue, W/L/T of 50): turtle 44/3/3, sw_turtle_grab 39/7/4, sw_macro_bruiser 38/10/2, macro 36/11/3, heavy 32/14/4, sw_rush_turtle 24/17/9, hidden 14/29/7, rush1 11/37/2, rush3 8/27/15, rush2 1/32/17, sw_fake_brush 2/37/11. Turtles still lead; the E6 matrix measures it properly.

### 2026-11-12 — G-13 Phase B: action space v3 (v0.8.9-ML)
Built per `docs/BOT_CONTROL_PLAN.md` §2 (R-2 deviation signed off by the user). Headless and training only: no engine change, golden hashes unchanged. Layout in `docs/ML_RETRAIN_IMPLEMENTATION.md` §5.7.
- **Actions** (`ACTION_SPACE_VERSION 3`): econ adds repair, set rally and cancel last queued, with sub-heads `site` (10 named + 750 grid build sites), `econPtr` (entity rows) and `econTarget` (rally point). Army adds a `unit` group (one own unit by pointer), orders guard, guard here (replaces hold), focus (ordered attack by enemy pointer), heal (medics, own-unit pointer) and stop, and 750 grid cells as point targets.
- **Observation schema 2:** new `guarding` entity feature; pointers index its entity rows, so observe runs before the masks.
- **Placement masks** mirror `validatePlacement` exactly and cache the wall-off seal check per nav-grid version; a decision with all 760 sites masked takes about 10 ms (24 ms before the cache).
- **Scripted bots:** guard at staging points, retreat badly hurt units, focus weak enemies near the army, medics heal. They do not repair: the engine's repair works from any distance (`repair.ts`), which would be free remote healing for already-dominant turtles. Raised with the user, not fixed.
- **Python:** `vec_env_v2.py` checks `actionSpaceVersion`; `test_vec_env_v2.py` samples all v3 heads. 110 decisions/s at 4 processes × 8 slots while the machine was busy with the E6 matrix (not comparable to T9's 462–481).
- **Checks:** 916/916 custom, 85/85 vitest, goldens unchanged, client type-checks, Python env test passes. The P-8 random-play test (750 decisions per map, with a seeded army and periodic damage so every kind gets a chance) uses every action kind with 0 ineffective actions, and the grid site masks equal `validateBuildSite` everywhere. botCheck (550 games): no exceptions, 0 ineffective, deterministic. As blue, W/L/T of 50: sw_turtle_grab 45/4/1, turtle 40/3/7, macro 34/7/9, sw_macro_bruiser 33/13/4, heavy 26/18/6, sw_rush_turtle 25/18/7, rush3 10/26/14, rush1 9/37/4, hidden 9/32/9, sw_fake_brush 4/36/10, rush2 3/37/10.

### 2026-11-12 — G-13 E6 balance re-check — user checkpoint
- 3 × 4,900 games, write-up in `docs/balance/2026-11-matrix-v2.md` ("G-13 E6 re-check"). turtle_grab v non-turtle bots: 0.86 before Phase E → 0.84 with Phase E → 0.88 with the v3 bots. Turret range 120 lifts macro to 0.52 and takes one map off the dominant list (4/10).
- Process note: the first E6 run was started while the v3 files were being edited, and balance runs load source through tsx at start. It was stopped and re-run from a clean git worktree at d87e559. Balance runs now go in a worktree whenever code is changing.
- Stopped for the user: turret range 120 or not, the repair range bug, and the go-ahead for M1.

### 2026-11-12 — Turret range 120 + repair range fix (v0.8.10-ML, ENGINE_VERSION 15)
- User at the E6 checkpoint: "All 3 in order please!" (turret range 120, fix repair, then start M1).
- **Turret range 150 → 120** (`shared/src/gameBalance.ts`).
- **Repair now needs range.** Repair used to heal from any distance. Now the worker walks to the building and repairs only within gathering range (60 px). If it gets another order it stops repairing, and a repairer that is pushed away walks back. Assigning a new repairer releases the old one, and a worker leaves its previous repair job. Repairing workers no longer count as idle (autopilot and the v3 repair pointer skip them). The old test that relied on remote repair now waits for the worker to arrive.
- **Scripted bots repair turrets.** Any scripted bot sends a worker to its most damaged turret below 75% health when the repair mask allows it, so the imitation data contains repair (202 repair decisions in 8 test games, 0 ineffective).
- ENGINE_VERSION 15: older replays are hidden again. Goldens regenerated (20 cases, 167 hashes).
- **Checks:** 922/922 custom, 85/85 vitest, client type-checks. botCheck (550 games, 18 processes, 356 s): no exceptions, 0 ineffective, deterministic. As blue, W/L/T of 50: sw_turtle_grab 44/4/2, turtle 41/1/8, macro 37/7/6, sw_macro_bruiser 33/12/5, heavy 27/20/3, sw_rush_turtle 23/21/6, rush3 11/24/15, rush1 9/38/3, hidden 9/32/9, sw_fake_brush 5/33/12, rush2 3/36/11.

### 2026-11-12 — G-10 M0 T11 GPU checks + M1 v2 PPO learner (v0.8.11-ML)
- **T11(a):** `training/test_gpu_checks.py` compares `nn.LayerNorm` with the custom `LayerNorm` (`training/ppo/policy.py`) on the P100 over 200 Adam steps, syncing the weights before each step so both gradients are taken at the same point. PASS: everything finite, max relative difference loss 1.2e-7, gradient 1.4e-4. The ROCm LayerNorm bug does not occur on this GPU, so the v2 model uses `nn.LayerNorm`. (A first version without the weight sync showed 5.6e-2 gradient drift. That was chaotic divergence between two training runs, not corruption.)
- **v2 learner** (`training/v2/`): `spaces.py` holds the obs v2 / action v3 sizes and checks them against the live runner at start-up. `batch.py` handles batching: entity rows are padded to the batch max, and the static grid is cached per episode. `model.py` is the feed-forward agent (3.14 M parameters). It has an entity transformer (d 128, 2 layers) whose per-entity embeddings feed the pointer heads, flatten-MLP encoders for nodes and memory, a 3-layer CNN on 10 grid channels, a z embedding and a core MLP → h 384. The autoregressive heads are econ → site / econ pointer / rally target, then group → order → unit pointer → point target / entity pointer, with heads that don't apply left out of log-prob and entropy. There are three value heads (win, shaped, aux), and the critic adds both seats' true globals. `train.py` runs PPO: one learner seat per slot, with map, seed, side and opponent drawn per episode, held-out maps refused. GAE is computed per value head (win γ 0.999 λ 0.99, shaped 0.99/0.95, aux 0.999/0.99), truncation bootstraps from V(final obs), and advantages are normalised per head and mixed (win/shaped/aux 0.1/0.8/0.1 → 0.8/0.1/0.1 over the budget, shaped floor 0.1). Shaped weights are res 1, army 0.5, dmg 1, ctrl 1 × 0.6^(min/10); aux = res + army. Clip is 0.1 for policy and value, 2 epochs × 8 minibatches, lr 1e-4 → 5e-5, entropy 0.01 → 0.001, grad norm 0.5. TensorBoard (`runs/<run>`) logs losses, per-head entropy, KL, clip fraction, explained variance per head, win/loss/truncation rates by side and opponent, win type, production mix, no-op rates and throughput. Checkpoints go to `checkpoints/v2/<run>/`.
- **T11(b) smoke run** (`m1-smoke-idle`, 5 min, 18 processes × 8 slots vs idle, 110,592 decisions, 6 updates): PASS. No NaN, KL ≤ 0.0016, clip fraction 0.08 → 0.01. Explained variance rose to win 0.97, shaped 0.90, aux 0.79, and mean shaped reward per decision went from −0.0067 to −0.0003. Total loss rose only because the entropy bonus decays on schedule. No episode finished: 12,000 ticks is 1,500 decisions, about 10 minutes per slot at this rate. Throughput was 316–385 decisions/s with 56–61% of the time in the env, so the Python side (stacking, inference, wire actions) costs about 40%. That leaves room to optimise later.

### 2026-11-12 — M1 step 1: eval harness; idle probe fails twice → user decision (v0.8.12-ML)
- **Win type fix:** the trainer logged a win type "crystal", but the engine calls it "combat", so that chart was always zero. Fixed.
- **Eval harness** `training/eval/evaluate.py`: a checkpoint (or `bot:<name>` in a teach seat, for oracle checks) plays each opponent on each map, once per seed from both seats. Each slot's next game is pre-configured so it starts on time. Results are win/loss/draw with 95% Wilson intervals, by map and by seat. The fixed seeds are `training/eval/seeds/eval-v1.txt` (500). Every run goes in the registry `docs/experiments.md`.
- **Oracle vs idle** (32 games): rush1, heavy and turtle win 100% (rush1 in ~2,500 ticks); macro 69%, because it draws on 4 maps (a bot quirk).
- **Idle probe run 1** (30 min, 460k decisions): 0/32 in eval, all truncated. No barracks or foundry was ever finished, because 80% of the near-uniform econ mass went to the 48 assign variants. Army targets were spread over 750 grid cells.
- **Run 2** added kind-balanced starting biases (learnable). The economy is fixed (combat units per episode 15 → 64, shaped return 0.67 → 3.78), but still 0/32 in eval. 30 minutes is only 18 PPO updates and about 1.5 episodes per slot, and throughput halves as armies grow (120–240 decisions/s).
- The stop rule fired (2 diagnosed iterations). The probe's "≥95% in 30 minutes" needs far more updates than this throughput gives. Options went to the user.

### 2026-11-12 — Idle probe criterion amended; run 3 started (v0.8.13-ML)
- User on the stop-rule options: "pick the option yourself (or a more suitable option if you have one)".
- Chosen: budget the idle probe by decisions, not minutes. New criterion: ≥95% wins vs idle (lower bound of the 95% interval over 208 fixed-seed games) within 5 M decisions. The throughput work is not done first. It would gain perhaps 1.5×, while the gap to the old budget is more than 10×, and the machine is otherwise idle.
- Not chosen: a shorter tick cap, which changes the task the probe tests. Imitation first is the fallback if run 3 misses, because an imitation start would beat idle without showing that PPO learns.
- Trainer: `--decisions` (schedules run on decisions; resume continues the count) and `--stop-win-rate` (the last 200 training episodes trigger a stop; the fixed-seed evaluation decides).
- Run `m1-idle-probe-r3` started.

### 2026-11-13 — Idle probe run 3 fails; imitation first (v0.8.14-ML)
- **Run 3** (`m1-idle-probe-r3`, 5 M decisions, 272 updates, 8.9 h): training-window win rate flat at 1–6%. It learned an economy and masses gunners (65–100 per episode), and the win value head is accurate (explained variance 0.99), but army control never became coherent. In a final.pt rollout most orders went to the scout or single units with mixed retreat, stop, guard and move, mostly to grid cells, and the whole army almost never attack-moved on the enemy base. Fixed-seed eval: 3 wins, 205 draws of 208 [0.00, 0.04]. **FAIL** against the amended criterion.
- Fallback, as announced: **imitation first** (plan §7.3 step 3 moved ahead; plan amended).
- Trainer `--imitate`: both seats of every slot are `teach:<bot>` (the 11 scripted bots, training maps only). The policy scores the teacher's actions (`teacher_actions` maps the wire actions to heads) and the loss is cross-entropy plus the value losses; no PPO ratio, no entropy bonus. Per-head cross-entropy is logged as `ce/<head>` (over decisions where the head applies). Teachers carry their template's z, but evaluation plays z = 0, so z is zeroed on half of the samples. `--overfit` trains on the first rollout only.
- Overfit probe: PASS, cross-entropy 2.07 → 0.0034 on one 512-decision batch.
- Teachers act (not no-op) on 16% of econ decisions and 30% of army decisions, so plain cross-entropy is fine.
- Run `m1-imitate` started (10 M decisions). Gate: the imitation policy alone wins ≥40% (lower bound) against the scripted pool. Then PPO from it with a KL penalty toward it (annealed to 0), and the idle probe re-checked.

### 2026-11-13 — Imitation run: gate passes (v0.8.15-ML); paused
- **`m1-imitate`** (10 M decisions, 272 updates, 9.9 h, ~325 decisions/s): cross-entropy 1.96 → 0.43 and still drifting down slowly. Per head: site 0.000, order 0.015, econ 0.07, target 0.08, unit 0.28, group 0.32. The group head (whether and when to give an army order) carries most of what is left; much of that is timing the teachers' own randomness makes unpredictable. Explained variance: win 0.96, shaped 0.97, aux 0.95.
- The console "kl" is PPO's ratio statistic against the rollout-time policy. In imitation it means nothing; one spike to 32,006 on the last update is one sample whose log-prob moved a lot.
- **Gate eval** (`docs/eval/m1-imitate.json`; final.pt alone, sampled actions, 11 scripted bots × 8 training maps × 2 seats × 3 seeds = 528 games): **0.51 overall [0.47, 0.56] → PASS** (≥40% lower bound). By bot: sw_fake_brush 0.79, hidden 0.75, rush1 0.67, rush2 0.62, sw_rush_turtle 0.56, heavy 0.50, sw_macro_bruiser 0.50, rush3 0.44, macro 0.38, turtle 0.35, sw_turtle_grab 0.08. It mostly wins by combat (254 of 271), and turtle-type bots are its weak spot, as they were for the scripted bots themselves (T10 sweep).
- **Ready for the next step, not started:** trainer `--init <ckpt>` starts PPO from given weights (fresh optimiser and counters), with `--kl-coef` (k3 estimator of KL to the frozen `--init` policy on the taken actions) annealed linearly to 0 over `--kl-anneal` (default 0.5) of the budget. Smoke-tested (KL 0.01–0.02, coefficient 0.5 → 0).
- Raw results from the session scratchpad (training logs, eval JSONs, balance/matrix/sweep outputs and their analysis scripts) archived in `docs/archive/raw-2026-11/`.
- **Paused at the user's request** after this run. Next when resumed: PPO from `checkpoints/v2/m1-imitate/final.pt` with the KL penalty, against the scripted pool; then the idle probe re-check, LSTM, opponent-model head, and the M1 gate (E-1 ≥70% vs each scripted bot).

### 2026-11-14 — PPO from the imitation policy started (v0.8.16-ML)
- User: "start now!"
- Run `m1-ppo-kl`: PPO against the 11 scripted bots (uniform), training maps, starting from `checkpoints/v2/m1-imitate/final.pt`. KL penalty toward the frozen imitation policy, coefficient 1.0 annealed linearly to 0 over the first half of the 10 M decisions. Entropy bonus lowered to 0.003 → 0.001 (the imitation policy already has sensible entropy; 0.01 summed over 9 heads would push it away). Opponent weighting toward the bots it loses to comes later.
- Watch: `kl/ref` (should stay small while the coefficient is high), `episode/win_rate` and `win_rate/bot_<name>` (start near 0.5), `sched/kl_coef`.
- **Result** (`docs/eval/m1-ppo-kl*.json`): scripted pool 521/528 = 0.99 [0.97, 0.99], every bot ≥0.92 (lowest sw_turtle_grab 0.92 [0.80, 0.97]); idle 208/208 (idle probe now passes); held-out maps, report only, 262/264 [0.97, 1.00]. Wins 491 combat / 30 control, games ~3,500–6,200 ticks.
- While the KL penalty held (first ~5 M decisions) the training win rate stayed ~0.65 and the army was mixed. Once it annealed out the policy moved far from imitation (kl/ref 0.05 → ~3) and converged on **gunner mass only** (~55 gunners per game; no skirmishers, bruisers or medics). One strategy that beats every fixed scripted bot — the expected outcome without self-play, and the opposite of the adaptive bot the user wants; M2 self-play is where the plan addresses it.
- M1 status: E-1 ≥70% vs each scripted bot PASS on training maps; held-out reported. Still open for the full M1 gate: the LSTM step (memory, seat, truncation probes), the opponent-model head, and the playtest deliverable (local inference process so the user can play the policy). Stopped for the user.

### 2026-11-15 — Is gunner mass beatable? Fight test and counter bots (v0.8.17-ML)
- User asked what counters the PPO policy's gunner mass, whether gunners are too strong, and proposed a counter bot added to the pool. Agreed: fight test, then counter bots, report before any retraining or balance change.
- **Fight test** (`headless/src/v2/fightTest.ts`, output in `docs/balance/2026-11-fight-test.txt`). The triangle holds at equal cost when both sides attack, but the skirmishers' margin shrinks with army size (they keep 56% of their value at 5 gunners, 30% at 55). Skirmishers + medics keep 62–78% at every size. Bruisers lose to gunners as designed.
- **Finding: melee units that hold lose to gunners.** A unit with no order reacts only inside its weapon range, so idle skirmishers are shot without answering. On Guard they react further out but may not leave the guard circle (half sight), and gunners out-range it: gunners attacking skirmishers on Guard keep 74–96% of their army at 15+. Scripted bots wait on Guard, so they feed this. Not changed; for the user (the guard circle was a deliberate limit).
- **Counter bots** (`scripted.ts`: `swarm`, `swarm_mass`, `swarm_tide`; not in any training pool yet). The best, `swarm` (skirmisher 4 : medic 1, attacks at 18 units, regroups below 10, retreats when hurt), beats the PPO policy in 21% of 96 games; PPO wins 0.79 [0.70, 0.86]. Traces show equal-cost armies at ~2,000 ticks; when the swarm wins the first big fight it wins the game, when it trickles units into the gunner line it loses. Pure skirmishers without medics do worse (3%).
- Conclusion so far: the gunner mass is not unbeatable and the unit triangle is not broken in a straight fight, but nothing hand-written beats this policy outright, and two things favour gunners beyond their stats: ranged fire concentrating at scale, and melee units being unable to answer while holding.

### 2026-11-15 — G-14 retaliation: holding units answer fire (v0.8.18-ML, ENGINE_VERSION 16)
- User on the fight-test finding (melee units that hold are shot down by gunners): fixing it "is a must"; then re-try the swarm bots.
- **Rule** (`combat.ts`, constants `RETALIATE` in `gameBalance.ts`): when an enemy damages a unit or building, every combat unit of that owner (skirmisher, gunner, bruiser) within `assist` 200 px of the victim that has no target, has auto-attack on and is not on a plain move order targets the nearest such attacker, even outside its own reach or guard circle. It may go up to `chase` 320 px from its guard point (or from where it stood), then lets go and walks back; a guard stays a guard. On the way it fights the first enemy that comes within weapon range. Workers and medics do not retaliate; ordered targets and plain moves are untouched.
- Two versions were rejected on the fight test: everyone piling onto the first shooter made charging armies worse (55 gunners kept 61% against charging skirmishers they used to lose to); excluding units still walking to their guard point left most of a large guard group unresponsive.
- **Fight test after** (`docs/balance/2026-11-fight-test-g14.txt`; before in `2026-11-fight-test.txt`). Gunners attacking equal-cost skirmishers on Guard: before, gunners kept 74% / 96% / 93% at 15 / 30 / 55; now the skirmishers win and keep 37% / 26% / 24%. Both sides attacking is unchanged (skirmishers keep 56 / 48 / 40 / 24%). Skirmisher + medic on Guard still loses at 30+ (gunners keep 36–38%, was 92–93%): the medics do not follow the charge, as designed. Gunner mirror: the attacker's edge over a guarding side shrank (keeps 10–17%, was 33–38%).
- ENGINE_VERSION 16: older replays are hidden again. Goldens regenerated (20 cases, 176 hashes). 14 new tests (936/936 custom, 85/85 vitest), client type-checks.
- botCheck (700 games, 14 bots, 403 s): no exceptions, 0 ineffective, deterministic. As blue, W/L/T of 50: swarm 47/2/1, sw_turtle_grab 44/4/2, turtle 41/5/4, macro 38/7/5, swarm_tide 34/10/6, heavy 27/22/1, swarm_mass 27/22/1, sw_macro_bruiser 16/32/2, sw_rush_turtle 15/35/0, hidden 12/35/3, rush1 9/39/2, rush3 6/39/5, rush2 3/44/3, sw_fake_brush 3/42/5. Timeouts are down (0–6 per bot, was 2–15). The balance matrix is not re-run yet.
- The imitation and PPO checkpoints were trained on ENGINE_VERSION 15; their evaluations from here on are on the new engine.
- **Swarm bots re-tried on the new engine** (the PPO policy is unchanged, trained on engine 15). PPO's win rate over 96 games each: v `swarm` 0.79 → **0.46** [0.36, 0.56]; v `swarm_tide` 0.84 → 0.57; v `swarm_mass` 0.97 → 0.81. So the skirmisher + medic bot now wins 54% against the gunner mass. Against the original 11 bots PPO is still 0.98 [0.96, 0.99] (516/528); sw_turtle_grab 0.92 → 0.81. Caveat: the policy has never seen retaliation, so part of the drop is it being out of date rather than the counter being fair. Retraining decides.

### 2026-11-15 — Scripted-bot matrix on engine 16; bulwark (shield unit) prototype (v0.8.19-ML)
- **Matrix after G-14** (`docs/archive/raw-2026-11/balance/g14_matrix.{txt,json}`; 9 bots, 10 maps, 3,240 games). No rock-paper-scissors among the scripted bots: it is a ladder. `sw_turtle_grab` beats every other bot 80–96%, `turtle` beats all but it 84–99%, then `swarm` (beats macro 65%, heavy 59%, sw_macro_bruiser 83%, rushes 91–100%; loses to turtle 4%, sw_turtle_grab 20%), `macro`, `heavy`, `sw_macro_bruiser`, `swarm_mass`, rushes last. G-8 checks: "no strategy >70% vs every other" FAIL (sw_turtle_grab), mirrors PASS, timeouts 16% FAIL (<15%). The only cycle seen so far includes the trained policy: PPO gunner mass beats the turtles (0.96 / 0.81), turtles beat `swarm` (96% / 80%), `swarm` beats the PPO gunner mass (54%).
- User asked for new pieces to break up single-unit armies: a shield unit (user's idea, with feedback to bots when shots are blocked), a cheap forward outpost that trains skirmishers, and a banner support unit. Order agreed: 1 shield prototype in the engine with fight-test numbers, 2 build it properly if the numbers look right, 3 outpost.
- **Bulwark prototype** (engine only; no building produces it, so live games, replays and golden hashes are unchanged and ENGINE_VERSION stays 16). `UNIT_DEFS.bulwark`: 400 health, cost 125, 2 supply, speed 3.0, no attack; skirmishers and bruisers deal 1.5× to it. In `combat.ts`: a shot from a ranged attacker (weapon range ≥ 60: gunner, turret, medic) whose line to its target passes within `BULWARK.halfWidth` 20 px of an enemy bulwark's centre, with the shooter on the bulwark's front side, hits the bulwark instead (the first one along the shot). Melee hits are never intercepted. The attack log entry carries `blockedFor` (the unit the shot was aimed at) for visuals and bot feedback.
- Choices made in the prototype, for the user to confirm: (a) the bulwark faces the enemy crystal and "front" is the whole half-plane on that side; (b) enemies give it the same target priority as a worker, so they aim at armed units and the shots are blocked, instead of treating it as the nearest target; (c) on attack-move it stops 100 px from the nearest enemy combat unit or turret (`BULWARK.standoff`), which puts it ~30–40 px in front of its own gunners.
- **Fight test** (`npx tsx headless/src/v2/fightTest.ts --shield [--hp N --cost N --width N]`, output `docs/balance/2026-11-shield-prototype.txt`; equal cost, open ground, shields start in a line in front). Both sides attacking, share of army value the winner keeps:
  - Gunners + shields v pure gunners (a mirror without shields is a draw): at 1,125 resources with 2 / 3 / 4 shields the shield side keeps 42 / 52 / 51%; at 2,250 with 2 / 4 / 6 / 8 it keeps 24 / 38 / 44 / 42%. About a quarter of shots are blocked with 2 shields per 15 gunners, a third or more with 4.
  - Health is the main lever: at 300 health the same mixes keep 28 / 27 / 12% (1,125) and 2 / 20 / 18% (2,250); at 250 health the shield side loses with 3 or more shields. 300 health at cost 100: 29 / 40 / 46% and 2 / 30 / 35%. Front ±14 px: 39 / 42 / 40%; ±28 px: 42 / 50 / 53%.
  - Against melee the shields are dead weight: equal-cost skirmishers keep 48% v pure gunners, 52% v gunners + 2 shields, 66% v gunners + 4 shields; gunners still beat bruisers but keep 66% instead of 75%.
  - Shields do not help melee armies: skirmishers + 2 shields keep 44% v gunners (48% without), and lose with 4; bruisers + shields still lose. The shield moves at 3.0 (skirmisher 4.0, bruiser 3.6) and stops short of the enemy.
  - Turrets: gunners already out-range turrets on attack-move (they stop ~146 px out, turrets reach ~131 px), so the turrets shoot the shield as the only thing in reach. 15 gunners v 3 turrets keep 65%; with 1 / 2 / 4 shields 72 / 69 / 67%. Against 3 turrets + 8 gunners, 15 gunners lose (defender keeps 43%) and 12 gunners + 2 shields win (keep 16%); at double size shields change nothing (defender keeps 19–20%). At 300 health there is no gain against turrets.
  - Medics behind shields add nothing (10 gunners + 2 shields + 2 medics keep 37% v 15 gunners, less than 12 gunners + 2 shields).
  - Shield mirror: a draw when both attack.
- Also seen: a melee unit that reaches a shield before any armed enemy is in its reach (about 46 px) hits the shield, as it would a worker, and switches only when an armed enemy comes into reach. Interception is of shots, not of attention.
- First run of the health and width variants was invalid and was re-run: the test's overrides changed a different copy of the balance file from the one the engine loads (the test now imports `@crystalfront/shared`).
- 9 new tests (945/945 custom, 85/85 vitest); golden hashes unchanged.
- Stopped for the user: confirm or change health/cost and choices (a)–(c) before step 2 (model, command card, scripted bots, observation/actions, ENGINE_VERSION bump).

### 2026-11-15 — Bulwark built into the game; `phalanx` bot (v0.8.20-ML, obs schema 3, action space 4)
- User on the prototype's open choices: front = anything from the enemy-crystal side ("makes life easier and since its slower, that's the payoff"); target priority low; stand-off agreed, "it shouldnt be able to attack"; "continue to step 2". Health and cost were not answered: built with **300 health, cost 125** (2 supply, 180 ticks, speed 3.0), the cautious end of the fight test. Target priority stays at worker level.
- **Game.** The foundry trains it (`produces: bruiser, medic, bulwark`). An `attack` order on a bulwark is rejected ("This unit cannot attack"); the client turns a right-click on an enemy into an attack-move to that spot. Bulwarks do not hold control nodes. ENGINE_VERSION stays 16: games without bulwarks are bit-identical (golden hashes unchanged), so existing replays stay valid.
- **Client.** Command card: W on a foundry (not offered when a barracks is selected too, where W is taken). 2D: round body with an arc on the side facing the enemy crystal. 3D: the knight model holding two large shields, turned toward the enemy crystal when idle. A blocked shot is drawn pale blue with a ring (2D) or spark burst (3D) on the shield. Replay browser counts bulwarks as `W{n}`. **Not looked at in a browser** (none on the training machine): the 3D model and effects need the user's eyes.
- **Bot interface.** Action space 4: train ×6 (62 econ kinds), group `bulwarks` (11 groups), bulwarks take every order but `focus`. Observation schema 3: 57 globals, 33 entity features. The user's idea of telling bots when shots are blocked is two globals over the last decision window: `shots_blocked` (share of own ranged shots stopped by enemy bulwarks) and `shots_shielded` (share of enemy ranged shots stopped by own). A lone gunner fires every 15 ticks and the window is 8, so the value is 0 between shots; scripted bots use a decaying peak. `training/v2/spaces.py` and `training/env/vec_env_v2.py` updated (the env test and 2-update PPO and imitation smoke runs pass). All checkpoints are now unusable (layouts changed).
- **Scripted bots.** Existing bots keep their mixes (user: "happy for most bots to keep mixed armies"). New template and bot `phalanx` (z 19): 7 workers, barracks, foundry, second barracks, gunner 4 : bulwark 1, push at 12, regroup below 6, retreat at 30% health. Every scripted bot now reacts to blocked shots: once the decayed peak of `shots_blocked` passes 0.2, half of new production goes to its melee unit (skirmisher, else bruiser). Focus orders skip enemy bulwarks. A bulwark near enemies with no armed ally within 300 px is sent home.
- **Finding: in real games the shields first blocked almost nothing.** `phalanx` on shardfall v macro, rush2, swarm, turtle (8 games): 3.6% of the enemy's ranged shots blocked, 29% aimed straight at shields. Traces showed why: the scripted army is never together. Every bot re-issues attack-move to all combat units, so reinforcements walk from base in a line, and the shields (low priority, so they outlive their gunners) end up at the front beside one to three gunners.
  - Tried and removed: an engine rule that held a bulwark on attack-move when it got more than 60 px ahead of its nearest armed ally. No measurable change, so it is not in the game.
  - Kept (bot only, `mass: true`, used by `phalanx` alone): push and regroup sizes count the units within 400 px of the army's foremost unit instead of the whole army, and the bot waits at its choke instead of its base. Same 8 games: 9.1% blocked, 22% aimed at shields.
- **Matrix** (`docs/archive/raw-2026-11/balance/bulwark_matrix.{txt,json}`; 7 bots, 10 maps, 1,960 games). `phalanx` scores 99% v heavy, 97% v rush2, 84% v macro, 74% v turtle, 44% v sw_turtle_grab, 40% v swarm. Before the grouping rule: 99 / 100 / 55 / 66 / 15 / 29%. G-8 checks: "no strategy >70% vs every other" now **PASS** (sw_turtle_grab is 56% v phalanx), mirrors PASS, timeouts 18% FAIL. A cycle among scripted bots now exists: phalanx beats turtle (74%), turtle beats swarm (96%), swarm beats phalanx (60%).
- **Control: the gain is the grouping, not the shield.** A temporary bot `gunline` (not committed: the `phalanx` template without the foundry and bulwarks, gunners only, same `mass` rule and choke staging) was run against the same bots (`bulwark_control_matrix.{txt,json}`, 1,440 games). It beats `phalanx` 69% and does better against everything: macro 100% (phalanx 84%), turtle 95% (74%), sw_turtle_grab 88% (44%), swarm 65% (40%). So at 300 health / cost 125 the bulwark is a net loss in a scripted bot's hands: the foundry and shields cost more than the 9% of shots they stop. With bulwark health 400 (`bulwark_control_hp400_matrix.{txt,json}`, 640 games, temporary edit) it is no better: phalanx 35% v gunline, 35% v swarm, 85% v turtle. Health alone is not the lever in real games; how much of the enemy's fire actually crosses a shield is.
  - Second reading of the same table: massed gunners are the strongest scripted strategy by a distance (≥65% against every bot tried), which is what the PPO policy found. The earlier ladder was partly an artefact of every bot trickling its army.
  - For the user (balance, not changed): the unit works as designed but does not pay for itself in bot play. Levers: a wider front (`BULWARK.halfWidth`, 20 px now; the fight test gained little from 28 px in tight formations but real armies are spread out), lower cost, or bot positioning (shields ahead of the gunners rather than among them). A human or a trained policy may place shields better than the scripted bots do.
- botCheck (750 games, 15 bots): no exceptions, 0 ineffective, deterministic; as blue phalanx W43 L6 T1, swarm 48/1/1, turtle 41/5/4, sw_turtle_grab 38/9/3, macro 38/7/5.
- 9 new tests (954/954 custom, 85/85 vitest); client type-checks; golden hashes unchanged.
- Next: step 3, the forward outpost (cost 50, 50 ticks, 50 health, skirmishers only), then the banner unit, then retrain from scratch with `swarm` and `phalanx` in the pool.

### 2026-11-15 — Cover order, wider shield front, `gunline` bot (v0.8.21-ML, obs schema 4, action space 5)
- User on the step 2 finding (shields stop 9% of shots, a gunners-only control beats `phalanx`): try the wider front, and "can the bots and our agent have control to place the shield between friendly and enemy units? some system of targeting friendly units with shield to make them stand in front and follow their direction? it could also make the unit walk slower to match the shield speed". Keep the gunners-only bot ("yep good idea"). Bulwarks stay unable to hold control nodes ("they'd be far too good at that otherwise").
- **Cover order** (engine command `cover`, bulwarks only, target = an own unit that is not a building, crystal or bulwark). The bulwark stands `BULWARK.coverDist` 40 px from its unit, on the side of the nearest visible armed enemy within `coverSense` 300 px of the unit, else on the enemy-crystal side, and follows the unit. Several bulwarks on one unit stand side by side (80 px apart). A bulwark that is behind its unit with the unit in the way first steps to the side. Any other order to the bulwark ends the cover; so does the unit dying. The covered unit walks no faster than the bulwark (3.0) while the bulwark is within 300 px.
  - The shield's blocking side is unchanged: it still faces the enemy crystal. A bulwark that stands toward an enemy coming from behind does not block that enemy's shots.
  - Tried and removed: making the covered unit wait for its shield (90% of shield speed while the shield was moving to its place, 60% when it was more than 20 px off). It did not raise the blocked share (22.1% with it, 21.5% without, same 8 games) and cost wins: `phalanx` v `gunline` 50% with it, 63% without; v `swarm` 24% and 33% (80 games each). Plain speed matching, as the user asked, is what shipped.
- **Wider front.** `BULWARK.halfWidth` 20 → 40 px (blocks shots passing within 40 px of its centre). Sweep with the cover order, 4 bots, 640 games per width (`docs/archive/raw-2026-11/balance/bulwark_cover_width{20,30,40}.*`): `phalanx` v `gunline` 43% / 44% / 61% at 20 / 30 / 40; v `swarm` 47 / 47 / 48%; v `turtle` 88 / 86 / 88%. Only 40 pays for the foundry and shields. Health 300 and cost 125 are unchanged.
- **Blocked share**, `phalanx` on shardfall v macro, rush2, swarm, turtle, seeds 7 and 8 (enemy ranged shots at `phalanx` that a bulwark intercepted): 3.6% at first, 9.1% with the grouping rule, 15.1% with cover, **21.5%** with cover and the 40 px front (another 21.5% are aimed straight at shields). Shields are covering 96–100% of the time. Against `gunline` (2 games): 15.6%.
- **Client.** Right-click a friendly unit with bulwarks selected to cover it. The 2D bulwark draws a faint line of the blocked width. The 3D model is not widened. Not looked at in a browser.
- **Bot interface.** Action space 5: order `cover` appended (index 11, 12 orders), legal for bulwarks only, pointer target = own movable unit that is not a bulwark. A covering bulwark ignores orders given to `all_combat`, `army_a`, `army_b` (so a whole-army order does not pull the shields off their units); orders to `bulwarks` or `unit` replace the cover. Observation schema 4: entity features `covering` and `covered` appended (35). Python constants updated; env test and 2-update PPO and imitation smoke runs pass. Checkpoints were already unusable; layouts changed again.
- **Scripted bots.** `gunline` is permanent (z 20): gunners only, two barracks, push at 12, regroup below 6, stage at the choke, `mass` rule. Every scripted bot with bulwarks gives each one a `cover` order on the nearest gunner that has no shield yet (else the nearest armed ally); with no armed ally nearby and enemies close, the bulwark goes home.
  - `mass` rule changed: it counted units within 400 px of the foremost unit, which made a 100-unit army switch between push and regroup every few decisions and time out against rush2. It now counts units within 400 px of the army's middle unit (ranked by distance to the enemy base).
- **Matrix** (`docs/archive/raw-2026-11/balance/cover_matrix.{txt,json}`; 8 bots, 10 maps, 2,560 games). `phalanx`: 63% v gunline (was 31% before cover and the wider front), 33% v swarm, 80% v macro, 100% v heavy, 76% v turtle, 46% v sw_turtle_grab, 100% v rush2. `gunline`: 65% v swarm, 99% v macro, 100% v heavy, 90% v turtle, 63% v sw_turtle_grab. G-8 checks: dominance PASS (no bot beats every other >70%), mirrors PASS, timeouts 17% FAIL (<15%; 319 of the 439 are mirror games, which nearly always time out).
  - There is now a three-way cycle between army types: shields + gunners beat gunners (63%), gunners beat skirmisher + medic (65%), skirmisher + medic beats shields + gunners (68%). `sw_turtle_grab` sits beside it: 54% v phalanx, 38% v gunline, 80% v swarm.
  - Shields are a liability against melee, as in the fight test: `phalanx` v `swarm` 33%.
- botCheck (800 games, 16 bots): no exceptions, 0 ineffective, deterministic. As blue, W/L/T of 50: gunline 45/2/3, turtle 41/5/4, swarm_tide 40/7/3, phalanx 39/5/6, macro 38/7/5, swarm 37/11/2, sw_turtle_grab 34/12/4.
- ENGINE_VERSION stays 16: games without bulwarks are bit-identical (golden hashes unchanged) and no stored replay contains a bulwark.
- 15 new tests (969/969 custom, 85/85 vitest); client type-checks.
- Next: step 3, the forward outpost (cost 50, 50 ticks, 50 health, skirmishers only), then the banner unit, then retrain from scratch with `swarm`, `phalanx` and `gunline` in the pool.

### 2026-11-15 — Forward outpost (step 3; v0.8.22-ML, obs schema 5, action space 6)
- User's numbers (2026-11-15): cost 50 ("perceivably cheaper"), build time 50 ("normal barracks is 3x slower"), health 50 ("very weak very risky"), skirmishers only, no warp-in; "something similar to the forward barracks strat in AOE2 with some heavy drawbacks". Training speed 75 ticks per skirmisher (100 at a barracks) was the suggestion on the table and was not changed.
- **Correction to what the user was told.** The proposal said "barracks can already be placed forward". They cannot: every building is limited to its owner's half of the map and kept out of a 400 px strip down the centre. So a forward building needs its own placement rule.
- **Placement rule (default chosen here, for the user to confirm).** The outpost may go anywhere on the map, either half and the centre strip included, on ground its owner can see at that moment (`BUILDING_DEFS.outpost.anywhere`; engine message "Not in sight"). The sight rule is there because a build site is solid and gives vision from the moment it is placed: without it 50 resources would buy a look at, or a block on, any spot on the map. Every other rule applies as for other buildings (terrain, 50 px spacing, no sealing a crystal, not on a node or another entity).
- **Engine.** `outpost`: cost 50, 50 ticks, 50 health, 32 × 32, vision 150, `produces: ["skirmisher"]`, `trainTimeMult 0.75`. One worker builds it; the worker still has to walk there. No prerequisite, no limit on how many, repairable like any building. ENGINE_VERSION stays 16 (games without outposts are bit-identical; golden hashes unchanged).
- **Client.** Worker command card: A = Outpost. Q on an outpost trains a skirmisher; F sets its rally point. 2D: a tent with a pennant. 3D: the barracks tent and flag without the platform. The placement preview is green anywhere for an outpost; the server still refuses a spot out of sight. Not looked at in a browser.
- **Bot interface.** Action space 6: building `outpost` appended (63 economy kinds, site mask 5 × 760); the outpost's site mask follows vision. `train skirmisher` uses a free outpost before a free barracks. Observation schema 5: 61 globals, 36 entity features, 15 memory features. Python constants updated.
- **Scripted bots.** Build steps can be `forward`: placed at the legal site nearest the army's middle unit, once that unit is on the enemy half. Two new bots: `outrider` (z 21: the `swarm` build plus two forward outposts, so `swarm` is its control) and `rush_post` (z 22: `rush2`'s skirmisher rush from two outposts at home in place of the barracks, pushing at tick 300).
- **Matrix** (`docs/archive/raw-2026-11/balance/outpost_matrix.{txt,json}`; 9 bots, 10 maps, 3,240 games). Pairings among the existing bots are unchanged from the cover matrix (same numbers), so nothing else moved.
  - **Forward outposts do not pay in scripted play.** `outrider` against its control `swarm`: 43%. Against the rest it is level with or below `swarm`: v phalanx 49% (swarm 68%), v gunline 18% (35%), v macro 61% (65%), v turtle 3% (4%), v sw_turtle_grab 23% (20%), v rush2 98% (98%). Traces (shardfall, 10 games): the outposts go down just past the map's middle (53% across), the worker takes about 760 ticks to walk there and build, and in lost games only 4–33 skirmishers were trained there before the outposts fell; one long game trained 128.
  - **Outposts at home make the rush better but not good.** `rush_post` beats the barracks rush `rush2` 78%, and wins 13 of 50 as blue in botCheck against 3 for `rush2`. It still loses to every non-rush bot (0–13%). So the cheaper, quicker building has not made rushing dominant.
  - G-8 checks: dominance PASS, mirrors PASS, timeouts 17% FAIL (<15%).
  - Tried and removed: making `outrider` gather at its forward outpost instead of at its base. Against swarm / gunline / phalanx (80 games each): 43 / 24 / 61% with it, 43 / 18 / 49% without. Still below the control in every pairing, so it is not in the bot.
- botCheck (900 games, 18 bots): no exceptions, 0 ineffective, deterministic. As blue, W/L/T of 50: gunline 47/1/2, turtle 41/5/4, outrider 40/9/1, macro 38/7/5, phalanx 36/11/3, sw_turtle_grab 34/12/4, swarm 33/15/2, rush_post 13/34/3, rush2 3/44/3. (Each bot's opponents come from the bot list, so numbers move when bots are added.)
- Python: `training/test_vec_env_v2.py` carried its own copy of the economy indices, still at the action space 3 values (6, 10, 58); it passed by luck through steps 2 and 2b and failed now. It reads them from `training/v2/spaces.py`. Only the test's random-action helper was affected, not training. Env test and 2-update PPO and imitation smoke runs against the outpost bots pass.
- 15 new tests (984/984 custom, 85/85 vitest); client type-checks; golden hashes unchanged.
- For the user: (1) the placement rule above; (2) whether the outpost should need something first (today a player can open with an outpost at tick 0, since it costs the 50 starting resources); (3) whether to change it given that scripted bots get nothing from it forward, or leave it for the retrain to find a use. Levers if wanted: faster training, a shorter worker trip (e.g. any unit can place it), or cheaper skirmishers there.
- Next: the banner unit (as a unit; suggested aura about 80 px, +15% attack speed, not stacking), then retrain from scratch with swarm, phalanx, gunline, outrider and rush_post in the pool.

### 2026-11-16 — Outpost round 2: barracks rule, escort and backdoor bots, training speed (v0.8.23-ML, action space 7)
- User's answers (2026-11-16) to the four open points of the outpost step:
  1. Placement stays "anywhere you can see": "i like the idea of sneaking a worker all the way to the enemy crystal then building a mass of scavengers and winning that way, a 'backdoor' strategy".
  2. Prerequisite: "should require a barracks having been built. If a barracks is destroyed when an outpost is built and not destroyed, it becomes unable to train units".
  3. Balance: "I like faster training as our main lever"; asked for scripted bots that escort a worker forward and defend it while it builds ("unleash from close up once done"), the backdoor, and a late escort for "turtle players that have amassed an army". Expected: "Turrets or any guarding army will counter this, but it may beat a careless straight line rush."
  4. Banner unit: "doesn't really solve a problem yet and would be a 'build no matter what' unit. Let's leave it documented as designed but no plans to implement right now".
- **Barracks rule (engine).** `BuildingDef.requires` (outpost: `"barracks"`). Without a finished barracks an outpost cannot be placed ("Requires a Barracks") and takes no unit ("Needs a barracks"), and a queue already running stands still until its owner has a finished barracks again. Reading taken: any finished barracks counts, and rebuilding one switches the outposts back on. An outpost under construction is still finished by its worker. ENGINE_VERSION stays 16: no saved replay contains an outpost, and games without outposts are bit-identical (golden hashes unchanged).
- **Client.** The worker card shows "Outpost (needs Barracks)" until a barracks is finished and the placement preview is red. Not looked at in a browser.
- **Bot interface (action space 7; same sizes, observation schema still 5).**
  - `build outpost` is masked off without a finished barracks; `train skirmisher` skips outposts then.
  - An outpost is built by the free worker nearest the site, the scout included. Other buildings keep "any free non-scout worker".
  - `move`, `attack_move` or `guard` given to a worker through the `unit` group makes it the seat's scout, which takes it off the worker autopilot. So a bot or the agent can walk a worker somewhere, keep it there, and have it build an outpost on the spot. Before this the only way to park a worker was the `scout` group, which picks a skirmisher whenever one is free.
  - Outposts take rally points and queue cancels (left out of the producer list in v0.8.22).
  - Not added: no action resumes a building whose builder died (true of every building; it shows up more with outposts at the front). The bots place a new one instead.
- **Scripted bots.** The old "build beside the army during the push" step is gone (`BuildStep.forward`). Templates now have `post`:
  - `escort`: when the push starts, a worker is sent to walk with the army's middle unit; the army heads for the enemy choke under a guard order; once the middle unit is on the enemy half and the worker is beside it the outposts are built one after another (about 50 ticks each instead of about 760 with a worker walking from home); the push goes on when they stand, or after 1,800 ticks. With outposts standing, skirmishers are trained there first.
  - `backdoor`: from tick 600 one worker walks along the top or bottom map edge (seeded) to a spot 320 px beside the enemy crystal and builds three outposts. Nothing is trained at home on its last leg, so the outposts open with resources in hand. Skirmishers are trained there first, gather to 8, then attack the crystal itself (a focus order). The gunners at home play the turtle's game.
  - Bots: `outrider` (z 21, now the swarm with an escort), `rush_post` (z 22, now a barracks plus two home outposts; its control is `rush3`), `backdoor` (z 23, turtle build), `siege` (z 24, turtle build, 14 gunners from tick 3,000 escort a worker and build three outposts). 20 bots.
  - Two bugs found by tracing and fixed before measuring: the walk order to the worker replaced its build order in the same decision (outposts placed, never built), and the escort waited for the army to reach the choke (in 5 of 8 sampled games it was stopped short and never built).
- **Does the escort pay?** Control `hold` = the same bot with the build switched off (it holds the same way, then pushes). 40 games per pairing, outpost training 0.75×:

  | v | swarm | gunline | phalanx | macro | turtle | rush3 |
  |---|---|---|---|---|---|---|
  | `outrider` | 43% | 45% | 60% | 95% | 15% | 90% |
  | `hold` (no outposts) | 50% | 45% | 58% | 95% | 15% | 90% |
  | `swarm` | – | 20% | 60% | 95% | 5% | – |

  The gain over `swarm` against gunners (45% v 20%) comes from gathering at the enemy choke before attacking, not from the outposts. The outposts themselves add nothing measurable.
- **Training speed sweep** (the user's lever; `docs/archive/raw-2026-11/balance/outpost_speed_sweep.txt`). 40 games per pairing, speeds 0.75× / 0.5× / 0.33×, averaged over swarm, gunline, phalanx, macro, turtle, rush3: `outrider` 58 / 58 / 58%, `siege` 62 / 60 / 61%, `rush_post` 22 / 18 / 19%, `backdoor` (before the crystal focus) 43 / 44 / 42%. No effect. These bots spend their income as it arrives, so they are limited by income, not by how fast a building trains.
- **Backdoor with a direct attack on the crystal.** The strike was first an attack-move, which stops for everything on the way: 28% v `swarm`. With a focus order on the crystal: 50%. A crystal has 1,000 health and 8 skirmishers do about 10 a tick, so a strike that arrives wins in about 100 ticks. Sweep with the focus order, 80 games per pairing:

  | speed | swarm | phalanx | macro | gunline | heavy | mean |
  |---|---|---|---|---|---|---|
  | 0.75× | 50% | 44% | 61% | 28% | 51% | 47% |
  | 0.5× | 40% | 40% | 60% | 28% | 61% | 46% |
  | 0.33× | 61% | 43% | 51% | 24% | 44% | 45% |
  | 0.25× | 68% | 33% | 59% | 24% | 47% | 46% |

  One cell is about ±5.5 points. Only the `swarm` column rises at the fastest two settings, and it dips at 0.5×; the mean does not move. `swarm` is the opponent that marches its whole army out of its base, which is the "careless straight line rush" case the user described.
- **Speed chosen: 0.5× (a skirmisher in 50 ticks, was 75).** The scripted games cannot choose a value: nothing between 0.75× and 0.25× changes the results on average. 0.5× is a modest step in the direction the user asked for and keeps the outpost's numbers at 50 / 50 / 50 / 50. Where speed should matter is a player who arrives with resources saved and wants them on the field at once, which none of these bots does well.
- **Risk noted for the user.** At home an outpost is now a 50-resource building that trains skirmishers twice as fast as a 75-resource barracks; only its 50 health and the one barracks it needs hold it back. `rush_post` (barracks + two home outposts) against `rush3` (two barracks) is level (55 / 50 / 50% across the sweep), so bots do not show a problem, but a player with spare resources and too few barracks could use home outposts as cheap production. One way to close that, if wanted: the speed bonus only on the enemy half of the map.
- **Matrix at the shipped settings** (`docs/archive/raw-2026-11/balance/outpost2_matrix.{txt,json}`; 11 bots, 10 maps, 2 seeds per side, 2,420 games, 40 per pairing so one cell is about ±8 points):

  | v | swarm | phalanx | gunline | macro | turtle | sw_turtle_grab | rush3 |
  |---|---|---|---|---|---|---|---|
  | `outrider` | 38% | 75% | 50% | 55% | 25% | 30% | 85% |
  | `swarm` (its base build) | – | 80% | 23% | 55% | 0% | 10% | 88% |
  | `siege` | 85% | 51% | 38% | 90% | 53% | 38% | 90% |
  | `backdoor` | 30% | 45% | 13% | 57% | 35% | 40% | 95% |
  | `turtle` (their base build) | 100% | 28% | 18% | 83% | – | 28% | 98% |
  | `rush_post` | 18% | 3% | 0% | 20% | 15% | 10% | 65% |

  - `siege` is the strongest of the new bots: it beats `backdoor` 70% and `outrider` 60%, and does better than `turtle` against phalanx, gunline and macro, at the price of 85% instead of 100% against `swarm`. How much of that is the outposts and how much the late 14-gunner push was not separated.
  - `backdoor` gives up the turtle's hold on `swarm` (30% here, 40–50% in the sweeps on other seeds) for a second way to win; `gunline`, which sits at its own choke and comes home at once, beats it 88%.
  - `rush_post` beats the two-barracks rush 65% and loses to everything else.
  - G-8 checks: dominance PASS, mirrors PASS, timeouts 19% FAIL (<15%; was 17%: the two new turtle-based bots add long games).
- botCheck (1,000 games, 20 bots): no exceptions, 0 ineffective actions, deterministic. As blue, W/L/T of 50: siege 44/3/3, turtle 41/5/4, gunline 39/6/5, outrider 38/10/2, macro 38/7/5, sw_turtle_grab 34/12/4, swarm 32/14/4, backdoor 26/12/12, phalanx 22/18/10, rush_post 18/24/8.
- Checks: 998/998 custom tests and 85/85 vitest (14 new: barracks rule in the engine and masks, forward builder, worker-to-scout, the three bots building and training at their outposts, backdoor beating an undefended base); client type-checks; golden hashes unchanged; Python env test and 2-update PPO and imitation smoke runs against the four outpost bots pass.
- **Banner unit: designed, not planned** (user, 2026-11-16). The design on file: an unarmed unit that gives allies within about 80 px +15% attack speed, not stacking. Reason for shelving: it solves no problem yet and would be built in every army.
- Next: retrain from scratch with swarm, phalanx, gunline, outrider, siege, backdoor and rush_post in the pool (imitation first, then PPO), once the user has confirmed the outpost speed.

### 2026-11-16 (later) — Outpost fast only on the enemy half; a backdoor that hides (v0.8.24-ML)
- User's answers (2026-11-16) to the v0.8.23 report:
  1. Hiding: "does this bot carefully place it's units outside of range of view of it's opponents? i'd love to have a bot or two that properly exhibits 'hiding' behaviour".
  2. Speed: "Maybe faster to 25".
  3. Home outposts: "let's do it that way, all differences between barracks (placing speed, training speed etc) only kick in in enemy half".
  4. "eyeball my suggestions and see if we should implement, if so then matrix, then retrain".
- **Enemy-half rule (engine).** `BuildingDef.forward = { buildTime, trainTimeMult }` replaces `trainTimeMult`. An outpost on its owner's enemy half (nearer an enemy crystal than the owner's own; on every pool map the crystals are at x = 100 and x = 4,900, y = 450, so this is the vertical centre line) is built in 50 ticks and trains a skirmisher in 25 (0.25×). On the owner's own half it takes 150 ticks, a barracks's time, and trains at normal speed. Reading taken of "all differences": the two speed advantages. Cost (50), health (50) and skirmishers-only are the same on both halves; a cost that depends on where the building is put was left out as harder to show on the card. Open with the user. ENGINE_VERSION stays 16 (no saved replay has an outpost; golden hashes unchanged).
- **Client.** The placement preview of an outpost says "Enemy half: fast to build, fast training" or "Own half: no faster than a Barracks". Not looked at in a browser.
- **Was the backdoor hiding? No.** Measured before the change, 100 games (5 opponents × 10 maps × 2 seeds, backdoor as blue; window = from the worker crossing the centre line to the first skirmisher within 250 px of the enemy crystal): the worker was in the enemy's sight before its first outpost in 100 of 100 games, something of the backdoor was in sight 56% of the window, and its skirmishers were out of sight 2% of the time. The spot was a fixed 320 px beside the enemy crystal, 95 px outside the crystal's own sight and inside that of the workers at the enemy's nodes.
- **Hiding (scripted bots only; the policy gets nothing new).** `BotContext.sight(p, kind)`: the action-grid cells a watcher of a given kind at a point sees, from the engine's own line-of-sight sets (rock and high ground block, as in the game). `BotContext.brushCell`: cells where a unit stands in brush. From these and its own fogged observation the backdoor keeps a map of watched ground: level 2 for the enemy crystal, the workers at the enemy's own nodes and at nodes it holds, enemy buildings it remembers and enemy units in sight now; level 1 for likely places (enemy pockets and chokes, the centre).
  - *Spot:* the reachable open ground nearest the enemy crystal (250–900 px) that is not watched, on the bot's seeded side when there is a choice; given up if a watcher turns up before the first outpost.
  - *Route:* cheapest path over the grid with watched ground costing 25× (likely: 4×), re-planned on every order (32 ticks), walked in the longest straight pieces that stay off watched ground.
  - *Outposts:* on unwatched cells near the worker when there are any.
  - *Skirmishers:* wait in brush within 300 px of the outposts if there is some, else at the outposts; strike at 8 as before.
  - Two bugs found on the way: the turtle build's home army order flips between two own-half nodes every decision, which left the worker without orders for 2,500 ticks on cinder-flats (the backdoor's worker and skirmisher orders now go first; the flip itself is left alone and noted); a cell the worker cannot walk to is dropped from the routes.
- **Result, same 100 games:**

  | | wins | worker seen before 1st outpost | in sight, share of window | skirmishers out of sight |
  |---|---|---|---|---|
  | before (fixed spot, map-edge route) | 42% | 100 / 100 | 56% | 2% |
  | hiding | 78% | 78 / 100 | 27% | 49% |

  By opponent, wins before → after: swarm 62 → 70%, phalanx 28 → 92%, gunline 20 → 60%, macro 58 → 88%, heavy 42 → 82%. The worker is still seen in most games at some point on the way: first by an enemy worker in 40 games (nodes on the enemy half that the bot has not seen worked yet) and by a gunner in 24 (300 px sight against the worker's own, so it is seen before it sees). Treating every enemy-half node and choke as watched was tried and was worse: no free route was left, 53 of 100 games placed an outpost and wins fell to 54%. Reverted.
- **Matrix at these settings** (`docs/archive/raw-2026-11/balance/outpost3_matrix.{txt,json}`; 11 bots, 10 maps, 2 seeds per side, 2,420 games, 40 per pairing, one cell about ±8 points):

  | v | outrider | siege | backdoor | rush_post | swarm | phalanx | gunline | macro | turtle | sw_turtle_grab | rush3 |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | `backdoor` | 60% | 60% | – | 83% | 55% | 100% | 85% | 80% | 78% | 75% | 90% |
  | `backdoor`, v0.8.23 | 55% | 30% | – | 88% | 30% | 45% | 13% | 57% | 35% | 40% | 95% |
  | `outrider` | – | 35% | 40% | 88% | 45% | 75% | 55% | 53% | 35% | 30% | 85% |
  | `siege` | 65% | – | 40% | 95% | 80% | 46% | 38% | 93% | 48% | 35% | 90% |
  | `rush_post` | 13% | 5% | 18% | – | 3% | 15% | 0% | 25% | 3% | 13% | 50% |

  - **The hiding backdoor is now the strongest scripted bot.** It scores 55% or more against every other bot (lowest: `swarm` 55%, `outrider` and `siege` 60%). The G-8 dominance check (no bot above 70% against every other) still passes, narrowly in spirit. With the same 25-tick training and no hiding it won 42% of the 100 measured games, so the hiding is what changed it; no scripted opponent scouts its own base surroundings or keeps anything at its crystal. Whether a human or the trained agent stops it by looking is the open question. Flagged to the user as a balance checkpoint.
  - `rush_post` (a barracks plus two outposts at home) against `rush3` is 50% and it loses to everything else: home outposts no longer pay, as intended.
  - `outrider` and `siege` are within noise of v0.8.23 (their outposts are on the enemy half, where 25 ticks instead of 50 changes nothing measurable, as the speed sweeps said).
  - G-8: dominance PASS, mirrors PASS, timeouts 16% FAIL (<15%; was 19%).
- botCheck (1,000 games, 20 bots): no exceptions, 0 ineffective actions, deterministic. As blue, W/L/T of 50: siege 44/3/3, backdoor 42/4/4 (was 26/12/12), turtle 41/5/4, macro 38/7/5, outrider 37/13/0, sw_turtle_grab 34/12/4, swarm 31/17/2, gunline 30/15/5, rush_post 22/23/5, phalanx 20/25/5.
- Checks: 1,002 custom tests and 85 vitest (new: an outpost on the own half takes a barracks's build time and trains at normal speed; no backdoor outpost is in the enemy's sight when placed); client type-checks; golden hashes unchanged; PPO and imitation smoke runs pass.
- Noted, not changed: the turtle build's waiting army gets a new guard order every decision (its staging node alternates between two own-half nodes).
- Next: retrain from scratch, imitation first (`m2-imitate`, all 20 scripted bots as teachers), then PPO from it.
- Run `m2-imitate` started (b17e76e, v0.8.24-ML): behaviour cloning from all 20 scripted bots on the 8 training maps, 10 M decisions, lr 3e-4 → 3e-5, 2 epochs × 16 minibatches, seed 1; about 330 decisions/s. Gate as for `m1-imitate`: the imitation policy alone wins ≥40% (lower bound) against the pool.
- `m2-imitate` crashed 6 minutes in, at the first finished episodes: the per-unit production counter in `training/v2/train.py` had 5 slots and there are 6 trainable units since the bulwark (the 2-update smoke runs end before any episode does). Fixed (v0.8.25-ML), run restarted from zero with the same settings.

### 2026-11-17 — `m2-imitate` done, gate passed; `m2-ppo-kl` started
- User (2026-11-16): not worried about the backdoor's strength ("the agent will work it out very quickly"); home outpost cost left to me (kept at 50 on both halves); no second hiding bot.
- `m2-imitate`: 10 M decisions, 272 updates, 10.8 h, ~295 decisions/s. Loss 1.99 → about 0.65.
- **Gate eval** (`docs/eval/m2-imitate.json`; final.pt alone, sampled actions, 20 bots × 8 training maps × 2 seats × 3 seeds = 960 games): **469 W / 413 L / 78 D = 0.49 [0.46, 0.52] → PASS** (lower bound ≥ 0.40). By bot: rush1 0.90, sw_fake_brush 0.85, hidden 0.79, rush_post 0.77, rush3 0.71, rush2 0.67, sw_rush_turtle 0.65, macro 0.60, swarm_mass 0.60, heavy 0.44, sw_macro_bruiser 0.42, phalanx 0.40, swarm_tide 0.40, swarm 0.33, siege 0.33, turtle 0.31, outrider 0.31, gunline 0.12, backdoor 0.10, sw_turtle_grab 0.06. No illegal actions.
- The imitation policy is weakest against the three bots that are strongest in the scripted matrix (`backdoor`, `sw_turtle_grab`, `gunline`). It loses to `backdoor` 85% of the time in games averaging 4,205 ticks: copying 20 teachers gives it nothing that watches its own base.
- `m2-ppo-kl` started: PPO from `m2-imitate/final.pt` against the 20 scripted bots, KL penalty toward the imitation policy 1.0 annealed to 0 over the first half of 10 M decisions, entropy 0.003 → 0.001 (the `m1-ppo-kl` settings). To watch: the win rate against `backdoor`, and the army mix after the KL term is gone (`m1-ppo-kl` collapsed to gunners only at that point).

### 2026-11-17 — Watching the agent: are gunners too strong, or do the bots not counter them?
- User asked whether I can watch matches against particular bots and decide between "gunners too strong" and "bots don't counter them". Mid-run checkpoint `m2-ppo-kl/update_340.pt` (6.3 M decisions; army 99% gunners from 5 M on, training win rate 0.88).
- **Tools:** `training/eval/evaluate.py --save-replays` (writes each game to `replays/`, so it shows in the game's replay viewer; filler games after a slot's queue ends are not saved) and `headless/src/v2/watch.ts` (re-runs a replay's command log and prints army snapshots, units in weapon contact, buildings started, battles, and damage dealt by attacker type → victim type).
- **Fight test rerun on the current engine:** at equal cost, skirmishers + medics keep 62–78% of their army against massed gunners at every size; pure skirmishers 56% → 24% as size grows; bruisers lose as designed. At equal supply gunners win from about 30 units up, but supply has no cap (depots), so cost is the fair basis.
- **24 recorded games** (swarm, backdoor, sw_turtle_grab, gunline, phalanx, macro × 2 maps × 2 seats): agent 0/4 v backdoor (every game over by 4:50), 3/4 or 4/4 v the rest.
  - Agent's build: 2–3 barracks, no foundry, no turrets, 7–8 workers, gunners only; army about 30 at 4:30, then pushes. It out-builds backdoor, macro and sw_turtle_grab (army value 1,350 v 645–1,020 at 3:00); against swarm, phalanx and gunline army values are about equal and it still wins.
  - Backdoor: three outposts at 13–15% of the map, never seen; 23 gunners stood about 1,400 px away while 13 skirmishers killed the crystal in about 20 s. The agent does not scout or keep anything at home.
  - Swarm (agent wins): at 4:20, 12–17 gunners were in weapon contact against 2–3 of 27 skirmishers. The swarm stops at the edge of gunner range, pulls hurt units out and loses units without trading.
  - **Probe:** a temporary swarm that never retreats (not kept) did worse, 0.91 agent win v 0.81 for `swarm` (32 games each). The armies walk past each other and trade bases; the gunners kill buildings as fast and the skirmishers returning to defend arrive in a stream into the gunner line.
- **Reading:** the unit stats are not the main cause. In a committed straight fight at equal cost the counter wins. The agent wins on decisions the bots never make: it fights at its own reinforcement point, avoids running into skirmishers head-on, wins base trades, and catches units coming home one at a time. The bots never deliver a whole skirmisher + medic army onto the gunner line at once. What does favour gunners structurally: range 120 means a counter must close 100 px under fire, the counter's margin shrinks with army size, and gunners are also the best building killers per unit. Whether a human can punish the gunner mass is untested; the bots cannot.

### 2026-11-17 — Does the agent adapt to its opponent? No
- User: more interested in how it does against the bots built to beat it (shield etc.); wants an agent that adapts and reacts to each opponent, not one strategy that beats everything, even though the win rate is a good sign.
- Measured from replays (command logs): `m2-ppo-kl/update_360.pt` (6.7 M decisions) and `m2-imitate/final.pt`, each v 12 bots × 4 training maps × 2 seats = 96 games.
- **PPO:** phalanx (gunners behind bulwarks) 0.50, swarm 0.62, outrider 0.62, swarm_tide 0.75, swarm_mass 0.88, backdoor 0.00 (8/8 lost); 0.62–1.00 v the rest. Same plan v every opponent: 94–100% gunners, 2.0–2.6 barracks, almost no foundry or turrets, first push 2.5–3.7 min. Army mix differs from its overall mix by 3% on average between opponents. Only hint of reacting: 14% skirmishers v phalanx (right direction).
- **Imitation policy:** mix differs by 18% between opponents, but it is weak (0.00–0.88) and the variety is copied teacher behaviour, not a reaction (e.g. 87% skirmishers and a push at 0.8 min v turtle, 0/8).
- Why: a fixed pool where one plan wins about 80% gives PPO no reason to vary; the model has no memory (no LSTM) and no opponent-model head yet, and it builds before it has seen anything. Proposed to the user: opponent sampling weighted to losses, exploiter agents trained against the current agent (AlphaStar league), LSTM + opponent-model head, and an adaptivity measure in the gate. Awaiting the user's choice.

### 2026-11-17 — League training: memory, opponent model, exploiters (v0.8.26-ML)
- User approved all three proposals (loss-weighted opponents, exploiter agents, LSTM + opponent-plan guess). On the gate: an adaptivity measure is reported, not required ("we have a lot of similar bots where the same strategy might work well"). `m2-ppo-kl` finishes as a baseline only.
- **Network** (`training/v2/model.py`, 4.56 M parameters, was 3.3 M): LSTM cell (384) after the encoder, added as a residual through `mem_out`; opponent-model head predicting enemy unit counts (6 types) and building counts (5 types) in bins 0/1/2/3–4/5–8/9+, plus the anchor nearest the enemy army (37 + none); its probabilities (detached) feed back into the policy through `opp_in`. `mem_out` and `opp_in` start at zero, so `m2-imitate/final.pt` loads and plays exactly as before (`training/test_model_v2.py`).
- **Trainer** (`training/v2/train.py`): LSTM state carried per stream through rollouts, reset at episode starts; updates replay 32-decision sequences from stored start states (sequence pass = step-by-step rollout to 6e-7, tested); opponent-model cross-entropy (`--opp-coef 0.5`); `ckpt:<path>` opponents played by frozen networks; `--pfsp` draws opponents by (1 − win rate over the last 50 games)², floor 0.1; `--stop-decisions` to resume runs in pieces without resetting schedules. `spaces.OPP_BUILDINGS` was stale (4; the runner sends 5).
- **Evaluator:** recurrent, and plays `ckpt:` opponents (exploitability).
- **League driver** (`training/v2/league.py`): per cycle, main agent N decisions v scripted pool + all exploiters (pfsp) → fresh exploiter from the imitation start v the frozen main agent → exploiter win rate v that agent recorded (`docs/eval/league-<run>.json`) → exploiter joins the pool. Resumable.
- Checks: rollout and training log-probs agree exactly before the first update (KL 0.0); smoke runs through episode ends for imitation, PPO with a checkpoint opponent, and two tiny league cycles. In the PPO smoke the KL to the reference rose to 0.3–0.6 on tiny batches: the untrained opponent-model head (loss 2.2) pulls the shared trunk. Hence the plan trains that head during an imitation fine-tune first.
- **Plan:** (1) `m3-imitate`: imitation fine-tune from `m2-imitate/final.pt` with the new modules, ~3 M decisions, then the 0.40 gate; (2) league from it.

### 2026-11-17 — Packed runner protocol: rollouts 2.7× faster (v0.8.27-ML); m2-ppo-kl baseline
- **Speed** (user asked for training speed-ups, approved "build the 2–3× speed-up first"). Profiling showed the GPU idle and the Python process at 100%: per step at 144 streams, JSON parsing of ~20k mask booleans and ~4k floats per stream plus building numpy arrays from nested lists cost more than the simulation. New `packed: true` in `reset_all` (`headless/src/v2/runner.ts`): each observation is one base64 float32 buffer, masks one base64 bit string in fixed key order, the critic only the two globals vectors the trainer reads (it used to send both seats' full fog-free grids and entities). `ready` carries the shapes; `spaces.check_layout` checks them. Python decodes with `np.frombuffer` and unpacks a whole batch's masks in one `np.unpackbits` (`batch.stack_masks`). JSON mode is unchanged (tests, tools).
- Parity test (`training/test_vec_env_v2.py`): same seeded games in both modes, same actions, 90 steps over policy v bot, policy v frozen policy and a teach seat: batched obs, masks, critic, labels, rewards and terminal observations identical.
- Benchmark (18 × 8, rollout loop): 356 → 975 decisions/s. Per step: env 248 → 124 ms, batching 136 → 3 ms, inference ~20 ms. `train.py` and `evaluate.py` now use packed mode. Smoke-tested end to end (PPO with a checkpoint opponent and truncation bootstrap; evaluation v a bot and a checkpoint).
- Not built: two-half pipelining (Node steps one half while Python runs the other). The Python share is now ~24 ms of ~148 ms per step, so it could save at most ~15%; not worth splitting the rollout buffer for. The remaining cost is the simulation itself.
- **m2-ppo-kl baseline** (960 games): 0.89 overall; backdoor 0.23 and swarm_tide 0.65 are the weak spots. Every game, whatever the opponent: 97–100% gunners, ~2.4 barracks, no foundry, first push 2.3–4.6 min; the army mix moves 0% between opponents. This is the one fixed plan the league is meant to break. Kept replays: a backdoor loss (`1794940912337-v2-5-4`) and a swarm_tide win (`1794941390643-v2-4-6`); the other eval replays were deleted.
- **m3-imitate** (imitation fine-tune that trains the memory and opponent-model head before PPO): 3 M decisions in 80 min (would have been ~2.8 h before the speed-up). Opponent-model loss 1.23 → 0.59 (uniform guess ≈ 1.8). Gate eval 0.52 [0.49, 0.55] over 960 games, PASS. League `lg1` launched from it: 4 cycles × (5 M main decisions v 20 bots + exploiters by loss-weighted sampling, 3 M exploiter decisions v the frozen main agent, exploitability eval).
- **lg1 cycle 1** (2026-11-18): main agent 5 M decisions (~2.9 h, ~490 decisions/s incl. updates), training win rate v the pool 0.45 → 0.70. Production per episode (all opponents together): gunner 47, skirmisher 25, bruiser 1.4, medic 1.4, bulwark 1.0, worker 6.5 — far more mixed than m2-ppo-kl (97–100% gunners); whether the mix depends on the opponent needs a replay eval (planned on every `cycle_k.pt` after the league, so the league keeps all 18 processes). Loss-weighted sampling ends the cycle weighting sw_turtle_grab 0.27, phalanx 0.18, turtle 0.14, outrider 0.14, all others at the 0.1 floor. Exploiter x1 (3 M decisions, 2.2 h) went pure gunner mass (90 gunners per game) and beats the frozen main agent **0.81** (32 games, `docs/eval/lg1-x1-vs-main.json`): very exploitable, as expected after one cycle. x1 is in the pool for cycle 2.
