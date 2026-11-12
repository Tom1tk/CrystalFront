# Bot control plan (G-13)

**Status:** signed off 2026-11-12 (Q1–Q4 answered, see §6). Phase E (E0–E5) built in v0.8.8-ML (ENGINE_VERSION 14). Phase B (action space v3, B1–B5) built in v0.8.9-ML; E6 done; the user chose turret range 120 and the repair range fix (v0.8.10-ML, ENGINE_VERSION 15), then M1.
**Goal:** bots get the same control over the game as a human player wherever possible, and the engine's own unit behaviour gets fixed for everyone. This comes before ML retrain M1 (`docs/ML_RETRAIN_PLAN.md`), because M1 trains on whatever action space exists at that point.

Decisions already made by the user (2026-11-12):

| Question | Answer |
|---|---|
| Threat-order targeting | Yes |
| Leash on auto-acquired targets; ordered targets stick | Yes |
| Medic auto-heal | Yes, within heal range only, **no chasing** |
| Action space | Option C is the end goal; option B is the first milestone (before M1) |
| Decision timing | Fixed 0.8 s for M1; a bot-chosen delay comes later (with C) |
| MCP / text interface for LLM, Laya or Jev play | Pencilled in only, far down the line, no planning yet |
| New **Guard** order (Age of Empires II style) | Proposed by the user, specified in E4 |
| Guard circle | About **half** sight range: guard must not become a dominant strategy; good macro stays the best option |
| Guard hotkey | An empty slot on the existing 8-key card, same key for all units: **F** |
| Auto-attack rules | See E0 |
| R-2 deviation (Phase B) | Signed off: "all most recent changes are king" |

---

## 0. Where we are today

**Bot controls** (`headless/src/v2/actions.ts`): one econ action and one army order every 8 ticks.
- Econ: noop; train 5 unit types; build 4 building types at 10 named sites; send 1/2/4 workers to one of 16 node slots.
- Army: group (all combat, army A/B, one unit type, scout) → order (attack-move, move, hold, retreat, join A/B) → target (37 anchors + 16 enemy-memory slots).
- Done by the harness: idle workers mine, builder and producer choice, auto-targeting.

**Gaps:** no focus fire, no heal, no repair, no single-unit control, targets limited to named points, one army order per decision, no stop/cancel/rally/queue.

**Engine behaviour that affects everyone:**
- Auto-targeting takes the nearest visible enemy of any type, then locks on until it dies, chasing it across the map.
- Medics heal only when given an explicit heal order. Bots can't give one, and humans rarely do.
- An ordered target (right-click) and an auto-acquired one are stored the same way, so nothing can treat them differently.
- The v2 bot "hold" order is an attack-move to the unit's own position. That inherits the unbounded chase, so a "holding" unit can be pulled across the map. Humans have no hold or guard order at all.
- `stop` also turns auto-attack off (the unit then ignores enemies until auto-attack is toggled back on). Fixed by E0.
- The command card's cost labels are hard-coded and stale: Worker (25) costs 35, Skirmisher (50) costs 60, Turret (60) costs 50. Fixed in E4's client work (labels read from the unit/building definitions).

---

## 1. Phase E: engine fixes (game rules, apply to humans and bots)

All of Phase E ships as one engine change: one ENGINE_VERSION bump (13 → 14), new goldens, and a note that older replays are hidden. The uncommitted `CF_TARGETING` experiment in `combat.ts` (T10 lever sweep) is replaced by E2.

### E0. Auto-attack rules (user, 2026-11-12)
- Auto-attack is **on by default** for combat units (already true; workers off, turrets on).
- The auto-attack toggle (selected units, key **R**) is the only way to turn it off. Attack-move turns it back on (unchanged).
- `stop` no longer turns it off: stopped units still defend themselves.
- A plain move ignores enemies until the unit arrives (already true); auto-attack applies again on arrival.
- So the difference between the two moves: an attack-move can be interrupted by an enemy, a plain move can't.
- Bots: the v2/v3 harness never toggles auto-attack, so bot units always have it on.

### E1. Ordered vs auto-acquired targets
- Add `attackOrdered: boolean` to the entity (in the state hash).
- `attack` (right-click an enemy) sets it; auto-acquisition clears it.
- Ordered targets are never overridden by priority (E2) and never leashed (E3). The unit chases until the target dies or a new order is given (as today).

