#!/bin/bash
# b3 round (beta, v3 layout, 0.9.14-ML): teach Hard to scout with the Outrider's own order slot.
# From b2-main cycle_2. The main agent gets the scout slot (an order for the Outrider every decision,
# with a 50-tick commit lock), cross-entropy on the scripted OutriderPlan's slot order (careful;
# 1.0 → 0.1 over the budget, left out of the KL to the init), and a one-off first-sighting reward
# (shaped.intel, weight 1 → 0 over the first half). Same bots and 2-cycle league as b2.
# Gate (by hand): pool score >= b2's, flank/backdoor better than b2, the Outrider commits (scoutmove.py),
# b3 >= 0.5 against b2.
set -e
cd "$(dirname "$0")/.."
export CF_LAYOUT=v3
BOTS=rush1,rush2,rush3,turtle,macro,heavy,hidden,sw_rush_turtle,sw_macro_bruiser,sw_fake_brush,sw_turtle_grab,swarm,swarm_mass,swarm_tide,phalanx,gunline,vanguard,rush_post,backdoor,siege,sw_read_macro,sw_read_turtle,flank,swing
INIT=checkpoints/v2/b2-main/cycle_2.pt
python3 -m training.v2.league --run b3 --init $INIT --bots $BOTS --cycles 2 \
  --main-decisions 4000000 --exploiter-decisions 2000000 \
  --train-args "--kl-coef 1.0 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20 --scout-teacher --scout-coef 1.0 --scout-coef-end 0.1 --intel-w 1.0 --intel-anneal 0.5" > logs/b3.log 2>&1
echo "league done"
for c in 1 2; do
  python3 -m training.eval.evaluate --checkpoint checkpoints/v2/b3-main/cycle_$c.pt --opponents $BOTS --maps train --seeds 1 \
    --out docs/eval/b3-main-c$c.json > logs/b3-main-c$c-eval.log 2>&1
done
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/b3-main/cycle_2.pt --opponents rush1,rush3,macro,turtle,swarm,backdoor,vanguard,sw_read_turtle,flank,swing \
  --maps train --seeds 1 --save-replays --out docs/eval/b3-main-c2-behaviour.json > logs/b3-c2-behaviour.log 2>&1
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/b3-main/cycle_2.pt --opponents ckpt:$INIT --maps train --seeds 2 \
  --out docs/eval/b3-c2-vs-b2-c2.json > logs/b3-c2-vs-b2.log 2>&1
echo "b3 done"
