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
    maxExposurePercent: [1, 100], maxSafetyOrders: [3, 3], safetyOrderStepPercent: [0.1, 50],
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
  const booleanKeys = [
    'isBotActive', 'dcaEnabled', 'trailingStopEnabled', 'pyramidingEnabled', 'partialLossCutEnabled',
    'trendAwareCutEnabled', 'autoPilotEnabled', 'breakoutEntryEnabled', 'dryRunMode',
    'experimentDca2RsiRecoveryEnabled',
    'experimentDca2VolumeConfirmationEnabled',
    'experimentPyramidRsiGuardEnabled',
    'experimentPyramidVolumeConfirmationEnabled',
    'experimentScalpTrendExpansionEnabled',
    'experimentScalpReentryCooldownEnabled',
    'experimentTrendTrailingArmingEnabled'
  ];
  const allowedKeys = new Set([...Object.keys(numericLimits), 'symbol', 'exchange', ...booleanKeys]);
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown configuration key: ${key}.`);
  }
  for (const key of booleanKeys) {
    if (key in config && typeof config[key] !== 'boolean') throw new Error(`Invalid ${key}. Expected a boolean.`);
  }
  return config as Partial<BotParams>;
}

function assertExperimentConfigIsSafe(config: Partial<BotParams>) {
  const experimentKeys: Array<keyof BotParams> = [
    'experimentDca2RsiRecoveryEnabled',
    'experimentDca2VolumeConfirmationEnabled',
    'experimentPyramidRsiGuardEnabled',
    'experimentPyramidVolumeConfirmationEnabled',
    'experimentScalpTrendExpansionEnabled',
    'experimentScalpReentryCooldownEnabled',
    'experimentTrendTrailingArmingEnabled'
  ];
  if (engine.params.isBotActive && experimentKeys.some((key) => key in config)) {
    throw new Error('전략 실험 토글은 봇을 정지한 상태에서만 변경할 수 있습니다.');
  }
}

// Enable CORS for development frontend
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) return res.sendStatus(403);
  if (origin && !ALLOWED_ORIGIN && !isLoopback(req.socket.remoteAddress)) return res.sendStatus(403);
  if (origin) res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN || origin);
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
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
          {
            const config = validateConfig(data.payload);
            assertExperimentConfigIsSafe(config);
            engine.updateParams(config);
          }
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

        case 'SAVE_TELEGRAM_CONFIG': {
          const { telegramBotToken, telegramChatId } = data.payload || {};
          if (typeof telegramBotToken !== 'string' || typeof telegramChatId !== 'string') {
            throw new Error('텔레그램 토큰 또는 Chat ID 형식이 올바르지 않습니다.');
          }
          secretManager.saveTelegramConfig(telegramBotToken, telegramChatId);
          const delivered = await secretManager.sendTelegramAlert('✅ Upbit 퀀트봇 알림이 연결되었습니다. 안전 정지·포지션 보정 필요·시작 실패를 즉시 알려드립니다.');
          if (!delivered) throw new Error('텔레그램 테스트 메시지를 전송하지 못했습니다. 봇 토큰과 Chat ID를 확인하세요.');
          ws.send(JSON.stringify({ type: 'TELEGRAM_CONFIG_RESULT', payload: { success: true } }));
          break;
        }

        case 'TEST_TELEGRAM_ALERT': {
          const delivered = await secretManager.sendTelegramAlert('🔔 Upbit 퀀트봇 텔레그램 연결 테스트입니다.');
          if (!delivered) throw new Error('저장된 텔레그램 설정으로 테스트 메시지를 전송하지 못했습니다.');
          ws.send(JSON.stringify({ type: 'TELEGRAM_CONFIG_RESULT', payload: { success: true } }));
          break;
        }

        case 'TEST_API_KEYS': {
          const { upbitAccessKey, upbitSecretKey } = data.payload;
          const currentKeys = secretManager.getKeys();
          const uAcc = (upbitAccessKey || currentKeys.upbitAccessKey || '').trim();
          const uSec = (upbitSecretKey || currentKeys.upbitSecretKey || '').trim();
          const client = new UpbitClient();
          const res = await client.getAccountBalance(uAcc, uSec);
          // Credential tests must never replace the live engine's account
          // state. Only SAVE_API_KEYS followed by full reconciliation may do
          // that.
          ws.send(JSON.stringify({ type: 'TEST_API_KEYS_RESULT', payload: res }));
          break;
        }

        case 'MANUAL_TRADE': {
          const side = data.payload.side as 'BUY' | 'SELL';
          if (side !== 'BUY' && side !== 'SELL') throw new Error('Invalid manual order side.');
          const manualBuyPercent = data.payload.manualBuyPercent;
          try {
            await engine.executeManualTrade(side, manualBuyPercent);
            ws.send(JSON.stringify({ type: 'MANUAL_TRADE_RESULT', payload: { success: true } }));
          } catch (err: any) {
            console.error('[Server WS] Manual trade error:', err.message);
            engine.addLog({
              type: 'SYSTEM',
              price: engine.currentPrice,
              reason: `❌ 수동 주문 실패: ${err.message}`
            });
            ws.send(JSON.stringify({ type: 'MANUAL_TRADE_RESULT', payload: { success: false, error: err.message } }));
          }
          break;
        }

        case 'REBASE_POSITION':
          await engine.rebaseCurrentPosition();
          ws.send(JSON.stringify({ type: 'POSITION_REBASE_RESULT', payload: { success: true } }));
          break;

        case 'RESTART_SERVER': {
          if (data.payload?.confirmed !== true) throw new Error('Server restart requires explicit confirmation.');
          // Acknowledge before closing the socket so the UI can show a clear
          // reconnecting state. PM2 is responsible for bringing this process
          // back; a forced fallback exit prevents active WS clients from
          // keeping httpServer.close() open indefinitely.
          ws.send(JSON.stringify({ type: 'SERVER_RESTARTING', payload: { message: 'Server restart acknowledged.' } }), () => {
            console.warn('[Server] Restart requested by authorized WebSocket client.');
            setTimeout(() => {
              wss.clients.forEach((client) => client.close(1012, 'Server restarting'));
              wss.close();
              server.close(() => process.exit(0));
              const forcedExit = setTimeout(() => process.exit(0), 1500);
              forcedExit.unref();
            }, 100).unref();
          });
          break;
        }

        default:
          console.warn('[Server WS] Unknown action:', data.type);
      }
    } catch (err: any) {
      console.error('[Server WS] Message handling error:', err.message);
      ws.send(JSON.stringify({ type: 'COMMAND_ERROR', payload: { message: err.message || '요청 처리 중 오류가 발생했습니다.' } }));
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
  const config = validateConfig(req.body);
  assertExperimentConfigIsSafe(config);
  engine.updateParams(config);
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
