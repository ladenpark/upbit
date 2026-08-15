import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import path from 'path';
import { ATREngine } from './strategy/atrEngine';
import { ApiKeys, BotParams } from './types/trading';
import { SecretManager } from './security/secretManager';
import { UpbitClient } from './exchanges/upbit';

const app = express();
app.use(express.json());

// Enable CORS for development frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const secretManager = SecretManager.getInstance();

// Instantiate ATR Strategy Engine
const engine = new ATREngine((state) => {
  broadcast({ type: 'STATE_UPDATE', payload: state });
});

// Broadcast state to all connected WebSocket clients
function broadcast(message: any) {
  const jsonStr = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // 1 = OPEN
      client.send(jsonStr);
    }
  });
}

// WebSocket Connection Handler
wss.on('connection', (ws: WebSocket) => {
  console.log('[Server WS] Client connected.');
  
  // Send initial full state immediately upon connection
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', payload: engine.getFullState() }));

  ws.on('message', async (message: RawData) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('[Server WS] Message received:', data.type);

      switch (data.type) {
        case 'UPDATE_CONFIG':
          engine.updateParams(data.payload as Partial<BotParams>);
          break;

        case 'TOGGLE_BOT':
          engine.updateParams({ isBotActive: Boolean(data.payload.isBotActive) });
          break;

        case 'SAVE_API_KEYS': {
          const keys = data.payload as ApiKeys;
          engine.setApiKeys(keys);
          ws.send(JSON.stringify({
            type: 'API_KEYS_STATUS',
            payload: { success: true, message: 'API keys securely saved.' }
          }));
          break;
        }

        case 'TEST_API_KEYS': {
          const { upbitAccessKey, upbitSecretKey } = data.payload;
          const currentKeys = secretManager.getKeys();
          const uAcc = (upbitAccessKey || currentKeys.upbitAccessKey || '').trim();
          const uSec = (upbitSecretKey || currentKeys.upbitSecretKey || '').trim();
          const client = new UpbitClient();
          const res = await client.getAccountBalance(uAcc, uSec);
          if (res.success && res.balances) {
            engine.realBalances = res.balances;
            engine.notifyClients();
          }
          ws.send(JSON.stringify({ type: 'TEST_API_KEYS_RESULT', payload: res }));
          break;
        }

        case 'MANUAL_TRADE': {
          const side = data.payload.side as 'BUY' | 'SELL';
          await engine.executeManualTrade(side);
          break;
        }

        default:
          console.warn('[Server WS] Unknown action:', data.type);
      }
    } catch (err: any) {
      console.error('[Server WS] Message handling error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[Server WS] Client disconnected.');
  });
});

// REST API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', serverTime: new Date().toISOString(), clients: wss.clients.size });
});

app.get('/api/state', (req, res) => {
  res.json(engine.getFullState());
});

app.post('/api/config', (req, res) => {
  engine.updateParams(req.body);
  res.json({ success: true, state: engine.getFullState() });
});

app.post('/api/keys', (req, res) => {
  engine.setApiKeys(req.body);
  res.json({ success: true, message: 'API keys updated securely.' });
});

app.post('/api/keys/test', async (req, res) => {
  const currentKeys = secretManager.getKeys();
  const client = new UpbitClient();
  const result = await client.getAccountBalance(
    currentKeys.upbitAccessKey || '',
    currentKeys.upbitSecretKey || ''
  );
  return res.json(result);
});

// Serve static files from Vite build (dist)
const distPath = path.resolve(process.cwd(), 'dist');
app.use(express.static(distPath));

// SPA fallback for non-API routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      next();
    }
  });
});

// Start Server
const PORT = Number(process.env.PORT) || 3005;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Upbit ATR Quantitative Bot Server Running!`);
  console.log(`🌐 HTTP Server: http://0.0.0.0:${PORT}`);
  console.log(`⚡ WebSocket Server: ws://0.0.0.0:${PORT}/ws`);
  console.log(`====================================================`);
});
