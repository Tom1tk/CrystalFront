#!/bin/bash
# Rebuild R1 (docs/REBUILD_R1_PLAN.md S9, layout v4, 0.9.15-ML), from b3 cycle 2 after surgery (S8).
# 1. r1-warm: policy frozen, trains critic / value heads / new opponent-model groups on b3's own games;
#    it is the league's init and therefore the KL and ROA reference.
# 2. r1 league, b3's train args plus value warm-up, UPGO, switch cost, no scout lock, scout teacher,
#    ROA scouting reward, defence teacher.
# 3. Evaluations: pool, 64 games each vs backdoor/flank/hidden/swing/rush_post (r1 and b3), behaviour
#    replays, head to head vs b3 (the surgered copy: same play within 1e-5).
# R1 check (by hand): pool >= 0.92, raid recall median at 20 s >= 0.5, backdoor >= 0.69, no-order 40-80%.
set -e
cd "$(dirname "$0")/.."
export CF_LAYOUT=v4
BOTS=rush1,rush2,rush3,turtle,macro,heavy,hidden,sw_rush_turtle,sw_macro_bruiser,sw_fake_brush,sw_turtle_grab,swarm,swarm_mass,swarm_tide,phalanx,gunline,vanguard,rush_post,backdoor,siege,sw_read_macro,sw_read_turtle,flank,swing
HARD=backdoor,flank,hidden,swing,rush_post
B3=checkpoints/v4/surgery/b3c2_v4.pt
REWARD="--switch-w 0.002 --scout-lock 0 --scout-reward roa --scout-w 0.5 --scout-anneal 0.5 --intel-w 0"
WARM=checkpoints/v2/r1-warm/final.pt
if [ ! -f $WARM ]; then
  python3 -m training.v2.train --run r1-warm --init $B3 --pfsp --minutes 0 --opponents $BOTS --decisions 300000 \
    --value-warmup 1000 --minibatches 16 $REWARD > logs/r1-warm.log 2>&1
fi
echo "warm done"
python3 -m training.v2.league --run r1 --init $WARM --bots $BOTS --cycles 2 \
  --main-decisions 4000000 --exploiter-decisions 2000000 \
  --train-args "--kl-coef 1.0 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20 \
--value-warmup 10 --upgo-coef 0.5 $REWARD --scout-teacher --scout-coef 0.5 --scout-coef-end 0.05 \
--defence-teacher --defence-coef 0.5 --defence-coef-end 0.05" \
  --exploiter-args "--kl-coef 0.5 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20 --scout-lock 0" > logs/r1.log 2>&1
echo "league done"
R1=checkpoints/v2/r1-main/cycle_2.pt
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/r1-main/cycle_1.pt --opponents $BOTS --maps train --seeds 1 \
  --out docs/eval/r1-main-c1.json > logs/r1-main-c1-eval.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R1 --opponents $BOTS --maps train --seeds 1 \
  --out docs/eval/r1-main-c2.json > logs/r1-main-c2-eval.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R1 --opponents $HARD --maps train --seeds 4 --save-replays \
  --out docs/eval/r1-main-c2-hard64.json > logs/r1-c2-hard64.log 2>&1
python3 -m training.eval.evaluate --checkpoint $B3 --opponents $HARD --maps train --seeds 4 --save-replays \
  --out docs/eval/b3-v4-hard64.json > logs/b3-v4-hard64.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R1 --opponents rush1,rush3,macro,turtle,swarm,backdoor,vanguard,sw_read_turtle,flank,swing \
  --maps train --seeds 1 --save-replays --out docs/eval/r1-main-c2-behaviour.json > logs/r1-c2-behaviour.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R1 --opponents ckpt:$B3 --maps train --seeds 4 \
  --out docs/eval/r1-c2-vs-b3.json > logs/r1-c2-vs-b3.log 2>&1
echo "r1 done"
