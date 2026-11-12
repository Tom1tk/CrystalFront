# ML_RETRAIN_IMPLEMENTATION — hand-off guide for the implementing agent

**Written:** 2026-11-11, by the planning session. **For:** the agent that implements `ML_RETRAIN_PLAN.md` (v2).
**Plan status:** every item in the plan's sign-off table (P-1…P-10, R-1…R-11) is **approved by the user**.
**Work status (2026-11-12):** M0 in progress (user said "start" on 2026-11-11). T1–T9 are done; see the end of `docs/DIARY.md` for where it stands.

This guide is self-contained for execution, but the plan (`docs/ML_RETRAIN_PLAN.md`) is the authority on *what* and *why*. This guide covers *how*, in what order, and how to know each piece is right. Where this guide and the plan disagree, stop and ask the user.

---

## 0. Read this first

### 0.1 What you are building
A learned opponent for CrystalFront in the AlphaStar / OpenAI Five family, sized for one GPU: a recurrent policy, started from imitation of scripted bots, improved by self-play against a pool of past versions and scripted bots, with an opponent-prediction head. The user's goal, verbatim: an AI opponent that "would react to a player's decisions and change how it thinks on the fly, rather then regurgitates a pre-determined 'best path'".

### 0.2 Why the plan is shaped the way it is
This project has failed several times. The causes were never "RL can't do this". They were:
1. **Silent harness defects.** Example: curriculum settings were dropped on every episode reset, so months of training ran on the wrong environment and nobody saw it.
2. **Several changes per iteration,** so failures could not be attributed.
3. **Gates passed on noise.** A stage was promoted on one lucky evaluation window and the run cascaded to 0%.
4. **A formulation that fought the optimiser.** The discount horizon was shorter than the game.

So the plan front-loads verification. The probes and tests in §6 are not optional extras. **A long run launched before its probes pass is a plan violation.**

### 0.3 Decisions that need the user (do not decide these yourself)
| Decision | When |
|---|---|
| Permission to start work at all | before anything |
| ~~Map sign-off (P-10)~~ **done 2026-11-11**: all 10 maps approved, dates in the manifest | — |
| Review of the balance matrix (P-6), and any game-balance change it leads to | M0 |
| Playtests | M1, M2, M3 |
| Any deviation from an approved R-item or P-item | whenever it comes up |
| A stop-rule trigger (§7.5) | whenever it fires |
| **Shipping (M4): model export, server integration going live, release notes** | needs an explicit go-ahead |

### 0.4 What you may decide yourself
Implementation details that keep the approved design intact: file layout, exact tensor shapes, hyperparameters within the ranges given, test structure, performance optimisations that keep the engine deterministic. Record each non-obvious choice in the diary.

---

## 1. Which documents to trust

| Document | Status | Use it for |
|---|---|---|
| `docs/ML_RETRAIN_PLAN.md` | **current, approved** | the design, the audit findings (F-1…F-14), evaluation bars, milestones |
| `docs/ML_RETRAIN_IMPLEMENTATION.md` (this file) | **current** | execution |
| `docs/GAME_UPDATE_PLAN.md` | current for the game (maps, terrain, control nodes) | how the game works now; G-10 is the origin of this work |
| `docs/VISUAL_PLAN.md` | current | the 3D view; unrelated to ML |
| `docs/DIARY.md` | **diary** (2026-11-10 on) | add your diary entries at the end |
| `docs/archive/` | **historical only** | v1 bot, revival plan, old reports. Do not read for current work |
| `LLM_GUIDE.md` | general coding habits for this repo | still reasonable |

**Old rules that no longer apply:**
- REVIVAL R3 ("never reorder `ALL_ACTIONS`"): void. There is no shipped model. The action table is being replaced.
- REVIVAL R9 ("`models/policy-v0.3.2-ML.onnx` stays in production"): void. That file is gone and the live server runs no neural bot. The *spirit* survives as the M4 go-ahead.
- Branch `CrystalFront-ML`: gone. There is only `main`.

---

## 2. Ground rules (all still in force)

