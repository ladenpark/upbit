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
  Rocket,
  Brain,
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

  // Symbol Selection (Upbit Exclusive)
  const exchange = 'UPBIT';
  const [selectedCoin, setSelectedCoin] = useState<string>('KRW-ETH');

  // Bot Parameters
  const [isBotActive, setIsBotActive] = useState<boolean>(false);
  const [atrMultiplier, setAtrMultiplier] = useState<number>(3.0);
  const [orderRatio, setOrderRatio] = useState<number>(20); // % (20% + 24% + 28.8% fits under 85%)
  const [stopLossMultiplier, setStopLossMultiplier] = useState<number>(2.0);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  // Advanced DCA & Trailing Stop State
  const [dcaEnabled, setDcaEnabled] = useState<boolean>(true);
  const [maxSafetyOrders, setMaxSafetyOrders] = useState<number>(3);
  const [safetyOrderStepPercent, setSafetyOrderStepPercent] = useState<number>(2.0);
  const [safetyOrderCount, setSafetyOrderCount] = useState<number>(0);
  const [trailingStopEnabled, setTrailingStopEnabled] = useState<boolean>(true);
  const [trailingCallbackPercent, setTrailingCallbackPercent] = useState<number>(0.8);
  const [isTrailingActive, setIsTrailingActive] = useState<boolean>(false);
  const [trailingPeakPrice, setTrailingPeakPrice] = useState<number | null>(null);

  // Pyramiding & Partial Loss-Cut State
  const [pyramidingEnabled, setPyramidingEnabled] = useState<boolean>(true);
  const [maxPyramidingOrders, setMaxPyramidingOrders] = useState<number>(2);
  const [pyramidingStepPercent, setPyramidingStepPercent] = useState<number>(1.5);
  const [pyramidingCount, setPyramidingCount] = useState<number>(0);
  const [partialLossCutEnabled, setPartialLossCutEnabled] = useState<boolean>(true);
  const [partialLossCutPercent, setPartialLossCutPercent] = useState<number>(40);
  const [partialLossCutThreshold, setPartialLossCutThreshold] = useState<number>(4.5);

  // Trend-Aware Loss-Cut & Bottom Re-entry State
  const [trendAwareCutEnabled, setTrendAwareCutEnabled] = useState<boolean>(true);
  const [trendDropSpeedThreshold, setTrendDropSpeedThreshold] = useState<number>(1.8);
  const [awaitingReentry, setAwaitingReentry] = useState<boolean>(false);

  // Global State Machine States
  const [botLifecycleState, setBotLifecycleState] = useState<'RUNNING' | 'PAUSED' | 'HALTED' | 'ERROR'>('PAUSED');
  const [marketFeedState, setMarketFeedState] = useState<'LIVE' | 'STALE' | 'DISCONNECTED'>('LIVE');
  const [positionLifecycleState, setPositionLifecycleState] = useState<string>('FLAT');

  // AI Auto-Pilot State
  const [autoPilotEnabled, setAutoPilotEnabled] = useState<boolean>(true);
  const [marketRegime, setMarketRegime] = useState<'BULL' | 'SIDEWAYS' | 'BEAR'>('SIDEWAYS');

  // API Credentials State (Upbit Exclusive)
  const [upbitAccess, setUpbitAccess] = useState<string>(() => localStorage.getItem('UPBIT_ACCESS_KEY') || '');
  const [upbitSecret, setUpbitSecret] = useState<string>(() => localStorage.getItem('UPBIT_SECRET_KEY') || '');
  const [apiKeyTestStatus, setApiKeyTestStatus] = useState<string | null>(null);
  const [hasApiKeys, setHasApiKeys] = useState<{ upbit: boolean }>({ upbit: false });

  // Financial & Market State
  const [balance, setBalance] = useState<number>(10000000.0);
  const [initialBalance, setInitialBalance] = useState<number>(10000000.0);
  const [positionAmount, setPositionAmount] = useState<number>(0);
  const [entryPrice, setEntryPrice] = useState<number | null>(null);
  const [totalRealizedPnl, setTotalRealizedPnl] = useState<number>(0);
  const [totalTrades, setTotalTrades] = useState<number>(0);
  const [winTrades, setWinTrades] = useState<number>(0);
  const [realBalances, setRealBalances] = useState<Record<string, number>>({});
  const [nextOrderInfo, setNextOrderInfo] = useState<{
    type: string;
    budgetKrw: number;
    unitPercent: number;
    scaleMultiplier: number;
    targetPriceLabel: string;
    pages?: Array<{
      category: 'DIP' | 'BREAKOUT' | 'DCA' | 'PYRAMID' | 'COMPLETED';
      categoryLabel: string;
      type: string;
      budgetKrw: number;
      unitPercent: number;
      scaleMultiplier: number;
      targetPriceLabel: string;
      themeColor: 'indigo' | 'emerald' | 'amber' | 'blue';
    }>;
  } | null>(null);
  const [nextOrderPageIndex, setNextOrderPageIndex] = useState<number>(0);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);

  // Price & Indicators State
  const [currentPrice, setCurrentPrice] = useState<number>(2650000.0);
  const [atrValue, setAtrValue] = useState<number>(35000.0);
  const [baselineValue, setBaselineValue] = useState<number>(2650000.0);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [logs, setLogs] = useState<TradeLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<TradeLog | null>(null);

  // PWA Install State
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const [showIosGuide, setShowIosGuide] = useState<boolean>(false);
  const [showSamsungGuide, setShowSamsungGuide] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Check PWA Standalone & listen for install prompt
  useEffect(() => {
    const handleBeforeInstall = (e: any) => {
      e.preventDefault();
      setInstallPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    if (window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone) {
      setIsStandalone(true);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  const handleInstallPwa = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallPrompt(null);
        setIsStandalone(true);
      }
    } else {
      const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      const isSamsung = /SamsungBrowser/i.test(navigator.userAgent);
      if (isIos) {
        setShowIosGuide(true);
      } else if (isSamsung) {
        setShowSamsungGuide(true);
      } else {
        setShowSamsungGuide(true);
      }
    }
  };

  // Connect to Backend WebSocket with Auto-Reconnect
  useEffect(() => {
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let isUnmounted = false;

    const connectWs = () => {
      if (isUnmounted) return;
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
              setSelectedCoin(s.params.symbol);
              setAtrMultiplier(s.params.atrMultiplier);
              setOrderRatio(s.params.orderRatio);
              setStopLossMultiplier(s.params.stopLossMultiplier);
              if (s.params.dcaEnabled !== undefined) setDcaEnabled(s.params.dcaEnabled);
              if (s.params.maxSafetyOrders !== undefined) setMaxSafetyOrders(s.params.maxSafetyOrders);
              if (s.params.safetyOrderStepPercent !== undefined) setSafetyOrderStepPercent(s.params.safetyOrderStepPercent);
              if (s.params.trailingStopEnabled !== undefined) setTrailingStopEnabled(s.params.trailingStopEnabled);
              if (s.params.trailingCallbackPercent !== undefined) setTrailingCallbackPercent(s.params.trailingCallbackPercent);
              if (s.params.pyramidingEnabled !== undefined) setPyramidingEnabled(s.params.pyramidingEnabled);
              if (s.params.maxPyramidingOrders !== undefined) setMaxPyramidingOrders(s.params.maxPyramidingOrders);
              if (s.params.pyramidingStepPercent !== undefined) setPyramidingStepPercent(s.params.pyramidingStepPercent);
              if (s.params.partialLossCutEnabled !== undefined) setPartialLossCutEnabled(s.params.partialLossCutEnabled);
              if (s.params.partialLossCutPercent !== undefined) setPartialLossCutPercent(s.params.partialLossCutPercent);
              if (s.params.partialLossCutThreshold !== undefined) setPartialLossCutThreshold(s.params.partialLossCutThreshold);
              if (s.params.trendAwareCutEnabled !== undefined) setTrendAwareCutEnabled(s.params.trendAwareCutEnabled);
              if (s.params.trendDropSpeedThreshold !== undefined) setTrendDropSpeedThreshold(s.params.trendDropSpeedThreshold);
              if (s.params.autoPilotEnabled !== undefined) setAutoPilotEnabled(s.params.autoPilotEnabled);
            }
            if (s.botState !== undefined) setBotLifecycleState(s.botState);
            if (s.marketState !== undefined) setMarketFeedState(s.marketState);
            if (s.marketRegime !== undefined) setMarketRegime(s.marketRegime);
            if (s.initialBalance !== undefined) setInitialBalance(s.initialBalance);
            if (s.balance !== undefined) setBalance(s.balance);
            if (s.position) {
              setPositionAmount(s.position.amount);
              setEntryPrice(s.position.entryPrice);
              if (s.position.state) setPositionLifecycleState(s.position.state);
            }
            if (s.safetyOrderCount !== undefined) setSafetyOrderCount(s.safetyOrderCount);
            if (s.pyramidingCount !== undefined) setPyramidingCount(s.pyramidingCount);
            if (s.awaitingReentry !== undefined) setAwaitingReentry(s.awaitingReentry);
            if (s.isTrailingActive !== undefined) setIsTrailingActive(s.isTrailingActive);
            if (s.trailingPeakPrice !== undefined) setTrailingPeakPrice(s.trailingPeakPrice);
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
            if (s.nextOrderInfo) setNextOrderInfo(s.nextOrderInfo);
          } else if (data.type === 'TEST_API_KEYS_RESULT') {
            const res = data.payload;
            if (res.success) {
              if (res.balances) setRealBalances(res.balances);
              const assets = res.balances ? Object.keys(res.balances).join(', ') : 'OK';
              setApiKeyTestStatus(`✅ Upbit API 연결 성공! 실시간 보유 자산 (${assets}) 수신 완료`);
            } else {
              setApiKeyTestStatus(`❌ Upbit API 연결 실패: ${res.error}`);
            }
          }
        } catch (err) {
          console.error('Error parsing backend WS message:', err);
        }
      };

      ws.onclose = () => {
        console.log('Backend WS Disconnected. Retrying in 2s...');
        setWsConnected(false);
        if (!isUnmounted) {
          reconnectTimeout = setTimeout(connectWs, 2000);
        }
      };

      ws.onerror = (err) => {
        console.warn('Backend WS Error:', err);
        ws.close();
      };
    };

    connectWs();

    return () => {
      isUnmounted = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Send config update to backend
  const sendWsCommand = (type: string, payload: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  };

  const handleCoinChange = (newCoin: string) => {
    setSelectedCoin(newCoin);
    sendWsCommand('UPDATE_CONFIG', { exchange: 'UPBIT', symbol: newCoin });
  };

  const handleParamsChange = (newParams: {
    atrMultiplier?: number;
    orderRatio?: number;
    stopLossMultiplier?: number;
    dcaEnabled?: boolean;
    maxSafetyOrders?: number;
    safetyOrderStepPercent?: number;
    trailingStopEnabled?: boolean;
    trailingCallbackPercent?: number;
    pyramidingEnabled?: boolean;
    maxPyramidingOrders?: number;
    pyramidingStepPercent?: number;
    partialLossCutEnabled?: boolean;
    partialLossCutPercent?: number;
    partialLossCutThreshold?: number;
    trendAwareCutEnabled?: boolean;
    trendDropSpeedThreshold?: number;
    autoPilotEnabled?: boolean;
  }) => {
    if (newParams.atrMultiplier !== undefined) setAtrMultiplier(newParams.atrMultiplier);
    if (newParams.orderRatio !== undefined) setOrderRatio(newParams.orderRatio);
    if (newParams.stopLossMultiplier !== undefined) setStopLossMultiplier(newParams.stopLossMultiplier);
    if (newParams.dcaEnabled !== undefined) setDcaEnabled(newParams.dcaEnabled);
    if (newParams.maxSafetyOrders !== undefined) setMaxSafetyOrders(newParams.maxSafetyOrders);
    if (newParams.safetyOrderStepPercent !== undefined) setSafetyOrderStepPercent(newParams.safetyOrderStepPercent);
    if (newParams.trailingStopEnabled !== undefined) setTrailingStopEnabled(newParams.trailingStopEnabled);
    if (newParams.trailingCallbackPercent !== undefined) setTrailingCallbackPercent(newParams.trailingCallbackPercent);
    if (newParams.pyramidingEnabled !== undefined) setPyramidingEnabled(newParams.pyramidingEnabled);
    if (newParams.maxPyramidingOrders !== undefined) setMaxPyramidingOrders(newParams.maxPyramidingOrders);
    if (newParams.pyramidingStepPercent !== undefined) setPyramidingStepPercent(newParams.pyramidingStepPercent);
    if (newParams.partialLossCutEnabled !== undefined) setPartialLossCutEnabled(newParams.partialLossCutEnabled);
    if (newParams.partialLossCutPercent !== undefined) setPartialLossCutPercent(newParams.partialLossCutPercent);
    if (newParams.partialLossCutThreshold !== undefined) setPartialLossCutThreshold(newParams.partialLossCutThreshold);
    if (newParams.trendAwareCutEnabled !== undefined) setTrendAwareCutEnabled(newParams.trendAwareCutEnabled);
    if (newParams.trendDropSpeedThreshold !== undefined) setTrendDropSpeedThreshold(newParams.trendDropSpeedThreshold);
    if (newParams.autoPilotEnabled !== undefined) setAutoPilotEnabled(newParams.autoPilotEnabled);
    sendWsCommand('UPDATE_CONFIG', newParams);
  };

  const handleToggleBot = () => {
    sendWsCommand('TOGGLE_BOT', { isBotActive: !isBotActive });
  };

  const handleTestApiKeys = () => {
    if (!upbitAccess || !upbitSecret) {
      setApiKeyTestStatus('❌ Upbit Access Key와 Secret Key를 먼저 입력해 주세요.');
      return;
    }
    setApiKeyTestStatus('⏳ Upbit REST API 연결 테스트 중...');
    sendWsCommand('TEST_API_KEYS', {
      exchange: 'UPBIT',
      upbitAccessKey: upbitAccess,
      upbitSecretKey: upbitSecret
    });
  };

  const handleSaveApiKeys = () => {
    sendWsCommand('SAVE_API_KEYS', {
      upbitAccessKey: upbitAccess,
      upbitSecretKey: upbitSecret
    });
    setApiKeyTestStatus('🔑 Upbit API 키가 백엔드에 안전하게 저장되었습니다.');
  };

  const formatPrice = (p: number, symbol = selectedCoin) => {
    if (p === undefined || p === null || isNaN(p)) return '0';
    return `₩${Math.round(p).toLocaleString('ko-KR')}`;
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
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
      } else if (type === 'SELL') {
        osc.frequency.setValueAtTime(900, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else if (type === 'STOP') {
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
      minPrice = Math.min(minPrice, p.price, p.lowerBand);
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

    // Indicator Lines (ATR Band - Upper & Lower Bands & Baseline)
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

    ctx.lineWidth = 2.5;
    priceHistory.forEach((pt, idx) => {
      const x = getX(idx);
      const y = getY(pt.price);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Draw trade event marker badges
    priceHistory.forEach((pt, idx) => {
      if (pt.event) {
        const x = getX(idx);
        const y = getY(pt.price);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, 2 * Math.PI);
        if (pt.event === 'BUY') {
          ctx.fillStyle = '#10b981';
        } else if (pt.event === 'SELL') {
          ctx.fillStyle = '#3b82f6';
        } else {
          ctx.fillStyle = '#ef4444';
        }
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    // Current Price Pulse Point
    const lastPoint = priceHistory[priceHistory.length - 1];
    const curX = getX(priceHistory.length - 1);
    const curY = getY(lastPoint.price);

    ctx.beginPath();
    ctx.arc(curX, curY, 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = '#1d4ed8';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Current price tooltip banner on right axis
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(width - padding.right + 4, curY - 9, padding.right - 6, 18);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(formatPrice(lastPoint.price, selectedCoin), width - padding.right + 7, curY + 3.5);
  }, [priceHistory, selectedCoin, exchange, positionAmount, entryPrice, safetyOrderStepPercent, pyramidingStepPercent]);

  // Position calculations
  const unrealizedPnl = useMemo(() => {
    if (positionAmount === 0 || !entryPrice) return 0;
    return (currentPrice - entryPrice) * positionAmount;
  }, [positionAmount, entryPrice, currentPrice]);

  const unrealizedPnlPercent = useMemo(() => {
    if (positionAmount === 0 || !entryPrice) return 0;
    return ((currentPrice - entryPrice) / entryPrice) * 100;
  }, [positionAmount, entryPrice, currentPrice]);

  const calculatedStopLoss = useMemo(() => {
    const lastPoint = priceHistory[priceHistory.length - 1];
    if (lastPoint && lastPoint.stopLoss) return lastPoint.stopLoss;
    const lower = baselineValue - atrValue * atrMultiplier;
    return Math.round(lower - atrValue * stopLossMultiplier);
  }, [priceHistory, baselineValue, atrValue, atrMultiplier, stopLossMultiplier]);

  const stopLossPercent = useMemo(() => {
    const refPrice = positionAmount > 0 && entryPrice ? entryPrice : currentPrice;
    if (refPrice <= 0) return 0;
    return ((calculatedStopLoss - refPrice) / refPrice) * 100;
  }, [calculatedStopLoss, positionAmount, entryPrice, currentPrice]);

  const isKrwCurrency = exchange === 'UPBIT' || selectedCoin.startsWith('KRW-');

  const realTotalEquity = useMemo(() => {
    if (isKrwCurrency) {
      const krw = realBalances['KRW'] || 0;
      const coinKey = selectedCoin.replace('KRW-', '');
      const coinAmount = realBalances[coinKey] || 0;
      const total = krw + coinAmount * currentPrice;
      return total > 0 ? total : null;
    } else {
      const usdt = realBalances['USDT'] || 0;
      const coinKey = selectedCoin.split('/')[0] || 'BTC';
      const coinAmount = realBalances[coinKey] || 0;
      const total = usdt + coinAmount * currentPrice;
      return total > 0 ? total : null;
    }
  }, [isKrwCurrency, realBalances, selectedCoin, currentPrice]);

  const currentEquity = realTotalEquity !== null
    ? realTotalEquity
    : (balance + positionAmount * currentPrice);

  const totalReturnPercent = initialBalance > 0
    ? ((currentEquity - initialBalance) / initialBalance) * 100
    : 0;

  const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : '0.0';

  const handleManualBuy = () => {
    sendWsCommand('MANUAL_TRADE', { side: 'BUY' });
    playBeep('BUY');
  };

  const handleManualSell = () => {
    sendWsCommand('MANUAL_TRADE', { side: 'SELL' });
    playBeep('SELL');
  };

  const getBotStateBadge = () => {
    switch (botLifecycleState) {
      case 'RUNNING':
        return { text: '가동 중', bg: 'bg-emerald-100 text-emerald-800 animate-pulse' };
      case 'HALTED':
        return { text: '긴급 정지', bg: 'bg-rose-100 text-rose-800' };
      case 'ERROR':
        return { text: '오류', bg: 'bg-rose-100 text-rose-800' };
      default:
        return { text: '대기 중', bg: 'bg-slate-100 text-slate-600' };
    }
  };

  const getPositionStateBadge = () => {
    switch (positionLifecycleState) {
      case 'ENTRY_FILLED':
        return { text: '1차 진입', bg: 'bg-blue-100 text-blue-800' };
      case 'DCA_MODE':
        return { text: `물타기 ${safetyOrderCount > 0 ? safetyOrderCount + '차' : '진행'}`, bg: 'bg-indigo-100 text-indigo-800' };
      case 'DEFENSIVE':
        return { text: '방어(현금확보)', bg: 'bg-amber-100 text-amber-800' };
      case 'EMERGENCY_EXIT':
        return { text: '긴급탈출', bg: 'bg-rose-100 text-rose-800' };
      case 'COOLDOWN':
        return { text: '쿨다운', bg: 'bg-purple-100 text-purple-800' };
      case 'TAKE_PROFIT':
        return { text: '익절 추적 중', bg: 'bg-emerald-100 text-emerald-800' };
      default:
        return { text: '관망 중', bg: 'bg-slate-100 text-slate-500' };
    }
  };

  const getMarketStateBadge = () => {
    switch (marketFeedState) {
      case 'LIVE':
        return { dot: 'bg-emerald-500', text: '실시간 정상' };
      case 'STALE':
        return { dot: 'bg-amber-500', text: '시세 지연(주문대기)' };
      default:
        return { dot: 'bg-rose-500', text: '연결 단절' };
    }
  };

  const botBadge = getBotStateBadge();
  const posBadge = getPositionStateBadge();
  const mktBadge = getMarketStateBadge();

  return (
    <div className="h-[100dvh] sm:min-h-screen bg-slate-100 flex flex-col items-center justify-center sm:p-4 text-slate-900 font-['Plus_Jakarta_Sans',sans-serif] overflow-hidden sm:overflow-auto">
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

      {/* Main App Container */}
      <div
        className={`w-full max-w-sm bg-white sm:rounded-3xl shadow-xl border border-slate-200 overflow-hidden flex flex-col transition-all duration-300 ${
          deviceFrameMode ? 'h-[100dvh] sm:h-[844px]' : 'h-[100dvh]'
        }`}
      >
        {/* Top Status Indicators (PWA & Offline Banner) */}
        {!wsConnected && (
          <div className="bg-rose-500 text-white text-[11px] font-bold px-3 py-1 text-center animate-pulse flex items-center justify-center gap-1.5 shrink-0 z-50">
            <RefreshCw className="w-3 h-3 animate-spin" />
            <span>실시간 백엔드 연결 중...</span>
          </div>
        )}

        {/* PWA Install Banner */}
        {installPrompt && !isStandalone && (
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-3.5 py-2 flex items-center justify-between text-xs shrink-0 shadow-xs z-40">
            <div className="flex items-center gap-2">
              <Download className="w-4 h-4 shrink-0" />
              <span className="font-semibold text-[11px]">홈 화면에 앱으로 설치</span>
            </div>
            <button
              onClick={async () => {
                if (installPrompt) {
                  installPrompt.prompt();
                  await installPrompt.userChoice;
                  setInstallPrompt(null);
                }
              }}
              className="px-2.5 py-1 bg-white text-blue-600 rounded-lg font-bold text-[10px] shadow-xs active:scale-95"
            >
              설치하기
            </button>
          </div>
        )}

        {/* Mobile Header Bar */}
        <header className="bg-white px-3.5 py-2 flex items-center justify-between border-b border-slate-200 shadow-2xs shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold shadow-2xs shrink-0">
              <Activity className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <h1 className="font-extrabold text-slate-900 text-sm leading-none">ATR BOT</h1>
                <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded-full shrink-0 ${botBadge.bg}`}>
                  {botBadge.text}
                </span>
                <span className={`text-[8.5px] font-bold px-1.5 py-0.2 rounded-full shrink-0 ${posBadge.bg}`}>
                  {posBadge.text}
                </span>
              </div>
              <p className="text-[10px] text-slate-400 font-medium mt-0.5 whitespace-nowrap truncate flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full inline-block ${mktBadge.dot}`}></span>
                <span>업비트 · {mktBadge.text}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1 items-end shrink-0">
            {/* Symbol Selector (Upbit) */}
            <select
              value={selectedCoin}
              onChange={(e) => handleCoinChange(e.target.value)}
              className="bg-blue-50 font-bold text-[10px] text-blue-900 px-2 py-1 rounded-lg border border-blue-200 focus:outline-none cursor-pointer w-28 text-center"
            >
              <option value="KRW-ETH">KRW-ETH</option>
              <option value="KRW-BTC">KRW-BTC</option>
              <option value="KRW-SOL">KRW-SOL</option>
              <option value="KRW-XRP">KRW-XRP</option>
              <option value="KRW-DOGE">KRW-DOGE</option>
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
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 pb-6 overscroll-contain">
          {activeTab === 'chart' && (
            <>
              {/* PWA Install Banner */}
              {!isStandalone && (
                <div className="bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-700 px-3.5 py-2.5 rounded-2xl text-white shadow-sm flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0">
                      <Smartphone className="w-4 h-4 text-white" />
                    </div>
                    <div>
                      <div className="text-xs font-extrabold leading-tight">ATR Bot 앱 설치하기</div>
                      <div className="text-[10px] text-blue-100 mt-0.5">홈 화면 아이콘으로 브라우저 없이 실행</div>
                    </div>
                  </div>
                  <button
                    onClick={handleInstallPwa}
                    className="px-3 py-1.5 bg-white text-blue-700 hover:bg-blue-50 font-extrabold text-[11px] rounded-xl shadow-xs transition shrink-0 cursor-pointer"
                  >
                    앱 설치
                  </button>
                </div>
              )}

              {/* Samsung / General Browser Guide Modal */}
              {showSamsungGuide && (
                <div className="bg-slate-900 text-white p-3.5 rounded-2xl shadow-lg border border-slate-700 text-xs space-y-2 animate-in fade-in duration-200">
                  <div className="flex items-center justify-between font-extrabold text-blue-400">
                    <span className="flex items-center gap-1.5">
                      <Smartphone className="w-4 h-4" />
                      삼성 인터넷 / 안드로이드 앱 설치 방법
                    </span>
                    <button onClick={() => setShowSamsungGuide(false)} className="text-slate-400 hover:text-white p-1">✕</button>
                  </div>
                  <div className="space-y-1.5 text-[11px] text-slate-300">
                    <div className="flex items-start gap-1.5">
                      <span className="font-bold text-blue-400">방법 1:</span>
                      <span>주소창 오른쪽 끝의 <strong>다운로드 아이콘(↓ 또는 +)</strong>을 누르세요.</span>
                    </div>
                    <div className="flex items-start gap-1.5">
                      <span className="font-bold text-blue-400">방법 2:</span>
                      <span>하단 <strong>메뉴 버튼(≡)</strong> ➡️ <strong>[현재 페이지 추가]</strong> ➡️ <strong>[홈 화면]</strong>을 선택하세요.</span>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowSamsungGuide(false)}
                    className="w-full py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 font-bold text-white text-[11px]"
                  >
                    확인
                  </button>
                </div>
              )}

              {/* AI Auto-Pilot Regime Status Card */}
              <div className={`p-3 rounded-2xl border transition-all ${
                marketRegime === 'BULL'
                  ? 'bg-gradient-to-r from-emerald-950 to-slate-900 text-white border-emerald-500/40 shadow-xs'
                  : marketRegime === 'BEAR'
                  ? 'bg-gradient-to-r from-rose-950 to-slate-900 text-white border-rose-500/40 shadow-xs'
                  : 'bg-gradient-to-r from-slate-900 to-indigo-950 text-white border-indigo-500/40 shadow-xs'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-xl ${
                      marketRegime === 'BULL' ? 'bg-emerald-500/20 text-emerald-400' : marketRegime === 'BEAR' ? 'bg-rose-500/20 text-rose-400' : 'bg-indigo-500/20 text-indigo-400'
                    }`}>
                      <Brain className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-extrabold">
                          {marketRegime === 'BULL' && '🟢 대세 상승 국면 (BULL)'}
                          {marketRegime === 'BEAR' && '🔴 대세 하락 국면 (BEAR)'}
                          {marketRegime === 'SIDEWAYS' && '🟡 박스권 횡보 국면 (SIDEWAYS)'}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-white/20 font-bold uppercase">
                          Auto-Pilot {autoPilotEnabled ? 'ON' : 'OFF'}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-300 mt-0.5">
                        {marketRegime === 'BULL' && '코인 60% 비중 확대 + 상승 불타기 및 최고가 익절 가동'}
                        {marketRegime === 'BEAR' && '현금 80% 안전 세이브 + 극단적 바닥 매수 모드 가동'}
                        {marketRegime === 'SIDEWAYS' && '코인 35% : 현금 65% + 박스권 단타 회전 매매 가동'}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleParamsChange({ autoPilotEnabled: !autoPilotEnabled })}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      autoPilotEnabled ? 'bg-emerald-500' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        autoPilotEnabled ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>

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

                <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-slate-400">현재 포지션</span>
                      {awaitingReentry && (
                        <span className="text-[9px] font-extrabold text-cyan-700 bg-cyan-100 px-1.5 py-0.2 rounded-md animate-pulse flex items-center gap-0.5">
                          🎯 바닥 재매수 대기
                        </span>
                      )}
                      {!awaitingReentry && isTrailingActive && (
                        <span className="text-[9px] font-extrabold text-emerald-600 bg-emerald-100 px-1.5 py-0.2 rounded-md animate-pulse flex items-center gap-0.5">
                          🔥 Trailing TP
                        </span>
                      )}
                      {!awaitingReentry && !isTrailingActive && pyramidingCount > 0 && (
                        <span className="text-[9px] font-extrabold text-amber-700 bg-amber-100 px-1.5 py-0.2 rounded-md flex items-center gap-0.5">
                          🚀 불타기 {pyramidingCount}/{maxPyramidingOrders}
                        </span>
                      )}
                      {!awaitingReentry && !isTrailingActive && pyramidingCount === 0 && safetyOrderCount > 0 && (
                        <span className="text-[9px] font-extrabold text-indigo-600 bg-indigo-100 px-1.5 py-0.2 rounded-md">
                          💧 DCA {safetyOrderCount}/{maxSafetyOrders}
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-extrabold mono text-indigo-700 mt-0.5 truncate">
                      {positionAmount > 0 ? `LONG ${positionAmount} @ ${formatPrice(entryPrice || currentPrice)}` : 'FLAT (무포지션)'}
                    </div>
                  </div>
                  <div className={`text-[10px] font-bold mt-1 ${unrealizedPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    손익: {unrealizedPnl >= 0 ? '+' : ''}{formatPrice(unrealizedPnl)} ({unrealizedPnlPercent.toFixed(1)}%)
                  </div>
                </div>
              </div>

              {/* Swipeable Next Order Unit & Target Budget Card */}
              {(() => {
                const pages = nextOrderInfo?.pages && nextOrderInfo.pages.length > 0
                  ? nextOrderInfo.pages
                  : [
                      {
                        category: (positionAmount > 0 ? 'DCA' : 'DIP') as any,
                        categoryLabel: positionAmount > 0 ? '하락 시 물타기' : '저점 눌림목 매수',
                        type: positionAmount > 0 ? 'DCA 1차 물타기' : '1차 저점 진입',
                        budgetKrw: currentEquity * ((orderRatio || 25) / 100),
                        unitPercent: orderRatio || 25,
                        scaleMultiplier: 1.0,
                        targetPriceLabel: '하단 밴드 터치 또는 돌파',
                        themeColor: 'indigo' as const
                      },
                      {
                        category: (positionAmount > 0 ? 'PYRAMID' : 'BREAKOUT') as any,
                        categoryLabel: positionAmount > 0 ? '상승 시 불타기' : '상승 추세 돌파 매수',
                        type: positionAmount > 0 ? '상승 불타기 1차' : '1차 돌파 진입',
                        budgetKrw: currentEquity * ((orderRatio || 25) / 100),
                        unitPercent: orderRatio || 25,
                        scaleMultiplier: 1.0,
                        targetPriceLabel: positionAmount > 0 ? '+1.5% 상승 돌파 시' : '기준선 상향 돌파 시',
                        themeColor: 'amber' as const
                      }
                    ];
                const currentPage = pages[nextOrderPageIndex % pages.length];
                const pageNum = (nextOrderPageIndex % pages.length) + 1;
                const totalPages = pages.length;

                const isAmber = currentPage.themeColor === 'amber';
                const isEmerald = currentPage.themeColor === 'emerald';
                const isBlue = currentPage.themeColor === 'blue';

                const handleCardTouchStart = (e: React.TouchEvent) => {
                  setTouchStartX(e.touches[0].clientX);
                };

                const handleCardTouchEnd = (e: React.TouchEvent) => {
                  if (touchStartX === null) return;
                  const touchEndX = e.changedTouches[0].clientX;
                  const diff = touchStartX - touchEndX;
                  if (diff > 35) {
                    setNextOrderPageIndex((prev) => (prev + 1) % pages.length);
                  } else if (diff < -35) {
                    setNextOrderPageIndex((prev) => (prev - 1 + pages.length) % pages.length);
                  }
                  setTouchStartX(null);
                };

                return (
                  <div
                    onTouchStart={handleCardTouchStart}
                    onTouchEnd={handleCardTouchEnd}
                    className={`p-3.5 rounded-2xl border transition-all select-none relative overflow-hidden ${
                      isAmber
                        ? 'bg-gradient-to-br from-amber-50/90 via-orange-50/60 to-slate-50 border-amber-200/80 shadow-2xs'
                        : isEmerald
                        ? 'bg-gradient-to-br from-emerald-50/90 via-teal-50/60 to-slate-50 border-emerald-200/80 shadow-2xs'
                        : isBlue
                        ? 'bg-gradient-to-br from-blue-50/90 via-sky-50/60 to-slate-50 border-blue-200/80 shadow-2xs'
                        : 'bg-gradient-to-br from-indigo-50/90 via-blue-50/70 to-slate-50 border-indigo-200/80 shadow-2xs'
                    }`}
                  >
                    {/* Header: Title with (1/2) Page Indicator and Switch Button */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full animate-pulse ${
                          isAmber ? 'bg-amber-600' : isEmerald ? 'bg-emerald-600' : isBlue ? 'bg-blue-600' : 'bg-indigo-600'
                        }`} />
                        <span className="text-[11px] font-extrabold text-slate-800 flex items-center gap-1">
                          다음 매수 예상 금액
                          <span className={`px-1.5 py-0.2 rounded-md text-[10px] font-bold ${
                            isAmber ? 'bg-amber-200/80 text-amber-900' : isEmerald ? 'bg-emerald-200/80 text-emerald-900' : isBlue ? 'bg-blue-200/80 text-blue-900' : 'bg-indigo-200/80 text-indigo-900'
                          }`}>
                            ({pageNum}/{totalPages})
                          </span>
                        </span>
                      </div>

                      {/* Right: Badge & Page Switcher */}
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[9px] font-extrabold px-2 py-0.5 rounded-md text-white shadow-2xs tracking-tight ${
                          isAmber ? 'bg-amber-600' : isEmerald ? 'bg-emerald-600' : isBlue ? 'bg-blue-600' : 'bg-indigo-600'
                        }`}>
                          {currentPage.type}
                        </span>
                        <button
                          onClick={() => setNextOrderPageIndex((prev) => (prev + 1) % pages.length)}
                          className="px-1.5 py-0.5 rounded-lg bg-white/90 border border-slate-200 flex items-center gap-0.5 text-[9px] text-slate-700 font-bold hover:bg-white shadow-2xs cursor-pointer active:scale-95 transition"
                          title="플랜 전환"
                        >
                          <span>{pageNum === 1 ? '불타기' : '물타기'}</span>
                          <span className="text-[10px]">⇄</span>
                        </button>
                      </div>
                    </div>

                    {/* Content: Budget and Trigger Condition */}
                    <div className="flex items-baseline justify-between">
                      <div>
                        <div className={`text-base font-black mono tracking-tight ${
                          isAmber ? 'text-amber-900' : isEmerald ? 'text-emerald-900' : isBlue ? 'text-blue-900' : 'text-indigo-900'
                        }`}>
                          {currentPage.budgetKrw > 0
                            ? formatPrice(currentPage.budgetKrw)
                            : formatPrice(currentEquity * ((orderRatio || 25) / 100))}
                        </div>
                        <div className="text-[10px] text-slate-500 font-medium mt-0.5">
                          {currentPage.categoryLabel} · 총자산의 {orderRatio || 25}% 
                          {currentPage.scaleMultiplier > 1 ? ` (×${currentPage.scaleMultiplier}배 스케일링)` : ' (기본 1 Unit)'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-semibold text-slate-400">진입 예상 타이밍</div>
                        <div className="text-[11px] font-bold text-slate-700 mt-0.5">
                          {currentPage.targetPriceLabel}
                        </div>
                      </div>
                    </div>

                    {/* Bottom Swipe Dot Indicators */}
                    <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-200/50">
                      <div className="flex items-center gap-1.5">
                        {pages.map((_, idx) => (
                          <button
                            key={idx}
                            onClick={() => setNextOrderPageIndex(idx)}
                            className={`h-1.5 rounded-full transition-all cursor-pointer ${
                              idx === (nextOrderPageIndex % pages.length)
                                ? `w-5 ${isAmber ? 'bg-amber-600' : isEmerald ? 'bg-emerald-600' : isBlue ? 'bg-blue-600' : 'bg-indigo-600'}`
                                : 'w-1.5 bg-slate-300 hover:bg-slate-400'
                            }`}
                          />
                        ))}
                      </div>
                      <span className="text-[9px] text-slate-400 font-medium flex items-center gap-0.5">
                        👆 좌우로 스와이프하여 {pageNum === 1 ? '불타기(2/2)' : '물타기(1/2)'} 확인
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Real-time Canvas Chart */}
              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <BarChart2 className="w-3.5 h-3.5 text-blue-600" />
                    <span className="text-xs font-bold text-slate-800">ATR 밴드 실시간 시세</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] font-semibold flex-wrap justify-end">
                    <span className="text-emerald-600 flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>익절선</span>
                    <span className="text-indigo-600 flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>매수선</span>
                    <span className="px-1.5 py-0.5 rounded-md bg-rose-50 border border-rose-200/80 text-rose-600 font-extrabold flex items-center gap-1 shadow-2xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
                      손절: {formatPrice(calculatedStopLoss)} ({stopLossPercent >= 0 ? '+' : ''}{stopLossPercent.toFixed(1)}%)
                    </span>
                  </div>
                </div>

                <div className="relative w-full h-[220px] bg-slate-50/80 rounded-xl border border-slate-200 overflow-hidden">
                  <canvas ref={canvasRef} className="w-full h-full block" />
                  <div className="absolute top-1.5 left-2 text-[9px] text-slate-400 mono flex items-center gap-1">
                    <Radio className="w-3 h-3 text-emerald-500 animate-pulse" />
                    WebSocket 수신 중
                  </div>
                  <div className="absolute bottom-1.5 right-2 text-[8.5px] text-rose-600 font-bold mono bg-white/90 px-1.5 py-0.5 rounded-md border border-rose-200/60 shadow-2xs backdrop-blur-xs">
                    🛡️ 마지노선 손절: {formatPrice(calculatedStopLoss)} ({stopLossPercent >= 0 ? '+' : ''}{stopLossPercent.toFixed(1)}%)
                  </div>
                </div>

                {/* Quick Manual Action Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={handleManualBuy}
                    disabled={balance < 5000}
                    className="py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-1 shadow-2xs active:scale-98 transition cursor-pointer"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" />
                    <span>{positionAmount > 0 ? '수동 추가 매수' : '수동 매수 (BUY)'}</span>
                  </button>
                  <button
                    onClick={handleManualSell}
                    disabled={positionAmount === 0}
                    className="py-2 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-1 shadow-2xs active:scale-98 transition cursor-pointer"
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
                      onClick={() => setSelectedLog(log)}
                      className={`p-2 rounded-lg border flex items-center justify-between cursor-pointer hover:opacity-90 active:scale-98 transition ${
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
              {/* AI Auto-Pilot Live Status Banner */}
              {autoPilotEnabled && (
                <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-3.5 rounded-2xl shadow-sm border border-indigo-500/40 space-y-1.5 animate-in fade-in">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-extrabold text-xs text-indigo-300">
                      <Brain className="w-4 h-4 text-cyan-400" />
                      <span>⚡ AI 오토파일럿 실시간 자동 제어 중</span>
                    </div>
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-400/30 font-mono font-bold animate-pulse">
                      LIVE TUNED
                    </span>
                  </div>
                  <p className="text-[10.5px] text-slate-300 leading-snug">
                    시장 추세 기울기와 변동성을 연속 계산하여 <strong>ATR({atrMultiplier.toFixed(1)}x)</strong>, <strong>진입비중({orderRatio}%)</strong>, <strong>DCA간격(-{safetyOrderStepPercent.toFixed(1)}%)</strong>을 실시간 <strong>미세조정</strong> 중입니다.
                  </p>
                </div>
              )}

              {/* Active Bot Lock Warning Banner */}
              {isBotActive && (
                <div className="bg-amber-50 border border-amber-300 text-amber-950 p-3 rounded-2xl flex items-center gap-2.5 text-xs shadow-xs animate-in fade-in">
                  <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
                  <div className="leading-tight">
                    <div className="font-extrabold">🔒 봇 가동 중 (설정 잠금 상태)</div>
                    <div className="text-[11px] text-amber-800 mt-0.5">
                      오작동 및 터치 실수를 방지하기 위해 설정이 잠겨 있습니다. 설정을 수정하려면 아래 <strong>[자동 봇 정지]</strong>를 누르세요.
                    </div>
                  </div>
                </div>
              )}

              {/* Disabled Fieldset Wrapper when Bot is Active */}
              <fieldset disabled={isBotActive} className={`space-y-3 transition-opacity ${isBotActive ? 'opacity-50 pointer-events-none cursor-not-allowed select-none' : ''}`}>
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
                    <span className="text-slate-700">비상 손절 배수 (SL)</span>
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
                    <span>2.0x (권장)</span>
                    <span>3.0x (여유)</span>
                  </div>
                </div>
              </div>

              {/* Trailing Take-Profit (상승장 수익 극대화) Card */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">트레일링 익절 (Trailing TP)</h3>
                      <p className="text-[10px] text-slate-400">급상승 시 최고점까지 끝까지 추적</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleParamsChange({ trailingStopEnabled: !trailingStopEnabled })}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      trailingStopEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        trailingStopEnabled ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {trailingStopEnabled && (
                  <div className="space-y-1.5 pt-1">
                    <div className="flex justify-between text-xs font-bold">
                      <span className="text-slate-700">고점 대비 꺾임 콜백 (Callback)</span>
                      <span className="text-emerald-600 mono">{trailingCallbackPercent.toFixed(1)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.3"
                      max="2.5"
                      step="0.1"
                      value={trailingCallbackPercent}
                      onChange={(e) => handleParamsChange({ trailingCallbackPercent: parseFloat(e.target.value) })}
                      className="w-full accent-emerald-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                    />
                    <div className="flex justify-between text-[10px] text-slate-400">
                      <span>0.3% (빠른익절)</span>
                      <span>0.8% (추천)</span>
                      <span>2.5% (여유)</span>
                    </div>
                    <p className="text-[10px] text-slate-500 bg-emerald-50/60 p-2 rounded-xl border border-emerald-100">
                      💡 상단 밴드 돌파 후 계속 오르면 끝까지 들고 가다가, <strong>최고점에서 -{trailingCallbackPercent}% 꺾일 때</strong> 최고가 근처에서 전량 익절합니다.
                    </p>
                  </div>
                )}
              </div>

              {/* Smart DCA (하락장 평단가 분할 물타기) Card */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-indigo-600" />
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">스마트 분할 물타기 (DCA)</h3>
                      <p className="text-[10px] text-slate-400">하락 시 추가 매수로 평단가 하락</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleParamsChange({ dcaEnabled: !dcaEnabled })}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      dcaEnabled ? 'bg-indigo-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        dcaEnabled ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {dcaEnabled && (
                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-bold">
                        <span className="text-slate-700">최대 물타기 횟수 (Max Orders)</span>
                        <span className="text-indigo-600 mono">{maxSafetyOrders}회</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="5"
                        step="1"
                        value={maxSafetyOrders}
                        onChange={(e) => handleParamsChange({ maxSafetyOrders: parseInt(e.target.value) })}
                        className="w-full accent-indigo-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>1회 (소극적)</span>
                        <span>3회 (표준)</span>
                        <span>5회 (공격적)</span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-bold">
                        <span className="text-slate-700">물타기 하락 간격 (Step %)</span>
                        <span className="text-indigo-600 mono">-{safetyOrderStepPercent.toFixed(1)}%</span>
                      </div>
                      <input
                        type="range"
                        min="1.0"
                        max="5.0"
                        step="0.5"
                        value={safetyOrderStepPercent}
                        onChange={(e) => handleParamsChange({ safetyOrderStepPercent: parseFloat(e.target.value) })}
                        className="w-full accent-indigo-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>-1.0% (촘촘하게)</span>
                        <span>-2.0% (추천)</span>
                        <span>-5.0% (넓게)</span>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-500 bg-indigo-50/60 p-2 rounded-xl border border-indigo-100">
                      💡 1차 매수 후 <strong>-{safetyOrderStepPercent}% 하락할 때마다</strong> 최대 {maxSafetyOrders}회까지 평단가를 낮춰 반등 시 쉽게 탈출합니다.
                    </p>
                  </div>
                )}
              </div>

              {/* Pyramiding (상승장 추가 매수 - 불타기) Card */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Rocket className="w-4 h-4 text-amber-500" />
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">상승 불타기 (Pyramiding)</h3>
                      <p className="text-[10px] text-slate-400">상승 추세 시 추가 매수로 수익 극대화</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleParamsChange({ pyramidingEnabled: !pyramidingEnabled })}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      pyramidingEnabled ? 'bg-amber-500' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        pyramidingEnabled ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {pyramidingEnabled && (
                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-bold">
                        <span className="text-slate-700">최대 불타기 횟수</span>
                        <span className="text-amber-600 mono">{maxPyramidingOrders}회</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="3"
                        step="1"
                        value={maxPyramidingOrders}
                        onChange={(e) => handleParamsChange({ maxPyramidingOrders: parseInt(e.target.value) })}
                        className="w-full accent-amber-500 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>1회 (신중)</span>
                        <span>2회 (표준)</span>
                        <span>3회 (공격적)</span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-bold">
                        <span className="text-slate-700">불타기 상승 수익 기준</span>
                        <span className="text-amber-600 mono">+{pyramidingStepPercent.toFixed(1)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.8"
                        max="3.0"
                        step="0.1"
                        value={pyramidingStepPercent}
                        onChange={(e) => handleParamsChange({ pyramidingStepPercent: parseFloat(e.target.value) })}
                        className="w-full accent-amber-500 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>+0.8% (빠르게)</span>
                        <span>+1.5% (추천)</span>
                        <span>+3.0% (확실할때)</span>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-500 bg-amber-50/60 p-2 rounded-xl border border-amber-100">
                      💡 1차 매수 후 <strong>+{pyramidingStepPercent}% 이상 오르면</strong> 추가 매수(불타기)하여 물량을 늘리고 트레일링 익절로 초대형 수익을 노립니다.
                    </p>
                  </div>
                )}
              </div>

              {/* Partial Loss-Cut & Cash Recycling (자금순환 부분손절) Card */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-1.5">
                    <RefreshCw className="w-4 h-4 text-purple-600" />
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">자금순환 부분손절 (Cash Recycling)</h3>
                      <p className="text-[10px] text-slate-400">현금 고갈 방지 및 바닥 재매수 기회 창출</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleParamsChange({ partialLossCutEnabled: !partialLossCutEnabled })}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      partialLossCutEnabled ? 'bg-purple-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        partialLossCutEnabled ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {partialLossCutEnabled && (
                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-bold">
                        <span className="text-slate-700">부분 손절 비중</span>
                        <span className="text-purple-600 mono">{partialLossCutPercent}%</span>
                      </div>
                      <input
                        type="range"
                        min="20"
                        max="60"
                        step="5"
                        value={partialLossCutPercent}
                        onChange={(e) => handleParamsChange({ partialLossCutPercent: parseInt(e.target.value) })}
                        className="w-full accent-purple-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>20% (소량회수)</span>
                        <span>40% (추천)</span>
                        <span>60% (절반이상)</span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-bold">
                        <span className="text-slate-700">발동 하락률 기준</span>
                        <span className="text-purple-600 mono">-{partialLossCutThreshold.toFixed(1)}%</span>
                      </div>
                      <input
                        type="range"
                        min="2.0"
                        max="6.0"
                        step="0.5"
                        value={partialLossCutThreshold}
                        onChange={(e) => handleParamsChange({ partialLossCutThreshold: parseFloat(e.target.value) })}
                        className="w-full accent-purple-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>-2.0% (빠른순환)</span>
                        <span>-3.5% (권장)</span>
                        <span>-6.0% (깊은하락)</span>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-500 bg-purple-50/60 p-2 rounded-xl border border-purple-100">
                      💡 물타기 소진 후 <strong>-{partialLossCutThreshold}% 하락 시</strong> 물량의 {partialLossCutPercent}%만 분할 매도하여 현금을 회수하고, <strong>더 낮은 바닥에서 다시 물타기를 재개</strong>합니다.
                    </p>
                  </div>
                )}
              </div>

              {/* Trend-Aware Predictive Loss-Cut & Bottom Re-entry Card */}
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Brain className="w-4 h-4 text-cyan-600" />
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">시세 흐름 조기손절 & 바닥 재매수</h3>
                      <p className="text-[10px] text-slate-400">급락 모멘텀 감지 시 선제 손절 후 바닥 매수</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleParamsChange({ trendAwareCutEnabled: !trendAwareCutEnabled })}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      trendAwareCutEnabled ? 'bg-cyan-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        trendAwareCutEnabled ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {trendAwareCutEnabled && (
                  <div className="space-y-3 pt-1">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs font-bold">
                        <span className="text-slate-700">급락 감지 민감도 (하락 속도)</span>
                        <span className="text-cyan-600 mono">-{trendDropSpeedThreshold.toFixed(1)}% / 틱</span>
                      </div>
                      <input
                        type="range"
                        min="0.3"
                        max="1.5"
                        step="0.1"
                        value={trendDropSpeedThreshold}
                        onChange={(e) => handleParamsChange({ trendDropSpeedThreshold: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>0.3% (매우 민감)</span>
                        <span>0.6% (표준 추천)</span>
                        <span>1.5% (둔감)</span>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-500 bg-cyan-50/60 p-2 rounded-xl border border-cyan-100">
                      💡 하단 밴드 이탈 및 <strong>급락 가속도(-{trendDropSpeedThreshold}%)</strong> 포착 시, 현금이 남아있어도 물량의 40%를 <strong>선제적 조기 손절</strong>하여 현금을 지키고, <strong>급락이 멈추고 바닥 지지가 확인될 때 세이브된 현금으로 재매수</strong>합니다.
                    </p>
                  </div>
                )}
              </div>
              </fieldset>

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
                      onClick={() => setSelectedLog(log)}
                      className={`p-2.5 rounded-xl border flex items-start gap-2 cursor-pointer hover:opacity-90 active:scale-98 transition ${
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
                            손익: {log.pnl >= 0 ? '+' : ''}{formatPrice(log.pnl)} ({log.pnlPercent?.toFixed(2)}%)
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
                    <span>실제 업비트(Upbit) 계좌 보유 자산</span>
                  </h3>
                  <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded-full">
                    {hasApiKeys.upbit ? '● 실시간 연동' : '○ API 키 필요'}
                  </span>
                </div>

                {Object.keys(realBalances).length === 0 ? (
                  <div className="text-center py-4 text-xs text-slate-400">
                    {hasApiKeys.upbit
                      ? '연동된 계좌의 보유 자산이 없거나 조회 중입니다.'
                      : '하단에서 Upbit API 키를 등록하면 실제 계좌 잔고가 표시됩니다.'}
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
                    <span>업비트(Upbit) API 키 설정</span>
                  </h3>
                  <span className="text-[10px] text-slate-400 font-mono">AES-256 Encrypted</span>
                </div>

                {apiKeyTestStatus && (
                  <div className="p-2.5 rounded-xl bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-800">
                    {apiKeyTestStatus}
                  </div>
                )}

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
                    onClick={handleTestApiKeys}
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

              {/* PWA App Installation Card */}
              <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 p-4 rounded-2xl text-white shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-10 h-10 rounded-xl bg-blue-600/30 border border-blue-400/30 flex items-center justify-center">
                      <Smartphone className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h4 className="font-bold text-xs">앱으로 설치하기 (PWA)</h4>
                      <p className="text-[10px] text-slate-300 mt-0.5">
                        {isStandalone ? '✅ 이미 홈 화면에 앱으로 설치됨' : '홈 화면 아이콘 및 전체화면 지원'}
                      </p>
                    </div>
                  </div>
                  {!isStandalone && (
                    <button
                      onClick={handleInstallPwa}
                      className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white font-bold text-xs rounded-xl shadow-xs transition cursor-pointer"
                    >
                      설치하기
                    </button>
                  )}
                </div>

                {showIosGuide && (
                  <div className="bg-white/10 backdrop-blur-md p-3 rounded-xl border border-white/15 text-[11px] space-y-1.5 text-slate-200">
                    <div className="font-bold text-white flex items-center justify-between">
                      <span>📱 아이폰/아이패드 (Safari) 설치 방법:</span>
                      <button onClick={() => setShowIosGuide(false)} className="text-slate-400 hover:text-white">✕</button>
                    </div>
                    <ol className="list-decimal list-inside space-y-1 text-[10.5px]">
                      <li>Safari 하단 메뉴의 <strong>공유 아이콘 (📤)</strong>을 누릅니다.</li>
                      <li>메뉴 목록을 내려 <strong>[홈 화면에 추가]</strong>를 누릅니다.</li>
                      <li>우측 상단의 <strong>[추가]</strong>를 누르면 설치 완료!</li>
                    </ol>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Mobile Bottom Navigation Bar (Fixed/Sticky at bottom) */}
        <nav className="sticky bottom-0 left-0 right-0 w-full bg-white/95 backdrop-blur-md border-t border-slate-200 px-3 py-2 flex items-center justify-around shrink-0 z-50 shadow-md">
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

        {/* Log Detail Popup Modal */}
        {selectedLog && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setSelectedLog(null)}
          >
            <div
              className="bg-white w-full max-w-sm rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col animate-in zoom-in-95 duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-extrabold px-2 py-0.5 rounded-full uppercase ${
                      selectedLog.type === 'BUY'
                        ? 'bg-emerald-600 text-white'
                        : selectedLog.type === 'SELL'
                        ? 'bg-blue-600 text-white'
                        : selectedLog.type === 'STOP_LOSS'
                        ? 'bg-rose-600 text-white'
                        : 'bg-slate-700 text-white'
                    }`}
                  >
                    {selectedLog.type}
                  </span>
                  <span className="text-xs font-bold text-slate-700">체결 상세 로그</span>
                </div>
                <button
                  onClick={() => setSelectedLog(null)}
                  className="w-7 h-7 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-600 flex items-center justify-center font-bold text-xs transition cursor-pointer"
                >
                  ✕
                </button>
              </div>

              {/* Modal Content */}
              <div className="p-5 space-y-4 text-xs">
                {/* Key Metrics Grid */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                    <div className="text-[10px] text-slate-400 font-semibold">체결 시간</div>
                    <div className="font-bold text-slate-800 mono mt-0.5">{selectedLog.time}</div>
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                    <div className="text-[10px] text-slate-400 font-semibold">체결 가격</div>
                    <div className="font-extrabold text-blue-600 mono mt-0.5">{formatPrice(selectedLog.price)}</div>
                  </div>
                  {selectedLog.amount !== undefined && (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                      <div className="text-[10px] text-slate-400 font-semibold">주문 수량</div>
                      <div className="font-bold text-slate-800 mono mt-0.5">{selectedLog.amount}</div>
                    </div>
                  )}
                  {selectedLog.pnl !== undefined && (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                      <div className="text-[10px] text-slate-400 font-semibold">실현 손익</div>
                      <div className={`font-extrabold mono mt-0.5 ${selectedLog.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {selectedLog.pnl >= 0 ? '+' : ''}{formatPrice(selectedLog.pnl)} ({selectedLog.pnlPercent?.toFixed(2)}%)
                      </div>
                    </div>
                  )}
                </div>

                {/* Full Message / Reason (No Truncation) */}
                <div className="space-y-1.5">
                  <div className="text-[11px] font-bold text-slate-500 flex items-center gap-1">
                    <Terminal className="w-3.5 h-3.5 text-slate-600" />
                    <span>상세 사유 및 시스템 전문 메시지</span>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-slate-900 text-slate-100 text-[11.5px] leading-relaxed mono break-words select-text border border-slate-800 shadow-inner max-h-48 overflow-y-auto">
                    {selectedLog.reason}
                  </div>
                </div>

                {/* Close Button */}
                <button
                  onClick={() => setSelectedLog(null)}
                  className="w-full py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 font-extrabold text-white text-xs shadow-xs transition active:scale-98 cursor-pointer"
                >
                  확인 닫기
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
