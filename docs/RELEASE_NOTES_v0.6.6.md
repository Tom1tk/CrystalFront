# CrystalFront v0.6.6 Release Notes — Game Update

**Released:** 2026-11-10
**Covers:** v0.6.0 – v0.6.6 (plan: `docs/GAME_UPDATE_PLAN.md`, phases U0–U5; details per phase in `docs/DIARY.md`)

This update rebuilds the base game before any new bot training. The old single-lane map, the "bank 4500 resources" win and the v0.3.2 ML bot are gone.

---

## What's new

### A new battlefield
- **5000×900 maps** that fit any 16:9 screen with no vertical scrolling (the camera pans left/right only).
- **Terrain:** rock and cliffs block movement, rough ground slows units (×0.6), and high ground gives +15% range and +15% vision.
- **Brush** hides units from enemies who have nothing in the same patch. Attacking reveals you to your victim.
- **Line-of-sight fog:** rock and cliffs block vision. The fog is soft and cell-based, and the minimap shows terrain and fog.
- **Map pool of 10 maps**, generated and validated: 5 mirror, 5 rotated 180°. In the lobby the host picks one or "random pool", with thumbnails.
- **More, smaller resource nodes:** 4 contested nodes per side (plus an optional centre node), each holding 150. Terrain starts about 500 px from each crystal, so bases stay open for building.

### Movement and control
- **Pathfinding:** units walk around terrain and buildings. Group moves use flow fields. After a move order you see a short path line.
- **Move vs attack-move:** a plain move ignores enemies until arrival (so you can retreat). **A** = attack-move, **R** = toggle auto-attack.
- **Shift-queue:** Shift + move / attack-move / attack / build queues up to 8 orders per unit. Shift+build stays in build mode.
- **Control groups:** Ctrl+1–9 to assign, Shift+1–9 to add, 1–9 to recall, double-tap to jump the camera.
- **Solid buildings:** units can't walk through buildings or crystals. A building that would seal off a crystal can't be placed.

### New win condition: node control
- **Hold a majority of the contested nodes to fill your control bar; a full bar wins** (60 s of net hold).
  - A node is yours when you have a combat unit next to it and the enemy has none. Workers and turrets don't count.
  - While you hold a majority your bar fills and the enemy's drains. With no majority, both bars pause.
- Destroying the enemy crystal still wins immediately.
- **On timeout** the winner is decided in this order: crystal HP → nodes held → army size → lifetime resources.
- **In game:** each node shows a ring in its holder's colour (gold dashed = nobody). The **⚑ NODES** HUD stat shows nodes held, nodes needed and both control %. The end screen says how the match was won.

### Bots
- The scripted bots (rush, macro, turtle, heavy) now fight for nodes. They take the nearest unheld node, leave small garrisons, and regroup before pushing.
- Balance (960 bot games across the pool): no strategy beats every other, rush is counterable, and 13% of games time out. In mirror matches each side wins 44–55% on every map.

### Removed
- **The v0.3.2 ML bot** and its ONNX runtime have been removed. A new adaptive bot will be trained from scratch on this game (next plan: `ML_RETRAIN_PLAN.md`).
- **The "hold 4500 resources" win.**

---

## Technical notes
- **One engine for live play, replays and training.** Units take one movement step per 100 ms tick, and the live server and headless runner are hash-identical.
- `ENGINE_VERSION` 10 is stamped on every replay. Replays from other engine or map versions are hidden rather than replayed incorrectly.
- **Per-entity `heading` and `actionState` are now streamed** to the client, ready for the planned 3D view (G-11, Kenney assets).
- `npm test` 613/613. Bench: about 4,900–5,300 ticks/s.
- `headless/src/balance.ts` reports the balance gates; `headless/src/mapPool.ts` surveys and freezes the map pool.

## Known issues / not yet signed off
- **Pool maps are still `approved: null`.** Each needs a manual play-test and sign-off.
- **Mirror games between identical scripted bots time out often** (rush-rush and turtle-turtle about 50%). Games between different strategies resolve.
- **Turtle is the strongest scripted bot.** It beats rush and heavy outright; only macro contests it.
- **The hotkey grid overlaps the bottom-left of the map.**
