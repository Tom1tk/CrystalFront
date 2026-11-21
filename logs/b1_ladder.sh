#!/bin/bash
# Beta difficulty ladder and behaviour sample for the b1 round (mainline 0.10 step 5).
cd "$(dirname "$0")/.."
export CF_LAYOUT=v3
while kill -0 463400 2>/dev/null; do sleep 20; done
C1=checkpoints/v2/b1-main/cycle_1.pt C2=checkpoints/v2/b1-main/cycle_2.pt IM=checkpoints/v2/b1-imitate/final.pt
E="python3 -m training.eval.evaluate --maps train --seeds 2"
$E --checkpoint $C2 --opponents ckpt:$IM,ckpt:$C1 --out docs/eval/ladder-b1-c2.json > logs/ladder-b1-c2.log 2>&1
$E --checkpoint $C1 --opponents ckpt:$IM --out docs/eval/ladder-b1-c1.json > logs/ladder-b1-c1.log 2>&1
python3 -m training.eval.evaluate --checkpoint $C2 --opponents rush1,macro,turtle,swarm,backdoor,siege,sw_read_macro,sw_read_turtle --maps heldout --seeds 2 --out docs/eval/b1-main-c2-heldout.json > logs/b1-c2-heldout.log 2>&1
python3 -m training.eval.evaluate --checkpoint $C2 --opponents rush1,rush3,macro,turtle,swarm,backdoor,vanguard,sw_read_turtle --maps train --seeds 1 --save-replays --out docs/eval/b1-main-c2-behaviour.json > logs/b1-c2-behaviour.log 2>&1
echo ladder done
