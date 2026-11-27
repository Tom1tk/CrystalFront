#!/bin/bash
# Rebuild R2 (docs/REBUILD_R1_PLAN.md S12, layout v4, 0.9.16-ML), from r1-main cycle 2.
# Run in the training worktree after logs/r1_chain.sh has finished and the worktree is at origin/main.
# 1. Scenario starts (S10) from the r1 and b3 losses in the r1 hard64 evaluations' replays.
# 2. r2 league: R1's args plus --scenarios (main agent only) and the strategy-forced exploiters (S11:
#    backdoor and flank; there is no hidden fidelity check, see headless/src/v4/fidelity.ts).
# 3. Evaluations as in S9, with r1 as a baseline too.
# Gate (by hand): pool >= 0.94; backdoor and flank >= 0.85 over 64 games; builder killed or outposts
# cleared before the first raid in over half the backdoor games; >= 0.5 vs b3; raid recall median >= 0.6.
set -e
cd "$(dirname "$0")/.."
export CF_LAYOUT=v4
BOTS=rush1,rush2,rush3,turtle,macro,heavy,hidden,sw_rush_turtle,sw_macro_bruiser,sw_fake_brush,sw_turtle_grab,swarm,swarm_mass,swarm_tide,phalanx,gunline,vanguard,rush_post,backdoor,siege,sw_read_macro,sw_read_turtle,flank,swing
HARD=backdoor,flank,hidden,swing,rush_post
B3=checkpoints/v4/surgery/b3c2_v4.pt
R1=checkpoints/v2/r1-main/cycle_2.pt
SCEN=checkpoints/v4/scenarios/r2
REWARD="--switch-w 0.002 --scout-lock 0 --scout-reward roa --scout-w 0.5 --scout-anneal 0.5 --intel-w 0"
if [ ! -f $SCEN/index.json ]; then
  python3 training/v2/scenarios.py docs/eval/r1-main-c2-hard64.json docs/eval/b3-v4-hard64.json \
    --replays replays --out $SCEN > logs/r2-scenarios.log 2>&1
fi
echo "scenarios done"
python3 -m training.v2.league --run r2 --init $R1 --bots $BOTS --cycles 2 \
  --main-decisions 4000000 --exploiter-decisions 2000000 \
  --train-args "--kl-coef 1.0 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20 \
--value-warmup 10 --upgo-coef 0.5 $REWARD --scout-teacher --scout-coef 0.5 --scout-coef-end 0.05 \
--defence-teacher --defence-coef 0.5 --defence-coef-end 0.05 --scenarios $SCEN/index.json --scenario-frac 0.25" \
  --exploiter-args "--kl-coef 0.5 --kl-anneal 0.25 --ent 0.003 --ent-end 0.001 --minibatches 16 --checkpoint-every 20 --scout-lock 0" \
  --forced-exploiters backdoor:23,flank:27 > logs/r2.log 2>&1
echo "league done"
R2=checkpoints/v2/r2-main/cycle_2.pt
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/r2-main/cycle_1.pt --opponents $BOTS --maps train --seeds 1 \
  --out docs/eval/r2-main-c1.json > logs/r2-main-c1-eval.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R2 --opponents $BOTS --maps train --seeds 1 \
  --out docs/eval/r2-main-c2.json > logs/r2-main-c2-eval.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R2 --opponents $HARD --maps train --seeds 4 --save-replays \
  --out docs/eval/r2-main-c2-hard64.json > logs/r2-c2-hard64.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R2 --opponents rush1,rush3,macro,turtle,swarm,backdoor,vanguard,sw_read_turtle,flank,swing \
  --maps train --seeds 1 --save-replays --out docs/eval/r2-main-c2-behaviour.json > logs/r2-c2-behaviour.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R2 --opponents ckpt:$B3 --maps train --seeds 4 \
  --out docs/eval/r2-c2-vs-b3.json > logs/r2-c2-vs-b3.log 2>&1
python3 -m training.eval.evaluate --checkpoint $R2 --opponents ckpt:$R1 --maps train --seeds 4 \
  --out docs/eval/r2-c2-vs-r1.json > logs/r2-c2-vs-r1.log 2>&1
echo "r2 done"