### E2. Threat-order targeting
When choosing a target automatically, the unit picks from the enemies in range in this order:
1. Combat units and finished turrets
2. Workers
3. Other buildings and crystals

Within a class the nearest enemy wins (ties broken by entity order, as now). A unit holding an auto-acquired target switches when an enemy of a better class comes into range. It never switches away from an ordered target. Workers still can't start fights with buildings.

### E3. Leash for auto-acquired targets
- When a unit acquires a target on its own, it records a leash centre: the point where it was when it acquired the target.
- If chasing would take it more than `LEASH.chase` px from that centre (starting value 200, tuned in E6), it drops the target. It then resumes what it was doing: back to its attack-move path, back to its idle spot, or back to its guard point (E4).
- Towers are unchanged (they already drop targets that leave range).

### E4. Guard order (new command)
`guard { entityIds, targetX, targetY }`, AoE II style:
1. The units attack-move to the guard point and remember it.
2. **Acquire:**
   - Melee units (skirmisher, bruiser) acquire an enemy that comes within `GUARD.acquireFrac × vision` of the unit (starting value 0.8, so 240 px for a skirmisher), as long as it can be reached without leaving the guard circle.
   - Ranged units (gunner) acquire only enemies inside their attack range.
   - Normal E2 priority applies.
3. **Chase inside the circle only:** the unit chases, but never moves outside `GUARD.radius` of the guard point (starting value: **half** that unit type's vision range, e.g. 150 px for a skirmisher, 135 for a gunner). Kept small on purpose: guard must not out-perform an active army, and good macro stays the best option.
   - Ranged units may still shoot a target just outside the circle if it's in range.
4. **Release:** when the target leaves the circle and is out of attack range, or dies, the unit drops it and walks back to the guard point.
5. Any new non-queued order (move, attack-move, attack, retreat, stop, another guard) replaces the guard.
6. Medics given a guard order stand at the point and auto-heal (E5).

Implementation note: E3 and E4 share one mechanism, a per-unit leash `{x, y, r}`.
- E3 sets it at acquisition time, with radius `LEASH.chase`.
- E4 sets it permanently to the guard point and `GUARD.radius`.
- Releasing a target sends the unit back to the leash centre only when guarding. Otherwise it resumes its order.

Client: a **Guard** button on the combat-unit command card, key **F** (empty for unit selections; the A-S-D-F row is the unit row). If a production building is also selected, F stays Rally, the same way building actions already take R from auto-attack. Ground-click to place the point, the same flow as attack-move. Card layout for units: R auto-attack, A attack-move, S stop, D retreat, F guard.

The bot's current "hold" order becomes **guard at own position**, and v3 adds guard at a target point (§2).

### E5. Medic auto-heal
- A medic with no explicit heal target heals the ally in heal range with the lowest HP fraction (ties: nearest, then entity order).
- It does **not move** to heal: no chasing, as the user specified. It heals whatever is in range while idle, holding, guarding, or stopped during an attack-move.
- An explicit `heal` order keeps today's behaviour (the medic follows its target).
- Medics don't auto-heal buildings or crystals; the current heal rules exclude them.

### E6. Balance re-check
- Run the T10 matrix again with E1–E5 plus whichever T10 lever wins the running sweep (turret range / cost / pre-June turret / control hold time / targeting).
- E2's threat order is itself one of the sweep's levers, so the sweep gives an early read on it.
- Present the result to the user before shipping. A balance change is a user checkpoint.

**Tests for Phase E** (`npm test`, custom suite):
- Auto-attack: stop keeps it on, attack-move turns it on, plain move ignores enemies until arrival.
- Priority picks a unit over a nearer worker.
- An ordered target survives priority.
- The leash drops a fleeing auto-target at the chase distance and resumes the order.
- Guard acquires at the right radius for melee and ranged units, never leaves the circle, returns to the centre, and is cancelled by a new order.
- A medic heals the most-damaged ally in range and does not move.
- Also: goldens regenerated, `botCheck` passes (0 ineffective actions, deterministic), and replays rebuild.

---

## 2. Phase B: action space v3, milestone B (before M1)

This is a deviation from approved item R-2 in `ML_RETRAIN_PLAN.md` and needs sign-off there. Same structure as today: one econ head and one army head per 0.8 s decision, built step by step (pick → order → target), with masks and the "every legal action does something" rule.

### B1. Pointer targets (fixes focus, heal, repair)
- Observation v2 already lists up to 200 entities (own and visible enemy). v3 adds pointer heads over those rows.
- **Army order `focus` → enemy pointer:** issues `attack` (ordered target, E1) for the selected group.
- **Army order `heal` → own-unit pointer:** medics in the group heal that unit (explicit heal, follows it).
- **Econ action `repair` → own-building pointer:** the nearest 1/2 free workers repair it.
- Masks: only visible enemies, only damaged own units / buildings.

### B2. Single-unit selection
- A new group option, **`unit` → own-entity pointer**, selects exactly one of the bot's own units.
- This lets the bot pull back one damaged unit, scout or raid with any unit, pull a worker to fight, or add one unit to army A/B.
- Multi-unit pointer selection is option C.

### B3. Free targets on a coarse grid
- The target head gets a grid option beside anchors and memory slots: a 50 × 15 grid of 100 × 60 px cells, the same as the observation grid.
- It's used by move, attack-move, guard, and the scout.
- Building gets the same: build sites = 10 named sites + buildable grid cells (masked by the existing placement check). This allows wall-offs and forward buildings.
- To keep the head small: anchors (37) + memory (16) + grid (750) as one flat pointer, with masks.

### B4. Guard and the other orders
- Army orders become: attack-move, move, guard (point), guard here (replaces hold), retreat, focus, heal, stop, join A/B.
- Econ gains: repair, set rally (production building → anchor/grid point), cancel last queued unit.

### B5. Scripted bots and plumbing
- Scripted bots are updated to use the new controls, so the imitation data contains them:
  - focus low-HP or high-threat enemies
  - medics heal
  - turtles repair turrets
  - guard on chokes
  - pull back damaged units
- Everything downstream is updated: observation/action schema versions, masks, wire format, replay rebuild (`replayObs.ts`), `botCheck.ts`, the Python side, and the docs.
- Acceptance: the same T8/T9 checks pass on v3 (0 ineffective actions, deterministic, replays rebuild exactly), and the balance matrix is re-run with the updated bots.

**Built (v0.8.9-ML).** Layout and wire format: `docs/ML_RETRAIN_IMPLEMENTATION.md` §5.7, "Action space v3". Differences from the text above:
- Repair sends the single nearest free worker. The engine allows only one repairer per building.
- **Scripted bots repair turrets (v0.8.10-ML).** Repair used to work from any distance. After E6 the user approved the fix: the worker walks to the building and repairs only within 60 px. Scripted bots now send a worker to their most damaged turret below 75% health.
- Scripted bots' new micro: guard at staging points (instead of attack-move), pull back badly hurt units, focus a weak enemy near the army, and medics heal the most hurt ally. Each has a minimum gap of 4 decisions.

---

## 3. Phase C: full control (end goal, after M1 shows B works)

- **Multi-unit selection:** a pointer that selects any set of own units (AlphaStar-style), replacing fixed groups as the main way to choose who acts.
- **Queue flag:** shift-queue orders (waypoints, build chains).
- **Bot-chosen delay:** the bot picks how many ticks until its next decision (for example 2–16), under a human-like action budget (APM cap plus a minimum reaction time, as AlphaStar had).
- Possibly more than one army order per decision.
- Any of these needs its own sign-off, and a fresh imitation pass, because the action space changes again.

## 4. Pencilled in: text / MCP interface

An MCP server exposing a text version of the game state and the same typed, masked actions, for LLM, Laya or Jev play. No planning until after PPO.

---

## 5. Order of work

1. **E1–E5**: engine, tests, client Guard button
   → verify: `npm test`, goldens, `botCheck`
2. **E6**: balance re-check with the chosen sweep lever
   → **user checkpoint**; ship as one engine bump
3. **B1–B5**: action space v3, scripted bots, harness
   → verify: T8/T9 checks on v3, matrix re-run
   → **user checkpoint** (R-2 deviation sign-off, then a playtest vs updated bots)
4. **M1**, as planned, with v3 actions (needs the user's go-ahead as before)
5. **C** after M1, separately approved

## 6. Sign-off (2026-11-12)

- **Q1** Guard numbers: melee acquire 0.8 × vision, ranged acquire = attack range, auto-target leash 200 px; guard circle changed to about **half** sight range (user). All starting values, tuned in E6.
- **Q2** Hotkey: use an empty slot on the existing 8-key card, same key for all units → **F**.
- **Q3** Stop keeps auto-attack on: yes. Plus the auto-attack rules in E0.
- **Q4** R-2 deviation for Phase B: signed off.
