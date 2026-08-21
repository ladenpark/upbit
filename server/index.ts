import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import path from 'path';
import { ATREngine } from './strategy/atrEngine';
import { ApiKeys, BotParams } from './types/trading';
import { SecretManager } from './security/secretManager';
import { UpbitClient } from './exchanges/upbit';

const app = express();
app.use(express.json({ limit: '100kb' }));

const API_TOKEN = process.env.SERVER_AUTH_TOKEN;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.APP_ORIGIN;

if (!isLoopback(HOST) && !API_TOKEN) {
  throw new Error('SERVER_AUTH_TOKEN is required when HOST is not loopback.');
}

function isLoopback(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!API_TOKEN) return isLoopback(req.socket.remoteAddress);
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const urlToken = new URL(req.url || '/', 'http://localhost').searchParams.get('token') || undefined;
  return bearer === API_TOKEN || urlToken === API_TOKEN;
}

function validateConfig(payload: unknown): Partial<BotParams> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Configuration payload must be an object.');
  }
  const config = payload as Record<string, unknown>;
  const numericLimits: Record<string, [number, number]> = {
    atrMultiplier: [0.1, 20], orderRatio: [0, 100], stopLossMultiplier: [0.1, 20],
    maxExposurePercent: [1, 100], maxSafetyOrders: [0, 10], safetyOrderStepPercent: [0.1, 50],
    safetyOrderVolumeScale: [0.1, 10], trailingCallbackPercent: [0.1, 20],
    maxPyramidingOrders: [0, 2], pyramidingStepPercent: [0.1, 50], partialLossCutPercent: [1, 100],
    partialLossCutThreshold: [0.1, 100], trendDropSpeedThreshold: [0.1, 100],
    trendDropWindowSeconds: [1, 60], cooldownSecondsAfterCut: [0, 86400], dailyMaxLossPercent: [0.1, 100]
  };
  for (const [key, [min, max]] of Object.entries(numericLimits)) {
    if (key in config && (!Number.isFinite(config[key]) || Number(config[key]) < min || Number(config[key]) > max)) {
      throw new Error(`Invalid ${key}. Expected a number from ${min} to ${max}.`);
    }
  }
  if ('symbol' in config && (typeof config.symbol !== 'string' || !/^KRW-[A-Z0-9]{2,20}$/.test(config.symbol))) {
    throw new Error('Invalid Upbit KRW market symbol.');
  }
  if ('exchange' in config && config.exchange !== 'UPBIT') throw new Error('Unsupported exchange.');
  return config as Partial<BotParams>;
}

// Enable CORS for development frontend
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) return res.sendStatus(403);
  if (origin && !ALLOWED_ORIGIN && !isLoopback(req.socket.remoteAddress)) return res.sendStatus(403);
  if (origin) res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN || origin);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!isAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
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
wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
  // A missing SERVER_AUTH_TOKEN is deliberately local-only; production must
  // set a token before binding the service beyond loopback.
  if (!isAuthorized(request)) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  console.log('[Server WS] Client connected.');
  
  // Send initial full state immediately upon connection
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', payload: engine.getFullState() }));

  ws.on('message', async (message: RawData) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('[Server WS] Message received:', data.type);

      switch (data.type) {
        case 'UPDATE_CONFIG':
          engine.updateParams(validateConfig(data.payload));
          break;

        case 'TOGGLE_BOT':
          if (!data.payload || typeof data.payload.isBotActive !== 'boolean') throw new Error('Invalid bot toggle payload.');
          engine.updateParams({ isBotActive: Boolean(data.payload.isBotActive) });
          break;

        case 'SAVE_API_KEYS': {
          const keys = data.payload as ApiKeys;
          if (!keys || typeof keys.upbitAccessKey !== 'string' || typeof keys.upbitSecretKey !== 'string') {
            throw new Error('Invalid API key payload.');
          }
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
          if (side !== 'BUY' && side !== 'SELL') throw new Error('Invalid manual order side.');
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
  engine.updateParams(validateConfig(req.body));
  res.json({ success: true, state: engine.getFullState() });
});

app.post('/api/keys', (req, res) => {
  if (!req.body || typeof req.body.upbitAccessKey !== 'string' || typeof req.body.upbitSecretKey !== 'string') {
    return res.status(400).json({ success: false, error: 'Invalid API key payload.' });
  }
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
server.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 Upbit ATR Quantitative Bot Server Running!`);
  console.log(`🌐 HTTP Server: http://${HOST}:${PORT}`);
  console.log(`⚡ WebSocket Server: ws://0.0.0.0:${PORT}/ws`);
  console.log(`====================================================`);
});
