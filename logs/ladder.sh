#!/bin/bash
# M4 difficulty ladder: head-to-head games between lg2 snapshots for Elo placement.
cd /root/CrystalFront
M=checkpoints/v2/lg2-main; I=checkpoints/v2/m4-imitate/final.pt
ev() { python3 -m training.eval.evaluate --checkpoint "$1" --opponents "$2" --maps train --seeds 2 --out "docs/eval/ladder-$3.json"; }
ev $M/cycle_3.pt ckpt:$I,ckpt:$M/update_40.pt,ckpt:$M/update_100.pt,ckpt:$M/cycle_1.pt,ckpt:$M/cycle_2.pt c3
ev $M/cycle_1.pt ckpt:$I,ckpt:$M/update_40.pt,ckpt:$M/update_100.pt c1
ev $M/update_100.pt ckpt:$I,ckpt:$M/update_40.pt u100
ev $M/update_40.pt ckpt:$I u40
echo ladder done
