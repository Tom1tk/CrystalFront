#!/bin/bash
cd /root/CrystalFront
for k in 3 1 2; do
python3 -m training.eval.evaluate --checkpoint checkpoints/v2/lg2-main/cycle_$k.pt --opponents rush1,rush2,rush3,turtle,macro,heavy,hidden,sw_rush_turtle,sw_macro_bruiser,sw_fake_brush,sw_turtle_grab,swarm,swarm_mass,swarm_tide,phalanx,gunline,outrider,rush_post,backdoor,siege --maps train --seeds 3 --save-replays --out docs/eval/lg2-cycle$k.json > logs/lg2-cycle$k-eval.log 2>&1
done
