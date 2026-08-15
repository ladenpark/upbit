import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play,
  Square,
  TrendingUp,
  TrendingDown,
  Activity,
  Sliders,
  Terminal,
  RefreshCw,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  ShieldAlert,
  Wallet,
  DollarSign,
  PieChart,
  Copy,
  Check,
  Code,
  Download,
  AlertCircle,
  BarChart2,
  ChevronDown,
  Volume2,
  VolumeX,
  Layers,
  Smartphone,
  Maximize2,
  Minimize2,
  Cpu,
  History,
  Settings,
  Key,
  Globe,
  Radio,
  CheckCircle,
  XCircle
} from 'lucide-react';

interface TradeLog {
  id: string;
  time: string;
  type: 'BUY' | 'SELL' | 'STOP_LOSS' | 'SYSTEM';
  price: number;
  reason: string;
  amount?: number;
  pnl?: number;
  pnlPercent?: number;
  exchange?: string;
  executionMode?: 'PAPER' | 'REAL';
}

interface PricePoint {
  time: number;
  timeLabel: string;
  price: number;
  upperBand: number;
  baseline: number;
  lowerBand: number;
  stopLoss: number;
  event?: 'BUY' | 'SELL' | 'STOP_LOSS';
}

export default function App() {
  // Mobile Tab view: 'chart' | 'bot' | 'logs' | 'account'
  const [activeTab, setActiveTab] = useState<'chart' | 'bot' | 'logs' | 'account'>('chart');
  const [deviceFrameMode, setDeviceFrameMode] = useState<boolean>(true);

  // Backend WS Connection State
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Exchange & Symbol Selection
  const [exchange, setExchange] = useState<'BINANCE' | 'UPBIT' | 'SIMULATION'>('BINANCE');
  const [selectedCoin, setSelectedCoin] = useState<string>('BTC/USDT');
  const [executionMode, setExecutionMode] = useState<'PAPER' | 'REAL'>('PAPER');

  // Bot Parameters
  const [isBotActive, setIsBotActive] = useState<boolean>(false);
  const [atrMultiplier, setAtrMultiplier] = useState<number>(2.0);
  const [orderRatio, setOrderRatio] = useState<number>(25); // %
  const [stopLossMultiplier, setStopLossMultiplier] = useState<number>(1.5);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  // API Credentials State
  const [binanceKey, setBinanceKey] = useState<string>('');
  const [binanceSecret, setBinanceSecret] = useState<string>('');
  const [upbitAccess, setUpbitAccess] = useState<string>('');
  const [upbitSecret, setUpbitSecret] = useState<string>('');
  const [apiKeyTestStatus, setApiKeyTestStatus] = useState<string | null>(null);
  const [hasApiKeys, setHasApiKeys] = useState<{ binance: boolean; upbit: boolean }>({ binance: false, upbit: false });

  // Financial & Market State
  const [balance, setBalance] = useState<number>(10000.0);
  const [initialBalance] = useState<number>(10000.0);
  const [positionAmount, setPositionAmount] = useState<number>(0);
  const [entryPrice, setEntryPrice] = useState<number | null>(null);
  const [totalRealizedPnl, setTotalRealizedPnl] = useState<number>(0);
  const [totalTrades, setTotalTrades] = useState<number>(0);
  const [winTrades, setWinTrades] = useState<number>(0);
  const [realBalances, setRealBalances] = useState<Record<string, number>>({});

  // Price & Indicators State
  const [currentPrice, setCurrentPrice] = useState<number>(96450.0);
  const [atrValue, setAtrValue] = useState<number>(1250.0);
  const [baselineValue, setBaselineValue] = useState<number>(96450.0);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [logs, setLogs] = useState<TradeLog[]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Connect to Backend WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    console.log(`Connecting to backend WebSocket at ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to Full-Stack ATR Backend!');
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'STATE_UPDATE') {
          const s = data.payload;
          if (s.params) {
            setIsBotActive(s.params.isBotActive);
            setExchange(s.params.exchange);
            setSelectedCoin(s.params.symbol);
            setExecutionMode(s.params.executionMode);
            setAtrMultiplier(s.params.atrMultiplier);
            setOrderRatio(s.params.orderRatio);
            setStopLossMultiplier(s.params.stopLossMultiplier);
          }
          if (s.balance !== undefined) setBalance(s.balance);
          if (s.position) {
            setPositionAmount(s.position.amount);
            setEntryPrice(s.position.entryPrice);
          }
          if (s.totalRealizedPnl !== undefined) setTotalRealizedPnl(s.totalRealizedPnl);
          if (s.totalTrades !== undefined) setTotalTrades(s.totalTrades);
          if (s.winTrades !== undefined) setWinTrades(s.winTrades);
          if (s.currentPrice !== undefined) setCurrentPrice(s.currentPrice);
          if (s.atrValue !== undefined) setAtrValue(s.atrValue);
          if (s.baselineValue !== undefined) setBaselineValue(s.baselineValue);
          if (s.priceHistory) setPriceHistory(s.priceHistory);
          if (s.logs) setLogs(s.logs);
          if (s.realBalances) setRealBalances(s.realBalances);
          if (s.hasApiKeys) setHasApiKeys(s.hasApiKeys);
        } else if (data.type === 'TEST_API_KEYS_RESULT') {
          const res = data.payload;
          if (res.success) {
            if (res.balances) setRealBalances(res.balances);
            const assets = res.balances ? Object.keys(res.balances).join(', ') : 'OK';
            setApiKeyTestStatus(`✅ API 연결 성공! 실시간 보유 자산 (${assets}) 수신 완료`);
          } else {
            setApiKeyTestStatus(`❌ API 연결 실패: ${res.error}`);
          }
        }
      } catch (err) {
        console.error('Error parsing backend WS message:', err);
      }
    };

    ws.onclose = () => {
      console.log('Backend WS Disconnected');
      setWsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  // Send config update to backend
  const sendWsCommand = (type: string, payload: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  };

  const handleExchangeChange = (newExchange: 'BINANCE' | 'UPBIT' | 'SIMULATION') => {
    let newCoin = selectedCoin;
    if (newExchange === 'UPBIT' && !selectedCoin.startsWith('KRW-')) {
      const coin = selectedCoin.split('/')[0] || 'BTC';
      newCoin = `KRW-${coin}`;
    } else if (newExchange === 'BINANCE' && selectedCoin.startsWith('KRW-')) {
      const coin = selectedCoin.replace('KRW-', '');
      newCoin = `${coin}/USDT`;
    }
    setExchange(newExchange);
    setSelectedCoin(newCoin);
    sendWsCommand('UPDATE_CONFIG', { exchange: newExchange, symbol: newCoin });
  };

  const handleCoinChange = (newCoin: string) => {
    setSelectedCoin(newCoin);
    sendWsCommand('UPDATE_CONFIG', { exchange, symbol: newCoin });
  };

  const handleParamsChange = (newParams: { atrMultiplier?: number; orderRatio?: number; stopLossMultiplier?: number; executionMode?: 'PAPER' | 'REAL' }) => {
    if (newParams.atrMultiplier !== undefined) setAtrMultiplier(newParams.atrMultiplier);
    if (newParams.orderRatio !== undefined) setOrderRatio(newParams.orderRatio);
    if (newParams.stopLossMultiplier !== undefined) setStopLossMultiplier(newParams.stopLossMultiplier);
    if (newParams.executionMode !== undefined) setExecutionMode(newParams.executionMode);
    sendWsCommand('UPDATE_CONFIG', newParams);
  };

  const handleToggleBot = () => {
    sendWsCommand('TOGGLE_BOT', { isBotActive: !isBotActive });
  };

  const handleSaveApiKeys = () => {
    sendWsCommand('SAVE_API_KEYS', {
      binanceApiKey: binanceKey,
      binanceApiSecret: binanceSecret,
      upbitAccessKey: upbitAccess,
      upbitSecretKey: upbitSecret
    });
    setApiKeyTestStatus('🔑 API 키가 백엔드에 안전하게 저장되었습니다.');
  };

  const handleTestApiKeys = (targetExchange: 'BINANCE' | 'UPBIT') => {
    if (targetExchange === 'UPBIT' && (!upbitAccess || !upbitSecret)) {
      setApiKeyTestStatus('❌ Upbit Access Key와 Secret Key를 먼저 입력해 주세요.');
      return;
    }
    if (targetExchange === 'BINANCE' && (!binanceKey || !binanceSecret)) {
      setApiKeyTestStatus('❌ Binance API Key와 Secret Key를 먼저 입력해 주세요.');
      return;
    }
    setApiKeyTestStatus('⏳ 거래소 REST API 연결 테스트 중...');
    sendWsCommand('TEST_API_KEYS', {
      exchange: targetExchange,
      binanceApiKey: binanceKey,
      binanceApiSecret: binanceSecret,
      upbitAccessKey: upbitAccess,
      upbitSecretKey: upbitSecret
    });
  };

  const formatPrice = (p: number, symbol = selectedCoin) => {
    if (symbol.startsWith('KRW-') || exchange === 'UPBIT') {
      return `₩${Math.round(p).toLocaleString('ko-KR')}`;
    }
    if (symbol.includes('SOL')) return `$${p.toFixed(2)}`;
    if (symbol.includes('ETH')) return `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `$${p.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
  };

  // Sound effects
  const playBeep = (type: 'BUY' | 'SELL' | 'STOP') => {
    if (!soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof window.AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'BUY') {
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else if (type === 'SELL') {
        osc.frequency.setValueAtTime(900, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } else {
        osc.frequency.setValueAtTime(400, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.18);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      }
    } catch {}
  };

  // Canvas mobile chart rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const padding = { top: 22, right: 68, bottom: 22, left: 10 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.clearRect(0, 0, width, height);
    if (priceHistory.length < 2) return;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    priceHistory.forEach((p) => {
      minPrice = Math.min(minPrice, p.price, p.lowerBand, p.stopLoss);
      maxPrice = Math.max(maxPrice, p.price, p.upperBand);
    });

    const priceRange = maxPrice - minPrice || 1;
    const paddedMin = minPrice - priceRange * 0.08;
    const paddedMax = maxPrice + priceRange * 0.08;
    const fullRange = paddedMax - paddedMin;

    const getY = (val: number) => padding.top + chartHeight - ((val - paddedMin) / fullRange) * chartHeight;
    const getX = (index: number) => padding.left + (index / (priceHistory.length - 1)) * chartWidth;

    // Grid lines
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padding.top + (i / 3) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const priceVal = paddedMax - (i / 3) * fullRange;
      ctx.fillStyle = '#94a3b8';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(formatPrice(priceVal, selectedCoin), width - padding.right + 6, y + 3);
    }

    // Shaded ATR Channel
    ctx.beginPath();
    for (let i = 0; i < priceHistory.length; i++) {
      const x = getX(i);
      const y = getY(priceHistory[i].upperBand);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let i = priceHistory.length - 1; i >= 0; i--) {
      const x = getX(i);
      const y = getY(priceHistory[i].lowerBand);
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(59, 130, 246, 0.05)';
    ctx.fill();

    // Indicator Lines
    const drawLine = (prop: keyof PricePoint, color: string, dash: number[] = [], w = 1.4) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.setLineDash(dash);
      priceHistory.forEach((p, idx) => {
        const x = getX(idx);
        const y = getY(Number(p[prop]));
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };

    drawLine('stopLoss', '#f43f5e', [3, 3], 1.2);
    drawLine('lowerBand', '#6366f1', [4, 3], 1.5);
    drawLine('baseline', '#cbd5e1', [], 1);
    drawLine('upperBand', '#10b981', [4, 3], 1.5);

    // Price Line
    ctx.beginPath();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    priceHistory.forEach((p, idx) => {
      const x = getX(idx);
      const y = getY(p.price);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Event Markers
    priceHistory.forEach((p, idx) => {
      if (!p.event) return;
      const x = getX(idx);
      const y = getY(p.price);
      ctx.save();
      if (p.event === 'BUY') {
        ctx.fillStyle = '#10b981';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.event === 'SELL') {
        ctx.fillStyle = '#059669';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.event === 'STOP_LOSS') {
        ctx.fillStyle = '#e11d48';
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });

    // Current Price Pulsing Dot
    const lastIdx = priceHistory.length - 1;
    const lastPoint = priceHistory[lastIdx];
    const curX = getX(lastIdx);
    const curY = getY(lastPoint.price);

    ctx.save();
    ctx.beginPath();
    ctx.arc(curX, curY, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(37, 99, 235, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(curX, curY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#2563eb';
    ctx.fill();
    ctx.restore();

    // Right Axis Price Tag
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.roundRect(width - padding.right + 4, curY - 9, padding.right - 8, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(formatPrice(lastPoint.price, selectedCoin), width - padding.right + 7, curY + 3.5);
  }, [priceHistory, selectedCoin, exchange]);

  // Position calculations
  const unrealizedPnl = useMemo(() => {
    if (positionAmount === 0 || !entryPrice) return 0;
    return (currentPrice - entryPrice) * positionAmount;
  }, [positionAmount, entryPrice, currentPrice]);

  const unrealizedPnlPercent = useMemo(() => {
    if (positionAmount === 0 || !entryPrice) return 0;
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }, [positionAmount, entryPrice, currentPrice]);

  const currentEquity = balance + positionAmount * currentPrice;
  const totalReturnPercent = ((currentEquity - initialBalance) / initialBalance) * 100;
  const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : '0.0';

  const handleManualBuy = () => {
    sendWsCommand('MANUAL_TRADE', { side: 'BUY' });
    playBeep('BUY');
  };

  const handleManualSell = () => {
    sendWsCommand('MANUAL_TRADE', { side: 'SELL' });
    playBeep('SELL');
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center sm:p-4 text-slate-900 font-['Plus_Jakarta_Sans',sans-serif]">
      {/* Desktop Mode Toggle Header */}
      <div className="hidden sm:flex items-center justify-between max-w-sm w-full mb-3 px-2 text-xs text-slate-500 font-medium">
        <div className="flex items-center gap-1.5 font-bold text-slate-700">
          <Smartphone className="w-4 h-4 text-blue-600" />
          <span>모바일 시세/매매 대시보드</span>
        </div>
        <button
          onClick={() => setDeviceFrameMode(!deviceFrameMode)}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold shadow-2xs transition"
        >
          {deviceFrameMode ? <Maximize2 className="w-3 h-3" /> : <Minimize2 className="w-3 h-3" />}
          <span>{deviceFrameMode ? '전체화면' : '프레임 모드'}</span>
        </button>
      </div>

      {/* Main Mobile Screen Container */}
      <div
        className={`w-full bg-slate-50 flex flex-col transition-all overflow-hidden ${
          deviceFrameMode
            ? 'sm:max-w-[400px] sm:h-[840px] sm:rounded-[40px] sm:border-[8px] sm:border-slate-800 sm:shadow-2xl'
            : 'max-w-md min-h-screen sm:rounded-2xl sm:shadow-xl sm:border border-slate-200'
        }`}
      >
        {/* Mobile Status Bar */}
        <div className="bg-white px-5 pt-3 pb-1.5 flex items-center justify-between text-xs font-bold text-slate-800 select-none border-b border-slate-100">
          <span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <div className="w-20 h-4 bg-slate-900 rounded-full sm:block hidden opacity-90"></div>
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] font-bold ${wsConnected ? 'text-emerald-600' : 'text-rose-500'}`}>
              {wsConnected ? 'LIVE WS' : 'OFFLINE'}
            </span>
            <div className="w-5 h-2.5 border border-slate-800 rounded-xs p-0.5 flex items-center">
              <div className="w-full h-full bg-slate-800 rounded-2xs"></div>
            </div>
          </div>
        </div>

        {/* Mobile Header Bar */}
        <header className="bg-white px-4 py-2.5 flex items-center justify-between border-b border-slate-200 shadow-2xs shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold shadow-2xs">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-extrabold text-slate-900 text-sm leading-none">ATR BOT</h1>
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.2 rounded-full ${
                    isBotActive ? 'bg-emerald-100 text-emerald-800 animate-pulse' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {isBotActive ? 'RUNNING' : 'IDLE'}
                </span>
              </div>
              <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                {exchange === 'BINANCE' ? 'Binance WS' : exchange === 'UPBIT' ? 'Upbit WS' : '시뮬레이션'} · {executionMode === 'REAL' ? '실제 매매' : '모의 매매'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Exchange Toggle */}
            <select
              value={exchange}
              onChange={(e) => handleExchangeChange(e.target.value as any)}
              className="bg-slate-100 font-bold text-[11px] text-slate-800 px-2 py-1 rounded-lg border border-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="BINANCE">Binance</option>
              <option value="UPBIT">Upbit</option>
              <option value="SIMULATION">모의 엔진</option>
            </select>

            {/* Symbol Selector */}
            <select
              value={selectedCoin}
              onChange={(e) => handleCoinChange(e.target.value)}
              className="bg-blue-50 font-bold text-[11px] text-blue-900 px-2 py-1 rounded-lg border border-blue-200 focus:outline-none cursor-pointer"
            >
              {exchange === 'UPBIT' ? (
                <>
                  <option value="KRW-BTC">KRW-BTC</option>
                  <option value="KRW-ETH">KRW-ETH</option>
                  <option value="KRW-SOL">KRW-SOL</option>
                </>
              ) : (
                <>
                  <option value="BTC/USDT">BTC/USDT</option>
                  <option value="ETH/USDT">ETH/USDT</option>
                  <option value="SOL/USDT">SOL/USDT</option>
                </>
              )}
            </select>
          </div>
        </header>

        {/* Live Price & Indicator Header Card */}
        <div className="bg-white px-4 py-2.5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              <span>{selectedCoin}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
            </div>
            <div className="text-xl font-extrabold mono text-slate-900 tracking-tight leading-tight">
              {formatPrice(currentPrice)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-400 mono">ATR: {formatPrice(atrValue)}</div>
            <div className="text-[10px] text-slate-500 font-medium">기준선: {formatPrice(baselineValue)}</div>
          </div>
        </div>

        {/* Scrollable Content Area */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {activeTab === 'chart' && (
            <>
              {/* Asset & Position Cards */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
                  <div className="text-[10px] font-semibold text-slate-400">총 자산 (Equity)</div>
                  <div className="text-sm font-extrabold mono text-slate-900 mt-0.5">
                    {formatPrice(currentEquity)}
                  </div>
                  <div className={`text-[10px] font-bold ${totalReturnPercent >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    수익률: {totalReturnPercent >= 0 ? '+' : ''}{totalReturnPercent.toFixed(2)}%
                  </div>
                </div>

                <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
                  <div className="text-[10px] font-semibold text-slate-400">현재 포지션</div>
                  <div className="text-xs font-extrabold mono text-indigo-700 mt-0.5 truncate">
                    {positionAmount > 0 ? `LONG ${positionAmount}` : 'FLAT (무포지션)'}
                  </div>
                  <div className={`text-[10px] font-bold ${unrealizedPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    손익: {unrealizedPnl >= 0 ? '+' : ''}{formatPrice(unrealizedPnl)} ({unrealizedPnlPercent.toFixed(1)}%)
                  </div>
                </div>
              </div>

              {/* Real-time Canvas Chart */}
              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <BarChart2 className="w-3.5 h-3.5 text-blue-600" />
                    <span className="text-xs font-bold text-slate-800">ATR 밴드 실시간 시세</span>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] font-semibold">
                    <span className="text-emerald-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>익절선</span>
                    <span className="text-indigo-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>매수선</span>
                    <span className="text-rose-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>손절선</span>
                  </div>
                </div>

                <div className="relative w-full h-[220px] bg-slate-50/80 rounded-xl border border-slate-200 overflow-hidden">
                  <canvas ref={canvasRef} className="w-full h-full block" />
                  <div className="absolute top-1.5 left-2 text-[9px] text-slate-400 mono flex items-center gap-1">
                    <Radio className="w-3 h-3 text-emerald-500 animate-pulse" />
                    WebSocket 수신 중
                  </div>
                </div>

                {/* Quick Manual Action Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={handleManualBuy}
                    disabled={positionAmount > 0}
                    className="py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-1 shadow-2xs active:scale-98 transition"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" />
                    <span>수동 매수 (BUY)</span>
                  </button>
                  <button
                    onClick={handleManualSell}
                    disabled={positionAmount === 0}
                    className="py-2 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-1 shadow-2xs active:scale-98 transition"
                  >
                    <ArrowDownRight className="w-3.5 h-3.5" />
                    <span>전량 청산 (SELL)</span>
                  </button>
                </div>
              </div>

              {/* Bot Control Card */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
                <div>
                  <div className="text-xs font-extrabold text-slate-900">ATR 자동 트레이딩 봇</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    밴드 터치 시 자동 매수/익절/손절
                  </div>
                </div>
                <button
                  onClick={handleToggleBot}
                  className={`px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-1.5 shadow-sm active:scale-95 transition ${
                    isBotActive
                      ? 'bg-rose-600 hover:bg-rose-700 text-white ring-2 ring-rose-200'
                      : 'bg-blue-600 hover:bg-blue-700 text-white ring-2 ring-blue-200'
                  }`}
                >
                  {isBotActive ? <Square className="w-3.5 h-3.5 fill-white" /> : <Play className="w-3.5 h-3.5 fill-white" />}
                  <span>{isBotActive ? '봇 정지' : '봇 가동 (ON)'}</span>
                </button>
              </div>

              {/* Mini Log Feed */}
              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2">
                <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                  <span className="flex items-center gap-1">
                    <Terminal className="w-3.5 h-3.5 text-slate-600" />
                    최근 매매 로그
                  </span>
                  <button onClick={() => setActiveTab('logs')} className="text-[11px] text-blue-600 font-semibold">
                    전체보기 ({logs.length})
                  </button>
                </div>
                <div className="space-y-1.5 text-[11px] mono">
                  {logs.slice(0, 3).map((log) => (
                    <div
                      key={log.id}
                      className={`p-2 rounded-lg border flex items-center justify-between ${
                        log.type === 'BUY'
                          ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
                          : log.type === 'SELL'
                          ? 'bg-blue-50/70 border-blue-200 text-blue-900'
                          : log.type === 'STOP_LOSS'
                          ? 'bg-rose-50/70 border-rose-200 text-rose-900'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="font-bold text-[9px] px-1 py-0.2 rounded bg-white/80 border">
                          {log.type}
                        </span>
                        <span className="truncate">{log.reason}</span>
                      </div>
                      <span className="shrink-0 font-bold ml-2">{formatPrice(log.price)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {activeTab === 'bot' && (
            <div className="space-y-3">
              {/* Execution Mode Selector */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-2xs space-y-2">
                <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                  <Zap className="w-4 h-4 text-amber-500" />
                  <span>매매 실행 모드 설정</span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => handleParamsChange({ executionMode: 'PAPER' })}
                    className={`p-2.5 rounded-xl border text-left transition ${
                      executionMode === 'PAPER'
                        ? 'bg-blue-50 border-blue-400 text-blue-900 font-bold'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    <div className="text-xs">모의 매매 (Paper)</div>
                    <div className="text-[9px] font-normal text-slate-500">실시간 시세 + 가상 잔고</div>
                  </button>
                  <button
                    onClick={() => handleParamsChange({ executionMode: 'REAL' })}
                    className={`p-2.5 rounded-xl border text-left transition ${
                      executionMode === 'REAL'
                        ? 'bg-amber-50 border-amber-500 text-amber-950 font-bold'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    <div className="text-xs text-amber-600">실제 매매 (Live API)</div>
                    <div className="text-[9px] font-normal text-slate-500">거래소 API 실제 매매</div>
                  </button>
                </div>
              </div>

              {/* Bot Parameter Tuning Form */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Sliders className="w-4 h-4 text-blue-600" />
                    <h2 className="font-bold text-sm text-slate-900">ATR 전략 파라미터</h2>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">Backend Auto Sync</span>
                </div>

                {/* ATR Multiplier Slider */}
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-bold">
                    <span className="text-slate-700">ATR 밴드 배수</span>
                    <span className="text-blue-600 mono">{atrMultiplier.toFixed(1)}x</span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="4.0"
                    step="0.1"
                    value={atrMultiplier}
                    onChange={(e) => handleParamsChange({ atrMultiplier: parseFloat(e.target.value) })}
                    className="w-full accent-blue-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                  />
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span>1.0x (타이트)</span>
                    <span>2.0x (표준)</span>
                    <span>4.0x (와이드)</span>
                  </div>
                </div>

                {/* Order Ratio Slider */}
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-bold">
                    <span className="text-slate-700">1회 진입 비중</span>
                    <span className="text-blue-600 mono">{orderRatio}%</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="100"
                    step="5"
                    value={orderRatio}
                    onChange={(e) => handleParamsChange({ orderRatio: parseInt(e.target.value) })}
                    className="w-full accent-blue-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                  />
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span>5% (분할)</span>
                    <span>25% (추천)</span>
                    <span>100% (올인)</span>
                  </div>
                </div>

                {/* Stop Loss Multiplier Slider */}
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-bold">
                    <span className="text-slate-700">동적 손절 배수 (SL)</span>
                    <span className="text-rose-600 mono">{stopLossMultiplier.toFixed(1)}x</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="3.0"
                    step="0.1"
                    value={stopLossMultiplier}
                    onChange={(e) => handleParamsChange({ stopLossMultiplier: parseFloat(e.target.value) })}
                    className="w-full accent-rose-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                  />
                  <div className="flex justify-between text-[10px] text-slate-400">
                    <span>0.5x (칼손절)</span>
                    <span>1.5x (권장)</span>
                    <span>3.0x (여유)</span>
                  </div>
                </div>
              </div>

              {/* Big Bot Control Button */}
              <button
                onClick={handleToggleBot}
                className={`w-full py-3.5 rounded-2xl font-extrabold text-sm flex items-center justify-center gap-2 shadow-sm transition active:scale-98 ${
                  isBotActive
                    ? 'bg-rose-600 hover:bg-rose-700 text-white'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
              >
                {isBotActive ? <Square className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white" />}
                <span>{isBotActive ? '자동 봇 정지 (IDLE)' : '자동 봇 가동 시작 (START)'}</span>
              </button>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2 flex flex-col h-[520px]">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <div className="flex items-center gap-1.5 font-bold text-xs text-slate-900">
                  <Terminal className="w-4 h-4 text-slate-600" />
                  <span>실시간 체결 & 백엔드 로그 ({logs.length})</span>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 mono text-[11px]">
                {logs.length === 0 ? (
                  <div className="text-center py-10 text-slate-400">체결 로그가 없습니다.</div>
                ) : (
                  logs.map((log) => (
                    <div
                      key={log.id}
                      className={`p-2.5 rounded-xl border flex items-start gap-2 ${
                        log.type === 'BUY'
                          ? 'bg-emerald-50/80 border-emerald-200 text-emerald-950'
                          : log.type === 'SELL'
                          ? 'bg-blue-50/80 border-blue-200 text-blue-950'
                          : log.type === 'STOP_LOSS'
                          ? 'bg-rose-50/80 border-rose-200 text-rose-950'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                      }`}
                    >
                      <span className="text-[10px] text-slate-400 shrink-0 mt-0.5">{log.time}</span>
                      <span
                        className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded uppercase shrink-0 ${
                          log.type === 'BUY'
                            ? 'bg-emerald-600 text-white'
                            : log.type === 'SELL'
                            ? 'bg-blue-600 text-white'
                            : log.type === 'STOP_LOSS'
                            ? 'bg-rose-600 text-white'
                            : 'bg-slate-200 text-slate-700'
                        }`}
                      >
                        {log.type}
                      </span>
                      <div className="flex-1 leading-tight font-medium">
                        <div>{log.reason}</div>
                        {log.pnl !== undefined && (
                          <div className={`text-[10px] font-bold mt-0.5 ${log.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                            손익: {log.pnl >= 0 ? '+' : ''}${log.pnl.toFixed(2)} ({log.pnlPercent?.toFixed(2)}%)
                          </div>
                        )}
                      </div>
                      <span className="font-bold shrink-0">{formatPrice(log.price)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'account' && (
            <div className="space-y-3">
              {/* Account Performance Overview */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <h3 className="font-bold text-sm text-slate-900 flex items-center gap-1.5">
                  <Wallet className="w-4 h-4 text-blue-600" />
                  <span>트레이딩 계좌 및 성과</span>
                </h3>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">현재 자산 평가액</span>
                    <span className="font-bold mono text-blue-600">{formatPrice(currentEquity)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">누적 실현 손익</span>
                    <span className={`font-bold mono ${totalRealizedPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {totalRealizedPnl >= 0 ? '+' : ''}{formatPrice(totalRealizedPnl)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">총 체결 횟수</span>
                    <span className="font-bold mono">{totalTrades}회</span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-slate-500">승률 (Win Rate)</span>
                    <span className="font-bold mono text-emerald-600">{winRate}%</span>
                  </div>
                </div>
              </div>

              {/* Real Exchange Wallet Assets */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="font-bold text-sm text-slate-900 flex items-center gap-1.5">
                    <PieChart className="w-4 h-4 text-emerald-600" />
                    <span>실제 {exchange} 계좌 보유 자산</span>
                  </h3>
                  <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded-full">
                    {hasApiKeys.upbit || hasApiKeys.binance ? '● 실시간 연동' : '○ API 키 필요'}
                  </span>
                </div>

                {Object.keys(realBalances).length === 0 ? (
                  <div className="text-center py-4 text-xs text-slate-400">
                    {hasApiKeys.upbit || hasApiKeys.binance
                      ? '연동된 계좌의 보유 자고가 없거나 조회 중입니다.'
                      : '하단에서 Upbit/Binance API 키를 등록하면 실제 계좌 잔고가 표시됩니다.'}
                  </div>
                ) : (
                  <div className="space-y-2 text-xs mono">
                    {Object.entries(realBalances).map(([asset, amount]) => (
                      <div key={asset} className="flex justify-between py-1.5 border-b border-slate-100 last:border-none">
                        <span className="font-bold text-slate-700 flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                          {asset}
                        </span>
                        <span className="font-bold text-slate-900">
                          {asset === 'KRW' ? `₩${Math.round(Number(amount)).toLocaleString('ko-KR')}` : `${Number(amount).toLocaleString()} ${asset}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* API Key Management Form */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="font-bold text-sm text-slate-900 flex items-center gap-1.5">
                    <Key className="w-4 h-4 text-amber-500" />
                    <span>실제 거래소 API 키 설정</span>
                  </h3>
                  <span className="text-[10px] text-slate-400 font-mono">Encrypted</span>
                </div>

                {apiKeyTestStatus && (
                  <div className="p-2.5 rounded-xl bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-800">
                    {apiKeyTestStatus}
                  </div>
                )}

                {/* Binance API Keys */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                    <span>Binance API Credentials</span>
                    <span className={`text-[10px] ${hasApiKeys.binance ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {hasApiKeys.binance ? '● Key Configured' : '○ Not Configured'}
                    </span>
                  </div>
                  <input
                    type="password"
                    placeholder="Binance API Key"
                    value={binanceKey}
                    onChange={(e) => setBinanceKey(e.target.value)}
                    className="w-full text-xs font-mono px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="password"
                    placeholder="Binance API Secret"
                    value={binanceSecret}
                    onChange={(e) => setBinanceSecret(e.target.value)}
                    className="w-full text-xs font-mono px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => handleTestApiKeys('BINANCE')}
                    className="w-full py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700"
                  >
                    Binance API 연결 테스트
                  </button>
                </div>

                <hr className="border-slate-100 my-2" />

                {/* Upbit API Keys */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                    <span>Upbit Access & Secret Keys</span>
                    <span className={`text-[10px] ${hasApiKeys.upbit ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {hasApiKeys.upbit ? '● Key Configured' : '○ Not Configured'}
                    </span>
                  </div>
                  <input
                    type="password"
                    placeholder="Upbit Access Key"
                    value={upbitAccess}
                    onChange={(e) => setUpbitAccess(e.target.value)}
                    className="w-full text-xs font-mono px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="password"
                    placeholder="Upbit Secret Key"
                    value={upbitSecret}
                    onChange={(e) => setUpbitSecret(e.target.value)}
                    className="w-full text-xs font-mono px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={() => handleTestApiKeys('UPBIT')}
                    className="w-full py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-700"
                  >
                    Upbit API 연결 테스트
                  </button>
                </div>

                <button
                  onClick={handleSaveApiKeys}
                  className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-2xs mt-2"
                >
                  API 키 저장 및 백엔드 적용
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Mobile Bottom Navigation Bar */}
        <nav className="bg-white border-t border-slate-200 px-3 py-2 flex items-center justify-around shrink-0 shadow-sm">
          <button
            onClick={() => setActiveTab('chart')}
            className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl transition ${
              activeTab === 'chart' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <BarChart2 className="w-5 h-5" />
            <span className="text-[10px]">차트 & 매매</span>
          </button>

          <button
            onClick={() => setActiveTab('bot')}
            className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl transition ${
              activeTab === 'bot' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Sliders className="w-5 h-5" />
            <span className="text-[10px]">봇 설정</span>
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl transition relative ${
              activeTab === 'logs' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Terminal className="w-5 h-5" />
            <span className="text-[10px]">체결 로그</span>
            {logs.length > 0 && (
              <span className="absolute top-0 right-2 w-2 h-2 rounded-full bg-blue-600"></span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('account')}
            className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl transition ${
              activeTab === 'account' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Wallet className="w-5 h-5" />
            <span className="text-[10px]">내 계좌 & API</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
