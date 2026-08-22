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
  XCircle,
  Target,
  Crosshair,
  Flame,
  ShieldCheck,
  Compass,
  Power,
  HelpCircle,
  Gauge
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
  timestamp?: number;
}

interface DailyNetPerformance {
  date: string;
  realizedPnl: number;
  fees: number;
  netPnl: number;
  sellCount: number;
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
  // Mobile Tab view: 'chart' | 'bot' | 'lab' | 'logs' | 'account'
  const [activeTab, setActiveTab] = useState<'chart' | 'radar' | 'bot' | 'lab' | 'logs' | 'account'>('chart');
  const [deviceFrameMode, setDeviceFrameMode] = useState<boolean>(true);

  // Backend WS Connection State
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [serverRestarting, setServerRestarting] = useState(false);
  const restartRequestedRef = useRef(false);

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
  const [trailingExitCount, setTrailingExitCount] = useState<number>(0);
  const [profitLockPrice, setProfitLockPrice] = useState<number | null>(null);

  // Pyramiding & Partial Loss-Cut State
  const [pyramidingEnabled, setPyramidingEnabled] = useState<boolean>(true);
  const [maxPyramidingOrders, setMaxPyramidingOrders] = useState<number>(2);
  const [pyramidingStepPercent, setPyramidingStepPercent] = useState<number>(1.5);
  const [pyramidingCount, setPyramidingCount] = useState<number>(0);
  const [boxPyramidCount, setBoxPyramidCount] = useState<number>(0);
  const [cooldownUntil, setCooldownUntil] = useState<number>(0);
  const [remainingCooldown, setRemainingCooldown] = useState<number>(0);

  // 쿨다운(재진입 대기) 타이머
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      if (cooldownUntil > now) {
        setRemainingCooldown(Math.ceil((cooldownUntil - now) / 1000));
      } else {
        setRemainingCooldown(0);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [cooldownUntil]);
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

  // Strategy Lab experiments are opt-in and default to OFF on the server.
  const [experimentDca2RsiRecoveryEnabled, setExperimentDca2RsiRecoveryEnabled] = useState(false);
  const [experimentDca2VolumeConfirmationEnabled, setExperimentDca2VolumeConfirmationEnabled] = useState(false);
  const [experimentPyramidRsiGuardEnabled, setExperimentPyramidRsiGuardEnabled] = useState(false);
  const [experimentPyramidVolumeConfirmationEnabled, setExperimentPyramidVolumeConfirmationEnabled] = useState(false);
  const [experimentScalpTrendExpansionEnabled, setExperimentScalpTrendExpansionEnabled] = useState(false);
  const [experimentScalpReentryCooldownEnabled, setExperimentScalpReentryCooldownEnabled] = useState(false);
  const [experimentTrendTrailingArmingEnabled, setExperimentTrendTrailingArmingEnabled] = useState(false);
  const [researchStats, setResearchStats] = useState({ enabled: false, ticksRecorded: 0, candlesRecorded: 0, shadowDifferences: 0, startedAt: 0 });
  const [rebaseStatus, setRebaseStatus] = useState<string | null>(null);

  // API Credentials State (Upbit Exclusive)
  // Exchange secrets must never be retained in browser storage.  They exist
  // only in this component until explicitly sent over the authenticated
  // same-origin WebSocket to the server-side secret store.
  const [upbitAccess, setUpbitAccess] = useState<string>('');
  const [upbitSecret, setUpbitSecret] = useState<string>('');
  const [apiKeyTestStatus, setApiKeyTestStatus] = useState<string | null>(null);
  const [hasApiKeys, setHasApiKeys] = useState<{ upbit: boolean }>({ upbit: false });

