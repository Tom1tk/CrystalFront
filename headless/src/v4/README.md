# v4: rebuild R1/R2 layout (training)

A copy of `../v3` taken at v0.9.14-ML (docs/REBUILD_R1_PLAN.md, S1). Observation schema 8 and
action space 10: relational and unit-fact features, enemy memory for army clusters and lone units,
location-aware opponent labels and the full (unfogged) critic state. The scripted bots read
observation features by name, so they play exactly as in `../v3` (tests/v4.ts checks this).

`../v3` stays frozen while the live server's beta bots and models use it. Select this layout in
training with `CF_LAYOUT=v4`.

## Schema 8 additions (appended; the v3 columns are unchanged)

- **Entities (+11, 37 → 48):** effective weapon range and vision (as the engine checks them),
  speed, damage per second; distance to the own and the enemy crystal; nearest opposing entity the
  seat sees, in its range, opposing entities within my range; own-frame velocity since the last
  decision (0 in the critic, which is stateless).
- **Grid (+2 dynamic channels, 5 → 7):** `enemy_threat` and `own_coverage`, the damage per second
  that reaches into each cell from what the seat sees.
- **Globals (+10, 68 → 78):** enemy buildings within 900 px of the own crystal (also from memory),
  enemy combat units near it, enemy units in the own half, enemy workers seen outside their half in
  the last 60 s, time since the first near-base building and the raid timer (minutes, capped at 1),
  nearest enemy to the crystal, own combat units near it and the own army's share at home and in the
  enemy half.

## Memory v2 and action space 10 (S3)

- **Slots 24 × 18:** 0–15 as in v3; 16–18 enemy army clusters (greedy, order-independent: combat
  units within 500 px of a seed, at least 3, the 3 largest), 19–23 lone enemy units (workers,
  Outriders, combat units outside a cluster) last seen outside their own half. Cluster and lone
  slots clear after 120 s, once their last position is in sight and empty, or (lone) when the unit
  is seen back in its own half. New columns: heading x/y (own frame) and the lone flag.
- **Targets:** memory 37..60, grid 61..810, none 811 (812 in all). Teacher labels therefore differ
  from v3's by +8 for grid targets; tests/v4.ts compares them in v3 numbering.

## Opponent-model labels (S4, training only)

`oppLabels` adds the true `nearBuildings` and `nearCombat` (enemy buildings in any state and
combat units within 900 px of the own crystal), `workersOut` (enemy workers outside their own half)
and `nearAnchor` (the anchor nearest the near-base building closest to the crystal, or 37 = none).

## Full critic state (S5, training only)

With `critic` on, each seat's message carries the unfogged state from `criticState()`. In packed mode
`packCritic` sends `{n, f}`, where `f` is float32 holding both seats' globals (own first), then the
seat's own nodes (20 × 13), dynamic grid (7 × 15 × 50) and `n` entity rows (× 48, the observation's
row priority). Python stacks it as `critic` (globals) plus `c_nodes`, `c_grid` (with the static
channels) and `c_ent`/`c_ent_n`, and the rollout stores `c_grid`/`c_ent` as float16.

Env-only cost (16 policy-vs-policy slots, 4 processes, no-op actions): 1135 → 854 decisions/s with
the critic on, against 1290 → 1180 for v3's globals-only critic.

## Network and export (S6)

`training/v2/model.py` with `CF_LAYOUT=v4` adds an attention pool to the trunk: 4 learned queries
over the entity embeddings and the 24 memory tokens (Linear 18 → 128 plus a slot embedding), and 2
more over enemy rows and filled memory slots only, with an always-valid null token. Its 256 outputs
are new core inputs whose `core[0]` columns start at zero. The opponent model adds the near-base and
workers-out bins and the near-base anchor (focal loss, γ 2); `nOpp` becomes 166. The critic adds the
unfogged entities (1 transformer layer, 64-d, 2-query pool), the grid (2-conv CNN) and the nodes next
to the true globals. It is training only and never exported.

`export_onnx.py` exports v4 with the same two graphs and input names (meta `layout: "v4"`, schema 8,
action space 10). `neural.ts` here feeds 24 memory rows and 12 grid channels. Parity (random v4
weights with the pool, memory and opponent feedback switched on, 4 games, 600 decisions):
worst head log-prob |Δ| 7.2e-7. The server's `neuralBotPlayer.ts` accepts a v4 model in `models/beta`,
but none is shipped.

