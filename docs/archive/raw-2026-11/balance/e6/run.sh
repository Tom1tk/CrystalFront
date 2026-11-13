#!/bin/bash
S=/tmp/claude-0/-root/cce514e3-4fac-4a3c-aa23-35090cd21413/scratchpad
cd /tmp/claude-0/-root/cce514e3-4fac-4a3c-aa23-35090cd21413/scratchpad/e6wt
BOTS=v2:turtle,v2:sw_turtle_grab,v2:macro,v2:heavy,v2:rush3,v2:sw_rush_turtle,v2:sw_macro_bruiser
while IFS='|' read -r name lever; do
  [ -z "$name" ] && continue
  echo "$(date +%T) start $name" >> $S/e6/progress.txt
  LEVER="$lever" NODE_OPTIONS="--import $S/lever.mjs" \
    npx tsx headless/src/balance.ts --games 10 --bots $BOTS --maps all --maxTicks 12000 --jobs 18 --json $S/e6/$name.json > $S/e6/$name.txt 2> $S/e6/$name.err
  echo "$(date +%T) done $name exit $?" >> $S/e6/progress.txt
done <<'LIST'
e_base|
e_range120|BUILDING_DEFS.turret.range=120
LIST
echo ALLDONE >> $S/e6/progress.txt
