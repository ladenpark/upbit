#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/bin:$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"
cd /home/pik0915/myproject/upbit
mkdir -p logs
pm2 delete upbit-bot 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 list
