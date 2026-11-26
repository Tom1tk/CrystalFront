# Rebuild plan R1/R2 (2026-11-26)

This implements the changes in `docs/TRAINING_REVIEW_2026-11.md` §5, all approved. Item numbers
below are the review's (1–9). Everything stays learned. The scripted bots supply training labels,
opponents and measurements only. Nothing scripted runs at play time.

## 0. Decisions in this plan

1. **New layout `v4`, as a frozen-copy fork of v3.** The project already does this for v2 and v3:
   `headless/src/v2` stays frozen for the 0.9 bots, and v3 is the beta layout.
   - Copy `headless/src/v3` to `headless/src/v4` and make every change there.
   - v3 stays as it is. The shipped beta models, their parity tests and the b-round replays keep
     working.
   - Observation schema 8, action space 10, `CF_LAYOUT=v4`.
2. **Warm start by surgery from b3, not a fresh imitation.** This deviates from the review, which
   said "fresh imitation warm start".
   - All the new inputs are added with zero weights, as `training/v3_surgery.py` did for v3.
     Affected parts: new entity, global and grid columns, new memory slots, the attention-pool
     branch into the core and the new opponent-model groups.
   - The v4 policy then plays exactly like b3 on day one (`--check`), while the new inputs get
     gradients from RL.
   - A fresh imitation starts from about 0.63 pool (b1-imitate) against b3's 0.94. Getting back to
     0.94 took three league rounds (b1→b3, about 80 h).
   - Fallback (§6): fresh imitation on v4, if the surgery check fails or R1 shows that the new
     inputs are not used.
3. **Memory slots are appended, not reshuffled.** Slots 0–15 keep their v3 meaning: 0 is the
   centroid of the last-seen enemy army, 1–15 are buildings. Slots 16–23 are new: 3 army clusters
   and 5 lone units. Old target indices then map one to one in surgery.
4. **The defence teacher (item 9) goes in R1, not R2.** It is cheap, training only, and aimed
   straight at the measured failure (0% of the away army comes home).

## 1. Versions

| | v3 (now) | v4 (R1) |
|---|---|---|
| `OBS_SCHEMA_VERSION` | 7 | 8 |
| `ACTION_SPACE_VERSION` | 9 | 10 |
| `N_GLOBALS` | 68 | 78 |
| `ENTITY_F` | 37 | 48 |
| Grid dynamic channels | 5 | 7 |
| Memory slots × `MEMORY_F` | 16 × 15 | 24 × 18 |
| `TARGETS` (37 anchors + memory + 750 grid + none) | 804 | 812 |
| Opponent model | 7 units + 5 buildings × 6 bins + anchor | adds 3 groups × 6 bins + near-base anchor (38) |
| Critic input | both seats' globals (136) | unfogged own entities, nodes and grid, plus both seats' globals |

- Package versions: R1 code is 0.9.15-ML and R2 code is 0.9.16-ML. Any further training, reward or
  config change bumps again (all 5 `package.json`).
- The engine is untouched, so golden hashes must stay identical. That is checked at every step.

## 2. R1: implementation steps

Each step is one or more commits and must pass the full check list (build and test, client and
server tsc, golden hashes, headless build, python tests, vite build) before the next step.

### S1. Fork the layout

- **Files:**
  - Copy `headless/src/v3/` to `headless/src/v4/`, at first with only the version numbers changed.
  - `training/v2/spaces.py`: `CF_LAYOUT=v4` reads the v4 layouts.
  - `training/env/vec_env_v2.py`: the v4 runner.
  - The npm build includes v4.
- **Verify:** with `CF_LAYOUT=v4`, a 2-env smoke run of `train.py` for 2 updates runs. All
  existing v3 tests are unchanged.

### S2. Schema 8: unit facts and relations (item 2)

All features are computed from the seat's own fogged view, like the scripted bots.

- **Entity columns (11 new; ENTITY_F 37 → 48):**
  - Unit constants from `UNIT_DEFS`/`BUILDING_DEFS`: weapon range /400, vision /600, speed /4 and
    dps (damage / cooldown) /40. They are 0 for buildings that have none.
  - Distance to own crystal and distance to enemy crystal, each /3000. Crystal positions are known
    from the map.
  - Distance to the nearest visible enemy /1000, capped at 1.
  - In range of a visible enemy (0/1): the enemy's range plus both radii is at least the distance.
  - Visible enemies within my range /5, capped.
  - vx, vy: displacement since the last decision / (8 × max speed). `ObsState` keeps an id → last
    position map, which is cleared for ids not seen.
