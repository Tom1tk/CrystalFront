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
