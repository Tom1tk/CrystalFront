#!/bin/bash
# CrystalFront RTS — one-command deploy
# Usage: ./deploy.sh
set -e
export PATH="/root/.local/bin:$PATH"

echo "=== 1/3  Build (shared + client) ==="
cd /root/CrystalFront
npm run build:shared
npm run build:client

echo "=== 2/3  Test ==="
npm run test

echo "=== 3/3  Restart + Verify ==="
systemctl restart crystalfront-rts
sleep 2

systemctl is-active crystalfront-rts
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3777/
grep -o 'index-[^"]*\.js' client/dist/index.html

echo ""
echo "✅ Deploy complete — CrystalFront RTS is live on port 3777"