- **Grid (2 new dynamic channels):**
  - `enemy_threat`: the sum of visible enemy dps whose range covers the cell, /100.
  - `own_coverage`: the same for own units and turrets.
  - Use the existing 15 × 50 cells, measured at the cell centre.
- **Globals (10 new; 68 → 78):**
  - Enemy buildings within 900 px of my crystal, seen or remembered (/5).
  - Enemy combat units visible within 900 px of my crystal (/10).
  - Enemy units visible in my half (/10).
  - Enemy workers seen outside their own half in the last 60 s (/3).
  - Time since the first near-base enemy building was seen (min(t/600, 1)).
  - Time since enemy combat units were first within 900 px (same scale; resets after 30 s with none).
  - Distance from the nearest visible enemy to my crystal (/3000).
  - Own combat units within 900 px of my crystal (/20).
  - Own army share within 900 px of my crystal.
  - Own army share in the enemy half.
- **Tests** (`headless/src/v4/*.test.ts`):
  - Mirror symmetry: the mirrored state gives the same features for the other seat. There are
    existing frame helpers in `frame.ts`.
  - Hand-built states with known distances, ranges and dps give exact values.
  - vx and vy are 0 on the first sight and correct after a known move.
  - The fogged view never leaks: an enemy out of vision changes no feature.

### S3. Memory v2 and action space 10 (item 3, memory part)

- **Slots:**
  - 0–15 as in v3.
  - 16–18 are enemy army clusters. A greedy, deterministic clustering puts visible enemy combat
    units within 500 px of a seed together, and the 3 largest clusters are kept, with their
    centroid, size, last-seen tick and heading.
  - 19–23 are lone units: enemy workers, Outriders, or groups of 1–2 combat units not in a cluster,
    last seen **outside their own half**.
- **Lifecycle:**
  - A lone unit takes a free slot, or the oldest one if none is free.
  - A slot is cleared when its unit is seen dead, when its last position is in vision and empty, or
    after 120 s.
- **MEMORY_F 15 → 18:** heading x/y and a "lone unit" flag are added to all slots.
- **Targets:** memory targets are 37..60 and the grid starts at 61. `TARGET_NONE` is 811 and
  `TARGETS` is 812. The masks allow a memory target only when the slot is filled.
- **Tests:**
  - A worker seen crossing the edge and then lost keeps its slot with its heading, and clears after
    120 s or once seen empty.
  - Clusters are stable under row order.
  - Mapping a target index to a point and back works for every memory slot.
  - v3 slots 0–15 are identical to v3's on a replayed game.

### S4. Opponent-model labels (item 4, model part)

The runner adds true labels for the seat's opponent, training only:

- enemy buildings within 900 px of my crystal (6 bins);
- enemy combat units within 900 px of my crystal (6 bins);
- enemy workers outside their own half (6 bins);
- the anchor of the nearest near-base enemy building (37 anchors + none).

**Test:** the labels match a hand count on fixed replays of `backdoor` and `rush_post`.

### S5. Critic input (item 1, data part)

- `packCritic` sends, from `criticState()` (which already exists):
  - the seat's **unfogged** entity block (200 × 48, the same row priority as the observation);
  - the unfogged nodes (20 × 13);
  - the unfogged grid (7 dynamic + 5 static × 15 × 50);
  - both seats' globals.
- This is about 15.5 k floats per decision. It is sent in the packed binary format and stored as
  float16 in the rollout batch (about 0.6 GB per update at 18 k decisions).
- **Test:**
  - The packed block round-trips.
  - The critic block of a mirrored state equals the mirror of the other seat's.
  - Throughput with the critic on is measured against off with `bench.ts`, and the cost is reported
    in the R1 results.

### S6. Network (items 1, 3, 4)

