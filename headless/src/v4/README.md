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
