#!/bin/bash
# ==============================================================================
# 🚀 Upbit ATR Trading Bot - One-Click Launcher & Service Manager
# ==============================================================================

# Ensure Node and PM2 PATH is available
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -n 1)/bin:$PATH"

PROJECT_DIR="/home/pik0915/myproject/upbit"
cd "$PROJECT_DIR" || exit 1

case "$1" in
  start)
    echo "▶️ [Upbit Bot] Starting Production Services..."
    npm run build
    pm2 start ecosystem.config.cjs || pm2 start dist/server/index.js --name "upbit-bot"
    pm2 save
    echo "✅ [Upbit Bot] Online! URL: https://upbit.ikdevlab.com"
    ;;
  stop)
    echo "⏹️ [Upbit Bot] Stopping Services..."
    pm2 stop upbit-bot
    echo "⏸️ [Upbit Bot] Stopped."
    ;;
  restart)
    echo "🔄 [Upbit Bot] Rebuilding and Restarting..."
    npm run build
    pm2 restart upbit-bot
    echo "✅ [Upbit Bot] Restarted successfully!"
    ;;
  status)
    pm2 status
    ;;
  logs)
    pm2 logs upbit-bot --lines 50
    ;;
  *)
    echo "======================================================"
    echo " 🤖 UPBIT ATR BOT CONTROLLER"
    echo "======================================================"
    echo " Usage:"
    echo "   ./run.sh start    : Build & Start 24/7 background service"
    echo "   ./run.sh stop     : Stop the trading bot"
    echo "   ./run.sh restart  : Rebuild & Restart bot"
    echo "   ./run.sh status   : Check running status"
    echo "   ./run.sh logs     : View real-time trading logs"
    echo "======================================================"
    pm2 status
    ;;
esac
