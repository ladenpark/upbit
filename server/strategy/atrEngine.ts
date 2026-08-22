import {
  BotParams,
  TradeLog,
  PricePoint,
  BotLifecycleState,
  MarketDataState,
  ApiKeys,
  NextOrderItem,
  Signal,
  PositionSnapshot,
  SignalType
} from '../types/trading';
import { SecretManager } from '../security/secretManager';
import { MarketDataManager } from '../market/marketDataManager';
import { ATRStrategyCore } from './atrStrategyCore';
import { GlobalRiskGovernor } from '../risk/globalRiskGovernor';
import { PositionManager } from '../position/positionManager';
import { OrderManager } from '../orders/orderManager';
import { UpbitClient, UpbitCandle } from '../exchanges/upbit';
import { ApiGateway } from '../gateway/apiGateway';
import { roundDownToTick } from '../utils/priceUtils';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ResearchRecorder, ResearchDecision } from '../research/researchRecorder';
import { DCA2_RECOVERY_PREBUY_FRACTION, FIXED_DCA_DROP_PERCENTS, FIXED_DCA_UNIT_SCALES } from './strategyRuleConstants';

const RUN_INTENT_FILE = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'bot_run_intent.json');

export class ATREngine {
  // Sub-modules
  private secretManager: SecretManager;
  private marketManager: MarketDataManager;
  private strategyCore: ATRStrategyCore;
  private riskGovernor: GlobalRiskGovernor;
  public positionManager: PositionManager;
  public orderManager: OrderManager;
  private upbitClient: UpbitClient;
  private apiGateway: ApiGateway;
  /** User's last explicit run choice; restored only after the startup barrier succeeds. */
  private requestedRunAfterStartup = false;

  private loadRunIntent(): boolean {
    try {
      if (!fs.existsSync(RUN_INTENT_FILE)) return false;
      return JSON.parse(fs.readFileSync(RUN_INTENT_FILE, 'utf-8'))?.isBotActive === true;
    } catch (error) {
      console.error('[ATREngine] Failed to load bot run intent; starting paused:', error);
      return false;
    }
  }

