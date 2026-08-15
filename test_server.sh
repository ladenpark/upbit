#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/bin:$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
echo "=== Testing Local HTTP API ==="
curl -s http://localhost:3000/api/health || echo "Curl failed"
echo ""
echo "=== PM2 Status ==="
pm2 status
echo ""
echo "=== PM2 Logs (Last 20 lines) ==="
pm2 logs upbit-bot --lines 20 --nostream
