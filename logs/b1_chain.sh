#!/bin/bash
# Mainline 0.10 bot round (beta, v3 layout): surgery model (0.9 Hard, lg2 cycle_3) -> short imitation
# top-up on the v3 scripted bots (Outrider, Surge-aware pushes) -> gate against the surgery
# baseline -> league b1 (2 cycles). If the top-up loses more than 0.05 of the baseline score, the
# league starts from the surgery model instead (imitating weaker teachers must not undo PPO).
set -e
cd /root/CrystalFront
export CF_LAYOUT=v3
BOTS=rush1,rush2,rush3,turtle,macro,heavy,hidden,sw_rush_turtle,sw_macro_bruiser,sw_fake_brush,sw_turtle_grab,swarm,swarm_mass,swarm_tide,phalanx,gunline,vanguard,rush_post,backdoor,siege,sw_read_macro,sw_read_turtle
SURG=checkpoints/v3/surgery/cycle_3_v3.pt
score() { python3 -c "import json;g=json.load(open('$1'))['games'];print(sum((x['result']=='win')+0.5*(x['result']=='draw') for x in g)/len(g))"; }

[ -f docs/eval/b0-surgery-c3.json ] || python3 -m training.eval.evaluate --checkpoint $SURG --opponents $BOTS --maps train --seeds 1 \
  --out docs/eval/b0-surgery-c3.json > logs/b0-surgery-eval.log 2>&1
BASE=$(score docs/eval/b0-surgery-c3.json)
echo "surgery baseline $BASE"

[ -f checkpoints/v2/b1-imitate/final.pt ] || python3 -m training.v2.train --run b1-imitate --init $SURG --imitate --opponents $BOTS \
  --decisions 500000 --minutes 0 --lr 3e-5 --lr-end 1e-5 --minibatches 16 --checkpoint-every 20 > logs/b1-imitate.log 2>&1
[ -f docs/eval/b1-imitate.json ] || python3 -m training.eval.evaluate --checkpoint checkpoints/v2/b1-imitate/final.pt --opponents $BOTS \
  --maps train --seeds 1 --out docs/eval/b1-imitate.json > logs/b1-imitate-eval.log 2>&1
TOP=$(score docs/eval/b1-imitate.json)
echo "imitation top-up $TOP"
INIT=checkpoints/v2/b1-imitate/final.pt
python3 -c "import sys;sys.exit(0 if $TOP>=$BASE-0.05 else 1)" || { echo "top-up regressed: league starts from the surgery model"; INIT=$SURG; }
echo "league init $INIT"

python3 -m training.v2.league --run b1 --init $INIT --bots $BOTS --cycles 2 \
  --main-decisions 4000000 --exploiter-decisions 2000000 > logs/b1.log 2>&1
echo "league done"
