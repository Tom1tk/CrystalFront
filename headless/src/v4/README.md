# v4: rebuild R1/R2 layout (training)

A copy of `../v3` taken at v0.9.14-ML (docs/REBUILD_R1_PLAN.md, S1). Observation schema 8 and
action space 10: relational and unit-fact features, enemy memory for army clusters and lone units,
location-aware opponent labels and the full (unfogged) critic state. The scripted bots read
observation features by name, so they play exactly as in `../v3` (tests/v4.ts checks this).

`../v3` stays frozen while the live server's beta bots and models use it. Select this layout in
training with `CF_LAYOUT=v4`.
