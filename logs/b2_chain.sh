#!/bin/bash
# b2 round (beta, v3 layout): teach Hard (b1-main cycle_2) to use the Outrider. Same 2-cycle league
# as b1, with scout distillation on the main agent: a frozen b1-imitate (which learned the Outrider
# from the scripted bots) acts on the same states; where it picks the scout group, the main agent
# gets cross-entropy on its army action. Restarted 2026-11-22 with the flank and swing bots (armies that come
# round the side) after Hard was seen clumping its turrets on the central route.
# Gate (by hand): pool score >= 0.93, the Outrider used, flank/swing beaten, turrets not all on the central route.
set -e
cd "$(dirname "$0")/.."
export CF_LAYOUT=v3
BOTS=rush1,rush2,rush3,turtle,macro,heavy,hidden,sw_rush_turtle,sw_macro_bruiser,sw_fake_brush,sw_turtle_grab,swarm,swarm_mass,swarm_tide,phalanx,gunline,vanguard,rush_post,backdoor,siege,sw_read_macro,sw_read_turtle,flank,swing
INIT=checkpoints/v2/b1-main/cycle_2.pt
TEACH=checkpoints/v2/b1-imitate/final.pt
python3 -m training.v2.league --run b2 --init $INIT --bots $BOTS --cycles 2 \
  --main-decisions 4000000 --exploiter-decisions 2000000 \
  --train-args "--kl-coef 1.0 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20 --scout-teacher $TEACH --scout-coef 1.0" > logs/b2.log 2>&1
echo "league done"
for c in 1 2; do
  python3 -m training.eval.evaluate --checkpoint checkpoints/v2/b2-main/cycle_$c.pt --opponents $BOTS --maps train --seeds 1 \
    --out docs/eval/b2-main-c$c.json > logs/b2-main-c$c-eval.log 2>&1
done
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/b2-main/cycle_2.pt --opponents rush1,rush3,macro,turtle,swarm,backdoor,vanguard,sw_read_turtle,flank,swing \
  --maps train --seeds 1 --save-replays --out docs/eval/b2-main-c2-behaviour.json > logs/b2-c2-behaviour.log 2>&1
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/b2-main/cycle_2.pt --opponents ckpt:$INIT --maps train --seeds 2 \
  --out docs/eval/b2-c2-vs-b1-c2.json > logs/b2-c2-vs-b1.log 2>&1
echo "b2 done"
