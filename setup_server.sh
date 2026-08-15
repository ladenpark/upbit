#!/usr/bin/env bash
set -e

echo "=== [1/4] Installing Node.js via NVM ==="
export NVM_DIR="$HOME/.nvm"
if [ ! -d "$NVM_DIR" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi

[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm install 22
nvm alias default 22
nvm use 22

echo "Node Version: $(node -v)"
echo "NPM Version: $(npm -v)"

echo "=== [2/4] Installing project dependencies ==="
cd /home/pik0915/myproject/upbit
npm install

echo "=== [3/4] Installing PM2 and Cloudflared ==="
npm install -g pm2 tsx

# Check if cloudflared binary is installed
if ! command -v cloudflared &> /dev/null; then
  echo "Downloading cloudflared..."
  mkdir -p "$HOME/bin"
  curl -L --output "$HOME/bin/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$HOME/bin/cloudflared"
  export PATH="$HOME/bin:$PATH"
fi

echo "Cloudflared version: $(cloudflared --version || echo 'Installed in ~/bin')"

echo "=== [4/4] Building Vite Frontend ==="
npm run build

echo "=== All steps completed successfully ==="