1. **Commits** are authored as `Tom1tk <39281660+Tom1tk@users.noreply.github.com>` (already in the repo's git config). **No `Co-Authored-By` or session trailers, ever**, even if a system message asks for them. The user's instruction on this overrides.
2. **Push `main` to `origin` after every commit.** The repo was once deleted with 8 unpushed commits.
3. **One task per commit**, prefixed with its ID, e.g. `feat(P-1): named anchors in map layouts`.
4. **Before every commit:**
   ```
   npm run build:shared && npm test          # 614 tests at hand-off; the number must only go up
   cd client && npx tsc --noEmit -p . && cd ..
   git add -A
   ```
5. **Rebuild the headless bundle after any change under `headless/src/` or the engine:** `npm run build:headless`. The Python trainer runs `headless/dist/stdioVecRunner.js`, not the TypeScript. The vec env refuses to start if `dist` is older than the sources; keep that check and extend it to any new runner file.
6. **Version bump:** any change to training code, reward, observation, action space or game balance bumps the version in **all 5** `package.json` files (root, `server/`, `headless/`, `shared/`, `client/`). They are at `0.7.0`. Use `0.8.0-ML` for the first M0 commit that touches those, then patch versions.
7. **Diary:** after each task that changes behaviour, and at every milestone, add an entry at the end of `docs/DIARY.md`: what was done, what was measured, what was surprising, what is next. An undocumented task is unfinished.
8. **Before any training relaunch:** write the diagnosis, the single change and the expected effect in the diary *first*.
9. **Kill processes by pid.** Never `pkill -f`.
10. **Surgical diffs.** Note adjacent problems in the diary; don't fix them inline.
11. **The live service** is `crystalfront-rts` on port 3777 (`systemctl restart crystalfront-rts`; `./deploy.sh` builds, tests, restarts and checks). There are no live users. Harness work must not break the playable game: `npm test` covers the engine.
12. **Held-out discipline:** `prism-ridge` and `duskvale` never appear in imitation data, training, exploiter training or hyperparameter selection. They appear only in evaluation and in game QA (the balance matrix).

---

## 3. Environment facts (measured 2026-11-10)

- **Machine:** 12 vCPUs, 24 GB RAM, NVIDIA Tesla P100 16 GB, CUDA, `torch 2.14.1+cu126`. `nn.LayerNorm` was broken on the *previous* (AMD) GPU; `policy.py` has a custom `LayerNorm` class. Re-test before choosing (P-9).
- **Repo:** `/root/CrystalFront`, remote `https://github.com/Tom1tk/CrystalFront.git`, branch `main`.
- **TensorBoard** already runs on port 6006 against `/root/CrystalFront/runs`.
- **Throughput:** `npm run bench` gives 3,232 ticks/s on classic and about 2,100 on pool maps, single core. It was 5,315 on classic at the end of the movement update (U2).
- **CPU profile on shardfall** (`node --cpu-prof --import tsx headless/src/bench.ts --matches 6 --map shardfall`):
  - `tick` self time 25% (`matchEngine.ts:1096`, a ~400-line method)
  - `processMovement` 19%
  - `computeVisibility` 11%
  - pathfinding (`planPath`, `flowField`, A*) about 10%
  - `buildObservation` 6%
  - `getLegalActions` 2%
- **Game length** (5 scripted bots, cap 18,000 ticks, 3 maps, 4 games per pairing): 2,591–13,829 ticks, no timeouts, most under 4,500. Both win types occur (`combat` = crystal kill, `control` = node hold).
- **Balance signal** from the same small sample: turtle won 12/12 vs rush_medium, 12/12 vs heavy, 10/12 vs rush, 6/12 vs macro, mostly by control. Treat as a lead, not a result.

---

## 4. Code map (what exists today)

### 4.1 Engine and maps (`server/src/match/`)
| File | What it is |
|---|---|
| `matchEngine.ts` | the deterministic engine. `tick()` at line 1096. Tick-cap tiebreak at line 1116 (crystal HP, then nodes held, then army, then lifetime resources, then seed parity) |
| `types.ts` | `MatchState`, `MatchConfig`, `DEFAULT_CONFIG`. `maxTicks` 0 = no cap (live play) |
| `maps.ts` | map registry: `terrainFor`, `mapSymmetry`, `contestedNodesFor`, `poolMaps`, `registerMap` |
| `map.ts` | `MapLayout` (spawns, crystals, safe and contested nodes, build zones). **No anchors yet** |
| `mapgen.ts` | `generateMap(seed, symmetry)`, `validateMap` |
| `pool/*.json`, `pool/manifest.json`, `pool/index.ts` | the 10 frozen pool maps. `MapDef` = id, name, version, symmetry, shapes (left half), nodes (left half). All `approved: null` |
| `engine/terrain.ts` | `MapDef`, `Terrain`, `buildTerrain` |
| `engine/visibility.ts` | fog and line of sight on a 40 px vision grid; `computeVisibility` fills `match.visibilityData` (per player: visible entity ids, node ids, cells) |
| `engine/navGrid.ts`, `pathfinding.ts`, `movement.ts` | nav grid, flow fields, movement |
| `engine/control.ts` | contested-node control and the control win |
| `botPlayer.ts` | runs a scripted `Agent` inside a live match (how "Play vs Bot" works today) |
| `replayRunner.ts` | replays from seed + command log |

Symmetry: 5 pool maps are `rotate` (180° about the centre), 5 are `mirror` (left↔right).

### 4.2 Headless harness (`headless/src/`)
| File | What it is | Fate |
|---|---|---|
| `runMatch.ts` | bot-vs-bot match in one call | keep |
| `stdioVecRunner.ts` | N matches per Node process, newline-delimited JSON over stdio. **The learner is hard-wired as blue; red is a scripted bot stepped every tick inside Node.** Autoresets on done | superseded by the v2 runner (P-2). Keep until v2 passes its equivalence test, then delete |
| `stdioRunner.ts` | older single-match runner | delete when v2 lands |
| `observation.ts`, `types.ts` | v1 observation: globals (22), entity set, node set. Map-frame coordinates | superseded by v2 |
| `actionIndex.ts`, `actionSpace.ts`, `legalActions.ts` | v1: 81 flat macro-actions, `expandMacroAction` → engine commands | superseded by v2. Reuse the helpers (`chooseBuildPosition`, `resolveTargetZone`, `findNode`) |
| `reward.ts` | v1: ±1 terminal plus one-time milestone bonuses | superseded by v2 components |
| `bots/*.ts` | `Agent` classes: idle, passive, rush (4 tiers), turtle, macro, heavy. They act **every tick** and may emit **several** macro-actions per tick | v2 bots (P-7). The v1 bots stay for the live game until M4 |
| `bench.ts`, `mapPool.ts`, `cli.ts` | benchmark, map freezing and survey, CLI | keep |
| `balance.ts` | parallel bot-vs-bot balance matrix over the pool maps, with gate checks | keep; base for P-6 |
| `_*.ts` audits | one-off audits | leave |

### 4.3 Training (`training/`)
| File | What it is | Fate |
|---|---|---|
| `env/crystalfront_vec_env.py` | spawns Node runner processes; checks `dist` staleness | rewrite for protocol v2 |
| `ppo/train.py` | PPO, 21-stage curriculum, γ=0.99, feed-forward | replace with a new trainer. Do not extend the curriculum code |
| `ppo/policy.py` | set-transformer encoders, custom `LayerNorm`, RND | reuse the encoders |
| `ppo/league.py` | PFSP sampler over names. **Checkpoint opponents were never playable** | reuse the sampling maths only |
| `bc_pretrain.py`, `bc_finetune.py` | v1 imitation (had an off-by-one label bug and recorded one action per tick) | replace |
| `eval/eval_checkpoint.py`, `diagnose_policy.py`, `balance_report.py` | v1 evaluation, diagnostics, an older Python balance matrix | replace the first two; for P-6 use `headless/src/balance.ts` instead |
| `export_onnx.py`, `test_onnx_parity.py` | v1 export | rewrite at M4 |

### 4.4 Tests
`tests/index.ts` is one file with a tiny custom runner (614 tests). Add engine and harness tests there. Python tests go in `training/` as `test_*.py` scripts that exit non-zero on failure, like `training/test_env.py`.

---

## 5. M0: build the environment

M0 builds the *environment* side of the design: anchors, the v2 observation and action space, the two-seat runner, v2 bots, and all checks. M1 then builds the first *learner* on top. The plan's rule "one new component per stage" applies to learning components (§7), not to M0's environment parts, but each M0 task still lands as its own commit with its own tests.

### 5.1 Order and dependencies
```
T0  pre-flight
T1  P-6a balance matrix with today's bots      → user review (may change the game)
T2  P-5  engine throughput                     (independent; do early, everything after is faster)
T3  P-1  anchors
T4  P-4  truncation at the cap
T5  action space v2 + masks                    (needs T3)
T6  observation v2, own-frame                  (needs T3)        ← P-3
T7  two-seat runner + Python vec env v2        (needs T5, T6)    ← P-2
T8  v2 scripted bots + switchers               (needs T5, T6)    ← P-7
T9  P-8  harness checks                        (needs T7)
T10 P-6b balance matrix with v2 bots           (needs T8)        → user review
T11 P-9  GPU checks
T12 M0 exit review with the user
```
The map sign-off (P-10) is done (2026-11-11, all 10 maps). If any map is re-frozen, its `approved` resets to null and needs a new sign-off before T12.

### 5.2 T0: pre-flight
- Read the plan, this guide, and `GAME_UPDATE_PLAN.md` G-5 to G-8 (terrain, sight, control).
- `npm run build:shared && npm test` → 614 pass. `npm run bench` → record the number in the diary as your baseline.
- Play one game in the browser or watch a replay, so you know what the game looks like.

### 5.3 T1 (P-6a): balance matrix with today's bots
**Why first:** if one strategy dominates, self-play will converge on it, and fixing the game later invalidates everything trained.
- The tool exists: `npx tsx headless/src/balance.ts --games N --bots … --maps all --maxTicks 12000 --jobs 12 --json out.json` (parallel, both seat orders, prints the matrix, mirrors, timeouts and win types). It knows only 4 bots (rush = `MediumRushBot`, macro, turtle, heavy); add the rest to its `BOTS` table.
- **Prior result (U5 gate, 2026-11-10, cap 6,000, 960 games):** row's score vs column: rush 38/0/22 vs macro/turtle/heavy; macro 63/43/92; turtle 100/57/100; heavy 78/8/0. Win types: control 61%, combat 26%, timeout 13%. It passed the game update's gate ("no strategy above 70% against every other") only because macro holds turtle to 57%. Mirror matches timed out often (rush–rush 45%, turtle–turtle 54%). The diary notes the counter triangle "is only partly there".
- What this task adds: the 12,000 cap (so timeouts stop hiding outcomes), all 9 bots, ≥20 games per pairing per map, per-map tables, and game-length statistics.
- Run all 9 bots × all pairings × all 10 pool maps, ≥20 games per pairing per map, **both seat orders**, cap 12,000.
- Record per pairing: win rate, **win type** (`combat` / `control` / `timeout`), mean and max game length.
- Write `docs/balance/2026-11-matrix.md` with the tables and a one-paragraph reading.
- **Gate:** on each map, no bot wins more than about 80% against *every* other bot. Also flag: more than 10% timeouts in any pairing; any map where one seat wins more than 60% in mirrors.
- **If the gate fails:** stop and show the user. They have already decided that a dominant strategy is fixed in the game before training. Propose the smallest lever (control hold time, node count needed, turret cost) and re-run. Balance changes follow the version-bump rule.

### 5.4 T2 (P-5): engine throughput
- **Hard constraint: determinism.** Before touching anything, generate golden state hashes: run about 20 seeded bot matches across 3 maps and record `engine/hash.ts` hashes every 500 ticks. After every optimisation the hashes must be identical. Add this as a test.
- Leads, in order:
  1. The 25% self time inside `tick()`. Profile with source maps (build with `tsc`, or `--enable-source-maps`) to find the loop. Suspects: repeated `[...match.entities.values()]` spreads and `find` calls per tick.
  2. `computeVisibility` (11%): skip recomputation for sources that did not move a cell; it runs for both players every tick.
  3. `processMovement` (19%) and `buildSpatialGrid`.
- The harness computes observations for scripted bots every tick. In v2, bots decide every 8 ticks (T8), which removes most of that cost in training.
- **Target:** ≥4,000 ticks/s per core on pool maps in `npm run bench`. If you reach 3,000 and the remaining cost is spread thin, write that up and move on. Record before and after.
- The number that matters at the end is **decisions per second through the full Python loop** (T7). Measure and record it.

### 5.5 T3 (P-1): named anchors
- Add `anchors` to the map data the engine exposes (compute once per map, cache with the terrain):
  ```ts
  interface MapAnchors {
    base: [Pt, Pt];             // per seat: just outside the crystal's no-build ring, toward the centre
    pockets: [Pt[], Pt[]];      // per seat: open build areas near the base (≤3)
    centre: Pt[];               // open areas near the map centre (≤3); own-frame order
    nodes: Pt[];                // every contested node
    safeNodes: [Pt[], Pt[]];
    chokes: [Pt[], Pt[]];       // per seat: narrowest points on base→centre paths (≤3)
  }
  ```
- Derive them from the nav grid and terrain, not by hand, so `mapgen` maps get them automatically:
  - pockets and centre: largest open, buildable regions by distance band;
  - chokes: minimum-width cells along the base→centre flow field.
- **Seat symmetry is mandatory:** seat 1's anchor *i* is the symmetric image of seat 0's anchor *i* (mirror: `x → W − x`; rotate: `x → W − x, y → H − y`). Shared anchors (`centre`, `nodes`) are stored once, and each seat reads them in its own-frame order (§5.7).
- Fixed maximum counts with padding and a validity mask. Suggested maxima: pockets 3, centre 3, chokes 3, contested nodes 12 (pool maps have 8–10), safe nodes 4.
- **Tests:** anchors exist and are on walkable (and for pockets, buildable) cells on all 12 maps; seat symmetry holds exactly; every anchor is reachable from the base.

### 5.6 T4 (P-4): truncation
- Training cap: `maxTicks = 12000`. Live play stays at 0 (no cap).
- At the cap the engine still names a tiebreak winner (keep that for the live game and for `runMatch`), but the runner must report `truncated: true` separately from `done`, and the trainer must **not** treat it as a win or loss.
- On truncation the runner returns the final observation of the truncated episode (see `terminal` in §5.8) so the trainer can bootstrap the value.
- In evaluation a truncated game counts as a draw.

### 5.7 T5 and T6: action space v2 and observation v2
Put v2 in new files (`headless/src/v2/…`) so v1 keeps working until the switch.

**Own frame (P-3).** Everything the policy sees or targets is in the acting player's frame: own base on the left. For seat 1, apply the map's symmetry transform to all coordinates, grid channels and anchor orderings. Write one module with `toOwnFrame` / `fromOwnFrame` and use it everywhere. **Test:** construct a state and its symmetric image with seats swapped; both seats must get bit-identical observations and masks. Do this on one mirror map and one rotate map.

**Actions (R-2).** One decision every `k = 8` ticks. Each decision is one economy action and one army order.

*Economy head: one flat categorical with a mask.*
| Entry | Count |
|---|---|
| `noop` | 1 |
| `train(unit)`: worker, skirmisher, gunner, bruiser, medic | 5 |
| `build(building, site)`: 4 buildings × sites (own base, own pockets, own chokes, centre) | 4 × 10 |
| `assign_workers(node slot, count ∈ {1, 2, all idle})`: node slots = safe + contested | 16 × 3 |

*Army head: three chained categoricals (group → order → target), each masked given the previous choice.*
| Part | Entries |
|---|---|
| group | `none`, all combat, army A, army B, skirmishers, gunners, bruisers, medics, scout (one idle fast unit, else one worker) |
| order | attack-move, move, hold, retreat to base, join army A, join army B |
| target | any anchor (own-frame index), or one of 16 enemy-memory slots, or `none` (for hold, retreat, join) |

- Army A/B membership is harness state per seat, reset per episode. New units join neither until assigned.
- **Worker autopilot (harness rule, applies to bots and policy alike).** The engine does not make new or idle workers gather, and today's bots spend an `assign_workers` action every 30 ticks on housekeeping. With one economy action per decision, that housekeeping would crowd out `train` and `build`. So: each decision, before the seat's action is applied, the harness sends any idle worker to the nearest own safe node that still has resources. `assign_workers` then becomes a strategic choice (send workers to a contested node, or pull them back), not a chore. Count autopilot assignments in `info`. This is a harness convenience, not a game change; if you think idle workers should auto-gather in the live game too, raise it with the user.
- The runner sends the masks as tables: `econMask[E]`, `groupMask[G]`, `orderMask[G][O]`, `targetMask[O][T]`. The policy samples group, then order, then target.
- **A legal action must do something** (P-8). Build legality includes "a valid placement exists at that site now". Train legality includes resources, supply and a free producer. Count executed-but-ineffective actions in `info`; the test requires the rate to be 0 for scripted play.
- Reuse `chooseBuildPosition` and friends for placement, but resolve targets from anchors, never from map-width fractions.
- You may adjust entry lists and maxima. You may not drop: anchor targets, memory-slot targets, two armies, or the parallel-heads structure. Those are the approved design (R-2).

**Action space v3 (G-13 Phase B, v0.8.9-ML; supersedes the two tables above).** A deviation from R-2 signed off by the user on 2026-11-12 (`docs/BOT_CONTROL_PLAN.md` §2). `ACTION_SPACE_VERSION = 3` in `headless/src/v2/actions.ts`, which is the source of truth for all indices.
- *Econ:* one flat head of 61 kinds: noop, train ×5, build ×4 (one per building), assign 16 × 3, repair, set rally, cancel last queued. Three sub-heads, each read only for its kinds:
  - `site` (760): 10 named sites + 750 grid cells (50 × 15 cells of 100 × 60 px). Masked per building by the exact placement check (including the wall-off seal check).
  - `econPtr` (200): entity row pointer. Repair → a damaged own building (nearest free worker repairs it); rally / cancel → an own production building.
  - `econTarget` (804, same table as the army target): rally point.
- *Army:* group (adds `unit`) → order → unit → target → ptr.
  - Groups: none, all combat, army A/B, 5 unit types, scout, unit (one own unit picked by the `unit` pointer).
  - Orders: none, attack-move, move, guard (point), guard here (each unit at its own spot; replaces hold), retreat, focus (enemy pointer → ordered `attack`), heal (own-unit pointer, medics), stop, join A/B.
  - Target (804): 37 anchors + 16 memory slots + 750 grid cells + none.
- Wire format: `{"econ": [kind, site, econPtr, econTarget], "army": [group, order, unit, target, ptr]}`. Masks: `econ[E]`, `site[4][760]`, `econPtr[3][200]`, `econTarget[804]`, `group[G]`, `order[G][O]`, `unit[O][200]`, `target[O][804]`, `ptr[O][200]`.
- Pointers index the observation's entity rows (`MAX_ENTITIES = 200`), so the observation must be built before the masks. Observation schema 2 adds a `guarding` entity feature.
- The "a legal action must do something" rule (P-8) still holds; `botCheck` and the custom suite's random-action test check it.

**Observation (R-1).** All in own frame, all deterministic.
| Block | Content |
|---|---|
| Globals | own resources, supply, queues; control-race state (public); tick / cap; last-seen enemy counts per unit and building type, each with its age; time since the enemy army was last seen; own army A/B sizes |
| Entity set | own and *currently visible* enemy entities: type, position, health, state flags, terrain under it (high, brush, rough), army membership |
| Enemy memory set (16 slots) | every enemy building ever seen, plus the last-seen enemy army cluster: type, last-seen position, last-seen health, age, known-destroyed flag. **Built only from what `visibilityData` allowed.** Stateful per seat; reset per episode |
| Node set | all nodes: position, remaining (if seen), controller, own workers on it |
| Spatial grid (≈48×24) | static: blocked, rough, high, water, brush. Dynamic: visible now, ever seen, time since seen, own army influence, last-seen enemy influence |
| Strategy token `z` | an integer set by the trainer per episode (0 = free). The runner just passes it through |
| **Critic state** (training only) | the same blocks built **without fog**, for both players |
| **Opponent-model labels** (training only) | the enemy's true unit count per type (5), building count per type (4), units in production per type, and the anchor nearest the enemy army's centre (or none) |

- Send static grid channels once per episode, in the reset reply.
- Give the observation a `schemaVersion` integer and have Python assert it.

### 5.8 T7 (P-2): two-seat runner and Python env
New `headless/src/v2/vecRunner.ts`, built to `headless/dist/` by a new `build:headless` entry.

**Protocol v2** (newline-delimited JSON, same transport as today):
```jsonc
// Python → Node
{ "type": "reset_all",
  "decision_interval": 8, "max_ticks": 12000,
  "slots": [ { "seed": 123, "map": "shardfall",
               "blue": "policy", "red": "bot:turtle",      // "policy" | "bot:<name>"
               "z": {"blue": 3, "red": 0},
               "scenario": null,                            // probe scenarios (§6)
               "save_replay": false } ] }
{ "type": "step",
  "actions": [ { "blue": {"econ": 7, "army": [2, 0, 14]} } ] }   // one entry per slot; only policy seats

// Node → Python
{ "type": "step_result",
  "slots": [ { "seats": { "blue": { "obs": {…}, "masks": {…}, "critic": {…}, "oppLabels": {…},
                                    "rewards": {"win": 0, "shaped": {"res": 0.01, "army": 0, "dmg": 0, "ctrl": 0}},
                                    "teacher": null } },
               "done": false, "truncated": false,
               "terminal": null,        // on done/truncated: final obs+critic per policy seat, before autoreset
               "info": {} } ] }
```
- Either seat, both, or neither can be `"policy"`. With both, one slot yields two streams of experience.
- A `bot:` seat is stepped inside Node at the same decision cadence, using the same v2 action space (T8).
- `teacher`: when a slot is in imitation mode (`"blue": "teach:turtle"`), the bot plays and the runner returns the bot's chosen v2 action with the observation **it was chosen from** (same step, no shift). That is the imitation label.
- **Rewards are returned as raw components.** Python applies weights and schedules, so a schedule change needs no rebuild. The shaped components are zero-sum differentials: my delta minus the opponent's delta, each normalised to be O(0.01) per decision.
- Autoreset on done or truncation, as today. Slot config (map, seats, `z`, scenario) persists across autoresets unless Python sends new values; allow per-slot reconfiguration at reset boundaries so the trainer can change opponents without restarting processes.
- Keep JSON. Measure IPC cost; consider a binary format only if serialisation exceeds about 15% of wall time.

**Python `training/env/vec_env_v2.py`:** spawns `n_procs` runners, flattens policy seats into a batch of *streams* (slot, seat), and tracks which streams belong to the learner and which to a frozen opponent. It exposes done/truncated per stream and the terminal observation.

**Tests:**
- *Equivalence:* drive bot-vs-bot through the v2 runner and through a direct in-process loop; state hashes match tick for tick.
- *Autoreset persistence:* after 3 autoresets every slot still has its map, seats and `z` (the bug that sank earlier runs).
- *Seat swap:* the same seed with seats swapped yields the mirrored game.
- *Throughput:* decisions/s through Python with a random policy, recorded in the diary.

### 5.9 T8 (P-7): v2 scripted bots
- New interface: `decide(obs, masks) → { econ, army }`, called once per decision by the runner. Bots use the same observation and action space as the policy, at the same rate. That makes them fair opponents and exact teachers.
- Port: rush (3 strengths), turtle, macro, heavy, idle.
- **Parameterise** each with an opening template (build order), a timing, and a target choice, sampled per episode from a seeded RNG. Each template carries a strategy token `z`. Aim for ≥12 distinct `z` values across bots.
- **Switcher bots:** start as one template and switch to another at a random tick in [1,500, 4,000]. At least four: rush→turtle with gunners; macro→bruiser timing attack; fake expansion then an army through brush; turtle→late control grab.
- **Hidden-army bot:** masses out of sight, then attacks. Used by E-6.
- All randomness through the engine's seeded RNG (`engine/rng.ts`), never `Math.random()`.
- **Tests:** every bot completes 5 games on every map without exceptions; identical seeds give identical games; the ineffective-action rate is 0.

### 5.10 T9, T10, T11
- **T9 (P-8):** the tests listed in T5–T8, plus: replaying a saved replay reproduces the recorded observations exactly.
- **T10 (P-6b):** re-run the balance matrix with the v2 bots including switchers. Same gate and same write-up. v2 bots are weaker per tick than v1 bots (fewer actions), so the picture may change. Show the user.
- **T11 (P-9):** on the P100, (a) a gradient check comparing `nn.LayerNorm` with the custom class over 200 steps (no NaN or inf), (b) a 5-minute PPO smoke run against the idle bot through the v2 env.

### 5.11 M0 exit
All tests green; diary entry; both balance write-ups reviewed by the user; map sign-off recorded; measured decisions/s recorded; the version bumped. Then ask the user before starting M1.

---

## 6. Probes: learning tests in the real engine

Each probe is a small scenario (`"scenario"` in the reset message, replacing `prePlace`) with a pass criterion. **Each ships with a scripted oracle that passes and a scripted anti-oracle that fails,** proving the probe measures what it claims before any network is trained on it. Probes live in `training/probes/` and run from one command. They re-run after any change to the runner, observation, actions or trainer.

| Probe | Scenario | Pass | Proves |
|---|---|---|---|
| **Overfit** | one imitation batch | loss < 0.05 | data path, heads, masks |
| **Idle** | full game vs idle bot | ≥95% wins within 30 minutes of training | reward, actions, termination end to end |
| **Memory** | The enemy's army composition (gunner-heavy or bruiser-heavy, random) is visible to a pre-placed scout for the first ~10 decisions, then the scout is removed. The enemy attacks at a fixed later tick. The agent has resources for exactly one counter-composition | recurrent agent ≥90%; the same agent with LSTM state zeroed each step and memory set blanked ≤60% | hidden state is stored, reset and used; memory set works |
| **Seat** | same policy from both seats, on a mirror map and a rotate map | win rates within the interval of each other | own-frame transform |
| **Truncation** | an idle-vs-idle style scenario that always hits the cap | value predictions near the cap stay near 0, not ±1 | bootstrap |
| **Opponent model** | scout walks into the enemy base | prediction loss drops sharply at the sighting and stays lower | labels, fog, memory |
| **Switch** | one switcher bot, fixed switch tick | after training, production mix differs before and after the switch | the E-4 measurement works |

For the memory probe, the counter table is `COUNTER_MODIFIER` in `shared/src/gameBalance.ts`: skirmisher > gunner > bruiser > skirmisher, at 1.5× / 0.75×. A workable pairing: the enemy shows either gunners or skirmishers; the right answers are skirmishers and bruisers respectively (pre-place a barracks and a foundry so both are buildable). Confirm with the scripted oracle that the right counter wins and the wrong one loses. If the 1.5× / 0.75× swing is too small for the oracle to separate them, tell the user: it would mean the game gives too little to adapt to.

---

## 7. M1–M4: the learner

### 7.1 Architecture (R-3)
```
entity set   → set-transformer (existing SetEncoder)   ┐
memory set   → small set-transformer                    │
grid         → 3-layer CNN → flatten → linear           ├→ concat → MLP → LSTM(256–384) → heads
globals + z  → MLP (z via embedding)                    ┘
heads:  econ logits | army group → order → target logits (each conditioned on the previous choice)
        value × 3 (win, shaped, aux)      ← these read the LSTM output *and* the critic-state encoding
        opponent model (binned counts per type, tech flags, army-location class)
```
- The opponent-model output (detached) is concatenated into the input of the policy heads.
- The critic-state encoder is separate and is not exported.
- Bin counts for the opponent model as classes (0, 1, 2, 3–4, 5–8, 9+) with cross-entropy.
- 2–4 M parameters. Check CPU inference time for batch 1 early: target under 5 ms.

### 7.2 Recurrent PPO: starting hyperparameters
Taken from RAISocketAI's published table (checked against the paper text) and OpenAI Five, adapted. They are starting points, not requirements.

| Setting | Start |
|---|---|
| Streams | as many as give full CPU use: about 10 processes × 8 slots |
| Rollout length | 128 decisions per stream |
| BPTT chunk | 32 decisions; stored initial LSTM state per chunk; state zeroed at episode starts |
| Epochs / minibatches | 2 epochs; minibatches are whole chunks |
| Discount γ per value head | win 0.999, shaped 0.99, aux 0.999 |
| GAE λ per head | win 0.99, shaped 0.95, aux 0.99 |
| Clip | 0.1 for policy and value |
| Learning rate | 1e-4, decaying to 5e-5 |
| Entropy coefficient | 0.01 → 0.001 |
| Max grad norm | 0.5 |
| Advantage mixing | normalise each head's advantage, then weighted sum. Weights (shaped, win, aux): 0.8 / 0.1 / 0.1 at the start → 0.1 / 0.8 / 0.1 late. **The shaped weight never goes below 0.1** |
| Shaped reward time decay | multiply shaped components by 0.6^(game minutes / 10) |
| Opponent-model loss weight | 0.5 at first; tune so it doesn't dominate the gradient norm |
| Truncation | bootstrap from the terminal observation's value |

**Known recurrent-PPO bugs to test for, not hope about:** wrong reshape between (time, batch) and (batch, time); hidden state not zeroed at episode starts inside a chunk; padding not masked in the loss; using stale stored states after the first epoch without noticing. The memory probe catches the first two.

### 7.3 M1: first learner (no self-play)
Add components in this order. Each step is compared with the previous one over 3 seeds at a short fixed budget, on training maps, and stays only if it is not worse.
1. **Feed-forward PPO** on the v2 observation and actions against the idle bot, then the weakest rush. Overfit and idle probes pass.
2. **LSTM.** Memory, seat and truncation probes pass.
3. **Imitation + KL** (R-4):
   - Generate data online with `teach:` seats: v2 bots playing each other on the 8 training maps, with their `z`.
   - Train policy heads (cross-entropy), all value heads (on the real outcomes and shaped returns) and the opponent-model head together.
   - **Gate:** the imitation policy alone wins ≥40% overall against the scripted pool (lower bound of the interval). If not, fix the observation or action design before any RL.
   - Start PPO from it with a KL penalty toward the frozen imitation policy, annealed to zero over the first part of training.
4. **Opponent-model head feeding the policy.** Opponent-model probe passes.

Then train against the scripted pool (all bots, sampled toward the ones it loses to) on all 8 training maps.
- **M1 gate:** all probes pass; E-1 ≥70% against each scripted bot on training maps; held-out maps reported.
- **Deliverables:** a playable snapshot for the user's first playtest (this needs a minimal way to run the PyTorch policy against a human: a local inference process the server calls is enough; the production path comes at M4); write new `docs/ML_AGENT.md` and `training/README.md` for the v2 system (the v1 versions are in `docs/archive/`).

### 7.4 M2 and M3
**M2: self-play (R-5, R-6).** Add in order: self-play → strategy token `z` → matchup weighting.
- Opponent mix per episode: 50% latest self (both seats learn), 25% past snapshots, 25% scripted pool. A snapshot is saved every fixed number of updates.
- Snapshot sampling: weight toward snapshots the learner loses to (`league.py`'s PFSP maths or OpenAI Five's quality scores). Limit distinct snapshots per rollout to about 4 so GPU inference stays batched.
- Frozen opponents run in Python on the GPU with their own LSTM states.
- `z`: per episode, with probability about 0.5 the learner gets a non-zero `z` and a small pseudo-reward for matching that template's opening (compare the first N production choices). Otherwise `z = 0`. Evaluation uses `z = 0`.
- Matchup weighting: scale each sample's loss by a weight that peaks at 1.0 for opponents near a 50% win rate.
- **M2 gate:** E-1 ≥80% each; E-9 (no forgetting); beats the M1 agent ≥70%; no rush-collapse alarms (§7.6).

**M3: robust and adaptive.**
- **Exploiter cycle:** freeze main; train a fresh agent from the imitation start against only the frozen main, for a fixed budget (the same budget every cycle); record its final win rate (E-5); add it to the scripted-pool share as a frozen opponent; resume main. Do 2–3 cycles.
- Shift the advantage mix toward win/loss (floor 0.1 on shaped).
- Only if E-7 shows poor scouting: add ROA-Star's scouting bonus (reward the decrease in opponent-model cross-entropy, never penalise the increase).
- **M3 gate:** E-2 to E-8, then the user's playtest.

**M4: ship (needs the user's explicit go-ahead).**
- Export to ONNX with the LSTM state as explicit inputs and outputs. Add `onnxruntime-node` to the server (it has no neural inference today).
- A server bot class that holds per-match LSTM state, builds the v2 observation for its seat, and acts every 8 ticks.
- Parity test: PyTorch vs ONNX over whole recorded episodes, not single steps.
- Easy / Normal / Hard = an early, a middle and the final snapshot. Pick them by Elo spacing.
- **The bot's read of the player** (opponent-model output): a toggle in the live UI, default off; always shown in replays. For replays, log the head's output per decision alongside the command log so replays stay deterministic.
- Release notes; `./deploy.sh`.

### 7.5 Stop rule and time boxes
| Milestone | Time box |
|---|---|
| M0 | ~2 weeks of build work |
| M1 | 1 week |
| M2 | 1–2 weeks |
| M3 | 2 weeks |

**Stop and go to the user when:** a milestone misses its gate after 2 diagnosed iterations; a time box is exceeded; a probe that used to pass fails and the cause isn't found in a day; you want to change more than one variable at once; you want to deviate from an approved item.

### 7.6 Monitoring (log all of these to TensorBoard from the first run)
- Per value head: explained variance, mean return.
- Per reward component: mean per episode (unweighted).
- **Episode length, win-type split (combat / control / truncated), production counts per unit type, opening entropy.** A sharp fall in episode length while win rate rises is the published signature of rush collapse (UECD: 1,200 → 300 frames, then 0% against unseen bots). Treat it as an alarm: stop, inspect replays, write it up.
- Policy entropy per head; KL to the imitation policy; clip fraction; gradient norm, split by loss term.
- Opponent-model loss and accuracy.
- Win rate per opponent and per map; seat split.
- Fraction of `noop` per head (the old "noop attractor").
- Decisions per second.

---

## 8. Evaluation harness (build during M1, before the first gate)

- `training/eval/evaluate.py`: a checkpoint, a list of opponents, a list of maps, a seed file → JSON results.
- **Fixed seed files** committed under `training/eval/seeds/`. Same seeds for every evaluation of every checkpoint.
- Every matchup is played from both seats. ≥200 games per matchup for gates.
- Report win, loss and draw (truncation) rates with **95% Wilson intervals. A gate passes only if the lower bound clears the bar.**
- Never promote, select or stop on a training-window statistic.
- Results are written to `docs/eval/<date>-<checkpoint>.md` and summarised in the diary.
- The metric definitions are in the plan (§10, E-1…E-10). E-3 and E-4 need per-decision logs of the opponent-model output and the production mix around the switcher's switch tick; the switcher bot must report its switch tick in `info`.
- **Experiment registry:** `docs/experiments.md`, one row per run: date, commit, config diff from the previous run, seeds, budget, result, verdict.

---

## 9. Pitfalls this project has already paid for

| Pitfall | Guard |
|---|---|
| Config silently lost on autoreset | T7 persistence test |
| Python ran a stale `dist` bundle | staleness check in the vec env; `npm run build:headless` after every harness change |
| Docs drifted from code (action table) | regenerate the action table in docs from code; `schemaVersion` asserted in Python |
| Imitation labels shifted by one step | `teacher` action is returned with the observation it was chosen from; overfit probe |
| Teacher acted more often than the student could | v2 bots use the policy's action space at the policy's cadence |
| Legal actions that did nothing | P-8 ineffective-action counter |
| Promotion on a noisy window | Wilson lower bound on fixed seeds |
| Discount horizon shorter than the game | per-head γ; win head at 0.999 |
| Terminal-only reward → rush collapse | shaped floor 0.1; monitors |
| "Noop until the inevitable loss" | zero-sum shaped rewards; truncation is not a loss; noop-fraction monitor |
| Bot crash killing a run | every bot fuzzed on every map (T8); the runner logs and survives a bot exception |
| `Math.random()` in the harness | seeded RNG only; replay-reproduces-observations test |
| Mid-rollout opponent or stage swaps corrupting GAE | change slot config only at episode boundaries; never rebuild envs inside a rollout |
| Resume warping the LR schedule | schedules are functions of total decisions stored in the checkpoint |
| Unpushed work lost | push after every commit |

---

## 10. Research digest for the implementer

Full table and sources: plan §1 and §14. The points that should guide judgement calls:

1. **Imitation, and staying close to it early, is the biggest single factor** (AlphaStar ablation: Elo 149 without human data, 936 from imitation alone, 1,400 with the KL penalty, 1,540 with strategy conditioning). When in doubt, improve the teachers and the imitation stage before touching RL.
2. **Signal beats optimiser tricks** (UECD ablation): richer observations, tighter masks, matchup weighting and opponent modelling each gave about +20 points; PopArt, GELU, autoregressive sampling and frame stacking gave +5 to +13 with high variance. Spend effort accordingly.
3. **Pure self-play forgets** (AlphaStar: worst win rate vs past versions 46%, against 71% with past opponents mixed in). Keep the past-snapshot share.
4. **Long horizons keep helping** (OpenAI Five went from 180 s to 6–12 min). If late-game play looks short-sighted, raise the win head's γ before anything else.
5. **Long episodes are where things break** (RAISocketAI's 3,500-step map fell below its imitation start under PPO). Our games are 375–1,500 decisions. If training degrades on the longest maps, suspect credit assignment first.
6. **Opponent modelling raised worst-case robustness the most** (ROA-Star: 1% → 44% worst-case win rate).
7. **Scale honesty:** AlphaStar used 12 agents on 32 TPUs each for 44 days. The comparable budget to ours is microRTS agents at 10–70 GPU-days. Do not copy large-scale choices (huge batches, many learners) without a reason.

---

## 11. Hand-off checklist (state at 2026-11-11)

- [x] Plan v2 written, audited, approved item by item.
- [x] User decisions recorded (plan §13).
- [x] This guide written.
- [x] Stale documents moved to `docs/archive/` (2026-11-12).
- [ ] **User says "start".**
- [x] Map sign-off (P-10), 2026-11-11.
- [ ] M0 … M4.

Unrelated work also pending from the user's earlier approval ("yes to all"), not part of this plan: 3D view polish (team colour on skirmisher and gunner models, Kenney audio, muzzle flashes and hit sparks). See `docs/VISUAL_PLAN.md` known gaps. Ask the user which comes first.
