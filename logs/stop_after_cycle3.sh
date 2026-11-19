#!/bin/bash
# Stop league lg2 once cycle 3's exploitability check is written (agreed 2026-11-19: skip cycle 4).
cd /root/CrystalFront
until grep -q "^cycle 3:" logs/lg2.log; do sleep 30; done
sleep 90   # let cycle 4's trainer spawn its workers so the whole tree is visible
L=95753
tree() { local p; for p in $(pgrep -P $1); do echo $p; tree $p; done; }
pids="$L $(tree $L)"
echo "killing: $pids"
kill $pids 2>/dev/null
sleep 15
kill -9 $pids 2>/dev/null
echo "stopped league after cycle 3 at $(date -u)" >> logs/lg2.log