- **Critic encoder** (training only, never exported):
  - Entity projection 48 → 64, 1 transformer layer (d 64, 4 heads), and an attention pool (2 queries
    plus a null token).
  - A small CNN (2 conv) over the 12-channel grid, an MLP over the nodes and an MLP over the 156
    globals, giving 256 in total.
  - `values(h, critic_enc)`: the existing value MLP, with its input widened.
- **Attention pool** for the policy trunk:
  - Tokens are the transformer's entity outputs E (200 × 128) plus memory tokens, where each of the
    24 slots goes through Linear(18 → 128) with a slot embedding.
  - 4 learned queries attend over all valid tokens, and 2 queries over enemy entity rows and
    filled memory slots only.
  - A learned null token is always valid, so empty sets cannot produce NaN.
  - The 6 × 128 output goes through Linear to 256, which is appended to the core input as **new
    zero-initialised columns of `core[0]`**.
  - The mean pool and the flattened memory MLP stay as they are.
  - The pointer heads still point only at entity rows.
- **Opponent model:**
  - The new groups extend `opp`/`opp_in`, with zero rows and columns in surgery.
  - The new groups use focal loss (γ 2), as in ROA, because the labels are rare. The old groups
    keep cross-entropy.
- **Export:**
  - `export_onnx.py` exports v4, including attention with key-padding masks. The critic and values
    are not exported, as now.
  - A new `headless/src/v4/neural.ts` and `test_onnx_parity.py` cover v4: torch and onnxruntime
    logits must agree within 1e-4 on 50 recorded states.
  - `neuralBotPlayer.ts` learns `layout: "v4"`, but no v4 model is shipped in this plan.
- **Tests:** `test_model_v2.py` gets v4 shape tests, the null-token case with an empty enemy set,
  and a check that `load_weights` tolerates the new prefixes.

### S7. Trainer (items 1, 4, 6, 7, 9)

New `train.py` flags, all off by default so old runs reproduce:

- **`--value-warmup N`:** for the first N updates, only the value, critic and opponent-model losses
  are trained (policy loss 0). This is needed because the new critic starts untrained.
- **`--upgo-coef c` (item 6, UPGO):**
  - For each value head with its own γ, the return follows the AlphaStar definition:
    - G^U_t = r_t + γ·(G^U_{t+1} if r_{t+1} + γV_{t+2} ≥ V_{t+1}, else V_{t+1}).
  - A^U = G^U_t − V_t, normalised per head and mixed with the same head weights as the PPO
    advantage.
  - Loss: −c · min(ratio, 1).detach() · A^U · log π.
  - Test: a hand-computed 6-step trajectory.
- **`--switch-w w` (item 7, deliberation cost):**
  - The runner counts `shaped.switch`. An event is an order to an army group or the scout slot that
    replaces a *different* order (another order type, a target more than 300 px away, or another
    entity) given to the same group within the last 6 decisions (5 s).
  - The cost is applied to the own seat only (not zero-sum) and added to the shaped head.
  - Giving no order is free.
  - `--scout-lock 0|1`: the 50-tick commit lock becomes optional. It is off in R1, so the cost
    replaces it.
- **`--scout-reward roa --scout-w w --scout-anneal f` (item 4, scouting reward):**
  - H_t is the frozen reference model's opponent-model cross-entropy against the true labels, at
    each decision. The reference already runs during the rollout for the KL. The near-base groups
    count ×3.
  - Reward: r_t = max(0, min(H_{t−38..t−1}) − H_t), i.e. a new low against the last 30 s
    (38 decisions). This is ROA's "drop in cross-entropy over 30 s, never negative", computed
    online so it never crosses a rollout boundary.
  - Own seat only. It replaces `--intel-w`, which stays available but is off.
  - Test: a synthetic H sequence gives the expected rewards, and wobbles within 30 s give 0.
- **`--defence-teacher --defence-coef a --defence-coef-end b` (item 9):**
  - The runner gives a defence label for policy seats, using the scripted bots' own rules:
    - `scripted.ts` threat response: enemy combat units within `THREAT_RADIUS` 600 of the crystal
      give "largest army group not within 900 px of home: attack-move to `T_OWN_BASE`";
    - the `scout.ts` worker guard.
  - First a refactor: these rules are moved into pure functions that both the scripted bots and the
    runner call. Golden hashes must stay identical, which proves the scripted bots are unchanged.
  - The label applies only while the condition holds. It adds cross-entropy on the group, order and
    target heads, annealed from a to b. It is left out of the KL to the init, like the scout
    teacher.
