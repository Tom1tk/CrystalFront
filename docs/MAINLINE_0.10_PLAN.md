# Mainline 0.10 plan: Outrider, Surges, 20-minute cap, 0.9 vs beta per-match toggle

Status: **agreed design, not implemented** (2026-11-20). Decisions below are the user's
answers to the planning questions; items marked *(proposed)* still need a yes.

## 0. Why

Playtest (Tom7 v Neural · Normal, Twin Spires, crystal lost at 6:53): there is no cheap way to see
what the opponent is building before the army arrives. Fastest unit is the skirmisher at 40 px/s,
about 1:50 to cross the 5,000 px map. Workers cross in about 2:25. Scouting costs a worker or a fighter
and arrives late.

Live games also have no time limit. Node control (hold more than half the contested nodes for a
net 60 s) is the only objective win. When nobody holds a majority, a game can run forever. 18% of
scripted-matrix games reach the 20-minute training cap.

## 1. Rulesets: 0.9 stays playable while the mainline is built

**One server, one deploy.** When you start a match you pick the game version with a toggle:
**0.9 (stable)**, the default, or **0.9.x beta — dev testing only**.

- **Where the toggle appears:** the bot-game, solo-test and PvP host screens. In PvP the host
  picks, and the joiner sees which version they're joining.
- **What it does:** the choice is stored on the match as `ruleset: "0.9" | "beta"`. It never
  changes mid-match.
- **Beta matches** show a "DEV BETA 0.9.x" badge in the HUD.
- **Version numbers:** the server version keeps 0.9.x numbers (0.9.2, 0.9.3, …) until 0.10.0.
  At 0.10.0 the beta ruleset becomes the default.

**How 0.9 stays exactly as it is:**

- **Game engine: one engine with a ruleset flag.** Every new feature is switched on only when
  `ruleset === "beta"`:
  - the Outrider (its unit definition is invisible to 0.9 matches);
  - the free Outrider at match start;
  - Surges;
  - the 20-minute cap and draws.
  - **Proof that 0.9 is unchanged:** the existing golden hashes must stay byte-identical under the
    0.9 ruleset on every commit.
- **Neural bot code: frozen copy.** The 0.9 bot code (`headless/src/v2`) and models
  (`models/policy-*`) are frozen. The beta bot gets its own copy (`headless/src/v3`,
  `models/beta/`) with the new observation and action layout. The bot that plays a match is
  chosen by its ruleset.
  - **New regression test:** each 0.9 neural model plays fixed seeded games, and the hash of every
    decision must not change. It runs as part of `goldenHashes --check`.
- **Replays** record their ruleset. The replay viewer runs each one under the ruleset it was played
  with. The replay browser gets a ruleset filter.
- **Client:** one client handles both rulesets. Beta-only HUD elements (Surge timer, Outrider
  button) appear only when the match says it is beta.

*Alternative, not recommended:* vendor a complete copy of the 0.9 engine and pick an engine per
match. That gives total isolation, but every bug fix or UX change to the engine has to be made
twice. The ruleset flag plus golden hashes gives the same guarantee, and the hashes catch any drift.

## 2. Outrider (scout unit)

| | Value | Notes |
|---|---|---|
| Speed | 8.0 px/tick (80 px/s) | 2× a skirmisher; about 55 s across the map |
| HP | 60 | |
| Damage | 5, cooldown 15 ticks, range 15 | about 3.3 dps: kills an undefended worker in about 30 s; workers hit back |
| Vision | 360 | largest in the game (others 195–300) |
| Cost / supply / train time | 50 / 1 / 60 ticks | |
| Trained at | Crystal | |
| Start | one free Outrider at match start (like AoE2) | |
| Limit | **one per player**, alive or queued; the train button greys out | no cooldown after it dies |
| Node control | **cannot hold or contest nodes** (excluded like workers) | otherwise it could freeze the enemy's hold countdown |
| Targeting | ordinary: turrets and units shoot it | |
| Counter multipliers | neutral (1.0) *(proposed)* | |

- **Visuals.** Vendor one more Kenney mini-character (CC0, same pack), team-painted. Add a speed
  cue: a lighter build and a dust trail.
