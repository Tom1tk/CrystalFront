# UI Rehaul Plan (G-12) — DRAFT, awaiting sign-off

**Status:** draft 2026-11-11. Nothing here is implemented yet.
**Asked for by the user:** "the entire site ui also needs a rehaul now to fit the new aesthetic of the 3d mode, lets plan that".
**Scope:** menus, lobby, loading, in-game HUD, match end, replays and settings. Gameplay, balance and the bot are out of scope.

## 1. Where the UI is today (v0.7.2)

The site uses the "facet" design system (`client/src/design/facet.tsx`). It has a near-black background (`#05060a`), neon cyan and magenta accents, notched panels, a mono font and glitch-style headings. The design was made for the old top-down 2D view of dark neon shapes.

The 3D view now looks very different: bright low-poly Kenney models, daylight lighting, and four map themes (verdant, desert, haunted, frost). The neon chrome no longer matches the game.

Problems seen in screenshots of the current build:

| Screen | Problem |
|---|---|
| Main menu | The left half is empty dark space. Nothing shows the game itself. Solo Test is hidden in Settings. |
| Settings | It opens inline under the menu and pushes the page down. "3D View" reads OFF when the page was opened with `?view=3d`, because the URL flag is only stored once a match starts. Sound is on/off only, with no volume. |
| Play vs Bot | The page has no side padding: the map picker touches the left edge. The bot list is plain text rows with no picture of how each bot plays. The map picker is a native `<select>`. |
| Lobby | Usable. The map preview is a small dashed box, and there is no picture of the map. |
| Loading (new in 0.7.2) | Works, but is plain: logo, status and map name only. |
| In-game HUD | Dark opaque slabs sit over a bright scene. The top bar repeats "[IN GAME] · Tick" and the debug text "Match: match-2". The hint line is debug-style mono text. The Q–R / A–F command grid has letters but no icons or names until a unit is selected. Debug Controls sit in the centre of the screen for every player. The minimap is the old 2D palette in a dark box. |
| Match end | Not reviewed in detail; same facet style. |
| Bot replays | A spreadsheet-style table with native selects. It reads as a dev tool. |

## 2. Direction — needs the user's choice

**A. "Facet, lit" (recommended).** Keep the CrystalFront identity: the logo, cyan crystal, notched corners and display font. Change how it sits on the game:
- Panels become frosted, translucent glass (backdrop blur) instead of black slabs, so the bright 3D scene shows through.
- Every menu screen has a live 3D backdrop: a slowly orbiting camera over a real pool map, built with the existing `World3D`.
- Accent colours follow the current map's theme (verdant green, desert amber, haunted violet, frost ice), so the UI and the map read as one place.
- Neon glows are kept for the crystal and team colours only.

**B. "Tabletop".** A fresh warm, rounded, light-panel style that matches Kenney's toy-like models (think board-game UI). It fits the models best, but it drops the existing identity, and it is a bigger rewrite: every component is restyled.

**C. Minimal touch.** Fix the problems in the table above and keep the dark style. It is cheap, but it does not meet the "fit the new aesthetic" ask.

The rest of this plan assumes **A**. The work items barely change under B; only the tokens and component skins in UI-1 differ.

## 3. Work items (each one ships on its own)

| ID | Item | What changes |
|---|---|---|
| UI-1 | Tokens and components | Add translucent glass panel, theme-accent and light-ink tokens to `facet.tsx`. Restyle `FctBtn`, `FctPanel` and `FctFrame` for glass. Replace native `<select>` controls with a styled dropdown. Add one shared page layout with consistent side padding (fixes the Play vs Bot edge). |
| UI-2 | Menu backdrop | A `MenuBackdrop` component: a lightweight `World3D` scene with no units, one random pool map and a slow orbiting camera. The 2D setting, or a failed WebGL start, falls back to a still map image. It reuses the model cache added in 0.7.2, so the first match loads instantly afterwards. |
| UI-3 | Main menu and Play flow | The title sits over the backdrop. One **Play** screen has tabs for Online (Host / Join), vs Bot, and Solo Test (moved out of Settings). A map picker with **map cards** (a 3D thumbnail, the theme name and size) replaces the `<select>` in Play, the lobby and Solo. |
| UI-4 | Settings modal | A centred modal instead of the inline panel. Contents: 3D view (fixes the OFF-with-`?view=3d` bug), **sound volume slider plus mute**, an optional separate music/effects split, and an in-game shortcut list (F3 and others). The same modal can be opened in-game from a gear button or Esc. |
| UI-5 | Lobby and loading | A large preview of the chosen map (3D thumbnail and theme). Player cards in team colours. The loading screen shows the map preview, both player names, per-player progress ("Loading…" / "Ready") and a gameplay tip. Per-player progress needs a small server message carrying each player's loaded state. |
| UI-6 | In-game HUD | Frosted, slimmer top bar: resources, supply and nodes, with a match clock instead of "Tick". Remove "Match: match-N" and the debug hint line (hints move to a dismissable first-match tip). A command card with icons and names for each slot. A minimap in theme colours with a frosted frame. Debug Controls only in Solo Test or with a dev flag. Selection panel with unit portraits (renders of the Kenney models). In-game sound control. |
| UI-7 | Match end | A result banner over the frozen 3D scene. Stats (units built, lost, nodes held, length). Buttons: Rematch, Watch replay, Menu. |
| UI-8 | Replays | Cards with map thumbnail, players, result and length, plus a compact filter bar. The table view stays as a "dev view" toggle. Replay player controls get the same frosted style. |
| UI-9 | Finish | Small-screen layout (down to 1280×720), keyboard focus states and contrast checks, screen-to-screen fades (the loading overlay's fade, reused), and before/after screenshots for sign-off. |

**Suggested order:** UI-1 → UI-2 → UI-3 → UI-4 → UI-6 → UI-5 → UI-7 → UI-8 → UI-9. UI-6 comes early because the HUD is where players spend their time.

**Versioning:** each item is a 0.7.x patch release (0.8.0-ML stays reserved for G-10 M0).

## 4. Assets

- **Map thumbnails:** render each pool map once from `World3D` with a top-down camera, as a build-time script or a cached canvas capture. Store them under `client/public/assets/maps/`. They must be re-rendered when a map is re-frozen.
- **Unit and building portraits:** offscreen renders of the Kenney models (CC0) at a fixed angle, made the same way.
- **Icons for the command card:** Kenney "Game Icons" (CC0). We already use Kenney packs, and the user has given permission to fetch them.
- **Fonts:** keep the current display, mono and UI fonts.

## 5. Questions for the user

1. Direction **A**, **B** or **C**? (A is recommended.)
2. Live 3D menu backdrop (costs GPU in the menu), or still map art?
3. Should Debug Controls be hidden outside Solo Test now? There are no live users, but this matters for PvP.
4. Is a separate music track wanted? There is none today; Kenney has CC0 music loops.
5. Anything to keep exactly as it is, such as the big glitch "CRYSTAL FRONT" title?

## 6. Out of scope

Gameplay rules, balance, the bot and training (G-10), accounts and matchmaking, and mobile/touch controls.