## Trainer hooks (S7)

All off by default, so old runs reproduce. In the runner (`reset_all`):

- `defence_teacher`: each policy seat's message carries `defenceTeacher`, from `defence.ts`, which
  reuses the scripted bots' own rules. It is `[group, order, unit, target]` or null:
  - **Recall:** an enemy combat unit within 600 px of the own crystal (`crystalThreat`, scripted.ts),
    and the largest of all_combat / army_a / army_b more than 900 px from home. That group
    attack-moves to the own base.
  - **Guard:** otherwise, an enemy Outrider at the own workers (`workerRaider`, scout.ts). One combat
    unit guards that spot (`guardOrder`, the scout teacher's worker guard).
  - Only legal labels are sent. Scripted play does not change; golden hashes and the v3 equivalence
    games still match.
- `switch_cost`: `rewards[side].shaped.switch` counts this decision's order switches
  (`countSwitches`). A switch is a new order, or a point target more than 300 px from the last one,
  to the same group, unit or the scout slot within 6 decisions.
- `scout_lock` (default on): with it off, the scout slot's 50-tick commitment is gone and every order
  stays open.

In `training/v2/train.py`:

| Flag | What it does |
|---|---|
| `--value-warmup N` | For the first N updates of each run, only parameters under `value.`, `critic.`, `c_*` and `opp.` move. pg, entropy, KL, UPGO and the teacher losses are off. |
| `--upgo-coef` | UPGO policy loss (r1.py `upgo_returns`, per value head, normalised and mixed like the PPO advantage). |
| `--switch-w` | Cost per switch on the shaped head. |
| `--scout-reward roa --scout-w --scout-anneal` | Reward on the shaped head for new lows of the frozen reference's opponent-model cross-entropy H, over the last 38 decisions (~30 s). H is `Agent.opp_ce` with the near-base groups weighted 3×. Needs `--init`. |
| `--defence-teacher --defence-coef --defence-coef-end` | CE on the label's group, order, unit and target heads where a label applies. The army heads are left out of the KL there. |

Tests: `tests/v4.ts` (S7 block) and `training/test_r1.py` (UPGO by hand, ROA, `opp_ce`). The R1 flag
test in `test_vec_env_v2.py` runs on v4.

## Surgery from b3 (S8)

`training/v4_surgery.py <v3.pt> <v4.pt> --check` maps a v3 checkpoint onto this layout. Input columns are copied
by name from the TypeScript layouts, and new inputs and branches (attention pool, critic encoder, the opponent
model's new groups) come in through zero columns. The point-target rows for grid and `none` move from 53 to 61.
The new memory rows 53..60 get bias −10. `--check` replays 200 states from scripted games in a v3 process and in
this one. Every head, the LSTM state and the old opponent-model groups must match within 1e-5. For b3 cycle 2 the
largest difference is 3.8e-6.

## Scenario starts (S10)

A slot's `scenario: { replay, tick, seat }` starts its episodes at `tick` of a saved replay instead of the
opening. The runner rebuilds the match from the replay's seed. Until the handover, `seat` plays its recorded
actions and the other seat (a scripted bot) plays live. Any of these is an error, never a silent drift:
- a bot's choice is not the recorded one;
- the engine command log before the handover differs from the replay's;
- the engine version, action space, k, cap, map, seats or z differ from the slot's;
- `tick` is not a recorded decision.

Rewards start at the handover. A saved replay holds the whole game, fast-forward included. The observation
memory, teachers and switch log are built during the fast-forward, so the first decision equals the original
game's.

A fast-forward runs at about 3 ms a tick. When a scenario is configured for a slot's next episode, a second
slot plays it in the background, one decision per step of the current episode, and `start()` takes it over.
A scenario set by `reset_all` fast-forwards at once.

- `headless/src/v4/scenarioEvents.ts` finds, from one seat's view, the first enemy building within 900 px of
  its crystal, the first enemy worker in its half after 30 s, and the first raid (≥ 3 enemy combat units within
  700 px).
- `training/v2/scenarios.py <evals…> --replays DIR --out checkpoints/v4/scenarios/r2` takes each loss
  against the hard opponents that has a saved replay and gives it two scenarios:
  - one 20–40 s before the first event;
  - one at a uniform decision between 30 s and 20 s before the end.

  It copies the replays next to `index.json`. The index lives under `checkpoints/` so the training worktree
  shares it.
- `train.py --scenarios <index.json> --scenario-frac 0.25`: that share of episodes picks the opponent by its
  PFSP weight, then one of its scenarios uniformly. Results are logged as `win_rate/scenario_<opp>` and kept out
  of the PFSP win rates. The printed `win` still includes them.

Tests: `tests/v4.ts` (scenario block) checks:
- replays fast-forwarded to their last decision end in the original final hash;
- a mid-game handover gives the original's observations, masks, teacher labels and rewards;
- the background fast-forward equals a direct start;
- each mismatch fails.

## Forced exploiters (S11)

A strategy-forced exploiter is pushed to play one scripted bot's plan, so the main agent keeps meeting
that plan played by a network.

- **Runner.** Slot field `shadow: { <side>: "<bot>" }` runs that scripted bot on a policy seat, without
  applying its actions. Its z is the seat's configured z, which picks the template.
  - Each decision, the seat's message carries `shadowTeacher`: the wire action the bot chooses from the seat's
    own obs and masks, or null when that action is not legal there.
  - Each window, `rewards[side].shaped.build` adds +1/len for each step of the bot's build list finished in
    order. A step is finished when that many of its building stand complete.
  - Deviation: `ScriptedV2Bot.buildOrder()` adds a forward-outpost template's outposts as one step, before the
    first step that waits for an army (this is where the bot builds them).
  - A shadow must be on a policy seat and needs a template for the seat's z. It cannot be combined with a
    scenario start.
- **Training.** `train.py --shadow-bot <bot> --fixed-z <z>` gives the learner's seat that z and that shadow,
  whichever side it draws.
  - `--shadow-coef 1.0 → --shadow-coef-end 0.3` sets a cross-entropy on the bot's econ and army heads (scout
    slot excluded) wherever its label is legal. The mask rows come from a second policy pass over the label.
  - `--build-w` adds `shaped.build` to the shaped head.
  - The KL is off (`--kl-coef 0`): the shadow cross-entropy takes its place.
  - `fixed_z` is saved in the checkpoint config. A checkpoint opponent, in training (`Slots`) and in
    `training/eval/evaluate.py`, plays its own `fixed_z`. `evaluate.py --z auto` gives the evaluated seat
    its checkpoint's `fixed_z`.
- **Fidelity.** `headless/src/v4/fidelity.ts <eval.json> --strategy backdoor|flank [--seat policy|opponent]`
  replays an evaluation's saved games and checks the plan (`PASS_RATE` 0.6 of the scored games):
  - backdoor: an own building within 900 px of the enemy crystal by 6:00;
  - flank: before the first attack (≥ 3 combat units within 700 px of the enemy crystal), the army in the
    enemy half (≥ 3 units) was at some point, on average, ≥ 0.25 of the map height off the line between the
    crystals. Only scored on `FLANK_MAPS` (hollow-crown, cinder-flats, ironreed, saltmarsh, glimmerfen):
    on twin-spires, basalt-run and shardfall every bot's lane already runs round the side.
  - Calibration on the scripted bots (the table is in the `fidelity.ts` header): backdoor z23 0.75 on
    backdoor, flank z27 0.7–1.0 on flank; every other bot (and each on the other check) 0–0.1.
  - No hidden check. The hidden bot (z11) stages beside brush, not in it. Neither brush time nor time unseen
    separates it from the other bots, so nothing could be calibrated, and a hidden exploiter could never
    pass the gate.
- **League.** `league.py --forced-exploiters backdoor:23,flank:27` adds a step to each cycle, after
  the main exploiter. For each entry, it:
  - trains `<run>-f<k>-<bot>` from the main's `cycle_k` snapshot against it for `--forced-decisions` (1M);
  - evaluates it on the train maps with saved replays;
  - runs fidelity. Only an exploiter that passes joins the main's pool for the next cycle.

  The league record keeps every result under `forced`.

Tests: `tests/v4.ts` (shadow block) checks that playing the labels completes the build list, that the
labels are legal, and the error cases. `training/test_r1.py` checks the slot draws and `ckpt_z`.
