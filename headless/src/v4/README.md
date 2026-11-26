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
