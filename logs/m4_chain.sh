#!/bin/bash
# m4-imitate (new rules) -> 0.40 gate -> league lg2. Stops if the gate fails.
set -e
cd /root/CrystalFront
BOTS=rush1,rush2,rush3,turtle,macro,heavy,hidden,sw_rush_turtle,sw_macro_bruiser,sw_fake_brush,sw_turtle_grab,swarm,swarm_mass,swarm_tide,phalanx,gunline,outrider,rush_post,backdoor,siege
python3 -m training.v2.train --run m4-imitate --init checkpoints/v2/m3-imitate/final.pt --imitate --opponents $BOTS \
  --decisions 3000000 --minutes 0 --lr 1e-4 --lr-end 1e-5 --minibatches 16 --checkpoint-every 20 > logs/m4-imitate.log 2>&1
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/m4-imitate/final.pt --opponents $BOTS --maps train --seeds 3 \
  --out docs/eval/m4-imitate.json > logs/m4-imitate-eval.log 2>&1
WIN=$(python3 -c "import json;g=json.load(open('docs/eval/m4-imitate.json'))['games'];print(sum(x['result']=='win' for x in g)/len(g))")
echo "gate win $WIN"
python3 -c "import sys;sys.exit(0 if $WIN>=0.40 else 1)" || { echo "GATE FAIL"; exit 1; }
python3 -m training.v2.league --run lg2 --init checkpoints/v2/m4-imitate/final.pt --bots $BOTS > logs/lg2.log 2>&1
echo "league done"