- **Scripted bots.** They scout with the Outrider instead of a worker.
- **Engine.** The Outrider is a new `UNIT_DEFS` entry. Crystal production gets a per-player limit
  check. `control.ts` excludes the Outrider. Match start spawns one per player. Replays need a
  balance-history entry, and old replays must still play.

## 3. Surges, the 20-minute cap, draws

| Time | Stage | Effect |
|---|---|---|
| 10:00 | Surge I | every unit +25% move speed; gathering ×1.5 |
| 14:00 *(proposed: midpoint)* | Surge II | units deal ×1.5 damage to buildings, turrets and crystals; hold countdown 60 s → 30 s |
| 18:00 | Surge III | building damage ×2 (replaces ×1.5, not on top of it) *(proposed)*; hold countdown 15 s |
| 20:00 | Hard cap | match ends (see below) |

- **Hold progress is kept as a percentage when the hold time shrinks.** Otherwise a side at 70% of
  60 s would win instantly at Surge II.
- **At 20:00:** the side with the higher node-control percentage wins (`winType: "time"`). If the
  percentages are equal, including 0%–0%, the match is a **draw**. Two AFK players simply end at
  20:00 with a draw.
- **Draws are new everywhere.** They need a result type, the end screen, the replay browser
  filter, replay files, the bot ladder (0.5 points) and training rewards.
- **Does the speed boost apply to every unit?** *(proposed: yes, including workers and the
  Outrider)*
- **HUD.**
  - Next to the clock: "Surge I in 3:12", and later "Hard cap in 1:40".
  - At each stage: a banner and a sound.
  - The terse nodes readout is replaced by one bar per side: "Hold 3 of 5 nodes · 0:42 left to win".
  - The first time a node is held, a one-line explanation appears.
- **Training.** `TRAIN_MAX_TICKS` is already 12,000 (20:00), so the training cap becomes the real
  rule. The training tiebreak switches to the new rule: control percentage, otherwise a draw.

## 4. Bot: new mainline training round (beta only)

1. **Observation and action changes.** Add `outrider` to `TRAIN_UNITS`, `ENTITY_TYPES` and the
   opponent-model groups. Add globals for surge stage, time to next stage and time to cap. The bot
   cannot train an Outrider while it already has one.
2. **Network surgery.** Expand the input and output layers of the 0.9 Hard model (lg2 cycle_3), with
   zero-initialised new weights. It starts out playing exactly as it does now and never picks the
   new actions until it is trained.
3. **Scripted opponents** get the Outrider and an awareness of Surges (attack timing).
4. **Training.**
   - Fine-tune with the existing G-10 pipeline: imitation top-up on the updated scripted bots, then
     self-play cycles.
   - Held-out maps (prism-ridge, duskvale) stay held out.
5. **Evaluation.**
   - Run the ladder under the new rules.
   - Reference points: the 0.9 models running in the new rules through an evaluation-only adapter
     (an Outrider is seen as a worker; they never train one).
   - Also watch behaviour: when the bot scouts, and how it reacts to being scouted.
6. **Ship.** New Easy/Normal/Hard in beta. When happy → 0.10.0, which becomes the default ruleset.

## 5. Order of work

1. **Measure.**
   - Game-length distribution and stalemate rate across the stored replays and the scripted matrix.
   - Map-crossing time per map, per unit.
   - Check that 10:00, 14:00 and 18:00 come after a typical game has already ended.
2. **Rulesets.**
   - `ruleset` on match config and replays, the start-match toggle, and the beta badge.
   - Freeze the bot code: split off v3 from v2.
   - Add the 0.9 neural regression hash.
   - Verify: golden hashes and neural hashes unchanged.
3. **Outrider**: engine, client, 3D model, scripted bots. Beta 0.9.2.
4. **Surges, cap, draws and HUD**: regenerate golden hashes; scripted matrix for stalemate rate and
   strategy win rates. Beta 0.9.3.
5. **Bot round**: surgery, training, ladder, behaviour review. Beta 0.9.x.
6. **0.10.0** release and switch-over.

Each step: version bump, full check procedure, commit as Tom1tk, push, deploy beta,
check in with the user.
