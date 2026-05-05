#!/bin/bash
# CrystalFront RTS — one-command deploy
# Usage: ./deploy.sh
set -e
export PATH="/root/.local/bin:$PATH"

echo "=== 1/4  Build ==="
cd /root/CrystalFront
npm run build

echo "=== 2/4  Test ==="
npm run test

echo "=== 3/4  Restart ==="
systemctl restart crystalfront-rts
sleep 1

echo "=== 4/4  Verify ==="
systemctl is-active crystalfront-rts
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3777/
grep -o 'index-[^"]*\.js' client/dist/index.html

echo ""
echo "✅ Deploy complete — CrystalFront RTS is live on port 3777"
