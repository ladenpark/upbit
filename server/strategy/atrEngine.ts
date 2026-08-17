import {
  BotParams,
  TradeLog,
  PricePoint,
  BotLifecycleState,
  MarketDataState,
  ApiKeys,
  NextOrderItem
} from '../types/trading';
import { SecretManager } from '../security/secretManager';
import { MarketDataManager } from '../market/marketDataManager';
import { ATRStrategyCore } from './atrStrategyCore';
import { GlobalRiskGovernor } from '../risk/globalRiskGovernor';
import { PositionManager } from '../position/positionManager';
import { OrderManager } from '../orders/orderManager';
import { UpbitClient } from '../exchanges/upbit';
import { ApiGateway } from '../gateway/apiGateway';
import { roundDownToTick } from '../utils/priceUtils';

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

  // Bot Lifecycle State
  public botState: BotLifecycleState = 'PAUSED';

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
    dailyMaxLossPercent: 5
  };

  // Higher Timeframe (15m) Trend State for Whipsaw Filtering
  private higherTfTrend: { trend: 'BULL' | 'SIDEWAYS' | 'BEAR'; htfSlope: number } = { trend: 'SIDEWAYS', htfSlope: 0 };

  // Live Metrics
  public currentPrice = 2650000.0;
  public atrValue = 35000.0;
  public baselineValue = 2650000.0;
  public marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR' = 'SIDEWAYS';
  public totalRealizedPnl = 0;
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

  constructor(broadcastCallback?: (payload: any) => void) {
    this.broadcastCallback = broadcastCallback;
    this.secretManager = SecretManager.getInstance();
    this.upbitClient = new UpbitClient();
    this.apiGateway = ApiGateway.getInstance();

    this.strategyCore = new ATRStrategyCore();
    this.riskGovernor = new GlobalRiskGovernor(this.params);
    this.positionManager = new PositionManager(this.params);
    this.orderManager = new OrderManager(
      this.riskGovernor,
      (record, prevFilledVolume) => {
        const added = record.filledVolume - prevFilledVolume;
        console.log(`[ATREngine] 🔔 Async Order Fill update received for ${record.clientOrderId} (${record.status}): Total Filled = ${record.filledVolume} (added +${added})`);
        if (record.signalType && added > 0) {
          this.handleOrderFilled(record.signalType, record, this.currentPrice, added);
        }
      }
    );

    // Restore persisted trade logs from disk so UI doesn't reset on restart
    this.logs = PositionManager.loadTradeLogs().slice(0, 60);

    this.initDefaultHistory();

    // Fetch initial dynamic ATR from candles
    this.refreshAtrFromExchange();

    // Initialize Market Data Manager with tick dispatcher
    this.marketManager = new MarketDataManager(
      this.params.exchange,
      this.params.symbol,
      (price, ts) => this.handleMarketTick(price, ts),
      (marketState) => {
        console.log(`[ATREngine] Market Feed state changed ➡️ ${marketState}`);
        this.notifyClients();
      }
    );

    // Initial account balance load & reconciliation
    this.reconcileOnStartup();

    // Start periodic background balance sync (every 10s)
    this.balanceRefreshTimer = setInterval(() => {
      this.fetchRealAccountBalance();
    }, 10000);

    // Start periodic background ATR recalculation (every 30s)
    this.atrRefreshTimer = setInterval(() => {
      this.refreshAtrFromExchange();
    }, 30000);
  }

  public async reconcileOnStartup() {
    console.log('[ATREngine] 🔄 Starting complete startup state reconciliation...');
    try {
      const keys = this.secretManager.getKeys();
      if (keys.upbitAccessKey && keys.upbitSecretKey) {
        // 1. Reconcile Pending Orders from disk against Upbit Exchange
        await this.orderManager.reconcilePendingOrdersOnStartup(keys, 'UPBIT', this.params.symbol);

        // 2. Sync Real Account Balances
        await this.fetchRealAccountBalance();

        // 3. Query Open Orders on Exchange
        const openRes = await this.upbitClient.getOpenOrders(keys.upbitAccessKey, keys.upbitSecretKey, this.params.symbol);
        if (openRes.success && Array.isArray(openRes.orders)) {
          console.log(`[ATREngine] 📋 Exchange active open orders: ${openRes.orders.length}`);
        }

        // 4. Position reconciled automatically via fetchRealAccountBalance
        this.addLog({
          type: 'SYSTEM',
          price: this.currentPrice,
          reason: `[시스템 복구 완료] 거래소 계좌 및 공식 평단가 동기화 완료`
        });
      }
    } catch (e: any) {
      console.error('[ATREngine] Startup reconciliation error:', e.message);
    }
  }

  public setBroadcastCallback(cb: (payload: any) => void) {
    this.broadcastCallback = cb;
  }

  private initDefaultHistory() {
    const base = this.currentPrice;
    const atr = this.atrValue;
    const now = Date.now();
    const history: PricePoint[] = [];
    let tempPrice = base;

    for (let i = 35; i >= 0; i--) {
      const time = now - i * 1000;
      const noise = (Math.random() - 0.5) * (atr * 0.35);
      tempPrice = Math.max(tempPrice + noise, base * 0.8);

      const baseline = base + Math.sin(i * 0.2) * (atr * 0.4);
      const upper = baseline + atr * this.params.atrMultiplier;
      const lower = baseline - atr * this.params.atrMultiplier;
      const stop = lower - atr * this.params.stopLossMultiplier;

      const d = new Date(time);
      const timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

      history.push({
        time,
        timeLabel,
        price: Number(tempPrice.toFixed(2)),
        baseline: Number(baseline.toFixed(2)),
        upperBand: Number(upper.toFixed(2)),
        lowerBand: Number(lower.toFixed(2)),
        stopLoss: Number(stop.toFixed(2))
      });
    }

    this.priceHistory = history;
  }

  /**
   * Main Market Tick Dispatcher & Deterministic Decision Loop
   */
  public async handleMarketTick(price: number, timestamp: number) {
    this.currentPrice = price;

    // Update ATR baseline & bands
    const effectiveAtr = this.atrValue;
    const lowerBand = this.baselineValue - (effectiveAtr * this.params.atrMultiplier);
    const upperBand = this.baselineValue + (effectiveAtr * this.params.atrMultiplier);
    const staticStopPrice = this.positionManager.getSnapshot().initialStopPrice || (lowerBand - (effectiveAtr * this.params.stopLossMultiplier));

    // Update trailing state if price touches upper band
    this.positionManager.updateTrailingState(price, upperBand);

    // Calculate drop speed over explicit 5-second window
    const dropSpeed = this.marketManager.calculateDropSpeed(this.params.trendDropWindowSeconds || 5);

    // ── enableReentry trigger: DEFENSIVE/EMERGENCY_EXIT → REENTRY_ALLOWED ──
    const positionForReentry = this.positionManager.getSnapshot();
    if (
      (positionForReentry.state === 'DEFENSIVE' || positionForReentry.state === 'EMERGENCY_EXIT') &&
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

    // Build price history array for adaptive indicators
    const historyPrices = this.priceHistory.map((p) => p.price);
    historyPrices.push(price);

    // Evaluate dynamic auto-pilot indicators with Higher-TF Confluence
    const adaptive = this.strategyCore.evaluateAdaptiveParams(
      price,
      this.baselineValue,
      this.atrValue,
      this.params,
      historyPrices,
      this.higherTfTrend
    );

    if (adaptive.marketRegime !== this.marketRegime) {
      this.marketRegime = adaptive.marketRegime;
    }

    // 1. Generate Strategy Signals
    const position = this.positionManager.getSnapshot();
    const candidateSignals = this.strategyCore.generateSignals(
      price,
      this.baselineValue,
      this.atrValue,
      this.params,
      position,
      dropSpeed,
      historyPrices,
      this.higherTfTrend
    );

    // 2. Pass highest-priority signal through Global Risk Governor
    if (candidateSignals.length > 0) {
      // Sort by priority ascending (1 = Absolute Stop Loss, 2 = Emergency Cut, etc.)
      candidateSignals.sort((a, b) => a.priority - b.priority);
      const topSignal = candidateSignals[0];

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
        console.log(`[ATREngine] 🎯 Signal APPROVED by Global Risk Governor: ${topSignal.type} (${topSignal.reason})`);

        this.addLog({
          type: 'SYSTEM',
          price,
          reason: `[위험관리 승인] ${topSignal.reason} ➡️ 주문 발송 중...`
        });

        // DRY-RUN MODE: Simulate fill without touching exchange
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
          this.handleOrderFilled(topSignal.type, dryRecord, price);
        } else {
          // 3. Execute Order via OrderManager (OrderManager autonomously manages reserve/commit/release lifecycle)
          await this.orderManager.submitOrder(
            riskResult.orderRequest,
            this.secretManager.getKeys(),
            this.params.exchange,
            (record) => {
              this.handleOrderFilled(topSignal.type, record, price);
            },
            (error) => {
              this.addLog({
                type: 'SYSTEM',
                price,
                reason: `❌ [주문 실패] ${error}`
              });
            }
          );
        }
      }
    }

    // Update Price History Chart Points
    const d = new Date(timestamp);
    const timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

    this.priceHistory.push({
      time: timestamp,
      timeLabel,
      price,
      baseline: this.baselineValue,
      upperBand,
      lowerBand,
      stopLoss: staticStopPrice
    });

    if (this.priceHistory.length > 40) {
      this.priceHistory.shift();
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
    const position = this.positionManager.getSnapshot();
    // Use exchange-confirmed price if available, otherwise fall back to tick price
    const fillPrice = record.avgFillPrice > 0 ? record.avgFillPrice : tickPrice;

    const isIncremental = overrideVolume !== undefined && overrideVolume > 0;

    // Use overrideVolume (incremental added volume) if passed by watcher, otherwise full filledVolume
    const effectiveVolume = isIncremental
      ? overrideVolume!
      : (record.filledVolume > 0 ? record.filledVolume : (record.requestedBudgetOrVolume / fillPrice));

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
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'DCA_BUY') {
      if (isIncremental) {
        // Incremental DCA fill: add to current DCA slot volume without consuming a new slot
        this.positionManager.addAdditionalDcaFilled(fillPrice, effectiveVolume);
      } else {
        const nextSlot = position.dcaSlots.find((s) => s.status === 'AVAILABLE') || { slotNumber: 1 };
        this.positionManager.onDcaFilled(nextSlot.slotNumber, fillPrice, effectiveVolume);
      }
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
      this.addLog({
        type: 'BUY',
        price: fillPrice,
        amount: effectiveVolume,
        exchange: this.params.exchange,
        reason: `${record.reason} [체결: ${effectiveVolume.toFixed(6)} @ ₩${Math.round(fillPrice).toLocaleString()}]`
      });
    } else if (signalType === 'PARTIAL_LOSS_CUT') {
      const cutVolume = effectiveVolume;
      const entry = position.entryPrice || fillPrice;
      const pnl = (fillPrice - entry) * cutVolume;
      const pnlPercent = entry > 0 ? ((fillPrice - entry) / entry) * 100 : 0;

      if (isIncremental) {
        this.positionManager.addAdditionalPartialCutFilled(cutVolume, fillPrice, pnl);
        this.totalRealizedPnl += pnl;
      } else {
        this.positionManager.onPartialLossCutFilled(cutVolume, fillPrice, pnl);
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
        this.positionManager.onTrailingPartialFilled(sellVolume, fillPrice, pnl);
      }

      this.totalRealizedPnl += pnl;
      this.totalTrades += 1;
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
    } else if (
      signalType === 'ABSOLUTE_STOP_EXIT' ||
      signalType === 'EMERGENCY_FULL_EXIT'
    ) {
      const sellVolume = effectiveVolume;
      const entry = position.entryPrice || fillPrice;
      const pnl = (fillPrice - entry) * sellVolume;
      const pnlPercent = entry > 0 ? ((fillPrice - entry) / entry) * 100 : 0;

      if (record.status === 'FILLED') {
        this.positionManager.onPositionClosed(pnl, signalType);
        this.totalRealizedPnl += pnl;
        this.totalTrades += 1;
        if (pnl > 0) this.winTrades += 1;

        if (signalType === 'EMERGENCY_FULL_EXIT') {
          this.botState = 'HALTED';
          this.params.isBotActive = false;
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

    // ── Record daily loss for Circuit Breaker ──
    // Sum up total capital for threshold calculation
    const totalCap = this.actualKrwBalance + (this.positionManager.getSnapshot().amount * this.currentPrice);
    if (this.totalRealizedPnl < 0) {
      // Only track realized losses (positive lossAmount = how much was lost)
      // We pass the absolute loss from this specific trade, not the cumulative
    }
    // Check if this specific fill was a losing sell
    if (
      signalType !== 'ENTRY_BUY' && signalType !== 'BREAKOUT_BUY' &&
      signalType !== 'DCA_BUY' && signalType !== 'PYRAMID_BUY' && signalType !== 'REENTRY_BUY'
    ) {
      const entry = position.entryPrice || fillPrice;
      const thisTradePnl = (fillPrice - entry) * effectiveVolume;
      if (thisTradePnl < 0) {
        const { circuitBroken } = this.riskGovernor.recordDailyLoss(Math.abs(thisTradePnl), totalCap);
        if (circuitBroken) {
          this.botState = 'HALTED';
          this.params.isBotActive = false;
          this.addLog({
            type: 'SYSTEM',
            price: fillPrice,
            reason: `🚨 [서킷 브레이커] 일일 최대 손실 한도(${this.params.dailyMaxLossPercent || 5}%) 초과 — 봇 자동 정지`
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

  /**
   * Authoritative real-time ATR & Baseline recalculation from Upbit candle history
   * and Multi-Timeframe (15m) Trend Analysis for Whipsaw Filtering
   */
  public async refreshAtrFromExchange() {
    try {
      // 1. Fetch 1-minute candles for immediate ATR & Baseline calculation
      const candles = await this.upbitClient.fetchCandles(this.params.symbol, 20, 'minutes/1');
      if (candles && candles.length >= 14) {
        let trSum = 0;
        for (let i = 1; i < candles.length; i++) {
          const prevClose = candles[i - 1].trade_price;
          const high = candles[i].high_price;
          const low = candles[i].low_price;
          const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
          trSum += tr;
        }
        const calculatedAtr = Math.round(trSum / (candles.length - 1));
        if (calculatedAtr > 0) {
          this.atrValue = calculatedAtr;
          const sumClose = candles.reduce((acc, c) => acc + c.trade_price, 0);
          this.baselineValue = Math.round(sumClose / candles.length);
          console.log(`[ATREngine] 📊 Recalculated Dynamic ATR (1m): ₩${this.atrValue.toLocaleString()} (Baseline: ₩${this.baselineValue.toLocaleString()})`);
        }
      }

      // 2. Fetch 15-minute candles for Higher Timeframe trend confluence
      const htfCandles = await this.upbitClient.fetchCandles(this.params.symbol, 20, 'minutes/15');
      if (htfCandles && htfCandles.length >= 10) {
        const htfCloses = htfCandles.map((c) => c.trade_price);
        const fastHtf = htfCloses.slice(-3).reduce((a, b) => a + b, 0) / 3;
        const slowHtf = htfCloses.slice(-10).reduce((a, b) => a + b, 0) / 10;
        const htfSlope = ((fastHtf - slowHtf) / slowHtf) * 100;
        let htfTrend: 'BULL' | 'SIDEWAYS' | 'BEAR' = 'SIDEWAYS';
        if (htfSlope > 0.15) htfTrend = 'BULL';
        else if (htfSlope < -0.15) htfTrend = 'BEAR';
        this.higherTfTrend = { trend: htfTrend, htfSlope };
        console.log(`[ATREngine] 📈 Higher-TF (15m) Trend Confluence: ${htfTrend} (Slope: ${htfSlope.toFixed(2)}%)`);
      }

      this.notifyClients();
    } catch (e: any) {
      console.warn('[ATREngine] ⚠️ ATR calculation fallback notice:', e.message);
    }
  }

  /**
   * Manual Buy / Sell Dispatcher
   */
  public async executeManualTrade(side: 'BUY' | 'SELL') {
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
      let targetBudget = exposure.totalCapitalKrw * ((this.params.orderRatio || 25) / 100);

      if (isAdditional) {
        const nextSlot = position.dcaSlots.find((s) => s.status === 'AVAILABLE');
        const scale = Math.pow(this.params.safetyOrderVolumeScale, nextSlot ? nextSlot.slotNumber : 1);
        targetBudget *= scale;
      }

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

      const signalType = isAdditional ? 'DCA_BUY' : 'ENTRY_BUY';
      const req = {
        clientOrderId: `ORD_MANUAL_${signalType}_${Date.now()}`,
        signalId: `SIG_MANUAL_${Date.now()}`,
        symbol: this.params.symbol,
        side: 'BUY' as const,
        requestedAmountKrw: budget,
        reason: `[수동 매수] 사용자 직접 매수 (${isAdditional ? '추가 매수' : '1차 진입'}, ₩${budget.toLocaleString()})`,
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
      const req = {
        clientOrderId: `ORD_MANUAL_SELL_${Date.now()}`,
        signalId: `SIG_MANUAL_${Date.now()}`,
        symbol: this.params.symbol,
        side: 'SELL' as const,
        requestedVolume: position.amount,
        limitPrice: roundDownToTick(this.currentPrice * 0.985),
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

  /**
   * Authoritative balance fetch & reconciliation with exchange
   */
  public async fetchRealAccountBalance() {
    try {
      const keys = this.secretManager.getKeys();
      if (this.params.exchange === 'UPBIT' && keys.upbitAccessKey && keys.upbitSecretKey) {
        const res = await this.apiGateway.enqueue(3, async () => {
          return await this.upbitClient.getAccountBalance(keys.upbitAccessKey!, keys.upbitSecretKey!);
        });

        if (res.success && res.balances) {
          this.realBalances = res.balances;
          const krw = this.realBalances['KRW'] || 0;
          this.actualKrwBalance = krw;
          const coinKey = this.params.symbol.replace('KRW-', '');
          const realCoinQty = this.realBalances[coinKey] || 0;
          const authoritativeAvgPrice = res.avgBuyPrices ? res.avgBuyPrices[coinKey] : null;

          // Reconcile position state with actual coin quantity and exchange authoritative avg buy price
          this.positionManager.reconcileWithExchange(realCoinQty, authoritativeAvgPrice, this.currentPrice);

          if (this.initialBalance === 0 && (krw > 0 || realCoinQty > 0)) {
            this.initialBalance = krw + (realCoinQty * this.currentPrice);
          }
        }
      }
      this.notifyClients();
    } catch (e) {}
  }

  public updateParams(newParams: Partial<BotParams>) {
    const symbolChanged = newParams.symbol && newParams.symbol !== this.params.symbol;
    const exchangeChanged = newParams.exchange && newParams.exchange !== this.params.exchange;

    this.params = { ...this.params, ...newParams };
    this.riskGovernor.setParams(this.params);
    this.positionManager.setParams(this.params);

    if (newParams.isBotActive !== undefined) {
      this.botState = newParams.isBotActive ? 'RUNNING' : 'PAUSED';
      this.addLog({
        type: 'SYSTEM',
        price: this.currentPrice,
        reason: `[봇 상태 전환] ➡️ ${this.botState}`
      });
    }

    if (symbolChanged || exchangeChanged) {
      this.marketManager.setSymbol(this.params.exchange, this.params.symbol);
      this.refreshAtrFromExchange();
      this.fetchRealAccountBalance();
    }

    this.notifyClients();
  }

  public setApiKeys(keys: ApiKeys) {
    this.secretManager.saveKeys(keys);
    this.orderManager.setApiKeysForWatcher(keys);
    this.fetchRealAccountBalance();
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
    if (this.logs.length > 60) this.logs.pop();

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
   * Full Snapshot for WebSocket Client UI Synchronization
   */
  public getFullState() {
    const pos = this.positionManager.getSnapshot();
    const masked = this.secretManager.getMaskedStatus();
    const exposure = this.riskGovernor.calculateExposureLimits(
      this.actualKrwBalance,
      pos.amount,
      this.currentPrice,
      0
    );

    // Calculate Next Order Info Pages for UI Swipeable Card
    const pages: NextOrderItem[] = [];
    const baseUnitBudget = exposure.totalCapitalKrw * ((this.params.orderRatio || 25) / 100);

    if (pos.amount > 0 && pos.state !== 'FLAT') {
      const entry = pos.entryPrice || this.currentPrice;

      // Page 1: DCA 물타기 (하락 시 대응)
      const nextDcaSlot = pos.dcaSlots.find((s) => s.status === 'AVAILABLE');
      if (this.params.dcaEnabled && nextDcaSlot) {
        const dcaScale = Number(Math.pow(this.params.safetyOrderVolumeScale, nextDcaSlot.slotNumber).toFixed(2));
        const dcaBudgetRaw = baseUnitBudget * dcaScale;
        const dcaBudget = Math.floor(Math.min(dcaBudgetRaw, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
        const targetDcaPrice = entry * (1 - (this.params.safetyOrderStepPercent * nextDcaSlot.slotNumber) / 100);
        pages.push({
          category: 'DCA',
          categoryLabel: '하락 시 물타기',
          type: `DCA #${nextDcaSlot.slotNumber}차 물타기`,
          budgetKrw: dcaBudget,
          unitPercent: this.params.orderRatio || 25,
          scaleMultiplier: dcaScale,
          targetPriceLabel: `₩${Math.round(targetDcaPrice).toLocaleString()} (-${(this.params.safetyOrderStepPercent * nextDcaSlot.slotNumber).toFixed(1)}% 하락 시)`,
          themeColor: 'indigo'
        });
      } else {
        pages.push({
          category: 'COMPLETED',
          categoryLabel: '물타기 완료',
          type: 'DCA 슬롯 소진',
          budgetKrw: 0,
          unitPercent: this.params.orderRatio || 25,
          scaleMultiplier: 0,
          targetPriceLabel: '최대 물타기 완료 (손절선 감시)',
          themeColor: 'indigo'
        });
      }

      // Page 2: 불타기 (상승 시 대응)
      if (this.params.pyramidingEnabled && pos.pyramidingCount < this.params.maxPyramidingOrders) {
        const pyrBudget = Math.floor(Math.min(baseUnitBudget, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
        const nextPyrStep = (pos.pyramidingCount + 1);
        const targetPyrPrice = entry * (1 + (this.params.pyramidingStepPercent * nextPyrStep) / 100);
        pages.push({
          category: 'PYRAMID',
          categoryLabel: '상승 시 불타기',
          type: `상승 불타기 #${nextPyrStep}차`,
          budgetKrw: pyrBudget,
          unitPercent: this.params.orderRatio || 25,
          scaleMultiplier: 1.0,
          targetPriceLabel: `₩${Math.round(targetPyrPrice).toLocaleString()} (+${(this.params.pyramidingStepPercent * nextPyrStep).toFixed(1)}% 상승 시)`,
          themeColor: 'amber'
        });
      } else {
        pages.push({
          category: 'COMPLETED',
          categoryLabel: '불타기 완료',
          type: '불타기 한도 소진',
          budgetKrw: 0,
          unitPercent: this.params.orderRatio || 25,
          scaleMultiplier: 0,
          targetPriceLabel: '최고점 트레일링 익절 대기 중',
          themeColor: 'amber'
        });
      }
    } else {
      // 무포지션 FLAT 상태일 때:
      const entryBudget = Math.floor(Math.min(baseUnitBudget, this.actualKrwBalance * 0.98, exposure.remainingAllowableExposureKrw));
      const lowerBandCalc = this.baselineValue - (this.atrValue * this.params.atrMultiplier);
      const lowerTarget = Math.round(lowerBandCalc > 0 ? lowerBandCalc : this.currentPrice * 0.98);

      // Page 1: 저점 눌림목 진입
      pages.push({
        category: 'DIP',
        categoryLabel: '저점 눌림목 매수',
        type: '1차 저점 진입 (1 Unit)',
        budgetKrw: entryBudget,
        unitPercent: this.params.orderRatio || 25,
        scaleMultiplier: 1.0,
        targetPriceLabel: `하단 ₩${lowerTarget.toLocaleString()} 이하 터치 시`,
        themeColor: 'blue'
      });

      // Page 2: 상승 돌파 진입
      pages.push({
        category: 'BREAKOUT',
        categoryLabel: '상승 추세 돌파 매수',
        type: '1차 돌파 진입 (1 Unit)',
        budgetKrw: entryBudget,
        unitPercent: this.params.orderRatio || 25,
        scaleMultiplier: 1.0,
        targetPriceLabel: `기준선(₩${Math.round(this.baselineValue).toLocaleString()}) 상향 돌파 시`,
        themeColor: 'emerald'
      });
    }

    const nextOrderInfo = {
      type: pages[0]?.type || '1차 신규 진입',
      budgetKrw: pages[0]?.budgetKrw || 0,
      unitPercent: this.params.orderRatio || 25,
      scaleMultiplier: pages[0]?.scaleMultiplier || 1.0,
      targetPriceLabel: pages[0]?.targetPriceLabel || '',
      pages
    };

    return {
      params: this.params,
      botState: this.botState,
      marketState: this.marketManager ? this.marketManager.marketState : 'DISCONNECTED',
      marketRegime: this.marketRegime,
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
        cooldownUntil: pos.cooldownUntil
      },
      exposureLimits: exposure,
      nextOrderInfo,
      totalRealizedPnl: this.totalRealizedPnl,
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
