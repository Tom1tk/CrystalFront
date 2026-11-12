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
