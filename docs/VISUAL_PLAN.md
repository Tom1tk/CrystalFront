# VISUAL_PLAN — G-11 3D skin

**Status:** v0.7.0, first pass shipped. The 3D view is optional and purely cosmetic.
**Code:** `client/src/three/World3D.ts`, wired into `client/src/components/GameShell.tsx`.
**Assets:** `client/public/assets/kenney/` (35 models, about 2.2 MB, Kenney CC0, see Credits).

## How to use it
- **F3** or the **3D/2D** button in the scoreboard toggles the view. The choice is saved in `localStorage` (`cf.view3d`).
- `?view=3d` or `?view=2d` in the URL forces a view.
- It works in live games, vs-bot games and replays. Three.js is a separate chunk (about 595 kB) that loads only when 3D is on.

## Architecture
- **A view, not a client.** `World3D` reads the same interpolated entities, resource nodes and static map that the 2D renderer draws. It holds no gameplay state and sends nothing to the server.
- **The 2D canvas stays on top as a transparent overlay.** Input, selection boxes, health bars, fog, path lines, the minimap and the HUD are all still the 2D code, so input and hit-testing did not change.
  - In 3D mode the 2D pass skips only what the 3D scene replaces: the ground, terrain, nodes, and the unit and building silhouettes.
- **Pixel-aligned camera.** An orthographic camera is pitched 55° down. A ground point (x, y) is placed at world (x, height, y / sin 55°), which projects onto exactly the same screen pixel as the 2D view. Models therefore stand where the 2D overlay expects them, with no inverse mapping. Height lifts a point on screen by `height · cos 55°`.
- **Terrain is built once per map** from `staticMap` (the G-5 static-map message):
  - a painted ground texture (8 px per cell);
  - instanced boxes for high-ground plateaus and water;
  - instanced Kenney rocks, cliffs, bushes and grass, scattered deterministically from a hash of the map id.

## Model mapping

| Game object | Kenney model(s) | Notes |
|---|---|---|
| Worker | mini-characters `character-worker` | animations: walk, interact (gather/build) |
| Skirmisher | `character-raider` + `weapon-spear` | sprints when moving |
| Gunner | `character-soldier` + `weapon-shooter` | holding-right-shoot when attacking |
| Bruiser | `character-knight` + `weapon-sword` + `shield-rectangle` | melee swing |
| Medic | `character-female-e` + `aid-defibrillator-red` | interact anim when healing |
| Crystal | tower-defense-kit `tower-round-base` + `tower-round-crystals` | plus a floating team-coloured gem and point light |
| Barracks | mini-forest `building-platform` + `tent` + `flag` | |
| Foundry | `building-platform` + `building-structure` + `building-roof` + fantasy-town-kit `chimney` + `flag` | |
| Supply depot | fantasy-town-kit `stall-red` + `cart-high` + `flag` | |
| Turret | tower-defense-kit `tower-round-bottom-a` + `weapon-turret` | the gun yaws to the entity's `heading` |
| Resource node | tower-defense-kit `detail-crystal-large` (gold) | scales 0.45–1.0 with remaining/capacity |
| Rock | nature-kit `rock_largeA`, `rock_tallA/B`, `stone_tallA`, `stone_largeA` | about 70% of rock cells |
| Cliff | nature-kit `cliff_block_rock` | |
| Brush | nature-kit `plant_bushLarge`, `plant_bushDetailed`, `grass_large` | |
| Rough ground | tower-defense-kit `detail-rocks` | dirt ground colour plus pebbles |
| Open ground | nature-kit `grass`, `flower_redA` | sparse decoration |
| High ground | instanced box, 8 px tall | units on high cells are raised to match |
| Water | instanced translucent box | |

## Team colour
The Kenney colormaps are shared texture atlases. `variantMat()` copies a texture and shifts every swatch with hue 195–330° and saturation ≥ 0.3 to a target hue:
- blue team: 188° (cyan)
- red team: 308° (magenta)
- neutral nodes: 44° (gold)