- **Test:** `test_vec_env_v2.py` (v4) checks:
  - each new reward and label appears only when its flag is on;
  - the switch count on a scripted sequence;
  - defence labels on a fixed `flank` replay.

### S8. Surgery from b3 (decision 2)

`training/v4_surgery.py checkpoints/v2/b3-main/cycle_2.pt checkpoints/v4/surgery/b3c2_v4.pt --check`:

- Columns are copied by name from the TypeScript layouts.
- New inputs and branches are zero-initialised.
- The target-head rows are remapped: anchors 0–36 and memory 37–52 keep their indices, and the
  grid moves from 53 to 61. The new memory rows get a bias of −10, so they start almost never
  picked.
- The critic encoder is new, with fresh initialisation.
- **`--check`:** on 200 states from replayed games, the v4 policy logits (after the index remap)
  equal the v3 model's within 1e-5, and so does the opponent model on the old groups.

### S9. R1 runs

Everything below is one chain script, `logs/r1_chain.sh` in `/root/CrystalFront-train`. It uses
the same 24 bots as b3.

1. **r1-warm** (about 1 h):
   - `train.py --init surgery --decisions 300000 --value-warmup 1000` (policy frozen).
   - This trains the critic, the value heads and the new opponent-model groups on b3's own games.
   - This checkpoint becomes the **reference model** for the KL and the scouting reward.
2. **r1 league:**
   - `league.py --run r1 --init r1-warm --cycles 2 --main-decisions 4000000 --exploiter-decisions 2000000`.
   - Train args are b3's (`--kl-coef 1.0 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16`), plus:
     - `--value-warmup 10 --upgo-coef 0.5 --switch-w 0.002 --scout-lock 0`;
     - `--scout-teacher --scout-coef 0.5 --scout-coef-end 0.05`;
     - `--scout-reward roa --scout-w 0.5 --scout-anneal 0.5`;
     - `--defence-teacher --defence-coef 0.5 --defence-coef-end 0.05`.
   - b3 took about 27 h. With the critic I expect about 30–35 h.
3. **Evaluations:**
   - The pool over the 24 bots.
   - 64 games each against `backdoor`, `flank`, `hidden`, `swing` and `rush_post`.
   - Behaviour replays.
   - Head to head against b3, 64 games.
4. **Behaviour report:** `headless/src/behaviourReport.ts` is the scratchpad raid-recall and
   backdoor-trace tools, moved into the repo. It is replay-based and works for any layout. It
   measures:
   - raid recall (§1 of the review: 10/20/40 s);
   - builder intercepted, and outposts cleared before the first raid;
   - Outrider commit and the no-order and switch rates.

**R1 check (go/no-go for R2):**