  // Financial & Market State
  const [balance, setBalance] = useState<number>(10000000.0);
  const [initialBalance, setInitialBalance] = useState<number>(10000000.0);
  const [positionAmount, setPositionAmount] = useState<number>(0);
  const [entryPrice, setEntryPrice] = useState<number | null>(null);
  const [totalRealizedPnl, setTotalRealizedPnl] = useState<number>(0);
  const [totalFeesPaid, setTotalFeesPaid] = useState<number>(0);
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
      category: any;
      categoryLabel: string;
      type: string;
      budgetKrw: number;
      unitPercent: number;
      scaleMultiplier: number;
      targetPriceLabel: string;
      targetPrice?: number;
      themeColor: any;
    }>;
  } | null>(null);
  const [nextOrderPageIndex, setNextOrderPageIndex] = useState<number>(0);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const [dailyNetPerformance, setDailyNetPerformance] = useState<DailyNetPerformance[]>([]);
  const [isDailyPerformanceOpen, setIsDailyPerformanceOpen] = useState(false);

  // Live Strategy Radar State & Adaptive Metrics
  const [adaptiveIndicators, setAdaptiveIndicators] = useState<{
    dynamicAtr: number;
    dynamicOrderRatio: number;
    dynamicDcaStep: number;
    dynamicTrailingCallback: number;
    dynamicScalpBandMultiplier: number;
    dynamicScalpTakeProfitPercent: number;
    marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR';
    sidewaysContext?: 'BULL_PULLBACK' | 'NEUTRAL_RANGE' | 'BEAR_PAUSE';
    slope: number;
    volatilityRatio: number;
    rsi?: number;
    volumeMultiplier?: number;
    volumeMa?: number;
  } | null>(null);
  const [rsiValue, setRsiValue] = useState<number>(50.0);
  const [volumeMultiplier, setVolumeMultiplier] = useState<number>(1.0);
  const [dropSpeed, setDropSpeed] = useState<number>(0);
  const [activeRadarTab, setActiveRadarTab] = useState<'BUY' | 'SELL' | 'ALL'>('ALL');
  const [radarExpanded, setRadarExpanded] = useState<boolean>(true);

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
        if (restartRequestedRef.current) {
          restartRequestedRef.current = false;
          setServerRestarting(false);
        }
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
              if (s.params.experimentDca2RsiRecoveryEnabled !== undefined) setExperimentDca2RsiRecoveryEnabled(s.params.experimentDca2RsiRecoveryEnabled);
              if (s.params.experimentDca2VolumeConfirmationEnabled !== undefined) setExperimentDca2VolumeConfirmationEnabled(s.params.experimentDca2VolumeConfirmationEnabled);
              if (s.params.experimentPyramidRsiGuardEnabled !== undefined) setExperimentPyramidRsiGuardEnabled(s.params.experimentPyramidRsiGuardEnabled);
              if (s.params.experimentPyramidVolumeConfirmationEnabled !== undefined) setExperimentPyramidVolumeConfirmationEnabled(s.params.experimentPyramidVolumeConfirmationEnabled);
              if (s.params.experimentScalpTrendExpansionEnabled !== undefined) setExperimentScalpTrendExpansionEnabled(s.params.experimentScalpTrendExpansionEnabled);
              if (s.params.experimentScalpReentryCooldownEnabled !== undefined) setExperimentScalpReentryCooldownEnabled(s.params.experimentScalpReentryCooldownEnabled);
              if (s.params.experimentTrendTrailingArmingEnabled !== undefined) setExperimentTrendTrailingArmingEnabled(s.params.experimentTrendTrailingArmingEnabled);
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
              if (s.position.trailingActive !== undefined) setIsTrailingActive(s.position.trailingActive);
              if (s.position.trailingPeakPrice !== undefined) setTrailingPeakPrice(s.position.trailingPeakPrice);
              if (s.position.trailingExitCount !== undefined) setTrailingExitCount(s.position.trailingExitCount);
              if (s.position.profitLockPrice !== undefined) setProfitLockPrice(s.position.profitLockPrice);
              if (s.position.cooldownUntil !== undefined) setCooldownUntil(s.position.cooldownUntil);
            }
            if (s.safetyOrderCount !== undefined) setSafetyOrderCount(s.safetyOrderCount);
            if (s.pyramidingCount !== undefined) setPyramidingCount(s.pyramidingCount);
            if (s.boxPyramidCount !== undefined) setBoxPyramidCount(s.boxPyramidCount);
            if (s.cooldownUntil !== undefined) setCooldownUntil(s.cooldownUntil);
            if (s.awaitingReentry !== undefined) setAwaitingReentry(s.awaitingReentry);
            if (s.isTrailingActive !== undefined) setIsTrailingActive(s.isTrailingActive);
            if (s.trailingPeakPrice !== undefined) setTrailingPeakPrice(s.trailingPeakPrice);
            if (s.trailingExitCount !== undefined) setTrailingExitCount(s.trailingExitCount);
            if (s.totalRealizedPnl !== undefined) setTotalRealizedPnl(s.totalRealizedPnl);
            if (s.totalFeesPaid !== undefined) setTotalFeesPaid(s.totalFeesPaid);
            if (s.dailyNetPerformance !== undefined) setDailyNetPerformance(s.dailyNetPerformance);
            if (s.totalTrades !== undefined) setTotalTrades(s.totalTrades);
            if (s.winTrades !== undefined) setWinTrades(s.winTrades);
            if (s.currentPrice !== undefined) setCurrentPrice(s.currentPrice);
            if (s.atrValue !== undefined) setAtrValue(s.atrValue);
            if (s.baselineValue !== undefined) setBaselineValue(s.baselineValue);
            if (s.rsi !== undefined) setRsiValue(s.rsi);
            if (s.volumeMultiplier !== undefined) setVolumeMultiplier(s.volumeMultiplier);
            if (s.research) setResearchStats(s.research);
            if (s.priceHistory) setPriceHistory(s.priceHistory);
            if (s.logs) setLogs(s.logs);
            if (s.realBalances) setRealBalances(s.realBalances);
            if (s.hasApiKeys) setHasApiKeys(s.hasApiKeys);
            if (s.nextOrderInfo) setNextOrderInfo(s.nextOrderInfo);
            if (s.adaptive) setAdaptiveIndicators(s.adaptive);
            if (s.dropSpeed !== undefined) setDropSpeed(s.dropSpeed);
          } else if (data.type === 'TEST_API_KEYS_RESULT') {
            const res = data.payload;
            if (res.success) {
              if (res.balances) setRealBalances(res.balances);
              const assets = res.balances ? Object.keys(res.balances).join(', ') : 'OK';
              setApiKeyTestStatus(`✅ Upbit API 연결 성공! 실시간 보유 자산 (${assets}) 수신 완료`);
            } else {
              setApiKeyTestStatus(`❌ Upbit API 연결 실패: ${res.error}`);
            }
          } else if (data.type === 'POSITION_REBASE_RESULT') {
            setRebaseStatus('✅ 거래소 잔고와 최신 지표 기준으로 포지션 보호 조건을 보정했습니다.');
          } else if (data.type === 'SERVER_RESTARTING') {
            restartRequestedRef.current = true;
            setServerRestarting(true);
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

  const requestServerRestart = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      window.alert('서버 연결이 끊어져 있어 재시작 요청을 보낼 수 없습니다. 연결이 복구된 뒤 다시 시도하세요.');
      return;
    }
    setShowRestartConfirm(false);
    restartRequestedRef.current = true;
    setServerRestarting(true);
    sendWsCommand('RESTART_SERVER', { confirmed: true });
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
    experimentDca2RsiRecoveryEnabled?: boolean;
    experimentDca2VolumeConfirmationEnabled?: boolean;
    experimentPyramidRsiGuardEnabled?: boolean;
    experimentPyramidVolumeConfirmationEnabled?: boolean;
    experimentScalpTrendExpansionEnabled?: boolean;
    experimentScalpReentryCooldownEnabled?: boolean;
    experimentTrendTrailingArmingEnabled?: boolean;
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
    if (newParams.experimentDca2RsiRecoveryEnabled !== undefined) setExperimentDca2RsiRecoveryEnabled(newParams.experimentDca2RsiRecoveryEnabled);
    if (newParams.experimentDca2VolumeConfirmationEnabled !== undefined) setExperimentDca2VolumeConfirmationEnabled(newParams.experimentDca2VolumeConfirmationEnabled);
    if (newParams.experimentPyramidRsiGuardEnabled !== undefined) setExperimentPyramidRsiGuardEnabled(newParams.experimentPyramidRsiGuardEnabled);
    if (newParams.experimentPyramidVolumeConfirmationEnabled !== undefined) setExperimentPyramidVolumeConfirmationEnabled(newParams.experimentPyramidVolumeConfirmationEnabled);
    if (newParams.experimentScalpTrendExpansionEnabled !== undefined) setExperimentScalpTrendExpansionEnabled(newParams.experimentScalpTrendExpansionEnabled);
    if (newParams.experimentScalpReentryCooldownEnabled !== undefined) setExperimentScalpReentryCooldownEnabled(newParams.experimentScalpReentryCooldownEnabled);
    if (newParams.experimentTrendTrailingArmingEnabled !== undefined) setExperimentTrendTrailingArmingEnabled(newParams.experimentTrendTrailingArmingEnabled);
    sendWsCommand('UPDATE_CONFIG', newParams);
  };

  const handleToggleBot = () => {
    sendWsCommand('TOGGLE_BOT', { isBotActive: !isBotActive });
  };

  const handlePositionRebase = () => {
    if (isBotActive) {
      setRebaseStatus('❌ 봇을 정지한 상태에서만 포지션 보정이 가능합니다.');
      return;
    }
    if (!window.confirm('거래소의 실제 보유 수량·평단을 다시 확인한 뒤, 손절·부분손절·트레일링 기준을 새 포지션 기준으로 재설정합니다. DCA 사용 기록은 유지합니다. 계속할까요?')) return;
    setRebaseStatus('⏳ 거래소 잔고와 최신 지표를 확인하는 중입니다…');
    sendWsCommand('REBASE_POSITION', {});
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
    setUpbitAccess('');
    setUpbitSecret('');
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
    const refPrice = positionAmount > 0 && entryPrice ? entryPrice : currentPrice;
    return Math.round(refPrice * 0.94);
  }, [priceHistory, positionAmount, entryPrice, currentPrice]);

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

  // Trade Confirmation Modal State
  const [tradeConfirmModal, setTradeConfirmModal] = useState<{
    type: 'BUY' | 'SELL';
    title: string;
    message: string;
    actionLabel: string;
    badgeLabel: string;
    manualBuyPercent?: 10 | 20 | 30;
    details: { label: string; value: string; highlight?: boolean }[];
  } | null>(null);

  const handleManualBuy = (manualBuyPercent?: 10 | 20 | 30) => {
    sendWsCommand('MANUAL_TRADE', { side: 'BUY', manualBuyPercent });
    playBeep('BUY');
  };

  const handleManualSell = () => {
    sendWsCommand('MANUAL_TRADE', { side: 'SELL' });
    playBeep('SELL');
  };

  const requestManualBuyConfirm = () => {
    const isAdditional = positionAmount > 0;
    const manualBuyPercent = 10 as const;
    const selectedPercent = isAdditional ? manualBuyPercent : (orderRatio || 20);
    const estBudget = currentEquity * (selectedPercent / 100);
    setTradeConfirmModal({
      type: 'BUY',
      title: isAdditional ? '수동 추가 매수 확인' : '수동 1차 매수 (BUY) 확인',
      badgeLabel: isAdditional ? '추가 매수' : '1차 진입',
      message: isAdditional
        ? '선택한 비중으로 평단가를 조정합니다. 자동 DCA 슬롯은 소비하지 않으며, 체결 뒤 가격 기준은 새 평단으로 다시 계산됩니다.'
        : '업비트 시장가로 1차 매수 주문을 전송합니다. 진행하시겠습니까?',
      actionLabel: isAdditional ? '추가 매수 실행' : '매수 주문 실행',
      manualBuyPercent: isAdditional ? manualBuyPercent : undefined,
      details: [
        { label: '주문 코인', value: selectedCoin },
        { label: '예상 주문 금액', value: `${formatPrice(estBudget)} (총자산의 ${selectedPercent}%)`, highlight: true },
        { label: '현재 실시간 시세', value: formatPrice(currentPrice) },
        ...(isAdditional && entryPrice ? [{ label: '현재 내 평단가', value: formatPrice(entryPrice) }] : [])
      ]
    });
  };

  const requestManualSellConfirm = () => {
    const coinKey = selectedCoin.replace('KRW-', '');
    const estTotalValue = positionAmount * currentPrice;
    setTradeConfirmModal({
      type: 'SELL',
      title: '전량 청산 (시장가 매도) 확인',
      badgeLabel: '긴급 매도',
      message: '보유 중인 모든 코인을 시장가로 전량 매도하고 봇을 [긴급 정지] 상태로 전환합니다. 정말로 매도하시겠습니까?',
      actionLabel: '전량 매도 실행',
      details: [
        { label: '매도 대상', value: selectedCoin },
        { label: '매도 수량', value: `${positionAmount.toFixed(6)} ${coinKey} (100% 전량)`, highlight: true },
        { label: '예상 평가액', value: formatPrice(estTotalValue) },
        { label: '평가 손익', value: `${unrealizedPnl >= 0 ? '+' : ''}${formatPrice(unrealizedPnl)} (${unrealizedPnlPercent >= 0 ? '+' : ''}${unrealizedPnlPercent.toFixed(2)}%)` }
      ]
    });
  };

  const handleConfirmTrade = () => {
    if (!tradeConfirmModal) return;
    if (tradeConfirmModal.type === 'BUY') {
      handleManualBuy(tradeConfirmModal.manualBuyPercent);
    } else {
      handleManualSell();
    }
    setTradeConfirmModal(null);
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
  // The backend's order page is derived from the persisted DCA slots. Prefer it
  // over the UI counter so the radar cannot show a stale DCA stage after a fill.
  const nextDcaPage = nextOrderInfo?.pages?.find((page) => page.category === 'DCA');
  const nextDcaMatch = nextDcaPage?.type.match(/DCA #(\d+)차/);
  const authoritativeNextDcaNumber = nextDcaMatch ? Number(nextDcaMatch[1]) : Math.min(safetyOrderCount + 1, 3);
  const authoritativeNextDcaLabel = nextDcaPage?.targetPriceLabel;
  // Compatibility fallback for a server that predates dailyNetPerformance.
  // Sell logs include gross PnL, fill price, volume and PnL %, allowing both
  // sides' 0.05% fee to be estimated until the FIFO server summary arrives.
  const fallbackDailyPerformance = (() => {
    const days = new Map<string, DailyNetPerformance>();
    for (const log of logs) {
      if (log.pnl === undefined || !log.amount || !log.timestamp) continue;
      const pnlRate = (log.pnlPercent || 0) / 100;
      const estimatedEntryPrice = pnlRate > -0.999 ? log.price / (1 + pnlRate) : log.price;
      const estimatedFees = (estimatedEntryPrice + log.price) * log.amount * 0.0005;
      const date = new Date(log.timestamp).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const day = days.get(date) || { date, realizedPnl: 0, fees: 0, netPnl: 0, sellCount: 0 };
      day.realizedPnl += log.pnl;
      day.fees += estimatedFees;
      day.netPnl += log.pnl - estimatedFees;
      day.sellCount += 1;
      days.set(date, day);
    }
    return [...days.values()]
      .map((day) => ({ ...day, realizedPnl: Math.round(day.realizedPnl), fees: Math.round(day.fees), netPnl: Math.round(day.netPnl) }))
      .sort((a, b) => b.date.localeCompare(a.date));
  })();
  const resolvedDailyPerformance = dailyNetPerformance.length > 0 ? dailyNetPerformance : fallbackDailyPerformance;
  const isEstimatedDailyPerformance = dailyNetPerformance.length === 0 && fallbackDailyPerformance.length > 0;
  const dailyPerformanceByDate = new Map(resolvedDailyPerformance.map((day) => [day.date, day]));
  const recentPerformanceDates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - index);
    return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  });
  const recentDailyPerformance = recentPerformanceDates.map((date) => dailyPerformanceByDate.get(date) || {
    date, realizedPnl: 0, fees: 0, netPnl: 0, sellCount: 0
  });
  const olderDailyPerformance = resolvedDailyPerformance.filter((day) => !recentPerformanceDates.includes(day.date));
  const displayedTotalRealizedPnl = resolvedDailyPerformance.length > 0
    ? resolvedDailyPerformance.reduce((sum, day) => sum + day.netPnl, 0)
    : totalRealizedPnl;

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
        className={`relative w-full max-w-sm bg-white sm:rounded-3xl shadow-xl border border-slate-200 overflow-hidden flex flex-col transition-all duration-300 ${
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

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Quick Bot Main Power Toggle Button */}
            <button
              onClick={handleToggleBot}
              aria-label={isBotActive ? '자동 매매 일시정지' : '자동 매매 시작'}
              className={`grid h-8 w-8 place-items-center rounded-xl shadow-2xs transition cursor-pointer active:scale-95 ${
                isBotActive
                  ? 'bg-emerald-500 text-white hover:bg-emerald-600 ring-2 ring-emerald-300'
                  : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
              }`}
              title={isBotActive ? '자동 매매 가동 중 (클릭 시 일시정지)' : '자동 매매 정지 중 (클릭 시 가동 시작)'}
            >
              <Power className="w-4 h-4" />
            </button>

            {/* Symbol Selector (Upbit) */}
            <select
              value={selectedCoin}
              onChange={(e) => handleCoinChange(e.target.value)}
              className="bg-blue-50 font-bold text-[10px] text-blue-900 px-1.5 py-1 rounded-lg border border-blue-200 focus:outline-none cursor-pointer text-center"
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
          <div className="text-right flex flex-col items-end">
            <div className="flex items-center gap-1.5 text-[10px] font-mono">
              <span className="text-slate-400">ATR: {formatPrice(atrValue)}</span>
              <span className={`px-1.5 py-0.2 rounded-md font-bold text-[9px] ${
                rsiValue >= 68 ? 'bg-rose-100 text-rose-700' : rsiValue <= 35 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700'
              }`}>
                RSI {rsiValue.toFixed(0)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-slate-500 mt-0.5">
              <span>기준선: {formatPrice(baselineValue)}</span>
              <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-600 font-bold">
                Vol {volumeMultiplier.toFixed(2)}x
              </span>
            </div>
          </div>
        </div>

        {/* Scrollable Content Area */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 pb-6 overscroll-contain">
          {activeTab === 'chart' && (
            <>
              {/* PWA Install Banner */}
              {false && !isStandalone && (
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
              <div className={`px-3.5 py-3 rounded-2xl border transition-all ${
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
                          {marketRegime === 'BULL' && '상승 국면'}
                          {marketRegime === 'BEAR' && '하락 국면'}
                          {marketRegime === 'SIDEWAYS' && (adaptiveIndicators?.sidewaysContext === 'BULL_PULLBACK' ? '상승 조정 국면' : adaptiveIndicators?.sidewaysContext === 'BEAR_PAUSE' ? '하락 정체 국면' : '중립 박스 국면')}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-white/20 font-bold uppercase">
                          Auto-Pilot {autoPilotEnabled ? 'ON' : 'OFF'}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-300 mt-0.5">
                        {marketRegime === 'BULL' && '돌파·추세 추적 중심'}
                        {marketRegime === 'BEAR' && '진입 규모를 낮추고 방어 우선'}
                        {marketRegime === 'SIDEWAYS' && (adaptiveIndicators?.sidewaysContext === 'BULL_PULLBACK' ? '박스권 전량 익절 보류 · 추세 보유 우선' : adaptiveIndicators?.sidewaysContext === 'BEAR_PAUSE' ? '박스권 신규 매수·불타기 차단 · 현금 보존' : '짧은 진입과 익절 중심')}
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

              {/* Unified strategy status + next action: one source of truth, opens the condition radar. */}
              {(() => {
                const hasPosition = positionAmount > 0;
                const dcaSteps = [2, 4.2, 5.5];
                const nextDcaStep = dcaSteps[Math.min(authoritativeNextDcaNumber - 1, dcaSteps.length - 1)];
                const nextDcaPrice = (entryPrice || currentPrice) * (1 - nextDcaStep / 100);
                const isCoolingDown = remainingCooldown > 0;
                const isDefensive = positionLifecycleState.startsWith('DEFENSIVE');
                const headline = !hasPosition
                  ? '신규 진입 조건 확인 중'
                  : isCoolingDown
                  ? `방어 쿨다운 ${remainingCooldown}초`
                  : awaitingReentry || positionLifecycleState === 'REENTRY_ALLOWED'
                  ? '재진입 조건 확인 중'
                  : isDefensive
                  ? '방어 상태 · 다음 대응 대기'
                  : '포지션 운용 중';
                const next = nextOrderInfo?.pages?.[0] || nextOrderInfo || {
                  type: hasPosition ? (authoritativeNextDcaNumber <= dcaSteps.length ? `DCA ${authoritativeNextDcaNumber}차` : '손절선·익절선 감시') : '첫 진입 감시',
                  budgetKrw: currentEquity * ((orderRatio || 20) / 100),
                  targetPriceLabel: hasPosition && authoritativeNextDcaNumber <= dcaSteps.length
                    ? (authoritativeNextDcaLabel || formatPrice(nextDcaPrice))
                    : '조건 레이더 참조'
                };
                const isExit = String(next.type).includes('익절') || String(next.type).includes('매도');

                return (
                  <button
                    onClick={() => setActiveTab('radar')}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-left shadow-2xs transition hover:border-indigo-200 active:scale-[0.99]"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">전략 상태 · 다음 행동</p>
                        <p className="mt-0.5 truncate text-sm font-bold text-slate-900">{headline}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${
                        isCoolingDown ? 'bg-amber-100 text-amber-800' : isDefensive ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700'
                      }`}>
                        {positionLifecycleState}
                      </span>
                    </div>
                    <div className="mt-2 flex items-end justify-between gap-3 border-t border-slate-100 pt-2">
                      <div className="min-w-0">
                        <p className="text-slate-400">다음 행동</p>
                        <p className="mt-0.5 truncate text-sm font-bold text-slate-800">{next.type}</p>
                        <p className="mt-0.5 truncate text-[10px] text-slate-500">{next.targetPriceLabel}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className={`text-sm font-extrabold mono ${isExit ? 'text-emerald-600' : 'text-indigo-600'}`}>{formatPrice(next.budgetKrw || 0)}</p>
                        <p className="mt-0.5 text-[10px] text-slate-400">조건 레이더 보기 →</p>
                      </div>
                    </div>
                  </button>
                );
              })()}

              {/* Asset & Position Cards */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white px-3.5 py-3 rounded-2xl border border-slate-200 shadow-2xs">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">총 자산</div>
                  <div className="text-[15px] font-extrabold mono text-slate-900 mt-1">
                      {formatPrice(currentEquity)}
                  </div>
                  <div className={`mt-2 text-[10px] font-semibold ${displayedTotalRealizedPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    실현 {displayedTotalRealizedPnl >= 0 ? '+' : ''}{formatPrice(displayedTotalRealizedPnl)}
                  </div>
                </div>

                <div className="bg-white px-3.5 py-3 rounded-2xl border border-indigo-200/80 shadow-2xs">
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">내 포지션</span>
                      {awaitingReentry ? (
                        <span className="text-[9px] font-black text-cyan-700 bg-cyan-100 px-1.5 py-0.5 rounded-md animate-pulse flex items-center gap-0.5">
                          🎯 바닥 재매수 대기
                        </span>
                      ) : isTrailingActive ? (
                        <span className="text-[9px] font-black text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-md animate-pulse flex items-center gap-0.5">
                          🔥 Trailing TP
                        </span>
                      ) : boxPyramidCount > 0 ? (
                        <span className="text-[9px] font-black text-fuchsia-700 bg-fuchsia-100 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                          🚀 불타기 {boxPyramidCount}/2
                        </span>
                      ) : pyramidingCount > 0 ? (
                        <span className="text-[9px] font-black text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                          🚀 불타기 {pyramidingCount}/{maxPyramidingOrders}
                        </span>
                      ) : safetyOrderCount > 0 ? (
                        <span className="text-[9px] font-black text-indigo-700 bg-indigo-100 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                          💧 DCA {safetyOrderCount}/{maxSafetyOrders}
                        </span>
                      ) : positionAmount > 0 ? (
                        <span className="text-[9px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded-md">
                          진입 완료
                        </span>
                      ) : (
                        <span className="text-[9px] font-bold text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-md">
                          FLAT
                        </span>
                      )}
                    </div>

                    {positionAmount > 0 ? (
                      <div className="mt-1.5">
                        <div className="text-[15px] font-extrabold mono text-indigo-700 tracking-tight">
                            {formatPrice(entryPrice || currentPrice)}
                        </div>
                        <div className="text-[10px] text-slate-500 font-medium mt-1">
                          {positionAmount.toFixed(4)} {selectedCoin.replace('KRW-', '')}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1">
                        <div className="text-[15px] font-extrabold text-slate-700">무포지션</div>
                        <div className="text-[10px] text-slate-400 mt-1">진입 조건 대기</div>
                      </div>
                    )}
                  </div>

                  <div className={`text-[10px] font-semibold mt-2 pt-2 border-t border-slate-100 flex items-center justify-between ${
                    unrealizedPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'
                  }`}>
                    <span className="text-slate-400 font-medium">평가</span>
                    <span className="mono">
                      {positionAmount > 0 ? (
                        `${unrealizedPnl >= 0 ? '+' : ''}${formatPrice(unrealizedPnl)} (${unrealizedPnlPercent >= 0 ? '+' : ''}${unrealizedPnlPercent.toFixed(2)}%)`
                      ) : (
                        '₩0 (0.00%)'
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {false && (() => {
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
                          {currentPage.category === 'SCALP_TP' || currentPage.category === 'TRAILING_TP'
                            ? '다음 익절 매도 예상 금액'
                            : currentPage.category === 'COMPLETED'
                            ? '추가 매수 한도 상태'
                            : '다음 매수 예상 금액'}
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
                          title="다음 플랜으로 전환"
                        >
                          <span>{pages[(nextOrderPageIndex + 1) % pages.length]?.categoryLabel?.substring(0, 4) || '다음'}</span>
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
                          {currentPage.category === 'COMPLETED'
                            ? '₩0 (매수 완료)'
                            : currentPage.budgetKrw > 0
                            ? formatPrice(currentPage.budgetKrw)
                            : formatPrice(currentEquity * (((currentPage.unitPercent || (autoPilotEnabled && adaptiveIndicators?.dynamicOrderRatio ? adaptiveIndicators.dynamicOrderRatio : orderRatio || 20))) / 100))}
                        </div>
                        <div className="text-[10px] text-slate-500 font-medium mt-0.5">
                          {currentPage.category === 'SCALP_TP' || currentPage.category === 'TRAILING_TP'
                            ? `${currentPage.categoryLabel} · 보유 수량의 ${currentPage.unitPercent}% 매도`
                            : currentPage.category === 'COMPLETED'
                            ? `${currentPage.categoryLabel} · 목표 수익 도달 대기`
                            : `${currentPage.categoryLabel} · 총자산의 ${currentPage.unitPercent || (autoPilotEnabled && adaptiveIndicators?.dynamicOrderRatio ? adaptiveIndicators.dynamicOrderRatio : orderRatio || 20)}% (1 Unit)`}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-semibold text-slate-400">
                          {currentPage.category === 'SCALP_TP' || currentPage.category === 'TRAILING_TP' ? '익절 발동 타이밍' : '진입 예상 타이밍'}
                        </div>
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
                        👆 좌우로 스와이프하여 {pages[(nextOrderPageIndex + 1) % pages.length]?.categoryLabel || '다음 플랜'}({((nextOrderPageIndex + 1) % pages.length) + 1}/{totalPages}) 확인
                      </span>
                    </div>
                  </div>
                );
              })()}

              {/* Real-time Canvas Chart */}
              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <BarChart2 className="w-3.5 h-3.5 text-blue-600" />
                    <span className="text-xs font-bold text-slate-800">실시간 시세</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] font-semibold flex-wrap justify-end">
                    <span className="text-emerald-600">상단</span>
                    <span className="text-indigo-600">기준선</span>
                    <span className="px-1.5 py-0.5 rounded-md bg-rose-50 border border-rose-200/80 text-rose-600 font-extrabold">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
                      손절: {formatPrice(calculatedStopLoss)} ({stopLossPercent >= 0 ? '+' : ''}{stopLossPercent.toFixed(1)}%)
                    </span>
                  </div>
                </div>

                <div className="relative w-full h-[240px] bg-slate-50/80 rounded-xl border border-slate-200 overflow-hidden">
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
                    onClick={requestManualBuyConfirm}
                    disabled={balance < 5000}
                    className="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-1 shadow-2xs active:scale-[0.98] transition cursor-pointer"
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" />
                    <span>{positionAmount > 0 ? '수동 추가 매수' : '수동 매수 (BUY)'}</span>
                  </button>
                  <button
                    onClick={requestManualSellConfirm}
                    disabled={positionAmount === 0}
                    className="py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-bold text-xs flex items-center justify-center gap-1 shadow-2xs active:scale-[0.98] transition cursor-pointer"
                  >
                    <ArrowDownRight className="w-3.5 h-3.5" />
                    <span>전량 청산 (SELL)</span>
                  </button>
                </div>
              </div>

              {/* The primary bot control lives in the persistent header. */}
              {false && <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
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
              </div>}

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

          {/* ── 🎯 DEDICATED LIVE STRATEGY CONDITIONS RADAR TAB ── */}
          {activeTab === 'radar' && (
            <div className="space-y-3 animate-in fade-in duration-150">
              {(() => {
                const dynamicAtr = adaptiveIndicators?.dynamicAtr || (marketRegime === 'BULL' ? 1.8 : marketRegime === 'BEAR' ? 3.5 : 2.4);
                const effectiveAtr = Math.max(atrValue, Math.max(5000, Math.round(currentPrice * 0.0025)));
                const upperBand = baselineValue + effectiveAtr * (autoPilotEnabled ? dynamicAtr : atrMultiplier);
                const lowerBand = baselineValue - effectiveAtr * (autoPilotEnabled ? dynamicAtr : atrMultiplier);
                const hasPosition = positionAmount > 0;
                const entry = entryPrice || currentPrice;
                const scalpTarget = entry * (1 + (adaptiveIndicators?.dynamicScalpTakeProfitPercent || 0.5) / 100);
                const trailingArm = Math.max(upperBand, entry * 1.01);
                const effectiveTrailingCallback = pyramidingCount >= 2
                  ? Math.min(adaptiveIndicators?.dynamicTrailingCallback || trailingCallbackPercent, 0.6)
                  : (adaptiveIndicators?.dynamicTrailingCallback || trailingCallbackPercent);
                const trailingExit = Math.max((trailingPeakPrice || currentPrice) * (1 - effectiveTrailingCallback / 100), entry * 1.002);
                // In SIDEWAYS mode the scalp target is a full exit.  When it
                // comes before the trailing arming price, trailing cannot
                // execute for this position unless the scalp condition is
                // bypassed by a regime/state change.
                const isNeutralRange = marketRegime === 'SIDEWAYS' && adaptiveIndicators?.sidewaysContext !== 'BULL_PULLBACK' && adaptiveIndicators?.sidewaysContext !== 'BEAR_PAUSE';
                const scalpPrecedesTrailing = hasPosition && isNeutralRange && !isTrailingActive && scalpTarget <= trailingArm;
                const dcaSteps = [2.0, 4.2, 5.5];
                const nextDca = nextDcaPage?.targetPrice || entry * (1 - (dcaSteps[Math.min(authoritativeNextDcaNumber - 1, 2)] || 5.5) / 100);
                const dca2ApproachPrice = entry * 0.965;
                const dca2ApproachFloor = entry * 0.9585;
                const recentRadarPrices = priceHistory.slice(-20).map((point) => point.price);
                const dca2RecoveryLow = Math.min(currentPrice, ...(recentRadarPrices.length ? recentRadarPrices : [currentPrice]));
                const dca2RecoveryBounce = dca2RecoveryLow > 0 ? ((currentPrice - dca2RecoveryLow) / dca2RecoveryLow) * 100 : 0;
                const dca2RecoveryLowDrop = entry > 0 ? ((entry - dca2RecoveryLow) / entry) * 100 : 0;
                const isDca2ApproachWindow = authoritativeNextDcaNumber === 2 && dca2RecoveryLowDrop >= 3.5 && dca2RecoveryLowDrop <= 4.15 && unrealizedPnlPercent <= -2.5;
                const isDca2RecoveryReady = isDca2ApproachWindow && dca2RecoveryBounce >= 0.7 && (adaptiveIndicators?.slope || 0) >= 0.05;
                const isDca2Remainder = authoritativeNextDcaNumber === 2 && nextDcaPage?.type.includes('잔여 매수');
                const isBreakoutReady = !hasPosition && currentPrice > baselineValue && (marketRegime === 'BULL' || (adaptiveIndicators?.slope || 0) >= 0.1) && rsiValue <= 68 && volumeMultiplier >= 1.15;
                const isEmergency = hasPosition && currentPrice < lowerBand && dropSpeed <= -Math.abs(trendDropSpeedThreshold);
                const regimeTargetExposure = marketRegime === 'BULL' ? 65 : marketRegime === 'BEAR' ? 40 : null;
                const status = (active: boolean, enabled = true) => active ? '발동' : enabled ? '대기' : '꺼짐';
                const tone = (active: boolean, enabled = true) => active ? 'bg-emerald-500 text-white border-emerald-500' : enabled ? 'bg-white text-slate-500 border-slate-200' : 'bg-slate-50 text-slate-400 border-slate-100';
                const buyRows = hasPosition ? [
                  ...(regimeTargetExposure ? [{ label: '국면 목표 비중', detail: `${marketRegime} · 코인 ${regimeTargetExposure}%까지 2분 간격·1회 최대 5%p 추가`, active: false, enabled: autoPilotEnabled, icon: '◉' }] : []),
                  authoritativeNextDcaNumber === 2
                    ? {
                        label: isDca2Remainder ? 'DCA 2차 잔여 60%' : 'DCA 2차 접근 반등',
                        detail: isDca2Remainder
                          ? `${formatPrice(nextDca)} 이하에서 잔여 60%`
                          : `${formatPrice(dca2ApproachPrice)}~${formatPrice(dca2ApproachFloor)} 터치 후 저점 +0.7% · 기울기 +0.05% 시 40%`,
                        active: dcaEnabled && (isDca2Remainder ? currentPrice <= nextDca : isDca2RecoveryReady),
                        enabled: dcaEnabled,
                        icon: '↓'
                      }
                    : { label: `DCA ${authoritativeNextDcaNumber}차`, detail: authoritativeNextDcaLabel || `${formatPrice(nextDca)} 이하`, active: dcaEnabled && currentPrice <= nextDca, enabled: dcaEnabled, icon: '↓' },
                  { label: pyramidingCount >= 2 ? '상승 불타기 완료' : `상승 불타기 ${pyramidingCount + 1}차`, detail: marketRegime === 'BULL' ? `평단 +${(pyramidingStepPercent * (pyramidingCount + 1)).toFixed(1)}% · ${pyramidingCount === 0 ? '0.50' : '0.35'} Unit` : '상승 국면에서만', active: false, enabled: pyramidingEnabled && marketRegime === 'BULL' && pyramidingCount < 2, icon: '↑' },
                  { label: '재진입', detail: awaitingReentry ? '급락 안정 확인 중' : '방어 매도 후 활성화', active: awaitingReentry, enabled: true, icon: '↺' }
                ] : [
                  { label: '저점 매수', detail: `${formatPrice(lowerBand)} 이하`, active: currentPrice <= lowerBand, enabled: true, icon: '↓' },
                  { label: '돌파 매수', detail: `RSI ${rsiValue.toFixed(0)} · 거래량 ${volumeMultiplier.toFixed(2)}x`, active: isBreakoutReady, enabled: true, icon: '↑' },
                  { label: '반등 확인', detail: `기준선 ${formatPrice(baselineValue)} 아래`, active: false, enabled: autoPilotEnabled, icon: '↗' }
                ];
                const sellRows = [
                  { label: '단기 익절', detail: !isNeutralRange ? (adaptiveIndicators?.sidewaysContext === 'BULL_PULLBACK' ? '상승 조정형: 전량 익절 보류' : adaptiveIndicators?.sidewaysContext === 'BEAR_PAUSE' ? '하락 정체형: 박스 익절 비활성' : '상승·하락 국면에서는 비활성') : hasPosition ? `${formatPrice(scalpTarget)} · 전량 매도` : '포지션 진입 후 활성화', active: hasPosition && isNeutralRange && currentPrice >= scalpTarget, enabled: hasPosition && isNeutralRange, icon: '◎' },
                  { label: '트레일링 익절', detail: isTrailingActive ? `${formatPrice(trailingExit)} 이탈 · 콜백 ${effectiveTrailingCallback.toFixed(1)}%` : scalpPrecedesTrailing ? `단기 익절(${formatPrice(scalpTarget)}) 우선 실행` : `${formatPrice(trailingArm)} 도달 시 무장`, active: isTrailingActive, enabled: trailingStopEnabled && hasPosition && !scalpPrecedesTrailing, statusOverride: scalpPrecedesTrailing ? '후순위' : undefined, icon: '⌁' },
                  { label: '불타기 수익 보호', detail: profitLockPrice ? `${formatPrice(profitLockPrice)} 이탈 시 전량 청산` : '불타기 1차 체결 후 활성화', active: Boolean(profitLockPrice && currentPrice <= profitLockPrice), enabled: Boolean(profitLockPrice), icon: '⌑' },
                  { label: '급락 방어', detail: `하단 이탈 + ${trendDropSpeedThreshold.toFixed(1)}% 급락`, active: isEmergency, enabled: trendAwareCutEnabled && hasPosition, icon: '!' },
                  { label: '절대 손절', detail: hasPosition ? `${formatPrice(calculatedStopLoss)} · 전량` : '포지션 진입 후 활성화', active: hasPosition && currentPrice <= calculatedStopLoss, enabled: hasPosition, icon: '×' }
                ];
                const visibleRows = activeRadarTab === 'BUY' ? buyRows : activeRadarTab === 'SELL' ? sellRows : [...buyRows.slice(0, 2), ...sellRows.slice(0, 2)];

                return (
                  <div className="space-y-3">
                    <section className="rounded-2xl bg-slate-900 px-4 py-3.5 text-white shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[10px] font-semibold tracking-wide text-slate-400">CONDITION RADAR</p>
                          <h2 className="mt-0.5 text-sm font-bold">지금 봐야 할 조건만</h2>
                          <p className="mt-1 text-[11px] text-slate-300">{hasPosition ? `평가 ${unrealizedPnlPercent >= 0 ? '+' : ''}${unrealizedPnlPercent.toFixed(2)}% · ${marketRegime}` : `무포지션 · ${marketRegime}`}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-right text-[10px] text-slate-300">
                          <span>RSI <b className="text-white">{rsiValue.toFixed(0)}</b></span>
                          <span>Vol <b className="text-white">{volumeMultiplier.toFixed(2)}x</b></span>
                          <span className="col-span-2">밴드 {formatPrice(lowerBand)} — {formatPrice(upperBand)}</span>
                        </div>
                      </div>
                      <div className="mt-3 flex rounded-xl bg-white/10 p-1 text-[11px] font-semibold">
                        {([['ALL', '핵심'], ['BUY', '매수'], ['SELL', '매도']] as const).map(([key, label]) => (
                          <button key={key} onClick={() => setActiveRadarTab(key)} className={`flex-1 rounded-lg py-1.5 transition ${activeRadarTab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-300'}`}>{label}</button>
                        ))}
                      </div>
                    </section>

                    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs">
                      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                        <span className="text-xs font-bold text-slate-900">{activeRadarTab === 'SELL' ? '청산 · 방어 조건' : activeRadarTab === 'BUY' ? '진입 · 추가매수 조건' : '핵심 조건'}</span>
                        <span className="text-[10px] text-slate-400">현재가 {formatPrice(currentPrice)}</span>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {visibleRows.map((row) => (
                          <div key={row.label} className="flex items-center gap-3 px-4 py-3">
                            <span className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${row.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{row.icon}</span>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold text-slate-800">{row.label}</div>
                              <div className="mt-0.5 truncate text-[11px] text-slate-500">{row.detail}</div>
                            </div>
                            <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${tone(row.active, row.enabled)}`}>{('statusOverride' in row ? row.statusOverride : undefined) || status(row.active, row.enabled)}</span>
                          </div>
                        ))}
                      </div>
                    </section>

                    <p className="px-1 text-center text-[10px] leading-4 text-slate-400">조건은 거래소 체결·위험관리 승인 후에만 주문으로 전환됩니다.</p>
                  </div>
                );
              })()}

              {false && (() => {
                const dynamicAtrMult = adaptiveIndicators?.dynamicAtr || (marketRegime === 'BULL' ? 1.8 : marketRegime === 'BEAR' ? 3.5 : 2.4);
                const dynamicScalpMult = adaptiveIndicators?.dynamicScalpBandMultiplier || (marketRegime === 'BULL' ? 1.0 : marketRegime === 'BEAR' ? 1.4 : 1.0);
                const dynamicScalpTp = adaptiveIndicators?.dynamicScalpTakeProfitPercent || (adaptiveIndicators?.volatilityRatio && adaptiveIndicators.volatilityRatio > 2.0 ? 0.70 : 0.40);
                const dynamicTrailingCb = adaptiveIndicators?.dynamicTrailingCallback || 0.8;
                const dynamicDca = adaptiveIndicators?.dynamicDcaStep || 2.0;
                const currentSlope = adaptiveIndicators?.slope || 0;
                const effectiveRatio = (autoPilotEnabled && adaptiveIndicators?.dynamicOrderRatio) ? adaptiveIndicators.dynamicOrderRatio : (orderRatio || 20);

                const minAtrFloor = Math.max(5000, Math.round(currentPrice * 0.0025));
                const effectiveAtr = Math.max(atrValue, minAtrFloor);

                const effectiveMultiplier = autoPilotEnabled ? dynamicAtrMult : atrMultiplier;
                const calcUpperBand = baselineValue + (effectiveAtr * effectiveMultiplier);
                const calcLowerBand = baselineValue - (effectiveAtr * effectiveMultiplier);
                const calcScalpLower = baselineValue - (effectiveAtr * dynamicScalpMult);
                const calcScalpUpper = baselineValue + (effectiveAtr * dynamicScalpMult);

                const baseBudget = currentEquity * (effectiveRatio / 100);
                const scalpBudget = baseBudget * 0.8;

                const hasPos = positionAmount > 0;
                const effectiveEntry = entryPrice || currentPrice;

                // ── Buy Conditions ──
                // Rule 8: Lower Band Dip
                const distLowerBand = currentPrice - calcLowerBand;
                const distLowerBandPct = (distLowerBand / currentPrice) * 100;
                const isLowerBandActive = !hasPos && currentPrice <= calcLowerBand;

                // Rule 8-b: Box Lower Scalp
                const distScalpLower = currentPrice - calcScalpLower;
                const distScalpLowerPct = (distScalpLower / currentPrice) * 100;
                const isScalpLowerActive = !hasPos && autoPilotEnabled && marketRegime !== 'BULL' && currentPrice <= calcScalpLower && currentPrice > calcLowerBand;

                // Rule 8-c: Box Low Bounce
                const SCALP_BOUNCE_LOOKBACK = 10;
                const SCALP_BOUNCE_CONFIRM_PERCENT = 0.15;
                const recentSlice = priceHistory.slice(-SCALP_BOUNCE_LOOKBACK).map((p: any) => p.price);
                const recentLow = recentSlice.length > 0 ? Math.min(...recentSlice) : currentPrice;
                const bounceThreshold = recentLow * (1 + SCALP_BOUNCE_CONFIRM_PERCENT / 100);
                const wasGenuineDip = recentLow <= baselineValue;
                const stillBelowBaseline = currentPrice <= baselineValue;
                const hasBounced = currentPrice > recentLow && currentPrice >= bounceThreshold;
                const isScalpBounceActive = !hasPos && autoPilotEnabled && marketRegime !== 'BULL' && priceHistory.length >= SCALP_BOUNCE_LOOKBACK && wasGenuineDip && stillBelowBaseline && hasBounced;
                const distBounce = bounceThreshold - currentPrice;
                const bounceConditionMet = currentPrice > recentLow && wasGenuineDip && stillBelowBaseline;

                // Rule 9: Breakout Entry (3-Tier Filter Checks)
                const isBreakoutBaselineMet = currentPrice > baselineValue;
                const isBreakoutSlopeMet = marketRegime === 'BULL' || currentSlope >= 0.10;
                const isBreakoutRsiMet = rsiValue <= 68;
                const isBreakoutVolumeMet = volumeMultiplier >= 1.15;
                const isBreakoutActive = !hasPos && isBreakoutBaselineMet && isBreakoutSlopeMet && isBreakoutRsiMet && isBreakoutVolumeMet;
                const distBaseline = currentPrice - baselineValue;

                // Rule 9-b: Box Upper Scalp
                const isAboveBaseline = currentPrice > baselineValue;
                const isBelowScalpUpper = currentPrice <= calcScalpUpper;
                const isBoxRsiMet = rsiValue <= 65;
                const isScalpUpperActive = !hasPos && autoPilotEnabled && marketRegime === 'SIDEWAYS' && isAboveBaseline && isBelowScalpUpper && isBoxRsiMet;
                const scalpUpperExceeded = isAboveBaseline && !isBelowScalpUpper;
                const distScalpUpperExceed = currentPrice - calcScalpUpper;

                // Rule 6: DCA Slots (-2.0%, -4.2%, -5.5%)
                const dca1Price = effectiveEntry * 0.980;
                const dca2Price = effectiveEntry * 0.958;
                const dca3Price = effectiveEntry * 0.945;
                const distDca1 = currentPrice - dca1Price;
                const distDca2 = currentPrice - dca2Price;
                const distDca3 = currentPrice - dca3Price;
                const isDca1Active = hasPos && safetyOrderCount === 0 && currentPrice <= dca1Price;
                const isDca2Active = hasPos && safetyOrderCount === 1 && currentPrice <= dca2Price;

                // Rule 7 & 7-b: Pyramiding Buy
                const BOX_PYRAMID_MAX_ADDS = 2;
                const BOX_PYRAMID_STEP_PERCENT = 0.25;
                const boxPyramidTargetPrice = effectiveEntry * (1 + BOX_PYRAMID_STEP_PERCENT / 100);
                const isBoxPyramidActive = hasPos && pyramidingEnabled && autoPilotEnabled && marketRegime === 'SIDEWAYS' && !isTrailingActive && boxPyramidCount < BOX_PYRAMID_MAX_ADDS && currentPrice >= boxPyramidTargetPrice;
                const distBoxPyramid = boxPyramidTargetPrice - currentPrice;

                const bullPyramidTargetPrice = effectiveEntry * (1 + (pyramidingStepPercent * (pyramidingCount + 1)) / 100);
                const isBullPyramidActive = hasPos && pyramidingEnabled && marketRegime === 'BULL' && !isTrailingActive && pyramidingCount < maxPyramidingOrders && currentPrice >= bullPyramidTargetPrice;
                const distBullPyramid = bullPyramidTargetPrice - currentPrice;

                // ── Sell & Defense Conditions ──
                // Rule 4: Stepped Scalp TP
                let steppedScalpTp = dynamicScalpTp;
                if (boxPyramidCount === 1) steppedScalpTp = Math.max(steppedScalpTp, 0.65);
                else if (boxPyramidCount >= 2) steppedScalpTp = Math.max(steppedScalpTp, 0.85);
                const scalpTpPrice = effectiveEntry * (1 + steppedScalpTp / 100);
                const distScalpTp = scalpTpPrice - currentPrice;
                const distScalpTpPct = ((scalpTpPrice - currentPrice) / currentPrice) * 100;
                const isScalpTpActive = hasPos && autoPilotEnabled && marketRegime === 'SIDEWAYS' && !isTrailingActive && unrealizedPnlPercent >= steppedScalpTp;

                // Rule 5: Trailing Stop Exit
                const minProfitArmingPrice = effectiveEntry * 1.010;
                const effectiveArmingPrice = Math.max(calcUpperBand, minProfitArmingPrice);
                const distUpperBand = effectiveArmingPrice - currentPrice;
                const trailingTriggerPrice = Math.max((trailingPeakPrice || currentPrice) * (1 - dynamicTrailingCb / 100), effectiveEntry * 1.002);
                const distTrailingTrigger = currentPrice - trailingTriggerPrice;

                // Rule 3-a & 3-b: Capital Recycling Partial Cuts
                const trim1Price = effectiveEntry * 0.990; // -1.0%
                const trim2Price = effectiveEntry * 0.968; // -3.2%
                const distTrim1 = currentPrice - trim1Price;
                const distTrim2 = currentPrice - trim2Price;

                // Rule 1: Absolute Stop Loss (-6.0%)
                const distStopLoss = currentPrice - calculatedStopLoss;
                const distStopLossPct = (distStopLoss / currentPrice) * 100;

                return (
                  <div className="space-y-3">
                    {/* Top Summary & 3-Tier Indicator Matrix */}
                    <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 text-white p-4 rounded-3xl border border-slate-700/80 shadow-md space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="p-1.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-400/30">
                            <Crosshair className="w-5 h-5 animate-spin" style={{ animationDuration: '8s' }} />
                          </div>
                          <div>
                            <div className="text-xs font-black text-slate-100 flex items-center gap-1.5">
                              <span>실시간 매매 조건 레이더</span>
                              <span className="px-1.5 py-0.2 rounded-md bg-cyan-500/20 text-cyan-300 text-[8.5px] font-bold border border-cyan-500/30">
                                LIVE
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400">
                              국면: <strong className={marketRegime === 'BULL' ? 'text-emerald-400' : marketRegime === 'BEAR' ? 'text-rose-400' : 'text-amber-400'}>{marketRegime}</strong> · 포지션: <strong className="text-slate-200">{hasPos ? `LONG (${formatPrice(entryPrice || currentPrice)})` : 'FLAT'}</strong>
                            </div>
                          </div>
                        </div>

                        {/* Filter Tabs */}
                        <div className="flex items-center p-0.5 bg-slate-950/80 rounded-xl border border-slate-700/60 text-[10px] font-bold">
                          <button
                            onClick={() => setActiveRadarTab('ALL')}
                            className={`px-2 py-1 rounded-lg transition cursor-pointer ${
                              activeRadarTab === 'ALL' ? 'bg-cyan-500 text-slate-950 font-black shadow-xs' : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            전체
                          </button>
                          <button
                            onClick={() => setActiveRadarTab('BUY')}
                            className={`px-2 py-1 rounded-lg transition cursor-pointer ${
                              activeRadarTab === 'BUY' ? 'bg-emerald-500 text-slate-950 font-black shadow-xs' : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            🟢 매수
                          </button>
                          <button
                            onClick={() => setActiveRadarTab('SELL')}
                            className={`px-2 py-1 rounded-lg transition cursor-pointer ${
                              activeRadarTab === 'SELL' ? 'bg-rose-500 text-slate-950 font-black shadow-xs' : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            🔴 청산
                          </button>
                        </div>
                      </div>

                      {/* 6-Grid 3-Tier Indicator Matrix */}
                      <div className="grid grid-cols-3 gap-1.5 p-2.5 rounded-2xl bg-slate-950/70 border border-slate-800/80 text-[9.5px]">
                        <div className="flex flex-col bg-slate-900/60 p-1.5 rounded-xl">
                          <span className="text-slate-400 font-medium">현재 체결가</span>
                          <span className="text-slate-100 font-black mono text-xs mt-0.5">{formatPrice(currentPrice)}</span>
                        </div>
                        <div className="flex flex-col bg-slate-900/60 p-1.5 rounded-xl">
                          <span className="text-slate-400 font-medium">20MA 기준선</span>
                          <span className="text-slate-200 font-bold mono text-xs mt-0.5">₩{Math.round(baselineValue).toLocaleString()}</span>
                        </div>
                        <div className="flex flex-col bg-slate-900/60 p-1.5 rounded-xl">
                          <span className="text-slate-400 font-medium">1분 ATR 변동폭</span>
                          <span className="text-cyan-400 font-bold mono text-xs mt-0.5">₩{Math.round(effectiveAtr).toLocaleString()}</span>
                        </div>
                        <div className="flex flex-col bg-slate-900/60 p-1.5 rounded-xl">
                          <span className="text-slate-400 font-medium">14주기 RSI (과열필터)</span>
                          <span className={`font-black mono text-xs mt-0.5 ${rsiValue >= 68 ? 'text-rose-400' : rsiValue <= 35 ? 'text-emerald-400' : 'text-slate-200'}`}>
                            {rsiValue.toFixed(1)} {rsiValue >= 68 ? '(과열🔥)' : rsiValue <= 35 ? '(과매도💧)' : '(적정)'}
                          </span>
                        </div>
                        <div className="flex flex-col bg-slate-900/60 p-1.5 rounded-xl">
                          <span className="text-slate-400 font-medium">거래량 승수 (돌파검증)</span>
                          <span className={`font-black mono text-xs mt-0.5 ${volumeMultiplier >= 1.15 ? 'text-emerald-400' : 'text-slate-300'}`}>
                            {volumeMultiplier.toFixed(2)}x {volumeMultiplier >= 1.15 ? '(급증🚀)' : '(평균)'}
                          </span>
                        </div>
                        <div className="flex flex-col bg-slate-900/60 p-1.5 rounded-xl text-right">
                          <span className="text-slate-400 font-medium">1분 추세 기울기</span>
                          <span className={`font-black mono text-xs mt-0.5 ${currentSlope >= 0.1 ? 'text-emerald-400' : currentSlope <= -0.1 ? 'text-rose-400' : 'text-amber-400'}`}>
                            {currentSlope >= 0 ? '+' : ''}{currentSlope.toFixed(2)}%
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* ── 🟢 매수 조건 섹션 (BUY & PYRAMIDING & DCA) ── */}
                    {(activeRadarTab === 'ALL' || activeRadarTab === 'BUY') && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-extrabold text-emerald-800 flex items-center justify-between px-1">
                          <span className="flex items-center gap-1.5">
                            <Target className="w-3.5 h-3.5 text-emerald-600" />
                            매수 진입 & 추가매수 레이더 ({hasPos ? '포지션 보유 중 · 추가매수 감시' : 'FLAT 상태 · 1차 진입 감시'})
                          </span>
                          <span className="text-[9.5px] text-slate-500 font-mono">1 Unit = {effectiveRatio}%</span>
                        </div>

                        <div className="grid grid-cols-1 gap-2">
                          {/* 1. Rule 9: 상승 모멘텀 돌파 진입 (3-Tier Filter) */}
                          <div className={`p-3 rounded-2xl border transition-all ${
                            isBreakoutActive
                              ? 'bg-emerald-50 border-emerald-400 ring-2 ring-emerald-200 shadow-xs'
                              : 'bg-white border-slate-200 hover:border-slate-300 shadow-2xs'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 9
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">상승 모멘텀 돌파 진입</span>
                                <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 py-0.2 rounded border border-emerald-200">1.0 Unit</span>
                              </div>
                              <div>
                                {isBreakoutActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-emerald-600 text-white font-black text-[10px] animate-pulse">
                                    🎯 즉시 돌파 매수
                                  </span>
                                ) : hasPos ? (
                                  <span className="text-[9.5px] text-slate-400 font-medium">1차 진입 완료됨</span>
                                ) : (
                                  <span className="text-[10px] text-slate-500 font-mono font-bold">
                                    {marketRegime === 'BULL' ? '기준선 상향 돌파 대기' : '기울기 +0.10% 또는 BULL 전환 대기'}
                                  </span>
                                )}
                              </div>
                            </div>
                            {/* 3-Tier Filter Check badges */}
                            <div className="grid grid-cols-4 gap-1 mt-2 pt-2 border-t border-slate-100 text-[9px] font-mono">
                              <div className={`p-1 rounded-lg text-center ${isBreakoutBaselineMet ? 'bg-emerald-100 text-emerald-800 font-bold' : 'bg-slate-100 text-slate-500'}`}>
                                {isBreakoutBaselineMet ? '✅' : '⏳'} 기준선 돌파
                              </div>
                              <div className={`p-1 rounded-lg text-center ${isBreakoutSlopeMet ? 'bg-emerald-100 text-emerald-800 font-bold' : 'bg-slate-100 text-slate-500'}`}>
                                {isBreakoutSlopeMet ? '✅' : '⏳'} 기울기≥+0.1%
                              </div>
                              <div className={`p-1 rounded-lg text-center ${isBreakoutRsiMet ? 'bg-emerald-100 text-emerald-800 font-bold' : 'bg-rose-100 text-rose-800 font-bold'}`}>
                                {isBreakoutRsiMet ? '✅' : '❌'} RSI≤68 ({rsiValue.toFixed(0)})
                              </div>
                              <div className={`p-1 rounded-lg text-center ${isBreakoutVolumeMet ? 'bg-emerald-100 text-emerald-800 font-bold' : 'bg-slate-100 text-slate-500'}`}>
                                {isBreakoutVolumeMet ? '✅' : '⏳'} 거래량≥1.15x ({volumeMultiplier.toFixed(2)}x)
                              </div>
                            </div>
                          </div>

                          {/* 2. Rule 8: 하단 밴드 과매도 진입 */}
                          <div className={`p-3 rounded-2xl border transition-all ${
                            isLowerBandActive
                              ? 'bg-blue-50 border-blue-400 ring-2 ring-blue-200 shadow-xs'
                              : 'bg-white border-slate-200 hover:border-slate-300 shadow-2xs'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-blue-100 text-blue-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 8
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">하단 밴드 과매도 진입</span>
                                <span className="text-[10px] text-blue-700 font-bold bg-blue-50 px-1 py-0.2 rounded border border-blue-200">1.0 Unit</span>
                              </div>
                              <div>
                                {isLowerBandActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-blue-600 text-white font-black text-[10px] animate-pulse">
                                    🎯 과매도 진입 발동
                                  </span>
                                ) : hasPos ? (
                                  <span className="text-[9.5px] text-slate-400 font-medium">1차 진입 완료됨</span>
                                ) : (
                                  <span className="text-[10px] text-slate-500 font-mono font-bold">
                                    -{Math.round(distLowerBand).toLocaleString()}원 (-{distLowerBandPct.toFixed(2)}%) 하락 시
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              <span>하단 매수가: <strong className="text-slate-800">₩{Math.round(calcLowerBand).toLocaleString()} 이하</strong></span>
                              <span className="text-slate-400">ATR×{effectiveMultiplier} 과매도 포착</span>
                            </div>
                          </div>

                          {/* 3. Rule 8-b: 박스권 하단 스캘핑 */}
                          <div className={`p-3 rounded-2xl border transition-all ${
                            isScalpLowerActive
                              ? 'bg-cyan-50 border-cyan-400 ring-2 ring-cyan-200 shadow-xs'
                              : 'bg-white border-slate-200 hover:border-slate-300 shadow-2xs'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-cyan-100 text-cyan-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 8-b
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">박스권 하단 스캘핑 진입</span>
                                <span className="text-[10px] text-cyan-700 font-bold bg-cyan-50 px-1 py-0.2 rounded border border-cyan-200">0.8 Unit</span>
                              </div>
                              <div>
                                {isScalpLowerActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-cyan-600 text-white font-black text-[10px] animate-pulse">
                                    🎯 스캘핑 진입 구간
                                  </span>
                                ) : marketRegime === 'BULL' ? (
                                  <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 font-bold text-[9px]">BULL 제외</span>
                                ) : (
                                  <span className="text-[10px] font-mono font-bold text-cyan-700">
                                    {distScalpLower > 0 ? `+${Math.round(distScalpLower).toLocaleString()}원 하락 시` : '도달'}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              <span>진입 기준가: <strong className="text-slate-800">₩{Math.round(calcScalpLower).toLocaleString()} 이하</strong></span>
                              <span className="text-slate-400">하한선: ₩{Math.round(calcLowerBand).toLocaleString()}</span>
                            </div>
                          </div>

                          {/* 4. Rule 8-c: 저점 반등 확인 매수 */}
                          <div className={`p-3 rounded-2xl border transition-all ${
                            isScalpBounceActive
                              ? 'bg-fuchsia-50 border-fuchsia-400 ring-2 ring-fuchsia-200 shadow-xs'
                              : 'bg-white border-slate-200 hover:border-slate-300 shadow-2xs'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-fuchsia-100 text-fuchsia-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 8-c
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">박스권 저점 반등 확인 진입</span>
                                <span className="text-[10px] text-fuchsia-700 font-bold bg-fuchsia-50 px-1 py-0.2 rounded border border-fuchsia-200">0.8 Unit</span>
                              </div>
                              <div>
                                {isScalpBounceActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-fuchsia-600 text-white font-black text-[10px] animate-pulse">
                                    🚀 반등 확인! (진입)
                                  </span>
                                ) : marketRegime === 'BULL' ? (
                                  <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 font-bold text-[9px]">BULL 제외</span>
                                ) : (
                                  <span className="text-[10px] font-mono font-bold text-fuchsia-700">
                                    +0.15% 반등 대기 (+{Math.round(distBounce).toLocaleString()}원)
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              <span>최근 10분 저점: <strong>₩{Math.round(recentLow).toLocaleString()}</strong></span>
                              <span className="text-slate-400">목표 반등가: ₩{Math.round(bounceThreshold).toLocaleString()}</span>
                            </div>
                          </div>

                          {/* 5. Rule 9-b: 박스권 상단 스캘핑 */}
                          <div className={`p-3 rounded-2xl border transition-all ${
                            isScalpUpperActive
                              ? 'bg-teal-50 border-teal-400 ring-2 ring-teal-200 shadow-xs'
                              : scalpUpperExceeded
                              ? 'bg-amber-50/60 border-amber-300'
                              : 'bg-white border-slate-200 hover:border-slate-300 shadow-2xs'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-teal-100 text-teal-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 9-b
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">박스권 상단 스캘핑 진입</span>
                                <span className="text-[10px] text-teal-700 font-bold bg-teal-50 px-1 py-0.2 rounded border border-teal-200">0.8 Unit</span>
                              </div>
                              <div>
                                {isScalpUpperActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-teal-600 text-white font-black text-[10px] animate-pulse">
                                    🎯 상단 진입 구간
                                  </span>
                                ) : scalpUpperExceeded ? (
                                  <span className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 border border-amber-300 font-bold text-[9px]">
                                    ⚠️ 상한선 +{Math.round(distScalpUpperExceed).toLocaleString()}원 초과 (보호)
                                  </span>
                                ) : marketRegime !== 'SIDEWAYS' ? (
                                  <span className="text-[9.5px] text-slate-400 font-medium">SIDEWAYS 전용</span>
                                ) : (
                                  <span className="text-[10px] text-teal-700 font-mono font-bold">
                                    기준선 상향 돌파 시 진입 (+{Math.round(distBaseline).toLocaleString()}원)
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              <span>진입 구간: <strong className="text-slate-800">₩{Math.round(baselineValue).toLocaleString()} ~ ₩{Math.round(calcScalpUpper).toLocaleString()}</strong></span>
                              <span className={isBoxRsiMet ? 'text-emerald-600 font-bold' : 'text-rose-600 font-bold'}>RSI {rsiValue.toFixed(0)} (≤65)</span>
                            </div>
                          </div>

                          {/* 6. Rule 6: DCA 자금순환형 저점 스케일업 추매 (1.5x / 2.0x / 1.5x) */}
                          <div className="p-3 rounded-2xl bg-white border border-indigo-200 shadow-2xs space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-indigo-100 text-indigo-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 6
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">DCA 저점 스케일업 추매</span>
                                <span className="text-[10px] text-indigo-700 font-bold bg-indigo-50 px-1 py-0.2 rounded border border-indigo-200">1.5x / 2.0x Unit</span>
                              </div>
                              <span className="text-[9.5px] text-indigo-600 font-bold font-mono">
                                {hasPos ? `평단 ₩${Math.round(effectiveEntry).toLocaleString()} 기준` : '포지션 진입 시 활성'}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-1.5 text-[9.5px] font-mono">
                              <div className={`p-2 rounded-xl border ${safetyOrderCount >= 1 ? 'bg-slate-100 border-slate-200 text-slate-400' : isDca1Active ? 'bg-indigo-100 border-indigo-400 text-indigo-900 font-bold animate-pulse' : 'bg-indigo-50/60 border-indigo-200 text-indigo-900'}`}>
                                <div className="font-extrabold text-[10px] flex items-center justify-between">
                                  <span>DCA #1차</span>
                                  <span className="text-[8.5px] bg-indigo-200 px-1 rounded">1.5x Unit</span>
                                </div>
                                <div className="mt-1 font-bold">₩{Math.round(dca1Price).toLocaleString()}</div>
                                <div className="text-[8.5px] text-slate-500">{safetyOrderCount >= 1 ? '✅ 체결 완료' : distDca1 > 0 ? `-${Math.round(distDca1).toLocaleString()}원 (-2.0%)` : '🎯 도달'}</div>
                              </div>

                              <div className={`p-2 rounded-xl border ${safetyOrderCount >= 2 ? 'bg-slate-100 border-slate-200 text-slate-400' : isDca2Active ? 'bg-indigo-100 border-indigo-400 text-indigo-900 font-bold animate-pulse' : 'bg-indigo-50/60 border-indigo-200 text-indigo-900'}`}>
                                <div className="font-extrabold text-[10px] flex items-center justify-between">
                                  <span>DCA #2차</span>
                                  <span className="text-[8.5px] bg-indigo-200 px-1 rounded">2.0x Unit</span>
                                </div>
                                <div className="mt-1 font-bold">₩{Math.round(dca2Price).toLocaleString()}</div>
                                <div className="text-[8.5px] text-slate-500">{safetyOrderCount >= 2 ? '✅ 체결 완료' : distDca2 > 0 ? `-${Math.round(distDca2).toLocaleString()}원 (-4.2%)` : '🎯 도달'}</div>
                              </div>

                              <div className="p-2 rounded-xl border bg-indigo-50/60 border-indigo-200 text-indigo-900">
                                <div className="font-extrabold text-[10px] flex items-center justify-between">
                                  <span>DCA #3차</span>
                                  <span className="text-[8.5px] bg-indigo-200 px-1 rounded">1.5x Unit</span>
                                </div>
                                <div className="mt-1 font-bold">₩{Math.round(dca3Price).toLocaleString()}</div>
                                <div className="text-[8.5px] text-slate-500">{safetyOrderCount >= 3 ? '✅ 체결 완료' : distDca3 > 0 ? `-${Math.round(distDca3).toLocaleString()}원 (-5.5%)` : '🎯 도달'}</div>
                              </div>
                            </div>
                          </div>

                          {/* 7. Rule 7 & 7-b: 불타기 (Pyramiding) */}
                          <div className="p-3 rounded-2xl bg-white border border-fuchsia-200 shadow-2xs space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-fuchsia-100 text-fuchsia-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 7 / 7-b
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">상승 불타기 (Pyramiding)</span>
                                <span className="text-[10px] text-fuchsia-700 font-bold bg-fuchsia-50 px-1 py-0.2 rounded border border-fuchsia-200">0.50 Unit 스케일업</span>
                              </div>
                              <span className="text-[9.5px] text-fuchsia-700 font-bold font-mono">
                                {marketRegime === 'SIDEWAYS' ? `박스권: +0.25% 마다 (최대 2회)` : `BULL: +1.5% 마다`}
                              </span>
                            </div>
                            <div className="flex items-center justify-between p-2 rounded-xl bg-fuchsia-50 border border-fuchsia-200 text-[10px] font-mono">
                              <div>
                                <span className="text-slate-500 font-medium">{marketRegime === 'SIDEWAYS' ? '박스권 불타기' : '대세 상승 불타기'}: </span>
                                <strong className="text-fuchsia-900">₩{Math.round(marketRegime === 'SIDEWAYS' ? boxPyramidTargetPrice : bullPyramidTargetPrice).toLocaleString()}</strong>
                              </div>
                              <div>
                                {isBoxPyramidActive || isBullPyramidActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-fuchsia-600 text-white font-bold animate-pulse">🚀 불타기 발동!</span>
                                ) : !hasPos ? (
                                  <span className="text-slate-400">포지션 진입 시 활성</span>
                                ) : boxPyramidCount >= 2 ? (
                                  <span className="text-slate-400">2회 한도 소진 (익절 대기)</span>
                                ) : (
                                  <span className="text-fuchsia-700 font-bold">+{Math.round(distBoxPyramid).toLocaleString()}원 상승 시 체결</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── 🔴 매도/익절/손절 조건 섹션 (SELL & EXIT & DEFENSE) ── */}
                    {(activeRadarTab === 'ALL' || activeRadarTab === 'SELL') && (
                      <div className="space-y-2 pt-1">
                        <div className="text-[11px] font-extrabold text-rose-800 flex items-center justify-between px-1">
                          <span className="flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-rose-600" />
                            매도 & 리스크 관리 레이더 {hasPos ? `(수익률: ${unrealizedPnlPercent >= 0 ? '+' : ''}${unrealizedPnlPercent.toFixed(2)}%)` : '(포지션 진입 시 즉시 활성화)'}
                          </span>
                          <span className="text-[9.5px] text-slate-500 font-mono">손절선 실시간 감시</span>
                        </div>

                        <div className="grid grid-cols-1 gap-2">
                          {/* 1. Rule 4: 박스권 스캘핑 100% 전량 익절 */}
                          <div className={`p-3 rounded-2xl border transition-all ${
                            isScalpTpActive
                              ? 'bg-teal-50 border-teal-400 ring-2 ring-teal-200'
                              : hasPos && marketRegime === 'SIDEWAYS'
                              ? 'bg-white border-teal-200 shadow-2xs'
                              : 'bg-white border-slate-200 shadow-2xs opacity-90'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-teal-100 text-teal-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 4
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">박스권 스캘핑 전량 익절</span>
                                <span className="text-[10px] text-teal-700 font-bold bg-teal-50 px-1 py-0.2 rounded border border-teal-200">+{steppedScalpTp.toFixed(2)}% 목표</span>
                              </div>
                              <div>
                                {isScalpTpActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-teal-600 text-white font-black text-[10px] animate-pulse">
                                    🎯 익절 발동! (100% 매도)
                                  </span>
                                ) : hasPos ? (
                                  <span className="text-[10px] font-mono font-bold text-teal-700">
                                    {distScalpTp > 0 ? `+${Math.round(distScalpTp).toLocaleString()}원 (+${distScalpTpPct.toFixed(2)}%) 상승 시` : '도달'}
                                  </span>
                                ) : (
                                  <span className="text-[9.5px] text-slate-400 font-mono">목표 +{steppedScalpTp.toFixed(2)}%</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              <span>목표 익절가: <strong className="text-teal-700">₩{Math.round(scalpTpPrice).toLocaleString()}</strong></span>
                              <span className="text-slate-400">체결 시 100% 전량 청산 ➡️ 30초 쿨다운</span>
                            </div>
                          </div>

                          {/* 2. Rule 5: 트레일링 2단계 익절 (1차 50% ➡️ 2차 전량 100%) */}
                          <div className={`p-3 rounded-2xl border transition-all ${
                            isTrailingActive
                              ? 'bg-emerald-50 border-emerald-400 ring-2 ring-emerald-200 shadow-xs'
                              : 'bg-white border-slate-200 shadow-2xs'
                          }`}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-emerald-100 text-emerald-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 5
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">
                                  트레일링 {trailingExitCount >= 1 ? '2차 전량(100%)' : '1차 50%'} 익절
                                </span>
                                <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 py-0.2 rounded border border-emerald-200">-{dynamicTrailingCb}% 콜백</span>
                              </div>
                              <div>
                                {isTrailingActive ? (
                                  <span className="px-2 py-0.5 rounded-md bg-emerald-600 text-white font-black text-[10px] animate-pulse shadow-sm">
                                    🔥 최고가 ₩{Math.round(trailingPeakPrice || currentPrice).toLocaleString()} 추적 중
                                  </span>
                                ) : (
                                  <span className="text-[10px] text-slate-500 font-mono font-bold">
                                    무장까지 {distUpperBand > 0 ? `+${Math.round(distUpperBand).toLocaleString()}원` : '무장 완료'}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              {isTrailingActive ? (
                                <>
                                  <span>{trailingExitCount >= 1 ? '2차 전량 매도가' : '1차 50% 매도가'}: <strong className="text-emerald-700 font-bold">₩{Math.round(trailingTriggerPrice).toLocaleString()}</strong></span>
                                  <span className="text-emerald-600 font-bold">현재가 대비 -{Math.round(distTrailingTrigger).toLocaleString()}원 시 체결</span>
                                </>
                              ) : (
                                <>
                                  <span>무장 목표가: <strong className="text-emerald-700">₩{Math.round(effectiveArmingPrice).toLocaleString()}</strong> (수익률 ≥ +1.0%)</span>
                                  <span className="text-slate-400">1차 50% ➡️ 2차 100% 전량 청산</span>
                                </>
                              )}
                            </div>
                          </div>

                          {/* 3. Rule 3-a & 3-b: 자금순환 2단계 리사이클링 덜어내기 */}
                          <div className="p-3 rounded-2xl bg-white border border-amber-200 shadow-2xs space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-900 font-extrabold font-mono text-[9.5px]">
                                  Rule 3-a / 3-b
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">자금순환 리사이클링 덜어내기</span>
                                <span className="text-[10px] text-amber-800 font-bold bg-amber-50 px-1 py-0.2 rounded border border-amber-200">1차 30% ➡️ 2차 50%</span>
                              </div>
                              <span className="text-[9.5px] text-amber-700 font-bold font-mono">현금 확보 ➡️ DCA 바닥 추매 대기</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-[9.5px] font-mono">
                              <div className="p-2 rounded-xl bg-amber-50/60 border border-amber-200 text-amber-950">
                                <div className="font-extrabold flex items-center justify-between">
                                  <span>1단계 (-1.0%)</span>
                                  <span className="text-[8.5px] bg-amber-200 px-1 rounded">30% 매도</span>
                                </div>
                                <div className="mt-1 font-bold">₩{Math.round(trim1Price).toLocaleString()}</div>
                                <div className="text-[8.5px] text-slate-500">{distTrim1 > 0 ? `-${Math.round(distTrim1).toLocaleString()}원 하락 시` : '발동'}</div>
                              </div>

                              <div className="p-2 rounded-xl bg-amber-50/60 border border-amber-200 text-amber-950">
                                <div className="font-extrabold flex items-center justify-between">
                                  <span>2단계 (-3.2%)</span>
                                  <span className="text-[8.5px] bg-amber-200 px-1 rounded">50% 매도</span>
                                </div>
                                <div className="mt-1 font-bold">₩{Math.round(trim2Price).toLocaleString()}</div>
                                <div className="text-[8.5px] text-slate-500">{distTrim2 > 0 ? `-${Math.round(distTrim2).toLocaleString()}원 하락 시` : '발동'}</div>
                              </div>
                            </div>
                          </div>

                          {/* 4. Rule 2: 급락 가속도 비상 탈출 */}
                          <div className="p-3 rounded-2xl bg-white border border-slate-200 shadow-2xs">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-purple-100 text-purple-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 2
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">급락 가속도 비상 탈출</span>
                                <span className="text-[10px] text-purple-700 font-bold bg-purple-50 px-1 py-0.2 rounded border border-purple-200">40% 긴급 청산</span>
                              </div>
                              <span className={`text-[10px] font-mono font-black ${dropSpeed <= -1.0 ? 'text-rose-600 animate-pulse' : 'text-slate-500'}`}>
                                현재 낙폭: {dropSpeed.toFixed(2)}% (기준: ≤-1.8%)
                              </span>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              <span>3초 내 -1.8% 폭락 감지 시 40% 즉시 손절하여 플래시 크래시 방어</span>
                              <span className="text-slate-400">비상 상태 전환</span>
                            </div>
                          </div>

                          {/* 5. Rule 1: 마지노선 절대 손절 */}
                          <div className="p-3 rounded-2xl bg-white border border-rose-200 shadow-2xs">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-rose-100 text-rose-800 font-extrabold font-mono text-[9.5px]">
                                  Rule 1
                                </span>
                                <span className="font-extrabold text-xs text-slate-900">마지노선 100% 절대 손절</span>
                                <span className="text-[10px] text-rose-700 font-bold bg-rose-50 px-1 py-0.2 rounded border border-rose-200">-6.0% 바닥선</span>
                              </div>
                              <div>
                                <span className={`text-[10px] font-mono font-bold ${distStopLoss < (atrValue * 0.5) ? 'text-rose-600 animate-pulse' : 'text-slate-500'}`}>
                                  남은 버퍼: ₩{Math.round(distStopLoss).toLocaleString()} ({distStopLossPct.toFixed(2)}%)
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-2 pt-1.5 border-t border-slate-100 text-[10px] text-slate-500 font-mono">
                              <span>절대 손절가: <strong className="text-rose-600 font-bold">₩{Math.round(calculatedStopLoss).toLocaleString()}</strong></span>
                              <span className="text-slate-400">발동 시 100% 전량 매도 ➡️ 3분 진정 쿨다운</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
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
                    최근 가격 데이터가 충분하면 국면별 고정 자동값을 사용합니다. 상승/횡보/하락 순으로 <strong>ATR 1.8× / 2.4× / 3.5×</strong>, <strong>진입 비중 20% / 18% / 10%</strong>가 적용됩니다. 아래 수동값은 오토파일럿을 끈 경우에만 주문에 반영됩니다.
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
                    <span className="text-slate-700">ATR 밴드 배수 <span className="font-medium text-slate-400">(수동 모드)</span></span>
                    <span className="text-blue-600 mono">{atrMultiplier.toFixed(1)}x</span>
                  </div>
                  <input
                    type="range"
                    min="1.0"
                    max="4.0"
                    step="0.1"
                    value={atrMultiplier}
                    onChange={(e) => handleParamsChange({ atrMultiplier: parseFloat(e.target.value) })}
                    disabled={autoPilotEnabled}
                    className="w-full accent-blue-600 cursor-pointer disabled:cursor-not-allowed h-2 bg-slate-200 rounded-lg appearance-none"
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
                    <span className="text-slate-700">1회 진입 비중 <span className="font-medium text-slate-400">(수동 모드)</span></span>
                    <span className="text-blue-600 mono">{orderRatio}%</span>
                  </div>
                  <input
                    type="range"
                    min="5"
                    max="100"
                    step="5"
                    value={orderRatio}
                    onChange={(e) => handleParamsChange({ orderRatio: parseInt(e.target.value) })}
                    disabled={autoPilotEnabled}
                    className="w-full accent-blue-600 cursor-pointer disabled:cursor-not-allowed h-2 bg-slate-200 rounded-lg appearance-none"
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
                      disabled={autoPilotEnabled}
                      className="w-full accent-emerald-600 cursor-pointer disabled:cursor-not-allowed h-2 bg-slate-200 rounded-lg appearance-none"
                    />
                    <div className="flex justify-between text-[10px] text-slate-400">
                      <span>0.3% (빠른익절)</span>
                      <span>0.8% (추천)</span>
                      <span>2.5% (여유)</span>
                    </div>
                    <p className="text-[10px] text-slate-500 bg-emerald-50/60 p-2 rounded-xl border border-emerald-100">
                      💡 평단 대비 최소 +1.0%와 상단 밴드를 모두 넘으면 추적을 시작합니다. 첫 꺾임 매도는 <strong>50%</strong>, 다음 꺾임 때 잔량을 전량 매도합니다. 오토파일럿 ON에서는 콜백이 변동성에 따라 <strong>0.8% 또는 1.2%</strong>로 자동 적용됩니다.
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
                        max="2"
                        step="1"
                        value={maxSafetyOrders}
                        onChange={(e) => handleParamsChange({ maxSafetyOrders: parseInt(e.target.value) })}
                        className="w-full accent-indigo-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>1회 (소극적)</span>
                        <span>2회</span>
                        <span>3회 (최대)</span>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-500 bg-indigo-50/60 p-2 rounded-xl border border-indigo-100">
                      💡 DCA 기준은 고정입니다: <strong>1차 -2.0% · 2차 접근 반등 -3.5%~-4.15% · 2차 본 기준 -4.2% · 3차 -5.5%</strong>. 2차는 접근 구간을 터치한 뒤 최근 저점 대비 <strong>+0.7% 반등</strong>, 단기 기울기 <strong>+0.05% 이상</strong>, 그리고 현재가가 평단 대비 <strong>-2.5% 이하</strong>일 때 2차 예산의 <strong>40%</strong>를 먼저 매수합니다. 이후 -4.2% 도달 시 남은 <strong>60%</strong>만 집행합니다. 각 단계의 총 주문 금액은 기본 주문의 1.5× · 2.0× · 1.5×입니다.
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
                        <span>2회 (한도)</span>
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
                      💡 상승장(BULL)에서만 작동합니다. 기본 진입은 오토파일럿 기준 <strong>20%</strong>이며, 불타기는 평단 <strong>+{pyramidingStepPercent.toFixed(1)}%에서 0.50 Unit</strong>, <strong>+{(pyramidingStepPercent * 2).toFixed(1)}%에서 0.35 Unit</strong>까지만 허용됩니다. 1차 체결 뒤에는 전체 평단 +0.1% 보호선이 생기고, 2차 체결 뒤에는 추가 매수가 차단되며 트레일링 콜백은 최대 <strong>0.6%</strong>로 조여집니다. 횡보장 오토파일럿은 별도 고정 규칙으로 평단 +0.25%에서 최대 2회, 각 0.5 Unit씩 추가 매수합니다.
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
                    <p className="text-[10px] text-slate-500 bg-purple-50/60 p-2 rounded-xl border border-purple-100">
                      💡 고정 방어 규칙입니다. 평단 대비 <strong>-1.0%에서 30%</strong>, 이후 <strong>-3.2%에서 남은 물량의 50%</strong>를 매도합니다. DCA 소진 여부와 무관하며, 부분손절 뒤 60초 쿨다운을 둡니다.
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
                        <span className="text-slate-700">급락 감지 민감도 <span className="font-medium text-slate-400">(3초 창)</span></span>
                        <span className="text-cyan-600 mono">-{trendDropSpeedThreshold.toFixed(1)}% / 3초</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="3.0"
                        step="0.1"
                        value={trendDropSpeedThreshold}
                        onChange={(e) => handleParamsChange({ trendDropSpeedThreshold: parseFloat(e.target.value) })}
                        className="w-full accent-cyan-600 cursor-pointer h-2 bg-slate-200 rounded-lg appearance-none"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>0.1% (매우 민감)</span>
                        <span>1.8% (기본)</span>
                        <span>3.0% (둔감)</span>
                      </div>
                    </div>

                    <p className="text-[10px] text-slate-500 bg-cyan-50/60 p-2 rounded-xl border border-cyan-100">
                      💡 최근 3초 변동률이 <strong>-{trendDropSpeedThreshold.toFixed(1)}%</strong> 이하이고 하단 밴드를 이탈하면 보유 물량의 40%를 매도합니다. 이후 재매수는 별도 바닥 지지 조건이 충족될 때만 가능합니다.
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

              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3.5 shadow-2xs">
                <div className="flex items-start gap-2.5">
                  <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-extrabold text-rose-900">서버 재시작</p>
                    <p className="mt-0.5 text-[10px] leading-relaxed text-rose-700">저장된 주문·포지션 상태를 다시 동기화한 뒤 자동으로 재연결합니다. 재시작 중에는 주문을 만들지 않습니다.</p>
                  </div>
                </div>
                <button
                  disabled={serverRestarting || !wsConnected}
                  onClick={() => setShowRestartConfirm(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-rose-600 py-2.5 text-xs font-extrabold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${serverRestarting ? 'animate-spin' : ''}`} />
                  {serverRestarting ? '서버 재시작·자동 재연결 중...' : wsConnected ? '서버 재시작' : '서버 연결 대기 중'}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'lab' && (
            <div className="space-y-3">
              <div className="bg-gradient-to-br from-violet-700 to-indigo-800 p-4 rounded-2xl text-white shadow-sm">
                <div className="flex items-start gap-2">
                  <Brain className="w-5 h-5 mt-0.5" />
                  <div>
                    <h2 className="font-extrabold text-sm">전략 실험실</h2>
                    <p className="text-[10px] text-violet-100 mt-1">백테스트 후보를 하나씩 소액 실거래로 검증하는 공간입니다. 모든 실험은 기본 OFF입니다.</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  ['틱 기록', researchStats.ticksRecorded],
                  ['완결 1분봉', researchStats.candlesRecorded],
                  ['규칙 차이', researchStats.shadowDifferences]
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-violet-100 bg-violet-50 p-2 text-center">
                    <div className="text-[9px] text-violet-600 font-bold">{label}</div>
                    <div className="mono text-sm font-extrabold text-violet-900 mt-0.5">{Number(value).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <p className="px-1 text-[9.5px] text-slate-500">{researchStats.enabled ? '● 수집 중 — 실제 주문 없이 기본 규칙과 각 후보의 신호 차이만 기록합니다.' : '서버 재시작 후 연구 수집기가 시작됩니다.'}</p>

              <div className="bg-white p-3 rounded-2xl border border-amber-200 shadow-2xs space-y-2">
                <div className="text-xs font-extrabold text-slate-900">포지션 안전 보정</div>
                <p className="text-[10px] leading-relaxed text-slate-500">재시작·부분 체결 뒤 실제 보유 수량과 평단은 맞지만 손절·부분손절 상태가 오래된 경우에만 사용합니다. DCA 사용 기록은 유지합니다.</p>
                <button disabled={isBotActive} onClick={handlePositionRebase} className="w-full rounded-xl bg-amber-500 py-2 text-[11px] font-extrabold text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40">거래소 기준으로 포지션 보정</button>
                {rebaseStatus && <p className="text-[10px] text-slate-600">{rebaseStatus}</p>}
              </div>

              {isBotActive && (
                <div className="p-3 rounded-2xl border border-amber-200 bg-amber-50 text-[11px] text-amber-800">
                  <strong>봇 가동 중:</strong> 실험 토글은 판단 규칙의 중간 변경을 막기 위해 봇을 정지한 상태에서만 바꿀 수 있습니다.
                </div>
              )}

              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2">
                <div className="text-xs font-extrabold text-slate-900">박스권 익절 · 추세 전환 보호</div>
                <p className="text-[10px] text-slate-500">거래량 20분 평균 1.5배·단기 기울기 +0.05% 이상인 상승 확장 구간에서만 적용됩니다. 기본 규칙은 전량 익절이며, 모든 항목은 독립 실험입니다.</p>
                {[
                  { key: 'expansion', title: '추세 확장 50% 분할 익절', detail: '전량 익절 대신 절반만 실현하고, 잔량은 평단 +0.2% 보호선으로 관리', enabled: experimentScalpTrendExpansionEnabled },
                  { key: 'cooldown', title: '익절 후 추격매수 방지', detail: '박스권 전량 익절 뒤 3분간 신규 돌파 매수 등을 대기', enabled: experimentScalpReentryCooldownEnabled },
                  { key: 'trailing', title: '추세 확장 트레일링 조기 무장', detail: '확장 조건일 때만 트레일링 무장 기준을 +1.0%에서 +0.8%로 완화', enabled: experimentTrendTrailingArmingEnabled }
                ].map((experiment) => {
                  const nextParams = experiment.key === 'expansion'
                    ? { experimentScalpTrendExpansionEnabled: !experiment.enabled }
                    : experiment.key === 'cooldown'
                      ? { experimentScalpReentryCooldownEnabled: !experiment.enabled }
                      : { experimentTrendTrailingArmingEnabled: !experiment.enabled };
                  return (
                    <div key={experiment.key} className="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                      <div><div className="text-[11px] font-bold text-slate-800">{experiment.title}</div><div className="text-[9.5px] text-slate-500 mt-0.5">{experiment.detail}</div></div>
                      <button disabled={isBotActive} onClick={() => handleParamsChange(nextParams)} className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${experiment.enabled ? 'bg-violet-600' : 'bg-slate-300'}`}>
                        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${experiment.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2">
                <div className="text-xs font-extrabold text-slate-900">DCA 2차 접근 반등 선매수</div>
                <p className="text-[10px] text-slate-500">원래 반등 조건은 유지하며, 아래 필터는 2차 예산 40%의 선매수에만 적용됩니다. -4.2% 잔여 60% 매수는 막지 않습니다.</p>
                {[
                  { key: 'rsi', title: 'RSI 회복 확인', detail: 'RSI가 35 이상일 때만 반등 선매수', enabled: experimentDca2RsiRecoveryEnabled },
                  { key: 'volume', title: '거래량 확인', detail: '거래량이 20분 평균의 1.05배 이상일 때만 선매수', enabled: experimentDca2VolumeConfirmationEnabled }
                ].map((experiment) => (
                  <div key={experiment.key} className="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                    <div><div className="text-[11px] font-bold text-slate-800">{experiment.title}</div><div className="text-[9.5px] text-slate-500 mt-0.5">{experiment.detail}</div></div>
                    <button disabled={isBotActive} onClick={() => handleParamsChange(experiment.key === 'rsi' ? { experimentDca2RsiRecoveryEnabled: !experiment.enabled } : { experimentDca2VolumeConfirmationEnabled: !experiment.enabled })} className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${experiment.enabled ? 'bg-violet-600' : 'bg-slate-300'}`}>
                      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${experiment.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2">
                <div className="text-xs font-extrabold text-slate-900">BULL 상승 불타기</div>
                <p className="text-[10px] text-slate-500">기존의 수익률·BULL 국면·최대 2단계 조건에 선택적으로 추가되는 진입 품질 필터입니다.</p>
                {[
                  { key: 'rsi', title: 'RSI 과열 방지', detail: 'RSI 55~68 구간에서만 불타기', enabled: experimentPyramidRsiGuardEnabled },
                  { key: 'volume', title: '거래량 확인', detail: '거래량이 20분 평균의 1.15배 이상일 때만 불타기', enabled: experimentPyramidVolumeConfirmationEnabled }
                ].map((experiment) => (
                  <div key={experiment.key} className="flex items-center justify-between gap-3 p-2.5 rounded-xl bg-slate-50 border border-slate-100">
                    <div><div className="text-[11px] font-bold text-slate-800">{experiment.title}</div><div className="text-[9.5px] text-slate-500 mt-0.5">{experiment.detail}</div></div>
                    <button disabled={isBotActive} onClick={() => handleParamsChange(experiment.key === 'rsi' ? { experimentPyramidRsiGuardEnabled: !experiment.enabled } : { experimentPyramidVolumeConfirmationEnabled: !experiment.enabled })} className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${experiment.enabled ? 'bg-violet-600' : 'bg-slate-300'}`}>
                      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${experiment.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                ))}
              </div>

              <p className="px-1 text-[10px] leading-relaxed text-slate-500">권장 순서: 실험 하나만 ON → 충분한 거래·시장 국면 기록 → 수수료 차감 손익과 최대낙폭 확인 → 유지 또는 OFF. 여러 항목을 한 번에 켜면 어떤 조건의 효과인지 분리할 수 없습니다.</p>
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
                    <span className="text-slate-500">누적 실현 순손익 (수수료 차감 후)</span>
                    <span className={`font-bold mono ${displayedTotalRealizedPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {displayedTotalRealizedPnl >= 0 ? '+' : ''}{formatPrice(displayedTotalRealizedPnl)}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">누적 거래 수수료 (0.05%)</span>
                    <span className="font-bold mono text-amber-600">-{formatPrice(totalFeesPaid)}</span>
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

                <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70">
                  <button
                    onClick={() => setIsDailyPerformanceOpen((open) => !open)}
                    className="flex w-full items-center justify-between px-3 py-2.5 text-left"
                    aria-expanded={isDailyPerformanceOpen}
                  >
                    <span>
                      <span className="block text-xs font-bold text-slate-800">일별 순손익</span>
                      <span className="mt-0.5 block text-[10px] text-slate-400">
                        {isEstimatedDailyPerformance ? '체결 로그 기반 수수료 추정치' : '실현손익에서 매수·매도 수수료를 차감'}
                      </span>
                    </span>
                    <span className="text-[11px] font-semibold text-blue-600">{isDailyPerformanceOpen ? '접기 ↑' : '최근 7일 보기 ↓'}</span>
                  </button>

                  {isDailyPerformanceOpen && (
                    <div className="border-t border-slate-200 bg-white px-3 py-2">
                      <div className="mb-1 flex items-center justify-between text-[10px] text-slate-400">
                        <span>최근 7일 · 아래로 스크롤하면 이전 기록</span>
                        <span>순손익</span>
                      </div>
                      <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto overscroll-contain pr-1">
                        {[...recentDailyPerformance, ...olderDailyPerformance].map((day) => (
                          <div key={day.date} className="flex items-center justify-between gap-3 py-2 text-[11px]">
                            <div>
                              <p className="font-medium text-slate-700">{day.date}</p>
                              <p className="mt-0.5 text-[10px] text-slate-400">
                                실현 {day.realizedPnl >= 0 ? '+' : ''}{formatPrice(day.realizedPnl)} · 수수료 -{formatPrice(day.fees)} · 매도 {day.sellCount}건
                              </p>
                            </div>
                            <span className={`shrink-0 font-bold mono ${day.netPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {day.netPnl >= 0 ? '+' : ''}{formatPrice(day.netPnl)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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

        {showRestartConfirm && (
          <div className="absolute inset-0 z-[70] grid place-items-center bg-slate-950/45 p-5 backdrop-blur-[1px]">
            <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
              <div className="flex items-start gap-2.5">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-100 text-rose-600"><RefreshCw className="h-4 w-4" /></div>
                <div>
                  <h3 className="text-sm font-extrabold text-slate-900">서버를 재시작할까요?</h3>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">연결이 약 2~3초 끊어진 뒤 자동으로 다시 연결됩니다. 시작 장벽이 완료되기 전까지 신규 주문은 차단됩니다.</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button onClick={() => setShowRestartConfirm(false)} className="rounded-xl bg-slate-100 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-200">취소</button>
                <button onClick={requestServerRestart} className="rounded-xl bg-rose-600 py-2.5 text-xs font-extrabold text-white hover:bg-rose-700">재시작</button>
              </div>
            </div>
          </div>
        )}

        {/* Mobile Bottom Navigation Bar (Fixed/Sticky at bottom) */}
        <nav className="sticky bottom-0 left-0 right-0 w-full bg-white/95 backdrop-blur-md border-t border-slate-200 px-2 py-2 flex items-center justify-around shrink-0 z-50 shadow-md">
          <button
            onClick={() => setActiveTab('chart')}
            className={`flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'chart' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <BarChart2 className="w-5 h-5" />
            <span className="text-[9.5px]">차트 & 매매</span>
          </button>

          <button
            onClick={() => setActiveTab('radar')}
            className={`flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition cursor-pointer relative ${
              activeTab === 'radar' ? 'text-cyan-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Crosshair className={`w-5 h-5 ${activeTab === 'radar' ? 'text-cyan-600' : ''}`} />
            <span className="text-[9.5px]">조건 레이더</span>
            <span className="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse"></span>
          </button>

          <button
            onClick={() => setActiveTab('bot')}
            className={`flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'bot' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Sliders className="w-5 h-5" />
            <span className="text-[9.5px]">봇 설정</span>
          </button>

          <button
            onClick={() => setActiveTab('lab')}
            className={`flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'lab' ? 'text-violet-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Brain className={`w-5 h-5 ${activeTab === 'lab' ? 'text-violet-600' : ''}`} />
            <span className="text-[9.5px]">전략 실험실</span>
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            className={`flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition cursor-pointer relative ${
              activeTab === 'logs' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Terminal className="w-5 h-5" />
            <span className="text-[9.5px]">체결 로그</span>
            {logs.length > 0 && (
              <span className="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-blue-600"></span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('account')}
            className={`flex flex-col items-center gap-1 px-2 py-1 rounded-xl transition cursor-pointer ${
              activeTab === 'account' ? 'text-blue-600 font-bold' : 'text-slate-400 font-medium'
            }`}
          >
            <Wallet className="w-5 h-5" />
            <span className="text-[9.5px]">내 계좌</span>
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

        {/* Trade Confirmation Popup Modal */}
        {tradeConfirmModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150"
            onClick={() => setTradeConfirmModal(null)}
          >
            <div
              className="bg-white w-full max-w-sm rounded-3xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col animate-in zoom-in-95 duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className={`px-5 py-4 border-b flex items-center justify-between ${
                tradeConfirmModal.type === 'BUY' ? 'bg-emerald-50/80 border-emerald-100' : 'bg-rose-50/80 border-rose-100'
              }`}>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full text-white shadow-2xs ${
                      tradeConfirmModal.type === 'BUY' ? 'bg-emerald-600' : 'bg-rose-600'
                    }`}
                  >
                    {tradeConfirmModal.badgeLabel}
                  </span>
                  <span className={`text-xs font-black ${
                    tradeConfirmModal.type === 'BUY' ? 'text-emerald-950' : 'text-rose-950'
                  }`}>
                    {tradeConfirmModal.title}
                  </span>
                </div>
                <button
                  onClick={() => setTradeConfirmModal(null)}
                  className="w-7 h-7 rounded-full bg-slate-200/80 hover:bg-slate-300 text-slate-600 flex items-center justify-center font-bold text-xs transition cursor-pointer"
                >
                  ✕
                </button>
              </div>

              {/* Modal Content */}
              <div className="p-5 space-y-4 text-xs">
                <p className="text-slate-600 font-medium leading-relaxed">
                  {tradeConfirmModal.message}
                </p>

                {tradeConfirmModal.type === 'BUY' && tradeConfirmModal.manualBuyPercent && (
                  <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[11px] font-bold text-emerald-900">추가 매수 비중</span>
                      <span className="text-[10px] text-emerald-700">총자산 기준 · DCA 슬롯 미소비</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {([10, 20, 30] as const).map((percent) => {
                        const isSelected = tradeConfirmModal.manualBuyPercent === percent;
                        return (
                          <button
                            key={percent}
                            onClick={() => setTradeConfirmModal((modal) => {
                              if (!modal) return null;
                              const estimatedBudget = currentEquity * (percent / 100);
                              return {
                                ...modal,
                                manualBuyPercent: percent,
                                details: modal.details.map((item) => item.label === '예상 주문 금액'
                                  ? { ...item, value: `${formatPrice(estimatedBudget)} (총자산의 ${percent}%)` }
                                  : item)
                              };
                            })}
                            className={`rounded-xl border py-2 text-xs font-extrabold transition ${isSelected
                              ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                              : 'border-emerald-200 bg-white text-emerald-700 hover:border-emerald-400'}`}
                          >
                            {percent}%
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Details Card */}
                <div className="bg-slate-50 rounded-2xl p-3.5 border border-slate-100 space-y-2.5">
                  {tradeConfirmModal.details.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">{item.label}</span>
                      <span className={`font-bold mono text-xs ${item.highlight ? (tradeConfirmModal.type === 'BUY' ? 'text-emerald-700 font-extrabold' : 'text-rose-700 font-extrabold') : 'text-slate-800'}`}>
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => setTradeConfirmModal(null)}
                    className="py-3 px-4 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition cursor-pointer active:scale-98"
                  >
                    취소
                  </button>
                  <button
                    onClick={handleConfirmTrade}
                    className={`py-3 px-4 rounded-2xl text-white font-black text-xs shadow-md active:scale-98 transition cursor-pointer ${
                      tradeConfirmModal.type === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20' : 'bg-rose-600 hover:bg-rose-700 shadow-rose-600/20'
                    }`}
                  >
                    {tradeConfirmModal.actionLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