  private persistRunIntent(isBotActive: boolean) {
    try {
      const dir = path.dirname(RUN_INTENT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${RUN_INTENT_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ isBotActive, updatedAt: Date.now() }), 'utf-8');
      fs.renameSync(tmp, RUN_INTENT_FILE);
    } catch (error) {
      // This is a convenience preference, never a reason to keep trading.
      console.error('[ATREngine] Failed to persist bot run intent:', error);
    }
  }

  private disableAutoRunIntent() {
    this.requestedRunAfterStartup = false;
    this.params.isBotActive = false;
    this.persistRunIntent(false);
  }
  private researchRecorder?: ResearchRecorder;

  // Bot Lifecycle State
  public botState: BotLifecycleState = 'STARTING';
  /** Set only by a local persistence failure; cleared exclusively by process restart. */
  private durabilityFailure = false;

  // Strategy Core Parameters
  public params: BotParams = {
    atrMultiplier: 3.0,
    orderRatio: 20,
    stopLossMultiplier: 2.0,
    isBotActive: false,
    exchange: 'UPBIT',
    symbol: 'KRW-ETH',
    maxExposurePercent: 85,
    dcaEnabled: true,
    maxSafetyOrders: 3,
    safetyOrderStepPercent: 2.0,
    safetyOrderVolumeScale: 1.2,
    trailingStopEnabled: true,
    trailingCallbackPercent: 0.8,
    pyramidingEnabled: true,
    maxPyramidingOrders: 2,
    pyramidingStepPercent: 1.5,
    partialLossCutEnabled: true,
    partialLossCutPercent: 40,
    partialLossCutThreshold: 4.5,
    trendAwareCutEnabled: true,
    trendDropSpeedThreshold: 1.8,
    trendDropWindowSeconds: 3,
    cooldownSecondsAfterCut: 60,
    autoPilotEnabled: true,
    breakoutEntryEnabled: true,
    dryRunMode: false,
    dailyMaxLossPercent: 5,
    experimentDca2RsiRecoveryEnabled: false,
    experimentDca2VolumeConfirmationEnabled: false,
    experimentPyramidRsiGuardEnabled: false,
    experimentPyramidVolumeConfirmationEnabled: false,
    experimentScalpTrendExpansionEnabled: false,
    experimentScalpReentryCooldownEnabled: false,
    experimentTrendTrailingArmingEnabled: false
  };

  // Higher Timeframe (15m) Trend State for Whipsaw Filtering
  private higherTfTrend: { trend: 'BULL' | 'SIDEWAYS' | 'BEAR'; htfSlope: number } = { trend: 'SIDEWAYS', htfSlope: 0 };
  private recent1mCloses: number[] = [];

  // Live Metrics
  public currentPrice = 2650000.0;
  public atrValue = 35000.0;
  public baselineValue = 2650000.0;
  public marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR' = 'SIDEWAYS';
  public rsiValue = 50.0;
  public volumeMultiplier = 1.0;
  public volumeMa = 0.0;
  public totalRealizedPnl = 0;
  public totalFeesPaid = 0;
  public totalTrades = 0;
  public winTrades = 0;

  public actualKrwBalance = 0;
  public realBalances: Record<string, number> = {};
  public initialBalance = 0;

  public priceHistory: PricePoint[] = [];
  public logs: TradeLog[] = [];

  private broadcastCallback?: (payload: any) => void;
  private balanceRefreshTimer: NodeJS.Timeout | null = null;
  private atrRefreshTimer: NodeJS.Timeout | null = null;
  private balanceSyncTimeout: NodeJS.Timeout | null = null;
  private startupReady = false;
  private startupPromise: Promise<void> | null = null;
  private startupFailureReason: string | null = null;
  private startupGeneration = 0;
  private accountContextGeneration = 0;
  private lastExchangeCoinQuantity = 0;
  private rebaseRequired = false;
  /**
   * Upbit balance snapshots can lag a confirmed order fill by a few seconds.
   * Keep a short-lived local KRW shadow so a pre-fill snapshot cannot make
   * the risk governor believe both the old KRW and newly bought coin exist.
   */
  private balanceShadowUntil = 0;
  private balanceShadowByOrder = new Map<string, { funds: number; fee: number }>();
  /** FIFO cost lots used for the live daily circuit breaker (fees included). */
  private dailyCostLots: { volume: number; price: number; fee: number }[] = [];

  private captureAsyncContext() {
    return {
      startupGeneration: this.startupGeneration,
      symbol: this.params.symbol,
      accountContextGeneration: this.accountContextGeneration
    };
  }

  private isAsyncContextCurrent(context: ReturnType<ATREngine['captureAsyncContext']>) {
    return context.startupGeneration === this.startupGeneration &&
      context.symbol === this.params.symbol &&
      context.accountContextGeneration === this.accountContextGeneration;
  }

  private accountFingerprint(keys: ApiKeys): string | null {
    if (!keys.upbitAccessKey || !keys.upbitSecretKey) return null;
    return crypto.createHash('sha256').update(`${keys.upbitAccessKey}:${keys.upbitSecretKey}`).digest('hex');
  }

  private assertOrBindAccountFingerprint(keys: ApiKeys) {
    const fingerprint = this.accountFingerprint(keys);
    if (!fingerprint) return;
    const position = this.positionManager.getSnapshot();
    const persisted = position.accountFingerprint;
    if (persisted && persisted !== fingerprint) {
      throw new Error('저장된 포지션/주문 원장이 현재 API 계좌와 다릅니다. 수동 복구가 필요합니다.');
    }
    if (!persisted) {
      // A truly fresh FLAT account has no position file by design. Do not
      // create one merely to store an account fingerprint.
      if (!this.positionManager.hasPersistedState()) return;
      // One-time migration for legacy ledgers predating account fingerprints.
      // Subsequent restarts are strictly compared; callers with a legacy
      // position should verify their configured account before this upgrade.
      this.positionManager.setAccountFingerprint(fingerprint);
    }
  }

  constructor(broadcastCallback?: (payload: any) => void, options: { backtest?: boolean } = {}) {
    this.broadcastCallback = broadcastCallback;
    this.secretManager = SecretManager.getInstance();
    this.upbitClient = new UpbitClient();
    this.apiGateway = ApiGateway.getInstance();
    this.requestedRunAfterStartup = !options.backtest && this.loadRunIntent();
    this.params.isBotActive = this.requestedRunAfterStartup;
    if (!options.backtest && process.env.NODE_ENV !== 'test') {
      this.researchRecorder = new ResearchRecorder();
    }

    this.strategyCore = new ATRStrategyCore();
    this.riskGovernor = new GlobalRiskGovernor(this.params);
    this.riskGovernor.setPersistenceFailureHandler((error) => {
      this.durabilityFailure = true;
      this.disableAutoRunIntent();
      this.botState = 'HALTED';
      this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: `🚨 [위험 원장 안전 정지] ${error instanceof Error ? error.message : String(error)}` });
      this.notifyClients();
    });
    this.positionManager = new PositionManager(this.params);
    const restoredPosition = this.positionManager.getSnapshot();
    if (
      this.positionManager.hasPersistedState() &&
      restoredPosition.amount > 1e-8 &&
      restoredPosition.symbol !== this.params.symbol
    ) {
      // A persisted open position owns exactly one asset. On restart its
      // symbol is authoritative; using the default/UI symbol here could
      // reconcile BTC state with ETH balances before any user action.
      console.warn(`[ATREngine] Bootstrapping active symbol from persisted position: ${this.params.symbol} → ${restoredPosition.symbol}`);
      this.params = { ...this.params, symbol: restoredPosition.symbol };
      this.riskGovernor.setParams(this.params);
      this.positionManager.setParams(this.params);
    }
    this.orderManager = new OrderManager(
      this.riskGovernor,
      (record, incrementalFilledVolume) => {
        console.log(`[ATREngine] 🔔 Async Order Fill update received for ${record.clientOrderId} (${record.status}): Incremental Fill = ${incrementalFilledVolume}`);
        if (record.signalType && incrementalFilledVolume > 0) {
          this.handleOrderFilled(record.signalType, record, this.currentPrice, incrementalFilledVolume);
        }
      }
    );
    // Every background order watcher result is valid only for this exact
    // symbol/account/startup context. invalidateStartupBarrier() replaces
    // this guard before any previous async watcher response can commit.
    const initialWatcherContext = this.captureAsyncContext();
    this.orderManager.setWatcherContextGuard(() => this.isAsyncContextCurrent(initialWatcherContext));
    this.orderManager.setStrategyFillDurabilityLookup(
      (clientOrderId) => this.positionManager.getDurableFillWatermark(clientOrderId),
      (clientOrderId, funds) => this.positionManager.restoreDurableFillWatermarkFunds(clientOrderId, funds)
    );
    this.orderManager.setOnPartialOrderCancelled((record) => {
      if (!record.signalType || !['DCA_BUY', 'PARTIAL_LOSS_CUT', 'TRAILING_STOP_EXIT'].includes(record.signalType)) return;
      this.positionManager.finalizeCancelledPartialStage(record.clientOrderId, record.signalType, record.filledVolume);
      this.notifyClients();
    });
    this.orderManager.setDurabilityFailureHandler(() => {
      this.durabilityFailure = true;
      this.botState = 'HALTED';
      this.disableAutoRunIntent();
      this.addLog({
        type: 'SYSTEM',
        price: this.currentPrice,
        reason: '🚨 [저장 안전 정지] 주문 또는 체결 원장을 디스크에 저장하지 못했습니다 — 재시작 후 거래소 동기화가 필요합니다.'
      });
      this.notifyClients();
    });

    // Restore persisted trade logs from disk so UI doesn't reset on restart
    this.logs = PositionManager.loadTradeLogs().slice(0, 300);

    // Compute exact historical realized PnL and trade counts from order history (FIFO matching)
    const allFilledOrders = this.orderManager.getAllOrders().filter((o) => o.status === 'FILLED' || o.filledVolume > 0);
    let historicalPnl = 0;
    let totalFees = 0;
    let closedTradesCount = 0;
    let winCount = 0;
    const buyQueue: { vol: number; price: number; fee: number }[] = [];

    allFilledOrders.forEach((o) => {
      totalFees += (o.fee || 0);
      if (o.side === 'BUY') {
        buyQueue.push({ vol: o.filledVolume, price: o.avgFillPrice, fee: o.fee || 0 });
      } else if (o.side === 'SELL' && o.avgFillPrice > 0) {
        let sellVol = o.filledVolume;
        const sellPrice = o.avgFillPrice;
        const sellFee = o.fee || 0;
        let tradeCost = 0;
        const tradeRevenue = sellVol * sellPrice;

        while (sellVol > 0 && buyQueue.length > 0) {
          const b = buyQueue[0];
          if (b.vol <= sellVol) {
            tradeCost += b.vol * b.price + b.fee;
            sellVol -= b.vol;
            buyQueue.shift();
          } else {
            const partialCost = sellVol * b.price + (b.fee * (sellVol / b.vol));
            tradeCost += partialCost;
            b.fee -= (b.fee * (sellVol / b.vol));
            b.vol -= sellVol;
            sellVol = 0;
          }
        }
        // Safety: If buy queue is exhausted, fallback to breakeven cost to prevent phantom profit
        if (sellVol > 0) {
          tradeCost += sellVol * sellPrice;
        }

        const pnl = tradeRevenue - tradeCost - sellFee;
        historicalPnl += pnl;
        closedTradesCount += 1;
        if (pnl > 0) winCount += 1;
      }
    });

    this.totalRealizedPnl = Math.round(historicalPnl);
    this.totalFeesPaid = Math.round(totalFees);
    this.totalTrades = closedTradesCount;
    this.winTrades = winCount;
    // `buyQueue` now contains only the still-open FIFO cost basis. Continue
    // from that exact basis for live fills instead of switching the circuit
    // breaker back to a gross entry-price approximation after restart.
    this.dailyCostLots = buyQueue.map((lot) => ({ volume: lot.vol, price: lot.price, fee: lot.fee }));

    // Initialize Market Data Manager with tick dispatcher
    this.marketManager = new MarketDataManager(
      this.params.exchange,
      this.params.symbol,
      (price, ts) => this.handleMarketTick(price, ts),
      (marketState) => {
        console.log(`[ATREngine] Market Feed state changed ➡️ ${marketState}`);
        this.notifyClients();
      },
      !options.backtest
    );

    if (options.backtest) {
      // Backtests provide their own deterministic market/account setup.
      this.startupReady = true;
      this.botState = 'PAUSED';
    } else {
      this.startStartupBarrier();
    }
  }

  /**
   * No strategy signal is allowed until the market indicators, pending orders
   * and exchange balance all describe the same point-in-time startup state.
   */
  private startStartupBarrier(): Promise<void> {
    if (this.startupReady) return Promise.resolve();
    if (this.startupPromise) return this.startupPromise;

    const generation = this.startupGeneration;
    this.botState = 'STARTING';
    this.startupFailureReason = null;
    this.notifyClients();
    this.startupPromise = (async () => {
      try {
        const orderLoadFailure = this.orderManager.getPersistenceLoadFailure();
        const positionLoadFailure = this.positionManager.getPersistenceLoadFailure();
        const riskLoadFailure = this.riskGovernor.getPersistenceFailure();
        if (orderLoadFailure || positionLoadFailure || riskLoadFailure) {
          throw new Error(`로컬 거래 상태를 안전하게 읽지 못했습니다: ${(orderLoadFailure || positionLoadFailure || riskLoadFailure)!.message}`);
        }
        const indicatorsReady = await this.refreshAtrFromExchange();
        if (!indicatorsReady) throw new Error('완성된 1분/15분 캔들로 지표를 준비하지 못했습니다.');

        const reconciled = await this.reconcileOnStartup();
        if (!reconciled) throw new Error('거래소 주문 또는 잔고 동기화에 실패했습니다.');
        if (this.rebaseRequired) throw new Error('거래소 잔고가 로컬 체결 원장과 다릅니다. 포지션 보정이 필요합니다.');

        if (generation !== this.startupGeneration) return;
        // A process restart must never silently bypass a same-day loss halt.
        // Preserve the safe PAUSED state and clear the saved run intent instead.
        const dailyCircuitActive = this.riskGovernor.getDailyLossStatus().circuitBroken;
        if (this.params.isBotActive && dailyCircuitActive) {
          this.disableAutoRunIntent();
          this.addLog({
            type: 'SYSTEM',
            price: this.currentPrice,
            reason: '⚠️ [자동 가동 복원 차단] 당일 손실 서킷 브레이커가 활성화되어 있습니다 — 보호 매도만 허용'
          });
        }
        this.startupReady = true;
        // A daily-loss halt is intentionally a sell-only HALTED state after
        // restart. PAUSED would reject ABSOLUTE_STOP_EXIT and leave an open
        // position without automatic protection.
        this.botState = dailyCircuitActive ? 'HALTED' : (this.params.isBotActive ? 'RUNNING' : 'PAUSED');
        this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: '[시작 장벽 해제] 완성 캔들·미체결 주문·실계좌 동기화 완료 — 전략 신호 허용' });
        this.startBackgroundRefreshes();
      } catch (e: any) {
        if (generation !== this.startupGeneration) return;
        this.startupReady = false;
        this.startupFailureReason = e.message || 'startup synchronization failed';
        // Fail closed: a bot cannot become RUNNING from incomplete startup data.
        this.disableAutoRunIntent();
        this.botState = this.durabilityFailure ? 'HALTED' : 'PAUSED';
        this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: `⚠️ [시작 장벽 유지] ${this.startupFailureReason} — 자동 주문 차단` });
      } finally {
        if (generation === this.startupGeneration) {
          this.startupPromise = null;
          this.notifyClients();
        }
      }
    })();
    return this.startupPromise;
  }

  /** Discards stale market/account assumptions before a symbol or account switch. */
  private invalidateStartupBarrier() {
    this.startupGeneration += 1;
    this.startupReady = false;
    this.startupPromise = null;
    this.startupFailureReason = null;
    this.botState = 'STARTING';
    this.recent1mCloses = [];
    this.priceHistory = [];
    this.higherTfTrend = { trend: 'SIDEWAYS', htfSlope: 0 };

    const watcherContext = this.captureAsyncContext();
    this.orderManager.setWatcherContextGuard(() => this.isAsyncContextCurrent(watcherContext));
  }

  private startBackgroundRefreshes() {
    if (!this.balanceRefreshTimer) {
      // Start periodic background balance sync (every 10s)
      this.balanceRefreshTimer = setInterval(() => {
        this.fetchRealAccountBalance();
      }, 10000);
    }
    if (!this.atrRefreshTimer) {
      // Start periodic background ATR recalculation (every 30s)
      this.atrRefreshTimer = setInterval(() => {
        this.refreshAtrFromExchange();
      }, 30000);
    }
  }

  public async reconcileOnStartup(): Promise<boolean> {
    console.log('[ATREngine] 🔄 Starting complete startup state reconciliation...');
    const context = this.captureAsyncContext();
    const symbol = context.symbol;
    try {
      const orderLoadFailure = this.orderManager.getPersistenceLoadFailure();
      const positionLoadFailure = this.positionManager.getPersistenceLoadFailure();
      const riskLoadFailure = this.riskGovernor.getPersistenceFailure();
      if (orderLoadFailure || positionLoadFailure || riskLoadFailure) {
        throw new Error(`Local trading state could not be loaded safely: ${(orderLoadFailure || positionLoadFailure || riskLoadFailure)!.message}`);
      }
      const keys = this.secretManager.getKeys();
      if (keys.upbitAccessKey && keys.upbitSecretKey) {
        // 1. Reconcile Pending Orders from disk against Upbit Exchange
        await this.orderManager.reconcilePendingOrdersOnStartup(
          keys,
          'UPBIT',
          symbol,
          () => this.isAsyncContextCurrent(context)
        );
        if (!this.isAsyncContextCurrent(context)) return false;
        const unresolvedOrders = this.orderManager.getPendingOrders().filter((order) =>
          order.status === 'UNKNOWN_PENDING_RECONCILIATION' ||
          order.status === 'ORDER_SUBMITTING' ||
          order.status === 'ORDER_SUBMITTED'
        );
        if (unresolvedOrders.length > 0) {
          console.warn(`[ATREngine] Startup blocked: ${unresolvedOrders.length} order(s) remain unconfirmed.`);
          return false;
        }

        // 2. Sync Real Account Balances
        const balanceSynced = await this.fetchRealAccountBalance();
        if (!this.isAsyncContextCurrent(context) || !balanceSynced) return false;
        if (!this.positionManager.hasPersistedState() && this.lastExchangeCoinQuantity > 1e-8) {
          throw new Error('거래소 보유 포지션은 있으나 로컬 position_state.json이 없습니다. 봇을 정지한 채 포지션 보정을 실행해야 합니다.');
        }
        this.assertOrBindAccountFingerprint(keys);

        // 3. Query Open Orders on Exchange
        const openRes = await this.upbitClient.getOpenOrders(keys.upbitAccessKey, keys.upbitSecretKey, symbol);
        if (!this.isAsyncContextCurrent(context)) return false;
        if (!openRes.success || !Array.isArray(openRes.orders)) return false;
        const knownPendingOrders = this.orderManager.getPendingOrders();
        const knownExchangeOrderIds = new Set(knownPendingOrders.map((order) => order.exchangeOrderId).filter(Boolean));
        const knownClientOrderIds = new Set(knownPendingOrders.map((order) => order.clientOrderId));
        const unknownExchangeOrders = openRes.orders.filter((order: any) =>
          !knownExchangeOrderIds.has(order.uuid) &&
          !knownClientOrderIds.has(order.identifier)
        );
        if (unknownExchangeOrders.length > 0) {
          console.error(`[ATREngine] Startup blocked: ${unknownExchangeOrders.length} exchange open order(s) are absent from the local ledger.`);
          return false;
        }
        console.log(`[ATREngine] 📋 Exchange active open orders: ${openRes.orders.length}`);

        // 4. Position reconciled automatically via fetchRealAccountBalance
        this.addLog({
          type: 'SYSTEM',
          price: this.currentPrice,
          reason: `[시스템 복구 완료] 거래소 계좌 및 공식 평단가 동기화 완료`
        });
        return balanceSynced;
      }
    } catch (e: any) {
      console.error('[ATREngine] Startup reconciliation error:', e.message);
    }
    return false;
  }

  public setBroadcastCallback(cb: (payload: any) => void) {
    this.broadcastCallback = cb;
  }

  /** Seeds the chart with completed exchange 1-minute candles and smooth historical rolling bands. */
  private seedPriceHistoryFromCompletedCandles(candles: UpbitCandle[], baseline: number, atr: number) {
    const minAtrFloor = Math.max(5000, Math.round((candles[candles.length - 1]?.trade_price || 3000000) * 0.0025));
    const effectiveAtr = Math.max(atr, minAtrFloor);
    const effectiveMultiplier = this.params.autoPilotEnabled
      ? (this.marketRegime === 'BULL' ? 1.8 : this.marketRegime === 'BEAR' ? 3.5 : 2.4)
      : this.params.atrMultiplier;
    const persistedStop = this.positionManager.getSnapshot().initialStopPrice;
    const count = candles.length;
    const startIndex = Math.max(0, count - 40);

    this.priceHistory = candles.slice(startIndex).map((candle, sliceIdx) => {
      const originalIdx = startIndex + sliceIdx;
      // Rolling baseline over up to 20 lookback bars
      const baselineSlice = candles.slice(Math.max(0, originalIdx - 19), originalIdx + 1);
      const barBaseline = baselineSlice.length > 0
        ? Math.round(baselineSlice.reduce((sum, c) => sum + c.trade_price, 0) / baselineSlice.length)
        : baseline;

      const date = new Date(candle.timestamp);
      const timeLabel = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      return {
        time: candle.timestamp,
        timeLabel,
        price: candle.trade_price,
        baseline: barBaseline,
        upperBand: barBaseline + (effectiveAtr * effectiveMultiplier),
        lowerBand: barBaseline - (effectiveAtr * effectiveMultiplier),
        stopLoss: persistedStop || barBaseline - (effectiveAtr * (effectiveMultiplier + this.params.stopLossMultiplier))
      };
    });
  }

  /**
   * Evaluates the current state against baseline and one-filter-at-a-time
   * variants. This is intentionally signal-only: it never creates a shadow
   * position, order, reservation, or exchange request.
   */
  private captureShadowDecisions(
    timestamp: number,
    price: number,
    position: PositionSnapshot,
    dropSpeed: number,
    historyPrices: number[],
    activeSignals: Signal[],
    currentExposurePercent: number
  ) {
    if (!this.researchRecorder) return;

    const summarize = (signals: Signal[]): ResearchDecision => {
      const top = [...signals].sort((a, b) => a.priority - b.priority)[0];
      return top ? { type: top.type, dcaExecution: top.dcaExecution } : { type: null };
    };
    const evaluate = (params: BotParams) => summarize(this.strategyCore.generateSignals(
      price, this.baselineValue, this.atrValue, params, position, dropSpeed,
      historyPrices, this.higherTfTrend, this.rsiValue, this.volumeMultiplier, this.volumeMa,
      historyPrices, { currentExposurePercent }
    ));
    const baselineParams: BotParams = {
      ...this.params,
      experimentDca2RsiRecoveryEnabled: false,
      experimentDca2VolumeConfirmationEnabled: false,
      experimentPyramidRsiGuardEnabled: false,
      experimentPyramidVolumeConfirmationEnabled: false,
      experimentScalpTrendExpansionEnabled: false,
      experimentScalpReentryCooldownEnabled: false,
      experimentTrendTrailingArmingEnabled: false
    };
    const decisions: Record<string, ResearchDecision> = {
      active: summarize(activeSignals),
      baseline: evaluate(baselineParams),
      dca2Rsi: evaluate({ ...baselineParams, experimentDca2RsiRecoveryEnabled: true }),
      dca2Volume: evaluate({ ...baselineParams, experimentDca2VolumeConfirmationEnabled: true }),
      pyramidRsi: evaluate({ ...baselineParams, experimentPyramidRsiGuardEnabled: true }),
      pyramidVolume: evaluate({ ...baselineParams, experimentPyramidVolumeConfirmationEnabled: true }),
      scalpExpansion: evaluate({ ...baselineParams, experimentScalpTrendExpansionEnabled: true }),
      scalpCooldown: evaluate({ ...baselineParams, experimentScalpReentryCooldownEnabled: true }),
      trendTrailingArm: evaluate({ ...baselineParams, experimentTrendTrailingArmingEnabled: true })
    };
    const uniqueDecisions = new Set(Object.values(decisions).map((decision) => `${decision.type || 'NONE'}:${decision.dcaExecution || ''}`));
    if (uniqueDecisions.size <= 1) return;

    this.researchRecorder.recordShadowDifference(timestamp, this.params.symbol, price, {
      rsi: this.rsiValue,
      volumeMultiplier: this.volumeMultiplier,
      baseline: this.baselineValue,
      atr: this.atrValue,
      marketRegime: this.marketRegime,
      dropSpeed
    }, decisions);
  }

  /**
   * Main Market Tick Dispatcher & Deterministic Decision Loop
   */
  public async handleMarketTick(price: number, timestamp: number) {
    this.currentPrice = price;
    this.researchRecorder?.recordTick(this.params.symbol, price, timestamp);

    // A durability halt may still update the dashboard price, but it must not
    // arm trailing/re-entry state or mutate the PositionManager before a
    // restart and authoritative reconciliation.
    if (this.durabilityFailure || this.botState === 'HALTED' && !this.riskGovernor.getDailyLossStatus().circuitBroken) {
      this.notifyClients();
      return;
    }

    // A balance/ledger discrepancy needs an explicit, paused rebase.  Do not
    // let a later tick arm trailing/re-entry state or create another order
    // while the dashboard is asking the user to reconcile the position.
    if (this.rebaseRequired) {
      this.notifyClients();
      return;
    }

    // Ticks are retained by MarketDataManager while startup runs, but no
    // indicator evaluation, protective-state mutation, signal or order can
    // happen until the authoritative startup barrier has completed.
    if (!this.startupReady) {
      this.notifyClients();
      return;
    }

    // Candle closes drive regime/slope/scalp decisions; raw ticks remain for
    // DCA rebound and short-term microstructure checks.
    const tickHistoryPrices = [...this.priceHistory.map((p) => p.price), price];
    const historyPrices = this.recent1mCloses.length >= 15
      ? [...this.recent1mCloses.slice(-19), price]
      : tickHistoryPrices;

    // Real-time 1m RSI(14) calculation: base 1m candles + latest tick price
    const rsiCloses = this.recent1mCloses.length >= 14
      ? [...this.recent1mCloses.slice(-14), price]
      : historyPrices;

    if (rsiCloses.length >= 15) {
      const slice = rsiCloses.slice(-15);
      let gains = 0;
      let losses = 0;
      for (let i = 1; i < slice.length; i++) {
        const diff = slice[i] - slice[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
      }
      const avgGain = gains / 14;
      const avgLoss = losses / 14;
      if (avgGain === 0 && avgLoss === 0) this.rsiValue = 50.0;
      else if (avgLoss === 0) this.rsiValue = 100.0;
      else if (avgGain === 0) this.rsiValue = 0.0;
      else {
        const rs = avgGain / avgLoss;
        this.rsiValue = Number((100 - (100 / (1 + rs))).toFixed(1));
      }
    }

    // Evaluate dynamic auto-pilot indicators FIRST so bands are consistent everywhere
    const adaptive = this.strategyCore.evaluateAdaptiveParams(
      price,
      this.baselineValue,
      this.atrValue,
      this.params,
      historyPrices,
      this.higherTfTrend,
      this.rsiValue,
      this.volumeMultiplier,
      this.volumeMa
    );

    if (adaptive.marketRegime !== this.marketRegime) {
      this.marketRegime = adaptive.marketRegime;
    }

    // Update ATR baseline & bands — use dynamic multiplier when AutoPilot is on
    const minAtrFloor = Math.max(5000, Math.round(price * 0.0025));
    const effectiveAtr = Math.max(this.atrValue, minAtrFloor);
    const effectiveMultiplier = this.params.autoPilotEnabled ? adaptive.dynamicAtr : this.params.atrMultiplier;
    const lowerBand = this.baselineValue - (effectiveAtr * effectiveMultiplier);
    const upperBand = this.baselineValue + (effectiveAtr * effectiveMultiplier);
    const staticStopPrice = this.positionManager.getSnapshot().initialStopPrice || (lowerBand - (effectiveAtr * this.params.stopLossMultiplier));

    // Update trailing state if price touches upper band (now using dynamic band)
    const isTrendExpansion = adaptive.marketRegime === 'SIDEWAYS' && adaptive.volumeMultiplier >= 1.5 && adaptive.slope >= 0.05;
    const trailingArmProfitPercent = this.params.experimentTrendTrailingArmingEnabled && isTrendExpansion ? 0.8 : 1.0;
    this.positionManager.updateTrailingState(price, upperBand, trailingArmProfitPercent);

    // Calculate drop speed over explicit 5-second window
    const dropSpeed = this.marketManager.calculateDropSpeed(this.params.trendDropWindowSeconds || 5);

    // ── enableReentry trigger: DEFENSIVE/EMERGENCY_EXIT → REENTRY_ALLOWED ──
    const positionForReentry = this.positionManager.getSnapshot();
    if (
      (
        positionForReentry.state === 'DEFENSIVE' ||
        positionForReentry.state === 'DEFENSIVE_1' ||
        positionForReentry.state === 'DEFENSIVE_2' ||
        positionForReentry.state === 'EMERGENCY_EXIT'
      ) &&
      (positionForReentry.recycleCycleCount || 0) < 2 &&
      !this.positionManager.isUnderCooldown() &&
      dropSpeed >= -0.3 &&
      price > lowerBand
    ) {
      this.positionManager.enableReentry();
      this.addLog({
        type: 'SYSTEM',
        price,
        reason: `✅ [재진입 허용] 급락 진정 확인 (dropSpeed=${dropSpeed.toFixed(2)}%) — 바닥 재매수 가능 상태로 전환`
      });
    }

    // 1. Generate Strategy Signals (evaluateAdaptiveParams is called again inside with identical inputs — same result)
    let position = this.positionManager.getSnapshot();
    const exposureLimits = this.riskGovernor.calculateExposureLimits(
      this.actualKrwBalance,
      position.amount,
      price,
      0
    );
    const currentExposurePercent = exposureLimits.totalCapitalKrw > 0
      ? (exposureLimits.currentExposureKrw / exposureLimits.totalCapitalKrw) * 100
      : 0;
    const candidateSignals = this.strategyCore.generateSignals(
      price,
      this.baselineValue,
      this.atrValue,
      this.params,
      position,
      dropSpeed,
      historyPrices,
      this.higherTfTrend,
      this.rsiValue,
      this.volumeMultiplier,
      this.volumeMa,
      tickHistoryPrices,
      { currentExposurePercent }
    );
    this.captureShadowDecisions(timestamp, price, position, dropSpeed, historyPrices, candidateSignals, currentExposurePercent);

    if (candidateSignals.length > 0) {
      console.log(`[ATREngine] 🎯 Signals Generated (${candidateSignals.length}):`, candidateSignals.map((s) => `[${s.type}] ${s.reason}`));
    }

    // 2. Pass highest-priority signal through Global Risk Governor
    if (candidateSignals.length > 0) {
      // Sort by priority ascending (1 = Absolute Stop Loss, 2 = Emergency Cut, etc.)
      candidateSignals.sort((a, b) => a.priority - b.priority);
      const topSignal = candidateSignals[0];

      // A full protective exit owns the symbol exclusively. First cancel and
      // reconcile any BUY or lower-priority SELL, then refresh the account so
      // the market exit is sized from currently unlocked exchange quantity.
      if (!this.params.dryRunMode && (topSignal.type === 'ABSOLUTE_STOP_EXIT' || topSignal.type === 'EMERGENCY_FULL_EXIT')) {
        try {
          await this.coordinateProtectiveFullExit();
          position = this.positionManager.getSnapshot();
        } catch (e: any) {
          this.durabilityFailure = true;
          this.disableAutoRunIntent();
          this.botState = 'HALTED';
          this.addLog({ type: 'SYSTEM', price, reason: `🚨 [보호청산 안전 정지] ${e.message}` });
          this.notifyClients();
          return;
        }
      }

      const riskResult = this.riskGovernor.evaluateSignal(
        topSignal,
        this.botState,
        this.marketManager.marketState,
        this.actualKrwBalance,
        position,
        price,
        this.orderManager.getPendingOrders(),
        0
      );

      if (riskResult.approved && riskResult.orderRequest) {
        const clientOrderId = riskResult.orderRequest.clientOrderId;
        if (!this.params.dryRunMode && topSignal.type === 'REENTRY_BUY' && !this.positionManager.markReentryPending()) {
          console.warn('[ATREngine] Re-entry signal discarded because its permission was already consumed.');
          return;
        }
        console.log(`[ATREngine] 🎯 Signal APPROVED by Global Risk Governor: ${topSignal.type} (${topSignal.reason})`);

        this.addLog({
          type: 'SYSTEM',
          price,
          reason: `[위험관리 승인] ${topSignal.reason} ➡️ 주문 발송 중... (예산: ₩${Math.round(riskResult.calculatedBudgetKrw || 0).toLocaleString()})`
        });

        // DRY-RUN MODE: record a hypothetical decision only. A simulated
        // fill must never mutate the production position/order/risk ledgers.
        if (this.params.dryRunMode) {
          const dryVolume = riskResult.orderRequest.side === 'BUY'
            ? (riskResult.orderRequest.requestedAmountKrw || 0) / price
            : (riskResult.orderRequest.requestedVolume || 0);
          const dryRecord = {
            clientOrderId,
            signalType: topSignal.type,
            status: 'FILLED',
            filledVolume: dryVolume,
            avgFillPrice: price,
            requestedBudgetOrVolume: riskResult.orderRequest.requestedAmountKrw || riskResult.orderRequest.requestedVolume || 0,
            reason: riskResult.orderRequest.reason,
            side: riskResult.orderRequest.side
          };
          console.log(`[ATREngine] 🏷️ DRY-RUN: Simulated ${riskResult.orderRequest.side} ${dryVolume.toFixed(6)} @ ₩${Math.round(price).toLocaleString()}`);
          this.addLog({
            type: 'SYSTEM', price,
            reason: `[DRY-RUN 가상 체결] ${topSignal.type} ${dryRecord.side} ${dryVolume.toFixed(6)} @ ₩${Math.round(price).toLocaleString()} — 실계좌 원장 미변경`
          });
        } else {
          // 3. Execute Order via OrderManager (OrderManager autonomously manages reserve/commit/release lifecycle)
          try {
            await this.orderManager.submitOrder(
              riskResult.orderRequest,
              this.secretManager.getKeys(),
              this.params.exchange,
              (record) => {
                this.handleOrderFilled(topSignal.type, record, price);
              },
              (error) => {
                if (topSignal.type === 'REENTRY_BUY') this.positionManager.restoreReentryAllowed();
                this.addLog({
                  type: 'SYSTEM',
                  price,
                  reason: `❌ [주문 실패] ${error}`
                });
              }
            );
          } catch (err: any) {
            this.addLog({
              type: 'SYSTEM',
              price,
              reason: `❌ [주문 제출 예외] ${err.message}`
            });
          }
        }
      } else {
        // Log rejection reason if risk check fails
        if (riskResult.rejectionReason && !riskResult.rejectionReason.includes('pending execution')) {
          console.warn(`[ATREngine] ⚠️ Signal Rejected: ${topSignal.type} - ${riskResult.rejectionReason}`);
        }
      }
    }

    // Update Live Rolling Price History Chart Series (50 streaming points)
    const lastPoint = this.priceHistory.length > 0 ? this.priceHistory[this.priceHistory.length - 1] : null;
    const shouldPushNewPoint = !lastPoint || (timestamp - lastPoint.time >= 2000) || (Math.abs(price - lastPoint.price) >= 1000);
    const d = new Date(timestamp);
    const timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

    if (shouldPushNewPoint) {
      this.priceHistory.push({
        time: timestamp,
        timeLabel,
        price,
        baseline: this.baselineValue,
        upperBand,
        lowerBand,
        stopLoss: staticStopPrice
      });
      if (this.priceHistory.length > 50) {
        this.priceHistory.shift();
      }
    } else if (lastPoint) {
      lastPoint.price = price;
      lastPoint.baseline = this.baselineValue;
      lastPoint.upperBand = upperBand;
      lastPoint.lowerBand = lowerBand;
      lastPoint.stopLoss = staticStopPrice;
      lastPoint.time = timestamp;
      lastPoint.timeLabel = timeLabel;
    }

    this.notifyClients();
  }

  /**
   * Handles a confirmed fill using ONLY exchange-verified data from the OrderRecord.
   * record.filledVolume = actual executed_volume from Upbit
   * record.avgFillPrice = actual weighted avg fill price from Upbit trades
   * overrideVolume = incremental volume when notified asynchronously by background watcher
   * Falls back to (requestedBudgetOrVolume / tickPrice) ONLY if exchange data is missing.
   */
  private handleOrderFilled(signalType: string, record: any, tickPrice: number, overrideVolume?: number) {
    const fillEventId = record.strategyFillEventId as string | undefined;
    if (!fillEventId) {
      this.applyOrderFillToPosition(signalType, record, tickPrice, overrideVolume);
      this.applyConfirmedBalanceShadow(record, tickPrice, overrideVolume);
      return;
    }

    // Persist the position mutation and its fill-event identity together. If
    // the order watermark write fails afterwards, restart recovery advances
    // only the watermark and never applies this position transition twice.
    if (!this.positionManager.beginDurableFillEvent(
      fillEventId,
      record.clientOrderId,
      record.strategyFillCumulativeVolume,
      record.strategyFillCumulativeFee,
      record.strategyFillKind === 'INITIAL',
      record.strategyFillCumulativeFunds
    )) return;
    try {
      this.applyOrderFillToPosition(signalType, record, tickPrice, overrideVolume);
    } finally {
      if (!this.positionManager.completeDurableFillEvent(fillEventId)) {
        this.durabilityFailure = true;
        this.botState = 'HALTED';
        this.disableAutoRunIntent();
        this.addLog({
          type: 'SYSTEM',
          price: tickPrice,
          reason: '🚨 [저장 안전 정지] 포지션 체결 상태를 디스크에 영속화하지 못했습니다 — 재시작 후 거래소 동기화가 필요합니다.'
        });
        throw new Error('Durable position fill write failed; bot halted for safe recovery.');
      }
    }
    this.applyConfirmedBalanceShadow(record, tickPrice, overrideVolume);
  }

  /** Apply only the newly confirmed cumulative fill cost/proceeds to local KRW. */
  private applyConfirmedBalanceShadow(record: any, tickPrice: number, overrideVolume?: number) {
    if (this.params.dryRunMode || !record?.clientOrderId || (record.side !== 'BUY' && record.side !== 'SELL')) return;

    const fillPrice = Number(record.avgFillPrice) > 0 ? Number(record.avgFillPrice) : tickPrice;
    const volume = overrideVolume && overrideVolume > 0
      ? overrideVolume
      : Math.max(0, Number(record.filledVolume) || 0);
    const cumulativeFunds = Number(record.strategyFillCumulativeFunds);
    const cumulativeFee = Number(record.strategyFillCumulativeFee);
    const previous = this.balanceShadowByOrder.get(record.clientOrderId) || { funds: 0, fee: 0 };
    const totalFunds = Number.isFinite(cumulativeFunds) && cumulativeFunds >= 0
      ? cumulativeFunds
      : previous.funds + (volume * fillPrice);
    const totalFee = Number.isFinite(cumulativeFee) && cumulativeFee >= 0
      ? cumulativeFee
      : previous.fee + Math.max(0, Number(record.fee) || 0);
    const incrementalFunds = Math.max(0, totalFunds - previous.funds);
    const incrementalFee = Math.max(0, totalFee - previous.fee);
    if (incrementalFunds <= 0 && incrementalFee <= 0) return;

    this.balanceShadowByOrder.set(record.clientOrderId, { funds: totalFunds, fee: totalFee });
    const krwDelta = record.side === 'BUY'
      ? -(incrementalFunds + incrementalFee)
      : (incrementalFunds - incrementalFee);
    this.actualKrwBalance = Math.max(0, this.actualKrwBalance + krwDelta);
    this.realBalances = { ...this.realBalances, KRW: this.actualKrwBalance };
    this.balanceShadowUntil = Date.now() + 15_000;
  }

  private applyOrderFillToPosition(signalType: string, record: any, tickPrice: number, overrideVolume?: number) {
    const position = this.positionManager.getSnapshot();
    // Use exchange-confirmed price if available, otherwise fall back to tick price
    const fillPrice = record.avgFillPrice > 0 ? record.avgFillPrice : tickPrice;

    // A watcher can observe an order's very first fill (for example after a
    // restart).  It must run the initial strategy transition once, not an
    // "additional fill" transition merely because the delivery came from the
    // watcher.
    const isInitialStrategyFill = record.strategyFillKind === 'INITIAL';
    const isIncremental = !isInitialStrategyFill && overrideVolume !== undefined && overrideVolume > 0;

    // Use overrideVolume (incremental added volume) if passed by watcher, otherwise full filledVolume
    const effectiveVolume = isIncremental
      ? overrideVolume!
      : (record.filledVolume > 0 ? record.filledVolume : (record.requestedBudgetOrVolume / fillPrice));

    const feeCharged = record.fee || (fillPrice * effectiveVolume * 0.0005);
    this.totalFeesPaid += Math.round(feeCharged);

    if (signalType === 'ENTRY_BUY' || signalType === 'BREAKOUT_BUY') {
      if (position.amount > 0 && position.state !== 'FLAT') {
        this.positionManager.addAdditionalEntryFilled(fillPrice, effectiveVolume);
      } else {
        this.positionManager.onInitialEntryFilled(
          fillPrice,
          effectiveVolume,
          this.baselineValue,
          this.atrValue,
          this.params.atrMultiplier,
          this.params.stopLossMultiplier
        );
      }
      if (!isIncremental) this.totalTrades += 1;
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'MANUAL_ADD_BUY') {
      this.positionManager.onManualAdditionalBuyFilled(
        fillPrice,
        effectiveVolume,
        this.baselineValue,
        this.atrValue,
        this.params.atrMultiplier,
        this.params.stopLossMultiplier
      );
      if (!isIncremental) this.totalTrades += 1;
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [수동 추가 체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()} · DCA 슬롯 보존]`
      });
    } else if (signalType === 'REENTRY_BUY') {
      if (isIncremental) {
        this.positionManager.addAdditionalReentryFilled(
          fillPrice,
          effectiveVolume,
          this.baselineValue,
          this.atrValue,
          this.params.atrMultiplier,
          this.params.stopLossMultiplier
        );
      } else {
        this.positionManager.onReentryBuyFilled(
          fillPrice,
          effectiveVolume,
          this.baselineValue,
          this.atrValue,
          this.params.atrMultiplier,
          this.params.stopLossMultiplier
        );
      }
      if (!isIncremental) this.totalTrades += 1;
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [재진입 체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()} · 재진입 권한 소진]`
      });
    } else if (signalType === 'DCA_BUY') {
      if (isIncremental) {
        // Incremental DCA fill: add to current DCA slot volume without consuming a new slot
        this.positionManager.addAdditionalDcaFilled(fillPrice, effectiveVolume, record.status === 'FILLED');
      } else {
        const nextSlot = position.dcaSlots.find((s) => s.status === 'AVAILABLE' || s.status === 'PARTIALLY_FILLED') || { slotNumber: 1 };
        if (record.reason.includes('DCA 2차 접근 반등 선매수')) {
          const plannedTargetPrice = (position.entryPrice || fillPrice) * 0.958;
          this.positionManager.onDcaRecoveryPrebuyFilled(nextSlot.slotNumber, fillPrice, effectiveVolume, plannedTargetPrice);
        } else {
          this.positionManager.onDcaFilled(nextSlot.slotNumber, fillPrice, effectiveVolume, record.status === 'FILLED');
        }
      }
      if (!isIncremental) this.totalTrades += 1;
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'PYRAMID_BUY') {
      if (isIncremental) {
        // Incremental Pyramid fill: add volume without incrementing pyramidingCount again
        this.positionManager.addAdditionalPyramidFilled(fillPrice, effectiveVolume);
      } else {
        this.positionManager.onPyramidFilled(fillPrice, effectiveVolume);
      }
      if (!isIncremental) this.totalTrades += 1;
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'BOX_PYRAMID_BUY') {
      if (isIncremental) this.positionManager.addAdditionalBoxPyramidFilled(fillPrice, effectiveVolume);
      else this.positionManager.onBoxPyramidFilled(fillPrice, effectiveVolume);
      if (!isIncremental) this.totalTrades += 1;
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'REGIME_REBALANCE_BUY') {
      const adaptive = this.strategyCore.evaluateAdaptiveParams(fillPrice, this.baselineValue, this.atrValue, this.params, this.priceHistory.map((point) => point.price), this.higherTfTrend, this.rsiValue, this.volumeMultiplier, this.volumeMa);
      this.positionManager.onRegimeRebalanceBuyFilled(fillPrice, effectiveVolume, this.baselineValue, Math.max(this.atrValue, 5000), adaptive.dynamicAtr, this.params.stopLossMultiplier);
      if (!isIncremental) this.totalTrades += 1;
      this.addLog({ type: 'BUY', price: fillPrice, amount: effectiveVolume, exchange: this.params.exchange, reason: `${record.reason} [체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]` });
    } else if (signalType === 'PARTIAL_LOSS_CUT') {
      const cutVolume = effectiveVolume;
      const entry = position.entryPrice || fillPrice;
      const pnl = (fillPrice - entry) * cutVolume;
      const pnlPercent = entry > 0 ? ((fillPrice - entry) / entry) * 100 : 0;
      const cutStep = (position.partialCutCount || 0) + 1;

      if (isIncremental) {
        this.positionManager.addAdditionalPartialCutFilled(cutVolume, fillPrice, pnl);
        this.totalRealizedPnl += pnl;
      } else {
        this.positionManager.onPartialLossCutFilled(cutVolume, fillPrice, pnl, cutStep);
        this.totalRealizedPnl += pnl;
        this.totalTrades += 1;
      }

      this.addLog({
        type: 'STOP_LOSS',
        price: fillPrice,
        amount: cutVolume,
        pnl,
        pnlPercent,
        exchange: this.params.exchange,
        reason: `${record.reason} [실제체결: ${cutVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'EMERGENCY_TREND_CUT') {
      const cutVolume = effectiveVolume;
      const entry = position.entryPrice || fillPrice;
      const pnl = (fillPrice - entry) * cutVolume;
      const pnlPercent = entry > 0 ? ((fillPrice - entry) / entry) * 100 : 0;

      if (isIncremental) {
        this.positionManager.addAdditionalPartialCutFilled(cutVolume, fillPrice, pnl);
        this.totalRealizedPnl += pnl;
      } else {
        this.positionManager.onEmergencyTrendCutFilled(cutVolume, fillPrice, pnl);
        this.totalRealizedPnl += pnl;
        this.totalTrades += 1;
      }

      this.addLog({
        type: 'STOP_LOSS',
        price: fillPrice,
        amount: cutVolume,
        pnl,
        pnlPercent,
        exchange: this.params.exchange,
        reason: `${record.reason} [실제체결: ${cutVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'TRAILING_STOP_EXIT') {
      const sellVolume = effectiveVolume;
      const entry = position.entryPrice || fillPrice;
      const pnl = (fillPrice - entry) * sellVolume;
      const pnlPercent = entry > 0 ? ((fillPrice - entry) / entry) * 100 : 0;

      const isFullExit = sellVolume >= position.amount - 1e-6;

      if (isFullExit) {
        this.positionManager.onPositionClosed(pnl, signalType);
      } else {
        this.positionManager.onTrailingPartialFilled(sellVolume, fillPrice, pnl, record.status === 'FILLED');
      }

      this.totalRealizedPnl += pnl;
      if (!isIncremental) this.totalTrades += 1;
      if (pnl > 0) this.winTrades += 1;

      this.addLog({
        type: pnl >= 0 ? 'SELL' : 'STOP_LOSS',
        price: fillPrice,
        amount: sellVolume,
        pnl,
        pnlPercent,
        exchange: this.params.exchange,
        reason: `${record.reason} [${isFullExit ? '전량' : '부분'}체결: ${sellVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'SCALP_PARTIAL_TAKE_PROFIT') {
      const sellVolume = effectiveVolume;
      const entry = position.entryPrice || fillPrice;
      const pnl = (fillPrice - entry) * sellVolume;
      const pnlPercent = entry > 0 ? ((fillPrice - entry) / entry) * 100 : 0;
      this.positionManager.onScalpPartialTakeProfitFilled(sellVolume, fillPrice, pnl);
      this.totalRealizedPnl += pnl;
      if (!isIncremental) this.totalTrades += 1;
      if (pnl > 0) this.winTrades += 1;
      this.addLog({
        type: 'SELL', price: fillPrice, amount: sellVolume, pnl, pnlPercent, exchange: this.params.exchange,
        reason: `${record.reason} [50% 부분체결: ${sellVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()} · 잔량 본전 보호]`
      });
    } else if (
      signalType === 'ABSOLUTE_STOP_EXIT' ||
      signalType === 'EMERGENCY_FULL_EXIT' ||
      signalType === 'SCALP_TAKE_PROFIT'
    ) {
      const sellVolume = effectiveVolume;
      const entry = position.entryPrice || fillPrice;
      const pnl = (fillPrice - entry) * sellVolume;
      const pnlPercent = entry > 0 ? ((fillPrice - entry) / entry) * 100 : 0;

      if (record.status === 'FILLED') {
        this.positionManager.onPositionClosed(pnl, signalType);
        if (signalType === 'SCALP_TAKE_PROFIT' && this.params.experimentScalpReentryCooldownEnabled) {
          this.positionManager.setScalpReentryCooldown(180);
        }
        this.totalRealizedPnl += pnl;
        if (!isIncremental) this.totalTrades += 1;
        if (pnl > 0) this.winTrades += 1;

        if (signalType === 'EMERGENCY_FULL_EXIT') {
          this.botState = 'HALTED';
          this.disableAutoRunIntent();
        }
      } else {
        this.positionManager.reducePositionOnPartialExit(sellVolume, pnl);
        this.totalRealizedPnl += pnl;
      }

      this.addLog({
        type: pnl >= 0 ? 'SELL' : 'STOP_LOSS',
        price: fillPrice,
        amount: sellVolume,
        pnl,
        pnlPercent,
        exchange: this.params.exchange,
        reason: `${record.reason} [실제체결: ${sellVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    }

    // Persist order-level stage progress alongside the fill mutation. This is
    // intentionally separate from quantity accounting: a partial fragment
    // changes quantity immediately, but it never becomes a second DCA/cut/
    // trailing stage merely because the watcher reports it again.
    if (record.clientOrderId && ['DCA_BUY', 'PARTIAL_LOSS_CUT', 'TRAILING_STOP_EXIT'].includes(signalType)) {
      this.positionManager.recordExecutionStage(
        record.clientOrderId,
        signalType as SignalType,
        Number(record.strategyFillCumulativeVolume) > 0 ? Number(record.strategyFillCumulativeVolume) : effectiveVolume,
        record.status === 'FILLED',
        record.side === 'SELL' ? Number(record.requestedBudgetOrVolume) : undefined,
        record.side === 'BUY' ? Number(record.requestedBudgetOrVolume) : undefined
      );
    }

    // ── Record daily loss for Circuit Breaker ──
    // The breaker must use the same net realized PnL concept as the dashboard:
    // FIFO matched cost + allocated BUY fee + this SELL fee, never gross price
    // movement alone.
    if (record.side === 'BUY') {
      this.dailyCostLots.push({ volume: effectiveVolume, price: fillPrice, fee: feeCharged });
    } else if (record.side === 'SELL') {
      const netPnl = this.consumeDailyCostLots(effectiveVolume, fillPrice, feeCharged, position.entryPrice || fillPrice);
      if (netPnl < 0) {
        // Balance polling may still show the pre-fill KRW amount here. Use
        // the confirmed SELL proceeds for this threshold calculation; the
        // same amount is then installed in the short-lived balance shadow.
        const projectedKrw = this.actualKrwBalance + ((effectiveVolume * fillPrice) - feeCharged);
        const totalCap = projectedKrw + (this.positionManager.getSnapshot().amount * this.currentPrice);
        const { circuitBroken } = this.riskGovernor.recordDailyLoss(Math.abs(netPnl), totalCap);
        if (circuitBroken) {
          this.botState = 'HALTED';
          this.disableAutoRunIntent();
          this.addLog({
            type: 'SYSTEM',
            price: fillPrice,
            reason: `🚨 [서킷 브레이커] 수수료 포함 일일 순손실 한도(${this.params.dailyMaxLossPercent || 5}%) 초과 — 봇 자동 정지`
          });
        }
      }
    }

    // Refresh real account balances with a delay for eventual consistency defense
    if (!this.params.dryRunMode) {
      if (this.balanceSyncTimeout) {
        clearTimeout(this.balanceSyncTimeout);
      }
      this.balanceSyncTimeout = setTimeout(() => {
        this.fetchRealAccountBalance();
      }, 1500);
    }
  }

  /** Consumes FIFO lots and returns fee-inclusive net realized PnL for one SELL fill. */
  private consumeDailyCostLots(volume: number, sellPrice: number, sellFee: number, fallbackEntryPrice: number): number {
    let remaining = volume;
    let cost = 0;
    let allocatedBuyFees = 0;
    while (remaining > 1e-12 && this.dailyCostLots.length > 0) {
      const lot = this.dailyCostLots[0];
      const matched = Math.min(remaining, lot.volume);
      const feePortion = lot.fee * (matched / lot.volume);
      cost += matched * lot.price;
      allocatedBuyFees += feePortion;
      lot.volume -= matched;
      lot.fee -= feePortion;
      remaining -= matched;
      if (lot.volume <= 1e-12) this.dailyCostLots.shift();
    }
    // A manually adopted/rebased position has no local historical lots. Use
    // its authoritative entry price as a neutral fallback rather than invent
    // a profit; its SELL fee is still counted.
    if (remaining > 1e-12) cost += remaining * fallbackEntryPrice;
    return (volume * sellPrice) - cost - allocatedBuyFees - sellFee;
  }

  /**
   * Authoritative real-time ATR & Baseline recalculation from Upbit candle history
   * and Multi-Timeframe (15m) Trend Analysis for Whipsaw Filtering
   */
  public async refreshAtrFromExchange(): Promise<boolean> {
    const context = this.captureAsyncContext();
    const symbol = context.symbol;
    try {
      // 1. Fetch 1-minute candles for immediate ATR & Baseline calculation
      const candles = await this.upbitClient.fetchCandles(symbol, 20, 'minutes/1');
      if (!this.isAsyncContextCurrent(context)) return false;
      const completedCandles = candles?.slice(0, -1) || [];
      if (completedCandles.length < 14) return false;
      let trSum = 0;
      for (let i = 1; i < completedCandles.length; i++) {
        const prevClose = completedCandles[i - 1].trade_price;
        const high = completedCandles[i].high_price;
        const low = completedCandles[i].low_price;
        trSum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      }
      const calculatedAtr = Math.round(trSum / (completedCandles.length - 1));
      if (calculatedAtr <= 0) return false;
      const calculatedBaseline = Math.round(completedCandles.reduce((acc, candle) => acc + candle.trade_price, 0) / completedCandles.length);
      const closes = completedCandles.map((candle) => candle.trade_price);
      let gains = 0;
      let losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff;
        else losses += Math.abs(diff);
      }
      const avgGain = gains / 14;
      const avgLoss = losses / 14;
      const calculatedRsi = avgGain === 0 && avgLoss === 0 ? 50.0
        : avgLoss === 0 ? 100.0
        : avgGain === 0 ? 0.0
        : Number((100 - (100 / (1 + (avgGain / avgLoss)))).toFixed(1));
      const volumes = completedCandles.map((candle) => candle.candle_acc_trade_volume).filter((volume) => volume > 0);
      const calculatedVolumeMa = volumes.length >= 5
        ? Number((volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length).toFixed(4))
        : 0;
      const calculatedVolumeMultiplier = calculatedVolumeMa > 0
        ? Number(((volumes[volumes.length - 1] || calculatedVolumeMa) / calculatedVolumeMa).toFixed(2))
        : 1.0;

      // 2. Fetch 15-minute candles for Higher Timeframe trend confluence
      const htfCandles = await this.upbitClient.fetchCandles(symbol, 20, 'minutes/15');
      if (!this.isAsyncContextCurrent(context)) return false;
      const completedHtfCandles = htfCandles?.slice(0, -1) || [];
      if (completedHtfCandles.length < 10) return false;
      const htfCloses = completedHtfCandles.map((candle) => candle.trade_price);
      const fastHtf = htfCloses.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const slowHtf = htfCloses.slice(-10).reduce((a, b) => a + b, 0) / 10;
      const htfSlope = ((fastHtf - slowHtf) / slowHtf) * 100;
      const htfTrend: 'BULL' | 'SIDEWAYS' | 'BEAR' = htfSlope > 0.15 ? 'BULL' : htfSlope < -0.15 ? 'BEAR' : 'SIDEWAYS';

      // Commit all related indicator values atomically after both timeframes
      // have completed under the same symbol/account/generation context.
      if (!this.isAsyncContextCurrent(context)) return false;
      this.atrValue = calculatedAtr;
      this.baselineValue = calculatedBaseline;
      this.rsiValue = calculatedRsi;
      this.volumeMa = calculatedVolumeMa;
      this.volumeMultiplier = calculatedVolumeMultiplier;
      this.recent1mCloses = closes;
      this.higherTfTrend = { trend: htfTrend, htfSlope };

      const lastClose = closes[closes.length - 1] || calculatedBaseline;
      const initialAdaptive = this.strategyCore.evaluateAdaptiveParams(
        lastClose,
        calculatedBaseline,
        calculatedAtr,
        this.params,
        closes,
        { trend: htfTrend, htfSlope },
        calculatedRsi,
        calculatedVolumeMultiplier,
        calculatedVolumeMa
      );
      this.marketRegime = initialAdaptive.marketRegime;

      if (this.priceHistory.length === 0) {
        this.seedPriceHistoryFromCompletedCandles(completedCandles, calculatedBaseline, calculatedAtr);
      }
      this.researchRecorder?.recordCompletedCandles(symbol, completedCandles);
      console.log(`[ATREngine] 📊 Recalculated Dynamic Indicators: ATR=₩${calculatedAtr.toLocaleString()}, Baseline=₩${calculatedBaseline.toLocaleString()}, RSI=${calculatedRsi}, VolMult=${calculatedVolumeMultiplier}x`);
      console.log(`[ATREngine] 📈 Higher-TF (15m) Trend Confluence: ${htfTrend} (Slope: ${htfSlope.toFixed(2)}%)`);

      this.notifyClients();
      return true;
    } catch (e: any) {
      console.warn('[ATREngine] ⚠️ ATR calculation fallback notice:', e.message);
      return false;
    }
  }

  /**
   * Manual Buy / Sell Dispatcher
   */
  public async executeManualTrade(side: 'BUY' | 'SELL', manualBuyPercent?: number) {
    if (side !== 'BUY' && side !== 'SELL') {
      throw new Error('Unsupported manual order side.');
    }
    const circuitBroken = this.riskGovernor.getDailyLossStatus().circuitBroken;
    // A daily-loss halt blocks new risk, not the user's ability to flatten.
    // A durability halt remains terminal: we cannot safely mutate local state.
    if ((this.botState === 'HALTED' && !circuitBroken) || (circuitBroken && side === 'BUY')) {
      throw new Error('Manual buy blocked: circuit breaker or durability halt is active. Emergency sell remains available only for the daily-loss circuit breaker.');
    }
    if (!this.startupReady) {
      throw new Error('Manual order blocked: startup synchronization is incomplete.');
    }
    if (this.marketManager.marketState !== 'LIVE') {
      throw new Error(`Manual order blocked: market feed is ${this.marketManager.marketState}.`);
    }
    if (side === 'BUY' && this.orderManager.getPendingOrdersCount() > 0) {
      throw new Error('Manual order blocked: another order is pending reconciliation.');
    }
    const position = this.positionManager.getSnapshot();
    const keys = this.secretManager.getKeys();
    const exposure = this.riskGovernor.calculateExposureLimits(
      this.actualKrwBalance,
      position.amount,
      this.currentPrice,
      0
    );

    if (side === 'BUY') {
      const isAdditional = position.amount > 0 && position.state !== 'FLAT';
      if (manualBuyPercent !== undefined && ![10, 20, 30].includes(manualBuyPercent)) {
        throw new Error('Manual buy percentage must be one of 10, 20, or 30.');
      }
      const selectedPercent = isAdditional ? (manualBuyPercent ?? 10) : (this.params.orderRatio ?? 25);
      const targetBudget = exposure.totalCapitalKrw * (selectedPercent / 100);

      const budget = Math.floor(Math.min(
        targetBudget,
        this.actualKrwBalance * 0.98,
        exposure.remainingAllowableExposureKrw
      ));

      if (budget < 5000) {
        this.addLog({
          type: 'SYSTEM',
          price: this.currentPrice,
          reason: `❌ 수동 매수 실패: 주문 가능 예산(₩${budget.toLocaleString()})이 업비트 최소 금액(₩5,000) 미만이거나 잔고가 부족합니다.`
        });
        return;
      }

      const signalType = isAdditional ? 'MANUAL_ADD_BUY' : 'ENTRY_BUY';
      const req = {
        clientOrderId: `ORD_MANUAL_${signalType}_${Date.now()}`,
        signalId: `SIG_MANUAL_${Date.now()}`,
        signalType: signalType as 'MANUAL_ADD_BUY' | 'ENTRY_BUY',
        symbol: this.params.symbol,
        side: 'BUY' as const,
        requestedAmountKrw: budget,
        reason: `[수동 매수] 사용자 직접 매수 (${isAdditional ? `추가 매수 ${selectedPercent}% · DCA 슬롯 보존` : '1차 진입'}, ₩${budget.toLocaleString()})`,
        createdAt: Date.now()
      };

      await this.orderManager.submitOrder(
        req,
        keys,
        this.params.exchange,
        (record) => this.handleOrderFilled(signalType, record, this.currentPrice),
        (err) => this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: `❌ 수동 매수 에러: ${err}` })
      );
    } else {
      if (position.amount <= 0) {
        this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: '❌ 수동 매도 실패: 보유 코인 수량 없음' });
        return;
      }
      // Manual full exit shares the same coordinator as an automatic
      // protective exit: first cancel/reconcile every live order, refresh
      // exchange balance, then sell the actually unlocked remaining volume.
      const actualRemainingVolume = await this.coordinateProtectiveFullExit();
      if (actualRemainingVolume <= 1e-8) {
        this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: '❌ 수동 매도 실패: 거래소에서 청산 가능한 보유 수량을 확인하지 못했습니다.' });
        return;
      }
      const req = {
        clientOrderId: `ORD_MANUAL_SELL_${Date.now()}`,
        signalId: `SIG_MANUAL_${Date.now()}`,
        signalType: 'EMERGENCY_FULL_EXIT' as const,
        symbol: this.params.symbol,
        side: 'SELL' as const,
        requestedVolume: actualRemainingVolume,
        reason: '[전량 청산] 사용자 긴급 전량 매도 요청',
        createdAt: Date.now()
      };
      await this.orderManager.submitOrder(
        req,
        keys,
        this.params.exchange,
        (record) => this.handleOrderFilled('EMERGENCY_FULL_EXIT', record, this.currentPrice),
        (err) => this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: `❌ 긴급 청산 에러: ${err}` })
      );
    }
  }

  /** Cancel/reconcile live orders and refresh the exchange quantity before a full protective market exit. */
  private async coordinateProtectiveFullExit(): Promise<number> {
    await this.orderManager.cancelPendingOrdersForProtectiveExit(this.secretManager.getKeys(), this.params.symbol);
    const synchronized = await this.fetchRealAccountBalance();
    if (!synchronized) throw new Error('Could not refresh exchange balance after protective-order cancellation.');
    return this.lastExchangeCoinQuantity;
  }

  /**
   * Authoritative balance fetch & reconciliation with exchange
   */
  public async fetchRealAccountBalance(allowMissingPositionStateRecovery = false): Promise<boolean> {
    const context = this.captureAsyncContext();
    const symbol = context.symbol;
    try {
      const keys = this.secretManager.getKeys();
      if (this.params.exchange === 'UPBIT' && keys.upbitAccessKey && keys.upbitSecretKey) {
        const res = await this.apiGateway.enqueue(3, async () => {
          return await this.upbitClient.getAccountBalance(keys.upbitAccessKey!, keys.upbitSecretKey!);
        });

        if (!this.isAsyncContextCurrent(context)) return false;
        if (res.success && res.balances) {
          const balances = res.balances;
          const krw = balances['KRW'] || 0;
          const coinKey = symbol.replace('KRW-', '');
          // A limit sell locks the coin at Upbit.  It is still part of the
          // position and must not be reconciled to zero while that order is
          // open.
          const realCoinQty = (balances[coinKey] || 0) + (res.lockedBalances?.[coinKey] || 0);
          const authoritativeAvgPrice = res.avgBuyPrices ? res.avgBuyPrices[coinKey] : null;

          if (!this.isAsyncContextCurrent(context)) return false;
          // Do not overwrite the local post-fill shadow with an eventually
          // consistent, pre-fill exchange snapshot. The next matching (or
          // post-grace) snapshot becomes authoritative again.
          const shadowIsFresh = Date.now() < this.balanceShadowUntil;
          const krwMatchesShadow = Math.abs(krw - this.actualKrwBalance) <= Math.max(10, this.actualKrwBalance * 0.001);
          if (!shadowIsFresh || krwMatchesShadow) {
            this.realBalances = balances;
            this.actualKrwBalance = krw;
            if (krwMatchesShadow) {
              this.balanceShadowByOrder.clear();
              this.balanceShadowUntil = 0;
            }
          } else {
            this.realBalances = { ...balances, KRW: this.actualKrwBalance };
          }
          this.lastExchangeCoinQuantity = realCoinQty;
          // A missing local position ledger cannot safely be recreated from
          // amount/average alone: DCA, trailing, cooldown and durable fill
          // state would be invented. Only explicit manual rebase may adopt it.
          const local = this.positionManager.getSnapshot();
          const quantityMismatch = Math.abs(local.amount - realCoinQty) > 1e-8;
          const averageMismatch = realCoinQty > 1e-8 && Boolean(authoritativeAvgPrice && Math.abs((local.entryPrice || 0) - authoritativeAvgPrice) > 1);
          // Before an order fills, Upbit may report a balance snapshot from
          // just before that order.  It is not safe to label that expected
          // in-flight delta as a manual/external position change.  Wait for
          // the order watcher to settle, then let a subsequent authoritative
          // poll reconcile the final state.
          const hasPendingOrders = this.orderManager.getPendingOrdersCount() > 0;
          if (hasPendingOrders && (quantityMismatch || averageMismatch)) {
            // Deliberately preserve the local durable position unchanged.
          } else if (shadowIsFresh && (quantityMismatch || averageMismatch)) {
            // The same lag can affect the coin balance. Never mistake the
            // pre-fill snapshot for an external manual trade/rebase event.
          } else if (!allowMissingPositionStateRecovery && this.positionManager.hasPersistedState() && (quantityMismatch || averageMismatch)) {
            // An external transfer/manual trade cannot safely inherit DCA,
            // trailing and durable-fill state. Preserve the local ledger and
            // require the explicit paused rebase path instead of guessing.
            this.rebaseRequired = true;
            this.disableAutoRunIntent();
            this.botState = 'PAUSED';
            this.addLog({ type: 'SYSTEM', price: this.currentPrice, reason: '⚠️ [포지션 보정 필요] 거래소 수량 또는 평단이 로컬 체결 원장과 다릅니다. 자동 전략을 정지했습니다.' });
          } else if (this.positionManager.hasPersistedState() || realCoinQty <= 1e-8 || allowMissingPositionStateRecovery) {
            this.positionManager.reconcileWithExchange(realCoinQty, authoritativeAvgPrice, this.currentPrice);
            if (allowMissingPositionStateRecovery) this.rebaseRequired = false;
          }

          if (this.initialBalance === 0 && (krw > 0 || realCoinQty > 0)) {
            this.initialBalance = krw + (realCoinQty * this.currentPrice);
          }
          this.notifyClients();
          return true;
        }
      }
      this.notifyClients();
      return false;
    } catch (e) {
      return false;
    }
  }

  /** Safe, explicit repair path for a position that was exchange-filled while local state was stale. */
  public async rebaseCurrentPosition() {
    if (this.botState === 'RUNNING' || this.params.isBotActive) {
      throw new Error('포지션 보정은 봇을 정지한 상태에서만 실행할 수 있습니다.');
    }
    if (this.orderManager.getPendingOrdersCount() > 0) {
      throw new Error('미체결 주문이 있어 포지션 보정을 실행할 수 없습니다.');
    }
    const indicatorsReady = await this.refreshAtrFromExchange();
    if (!indicatorsReady) {
      throw new Error('완성된 1분/15분 지표를 준비하지 못해 포지션 보정을 중단했습니다.');
    }
    const keys = this.secretManager.getKeys();
    if (!keys.upbitAccessKey || !keys.upbitSecretKey) {
      throw new Error('거래소 API 키가 없어 포지션 보정을 실행할 수 없습니다.');
    }
    const openOrders = await this.upbitClient.getOpenOrders(keys.upbitAccessKey, keys.upbitSecretKey, this.params.symbol);
    if (!openOrders.success || !Array.isArray(openOrders.orders)) {
      throw new Error('거래소 미체결 주문을 확인하지 못해 포지션 보정을 중단했습니다.');
    }
    if (openOrders.orders.length > 0) {
      throw new Error('거래소 미체결 주문이 있어 포지션 보정을 실행할 수 없습니다. 먼저 주문을 정리하세요.');
    }
    // Do not call the ordinary reconciliation path here: it writes an
    // intermediate amount/average-only position before protection fields are
    // rebuilt. Read the balance and adopt/rebase once below instead.
    const context = this.captureAsyncContext();
    const balanceRes = await this.apiGateway.enqueue(3, async () => {
      return await this.upbitClient.getAccountBalance(keys.upbitAccessKey!, keys.upbitSecretKey!);
    });
    if (!this.isAsyncContextCurrent(context) || !balanceRes.success || !balanceRes.balances) {
      throw new Error('거래소 잔고 동기화에 실패해 포지션 보정을 중단했습니다.');
    }
    const coinKey = this.params.symbol.replace('KRW-', '');
    const exchangeQuantity = (balanceRes.balances[coinKey] || 0) + (balanceRes.lockedBalances?.[coinKey] || 0);
    const exchangeEntryPrice = balanceRes.avgBuyPrices?.[coinKey] || 0;
    if (exchangeQuantity <= 1e-8 || exchangeEntryPrice <= 0) {
      throw new Error('거래소에서 확인된 보유 포지션이 없어 보정을 중단했습니다.');
    }
    const adaptive = this.strategyCore.evaluateAdaptiveParams(
      this.currentPrice, this.baselineValue, this.atrValue, this.params,
      this.priceHistory.map((point) => point.price), this.higherTfTrend,
      this.rsiValue, this.volumeMultiplier, this.volumeMa
    );
    const atrMultiplier = this.params.autoPilotEnabled ? adaptive.dynamicAtr : this.params.atrMultiplier;
    this.positionManager.adoptAndRebaseExchangePosition(
      exchangeQuantity, exchangeEntryPrice, this.baselineValue, this.atrValue, atrMultiplier
    );
    this.realBalances = balanceRes.balances;
    this.actualKrwBalance = balanceRes.balances.KRW || 0;
    this.lastExchangeCoinQuantity = exchangeQuantity;
    this.rebaseRequired = false;
    const repaired = this.positionManager.getSnapshot();
    this.addLog({
      type: 'SYSTEM',
      price: this.currentPrice,
      reason: `[포지션 안전 보정] 거래소 실수량·평단으로 동기화 후 보호 기준 재설정 (평단 ₩${Math.round(repaired.entryPrice || 0).toLocaleString()}, 정적 손절 ₩${Math.round(repaired.initialStopPrice || 0).toLocaleString()})`
    });
    this.notifyClients();
  }

  public updateParams(newParams: Partial<BotParams>) {
    const symbolChanged = newParams.symbol && newParams.symbol !== this.params.symbol;
    const exchangeChanged = newParams.exchange && newParams.exchange !== this.params.exchange;

    if (newParams.isBotActive === true && this.durabilityFailure) {
      throw new Error('저장 안전 정지 상태입니다. 서버를 재시작하고 거래소 동기화가 완료되기 전에는 봇을 다시 가동할 수 없습니다.');
    }
    if (newParams.isBotActive === true && this.rebaseRequired) {
      throw new Error('포지션 보정이 필요합니다. 봇을 정지한 상태에서 보정을 완료하기 전에는 다시 가동할 수 없습니다.');
    }
    if (newParams.isBotActive === true && this.riskGovernor.getDailyLossStatus().circuitBroken) {
      throw new Error('당일 손실 서킷 브레이커가 활성화되어 있습니다. 신규 매수는 다음 KST 일자 초기화 전까지 재개할 수 없습니다. 보호 매도만 허용됩니다.');
    }
    if (newParams.dryRunMode !== undefined && newParams.dryRunMode !== this.params.dryRunMode) {
      const position = this.positionManager.getSnapshot();
      if (this.botState !== 'PAUSED' || position.state !== 'FLAT' || this.orderManager.getPendingOrdersCount() > 0) {
        throw new Error('Dry-run 전환은 봇 정지(PAUSED)·무포지션(FLAT)·미체결 주문 0건일 때만 가능합니다.');
      }
    }

    // PositionManager models exactly one asset. Switching its market while a
    // position or an exchange order exists would mix two assets in one state
    // machine, so reject the request before mutating any active parameters.
    if (symbolChanged || exchangeChanged) {
      const position = this.positionManager.getSnapshot();
      if (position.state !== 'FLAT' || this.orderManager.getPendingOrdersCount() > 0) {
        throw new Error('보유 포지션 또는 미체결 주문이 있어 심볼/거래소를 변경할 수 없습니다. 전량 청산 및 주문 정리 후 다시 시도하세요.');
      }
    }

    // Strategy Lab controls are retired from live operation. Keep their
    // signal-only recorder variants, but never allow a persisted or stale UI
    // configuration to alter real order decisions.
    this.params = {
      ...this.params,
      ...newParams,
      experimentDca2RsiRecoveryEnabled: false,
      experimentDca2VolumeConfirmationEnabled: false,
      experimentPyramidRsiGuardEnabled: false,
      experimentPyramidVolumeConfirmationEnabled: false,
      experimentScalpTrendExpansionEnabled: false,
      experimentScalpReentryCooldownEnabled: false,
      experimentTrendTrailingArmingEnabled: false
    };
    this.riskGovernor.setParams(this.params);
    this.positionManager.setParams(this.params);

    if (newParams.isBotActive !== undefined) {
      this.requestedRunAfterStartup = newParams.isBotActive;
      this.persistRunIntent(newParams.isBotActive);
      if (newParams.isBotActive && !this.startupReady) {
        this.botState = 'STARTING';
        this.startStartupBarrier();
      } else {
        this.botState = newParams.isBotActive ? 'RUNNING' : 'PAUSED';
      }
      this.addLog({
        type: 'SYSTEM',
        price: this.currentPrice,
        reason: `[봇 상태 전환] ➡️ ${this.botState}`
      });
    }

    if (symbolChanged || exchangeChanged) {
      this.invalidateStartupBarrier();
      this.marketManager.setSymbol(this.params.exchange, this.params.symbol);
      this.startStartupBarrier();
    }

    this.notifyClients();
  }

  public setApiKeys(keys: ApiKeys) {
    const position = this.positionManager.getSnapshot();
    if (position.state !== 'FLAT' || this.orderManager.getPendingOrdersCount() > 0) {
      throw new Error('보유 포지션 또는 미체결 주문이 있어 API 키/계좌를 변경할 수 없습니다. 전량 청산 및 주문 정리 후 다시 시도하세요.');
    }
    this.secretManager.saveKeys(keys);
    this.orderManager.setApiKeysForWatcher(keys);
    // A key change can mean a different account. Reconcile orders and balance
    // as a single fresh startup sequence before allowing any strategy action.
    this.accountContextGeneration += 1;
    this.invalidateStartupBarrier();
    this.startStartupBarrier();
    this.addLog({
      type: 'SYSTEM',
      price: this.currentPrice,
      reason: '🔑 거래소 API 키가 암호화되어 안전하게 영구 저장되었습니다.'
    });
  }

  public addLog(log: Omit<TradeLog, 'id' | 'time' | 'timestamp'>) {
    const dryTag = this.params.dryRunMode ? '[DRY-RUN] ' : '';
    const d = new Date();
    const timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    const newLog: TradeLog = {
      ...log,
      reason: dryTag + log.reason,
      id: Math.random().toString(36).substring(7),
      time: timeLabel,
      timestamp: Date.now()
    };
    this.logs.unshift(newLog);
    if (this.logs.length > 300) this.logs.pop();

    // Do not alert on ordinary manual pauses or every trade. Only conditions
    // that require the owner to inspect/recover the engine are pushed.
    if (log.type === 'SYSTEM' && /(안전 정지|포지션 보정 필요|시작 장벽 유지|보호청산 안전 정지|저장 안전 정지)/.test(log.reason)) {
      void this.secretManager.sendTelegramAlert(
        `🚨 Upbit 퀀트봇 주의\n${log.reason}\n현재가: ₩${Math.round(this.currentPrice).toLocaleString()}\n시간: ${timeLabel}`
      );
    }

    // Persist trade logs (BUY/SELL/STOP_LOSS) to disk
    if (log.type !== 'SYSTEM') {
      try {
        const diskLogs = PositionManager.loadTradeLogs();
        diskLogs.unshift(newLog);
        PositionManager.saveTradeLogs(diskLogs);
      } catch {}
    }
  }

  /**
   * Realized performance belongs to the day a SELL fill closes quantity.
   * Both the matched BUY fee and the SELL fee are deducted on that day so the
   * dashboard never presents a gross profit as a net daily result.
   */
  private getDailyNetPerformance() {
    const days = new Map<string, { date: string; realizedPnl: number; fees: number; netPnl: number; sellCount: number }>();
    const buys: { vol: number; price: number; fee: number }[] = [];
    const orders = this.orderManager.getAllOrders()
      .filter((order) => order.filledVolume > 0 && order.avgFillPrice > 0)
      .sort((a, b) => a.updatedAt - b.updatedAt);

    for (const order of orders) {
      if (order.side === 'BUY') {
        buys.push({ vol: order.filledVolume, price: order.avgFillPrice, fee: order.fee || 0 });
        continue;
      }

      if (order.side !== 'SELL') continue;
      let remainingVolume = order.filledVolume;
      let matchedCost = 0;
      let matchedBuyFees = 0;

      while (remainingVolume > 0 && buys.length > 0) {
        const buy = buys[0];
        const matchedVolume = Math.min(remainingVolume, buy.vol);
        const feePortion = buy.fee * (matchedVolume / buy.vol);
        matchedCost += matchedVolume * buy.price;
        matchedBuyFees += feePortion;
        buy.vol -= matchedVolume;
        buy.fee -= feePortion;
        remainingVolume -= matchedVolume;
        if (buy.vol <= 1e-12) buys.shift();
      }

      // Ignore unmatched quantity for PnL rather than manufacturing a profit.
      const matchedVolume = order.filledVolume - remainingVolume;
      if (matchedVolume <= 0) continue;
      const sellFee = (order.fee || 0) * (matchedVolume / order.filledVolume);
      const grossPnl = (matchedVolume * order.avgFillPrice) - matchedCost;
      const fees = matchedBuyFees + sellFee;
      const date = new Date(order.updatedAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      const day = days.get(date) || { date, realizedPnl: 0, fees: 0, netPnl: 0, sellCount: 0 };
      day.realizedPnl += grossPnl;
      day.fees += fees;
      day.netPnl += grossPnl - fees;
      day.sellCount += 1;
      days.set(date, day);
    }

    return [...days.values()]
      .map((day) => ({
        ...day,
        realizedPnl: Math.round(day.realizedPnl),
        fees: Math.round(day.fees),
        netPnl: Math.round(day.netPnl)
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * Full Snapshot for WebSocket Client UI Synchronization
   */
  public getFullState() {
    const pos = this.positionManager.getSnapshot();
    const masked = this.secretManager.getMaskedStatus();
    // Use the same FIFO, fee-deducted realization basis everywhere the UI
    // shows performance. The mutable running counter is retained internally
    // for trade handling, but can otherwise drift from fees after live fills.
    const dailyNetPerformance = this.getDailyNetPerformance();
    const realizedNetPnl = dailyNetPerformance.reduce((sum, day) => sum + day.netPnl, 0);
    const exposure = this.riskGovernor.calculateExposureLimits(
      this.actualKrwBalance,
      pos.amount,
      this.currentPrice,
      0
    );

    // Evaluate dynamic adaptive indicators for UI visualization
    const historyPrices = this.priceHistory.map((p) => p.price);
    historyPrices.push(this.currentPrice);
    const adaptive = this.strategyCore.evaluateAdaptiveParams(
      this.currentPrice,
      this.baselineValue,
      this.atrValue,
      this.params,
      historyPrices,
      this.higherTfTrend,
      this.rsiValue,
      this.volumeMultiplier,
      this.volumeMa
    );
    const dropSpeed = this.marketManager ? this.marketManager.calculateDropSpeed(this.params.trendDropWindowSeconds || 5) : 0;

    // Calculate Next Order Info Pages for UI Swipeable Card
    const pages: NextOrderItem[] = [];
    const effectiveOrderRatio = (this.params.autoPilotEnabled && adaptive.dynamicOrderRatio > 0)
      ? adaptive.dynamicOrderRatio
      : (this.params.orderRatio ?? 25);
    const baseUnitBudget = exposure.totalCapitalKrw * (effectiveOrderRatio / 100);

    if (pos.amount > 0 && pos.state !== 'FLAT') {
      const entry = pos.entryPrice || this.currentPrice;
      const currentExposurePercent = exposure.totalCapitalKrw > 0
        ? (exposure.currentExposureKrw / exposure.totalCapitalKrw) * 100
        : 0;
      const positionPnlPercent = entry > 0 ? ((this.currentPrice - entry) / entry) * 100 : 0;
      const strongBullTarget =
        this.higherTfTrend?.trend === 'BULL' && adaptive.marketRegime === 'BULL' &&
        positionPnlPercent >= 0.70 && adaptive.slope >= 0.10 && adaptive.volumeMultiplier >= 1.30 &&
        adaptive.rsi >= 52 && adaptive.rsi <= 68;
      const bullTargetExposurePercent = strongBullTarget ? 70 : 65;
      const hasDcaOrderInProgress = pos.dcaSlots.some((slot) =>
        slot.status === 'RESERVED' || slot.status === 'ORDER_PENDING' || slot.status === 'PARTIALLY_FILLED'
      );
      const defensivePosition = pos.state === 'DEFENSIVE' || pos.state === 'DEFENSIVE_1' || pos.state === 'DEFENSIVE_2' || pos.state === 'EMERGENCY_EXIT';
      const canBuildBullCore =
        this.params.autoPilotEnabled && this.params.pyramidingEnabled &&
        this.higherTfTrend?.trend === 'BULL' && adaptive.marketRegime === 'BULL' && adaptive.rsi < 75 &&
        currentExposurePercent < bullTargetExposurePercent - 2 &&
        !pos.trailingActive && !(pos.trailingExitCount && pos.trailingExitCount >= 1) &&
        !hasDcaOrderInProgress && !defensivePosition && (pos.partialCutCount || 0) === 0 &&
        Date.now() - (pos.lastRegimeRebalanceAt || 0) >= 120_000 && Date.now() >= pos.cooldownUntil;

      // Only expose this as the next action when it is genuinely eligible;
      // a higher-timeframe BULL alone is not enough during a BULL_PULLBACK.
      if (canBuildBullCore) {
        const gapKrw = Math.max(0, (exposure.totalCapitalKrw * (bullTargetExposurePercent / 100)) - exposure.currentExposureKrw);
        const stepBudget = Math.floor(Math.min(gapKrw, exposure.totalCapitalKrw * 0.05, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
        pages.push({
          category: 'REGIME_TARGET',
          categoryLabel: '상승장 보유비중 우선',
          type: 'BULL 목표비중 채우기 (최대 5%p)',
          budgetKrw: stepBudget,
          unitPercent: 5,
          scaleMultiplier: 1,
          targetPriceLabel: `현재 ${currentExposurePercent.toFixed(1)}% → 목표 ${bullTargetExposurePercent}% (현재 BULL·RSI<75·방어/DCA 대기 없음)`,
          themeColor: 'amber'
        });
      }

      // Page 1: DCA 물타기 (하락 시 대응)
      const nextDcaSlot = pos.dcaSlots.find((s) => s.status === 'AVAILABLE' || s.status === 'PARTIALLY_FILLED');
      if (this.params.dcaEnabled && nextDcaSlot) {
        const dcaScale = FIXED_DCA_UNIT_SCALES[nextDcaSlot.slotNumber - 1] || FIXED_DCA_UNIT_SCALES[0];
        const isDca2Remainder = nextDcaSlot.slotNumber === 2 && nextDcaSlot.status === 'PARTIALLY_FILLED';
        const dcaBudgetRaw = baseUnitBudget * dcaScale * (isDca2Remainder ? 1 - DCA2_RECOVERY_PREBUY_FRACTION : 1);
        const dcaBudget = Math.floor(Math.min(dcaBudgetRaw, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
        const targetDcaDrop = FIXED_DCA_DROP_PERCENTS[nextDcaSlot.slotNumber - 1] || FIXED_DCA_DROP_PERCENTS[0];
        const targetDcaPrice = isDca2Remainder && nextDcaSlot.plannedTargetPrice
          ? nextDcaSlot.plannedTargetPrice
          : entry * (1 - targetDcaDrop / 100);
        pages.push({
          category: 'DCA',
          categoryLabel: '하락 시 저점 추매',
          type: isDca2Remainder ? 'DCA #2차 잔여 매수 (60%)' : `DCA #${nextDcaSlot.slotNumber}차 리사이클링 (${dcaScale}x)`,
          budgetKrw: dcaBudget,
          unitPercent: Number((effectiveOrderRatio * dcaScale * (isDca2Remainder ? 1 - DCA2_RECOVERY_PREBUY_FRACTION : 1)).toFixed(1)),
          scaleMultiplier: dcaScale,
          targetPriceLabel: isDca2Remainder
            ? `₩${Math.round(targetDcaPrice).toLocaleString()} (-4.2% 도달 시 · 2차 잔여 60%)`
            : nextDcaSlot.slotNumber === 2
              ? `접근 반등: -3.5%~-4.15%에서 저점 +0.7% 반등 시 ${DCA2_RECOVERY_PREBUY_FRACTION * 100}% · ₩${Math.round(targetDcaPrice).toLocaleString()}(-4.2%)에서 잔여 ${(1 - DCA2_RECOVERY_PREBUY_FRACTION) * 100}%`
              : `₩${Math.round(targetDcaPrice).toLocaleString()} (-${targetDcaDrop.toFixed(1)}% 저점 도달 시)`,
          targetPrice: targetDcaPrice,
          themeColor: 'indigo'
        });
      } else {
        pages.push({
          category: 'COMPLETED',
          categoryLabel: '물타기 완료',
          type: 'DCA 슬롯 소진',
          budgetKrw: 0,
          unitPercent: effectiveOrderRatio,
          scaleMultiplier: 0,
          targetPriceLabel: '최대 물타기 완료 (마지노선 감시)',
          themeColor: 'indigo'
        });
      }

      // Page 2: 불타기 (상승 시 대응: BULL vs SIDEWAYS 구분)
      const isNeutralRange = adaptive.marketRegime === 'SIDEWAYS' && adaptive.sidewaysContext === 'NEUTRAL_RANGE';
      if (isNeutralRange) {
        const BOX_RATIOS = [0.50, 0.50];
        if (this.params.pyramidingEnabled && pos.boxPyramidCount < 2) {
          const nextBoxStep = pos.boxPyramidCount + 1;
          const boxScale = BOX_RATIOS[pos.boxPyramidCount] || 0.50;
          const boxBudgetRaw = baseUnitBudget * boxScale;
          const boxBudget = Math.floor(Math.min(boxBudgetRaw, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
          const targetBoxPrice = entry * (1 + 0.0025);
          pages.push({
            category: 'PYRAMID',
            categoryLabel: '박스권 불타기',
            type: `박스 불타기 #${nextBoxStep}차 (${boxScale} Unit)`,
            budgetKrw: boxBudget,
            unitPercent: Number((effectiveOrderRatio * boxScale).toFixed(1)),
            scaleMultiplier: boxScale,
            targetPriceLabel: `₩${Math.round(targetBoxPrice).toLocaleString()} (+0.25% 도달 시)`,
            themeColor: 'purple'
          });
        } else {
          pages.push({
            category: 'COMPLETED',
            categoryLabel: '불타기 완료',
            type: '박스 불타기 한도(2회) 소진',
            budgetKrw: 0,
            unitPercent: effectiveOrderRatio,
            scaleMultiplier: 0,
            targetPriceLabel: '목표 수익 도달 시 전량 익절 대기',
            themeColor: 'purple'
          });
        }
      } else if (this.params.pyramidingEnabled && pos.pyramidingCount < this.params.maxPyramidingOrders) {
        const nextPyrStep = (pos.pyramidingCount + 1);
        const pyramidScale = nextPyrStep === 1 ? 0.50 : 0.35;
        const pyrBudget = Math.floor(Math.min(baseUnitBudget * pyramidScale, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
        const targetPyrPrice = entry * (1 + (this.params.pyramidingStepPercent * nextPyrStep) / 100);
        pages.push({
          category: 'PYRAMID',
          categoryLabel: '상승 시 불타기',
          type: `상승 불타기 #${nextPyrStep}차 (${pyramidScale} Unit)`,
          budgetKrw: pyrBudget,
          unitPercent: Number((effectiveOrderRatio * pyramidScale).toFixed(1)),
          scaleMultiplier: pyramidScale,
          targetPriceLabel: `₩${Math.round(targetPyrPrice).toLocaleString()} (+${(this.params.pyramidingStepPercent * nextPyrStep).toFixed(1)}% 상승 시)`,
          themeColor: 'amber'
        });
      } else {
        pages.push({
          category: 'COMPLETED',
          categoryLabel: '불타기 완료',
          type: '불타기 한도 소진',
          budgetKrw: 0,
          unitPercent: effectiveOrderRatio,
          scaleMultiplier: 0,
          targetPriceLabel: '최고점 트레일링 익절 대기 중',
          themeColor: 'amber'
        });
      }

      // Page 3: 박스권 짤짤이 익절 (Rule 3-b) - Stepped target based on boxPyramidCount
      if (isNeutralRange) {
        let steppedScalpTpPercent = adaptive.dynamicScalpTakeProfitPercent;
        if (pos.boxPyramidCount === 1) steppedScalpTpPercent = Math.max(steppedScalpTpPercent, 0.60);
        else if (pos.boxPyramidCount === 2) steppedScalpTpPercent = Math.max(steppedScalpTpPercent, 0.70);
        else if (pos.boxPyramidCount >= 3) steppedScalpTpPercent = Math.max(steppedScalpTpPercent, 0.85);

        const scalpTpTargetPrice = entry * (1 + steppedScalpTpPercent / 100);
        pages.push({
          category: 'SCALP_TP',
          categoryLabel: '박스권 짤짤이 익절',
          type: `스캘핑 전량 익절 (+${steppedScalpTpPercent.toFixed(2)}%)`,
          budgetKrw: Math.round(pos.amount * this.currentPrice),
          unitPercent: 100,
          scaleMultiplier: 1.0,
          targetPriceLabel: `₩${Math.round(scalpTpTargetPrice).toLocaleString()} (+${steppedScalpTpPercent.toFixed(2)}% 도달 시)`,
          themeColor: 'teal'
        });
      }

      // Page 4: 트레일링 50% 분할 익절 (Rule 4)
      const minAtrFloor = Math.max(5000, Math.round(this.currentPrice * 0.0025));
      const effectiveAtr = Math.max(this.atrValue, minAtrFloor);
      const effectiveMultiplier = this.params.autoPilotEnabled ? adaptive.dynamicAtr : this.params.atrMultiplier;
      const upperBandCalc = this.baselineValue + (effectiveAtr * effectiveMultiplier);
      const entryPriceVal = pos.entryPrice || 0;
      const minProfitArmingPrice = entryPriceVal * 1.010; // +1.0% 이상
      const armingTargetPrice = Math.max(upperBandCalc, minProfitArmingPrice);

      const minFloorExitPrice = entryPriceVal * 1.002; // +0.2% 이상
      const effectiveTrailingCallback = pos.pyramidingCount >= 2
        ? Math.min(adaptive.dynamicTrailingCallback, 0.6)
        : adaptive.dynamicTrailingCallback;
      const trailingExitPrice = Math.max(
        (pos.trailingPeakPrice || this.currentPrice) * (1 - effectiveTrailingCallback / 100),
        minFloorExitPrice
      );
      const isLastStep = (pos.trailingExitCount || 0) >= 1 || ((pos.amount * 0.5) * this.currentPrice < 500000);
      pages.push({
        category: 'TRAILING_TP',
        categoryLabel: isLastStep ? '트레일링 전량 익절' : '트레일링 50% 익절',
        type: pos.trailingActive
          ? (isLastStep ? `2차 최고점 대비 -${effectiveTrailingCallback}% 꺾임 시 전량(100%) 익절` : `1차 최고점 대비 -${effectiveTrailingCallback}% 꺾임 시 50% 익절`)
          : `평단 대비 +1.0% (상단 밴드) 도달 시 무장`,
        budgetKrw: Math.round((isLastStep ? pos.amount : pos.amount * 0.5) * this.currentPrice),
        unitPercent: isLastStep ? 100 : 50,
        scaleMultiplier: isLastStep ? 1.0 : 0.5,
        targetPriceLabel: pos.trailingActive
          ? `₩${Math.round(trailingExitPrice).toLocaleString()} (최고 ₩${Math.round(pos.trailingPeakPrice || this.currentPrice).toLocaleString()} 대비 -${effectiveTrailingCallback}% 하락 시)`
          : `₩${Math.round(armingTargetPrice).toLocaleString()} 이상 터치 시 (평단 대비 +1.0% 확보)`,
        themeColor: 'emerald'
      });
    } else {
      // 무포지션 FLAT 상태일 때:
      const entryBudget = Math.floor(Math.min(baseUnitBudget, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
      const scalpBudget = Math.floor(Math.min(baseUnitBudget * 0.5, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
      
      const minAtrFloor = Math.max(5000, Math.round(this.currentPrice * 0.0025));
      const effectiveAtr = Math.max(this.atrValue, minAtrFloor);
      const effectiveMultiplier = this.params.autoPilotEnabled ? adaptive.dynamicAtr : this.params.atrMultiplier;
      const lowerBandCalc = this.baselineValue - (effectiveAtr * effectiveMultiplier);
      const lowerTarget = Math.round(lowerBandCalc > 0 ? lowerBandCalc : this.currentPrice * 0.98);

      const lowerScalpCalc = this.baselineValue - (effectiveAtr * adaptive.dynamicScalpBandMultiplier);
      const upperScalpCalc = this.baselineValue + (effectiveAtr * adaptive.dynamicScalpBandMultiplier);

      // Page 1: 박스권 하단 스캘핑 진입 (Rule 8-b)
      pages.push({
        category: 'SCALP_DIP',
        categoryLabel: '박스권 하단 스캘핑',
        type: '하단 스캘핑 (0.5 Unit)',
        budgetKrw: scalpBudget,
        unitPercent: Math.round(effectiveOrderRatio * 0.5),
        scaleMultiplier: 0.5,
        targetPriceLabel: `₩${Math.round(lowerScalpCalc).toLocaleString()} 이하 터치 시`,
        themeColor: 'cyan'
      });

      // Page 2: 박스권 상단 스캘핑 진입 (Rule 9-b)
      pages.push({
        category: 'SCALP_BREAKOUT',
        categoryLabel: '박스권 상단 스캘핑',
        type: '상단 스캘핑 (0.5 Unit)',
        budgetKrw: scalpBudget,
        unitPercent: Math.round(effectiveOrderRatio * 0.5),
        scaleMultiplier: 0.5,
        targetPriceLabel: `기준선 ~ ₩${Math.round(upperScalpCalc).toLocaleString()} 구간`,
        themeColor: 'teal'
      });

      // Page 3: 1차 저점 과매도 진입 (Rule 8)
      pages.push({
        category: 'DIP',
        categoryLabel: '하단밴드 과매도 매수',
        type: '1차 저점 진입 (1 Unit)',
        budgetKrw: entryBudget,
        unitPercent: effectiveOrderRatio,
        scaleMultiplier: 1.0,
        targetPriceLabel: `하단 ₩${lowerTarget.toLocaleString()} 이하 터치 시`,
        themeColor: 'blue'
      });

      // Page 4: 1차 상승 모멘텀 돌파 (Rule 9)
      pages.push({
        category: 'BREAKOUT',
        categoryLabel: '상승 추세 돌파 매수',
        type: '1차 돌파 진입 (1 Unit)',
        budgetKrw: entryBudget,
        unitPercent: effectiveOrderRatio,
        scaleMultiplier: 1.0,
        targetPriceLabel: `기준선(₩${Math.round(this.baselineValue).toLocaleString()}) 상향 + BULL/모멘텀`,
        themeColor: 'emerald'
      });
    }

    const nextOrderInfo = {
      type: pages[0]?.type || '1차 신규 진입',
      budgetKrw: pages[0]?.budgetKrw || 0,
      unitPercent: pages[0]?.unitPercent ?? (this.params.orderRatio ?? 25),
      scaleMultiplier: pages[0]?.scaleMultiplier || 1.0,
      targetPriceLabel: pages[0]?.targetPriceLabel || '',
      pages
    };

    return {
      params: this.params,
      botState: this.botState,
      startup: {
        ready: this.startupReady,
        failureReason: this.startupFailureReason,
        rebaseRequired: this.rebaseRequired
      },
      marketState: this.marketManager ? this.marketManager.marketState : 'DISCONNECTED',
      marketRegime: this.marketRegime,
      // Presentation-only: lets the radar explain why a BULL target-add is
      // waiting without duplicating or changing the strategy decision.
      higherTimeframe: this.higherTfTrend,
      adaptive,
      dropSpeed,
      rsi: this.rsiValue,
      volumeMultiplier: this.volumeMultiplier,
      volumeMa: this.volumeMa,
      research: this.researchRecorder?.getStats() || { enabled: false, ticksRecorded: 0, candlesRecorded: 0, shadowDifferences: 0, totalTicksRecorded: 0, totalCandlesRecorded: 0, totalShadowDifferences: 0, startedAt: 0 },
      currentPrice: this.currentPrice,
      atrValue: this.atrValue,
      baselineValue: this.baselineValue,
      balance: this.actualKrwBalance,
      initialBalance: this.initialBalance,
      realBalances: this.realBalances,
      position: {
        amount: pos.amount,
        entryPrice: pos.entryPrice,
        initialStopPrice: pos.initialStopPrice,
        state: pos.state,
        unrealizedPnl: (pos.amount > 0 && pos.entryPrice) ? (this.currentPrice - pos.entryPrice) * pos.amount : 0,
        unrealizedPnlPercent: (pos.amount > 0 && pos.entryPrice) ? ((this.currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0,
        trailingActive: pos.trailingActive,
        trailingPeakPrice: pos.trailingPeakPrice,
        trailingExitCount: pos.trailingExitCount || 0,
        profitLockPrice: pos.profitLockPrice || null,
        cooldownUntil: pos.cooldownUntil,
        pyramidingCount: pos.pyramidingCount,
        boxPyramidCount: pos.boxPyramidCount
      },
      boxPyramidCount: pos.boxPyramidCount,
      pyramidingCount: pos.pyramidingCount,
      // Keep the dashboard's action summary in sync with the persisted slots.
      // This is presentation data only; it does not affect order decisions.
      safetyOrderCount: pos.dcaSlots.filter((slot) => slot.status === 'FILLED' || slot.status === 'PARTIALLY_FILLED').length,
      cooldownUntil: pos.cooldownUntil,
      awaitingReentry: pos.state === 'REENTRY_ALLOWED',
      isTrailingActive: pos.trailingActive,
      trailingPeakPrice: pos.trailingPeakPrice,
      trailingExitCount: pos.trailingExitCount || 0,
      exposureLimits: exposure,
      nextOrderInfo,
      totalRealizedPnl: realizedNetPnl,
      totalFeesPaid: this.totalFeesPaid,
      dailyNetPerformance,
      totalTrades: this.totalTrades,
      winTrades: this.winTrades,
      priceHistory: this.priceHistory,
      logs: this.logs,
      maskedKeys: masked,
      hasApiKeys: {
        upbit: masked.hasUpbitKeys
      }
    };
  }

  public notifyClients() {
    if (this.broadcastCallback) {
      this.broadcastCallback(this.getFullState());
    }
  }

  public close() {
    if (this.balanceRefreshTimer) clearInterval(this.balanceRefreshTimer);
    if (this.atrRefreshTimer) clearInterval(this.atrRefreshTimer);
    this.marketManager.destroy();
  }
}