- pool ≥ 0.92;
- raid recall median at 20 s ≥ 0.5 (b3: 0.00);
- `backdoor` ≥ 0.69 over 64 games (b3's figure on 16);
- no-order rate within 40–80%.

If recall stays near 0, I stop and diagnose before R2 and report back. Two checks come first:

- whether the new columns' weights grew from zero;
- whether the critic's value drops when outposts appear.

## 3. R2: curriculum and league

### S10. Scenario starts (item 5)

- **Runner:** slot config `scenario: { replay, tick, seat }` replaces today's throw.
  - It creates the match with the replay's seed and map.
  - Until `tick`, it applies the replay's command log for the policy seat. The opponent's scripted
    bot runs **live** from the same seed, and its commands must equal the log; otherwise the slot
    fails with an error.
  - Observations run through the fast-forward, so the memory slots are filled. The LSTM starts at
    zero.
  - Rewards count only after the handover. The win reward is as normal.
  - It works only with scripted opponents. The command log is engine-level, so v3 replays work too.
- **`training/v2/scenarios.py`** builds `scenarios/r2.json` from saved loss replays against
  `backdoor`, `flank`, `swing`, `hidden` and `rush_post` (b3's and r1's). It picks the handover
  tick 20–40 s before:
  - the first enemy building within 900 px of the crystal;
  - the builder crossing into my half;
  - the first raid (review §1 definition).

  A random tick from each loss is added too.
- **`train.py --scenarios file --scenario-frac 0.25`:** a quarter of the slots start from a
  scenario, sampled with PFSP weights by the scenario's opponent.
- **Tests:**
  - Fast-forwarding 20 replays to their end gives the replay's final state hash.
  - Determinism holds across runs.
  - A mismatched log fails loudly.

### S11. Strategy-forced exploiters (item 8)

- **Runner:** `shadow: "<bot>"` runs a dry-run copy of a scripted bot on the seat's own state. Its
  commands are captured, not applied, and turned into action labels by the existing imitation
  mapping.
- **League:** each cycle adds 3 forced exploiters after the main exploiter: `backdoor` (z 23),
  `flank` (z 27) and `hidden` (z 11).
  - Each starts from the current main's weights with a fixed z, as in ROA EIE, and gets 1 M
    decisions against the frozen main.
  - Shadow cross-entropy on all heads from its own bot, 1.0 → 0.3 (a floor, so it stays on plan).
  - A build-order pseudo-reward: +1/len for each step of the template's build list completed in
    order, as in AlphaStar's z reward.
  - They join the main's PFSP pool for the next cycle, next to the scripted bots.
- **Fidelity check** per exploiter (behaviour report, 32 games):
  - `backdoor`: a building within 900 px of the enemy crystal by 6 min in ≥ 80% of games;
  - `flank`: the army's first attack comes along a map edge;
  - `hidden`: no army seen by the opponent before the push.

  An exploiter that fails stays out of the pool, and the result is reported.

### S12. R2 runs

- `league.py --run r2 --init r1-main/cycle_2 --cycles 2`, with R1's args plus
  `--scenarios scenarios/r2.json --scenario-frac 0.25 --forced-exploiters backdoor,flank,hidden`.
- About 25 h per cycle, so about 50 h.
- The evaluations and behaviour report are as in S9, with r1 also as a baseline.

## 4. Gate (from the review)

- Pool ≥ 0.94.
- `backdoor` ≥ 0.85 and `flank` ≥ 0.85, over 64 games each.
- Builder killed or outposts cleared before the first raid in over half of the `backdoor` games.
- ≥ 0.5 against b3 head to head (64 games).
- Raid recall median at 20 s ≥ 0.6.

Results go in `docs/eval/` and a short results doc. Behaviour replays are prepared for you to
watch. Shipping and deploying are your call, as with b2 and b3.

## 5. Budget

| Stage | Wall time |
|---|---|
| S1–S8 code and tests | about 1–2 days of work, done before any long run |
| r1-warm | about 1 h |
| r1 league (2 cycles) | about 30–35 h |
| r1 evaluations and report | about 3 h |
| S10–S11 code (can overlap with the r1 run) | — |
| r2 league (2 cycles) | about 50 h |
| r2 evaluations and report | about 4 h |

## 6. Risks and fallbacks

- **Throughput.** The critic adds about 15 k floats per decision. It is stored as float16, and
  the critic encoder is small. If dec/s drops more than 30%, the critic entity rows are capped at
  100 (the priority order keeps the relevant ones).
- **New inputs left unused** (zero-init columns that stay near zero under the KL anchor). Checked
  after r1 cycle 1 by the weight norms of the new columns. Fallback: fresh imitation on v4 (b1
  style, about 3 M decisions, both seats teaching, with the defence teacher), then the r1 league
  from there.
- **Scouting reward farmed.** The reward is per-decision bounded and annealed to 0. I monitor the
  scout reward against win rate in the training log.
- **Switch cost makes it passive.** Small weight. The no-order rate is part of the R1 check.
- **Defence teacher pulls the army home too eagerly.** Same condition as the scripted bots, and
  annealed to 0.05. Pool and attack timing are in the report.
- **Scenario drift.** A slot whose opponent bot departs from its log fails loudly, and that
  replay is dropped from the scenario file.
- **Exploiters drift off plan.** The cross-entropy floor and the fidelity check deal with this.

## 7. Not changing

- The engine, game rules and golden hashes.
- The live service and the shipped v2/v3 models.
- The decision rate (8 ticks).
- The action heads, except the size of the target heads.
- PPO, the league structure and PFSP otherwise.
