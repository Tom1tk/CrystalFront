#!/bin/bash
# T10 lever sweep: name|LEVER|CF_TARGETING
S=/tmp/claude-0/-root/cce514e3-4fac-4a3c-aa23-35090cd21413/scratchpad
cd /root/CrystalFront
BOTS=v2:turtle,v2:sw_turtle_grab,v2:macro,v2:heavy,v2:rush3,v2:sw_rush_turtle,v2:sw_macro_bruiser
while IFS='|' read -r name lever targ; do
  [ -z "$name" ] && continue
  echo "$(date +%T) start $name" >> $S/sweep/progress.txt
  LEVER="$lever" CF_TARGETING="$targ" NODE_OPTIONS="--import $S/lever.mjs" \
    npx tsx headless/src/balance.ts --games 10 --bots $BOTS --maps all --maxTicks 12000 --jobs 18 --json $S/sweep/$name.json > $S/sweep/$name.txt 2> $S/sweep/$name.err
  echo "$(date +%T) done $name exit $?" >> $S/sweep/progress.txt
done <<'LIST'
base||
range120|BUILDING_DEFS.turret.range=120|
cost100|BUILDING_DEFS.turret.cost=100|
prejune|BUILDING_DEFS.turret.cost=60;BUILDING_DEFS.turret.health=400;BUILDING_DEFS.turret.attackCooldown=12|
hold400|CONTROL.holdTicks=400|
tgt_threat||threat
tgt_units||units
LIST
echo ALLDONE >> $S/sweep/progress.txt
