import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import path from 'path';
import { ATREngine, ApiKeys, BotParams } from './strategy/atrEngine';
import { BinanceClient } from './exchanges/binance';
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
          const trimmedKeys: ApiKeys = {
            binanceApiKey: keys.binanceApiKey?.trim(),
            binanceApiSecret: keys.binanceApiSecret?.trim(),
            upbitAccessKey: keys.upbitAccessKey?.trim(),
            upbitSecretKey: keys.upbitSecretKey?.trim()
          };
          engine.setApiKeys(trimmedKeys);
          ws.send(JSON.stringify({
            type: 'API_KEYS_STATUS',
            payload: { success: true, message: 'API keys saved successfully.' }
          }));
          break;
        }

        case 'TEST_API_KEYS': {
          const { exchange, binanceApiKey, binanceApiSecret, upbitAccessKey, upbitSecretKey } = data.payload;
          if (exchange === 'BINANCE') {
            const bKey = (binanceApiKey || engine.apiKeys.binanceApiKey || '').trim();
            const bSec = (binanceApiSecret || engine.apiKeys.binanceApiSecret || '').trim();
            const client = new BinanceClient();
            const res = await client.getAccountBalance(bKey, bSec);
            if (res.success && res.balances) {
              engine.realBalances = res.balances;
              engine.notifyClients();
            }
            ws.send(JSON.stringify({ type: 'TEST_API_KEYS_RESULT', payload: res }));
          } else if (exchange === 'UPBIT') {
            const uAcc = (upbitAccessKey || engine.apiKeys.upbitAccessKey || '').trim();
            const uSec = (upbitSecretKey || engine.apiKeys.upbitSecretKey || '').trim();
            const client = new UpbitClient();
            const res = await client.getAccountBalance(uAcc, uSec);
            if (res.success && res.balances) {
              engine.realBalances = res.balances;
              engine.notifyClients();
            }
            ws.send(JSON.stringify({ type: 'TEST_API_KEYS_RESULT', payload: res }));
          }
          break;
        }

        case 'MANUAL_TRADE': {
          const side = data.payload.side as 'BUY' | 'SELL';
          if (side === 'BUY') {
            engine.processTick(engine.baselineValue - (engine.atrValue * engine.params.atrMultiplier * 1.1), engine.params.symbol);
          } else {
            engine.processTick(engine.baselineValue + (engine.atrValue * engine.params.atrMultiplier * 1.1), engine.params.symbol);
          }
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
  res.json({ success: true, message: 'API keys updated successfully.' });
});

app.post('/api/keys/test', async (req, res) => {
  const { exchange } = req.body;
  if (exchange === 'BINANCE') {
    const client = new BinanceClient();
    const result = await client.getAccountBalance(
      engine.apiKeys.binanceApiKey || '',
      engine.apiKeys.binanceApiSecret || ''
    );
    return res.json(result);
  } else if (exchange === 'UPBIT') {
    const client = new UpbitClient();
    const result = await client.getAccountBalance(
      engine.apiKeys.upbitAccessKey || '',
      engine.apiKeys.upbitSecretKey || ''
    );
    return res.json(result);
  }
  res.status(400).json({ success: false, error: 'Invalid exchange' });
});

// Start Server & Exchange Streams
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 ATR Trading Bot Full-Stack Server Running!`);
  console.log(`🌐 HTTP Server: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Server: ws://localhost:${PORT}`);
  console.log(`====================================================`);

  // Start real-time exchange streams
  engine.startExchangeStream();
});