The skirmisher, gunner and medic wear green and dark-grey gear that the hue shift above misses, so their variants ("g0"/"g1") also turn green swatches (hue 135–175°, saturation ≥ 0.35) and dark-grey gear (saturation < 0.12, lightness 0.18–0.32) into a dark shade of the team colour.

Results are cached per texture and variant. Every entity also gets a team ring on the ground. Construction progress scales the building's height (minimum 12%).

## Animation
- **Moving:** a unit counts as moving when its smoothed screen speed is above 6 px/s. It plays `walk`, or `sprint` for the skirmisher.
- **Other states** come from the streamed `actionState`: attacking, gathering, constructing, dying (plays `die` once) and idle. Armed units idle with `holding-right`.
- **Facing:** units face their movement direction, or the streamed `heading` when standing still.

## Combat effects
`World3D.spawnCombatFx()` reads new `attackLog` events each frame:
- **Ranged** (gunner, turret): a muzzle flash at the attacker, a tracer to the target and orange sparks at the impact.
- **Melee:** sparks at the target. On buildings and crystals the impact is on the face toward the attacker.
- **Heal:** green motes rising from the target.

The effects are two instanced meshes (up to 600 particles and 96 tracers) with unlit, solid-colour materials. They fade by shrinking rather than by transparency, because additive blending disappeared against the white frost ground.

## Sound
`client/src/audio.ts` plays Kenney sounds through WebAudio in both the 2D and the 3D view. Settings has a Sound On/Off toggle (stored as `cf.sound`, on by default). Browsers only allow audio after a click or key press, so the sounds load on the first one.
- **Combat:** weapon sounds per attacker type, plus a hit sound on buildings and crystals. Heals have a soft chime.
- **Events:** unit death, building collapse, crystal destroyed, and your own building finished.
- **Interface:** select, order and error.

Each `attackLog` event plays once. After a jump (joining a game, seeking a replay) the current log is marked as heard without playing, so no backlog plays. The 3D effects use the same rule, and their timestep is capped at 1/20 s so they stay visible at low frame rates. Events off screen are silent, and sounds are panned left or right by their position on screen. The same sound plays at most once every 70 ms.

## Map themes
`client/src/mapThemes.ts` gives each pool map one of four cosmetic colour themes. Gameplay is unchanged. Each theme sets the 2D terrain palette, the 3D ground, water and background colours, the lighting, the foliage and rock tint, and whether open ground gets grass and flowers or only pebbles.

| Theme | Maps | Look |
|---|---|---|
| Verdant | ironreed, twin-spires, glimmerfen, and any map without an entry (classic, dev) | green grass, flowers, blue water |
| Desert | basalt-run, saltmarsh, cinder-flats (the three maps with no water) | orange sand, olive scrub, pebbles |
| Haunted | duskvale, hollow-crown | purple ground, violet foliage, dim light |
| Frost | shardfall, prism-ridge | snow, frosted trees, snowy rocks |

The map picker shows each thumbnail in its theme colours and labels it "Name · Theme".

## Known gaps / next iterations
1. **Not yet used:** the 3d-road-tiles pack and ramps between high and low ground (plateaus are currently plain boxes).
2. **Fog** is still the 2D overlay, drawn at 80% opacity. A shader fog on the ground would look softer.
3. **Not measured on a real GPU.** Only tested with software WebGL (SwiftShader). Shadows use a 2048 map that follows the view.
4. **Readability:** units are small at the default zoom, as they are in 2D. A unit-scale setting may help.

## Credits
All models, textures and sounds are by **Kenney** (www.kenney.nl), released under **CC0 1.0**. Each pack's `License.txt` is kept next to its models:
- Mini Characters
- Fantasy Town Kit
- Mini Forest
- Tower Defense Kit
- Nature Kit
- Impact Sounds, Interface Sounds, RPG Audio (combined licence in `client/public/assets/kenney/audio/License.txt`)
