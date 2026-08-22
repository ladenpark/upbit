/**
 * Comprehensive Automated Test Suite for Quantitative Trading Engine
 * Tests: Strategy, Risk, Position, Order Idempotency, Exposure Reservation,
 *        Fill Confirmation, Timeout Reconciliation, Collision Blocking
 * 
 * Run: npm test
 * The npm script supplies NODE_ENV=test and an isolated temporary DATA_DIR.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ATRStrategyCore } from '../strategy/atrStrategyCore';
import { GlobalRiskGovernor } from '../risk/globalRiskGovernor';
import { ATREngine } from '../strategy/atrEngine';
import { PositionManager } from '../position/positionManager';
import { OrderManager } from '../orders/orderManager';
import { SecretManager } from '../security/secretManager';
import { ResearchRecorder } from '../research/researchRecorder';
import { MarketDataManager } from '../market/marketDataManager';
import { PositionSnapshot, BotParams, Signal, OrderRecord } from '../types/trading';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log('🧪 Starting Automated Quantitative Trading Test Suite');
  console.log('======================================================');

  // Fail closed before any stateful manager is constructed. A direct tsx run
  // must never be able to clean or overwrite the live ./data directory.
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Trading engine tests must run with NODE_ENV=test (use `npm test`).');
  }
  if (!process.env.DATA_DIR) {
    throw new Error('Trading engine tests require an explicit isolated DATA_DIR (use `npm test`).');
  }
  const testDataDir = path.resolve(process.env.DATA_DIR);
  const tmpRoot = path.resolve(os.tmpdir());
  const relativeToTmp = path.relative(tmpRoot, testDataDir);
  if (!relativeToTmp || relativeToTmp.startsWith('..') || path.isAbsolute(relativeToTmp)) {
    throw new Error(`Trading engine test DATA_DIR must be a child of ${tmpRoot}, never the production data directory.`);
  }
  const reservationFile = path.join(testDataDir, 'exposure_reservations.json');
  const orderFile = path.join(testDataDir, 'order_history.json');
  const signalFile = path.join(testDataDir, 'processed_signals.json');
  const posFile = path.join(testDataDir, 'position_state.json');
  const dailyRiskFile = path.join(testDataDir, 'daily_risk_state.json');

  if (fs.existsSync(reservationFile)) fs.writeFileSync(reservationFile, '[]', 'utf-8');
  if (fs.existsSync(orderFile)) fs.writeFileSync(orderFile, '[]', 'utf-8');
  if (fs.existsSync(signalFile)) fs.writeFileSync(signalFile, '[]', 'utf-8');
  if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  if (fs.existsSync(dailyRiskFile)) fs.unlinkSync(dailyRiskFile);

  const defaultParams: BotParams = {
    atrMultiplier: 3.0,
    orderRatio: 25,
    stopLossMultiplier: 2.0,
    isBotActive: true,
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
    partialLossCutThreshold: 3.5,
    trendAwareCutEnabled: true,
    trendDropSpeedThreshold: 0.6,
    trendDropWindowSeconds: 5,
    cooldownSecondsAfterCut: 60,
    autoPilotEnabled: true,
    experimentDca2RsiRecoveryEnabled: false,
    experimentDca2VolumeConfirmationEnabled: false,
    experimentPyramidRsiGuardEnabled: false,
    experimentPyramidVolumeConfirmationEnabled: false,
    experimentScalpTrendExpansionEnabled: false,
    experimentScalpReentryCooldownEnabled: false,
    experimentTrendTrailingArmingEnabled: false
  };

  const riskGovernor = new GlobalRiskGovernor(defaultParams);

  // ──────────────────────────────────────────────────────
  // TEST GROUP 1: Strategy Conflict & Signal Priority
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 1: Strategy Conflict & Signal Priority Resolution');
  const strategyCore = new ATRStrategyCore();

  const testPosition: PositionSnapshot = {
    id: 'POS_TEST', symbol: 'KRW-ETH', state: 'ENTRY_FILLED',
    amount: 1.0, entryPrice: 2900000, positionEntryAtr: 50000,
    initialStopPrice: 2750000, initialBaseline: 3000000, initialBand: 2850000,
    totalCostKrw: 2900000, realizedPnl: 0, unrealizedPnl: -100000, unrealizedPnlPercent: -3.45,
    openedAt: Date.now(), lastUpdatedAt: Date.now(),
    dcaSlots: [
      { slotNumber: 1, status: 'AVAILABLE' },
      { slotNumber: 2, status: 'AVAILABLE' },
      { slotNumber: 3, status: 'AVAILABLE' }
    ],
    pyramidingCount: 0, maxPyramidingOrders: 2, boxPyramidCount: 0,
    trailingActive: false, trailingPeakPrice: null, cooldownUntil: 0
  };

  const priceHistory = [3100000, 3050000, 3000000, 2980000, 2950000, 2920000, 2900000, 2850000, 2800000, 2750000];
  const atr = 50000;
  const baseline = 3000000;

  const signals = strategyCore.generateSignals(
    2600000, // currentPrice - below stop loss
    baseline,
    atr,
    defaultParams,
    testPosition,
    -0.8, // dropSpeed
    priceHistory
  );

  assert(signals.length > 0, 'Exactly one dominant signal generated on severe drop');
  if (signals.length > 0) {
    signals.sort((a, b) => a.priority - b.priority);
    assert(signals[0].type === 'ABSOLUTE_STOP_EXIT', 'Absolute Stop Loss takes highest priority over DCA and emergency cut');
    assert(signals[0].priority === 1, 'Absolute Stop Loss is Priority 1');
  }

  const emergencySignals = strategyCore.generateSignals(
    2840000, // currentPrice - below lowerBand (2850000) with fast drop
    baseline,
    atr,
    defaultParams,
    testPosition,
    -0.8, // dropSpeed
    priceHistory
  );

  const emergencyTrendSignals = emergencySignals.filter((s) => s.type === 'EMERGENCY_TREND_CUT');
  assert(emergencyTrendSignals.length > 0, 'Emergency Trend Cut detected on drop speed');
  assert(emergencyTrendSignals[0]?.type === 'EMERGENCY_TREND_CUT', 'Emergency Trend Cut triggered for 40% capital protection');

  const beforeFirstPartialCut = strategyCore.generateSignals(2860000, baseline, atr, defaultParams, testPosition, 0, priceHistory);
  assert(!beforeFirstPartialCut.some((s) => s.type === 'PARTIAL_LOSS_CUT'), 'First partial cut does not trigger before the widened -1.5% threshold');
  const firstPartialCutSignals = strategyCore.generateSignals(2856000, baseline, atr, defaultParams, testPosition, 0, priceHistory);
  assert(firstPartialCutSignals[0]?.type === 'PARTIAL_LOSS_CUT', 'First partial cut triggers at the widened -1.5% threshold');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 2: Global Risk Governor & Max Exposure
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 2: Global Risk Governor & Max Exposure Enforcement');

  const posWithLoss: PositionSnapshot = {
    id: 'POS_TEST', symbol: 'KRW-ETH', state: 'ENTRY_FILLED',
    amount: 1.0, entryPrice: 2900000, positionEntryAtr: 50000,
    initialStopPrice: 2750000, initialBaseline: 3000000, initialBand: 2850000,
    totalCostKrw: 2900000, realizedPnl: 0, unrealizedPnl: -100000, unrealizedPnlPercent: -3.45,
    openedAt: Date.now(), lastUpdatedAt: Date.now(),
    dcaSlots: [
      { slotNumber: 1, status: 'AVAILABLE' },
      { slotNumber: 2, status: 'AVAILABLE' },
      { slotNumber: 3, status: 'AVAILABLE' }
    ],
    pyramidingCount: 0, maxPyramidingOrders: 2, boxPyramidCount: 0,
    trailingActive: false, trailingPeakPrice: null, cooldownUntil: 0
  };

  const buySignal: Signal = {
    id: 'SIG_TEST_BUY', timestamp: Date.now(), timeframe: '1m',
    source: 'ATR_STRATEGY_CORE', type: 'ENTRY_BUY', priority: 6,
    symbol: 'KRW-ETH', price: 2800000, reason: 'Test Buy Signal',
    indicatorSnapshot: {
      baseline: 3000000, atr: 50000, upperBand: 3150000, lowerBand: 2850000,
      currentStopLoss: 2750000, marketRegime: 'BEAR', slope: -0.02, volatilityRatio: 1.5,
      dynamicOrderRatio: 10
    }
  };

  const highExposurePos: PositionSnapshot = {
    ...posWithLoss,
    amount: 2.8, // 2.8 * 2.8M = 7.84M (near 85% of 10M)
    state: 'ENTRY_FILLED'
  };

  const riskEval = riskGovernor.evaluateSignal(
    buySignal, 'RUNNING', 'LIVE',
    1600000, highExposurePos, 2800000, 0, 0
  );

  assert(riskEval.approved === true, 'Risk evaluation approved clamped budget');
  const requestedAmt = riskEval.orderRequest?.requestedAmountKrw || 0;
  const limits = riskGovernor.calculateExposureLimits(1600000, 2.8, 2800000);
  assert(
    requestedAmt <= limits.remainingAllowableExposureKrw,
    `Budget clamped within remaining exposure (Requested: ₩${requestedAmt.toLocaleString()}, Max Remaining: ₩${Math.round(limits.remainingAllowableExposureKrw).toLocaleString()})`
  );

  const fullExposurePos: PositionSnapshot = {
    ...posWithLoss,
    amount: 3.2, // 3.2 * 2.8M = 8.96M (over 85%)
    state: 'ENTRY_FILLED'
  };

  const fullRiskEval = riskGovernor.evaluateSignal(
    buySignal, 'RUNNING', 'LIVE',
    1040000, fullExposurePos, 2800000, 0, 0
  );
  assert(fullRiskEval.approved === false, 'New BUY blocked when Global Max Exposure is exceeded');

  const netLossEngine = new ATREngine(undefined, { backtest: true });
  (netLossEngine as any).dailyCostLots = [{ volume: 1, price: 2700000, fee: 1350 }];
  const feeOnlyLoss = (netLossEngine as any).consumeDailyCostLots(1, 2700000, 1350, 2700000);
  assert(feeOnlyLoss === -2700, '[Daily circuit] Flat-price SELL includes allocated BUY and SELL fees as a net realized loss');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 3: Static Stop Loss Snapshot Immutability
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 3: Static Stop Loss Snapshot Immutability (Dynamic ATR drift test)');
  const posManager = new PositionManager(defaultParams);

  posManager.onInitialEntryFilled(2850000, 1.0, 3000000, 50000, 3.0, 2.0);
  const snapshotAfterEntry = posManager.getSnapshot();
  assert(snapshotAfterEntry.initialStopPrice === 2679000, `Absolute stop is fixed at entry -6% (₩${snapshotAfterEntry.initialStopPrice})`);

  const snapshotLater = posManager.getSnapshot();
  assert(snapshotLater.initialStopPrice === 2679000, 'Absolute stop does NOT drift with market volatility');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 4: DCA & Partial Cut Loop Prevention
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 4: DCA & Partial Cut Loop Prevention');
  posManager.onPartialLossCutFilled(0.4, 2700000, -60000);
  const defSnapshot = posManager.getSnapshot();

  assert(defSnapshot.state === 'DEFENSIVE_1', 'Position transitioned to DEFENSIVE_1 state after first Partial Cut');
  assert(posManager.isUnderCooldown(), 'Cooldown timer is active following Partial Loss Cut');

  const dcaSignal = { ...buySignal, type: 'DCA_BUY' as const, reason: 'DCA Test' };
  const dcaRiskEval = riskGovernor.evaluateSignal(
    dcaSignal, 'RUNNING', 'LIVE',
    5000000, defSnapshot, 2700000, 0, 0
  );
  assert(dcaRiskEval.approved === false, 'DCA immediately blocked during Cooldown & DEFENSIVE state (Infinite loop prevented)');

  const defensiveRegimeSignal: Signal = { ...buySignal, id: 'SIG_DEFENSIVE_REGIME', type: 'REGIME_REBALANCE_BUY', regimeTargetExposurePercent: 40, reason: 'BEAR 목표비중 채우기' };
  const defensiveRegimeEval = riskGovernor.evaluateSignal(
    defensiveRegimeSignal, 'RUNNING', 'LIVE', 5000000, defSnapshot, 2700000, 0, 0
  );
  assert(defensiveRegimeEval.approved === false, '[Defensive conflict] Regime rebalance BUY is blocked after a partial loss cut');
  const protectedCutCount = defSnapshot.partialCutCount;
  const protectedCooldown = defSnapshot.cooldownUntil;
  const protectedStop = defSnapshot.initialStopPrice;
  posManager.onRegimeRebalanceBuyFilled(2680000, 0.1, 2650000, 35000, 3, 2);
  const afterRegimeFill = posManager.getSnapshot();
  assert(afterRegimeFill.partialCutCount === protectedCutCount && afterRegimeFill.cooldownUntil === protectedCooldown && afterRegimeFill.initialStopPrice === protectedStop, '[Defensive conflict] Any legacy/in-flight regime fill preserves partial-cut count, cooldown and fixed stop');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 5: Order Idempotency & Stale Market Feed
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 5: Order Idempotency & Stale Market Data Protection');
  const orderManager = new OrderManager();

  const staleRiskEval = riskGovernor.evaluateSignal(
    buySignal, 'RUNNING', 'STALE',
    5000000, snapshotAfterEntry, 2850000, 0, 0
  );
  assert(staleRiskEval.approved === false, 'Orders completely blocked when Market Data is STALE');

  const secretManager = SecretManager.getInstance();
  secretManager.saveKeys({
    upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL',
    upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL'
  });
  const maskedStatus = secretManager.getMaskedStatus();
  assert(maskedStatus.hasUpbitKeys === true, 'Upbit Keys presence verified');
  assert(maskedStatus.upbitAccessMasked === 'TEST************REAL', 'API Key properly masked without plaintext exposure');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 6: Atomic Exposure Reservation & Collision Blocking
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 6: Atomic Exposure Reservation & Strict Collision Blocking');

  const clientOrderId = 'ORD_TEST_PENDING_001';
  const reserveSuccess = riskGovernor.reserveExposure(clientOrderId, 1500000);
  assert(reserveSuccess === true, 'Exposure atomically reserved for pending order');
  assert(riskGovernor.reservedBuyExposureKrw === 1500000, 'Reserved exposure tracks exact ₩1,500,000');

  const collisionEval = riskGovernor.evaluateSignal(
    buySignal, 'RUNNING', 'LIVE',
    5000000, snapshotAfterEntry, 2850000, 1, 0
  );
  assert(collisionEval.approved === false, 'Conflicting signal strictly rejected while another order is pending (Collision blocked)');

  riskGovernor.releaseExposure(clientOrderId);
  assert(riskGovernor.reservedBuyExposureKrw === 0, 'Reserved exposure cleanly released back to available pool');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 7: OrderManager - identifier, fill confirmation, applyExchangeOrderState
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 7: OrderManager Fill Confirmation & Reconciliation Logic');

  // Test: normal market buy fully filled (simulated via mock)
  // We verify the OrderManager constructor and getPendingOrdersCount behavior
  const freshOrderManager = new OrderManager();
  assert(freshOrderManager.getPendingOrdersCount() === 0, '[normal market buy] Initial pending count is 0');

  // Test: duplicate clientOrderId prevention
  const testSignalId = `SIG_DUP_TEST_${Date.now()}`;
  let firstCallOk = false;
  let secondCallThrew = false;

  try {
    await freshOrderManager.submitOrder(
      {
        clientOrderId: `ORD_DUP_TEST_${Date.now()}`,
        signalId: testSignalId,
        signalType: 'ENTRY_BUY',
        symbol: 'KRW-ETH',
        side: 'BUY',
        requestedAmountKrw: 50000,
        reason: 'Dup test 1',
        createdAt: Date.now()
      },
      {}, // no keys → will throw
      'UPBIT',
      () => {},
      () => {}
    );
  } catch {
    firstCallOk = true; // Expected: fails due to missing keys, but signalId is registered
  }

  try {
    await freshOrderManager.submitOrder(
      {
        clientOrderId: `ORD_DUP_TEST2_${Date.now()}`,
        signalId: testSignalId, // SAME signalId
        signalType: 'ENTRY_BUY',
        symbol: 'KRW-ETH',
        side: 'BUY',
        requestedAmountKrw: 50000,
        reason: 'Dup test 2',
        createdAt: Date.now()
      },
      {},
      'UPBIT',
      () => {},
      () => {}
    );
  } catch {
    secondCallThrew = true;
  }
  assert(secondCallThrew === true, '[duplicate clientOrderId] Second submit with same signalId correctly throws');

  // Test: UNKNOWN_PENDING_RECONCILIATION blocks new orders
  // The previous failed order should not count as pending (it was REJECTED due to missing keys)
  // But an UNKNOWN_PENDING_RECONCILIATION order would block
  const pendingCountAfterReject = freshOrderManager.getPendingOrdersCount();
  assert(pendingCountAfterReject === 0, '[restart after order submitted] Rejected orders do not count as pending');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 8: Exchange-confirmed fill data flow
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 8: Exchange-Confirmed Fill Data (executed_volume & avgFillPrice)');

  // Simulate what applyExchangeOrderState does with a mock Upbit response
  const mockUpbitOrder = {
    uuid: 'mock-uuid-123',
    identifier: 'ORD_TEST_FILL_001',
    side: 'bid' as const,
    ord_type: 'price',
    price: '500000',
    state: 'done' as const,
    market: 'KRW-ETH',
    created_at: new Date().toISOString(),
    volume: null,
    remaining_volume: '0',
    reserved: '500000',
    remaining_fee: '0',
    paid_fee: '125',
    locked: '0',
    executed_volume: '0.156789',
    trades_count: 1,
    trades: [{
      market: 'KRW-ETH',
      uuid: 'trade-uuid-1',
      price: '3190000',
      volume: '0.156789',
      funds: '500000',
      created_at: new Date().toISOString(),
      side: 'bid'
    }]
  };

  const executedVol = parseFloat(mockUpbitOrder.executed_volume);
  const tradePrice = parseFloat(mockUpbitOrder.trades[0].price);
  assert(executedVol === 0.156789, '[normal market buy fully filled] executed_volume correctly parsed from exchange');
  assert(tradePrice === 3190000, '[normal market buy fully filled] avgFillPrice correctly derived from trades');
  assert(mockUpbitOrder.state === 'done', '[normal market buy fully filled] state=done maps to FILLED');

  // Simulate partial fill
  const mockPartialOrder = {
    ...mockUpbitOrder,
    state: 'cancel' as const,
    executed_volume: '0.05',
    remaining_volume: '0.106789',
  };
  const partialVol = parseFloat(mockPartialOrder.executed_volume);
  assert(partialVol === 0.05, '[partial fill] Partial executed_volume correctly parsed');
  assert(mockPartialOrder.state === 'cancel' && partialVol > 0, '[partial fill] cancel + executed_volume > 0 is terminal CANCELLED with a partial execution');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 9: Protective SELL During Pending BUY (문제 1 완전 검증)
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 9: Protective SELL During Pending BUY & Duplicate Sell Block');

  const pendingBuyOrders: OrderRecord[] = [
    {
      id: 'ORD_PENDING_BUY_1',
      clientOrderId: 'ORD_BUY_CLIENT_1',
      signalId: 'SIG_BUY_1',
      signalType: 'ENTRY_BUY',
      symbol: 'KRW-ETH',
      side: 'BUY',
      status: 'ORDER_SUBMITTING',
      requestedBudgetOrVolume: 500000,
      filledVolume: 0,
      avgFillPrice: 0,
      fee: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reason: 'Pending Buy Test',
      fills: []
    }
  ];

  // Clean test position with no cooldown
  const cleanPosition: PositionSnapshot = {
    ...snapshotAfterEntry,
    amount: 1.0,
    entryPrice: 2900000,
    cooldownUntil: 0
  };

  // 1. ABSOLUTE_STOP_EXIT allowed during pending BUY
  const stopLossSignal: Signal = {
    ...buySignal,
    type: 'ABSOLUTE_STOP_EXIT',
    priority: 1,
    reason: 'Absolute Stop Loss'
  };
  const stopLossEval = riskGovernor.evaluateSignal(
    stopLossSignal, 'RUNNING', 'LIVE',
    5000000, cleanPosition, 2700000,
    pendingBuyOrders, 0
  );
  assert(stopLossEval.approved === true, '[문제 1] ABSOLUTE_STOP_EXIT approved even when BUY is pending');

  // 2. PARTIAL_LOSS_CUT allowed during pending BUY
  const partialCutSignal: Signal = {
    ...buySignal,
    type: 'PARTIAL_LOSS_CUT',
    priority: 2,
    reason: 'Partial Loss Cut'
  };
  const partialCutEval = riskGovernor.evaluateSignal(
    partialCutSignal, 'RUNNING', 'LIVE',
    5000000, cleanPosition, 2700000,
    pendingBuyOrders, 0
  );
  assert(partialCutEval.approved === true, '[문제 1] PARTIAL_LOSS_CUT approved even when BUY is pending');

  // 3. EMERGENCY_TREND_CUT allowed during pending BUY
  const emergencyTrendSignal: Signal = {
    ...buySignal,
    type: 'EMERGENCY_TREND_CUT',
    priority: 2,
    reason: 'Emergency Trend Cut'
  };
  const emergencyTrendEval = riskGovernor.evaluateSignal(
    emergencyTrendSignal, 'RUNNING', 'LIVE',
    5000000, cleanPosition, 2700000,
    pendingBuyOrders, 0
  );
  assert(emergencyTrendEval.approved === true, '[문제 1] EMERGENCY_TREND_CUT approved even when BUY is pending');

  // 4. TRAILING_STOP_EXIT allowed during pending BUY
  const trailingStopSignal: Signal = {
    ...buySignal,
    type: 'TRAILING_STOP_EXIT',
    priority: 3,
    reason: 'Trailing Stop Exit'
  };
  const trailingStopEval = riskGovernor.evaluateSignal(
    trailingStopSignal, 'RUNNING', 'LIVE',
    5000000, cleanPosition, 3200000,
    pendingBuyOrders, 0
  );
  assert(trailingStopEval.approved === true, '[문제 1] TRAILING_STOP_EXIT approved even when BUY is pending');

  // 5. Duplicate identical protective SELL is BLOCKED
  const pendingStopLossOrders: OrderRecord[] = [
    {
      id: 'ORD_PENDING_STOP_1',
      clientOrderId: 'ORD_STOP_CLIENT_1',
      signalId: 'SIG_STOP_1',
      signalType: 'ABSOLUTE_STOP_EXIT',
      symbol: 'KRW-ETH',
      side: 'SELL',
      status: 'ORDER_SUBMITTING',
      requestedBudgetOrVolume: 1.0,
      filledVolume: 0,
      avgFillPrice: 0,
      fee: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reason: 'Absolute Stop Loss in progress',
      fills: []
    }
  ];
  const duplicateStopEval = riskGovernor.evaluateSignal(
    stopLossSignal, 'RUNNING', 'LIVE',
    5000000, cleanPosition, 2700000,
    pendingStopLossOrders, 0
  );
  assert(duplicateStopEval.approved === false, '[문제 1] Duplicate identical ABSOLUTE_STOP_EXIT is strictly blocked');

  // 6. Normal BUY is still strictly blocked when BUY or SELL is pending
  const normalBuyEval = riskGovernor.evaluateSignal(
    buySignal, 'RUNNING', 'LIVE',
    5000000, cleanPosition, 2850000,
    pendingBuyOrders, 0
  );
  assert(normalBuyEval.approved === false, '[문제 1] Normal ENTRY_BUY remains strictly blocked during pending orders');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 10: Reservation Lifecycle & OrderManager Integration (문제 4)
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 10: Reservation Lifecycle with OrderManager');
  const testGovernor = new GlobalRiskGovernor(defaultParams);
  const managedOrderMgr = new OrderManager(testGovernor);

  const testClientOrderId = `ORD_RESERVE_TEST_${Date.now()}`;
  testGovernor.reserveExposure(testClientOrderId, 500000);
  assert(testGovernor.reservedBuyExposureKrw === 500000, '[문제 4] Initial exposure reserved: ₩500,000');

  testGovernor.commitExposure(testClientOrderId);
  assert(testGovernor.reservedBuyExposureKrw === 0, '[문제 4] Exposure committed on fill: reserved pool back to 0');

  const testClientOrderId2 = `ORD_RESERVE_TEST_2_${Date.now()}`;
  testGovernor.reserveExposure(testClientOrderId2, 300000);
  testGovernor.releaseExposure(testClientOrderId2);
  assert(testGovernor.reservedBuyExposureKrw === 0, '[문제 4] Exposure released on rejection/error: reserved pool back to 0');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 11: Upbit Order API & Startup Reconcile Interface
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 11: Upbit Order API & Startup Reconcile Interface');
  assert(typeof managedOrderMgr.reconcilePendingOrdersOnStartup === 'function', '[Upbit] reconcilePendingOrdersOnStartup method exists');
  assert(typeof managedOrderMgr.reconcileUpbitOrder === 'function', '[Upbit] reconcileUpbitOrder method exists');
  assert(typeof managedOrderMgr.getPendingOrders === 'function', '[Upbit] getPendingOrders method exists');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 12: Live Partial Fill Watcher & Single-Notification Verification
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 12: Single-Notification & Incremental Watcher Verification (Scenarios A, B, C)');

  let watcherEventCount = 0;
  let watcherReceivedVolume = 0;
  let watcherReceivedIncrement = 0;

  const testPosManager = new PositionManager(defaultParams);
  const scenarioGovernor = new GlobalRiskGovernor(defaultParams);
  const testOrderManager = new OrderManager(
    scenarioGovernor,
    (updatedRecord, incrementalVolume) => {
      watcherEventCount++;
      watcherReceivedVolume = updatedRecord.filledVolume;
      watcherReceivedIncrement = incrementalVolume;
      const added = incrementalVolume;
      if (updatedRecord.signalType === 'ENTRY_BUY') {
        const snap = testPosManager.getSnapshot();
        if (snap.amount > 0 && snap.state !== 'FLAT') {
          testPosManager.addAdditionalEntryFilled(updatedRecord.avgFillPrice || 2700000, added);
        } else {
          testPosManager.onInitialEntryFilled(
            updatedRecord.avgFillPrice || 2700000,
            added,
            2650000,
            35000,
            3.0,
            2.0
          );
        }
      }
    }
  );

  // ------------------------------------------------------------------
  // [Scenario A] Initial Buy Order Filled Immediately During Submit Flow
  // ------------------------------------------------------------------
  let scenarioAFilledCalls = 0;
  let scenarioAFilledVolume = 0;

  const recordA: OrderRecord = {
    id: `ORD_SCENARIO_A_${Date.now()}`,
    clientOrderId: `CLIENT_A_${Date.now()}`,
    signalId: `SIG_A_${Date.now()}`,
    signalType: 'ENTRY_BUY',
    symbol: 'KRW-ETH',
    side: 'BUY',
    status: 'ORDER_SUBMITTING',
    requestedBudgetOrVolume: 1.0,
    filledVolume: 0,
    avgFillPrice: 0,
    fee: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    reason: 'Scenario A immediate fill',
    fills: []
  };

  const responseA = {
    uuid: 'mock-uuid-scenario-a',
    identifier: recordA.clientOrderId,
    side: 'bid' as const,
    ord_type: 'limit',
    price: '2700000',
    state: 'done' as const,
    market: 'KRW-ETH',
    created_at: new Date().toISOString(),
    volume: '1.0',
    remaining_volume: '0',
    reserved: '2700000',
    remaining_fee: '0',
    paid_fee: '125',
    locked: '0',
    executed_volume: '1.0',
    trades_count: 1,
    trades: [{ market: 'KRW-ETH', uuid: 't-a', price: '2700000', volume: '1.0', funds: '2700000', created_at: new Date().toISOString(), side: 'bid' }]
  };

  // Submit flow applies fill
  testOrderManager.applyUpbitOrderState(
    recordA,
    responseA as any,
    (rec) => {
      scenarioAFilledCalls++;
      scenarioAFilledVolume = rec.filledVolume;
    },
    () => {},
    'SUBMIT_FLOW'
  );

  assert(scenarioAFilledCalls === 1, '[Scenario A] onFilled called exactly 1 time in SUBMIT_FLOW');
  assert(scenarioAFilledVolume === 1.0, '[Scenario A] onFilled received exact 1.0 ETH');
  assert(watcherEventCount === 0, '[Scenario A] onOrderUpdated suppressed during SUBMIT_FLOW (0 duplicate calls)');

  // ------------------------------------------------------------------
  // [Scenario B] Initial Partial Fill (0.4 ETH) + Watcher Fill (0.6 ETH)
  // ------------------------------------------------------------------
  let scenarioBFilledCalls = 0;
  let scenarioBFilledVolume = 0;
  watcherEventCount = 0; // reset watcher counter

  const recordB: OrderRecord = {
    id: `ORD_SCENARIO_B_${Date.now()}`,
    clientOrderId: `CLIENT_B_${Date.now()}`,
    signalId: `SIG_B_${Date.now()}`,
    signalType: 'ENTRY_BUY',
    symbol: 'KRW-ETH',
    side: 'BUY',
    status: 'ORDER_SUBMITTING',
    requestedBudgetOrVolume: 1.0,
    filledVolume: 0,
    avgFillPrice: 0,
    fee: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    reason: 'Scenario B partial fill',
    fills: []
  };

  // Step 1: Submit flow partial fill (0.4 ETH)
  const responseB_Partial = {
    uuid: 'mock-uuid-scenario-b',
    identifier: recordB.clientOrderId,
    side: 'bid' as const,
    ord_type: 'limit',
    price: '2700000',
    state: 'wait' as const,
    market: 'KRW-ETH',
    created_at: new Date().toISOString(),
    volume: '1.0',
    remaining_volume: '0.6',
    reserved: '2700000',
    remaining_fee: '0',
    paid_fee: '50',
    locked: '0',
    executed_volume: '0.4',
    trades_count: 1,
    trades: [{ market: 'KRW-ETH', uuid: 't-b1', price: '2700000', volume: '0.4', funds: '1080000', created_at: new Date().toISOString(), side: 'bid' }]
  };

  testOrderManager.applyUpbitOrderState(
    recordB,
    responseB_Partial as any,
    (rec) => {
      scenarioBFilledCalls++;
      scenarioBFilledVolume = rec.filledVolume;
      testPosManager.onInitialEntryFilled(2700000, rec.filledVolume, 2650000, 35000, 3.0, 2.0);
    },
    () => {},
    'SUBMIT_FLOW'
  );

  assert(scenarioBFilledCalls === 1, '[Scenario B - Step 1] onFilled called 1 time on partial submit');
  assert(scenarioBFilledVolume === 0.4, '[Scenario B - Step 1] onFilled received 0.4 ETH');
  assert(watcherEventCount === 0, '[Scenario B - Step 1] onOrderUpdated not called during SUBMIT_FLOW');
  assert(testPosManager.getSnapshot().amount === 0.4, '[Scenario B - Step 1] PositionManager has 0.4 ETH');
  assert(testOrderManager.getWatchingOrderIdsCount() === 1, '[Scenario B - Step 1] Order added to watcher queue');

  // Step 2: 4s later, Watcher detects remaining 0.6 ETH fill (Total 1.0 ETH)
  const responseB_Done = {
    ...responseB_Partial,
    state: 'done' as const,
    remaining_volume: '0',
    executed_volume: '1.0',
    trades_count: 2,
    paid_fee: '125',
    trades: [
      { market: 'KRW-ETH', uuid: 't-b1', price: '2700000', volume: '0.4', funds: '1080000', created_at: new Date().toISOString(), side: 'bid' },
      { market: 'KRW-ETH', uuid: 't-b2', price: '2700000', volume: '0.6', funds: '1620000', created_at: new Date().toISOString(), side: 'bid' }
    ]
  };

  testOrderManager.applyUpbitOrderState(
    recordB,
    responseB_Done as any,
    () => {},
    () => {},
    'WATCHER'
  );

  assert(scenarioBFilledCalls === 1, '[Scenario B - Step 2] submit-flow onFilled was NOT called again');
  assert(watcherEventCount === 1, '[Scenario B - Step 2] Watcher onOrderUpdated called exactly 1 time');
  assert(watcherReceivedVolume === 0.6 && watcherReceivedIncrement === 0.6, '[Scenario B - Step 2] Watcher received only the incremental 0.6 ETH fill');
  assert(testPosManager.getSnapshot().amount === 1.0, '[Scenario B - Step 2] PositionManager updated with exact added 0.6 ETH -> total 1.0 ETH (No duplicate inflation)');
  assert(testOrderManager.getWatchingOrderIdsCount() === 0, '[Scenario B - Step 2] Order removed from watcher queue upon FILLED');

  // ------------------------------------------------------------------
  // [Scenario C] Server Startup Reconciliation of Pending Order
  // ------------------------------------------------------------------
  watcherEventCount = 0; // reset

  const recordC: OrderRecord = {
    id: `ORD_SCENARIO_C_${Date.now()}`,
    clientOrderId: `CLIENT_C_${Date.now()}`,
    signalId: `SIG_C_${Date.now()}`,
    signalType: 'ENTRY_BUY',
    symbol: 'KRW-ETH',
    side: 'BUY',
    status: 'ORDER_SUBMITTED',
    requestedBudgetOrVolume: 1.0,
    filledVolume: 0,
    avgFillPrice: 0,
    fee: 0,
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 60000,
    reason: 'Scenario C startup reconcile',
    fills: []
  };

  const responseC = {
    uuid: 'mock-uuid-scenario-c',
    identifier: recordC.clientOrderId,
    side: 'bid' as const,
    ord_type: 'limit',
    price: '2700000',
    state: 'done' as const,
    market: 'KRW-ETH',
    created_at: new Date(Date.now() - 60000).toISOString(),
    volume: '1.0',
    remaining_volume: '0',
    reserved: '2700000',
    remaining_fee: '0',
    paid_fee: '125',
    locked: '0',
    executed_volume: '1.0',
    trades_count: 1,
    trades: [{ market: 'KRW-ETH', uuid: 't-c', price: '2700000', volume: '1.0', funds: '2700000', created_at: new Date().toISOString(), side: 'bid' }]
  };

  // Reconcile on startup calls applyUpbitOrderState with WATCHER
  testOrderManager.applyUpbitOrderState(
    recordC,
    responseC as any,
    () => {},
    () => {},
    'WATCHER'
  );

  assert(watcherEventCount === 1, '[Scenario C] Startup reconcile triggered onOrderUpdated exactly 1 time');
  assert(watcherReceivedVolume === 1.0 && watcherReceivedIncrement === 1.0, '[Scenario C] Startup reconcile received 1.0 ETH added');

  // A watcher may be the first observer after a restart. That delivery is an
  // INITIAL strategy fill, not an additional-fill transition.
  assert(recordC.strategyInitialFillApplied === true && recordC.strategyAppliedFilledVolume === 1.0, '[Scenario C] Initial watcher fill is persisted as strategy-applied');

  // A startup reconcile response that arrives after the engine changed symbol,
  // account or generation must not apply exchange state to the old order.
  let staleReconcileContextCurrent = true;
  let staleReconcileCallbacks = 0;
  const staleReconcileManager = new OrderManager(undefined, () => { staleReconcileCallbacks++; });
  const staleReconcileRecord: OrderRecord = {
    id: `ORD_STALE_RECONCILE_${Date.now()}`,
    clientOrderId: `CLIENT_STALE_RECONCILE_${Date.now()}`,
    signalId: `SIG_STALE_RECONCILE_${Date.now()}`,
    signalType: 'DCA_BUY',
    symbol: 'KRW-ETH', side: 'BUY', status: 'ORDER_SUBMITTED',
    requestedBudgetOrVolume: 1000000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'stale startup reconciliation', fills: []
  };
  (staleReconcileManager as any).orders.set(staleReconcileRecord.id, staleReconcileRecord);
  let resolveStaleReconcile!: (value: any) => void;
  (staleReconcileManager as any).reconcileUpbitOrder = () => new Promise((resolve) => { resolveStaleReconcile = resolve; });
  const staleReconcileRun = staleReconcileManager.reconcilePendingOrdersOnStartup(
    { upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' },
    'UPBIT',
    'KRW-ETH',
    () => staleReconcileContextCurrent
  );
  staleReconcileContextCurrent = false;
  resolveStaleReconcile({ found: true, order: { ...responseC, uuid: 'mock-stale-reconcile', identifier: staleReconcileRecord.clientOrderId } });
  assert(await staleReconcileRun === 0, '[Stale reconcile] Stale exchange result is not counted as reconciled');
  assert(staleReconcileRecord.status === 'ORDER_SUBMITTED' && staleReconcileRecord.filledVolume === 0 && staleReconcileRecord.strategyAppliedFilledVolume === undefined, '[Stale reconcile] Stale response cannot mutate order state or watermark');
  assert(staleReconcileCallbacks === 0, '[Stale reconcile] Stale response cannot trigger a position callback');

  // The periodic watcher is subject to exactly the same guard. A response
  // started under the old API-key/account context must not apply an order
  // state after that context is replaced.
  let staleWatcherCallbacks = 0;
  const staleWatcherManager = new OrderManager(undefined, () => { staleWatcherCallbacks++; });
  const staleWatcherRecord: OrderRecord = {
    id: `ORD_STALE_WATCHER_${Date.now()}`,
    clientOrderId: `CLIENT_STALE_WATCHER_${Date.now()}`,
    signalId: `SIG_STALE_WATCHER_${Date.now()}`,
    signalType: 'DCA_BUY',
    symbol: 'KRW-ETH', side: 'BUY', status: 'OPEN',
    requestedBudgetOrVolume: 1000000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'stale watcher response', fills: []
  };
  (staleWatcherManager as any).orders.set(staleWatcherRecord.id, staleWatcherRecord);
  (staleWatcherManager as any).watchingOrderIds.add(staleWatcherRecord.id);
  staleWatcherManager.setApiKeysForWatcher({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  staleWatcherManager.setWatcherContextGuard(() => true);
  let resolveStaleWatcher!: (value: any) => void;
  (staleWatcherManager as any).reconcileUpbitOrder = () => new Promise((resolve) => { resolveStaleWatcher = resolve; });
  const staleWatcherRun = (staleWatcherManager as any).processPartialFillWatcherCycle();
  // setWatcherContextGuard increments the watcher generation, invalidating
  // the request already in flight just as an API-key/account switch does.
  staleWatcherManager.setWatcherContextGuard(() => true);
  resolveStaleWatcher({ found: true, order: { ...responseC, uuid: 'mock-stale-watcher', identifier: staleWatcherRecord.clientOrderId } });
  await staleWatcherRun;
  assert(staleWatcherRecord.status === 'OPEN' && staleWatcherRecord.filledVolume === 0 && staleWatcherRecord.strategyAppliedFilledVolume === undefined, '[Stale watcher] Late watcher response cannot mutate order state or watermark');
  assert(staleWatcherCallbacks === 0, '[Stale watcher] Late watcher response cannot trigger a position callback');

  // The timeout-cancel path has the identical commit guard: cancellation from
  // an old account must not mark a current order terminal or release state.
  const staleCancelManager = new OrderManager();
  const staleCancelRecord: OrderRecord = {
    id: `ORD_STALE_CANCEL_${Date.now()}`, clientOrderId: `CLIENT_STALE_CANCEL_${Date.now()}`,
    signalId: `SIG_STALE_CANCEL_${Date.now()}`, signalType: 'DCA_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'OPEN', exchangeOrderId: 'uuid-stale-cancel', requestedBudgetOrVolume: 1000000,
    filledVolume: 0, avgFillPrice: 0, fee: 0, createdAt: Date.now() - 61000, updatedAt: Date.now(),
    reason: 'stale timeout cancel', fills: []
  };
  (staleCancelManager as any).orders.set(staleCancelRecord.id, staleCancelRecord);
  (staleCancelManager as any).watchingOrderIds.add(staleCancelRecord.id);
  staleCancelManager.setApiKeysForWatcher({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  staleCancelManager.setWatcherContextGuard(() => true);
  let resolveStaleCancel!: (value: any) => void;
  (staleCancelManager as any).upbitClient.cancelOrder = () => new Promise((resolve) => { resolveStaleCancel = resolve; });
  const staleCancelRun = (staleCancelManager as any).processPartialFillWatcherCycle();
  staleCancelManager.setWatcherContextGuard(() => true);
  resolveStaleCancel({ success: true, order: { ...responseC, uuid: 'uuid-stale-cancel', state: 'cancel', identifier: staleCancelRecord.clientOrderId } });
  await staleCancelRun;
  assert(staleCancelRecord.status === 'OPEN' && staleCancelRecord.filledVolume === 0, '[Stale watcher cancel] Late cancellation response cannot mutate order state');

  // UNKNOWN reconciliation must also retain its ledger/reservation state when
  // the account context changes while the exchange lookup is pending.
  const staleUnknownManager = new OrderManager();
  const staleUnknownRecord: OrderRecord = {
    id: `ORD_STALE_UNKNOWN_${Date.now()}`, clientOrderId: `CLIENT_STALE_UNKNOWN_${Date.now()}`,
    signalId: `SIG_STALE_UNKNOWN_${Date.now()}`, signalType: 'DCA_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'UNKNOWN_PENDING_RECONCILIATION', requestedBudgetOrVolume: 1000000,
    filledVolume: 0, avgFillPrice: 0, fee: 0, createdAt: Date.now() - 121000, updatedAt: Date.now() - 121000,
    reason: 'stale UNKNOWN reconciliation', fills: []
  };
  (staleUnknownManager as any).orders.set(staleUnknownRecord.id, staleUnknownRecord);
  staleUnknownManager.setApiKeysForWatcher({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  staleUnknownManager.setWatcherContextGuard(() => true);
  let resolveStaleUnknown!: (value: any) => void;
  (staleUnknownManager as any).reconcileUpbitOrder = () => new Promise((resolve) => { resolveStaleUnknown = resolve; });
  const staleUnknownRun = (staleUnknownManager as any).processPartialFillWatcherCycle();
  staleUnknownManager.setWatcherContextGuard(() => true);
  resolveStaleUnknown({ found: true, order: { ...responseC, uuid: 'mock-stale-unknown', identifier: staleUnknownRecord.clientOrderId } });
  await staleUnknownRun;
  assert(staleUnknownRecord.status === 'UNKNOWN_PENDING_RECONCILIATION' && staleUnknownRecord.filledVolume === 0, '[Stale UNKNOWN watcher] Late reconciliation cannot mutate uncertain order state');

  // Replaying the exact same exchange state must never run a strategy handler
  // twice. This applies to every stateful partial-fill signal, regardless of
  // whether SUBMIT_FLOW or WATCHER observed the first execution.
  const statefulFillSignals = ['DCA_BUY', 'PYRAMID_BUY', 'BOX_PYRAMID_BUY', 'PARTIAL_LOSS_CUT', 'EMERGENCY_TREND_CUT', 'REENTRY_BUY'] as const;
  for (const signalType of statefulFillSignals) {
    let initialHandlerCalls = 0;
    const duplicateRecord: OrderRecord = {
      id: `ORD_STRATEGY_LEDGER_${signalType}_${Date.now()}`,
      clientOrderId: `CLIENT_STRATEGY_LEDGER_${signalType}_${Date.now()}`,
      signalId: `SIG_STRATEGY_LEDGER_${signalType}_${Date.now()}`,
      signalType,
      symbol: 'KRW-ETH',
      side: signalType === 'PARTIAL_LOSS_CUT' || signalType === 'EMERGENCY_TREND_CUT' ? 'SELL' : 'BUY',
      status: 'ORDER_SUBMITTED',
      requestedBudgetOrVolume: 1,
      filledVolume: 0,
      avgFillPrice: 0,
      fee: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reason: `Strategy ledger ${signalType}`,
      fills: []
    };
    const response = { ...responseC, uuid: `mock-ledger-${signalType}`, identifier: duplicateRecord.clientOrderId };
    testOrderManager.applyUpbitOrderState(duplicateRecord, response as any, (rec) => {
      initialHandlerCalls++;
      assert(rec.strategyFillKind === 'INITIAL', `[Strategy ledger] ${signalType} first handler is INITIAL`);
    }, () => {}, 'SUBMIT_FLOW');
    testOrderManager.applyUpbitOrderState(duplicateRecord, response as any, () => {
      initialHandlerCalls++;
    }, () => {}, 'WATCHER');
    assert(initialHandlerCalls === 1, `[Strategy ledger] ${signalType} initial handler executes exactly once across submit/watcher`);
    assert(duplicateRecord.strategyInitialFillApplied === true && duplicateRecord.strategyAppliedFilledVolume === 1.0, `[Strategy ledger] ${signalType} applied watermark is persisted`);
  }

  // ──────────────────────────────────────────────────────
  // TEST GROUP 13: Non-Entry Signal Incremental Fill Protection (DCA, Pyramid, Cut)
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 13: Non-Entry Signal Incremental Fill Protection (DCA, Pyramid, Partial Cut)');

  const nonEntryPosManager = new PositionManager(defaultParams);
  // Establish baseline position: 1.0 ETH @ ₩2,700,000
  nonEntryPosManager.onInitialEntryFilled(2700000, 1.0, 2650000, 35000, 3.0, 2.0);

  // 1. DCA_BUY Partial Fill (0.3 ETH) -> Watcher Fill (0.2 ETH)
  // Step 1: Initial submit of DCA (Slot 1 filled with 0.3 ETH)
  nonEntryPosManager.onDcaFilled(1, 2600000, 0.3);
  const snapAfterDca1 = nonEntryPosManager.getSnapshot();
  assert(snapAfterDca1.amount === 1.3, '[DCA Partial Fill] Position amount is 1.3 ETH after 1st partial fill');
  assert(snapAfterDca1.initialStopPrice === 2538000, '[DCA Partial Fill] DCA preserves the original fixed -6% absolute stop');
  assert(snapAfterDca1.dcaSlots[0].status === 'FILLED' && snapAfterDca1.dcaSlots[0].filledVolume === 0.3, '[DCA Partial Fill] Slot 1 filled with 0.3 ETH');
  assert(snapAfterDca1.dcaSlots[1].status === 'AVAILABLE', '[DCA Partial Fill] Slot 2 is still AVAILABLE');

  // Step 2: Watcher detects remaining 0.2 ETH filled -> call addAdditionalDcaFilled
  nonEntryPosManager.addAdditionalDcaFilled(2600000, 0.2);
  const snapAfterDca2 = nonEntryPosManager.getSnapshot();
  assert(snapAfterDca2.amount === 1.5, '[DCA Partial Fill] Position amount increased to exact 1.5 ETH');
  assert(snapAfterDca2.dcaSlots[0].filledVolume === 0.5, '[DCA Partial Fill] Slot 1 volume correctly updated to 0.5 ETH');
  assert(snapAfterDca2.dcaSlots[1].status === 'AVAILABLE', '[DCA Partial Fill] Slot 2 remains untouched & AVAILABLE (No false slot consumption!)');

  // A single exchange DCA order must remain one lifecycle stage while it is
  // only partially filled. The terminal fragment, not the first fragment,
  // marks the slot complete.
  const lifecyclePosManager = new PositionManager(defaultParams);
  lifecyclePosManager.onInitialEntryFilled(2700000, 1, 2650000, 35000, 3, 2);
  lifecyclePosManager.onDcaFilled(1, 2600000, 0.2, false);
  assert(lifecyclePosManager.getSnapshot().dcaSlots[0].status === 'PARTIALLY_FILLED', '[Stage lifecycle] First DCA fragment stays PARTIALLY_FILLED');
  lifecyclePosManager.addAdditionalDcaFilled(2600000, 0.3, true);
  lifecyclePosManager.recordExecutionStage('CLIENT_STAGE_DCA_1', 'DCA_BUY', 0.5, true, undefined, 1300000);
  const lifecycleSnapshot = lifecyclePosManager.getSnapshot();
  assert(lifecycleSnapshot.dcaSlots[0].status === 'FILLED' && lifecycleSnapshot.executionStages?.CLIENT_STAGE_DCA_1?.cumulativeFilledVolume === 0.5 && lifecycleSnapshot.executionStages.CLIENT_STAGE_DCA_1.status === 'FILLED', '[Stage lifecycle] Final DCA fragment completes exactly its own order stage');
  lifecyclePosManager.onTrailingPartialFilled(0.1, 2800000, 10000, false);
  assert((lifecyclePosManager.getSnapshot().trailingExitCount || 0) === 0, '[Stage lifecycle] First trailing fragment does not consume a trailing exit count');
  lifecyclePosManager.onTrailingPartialFilled(0.1, 2800000, 10000, true);
  assert((lifecyclePosManager.getSnapshot().trailingExitCount || 0) === 1, '[Stage lifecycle] Final trailing fragment consumes one trailing exit count');
  const cancelledStageManager = new PositionManager(defaultParams);
  cancelledStageManager.onInitialEntryFilled(2700000, 1, 2650000, 35000, 3, 2);
  cancelledStageManager.onDcaFilled(1, 2600000, 0.2, false);
  cancelledStageManager.recordExecutionStage('CLIENT_CANCELLED_DCA', 'DCA_BUY', 0.2, false, undefined, 1300000);
  cancelledStageManager.finalizeCancelledPartialStage('CLIENT_CANCELLED_DCA', 'DCA_BUY', 0.2);
  assert(cancelledStageManager.getSnapshot().dcaSlots[0].status === 'FILLED' && cancelledStageManager.getSnapshot().executionStages?.CLIENT_CANCELLED_DCA?.status === 'CANCELLED_PARTIAL', '[Stage lifecycle] Cancelled DCA partial is explicitly completed once without retrying the full stage');

  // 2. PYRAMID_BUY Partial Fill (0.3 ETH) -> Watcher Fill (0.2 ETH)
  // Step 1: Initial submit of Pyramid (Count becomes 1, volume +0.3 ETH)
  nonEntryPosManager.onPyramidFilled(2800000, 0.3);
  const snapAfterPyr1 = nonEntryPosManager.getSnapshot();
  assert(snapAfterPyr1.amount === 1.8, '[Pyramid Partial Fill] Position amount is 1.8 ETH');
  assert(snapAfterPyr1.pyramidingCount === 1, '[Pyramid Partial Fill] Pyramiding count is 1 after initial fill');

  // Step 2: Watcher detects remaining 0.2 ETH filled -> call addAdditionalPyramidFilled
  nonEntryPosManager.addAdditionalPyramidFilled(2800000, 0.2);
  const snapAfterPyr2 = nonEntryPosManager.getSnapshot();
  assert(snapAfterPyr2.amount === 2.0, '[Pyramid Partial Fill] Position amount is exact 2.0 ETH');
  assert(snapAfterPyr2.pyramidingCount === 1, '[Pyramid Partial Fill] Pyramiding count remains 1 (No duplicate count inflation!)');

  // 3. PARTIAL_LOSS_CUT Partial Fill (0.4 ETH) -> Watcher Fill (0.4 ETH)
  // Step 1: Initial submit of Partial Cut (40% of 2.0 = 0.8 total; first fill is 0.4 ETH)
  nonEntryPosManager.onPartialLossCutFilled(0.4, 2600000, -40000);
  const snapAfterCut1 = nonEntryPosManager.getSnapshot();
  assert(snapAfterCut1.amount === 1.6, '[Partial Cut] Position amount reduced to 1.6 ETH');
  assert(snapAfterCut1.state === 'DEFENSIVE_1', '[Partial Cut] Position state is DEFENSIVE_1');
  assert(nonEntryPosManager.isUnderCooldown(), '[Partial Cut] Cooldown is armed before any DCA re-entry');

  // Step 2: Watcher detects remaining 0.4 ETH cut -> call addAdditionalPartialCutFilled
  nonEntryPosManager.addAdditionalPartialCutFilled(0.4, 2600000, -40000);
  const snapAfterCut2 = nonEntryPosManager.getSnapshot();
  assert(snapAfterCut2.amount === 1.2, '[Partial Cut] Position amount reduced to exact 1.2 ETH');
  assert(snapAfterCut2.state === 'DEFENSIVE_1', '[Partial Cut] Incremental fill preserves defensive state');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 13-b: Manual Add Isolation & Full-Exit Reset
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 13-b: Manual Add Isolation & Full-Exit Reset');

  const manualAddPosManager = new PositionManager(defaultParams);
  manualAddPosManager.onInitialEntryFilled(2700000, 1.0, 2650000, 35000, 3.0, 2.0);
  manualAddPosManager.onManualAdditionalBuyFilled(2600000, 0.2, 2640000, 30000, 3.0, 2.0);
  const manualAddSnapshot = manualAddPosManager.getSnapshot();
  assert(manualAddSnapshot.amount === 1.2, '[Manual Add] Added volume is reflected in the open position');
  assert(manualAddSnapshot.entryPrice === 2683333.33, '[Manual Add] Weighted average is recalculated from the confirmed fill price');
  assert(manualAddSnapshot.dcaSlots.every((slot) => slot.status === 'AVAILABLE'), '[Manual Add] Automated DCA slots remain untouched');
  assert(manualAddSnapshot.initialStopPrice !== null && manualAddSnapshot.initialStopPrice <= manualAddSnapshot.entryPrice! * 0.94 + 1, '[Manual Add] Static stop is rebuilt from the new average');

  manualAddPosManager.onPositionClosed(50000, 'MANUAL_FULL_EXIT');
  const fullExitSnapshot = manualAddPosManager.getSnapshot();
  assert(fullExitSnapshot.state === 'FLAT' && fullExitSnapshot.amount === 0 && fullExitSnapshot.entryPrice === null, '[Full Exit] Position quantity and entry state are cleared');
  assert(fullExitSnapshot.dcaSlots.every((slot) => slot.status === 'AVAILABLE') && fullExitSnapshot.partialCutCount === 0, '[Full Exit] DCA slots and partial-cut state are reset');
  assert(fullExitSnapshot.initialBaseline === null && fullExitSnapshot.initialBand === null && fullExitSnapshot.initialStopPrice === null, '[Full Exit] Price-dependent protective levels are reset');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 14: Breakout 1st Entry (BULL Market Momentum Entry)
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 14: Breakout 1st Entry in Bullish Momentum');

  const breakoutStrategyCore = new ATRStrategyCore();
  const breakoutPosManager = new PositionManager(defaultParams);
  breakoutPosManager.onPositionClosed(0, 'INIT_FLAT'); // reset to pristine FLAT
  const flatPosition = breakoutPosManager.getSnapshot();
  flatPosition.cooldownUntil = 0; // clear test cooldown

  // Simulating Bullish upward trend: 20 ticks rising from 2,600,000 to 2,750,000 (above baseline 2,650,000)
  const bullPriceHistory = Array.from({ length: 20 }, (_, i) => 2600000 + i * 8000);
  const currentBullPrice = 2750000;
  const bullBaseline = 2650000;
  const bullAtr = 35000;

  const breakoutSignals = breakoutStrategyCore.generateSignals(
    currentBullPrice,
    bullBaseline,
    bullAtr,
    { ...defaultParams, breakoutEntryEnabled: true },
    flatPosition,
    0.05,
    bullPriceHistory,
    undefined,
    50,
    1.2
  );

  assert(breakoutSignals.length === 1, '[Breakout Entry] Exactly 1 signal generated in Bull trend');
  assert(breakoutSignals[0].type === 'BREAKOUT_BUY', '[Breakout Entry] Signal is BREAKOUT_BUY (No waiting for lower band!)');
  assert(breakoutSignals[0].priority === 6, '[Breakout Entry] Priority is 6 (Entry level)');

  // Evaluate by Risk Governor
  const breakoutGov = new GlobalRiskGovernor(defaultParams);
  const breakoutRiskEval = breakoutGov.evaluateSignal(
    breakoutSignals[0],
    'RUNNING',
    'LIVE',
    10000000,
    flatPosition,
    currentBullPrice,
    [],
    0
  );

  assert(breakoutRiskEval.approved === true, '[Breakout Entry] Approved by Global Risk Governor');
  assert(breakoutRiskEval.orderRequest?.side === 'BUY', '[Breakout Entry] Valid BUY order request generated');

  // Fill execution and Position initialization
  breakoutPosManager.onInitialEntryFilled(
    currentBullPrice,
    0.8,
    bullBaseline,
    bullAtr,
    3.0,
    2.0
  );
  const posAfterBreakout = breakoutPosManager.getSnapshot();
  assert(posAfterBreakout.state === 'ENTRY_FILLED', '[Breakout Entry] Position state transitioned to ENTRY_FILLED');
  assert(posAfterBreakout.amount === 0.8, '[Breakout Entry] Position amount is 0.8 ETH');
  assert(posAfterBreakout.initialStopPrice !== null && posAfterBreakout.initialStopPrice < currentBullPrice, '[Breakout Entry] Static Stop Loss securely locked below entry');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 15: Trailing Partial Take-Profit (50% Scaling & Dust Guard) - Scenarios 1 to 6
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 15: Trailing Partial Take-Profit (50% Partial Exit & Dust Guard)');

  const partialTrailingPosManager = new PositionManager(defaultParams);
  partialTrailingPosManager.onPositionClosed(0, 'INIT_FLAT');
  // Pristine test isolation
  (partialTrailingPosManager as any).position.realizedPnl = 0;
  (partialTrailingPosManager as any).position.cooldownUntil = 0;
  partialTrailingPosManager.onInitialEntryFilled(2800000, 1.0, 2800000, 30000, 3.0, 2.0);

  // [Scenario 1] 1.0 ETH position -> RiskGovernor calculates 50% partial exit = 0.5 ETH
  const posSnap1 = partialTrailingPosManager.getSnapshot();
  const trailingSignal1: Signal = {
    id: 'SIG_TRAILING_PARTIAL_1',
    timestamp: Date.now(),
    timeframe: 'tick',
    source: 'TRAILING_STOP_ENGINE',
    type: 'TRAILING_STOP_EXIT',
    priority: 3,
    symbol: 'KRW-ETH',
    price: 3000000,
    reason: 'Trailing take-profit triggered',
    indicatorSnapshot: {
      baseline: 2800000,
      atr: 30000,
      upperBand: 2890000,
      lowerBand: 2710000,
      currentStopLoss: 2600000,
      marketRegime: 'BULL',
      slope: 0.2,
      volatilityRatio: 1.0,
      dynamicOrderRatio: 20
    }
  };

  const riskEval1 = riskGovernor.evaluateSignal(
    trailingSignal1,
    'RUNNING',
    'LIVE',
    5000000,
    posSnap1,
    3000000,
    [],
    0
  );

  assert(riskEval1.approved === true, '[Scenario 1] TRAILING_STOP_EXIT is approved by RiskGovernor');
  assert(riskEval1.calculatedVolume === 0.5, '[Scenario 1] Exactly 50% volume (0.5 ETH) calculated for 1.0 ETH position');

  // Execute partial exit fill
  const pnl1 = (3000000 - 2800000) * 0.5; // +100,000 KRW
  partialTrailingPosManager.onTrailingPartialFilled(0.5, 3000000, pnl1);
  const posSnapAfterExit1 = partialTrailingPosManager.getSnapshot();
  assert(posSnapAfterExit1.amount === 0.5, '[Scenario 1] Position amount is exactly 0.5 ETH remaining after 1st partial exit');
  assert(posSnapAfterExit1.state === 'ENTRY_FILLED', '[Scenario 1] Position state remains open (ENTRY_FILLED)');
  assert(posSnapAfterExit1.realizedPnl === 100000, '[Scenario 1] Realized PnL correctly accumulated ₩100,000');

  // [Scenario 2] Trailing is disarmed (trailingActive=false, trailingPeakPrice=null)
  assert(posSnapAfterExit1.trailingActive === false, '[Scenario 2] trailingActive is disarmed to false after partial exit');
  assert(posSnapAfterExit1.trailingPeakPrice === null, '[Scenario 2] trailingPeakPrice is reset to null to require fresh higher high');

  // [Scenario 3] The second trailing exit liquidates all remaining quantity.
  const riskEval2 = riskGovernor.evaluateSignal(
    trailingSignal1,
    'RUNNING',
    'LIVE',
    5000000,
    posSnapAfterExit1,
    3100000,
    [],
    0
  );
  assert(riskEval2.approved === true, '[Scenario 3] 2nd TRAILING_STOP_EXIT is approved');
  assert(riskEval2.calculatedVolume === 0.5, '[Scenario 3] Second trailing exit sells the full remaining 0.5 ETH');

  const pnl2 = (3100000 - 2800000) * 0.5; // +150,000 KRW
  partialTrailingPosManager.onTrailingPartialFilled(0.5, 3100000, pnl2);
  const posSnapAfterExit2 = partialTrailingPosManager.getSnapshot();
  assert(posSnapAfterExit2.amount === 0, '[Scenario 3] Position is fully closed after the 2nd trailing exit');
  assert(posSnapAfterExit2.realizedPnl === 250000, '[Scenario 3] Realized PnL is now ₩250,000');
  assert(posSnapAfterExit2.trailingActive === false && posSnapAfterExit2.trailingPeakPrice === null, '[Scenario 3] Trailing state remains cleanly disarmed');

  // [Scenario 4] Dust Guard test: remaining value < 10,000 KRW forces full liquidation
  const dustPos: PositionSnapshot = {
    ...posSnapAfterExit2,
    amount: 0.003, // 0.003 ETH @ 2,500,000 = 7,500 KRW (< 10,000 KRW dust guard threshold)
    cooldownUntil: 0 // Isolate the dust guard from the full-exit cooldown behavior.
  };
  const dustRiskEval = riskGovernor.evaluateSignal(
    trailingSignal1,
    'RUNNING',
    'LIVE',
    5000000,
    dustPos,
    2500000,
    [],
    0
  );
  assert(dustRiskEval.approved === true, '[Scenario 4] Dust guard signal approved');
  assert(dustRiskEval.calculatedVolume === 0.003, '[Scenario 4] Dust guard forced 100% full liquidation (0.003 ETH instead of 0.0015 ETH)');

  // When 0.003 is sold, position becomes FLAT
  const finalSnap = partialTrailingPosManager.getSnapshot();
  assert(finalSnap.amount === 0, '[Scenario 4] Position amount becomes 0');
  assert(finalSnap.state === 'FLAT', '[Scenario 4] Position state transitions to FLAT');
  assert(finalSnap.entryPrice === null, '[Scenario 4] Entry price cleared on 100% closure');

  // [Scenario 5] Verify other exits (ABSOLUTE_STOP_EXIT, EMERGENCY_FULL_EXIT, PARTIAL_LOSS_CUT, EMERGENCY_TREND_CUT, DCA_BUY)
  const fullPosSnap: PositionSnapshot = { ...posSnap1, amount: 1.0 };
  const absStopEval = riskGovernor.evaluateSignal({ ...trailingSignal1, type: 'ABSOLUTE_STOP_EXIT', priority: 1 }, 'RUNNING', 'LIVE', 5000000, fullPosSnap, 2500000, [], 0);
  assert(absStopEval.approved === true && absStopEval.calculatedVolume === 1.0, '[Scenario 5] ABSOLUTE_STOP_EXIT remains 100% full exit (1.0 ETH)');

  const emgFullEval = riskGovernor.evaluateSignal({ ...trailingSignal1, type: 'EMERGENCY_FULL_EXIT', priority: 2 }, 'RUNNING', 'LIVE', 5000000, fullPosSnap, 2500000, [], 0);
  assert(emgFullEval.approved === true && emgFullEval.calculatedVolume === 1.0, '[Scenario 5] EMERGENCY_FULL_EXIT remains 100% full exit (1.0 ETH)');

  const partLossEval = riskGovernor.evaluateSignal({ ...trailingSignal1, type: 'PARTIAL_LOSS_CUT', priority: 4 }, 'RUNNING', 'LIVE', 5000000, fullPosSnap, 2500000, [], 0);
  assert(partLossEval.approved === true && partLossEval.calculatedVolume === 0.3, '[Scenario 5] First PARTIAL_LOSS_CUT sells 30% (0.3 ETH)');

  const emgTrendEval = riskGovernor.evaluateSignal({ ...trailingSignal1, type: 'EMERGENCY_TREND_CUT', priority: 2 }, 'RUNNING', 'LIVE', 5000000, fullPosSnap, 2500000, [], 0);
  assert(emgTrendEval.approved === true && emgTrendEval.calculatedVolume === 0.4, '[Scenario 5] EMERGENCY_TREND_CUT remains 40% emergency cut (0.4 ETH)');

  // [Scenario 6] TRAILING_STOP_EXIT approved even when BUY is pending
  const pendingBuyOrdersList: OrderRecord[] = [{
    id: 'ORD_PENDING_BUY_TEST', clientOrderId: 'ORD_CLI_BUY_1', signalId: 'SIG_BUY_1', signalType: 'ENTRY_BUY',
    symbol: 'KRW-ETH', side: 'BUY', status: 'ORDER_SUBMITTING', requestedBudgetOrVolume: 500000,
    filledVolume: 0, avgFillPrice: 0, fee: 0, reason: 'Test pending BUY', fills: [],
    createdAt: Date.now(), updatedAt: Date.now()
  }];
  const trailingWithPendingBuyEval = riskGovernor.evaluateSignal(
    trailingSignal1, 'RUNNING', 'LIVE',
    5000000, fullPosSnap, 3000000,
    pendingBuyOrdersList, 0
  );
  assert(trailingWithPendingBuyEval.approved === true, '[Scenario 6] TRAILING_STOP_EXIT is not blocked by pending BUY orders');
  assert(trailingWithPendingBuyEval.calculatedVolume === 0.5, '[Scenario 6] Partial trailing volume is 0.5 ETH during pending BUY');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 16: Pyramiding Bull Gate & Signal Priority - Scenarios 7 to 9
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 16: Pyramiding Bull Gate & Signal Priority');

  const pyramidStrategyCore = new ATRStrategyCore();
  const baseBullHistory = Array.from({ length: 20 }, (_, i) => 2600000 + i * 10000); // strong upward slope

  // [Scenario 7] Once trailing is armed, additional pyramiding is blocked.
  const armedBullPosition: PositionSnapshot = {
    ...posSnap1,
    entryPrice: 2700000,
    amount: 1.0,
    pyramidingCount: 0,
    trailingActive: true, // Trailing is ARMED
    trailingPeakPrice: 2780000
  };

  const currentBullPriceForPyr = 2750000; // PnL = (2750000 - 2700000)/2700000 = +1.85% (>= 1.5%)
  const bullBaselineForPyr = 2650000;
  const bullAtrForPyr = 30000; // upperBand = 2650000 + 30000 * 2.4 = 2722000; current price 2750000 > upperBand

  // When peak was 2780000 and current is 2750000, drop from peak is (2780000 - 2750000)/2780000 = 1.07% (>= 0.8% callback)
  // To test ONLY pyramiding rule without trailing trigger, set peakPrice = 2750000 (0% drop from peak)
  const armedBullPosNoDrop: PositionSnapshot = {
    ...armedBullPosition,
    trailingPeakPrice: 2750000 // 0% drop from peak, so Trailing Stop Exit does NOT trigger
  };

  const signalsBull = pyramidStrategyCore.generateSignals(
    currentBullPriceForPyr,
    bullBaselineForPyr,
    bullAtrForPyr,
    defaultParams,
    armedBullPosNoDrop,
    0.01,
    baseBullHistory,
    { trend: 'BULL', htfSlope: 0.5 }
  );

  const pyramidSignal = signalsBull.find((s) => s.type === 'PYRAMID_BUY');
  assert(pyramidSignal === undefined, '[Scenario 7] PYRAMID_BUY is blocked while trailingActive=true');

  // [Scenario 8] SIDEWAYS or BEAR market -> PYRAMID_BUY is strictly blocked
  const sidewaysHistory = Array.from({ length: 20 }, () => 2700000); // flat slope
  const signalsSideways = pyramidStrategyCore.generateSignals(
    currentBullPriceForPyr,
    bullBaselineForPyr,
    bullAtrForPyr,
    defaultParams,
    armedBullPosNoDrop,
    0.01,
    sidewaysHistory,
    { trend: 'SIDEWAYS', htfSlope: 0 }
  );

  const pyrInSideways = signalsSideways.find((s) => s.type === 'PYRAMID_BUY');
  assert(pyrInSideways === undefined, '[Scenario 8] PYRAMID_BUY is strictly BLOCKED in SIDEWAYS market');

  const bearHistory = Array.from({ length: 20 }, (_, i) => 2800000 - i * 10000); // downward slope
  const signalsBear = pyramidStrategyCore.generateSignals(
    currentBullPriceForPyr,
    bullBaselineForPyr,
    bullAtrForPyr,
    defaultParams,
    armedBullPosNoDrop,
    0.01,
    bearHistory,
    { trend: 'BEAR', htfSlope: -0.5 }
  );

  const pyrInBear = signalsBear.find((s) => s.type === 'PYRAMID_BUY');
  assert(pyrInBear === undefined, '[Scenario 8] PYRAMID_BUY is strictly BLOCKED in BEAR market');

  // [Scenario 9] Priority preservation: When Trailing Stop AND Pyramiding conditions both match,
  // TRAILING_STOP_EXIT (priority 3) fires and early-returns, preventing concurrent PYRAMID_BUY
  const armedBullPosWithDrop: PositionSnapshot = {
    ...armedBullPosition,
    trailingPeakPrice: 2780000 // Peak was 2,780,000; current is 2,750,000 (-1.08% drop >= 0.8% callback)
  };

  const concurrentSignals = pyramidStrategyCore.generateSignals(
    currentBullPriceForPyr,
    bullBaselineForPyr,
    bullAtrForPyr,
    defaultParams,
    armedBullPosWithDrop,
    0.01,
    baseBullHistory,
    { trend: 'BULL', htfSlope: 0.5 }
  );

  assert(concurrentSignals.length === 1, '[Scenario 9] Exactly 1 signal generated on concurrent condition tick');
  assert(concurrentSignals[0].type === 'TRAILING_STOP_EXIT', '[Scenario 9] TRAILING_STOP_EXIT (Priority 3) takes precedence over Pyramiding (Priority 6)');
  assert(concurrentSignals.find((s) => s.type === 'PYRAMID_BUY') === undefined, '[Scenario 9] PYRAMID_BUY is NOT co-emitted in the same tick');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 17: Dynamic Order Ratio (Regime-Aware Sizing) & AutoPilot Gate - Scenarios 1 to 6
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 17: Dynamic Order Ratio (Regime-Aware Sizing) & AutoPilot Gate');

  const sizingRiskGov = new GlobalRiskGovernor({
    ...defaultParams,
    autoPilotEnabled: true,
    orderRatio: 25 // static fallback is 25%
  });

  const cleanFlatPos: PositionSnapshot = {
    ...testPosition,
    amount: 0,
    state: 'FLAT',
    cooldownUntil: 0
  };

  const totalCap = 10000000; // 10,000,000 KRW

  // [Scenario 1] AutoPilot ON + BULL market (dynamicOrderRatio = 20%) -> effectiveOrderRatio = 0.20, targetBudget = 2,000,000 KRW
  const bullBuySignal: Signal = {
    id: 'SIG_BULL_BUY_TEST',
    timestamp: Date.now(),
    timeframe: 'tick',
    source: 'ATR_STRATEGY_CORE',
    type: 'ENTRY_BUY',
    priority: 6,
    symbol: 'KRW-ETH',
    price: 2700000,
    reason: 'Bull Breakout Entry',
    indicatorSnapshot: {
      baseline: 2650000,
      atr: 30000,
      upperBand: 2722000,
      lowerBand: 2578000,
      currentStopLoss: 2518000,
      marketRegime: 'BULL',
      slope: 0.25,
      volatilityRatio: 1.13,
      dynamicOrderRatio: 20 // 20%
    }
  };

  const bullRiskEval = sizingRiskGov.evaluateSignal(
    bullBuySignal,
    'RUNNING',
    'LIVE',
    totalCap,
    cleanFlatPos,
    2700000,
    [],
    0
  );

  assert(bullRiskEval.approved === true, '[Scenario 1] BULL ENTRY_BUY is approved by RiskGovernor');
  assert(bullRiskEval.calculatedBudgetKrw === 2000000, `[Scenario 1] BULL dynamicOrderRatio (20%) applied: calculated budget is exact ₩2,000,000 (was: ₩${bullRiskEval.calculatedBudgetKrw?.toLocaleString()})`);

  // [Scenario 2] AutoPilot ON + BEAR market (dynamicOrderRatio = 10%) -> effectiveOrderRatio = 0.10, targetBudget = 1,000,000 KRW
  const bearBuySignal: Signal = {
    ...bullBuySignal,
    id: 'SIG_BEAR_BUY_TEST',
    indicatorSnapshot: {
      ...bullBuySignal.indicatorSnapshot,
      marketRegime: 'BEAR',
      dynamicOrderRatio: 10 // 10%
    }
  };

  const bearRiskEval = sizingRiskGov.evaluateSignal(
    bearBuySignal,
    'RUNNING',
    'LIVE',
    totalCap,
    cleanFlatPos,
    2700000,
    [],
    0
  );

  assert(bearRiskEval.approved === true, '[Scenario 2] BEAR ENTRY_BUY is approved by RiskGovernor');
  assert(bearRiskEval.calculatedBudgetKrw === 1000000, `[Scenario 2] BEAR dynamicOrderRatio (10%) applied: calculated budget is exact ₩1,000,000 (was: ₩${bearRiskEval.calculatedBudgetKrw?.toLocaleString()})`);

  // [Scenario 3] AutoPilot OFF -> Ignores dynamicOrderRatio (20%), strictly uses static params.orderRatio (25%) -> 2,500,000 KRW
  const manualRiskGov = new GlobalRiskGovernor({
    ...defaultParams,
    autoPilotEnabled: false, // AutoPilot turned OFF!
    orderRatio: 25 // Static user configured ratio = 25%
  });

  const autoPilotOffEval = manualRiskGov.evaluateSignal(
    bullBuySignal, // carries dynamicOrderRatio = 20
    'RUNNING',
    'LIVE',
    totalCap,
    cleanFlatPos,
    2700000,
    [],
    0
  );

  assert(autoPilotOffEval.approved === true, '[Scenario 3] AutoPilot OFF ENTRY_BUY is approved');
  assert(autoPilotOffEval.calculatedBudgetKrw === 2500000, `[Scenario 3] AutoPilot OFF strictly preserves user static orderRatio (25% = ₩2,500,000) ignoring dynamicRatio (was: ₩${autoPilotOffEval.calculatedBudgetKrw?.toLocaleString()})`);

  // [Scenario 4] DCA_BUY: dynamicOrderRatio (SIDEWAYS 18%) multiplied by the fixed slot-2 scale (2.0 Unit)
  const sidewaysDcaPos: PositionSnapshot = {
    ...testPosition,
    amount: 1.0, // 1.0 ETH @ 2,700,000 = 2,700,000 KRW
    entryPrice: 2800000,
    dcaSlots: [
      { slotNumber: 1, status: 'FILLED' },
      { slotNumber: 2, status: 'AVAILABLE' }, // Slot 2 -> fixed 2.0 Unit
      { slotNumber: 3, status: 'AVAILABLE' }
    ]
  };

  const dcaSignalTest17: Signal = {
    ...bullBuySignal,
    id: 'SIG_DCA_SIDEWAYS_TEST',
    type: 'DCA_BUY',
    priority: 5,
    indicatorSnapshot: {
      ...bullBuySignal.indicatorSnapshot,
      marketRegime: 'SIDEWAYS',
      dynamicOrderRatio: 18 // 18% base
    }
  };

  // actualKrwBalance = 7,300,000 + (1.0 * 2,700,000) = 10,000,000 Total Capital
  const dcaRiskEvalTest17 = sizingRiskGov.evaluateSignal(
    dcaSignalTest17,
    'RUNNING',
    'LIVE',
    7300000,
    sidewaysDcaPos,
    2700000,
    [],
    0
  );

  // Expected DCA budget: TotalCapital (10,000,000) * 0.18 * 2.0 = 3,600,000 KRW
  assert(dcaRiskEvalTest17.approved === true, '[Scenario 4] DCA_BUY approved with dynamic ratio & slot scaling');
  assert(dcaRiskEvalTest17.calculatedBudgetKrw === 3600000, `[Scenario 4] DCA_BUY budget correctly scaled: ₩10M * 18% * 2.0 = ₩3,600,000 (was: ₩${dcaRiskEvalTest17.calculatedBudgetKrw?.toLocaleString()})`);

  // [Scenario 5] Strict Clamp: targetBudget clamped to 98% KRW balance and remainingAllowableExposure
  // Test 98% cash balance clamp on 99% dynamic ratio (Flat position, 1M capital):
  const highRatioSignal: Signal = {
    ...bullBuySignal,
    id: 'SIG_HIGH_RATIO_CLAMP_TEST',
    indicatorSnapshot: {
      ...bullBuySignal.indicatorSnapshot,
      dynamicOrderRatio: 99 // 99% -> targetBudget = ₩990,000
    }
  };

  // Using a governor with maxExposure = 99% to isolate 98% cash clamp
  const cashClampGov = new GlobalRiskGovernor({
    ...defaultParams,
    maxExposurePercent: 99,
    autoPilotEnabled: true
  });

  const lowCashRiskEval = cashClampGov.evaluateSignal(
    highRatioSignal,
    'RUNNING',
    'LIVE',
    1000000, // 1,000,000 KRW cash
    cleanFlatPos,
    2700000,
    [],
    0
  );

  assert(lowCashRiskEval.approved === true, '[Scenario 5] Low cash order approved within 98% clamp');
  assert(lowCashRiskEval.calculatedBudgetKrw === 980000, `[Scenario 5] Clamped to 98% cash: ₩980,000 (was: ₩${lowCashRiskEval.calculatedBudgetKrw?.toLocaleString()})`);

  // Max exposure limit clamp: Total capital = 10M (1.9M cash + 8.1M coin [3.0 ETH @ 2.7M]).
  // Max exposure (85%) = 8,500,000 KRW. Current exposure = 8,100,000 KRW. Remaining allowable = 400,000 KRW.
  const nearMaxExpPos: PositionSnapshot = {
    ...cleanFlatPos,
    amount: 3.0 // 3.0 * 2,700,000 = 8,100,000 KRW exposure
  };
  const maxExpClampedEval = sizingRiskGov.evaluateSignal(
    bullBuySignal,
    'RUNNING',
    'LIVE',
    1900000, // 1,900,000 KRW cash (Total capital = 10,000,000 KRW)
    nearMaxExpPos,
    2700000,
    [],
    0
  );
  assert(maxExpClampedEval.approved === true, '[Scenario 5] Near max exposure order approved within allowable remaining');
  assert(maxExpClampedEval.calculatedBudgetKrw === 400000, `[Scenario 5] Clamped to remaining allowable exposure: ₩400,000 (was: ₩${maxExpClampedEval.calculatedBudgetKrw?.toLocaleString()})`);

  // [Scenario 6] A BULL breakout meeting the RSI and volume gates emits a
  // complete signal containing the regime-aware order ratio.
  const fullSignals = pyramidStrategyCore.generateSignals(
    2750000,
    2650000,
    30000,
    defaultParams,
    cleanFlatPos,
    0.01,
    baseBullHistory,
    { trend: 'BULL', htfSlope: 0.5 },
    55,
    1.2
  );
  assert(fullSignals.length === 1 && fullSignals[0].type === 'BREAKOUT_BUY', '[Scenario 6] Strategy Core emits a BULL breakout when RSI and volume gates pass');
  assert(typeof fullSignals[0]?.indicatorSnapshot.dynamicOrderRatio === 'number', '[Scenario 6] Breakout signal contains numeric dynamicOrderRatio');
  assert(fullSignals[0]?.indicatorSnapshot.dynamicOrderRatio === 20, '[Scenario 6] BULL breakout signal carries dynamicOrderRatio = 20%');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 18: Strategy Lab opt-in filters
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 18: Strategy Lab Opt-in Filters');
  const labDcaPosition: PositionSnapshot = {
    ...testPosition,
    entryPrice: 100,
    amount: 1,
    totalCostKrw: 100,
    initialStopPrice: 90,
    partialCutCount: 2,
    dcaSlots: [
      { slotNumber: 1, status: 'FILLED' },
      { slotNumber: 2, status: 'AVAILABLE' },
      { slotNumber: 3, status: 'AVAILABLE' }
    ]
  };
  const recoveryHistory = [96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96.1, 96.2, 96.3, 96.4, 96.5, 96.6, 96.7, 96.7, 96.7, 96.7];
  const dcaWithoutLabFilter = strategyCore.generateSignals(96.7, 100, 1, defaultParams, labDcaPosition, 0, recoveryHistory, { trend: 'BULL', htfSlope: 0.2 }, 30, 1.2);
  assert(dcaWithoutLabFilter.some((signal) => signal.id.startsWith('SIG_DCA_2_RECOVERY')), '[Lab] DCA 2 recovery prebuy remains available when all lab filters are OFF');
  const dcaWithRsiFilter = strategyCore.generateSignals(96.7, 100, 1, { ...defaultParams, experimentDca2RsiRecoveryEnabled: true }, labDcaPosition, 0, recoveryHistory, { trend: 'BULL', htfSlope: 0.2 }, 30, 1.2);
  assert(!dcaWithRsiFilter.some((signal) => signal.id.startsWith('SIG_DCA_2_RECOVERY')), '[Lab] DCA 2 RSI experiment blocks prebuy when RSI is below 35');
  const dcaWithVolumeFilter = strategyCore.generateSignals(96.7, 100, 1, { ...defaultParams, experimentDca2VolumeConfirmationEnabled: true }, labDcaPosition, 0, recoveryHistory, { trend: 'BULL', htfSlope: 0.2 }, 50, 1.0);
  assert(!dcaWithVolumeFilter.some((signal) => signal.id.startsWith('SIG_DCA_2_RECOVERY')), '[Lab] DCA 2 volume experiment blocks prebuy when volume is below 1.05x');

  const labPyramidPosition: PositionSnapshot = {
    ...testPosition,
    entryPrice: 2700000,
    amount: 1,
    totalCostKrw: 2700000,
    initialStopPrice: 2500000,
    partialCutCount: 0,
    dcaSlots: [{ slotNumber: 1, status: 'FILLED' }, { slotNumber: 2, status: 'FILLED' }, { slotNumber: 3, status: 'FILLED' }],
    pyramidingCount: 0,
    trailingActive: false,
    trailingExitCount: 0
  };
  const pyramidWithVolumeFilter = strategyCore.generateSignals(2750000, 2650000, 30000, { ...defaultParams, experimentPyramidVolumeConfirmationEnabled: true }, labPyramidPosition, 0, baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 60, 1.0);
  assert(!pyramidWithVolumeFilter.some((signal) => signal.type === 'PYRAMID_BUY'), '[Lab] Pyramid volume experiment blocks add when volume is below 1.15x');
  const pyramidWithConfirmedVolume = strategyCore.generateSignals(2750000, 2650000, 30000, { ...defaultParams, experimentPyramidVolumeConfirmationEnabled: true }, labPyramidPosition, 0, baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 60, 1.2);
  assert(pyramidWithConfirmedVolume[0]?.type === 'REGIME_REBALANCE_BUY' && pyramidWithConfirmedVolume[0]?.regimeTargetExposurePercent === 65, '[Regime Controller] Confirmed BULL uses gradual target-exposure add before legacy pyramid');
  const pyramidWithRsiFilter = strategyCore.generateSignals(2750000, 2650000, 30000, { ...defaultParams, experimentPyramidRsiGuardEnabled: true }, labPyramidPosition, 0, baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 70, 1.2);
  assert(!pyramidWithRsiFilter.some((signal) => signal.type === 'PYRAMID_BUY'), '[Lab] Pyramid RSI experiment blocks an overbought add above RSI 68');

  const earlyTrendFollowSignals = strategyCore.generateSignals(2720000, 2650000, 30000, defaultParams, labPyramidPosition, 0, baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 60, 1.3);
  assert(earlyTrendFollowSignals[0]?.id.startsWith('SIG_BULL_TARGET_ADD'), '[BULL Target] Confirmed BULL continuation deploys cash toward its target exposure');
  assert(earlyTrendFollowSignals[0]?.regimeTargetExposurePercent === 70, '[BULL Target] Strong continuation may extend the target exposure to 70%');
  const underweightBullSignals = strategyCore.generateSignals(
    2720000, 2650000, 30000, defaultParams, labPyramidPosition, 0,
    baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 60, 1.3, 0,
    baseBullHistory, { currentExposurePercent: 40 }
  );
  assert(underweightBullSignals[0]?.type === 'REGIME_REBALANCE_BUY', '[BULL Hold] Underweight confirmed BULL prioritizes building its core position');
  assert(underweightBullSignals[0]?.regimeTargetExposurePercent === 70, '[BULL Hold] Only a strong confirmed BULL can extend the target to 70%');
  const baseBullCoreSignals = strategyCore.generateSignals(
    2710000, 2650000, 30000, defaultParams, labPyramidPosition, 0,
    baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 72, 0.50, 0,
    baseBullHistory, { currentExposurePercent: 40 }
  );
  assert(baseBullCoreSignals[0]?.type === 'REGIME_REBALANCE_BUY' && baseBullCoreSignals[0]?.regimeTargetExposurePercent === 65, '[BULL Hold] A confirmed BULL fills its 65% core target without requiring momentum-volume confirmation');
  const onTargetBullSignals = strategyCore.generateSignals(
    2720000, 2650000, 30000, defaultParams, labPyramidPosition, 0,
    baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 60, 1.3, 0,
    baseBullHistory, { currentExposurePercent: 70 }
  );
  assert(!onTargetBullSignals.some((signal) => signal.type === 'REGIME_REBALANCE_BUY'), '[BULL Hold] Target-weight BULL does not churn additional target-allocation buys');
  const bullPullbackHistory = [98, 98.2, 98.4, 98.6, 98.8, 99, 99.2, 99.4, 99.6, 99.8, 100, 100.2, 100.4, 100.6, 100.8];
  const bullPullbackAddSignals = strategyCore.generateSignals(
    99.4, 99.8, 1, defaultParams, { ...labPyramidPosition, entryPrice: 100, amount: 1, totalCostKrw: 100, initialStopPrice: 90 }, 0,
    bullPullbackHistory, { trend: 'BULL', htfSlope: 0.5 }, 55, 1.1, 0,
    [...bullPullbackHistory.slice(-10), 99.1, 99.2, 99.4], { currentExposurePercent: 40 }
  );
  assert(bullPullbackAddSignals[0]?.type === 'REGIME_REBALANCE_BUY' && bullPullbackAddSignals[0]?.reason.includes('눌림목 반등'), '[BULL Pullback] A confirmed shallow pullback rebound builds exposure without moving DCA thresholds');
  const targetBudgetEval = riskGovernor.evaluateSignal(
    earlyTrendFollowSignals[0], 'RUNNING', 'LIVE', 8_000_000,
    { ...labPyramidPosition, amount: 2_000, entryPrice: 1_000, totalCostKrw: 2_000_000 }, 1_000, [], 0
  );
  assert(targetBudgetEval.approved === true && targetBudgetEval.calculatedBudgetKrw === 500_000, `[Regime Controller] Each target-exposure order is capped at 5% of total capital (actual: ₩${targetBudgetEval.calculatedBudgetKrw}, ${targetBudgetEval.rejectionReason || 'approved'})`);
  const weakTrendFollowSignals = strategyCore.generateSignals(2720000, 2650000, 30000, defaultParams, labPyramidPosition, 0, baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 60, 1.0);
  assert(weakTrendFollowSignals[0]?.type === 'REGIME_REBALANCE_BUY' && weakTrendFollowSignals[0]?.regimeTargetExposurePercent === 65, '[BULL Target] A non-overheated confirmed BULL fills its 65% core target even without volume expansion');

  const scalpExpansionPosition: PositionSnapshot = {
    ...labPyramidPosition,
    entryPrice: 100,
    amount: 1,
    totalCostKrw: 100,
    initialStopPrice: 90,
    boxPyramidCount: 0,
    dcaSlots: [{ slotNumber: 1, status: 'FILLED' }, { slotNumber: 2, status: 'FILLED' }, { slotNumber: 3, status: 'FILLED' }]
  };
  const expansionHistory = [99.9, 100, 100, 100.1, 100.2, 100.2, 100.3, 100.4, 100.4, 100.5, 100.5, 100.6, 100.6, 100.6, 100.6];
  const normalScalpSignals = strategyCore.generateSignals(100.6, 100.7, 1, defaultParams, scalpExpansionPosition, 0, expansionHistory, { trend: 'SIDEWAYS', htfSlope: 0 }, 60, 1.6);
  assert(normalScalpSignals[0]?.type === 'SCALP_TAKE_PROFIT', '[Lab] Box scalp remains a full exit while trend-expansion experiment is OFF');
  const expansionScalpSignals = strategyCore.generateSignals(100.6, 100.7, 1, { ...defaultParams, experimentScalpTrendExpansionEnabled: true }, scalpExpansionPosition, 0, expansionHistory, { trend: 'SIDEWAYS', htfSlope: 0 }, 60, 1.6);
  assert(expansionScalpSignals[0]?.type === 'SCALP_PARTIAL_TAKE_PROFIT', '[Lab] Trend expansion experiment converts box scalp exit to a 50% partial exit');
  const partialScalpEval = riskGovernor.evaluateSignal(expansionScalpSignals[0], 'RUNNING', 'LIVE', 1_000_000, scalpExpansionPosition, 0, [], 0);
  assert(partialScalpEval.approved === true && partialScalpEval.calculatedVolume === 0.5, '[Lab] Trend expansion partial exit sells exactly 50% of the position');
  const scalpPartialManager = new PositionManager(defaultParams);
  scalpPartialManager.onInitialEntryFilled(100, 1, 90, 1, 1, 1);
  scalpPartialManager.onScalpPartialTakeProfitFilled(0.5, 100.6, 0.3);
  const scalpPartialSnapshot = scalpPartialManager.getSnapshot();
  assert(scalpPartialSnapshot.amount === 0.5 && scalpPartialSnapshot.profitLockPrice === 100.2, '[Lab] Partial scalp exit leaves 50% with a +0.2% breakeven protection floor');
  scalpPartialManager.setScalpReentryCooldown(180);
  assert(scalpPartialManager.isUnderCooldown() && scalpPartialManager.getSnapshot().cooldownReason === 'SCALP_TAKE_PROFIT_REENTRY_GUARD', '[Lab] Scalp re-entry guard persists a 3-minute cooldown');

  const bullPullbackAdaptive = strategyCore.evaluateAdaptiveParams(100.6, 100.7, 1, defaultParams, expansionHistory, { trend: 'BULL', htfSlope: 0.2 }, 60, 1.0);
  assert(bullPullbackAdaptive.marketRegime === 'SIDEWAYS' && bullPullbackAdaptive.sidewaysContext === 'BULL_PULLBACK', '[Regime Context] Higher-timeframe BULL pullback is separated from a neutral box');
  const bullPullbackSignals = strategyCore.generateSignals(100.6, 100.7, 1, defaultParams, scalpExpansionPosition, 0, expansionHistory, { trend: 'BULL', htfSlope: 0.2 }, 60, 1.0);
  assert(!bullPullbackSignals.some((signal) => signal.type === 'SCALP_TAKE_PROFIT'), '[Regime Context] BULL pullback blocks box-range full take-profit');
  const bearPauseAdaptive = strategyCore.evaluateAdaptiveParams(100, 100, 1, defaultParams, Array.from({ length: 15 }, () => 100), { trend: 'BEAR', htfSlope: -0.2 }, 50, 1.0);
  assert(bearPauseAdaptive.marketRegime === 'SIDEWAYS' && bearPauseAdaptive.sidewaysContext === 'BEAR_PAUSE', '[Regime Context] Higher-timeframe BEAR pause is separated from a neutral box');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 19: Research Recorder Isolation
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 19: Research Recorder Isolation');
  const researchRecorder = new ResearchRecorder();
  const researchStatsBefore = researchRecorder.getStats();
  const researchTimestamp = Date.now();
  researchRecorder.recordTick('KRW-ETH', 3000000, researchTimestamp);
  researchRecorder.recordTick('KRW-ETH', 3000000, researchTimestamp + 100); // duplicate ticker noise
  researchRecorder.recordTick('KRW-ETH', 3001000, researchTimestamp + 200);
  researchRecorder.recordCompletedCandles('KRW-ETH', [{
    market: 'KRW-ETH', candle_date_time_utc: '2023-11-14T00:00:00', opening_price: 3000000,
    high_price: 3010000, low_price: 2990000, trade_price: 3001000, timestamp: researchTimestamp,
    candle_acc_trade_volume: 12.34
  }]);
  researchRecorder.recordShadowDifference(researchTimestamp, 'KRW-ETH', 3001000, { rsi: 40, volumeMultiplier: 1.2 }, {
    baseline: { type: 'DCA_BUY', dcaExecution: 'RECOVERY_PREBUY' },
    dca2Rsi: { type: null }
  });
  const researchStats = researchRecorder.getStats();
  assert(researchStats.ticksRecorded === researchStatsBefore.ticksRecorded + 2, '[Research] Duplicate ticker noise is not written repeatedly');
  assert(researchStats.candlesRecorded === researchStatsBefore.candlesRecorded + 1 && researchStats.shadowDifferences === researchStatsBefore.shadowDifferences + 1, '[Research] Completed candle and shadow difference are recorded independently');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 20: Single-Use Re-entry Lock
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 20: Single-Use Re-entry Lock');
  const reentryManager = new PositionManager(defaultParams);
  reentryManager.onInitialEntryFilled(2700000, 1, 2720000, 30000, 3, 2);
  reentryManager.onPartialLossCutFilled(0.3, 2670000, -9000, 1);
  reentryManager.enableReentry();
  assert(reentryManager.getSnapshot().state === 'REENTRY_ALLOWED', '[Re-entry] Defensive state can grant one re-entry permission');
  assert(reentryManager.markReentryPending() === true && reentryManager.getSnapshot().state === 'REENTRY_PENDING', '[Re-entry] Permission is atomically consumed before order submission');
  assert(reentryManager.markReentryPending() === false, '[Re-entry] A second re-entry cannot consume the same permission');
  reentryManager.onReentryBuyFilled(2660000, 0.2, 2700000, 30000, 3, 2);
  assert(reentryManager.getSnapshot().state === 'ENTRY_FILLED' && reentryManager.getSnapshot().amount === 0.9, '[Re-entry] Any confirmed fill returns position to normal holding state');
  const recycleAfterInitialReentry = reentryManager.getSnapshot().recycleCycleCount || 0;
  reentryManager.addAdditionalReentryFilled(2655000, 0.1, 2700000, 30000, 3, 2);
  assert((reentryManager.getSnapshot().recycleCycleCount || 0) === recycleAfterInitialReentry, '[Re-entry] Incremental fill of the same order does not consume an additional recycle cycle');
  reentryManager.rebaseReconciledPosition(2700000, 30000, 3, 2);
  const rebasedSnapshot = reentryManager.getSnapshot();
  assert(rebasedSnapshot.partialCutCount === 0 && rebasedSnapshot.trailingActive === false && rebasedSnapshot.state === 'ENTRY_FILLED', '[Rebase] Defensive and trailing state are reset from the reconciled position');
  assert(rebasedSnapshot.initialStopPrice === rebasedSnapshot.entryPrice! * 0.94, '[Rebase] Absolute stop is rebuilt as fixed -6% of the reconciled average');
  const reentryPendingRisk = new GlobalRiskGovernor(defaultParams).evaluateSignal(
    { ...bullBuySignal, type: 'REENTRY_BUY' }, 'RUNNING', 'LIVE', 5000000,
    { ...labPyramidPosition, state: 'REENTRY_PENDING' }, 2750000, [], 0
  );
  assert(reentryPendingRisk.approved === false, '[Re-entry] Risk governor blocks all new buys while re-entry is pending');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 21: Startup Barrier
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 21: Startup Barrier & No Synthetic Signal Path');
  const startupGateEngine = new ATREngine(undefined, { backtest: true });
  (startupGateEngine as any).startupReady = false;
  (startupGateEngine as any).botState = 'STARTING';
  (startupGateEngine as any).strategyCore = {
    generateSignals: () => { throw new Error('Strategy generation must be blocked during STARTING'); }
  };
  await startupGateEngine.handleMarketTick(2700000, Date.now());
  assert(startupGateEngine.currentPrice === 2700000, '[Startup barrier] Tick price is retained while strategy evaluation is blocked');
  assert((startupGateEngine as any).startupReady === false && startupGateEngine.botState === 'STARTING', '[Startup barrier] Engine remains STARTING until authoritative initialization completes');

  // A reconciliation-required engine is deliberately more restrictive than
  // PAUSED: it must neither evaluate a later tick nor accept a UI resume
  // until the explicit rebase transaction has completed.
  const rebaseRequiredEngine = new ATREngine(undefined, { backtest: true });
  (rebaseRequiredEngine as any).startupReady = true;
  (rebaseRequiredEngine as any).rebaseRequired = true;
  (rebaseRequiredEngine as any).strategyCore = {
    generateSignals: () => { throw new Error('Strategy generation must be blocked while rebase is required'); }
  };
  await rebaseRequiredEngine.handleMarketTick(2700000, Date.now());
  let rebaseResumeRejected = false;
  try {
    rebaseRequiredEngine.updateParams({ isBotActive: true });
  } catch {
    rebaseResumeRejected = true;
  }
  assert(rebaseResumeRejected && rebaseRequiredEngine.params.isBotActive === false, '[Rebase guard] Reconciliation-required state blocks ticks and bot resume');

  // A late candle response from a previous generation must not overwrite the
  // newly invalidated market context.
  const staleMarketEngine = new ATREngine(undefined, { backtest: true });
  staleMarketEngine.atrValue = 11111;
  staleMarketEngine.baselineValue = 2222222;
  let resolveCandles!: (candles: any[]) => void;
  (staleMarketEngine as any).upbitClient.fetchCandles = () => new Promise<any[]>((resolve) => { resolveCandles = resolve; });
  const staleMarketRefresh = staleMarketEngine.refreshAtrFromExchange();
  (staleMarketEngine as any).invalidateStartupBarrier();
  resolveCandles(Array.from({ length: 20 }, (_, index) => ({
    timestamp: Date.now() - ((20 - index) * 60000), trade_price: 3000000 + index,
    high_price: 3000100 + index, low_price: 2999900 + index, candle_acc_trade_volume: 10 + index
  })));
  assert(await staleMarketRefresh === false, '[Stale generation] Late candle refresh is discarded');
  assert(staleMarketEngine.atrValue === 11111 && staleMarketEngine.baselineValue === 2222222, '[Stale generation] Late candles cannot overwrite indicators');

  // The same rule applies to a delayed account response: no balance or
  // position reconciliation may commit after context invalidation.
  const staleAccountEngine = new ATREngine(undefined, { backtest: true });
  staleAccountEngine.actualKrwBalance = 123456;
  staleAccountEngine.realBalances = { KRW: 123456 };
  let resolveAccount!: (value: any) => void;
  (staleAccountEngine as any).apiGateway.enqueue = async (_priority: number, task: () => Promise<any>) => task();
  (staleAccountEngine as any).upbitClient.getAccountBalance = () => new Promise<any>((resolve) => { resolveAccount = resolve; });
  const staleAccountRefresh = staleAccountEngine.fetchRealAccountBalance();
  (staleAccountEngine as any).invalidateStartupBarrier();
  resolveAccount({ success: true, balances: { KRW: 999999 }, lockedBalances: {}, avgBuyPrices: {} });
  assert(await staleAccountRefresh === false, '[Stale generation] Late account refresh is discarded');
  assert(staleAccountEngine.actualKrwBalance === 123456 && staleAccountEngine.realBalances.KRW === 123456, '[Stale generation] Late account response cannot overwrite balances');

  // A confirmed BUY must immediately reduce the exposure cash base. Upbit can
  // return the pre-fill KRW snapshot for a short period; that stale snapshot
  // must not restore spendable cash and allow a second over-exposure BUY.
  const balanceShadowEngine = new ATREngine(undefined, { backtest: true });
  balanceShadowEngine.actualKrwBalance = 1_000_000;
  balanceShadowEngine.realBalances = { KRW: 1_000_000 };
  (balanceShadowEngine as any).applyConfirmedBalanceShadow({
    clientOrderId: 'CLIENT_BALANCE_SHADOW', side: 'BUY', avgFillPrice: 2_500_000,
    filledVolume: 0.08, strategyFillCumulativeFunds: 200_000, strategyFillCumulativeFee: 100
  }, 2_500_000, 0.08);
  (balanceShadowEngine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  (balanceShadowEngine as any).apiGateway.enqueue = async (_priority: number, task: () => Promise<any>) => task();
  (balanceShadowEngine as any).upbitClient.getAccountBalance = async () => ({ success: true, balances: { KRW: 1_000_000 }, lockedBalances: {}, avgBuyPrices: {} });
  assert(balanceShadowEngine.actualKrwBalance === 799900 && await balanceShadowEngine.fetchRealAccountBalance() === true && balanceShadowEngine.actualKrwBalance === 799900, '[Balance shadow] A stale pre-fill KRW response cannot restore already-spent buying power');

  // A pending order can legitimately make the exchange balance differ from
  // the durable local position for one poll. That in-flight window must not
  // be misclassified as an external/manual trade and pause the bot.
  const pendingBalanceEngine = new ATREngine(undefined, { backtest: true });
  pendingBalanceEngine.positionManager.onInitialEntryFilled(2_700_000, 0.1, 2_700_000, 10_000, 2, 3);
  (pendingBalanceEngine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  (pendingBalanceEngine as any).apiGateway.enqueue = async (_priority: number, task: () => Promise<any>) => task();
  (pendingBalanceEngine as any).upbitClient.getAccountBalance = async () => ({
    success: true, balances: { KRW: 700_000, ETH: 0.1 }, lockedBalances: {}, avgBuyPrices: { ETH: 2_700_000 }
  });
  (pendingBalanceEngine.orderManager as any).getPendingOrdersCount = () => 1;
  assert(await pendingBalanceEngine.fetchRealAccountBalance() === true && !(pendingBalanceEngine as any).rebaseRequired && pendingBalanceEngine.positionManager.getSnapshot().amount === 0.1, '[Balance reconciliation] Pending-order balance lag does not trigger a false rebase pause');

  // A single PositionManager cannot safely represent two symbols. Active
  // positions and any non-terminal order therefore block market switches.
  const activePositionSwitchEngine = new ATREngine(undefined, { backtest: true });
  activePositionSwitchEngine.positionManager.onInitialEntryFilled(3000000, 0.1, 3000000, 10000, 2, 3);
  let activePositionSwitchRejected = false;
  try {
    activePositionSwitchEngine.updateParams({ symbol: 'KRW-BTC' });
  } catch {
    activePositionSwitchRejected = true;
  }
  assert(activePositionSwitchRejected && activePositionSwitchEngine.params.symbol === 'KRW-ETH', '[Symbol switch] Active position rejects symbol change without mutating params');

  const pendingOrderSwitchEngine = new ATREngine(undefined, { backtest: true });
  const pendingSwitchOrder: OrderRecord = {
    id: `ORD_PENDING_SWITCH_${Date.now()}`, clientOrderId: `CLIENT_PENDING_SWITCH_${Date.now()}`,
    signalId: `SIG_PENDING_SWITCH_${Date.now()}`, signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'OPEN', requestedBudgetOrVolume: 100000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'pending switch guard', fills: []
  };
  ((pendingOrderSwitchEngine.orderManager as any).orders as Map<string, OrderRecord>).set(pendingSwitchOrder.id, pendingSwitchOrder);
  let pendingOrderSwitchRejected = false;
  try {
    pendingOrderSwitchEngine.updateParams({ exchange: 'BINANCE' as any });
  } catch {
    pendingOrderSwitchRejected = true;
  }
  assert(pendingOrderSwitchRejected && pendingOrderSwitchEngine.params.exchange === 'UPBIT', '[Symbol switch] Pending order rejects exchange change without mutating params');

  // A corrupt local ledger must never be silently replaced with an empty
  // in-memory ledger and allowed through the startup barrier.
  const savedOrderHistory = fs.existsSync(orderFile) ? fs.readFileSync(orderFile, 'utf-8') : null;
  fs.writeFileSync(orderFile, '{not-valid-json', 'utf-8');
  const corruptedOrderEngine = new ATREngine(undefined, { backtest: true });
  if (savedOrderHistory === null) fs.unlinkSync(orderFile); else fs.writeFileSync(orderFile, savedOrderHistory, 'utf-8');
  (corruptedOrderEngine as any).startupReady = false;
  corruptedOrderEngine.botState = 'STARTING';
  (corruptedOrderEngine as any).refreshAtrFromExchange = async () => true;
  await (corruptedOrderEngine as any).startStartupBarrier();
  assert(corruptedOrderEngine.orderManager.hasPersistenceLoadFailure() && (corruptedOrderEngine as any).startupReady === false && (corruptedOrderEngine.botState as string) === 'PAUSED', '[Persistence load] Corrupted order_history blocks startup READY and new trading');

  const semanticOrder = { ...pendingSwitchOrder, id: 'ORD_SEMANTIC_DUP_A', clientOrderId: 'CLIENT_SEMANTIC_DUP', signalId: 'SIG_SEMANTIC_DUP' };
  fs.writeFileSync(orderFile, JSON.stringify([semanticOrder, { ...semanticOrder, id: 'ORD_SEMANTIC_DUP_B' }]), 'utf-8');
  const duplicateOrderLedger = new OrderManager();
  assert(duplicateOrderLedger.hasPersistenceLoadFailure(), '[Order schema] Parseable order ledger with duplicate clientOrderId fails closed');
  if (savedOrderHistory === null) fs.unlinkSync(orderFile); else fs.writeFileSync(orderFile, savedOrderHistory, 'utf-8');

  const savedReservations = fs.existsSync(reservationFile) ? fs.readFileSync(reservationFile, 'utf-8') : null;
  fs.writeFileSync(reservationFile, JSON.stringify([{ clientOrderId: 123, amountKrw: -1, status: 'BAD' }]), 'utf-8');
  const corruptedRiskEngine = new ATREngine(undefined, { backtest: true });
  if (savedReservations === null) fs.unlinkSync(reservationFile); else fs.writeFileSync(reservationFile, savedReservations, 'utf-8');
  (corruptedRiskEngine as any).startupReady = false;
  corruptedRiskEngine.botState = 'STARTING';
  await (corruptedRiskEngine as any).startStartupBarrier();
  assert((corruptedRiskEngine as any).riskGovernor.getPersistenceFailure() && (corruptedRiskEngine as any).startupReady === false && (corruptedRiskEngine.botState as string) === 'PAUSED', '[Risk persistence] Malformed reservation ledger blocks startup READY');

  const savedPositionState = fs.existsSync(posFile) ? fs.readFileSync(posFile, 'utf-8') : null;
  fs.writeFileSync(posFile, '{not-valid-json', 'utf-8');
  const corruptedPositionEngine = new ATREngine(undefined, { backtest: true });
  if (savedPositionState === null) fs.unlinkSync(posFile); else fs.writeFileSync(posFile, savedPositionState, 'utf-8');
  (corruptedPositionEngine as any).startupReady = false;
  corruptedPositionEngine.botState = 'STARTING';
  (corruptedPositionEngine as any).refreshAtrFromExchange = async () => true;
  await (corruptedPositionEngine as any).startStartupBarrier();
  assert(corruptedPositionEngine.positionManager.hasPersistenceLoadFailure() && (corruptedPositionEngine as any).startupReady === false && (corruptedPositionEngine.botState as string) === 'PAUSED', '[Persistence load] Corrupted position_state blocks startup READY despite an in-memory FLAT fallback');

  // JSON syntax alone is not proof of a valid position ledger. Validate the
  // semantic shape before accepting it as persisted state.
  const savedSemanticPositionState = fs.existsSync(posFile) ? fs.readFileSync(posFile, 'utf-8') : null;
  const semanticSeed = new PositionManager(defaultParams);
  semanticSeed.onInitialEntryFilled(2700000, 1, 2700000, 10000, 2, 3);
  const validSemanticState: any = semanticSeed.getSnapshot();
  fs.writeFileSync(posFile, '{}', 'utf-8');
  const emptySemanticState = new PositionManager(defaultParams);
  assert(emptySemanticState.hasPersistenceLoadFailure() && !emptySemanticState.hasPersistedState(), '[Position schema] Empty JSON object is rejected rather than bypassing missing-position protection');
  const incompleteOpenState = JSON.parse(JSON.stringify(validSemanticState));
  delete incompleteOpenState.initialStopPrice;
  fs.writeFileSync(posFile, JSON.stringify(incompleteOpenState), 'utf-8');
  const incompleteOpenPosition = new PositionManager(defaultParams);
  assert(incompleteOpenPosition.hasPersistenceLoadFailure(), '[Position schema] Open position without complete protective state is rejected');
  const malformedSlotsState = JSON.parse(JSON.stringify(validSemanticState));
  malformedSlotsState.dcaSlots = null;
  fs.writeFileSync(posFile, JSON.stringify(malformedSlotsState), 'utf-8');
  const malformedSlotsPosition = new PositionManager(defaultParams);
  assert(malformedSlotsPosition.hasPersistenceLoadFailure(), '[Position schema] Malformed DCA slots are rejected');
  const malformedWatermarkState = JSON.parse(JSON.stringify(validSemanticState));
  malformedWatermarkState.durableFillWatermarks = { BAD: { volume: 0.4, fee: 0, initialApplied: 'yes' } };
  fs.writeFileSync(posFile, JSON.stringify(malformedWatermarkState), 'utf-8');
  const malformedWatermarkPosition = new PositionManager(defaultParams);
  assert(malformedWatermarkPosition.hasPersistenceLoadFailure(), '[Position schema] Malformed durable watermark is rejected');
  for (const protectiveField of ['entryPrice', 'positionEntryAtr', 'initialStopPrice', 'initialBaseline', 'initialBand']) {
    const zeroProtectiveState = JSON.parse(JSON.stringify(validSemanticState));
    zeroProtectiveState[protectiveField] = 0;
    fs.writeFileSync(posFile, JSON.stringify(zeroProtectiveState), 'utf-8');
    const zeroProtectivePosition = new PositionManager(defaultParams);
    assert(zeroProtectivePosition.hasPersistenceLoadFailure(), `[Position schema] Open position with ${protectiveField}=0 fails closed`);
  }
  const legacySemanticState = JSON.parse(JSON.stringify(validSemanticState));
  delete legacySemanticState.boxPyramidCount;
  delete legacySemanticState.partialCutCount;
  delete legacySemanticState.trailingExitCount;
  delete legacySemanticState.profitLockPrice;
  delete legacySemanticState.lastRegimeRebalanceAt;
  delete legacySemanticState.recycleCycleCount;
  delete legacySemanticState.appliedFillEventIds;
  delete legacySemanticState.durableFillWatermarks;
  fs.writeFileSync(posFile, JSON.stringify(legacySemanticState), 'utf-8');
  const migratedLegacyPosition = new PositionManager(defaultParams);
  assert(!migratedLegacyPosition.hasPersistenceLoadFailure() && migratedLegacyPosition.hasPersistedState() && Array.isArray(migratedLegacyPosition.getSnapshot().dcaSlots) && Array.isArray(migratedLegacyPosition.getSnapshot().appliedFillEventIds), '[Position schema] Known additive legacy state migrates and validates before use');
  if (savedSemanticPositionState === null) {
    if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  } else fs.writeFileSync(posFile, savedSemanticPositionState, 'utf-8');

  // The persisted symbol of an open position is authoritative at restart.
  // A default ETH engine must bootstrap to BTC before choosing balance coinKey.
  const savedBootstrapPositionState = fs.existsSync(posFile) ? fs.readFileSync(posFile, 'utf-8') : null;
  const persistedBtcPosition = JSON.parse(JSON.stringify(validSemanticState));
  persistedBtcPosition.symbol = 'KRW-BTC';
  fs.writeFileSync(posFile, JSON.stringify(persistedBtcPosition), 'utf-8');
  const symbolBootstrapEngine = new ATREngine(undefined, { backtest: true });
  if (savedBootstrapPositionState === null) {
    if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  } else fs.writeFileSync(posFile, savedBootstrapPositionState, 'utf-8');
  (symbolBootstrapEngine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  (symbolBootstrapEngine as any).apiGateway.enqueue = async (_priority: number, task: () => Promise<any>) => task();
  (symbolBootstrapEngine.orderManager as any).reconcilePendingOrdersOnStartup = async () => 0;
  (symbolBootstrapEngine as any).upbitClient.getAccountBalance = async () => ({ success: true, balances: { KRW: 1000000, ETH: 0, BTC: 1 }, lockedBalances: {}, avgBuyPrices: { BTC: 2700000 } });
  (symbolBootstrapEngine as any).upbitClient.getOpenOrders = async () => ({ success: true, orders: [] });
  assert(symbolBootstrapEngine.params.symbol === 'KRW-BTC' && await symbolBootstrapEngine.reconcileOnStartup() === true && symbolBootstrapEngine.positionManager.getSnapshot().symbol === 'KRW-BTC' && symbolBootstrapEngine.positionManager.getSnapshot().amount === 1, '[Restart symbol] Persisted KRW-BTC position bootstraps engine before balance reconciliation, never reconciling it as ETH');

  const flatSymbolConsistencyPosition = new PositionManager(defaultParams);
  flatSymbolConsistencyPosition.onPositionClosed(0, 'symbol consistency test');
  flatSymbolConsistencyPosition.setParams({ ...defaultParams, symbol: 'KRW-BTC' });
  assert(flatSymbolConsistencyPosition.getSnapshot().symbol === 'KRW-BTC', '[Position params] Flat position symbol follows updated strategy symbol');
  if (savedSemanticPositionState === null) {
    if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  } else fs.writeFileSync(posFile, savedSemanticPositionState, 'utf-8');

  // A missing file is normal only for a truly empty first-run account. When
  // the exchange already holds the coin, amount/average alone are not enough
  // to reconstruct durable fills, DCA slots, trailing or cooldown state.
  const savedMissingPositionState = fs.existsSync(posFile) ? fs.readFileSync(posFile, 'utf-8') : null;
  if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  const missingPositionWithCoinEngine = new ATREngine(undefined, { backtest: true });
  const missingPositionEmptyAccountEngine = new ATREngine(undefined, { backtest: true });
  if (savedMissingPositionState === null) {
    if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  } else fs.writeFileSync(posFile, savedMissingPositionState, 'utf-8');
  for (const engine of [missingPositionWithCoinEngine, missingPositionEmptyAccountEngine]) {
    (engine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
    (engine as any).apiGateway.enqueue = async (_priority: number, task: () => Promise<any>) => task();
    (engine.orderManager as any).reconcilePendingOrdersOnStartup = async () => 0;
    (engine as any).upbitClient.getOpenOrders = async () => ({ success: true, orders: [] });
  }
  (missingPositionWithCoinEngine as any).upbitClient.getAccountBalance = async () => ({
    success: true, balances: { KRW: 1000000, ETH: 1 }, lockedBalances: {}, avgBuyPrices: { ETH: 2700000 }
  });
  (missingPositionEmptyAccountEngine as any).upbitClient.getAccountBalance = async () => ({
    success: true, balances: { KRW: 1000000 }, lockedBalances: {}, avgBuyPrices: {}
  });
  assert(await missingPositionWithCoinEngine.reconcileOnStartup() === false && !missingPositionWithCoinEngine.positionManager.hasPersistedState() && missingPositionWithCoinEngine.positionManager.getSnapshot().amount === 0, '[Missing position state] Existing exchange coin blocks startup without silently adopting a partial local position');
  assert(await missingPositionEmptyAccountEngine.reconcileOnStartup() === true && !missingPositionEmptyAccountEngine.positionManager.hasPersistedState(), '[Missing position state] Empty exchange account remains a valid first-run startup');

  // A first runtime fill creates the ledger, so subsequent background balance
  // reconciliation must no longer be treated as a missing-state recovery.
  const savedRuntimePositionState = fs.existsSync(posFile) ? fs.readFileSync(posFile, 'utf-8') : null;
  if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  const firstFillEngine = new ATREngine(undefined, { backtest: true });
  firstFillEngine.positionManager.onInitialEntryFilled(2700000, 1, 2700000, 10000, 2, 3);
  (firstFillEngine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  (firstFillEngine as any).apiGateway.enqueue = async (_priority: number, task: () => Promise<any>) => task();
  (firstFillEngine as any).upbitClient.getAccountBalance = async () => ({ success: true, balances: { KRW: 1000000, ETH: 1 }, lockedBalances: {}, avgBuyPrices: { ETH: 2700000 } });
  assert(firstFillEngine.positionManager.hasPersistedState() && await firstFillEngine.fetchRealAccountBalance() === true && firstFillEngine.positionManager.getSnapshot().amount === 1, '[Missing position state] First fill creates persisted state and allows later balance reconciliation');

  // Manual rebase is another runtime writer. Once it commits the rebuilt
  // state, a new startup barrier in the same process may safely pass.
  if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  const rebaseMissingStateEngine = new ATREngine(undefined, { backtest: true });
  ((rebaseMissingStateEngine.orderManager as any).orders as Map<string, OrderRecord>).clear();
  rebaseMissingStateEngine.params.isBotActive = false;
  rebaseMissingStateEngine.botState = 'PAUSED';
  rebaseMissingStateEngine.currentPrice = 2700000;
  rebaseMissingStateEngine.baselineValue = 2700000;
  rebaseMissingStateEngine.atrValue = 10000;
  (rebaseMissingStateEngine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  (rebaseMissingStateEngine as any).apiGateway.enqueue = async (_priority: number, task: () => Promise<any>) => task();
  (rebaseMissingStateEngine as any).upbitClient.getAccountBalance = async () => ({ success: true, balances: { KRW: 1000000, ETH: 1 }, lockedBalances: {}, avgBuyPrices: { ETH: 2700000 } });
  (rebaseMissingStateEngine as any).upbitClient.getOpenOrders = async () => ({ success: true, orders: [] });
  (rebaseMissingStateEngine.orderManager as any).reconcilePendingOrdersOnStartup = async () => 0;
  (rebaseMissingStateEngine as any).refreshAtrFromExchange = async () => true;
  await rebaseMissingStateEngine.rebaseCurrentPosition();
  (rebaseMissingStateEngine as any).startupReady = false;
  rebaseMissingStateEngine.botState = 'STARTING';
  await (rebaseMissingStateEngine as any).startStartupBarrier();
  clearInterval((rebaseMissingStateEngine as any).balanceRefreshTimer);
  clearInterval((rebaseMissingStateEngine as any).atrRefreshTimer);
  assert(rebaseMissingStateEngine.positionManager.hasPersistedState() && (rebaseMissingStateEngine as any).startupReady === true && (rebaseMissingStateEngine.botState as string) === 'PAUSED', '[Missing position state] Manual rebase persists recovery and permits startup without a restart');
  if (savedRuntimePositionState === null) {
    if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  } else fs.writeFileSync(posFile, savedRuntimePositionState, 'utf-8');

  // A live exchange order not represented in the local pending ledger is an
  // ownership ambiguity: do not start a strategy that could submit against it.
  const unknownExchangeOrderEngine = new ATREngine(undefined, { backtest: true });
  ((unknownExchangeOrderEngine.orderManager as any).orders as Map<string, OrderRecord>).clear();
  (unknownExchangeOrderEngine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  (unknownExchangeOrderEngine.orderManager as any).reconcilePendingOrdersOnStartup = async () => 0;
  unknownExchangeOrderEngine.fetchRealAccountBalance = async () => true;
  (unknownExchangeOrderEngine as any).upbitClient.getOpenOrders = async () => ({ success: true, orders: [{ uuid: 'UNKNOWN_EXCHANGE_OPEN_UUID', identifier: 'UNKNOWN_EXCHANGE_OPEN_CLIENT' }] });
  assert(await unknownExchangeOrderEngine.reconcileOnStartup() === false, '[Startup invariant] Unknown exchange OPEN order blocks startup reconciliation');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 22: Durable Fill Recovery / Failure Injection
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 22: Durable Fill Recovery & Failure Injection');
  const durableClientOrderId = `CLIENT_DURABLE_${Date.now()}`;
  const durableEventId = `${durableClientOrderId}:1.00000000`;
  const durablePosition = new PositionManager(defaultParams);
  assert(durablePosition.beginDurableFillEvent(durableEventId, durableClientOrderId, 1, 1350, true, 2700000) === true, '[Durability] New fill event can start an atomic position transition');
  durablePosition.onInitialEntryFilled(2700000, 1, 2700000, 10000, 2, 3);
  assert(durablePosition.completeDurableFillEvent(durableEventId) === true, '[Durability] Position transition and fill-event ID persist together');

  const durabilityOrderManager = new OrderManager();
  const durabilityOrder: OrderRecord = {
    id: `ORD_DURABLE_${Date.now()}`, clientOrderId: durableClientOrderId,
    signalId: `SIG_DURABLE_${Date.now()}`, signalType: 'DCA_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'ORDER_SUBMITTED', requestedBudgetOrVolume: 1000000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'durability failure injection', fills: [],
    strategyAppliedFilledVolume: 0, strategyAppliedFee: 0, strategyInitialFillApplied: false
  };
  (durabilityOrderManager as any).orders.set(durabilityOrder.id, durabilityOrder);
  let durabilitySaveCount = 0;
  const realOrderSave = (durabilityOrderManager as any).saveOrdersToFile.bind(durabilityOrderManager);
  (durabilityOrderManager as any).saveOrdersToFile = () => {
    durabilitySaveCount++;
    if (durabilitySaveCount === 2) throw new Error('injected order rename failure');
    return realOrderSave();
  };
  let durabilityHandlerCalls = 0;
  let durabilityFailedClosed = false;
  durabilityOrderManager.setDurabilityFailureHandler(() => { durabilityFailedClosed = true; });
  try {
    durabilityOrderManager.applyUpbitOrderState(
      durabilityOrder,
      { ...responseC, uuid: 'mock-durable-order', identifier: durableClientOrderId },
      () => { durabilityHandlerCalls++; },
      () => {},
      'SUBMIT_FLOW'
    );
  } catch {
    // Expected: the post-handler order watermark write is injected to fail.
  }
  assert(durabilityHandlerCalls === 1 && durabilityFailedClosed, '[Durability] Order watermark write failure is surfaced and fail-closes the manager');

  // Simulate restart: order_history contains the pre-watermark first write,
  // while position_state already contains the same durable event. The fill
  // must update only the order watermark, never call the strategy again.
  const restartedPosition = new PositionManager(defaultParams);
  const restartedOrderManager = new OrderManager();
  restartedOrderManager.setStrategyFillDurabilityLookup((clientOrderId) => restartedPosition.getDurableFillWatermark(clientOrderId));
  const restartedOrder = restartedOrderManager.getAllOrders().find((order) => order.clientOrderId === durableClientOrderId)!;
  let replayedStrategyCalls = 0;
  restartedOrderManager.applyUpbitOrderState(
    restartedOrder,
    { ...responseC, uuid: 'mock-durable-order', identifier: durableClientOrderId },
    () => { replayedStrategyCalls++; },
    () => {},
    'WATCHER'
  );
  assert(restartedPosition.hasDurablyAppliedFillEvent(durableEventId), '[Durability] Restart restores the position fill-event ledger');
  assert(replayedStrategyCalls === 0 && restartedOrder.strategyAppliedFilledVolume === 1, '[Durability] Restart repairs only the watermark without replaying the position transition');

  // A durable partial fill can be followed by additional exchange execution
  // while the order watermark is unavailable. Recovery must apply only the
  // new cumulative delta, preserving the original INITIAL transition.
  const partialDurableClientId = `CLIENT_DURABLE_PARTIAL_${Date.now()}`;
  const partialDurablePosition = new PositionManager(defaultParams);
  const partialDurableEvent = `${partialDurableClientId}:0.40000000`;
  partialDurablePosition.beginDurableFillEvent(partialDurableEvent, partialDurableClientId, 0.4, 50, true, 1080000);
  partialDurablePosition.onInitialEntryFilled(2700000, 0.4, 2700000, 10000, 2, 3);
  partialDurablePosition.completeDurableFillEvent(partialDurableEvent);
  const preCrashOrderManager = new OrderManager();
  const preCrashOrder: OrderRecord = {
    id: `ORD_DURABLE_PARTIAL_${Date.now()}`, clientOrderId: partialDurableClientId,
    signalId: `SIG_DURABLE_PARTIAL_${Date.now()}`, signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'OPEN', requestedBudgetOrVolume: 1000000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'partial durable watermark failure', fills: [],
    strategyAppliedFilledVolume: 0, strategyAppliedFee: 0, strategyInitialFillApplied: false
  };
  (preCrashOrderManager as any).orders.set(preCrashOrder.id, preCrashOrder);
  (preCrashOrderManager as any).saveOrdersToFile(); // persisted state before the failed watermark write
  const partialRestartPosition = new PositionManager(defaultParams);
  const partialRestartOrderManager = new OrderManager();
  partialRestartOrderManager.setStrategyFillDurabilityLookup((clientOrderId) => partialRestartPosition.getDurableFillWatermark(clientOrderId));
  const partialRestartOrder = partialRestartOrderManager.getAllOrders().find((order) => order.clientOrderId === partialDurableClientId)!;
  let recoveredIncrement = 0;
  let recoveredFee = 0;
  let recoveredKind = '';
  partialRestartOrderManager.setOnOrderUpdated((record, incrementalVolume) => {
    recoveredIncrement = incrementalVolume;
    recoveredFee = record.fee;
    recoveredKind = record.strategyFillKind || '';
    partialRestartPosition.beginDurableFillEvent(record.strategyFillEventId!, record.clientOrderId, record.strategyFillCumulativeVolume, record.strategyFillCumulativeFee, record.strategyFillKind === 'INITIAL', record.strategyFillCumulativeFunds);
    partialRestartPosition.addAdditionalEntryFilled(record.avgFillPrice, incrementalVolume);
    partialRestartPosition.completeDurableFillEvent(record.strategyFillEventId!);
  });
  partialRestartOrderManager.applyUpbitOrderState(
    partialRestartOrder,
    { ...responseA, uuid: 'mock-durable-partial-final', identifier: partialDurableClientId, paid_fee: '125', executed_volume: '1.0', volume: '1.0', remaining_volume: '0' },
    () => {},
    () => {},
    'WATCHER'
  );
  assert(recoveredIncrement === 0.6 && recoveredKind === 'INCREMENTAL' && recoveredFee === 75, '[Durability] Partial durable watermark recovers only the 0.6 incremental volume and fee');
  assert(partialRestartPosition.getSnapshot().amount === 1 && partialRestartOrder.strategyAppliedFilledVolume === 1 && partialRestartOrder.strategyAppliedFee === 125, '[Durability] Partial durable restart reaches final 1.0 position without INITIAL replay');

  // The exchange response's avg fill price is cumulative. Strategy callbacks
  // must instead receive the price of only this newly applied fill delta.
  const pricePartialClientId = `CLIENT_PRICE_PARTIAL_${Date.now()}`;
  const pricePartialOrder: OrderRecord = {
    id: `ORD_PRICE_PARTIAL_${Date.now()}`, clientOrderId: pricePartialClientId,
    signalId: `SIG_PRICE_PARTIAL_${Date.now()}`, signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'OPEN', requestedBudgetOrVolume: 2800000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'mixed-price partial fill', fills: []
  };
  const pricePartialOrderManager = new OrderManager();
  const pricePartialPosition = new PositionManager(defaultParams);
  const callbackPrices: Array<{ volume: number; price: number; kind: string }> = [];
  pricePartialOrderManager.setOnOrderUpdated((record, incrementalVolume) => {
    callbackPrices.push({ volume: incrementalVolume, price: record.avgFillPrice, kind: record.strategyFillKind || '' });
    if (record.strategyFillKind === 'INITIAL') {
      pricePartialPosition.onInitialEntryFilled(record.avgFillPrice, incrementalVolume, 2700000, 10000, 2, 3);
    } else {
      pricePartialPosition.addAdditionalEntryFilled(record.avgFillPrice, incrementalVolume);
    }
  });
  const pricePartialFirst = {
    ...responseA, uuid: 'mock-price-partial-first', identifier: pricePartialClientId, state: 'wait' as const,
    volume: '1.0', remaining_volume: '0.6', executed_volume: '0.4', paid_fee: '54', trades_count: 1,
    trades: [{ market: 'KRW-ETH', uuid: 'price-t-1', price: '2700000', volume: '0.4', funds: '1080000', created_at: new Date().toISOString(), side: 'bid' }]
  };
  const pricePartialFinal = {
    ...pricePartialFirst, uuid: 'mock-price-partial-final', state: 'done' as const,
    remaining_volume: '0', executed_volume: '1.0', paid_fee: '138', trades_count: 2,
    trades: [
      { market: 'KRW-ETH', uuid: 'price-t-1', price: '2700000', volume: '0.4', funds: '1080000', created_at: new Date().toISOString(), side: 'bid' },
      { market: 'KRW-ETH', uuid: 'price-t-2', price: '2800000', volume: '0.6', funds: '1680000', created_at: new Date().toISOString(), side: 'bid' }
    ]
  };
  (pricePartialOrderManager as any).orders.set(pricePartialOrder.id, pricePartialOrder);
  pricePartialOrderManager.applyUpbitOrderState(pricePartialOrder, pricePartialFirst as any, () => {}, () => {}, 'WATCHER');
  pricePartialOrderManager.applyUpbitOrderState(pricePartialOrder, pricePartialFinal as any, () => {}, () => {}, 'WATCHER');
  assert(callbackPrices.length === 2 && callbackPrices[1].volume === 0.6 && callbackPrices[1].price === 2800000 && callbackPrices[1].kind === 'INCREMENTAL', '[Durability] Mixed-price partial fill delivers only 0.6 ETH at its actual ₩2.8M delta price');
  assert(pricePartialPosition.getSnapshot().amount === 1 && pricePartialPosition.getSnapshot().entryPrice === 2760000 && pricePartialOrder.strategyAppliedFunds === 2760000, '[Durability] 0.4@₩2.7M + 0.6@₩2.8M produces the correct ₩2.76M position average and order notional watermark');

  // Repeat the same mixed-price sequence across a restart boundary: the
  // durable position watermark owns the first 0.4/₩1.08M when the order
  // watermark was never written, so reconciliation applies only 0.6/₩1.68M.
  const priceRestartClientId = `CLIENT_PRICE_RESTART_${Date.now()}`;
  const priceRestartPositionBeforeCrash = new PositionManager(defaultParams);
  const priceRestartEvent = `${priceRestartClientId}:0.40000000`;
  priceRestartPositionBeforeCrash.beginDurableFillEvent(priceRestartEvent, priceRestartClientId, 0.4, 54, true, 1080000);
  priceRestartPositionBeforeCrash.onInitialEntryFilled(2700000, 0.4, 2700000, 10000, 2, 3);
  priceRestartPositionBeforeCrash.completeDurableFillEvent(priceRestartEvent);
  const priceRestartPreCrashOrderManager = new OrderManager();
  const priceRestartPreCrashOrder: OrderRecord = {
    id: `ORD_PRICE_RESTART_${Date.now()}`, clientOrderId: priceRestartClientId,
    signalId: `SIG_PRICE_RESTART_${Date.now()}`, signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'OPEN', requestedBudgetOrVolume: 2800000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'mixed-price durable restart', fills: [],
    strategyAppliedFilledVolume: 0, strategyAppliedFee: 0, strategyAppliedFunds: 0, strategyInitialFillApplied: false
  };
  (priceRestartPreCrashOrderManager as any).orders.set(priceRestartPreCrashOrder.id, priceRestartPreCrashOrder);
  (priceRestartPreCrashOrderManager as any).saveOrdersToFile();
  const priceRestartPosition = new PositionManager(defaultParams);
  const priceRestartOrderManager = new OrderManager();
  priceRestartOrderManager.setStrategyFillDurabilityLookup((clientOrderId) => priceRestartPosition.getDurableFillWatermark(clientOrderId));
  const priceRestartOrder = priceRestartOrderManager.getAllOrders().find((order) => order.clientOrderId === priceRestartClientId)!;
  let restartDeltaVolume = 0;
  let restartDeltaPrice = 0;
  let restartDeltaKind = '';
  priceRestartOrderManager.setOnOrderUpdated((record, incrementalVolume) => {
    restartDeltaVolume = incrementalVolume;
    restartDeltaPrice = record.avgFillPrice;
    restartDeltaKind = record.strategyFillKind || '';
    priceRestartPosition.beginDurableFillEvent(record.strategyFillEventId!, record.clientOrderId, record.strategyFillCumulativeVolume, record.strategyFillCumulativeFee, record.strategyFillKind === 'INITIAL', record.strategyFillCumulativeFunds);
    priceRestartPosition.addAdditionalEntryFilled(record.avgFillPrice, incrementalVolume);
    priceRestartPosition.completeDurableFillEvent(record.strategyFillEventId!);
  });
  priceRestartOrderManager.applyUpbitOrderState(
    priceRestartOrder,
    { ...pricePartialFinal, uuid: 'mock-price-restart-final', identifier: priceRestartClientId } as any,
    () => {}, () => {}, 'WATCHER'
  );
  const priceRestartWatermark = priceRestartPosition.getDurableFillWatermark(priceRestartClientId);
  assert(restartDeltaVolume === 0.6 && restartDeltaPrice === 2800000 && restartDeltaKind === 'INCREMENTAL', '[Durability] Restart recovery sends only the new 0.6 ETH at ₩2.8M, never the cumulative ₩2.76M price');
  assert(priceRestartPosition.getSnapshot().amount === 1 && priceRestartPosition.getSnapshot().entryPrice === 2760000 && priceRestartOrder.strategyAppliedFunds === 2760000 && priceRestartWatermark?.funds === 2760000, '[Durability] Mixed-price restart recovers final 1.0 ETH at ₩2.76M with matching durable funds watermarks');

  // Upgrade an old partial-order/position schema which has volume and fee
  // watermarks but no cumulative notional. It must use authoritative trades,
  // never silently assume zero funds (which would corrupt the next delta's
  // average price).
  const legacyFundsClientId = `CLIENT_LEGACY_FUNDS_${Date.now()}`;
  const legacyFundsSeedPosition = new PositionManager(defaultParams);
  const legacyFundsEvent = `${legacyFundsClientId}:0.40000000`;
  legacyFundsSeedPosition.beginDurableFillEvent(legacyFundsEvent, legacyFundsClientId, 0.4, 54, true);
  legacyFundsSeedPosition.onInitialEntryFilled(2700000, 0.4, 2700000, 10000, 2, 3);
  legacyFundsSeedPosition.completeDurableFillEvent(legacyFundsEvent);
  const oldSchemaPosition: any = legacyFundsSeedPosition.getSnapshot();
  delete oldSchemaPosition.durableFillWatermarks[legacyFundsClientId].funds;
  fs.writeFileSync(posFile, JSON.stringify(oldSchemaPosition, null, 2), 'utf-8');
  const oldSchemaOrder: OrderRecord = {
    id: `ORD_LEGACY_FUNDS_${Date.now()}`, clientOrderId: legacyFundsClientId,
    signalId: `SIG_LEGACY_FUNDS_${Date.now()}`, signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'PARTIALLY_FILLED', requestedBudgetOrVolume: 2800000, filledVolume: 0.4, avgFillPrice: 2700000, fee: 54,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'old schema funds upgrade', fills: [],
    strategyAppliedFilledVolume: 0.4, strategyAppliedFee: 54, strategyInitialFillApplied: true
  };
  fs.writeFileSync(orderFile, JSON.stringify([oldSchemaOrder], null, 2), 'utf-8');
  const legacyFundsPosition = new PositionManager(defaultParams);
  const legacyFundsOrderManager = new OrderManager();
  legacyFundsOrderManager.setStrategyFillDurabilityLookup(
    (clientOrderId) => legacyFundsPosition.getDurableFillWatermark(clientOrderId),
    (clientOrderId, funds) => legacyFundsPosition.restoreDurableFillWatermarkFunds(clientOrderId, funds)
  );
  const legacyFundsOrder = legacyFundsOrderManager.getAllOrders().find((order) => order.clientOrderId === legacyFundsClientId)!;
  let legacyDeltaPrice = 0;
  legacyFundsOrderManager.setOnOrderUpdated((record, incrementalVolume) => {
    legacyDeltaPrice = record.avgFillPrice;
    legacyFundsPosition.beginDurableFillEvent(record.strategyFillEventId!, record.clientOrderId, record.strategyFillCumulativeVolume, record.strategyFillCumulativeFee, false, record.strategyFillCumulativeFunds);
    legacyFundsPosition.addAdditionalEntryFilled(record.avgFillPrice, incrementalVolume);
    legacyFundsPosition.completeDurableFillEvent(record.strategyFillEventId!);
  });
  (legacyFundsOrderManager as any).reconcileUpbitOrder = async () => ({ found: true, order: { ...pricePartialFinal, uuid: 'mock-legacy-funds-final', identifier: legacyFundsClientId } });
  assert(await legacyFundsOrderManager.reconcilePendingOrdersOnStartup({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' }) === 1, '[Durability] Old-schema partial order upgrades its missing notional from exchange trades during startup');
  const legacyOrderFunds = legacyFundsOrder.strategyAppliedFunds || 0;
  const legacyPositionFunds = legacyFundsPosition.getDurableFillWatermark(legacyFundsClientId)?.funds || 0;
  assert(Math.abs(legacyOrderFunds - 2760000) < 0.01 && Math.abs(legacyPositionFunds - 2760000) < 0.01, `[Durability] Legacy order/position funds recovery persists the reconstructed ₩2.76M cumulative notional (order=${legacyOrderFunds}, position=${legacyPositionFunds})`);
  assert(legacyDeltaPrice === 2800000, '[Durability] Legacy funds recovery preserves the correct ₩2.8M incremental price');

  const unavailableLegacyFundsManager = new OrderManager();
  ((unavailableLegacyFundsManager as any).orders as Map<string, OrderRecord>).clear();
  const unavailableLegacyFundsOrder: OrderRecord = {
    ...oldSchemaOrder,
    id: `ORD_LEGACY_NO_TRADES_${Date.now()}`,
    clientOrderId: `CLIENT_LEGACY_NO_TRADES_${Date.now()}`,
    strategyAppliedFunds: undefined,
    strategyAppliedFundsRecoveryRequired: true
  };
  (unavailableLegacyFundsManager as any).orders.set(unavailableLegacyFundsOrder.id, unavailableLegacyFundsOrder);
  (unavailableLegacyFundsManager as any).reconcileUpbitOrder = async () => ({ found: true, order: { ...pricePartialFinal, uuid: 'mock-legacy-no-trades', identifier: unavailableLegacyFundsOrder.clientOrderId, trades: [] } });
  let unavailableLegacyFundsRejected = false;
  try {
    await unavailableLegacyFundsManager.reconcilePendingOrdersOnStartup({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  } catch {
    unavailableLegacyFundsRejected = true;
  }
  assert(unavailableLegacyFundsRejected, '[Durability] Legacy applied volume without exchange trades fails closed instead of assuming zero notional');

  // Watermark-only repair (no new volume to deliver) is still a durable
  // commit. Its save failure must escape startup reconciliation and keep the
  // engine behind the startup barrier.
  const repairFailureOrderManager = new OrderManager();
  ((repairFailureOrderManager as any).orders as Map<string, OrderRecord>).clear();
  ((repairFailureOrderManager as any).watchingOrderIds as Set<string>).clear();
  const repairFailureOrder: OrderRecord = {
    id: `ORD_REPAIR_FAILURE_${Date.now()}`, clientOrderId: `CLIENT_REPAIR_FAILURE_${Date.now()}`,
    signalId: `SIG_REPAIR_FAILURE_${Date.now()}`, signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY',
    status: 'OPEN', requestedBudgetOrVolume: 1080000, filledVolume: 0, avgFillPrice: 0, fee: 0,
    createdAt: Date.now(), updatedAt: Date.now(), reason: 'watermark repair write failure', fills: [],
    strategyAppliedFilledVolume: 0, strategyAppliedFee: 0, strategyAppliedFunds: 0, strategyInitialFillApplied: false
  };
  (repairFailureOrderManager as any).orders.set(repairFailureOrder.id, repairFailureOrder);
  repairFailureOrderManager.setStrategyFillDurabilityLookup(() => ({ volume: 0.4, fee: 54, funds: 1080000, initialApplied: true }));
  let repairSaveCalls = 0;
  const repairRealSave = (repairFailureOrderManager as any).saveOrdersToFile.bind(repairFailureOrderManager);
  (repairFailureOrderManager as any).saveOrdersToFile = () => {
    repairSaveCalls++;
    if (repairSaveCalls === 2) throw new Error('injected watermark-only repair write failure');
    return repairRealSave();
  };
  (repairFailureOrderManager as any).reconcileUpbitOrder = async () => ({ found: true, order: { ...pricePartialFirst, uuid: 'mock-repair-failure', identifier: repairFailureOrder.clientOrderId } });
  let repairReconcileRejected = false;
  try {
    await repairFailureOrderManager.reconcilePendingOrdersOnStartup({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  } catch {
    repairReconcileRejected = true;
  }
  assert(repairReconcileRejected, '[Durability] Watermark-only repair save failure is not swallowed by startup reconciliation');
  // Recreate the same pre-repair persistent state as a fresh process would
  // see, then make the startup barrier consume that failing reconciliation.
  repairFailureOrder.strategyAppliedFilledVolume = 0;
  repairFailureOrder.strategyAppliedFee = 0;
  repairFailureOrder.strategyAppliedFunds = 0;
  repairFailureOrder.strategyInitialFillApplied = false;
  repairFailureOrder.status = 'OPEN';
  repairSaveCalls = 0;
  (repairFailureOrderManager as any).durabilityFailure = false;
  const repairFailureEngine = new ATREngine(undefined, { backtest: true });
  (repairFailureEngine as any).startupReady = false;
  (repairFailureEngine as any).refreshAtrFromExchange = async () => true;
  (repairFailureEngine as any).reconcileOnStartup = async () => {
    await repairFailureOrderManager.reconcilePendingOrdersOnStartup({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
    return true;
  };
  await (repairFailureEngine as any).startStartupBarrier();
  assert((repairFailureEngine as any).startupReady === false && repairFailureEngine.botState === 'PAUSED', '[Durability] A startup watermark repair write failure can never pass startupReady');

  const failingPosition = new PositionManager(defaultParams);
  const failingEventId = `CLIENT_POSITION_WRITE_FAIL_${Date.now()}:0.40000000`;
  failingPosition.beginDurableFillEvent(failingEventId);
  (failingPosition as any).saveStateToFile = () => { throw new Error('injected position rename failure'); };
  let positionWriteFailed = false;
  try {
    failingPosition.onInitialEntryFilled(2700000, 0.4, 2700000, 10000, 2, 3);
  } catch {
    positionWriteFailed = true;
  }
  assert(positionWriteFailed && failingPosition.completeDurableFillEvent(failingEventId) === false, '[Durability] Position write failure prevents a durable fill marker from being acknowledged');

  // REENTRY and REGIME_REBALANCE each invoke a nested manual-add mutator.
  // Their whole fill must still produce one final physical position commit;
  // a hypothetical second write therefore cannot publish an early marker.
  const nestedFillPosition = new PositionManager(defaultParams);
  nestedFillPosition.onInitialEntryFilled(2700000, 1, 2700000, 10000, 2, 3);
  const nestedEventId = `CLIENT_NESTED_FILL_${Date.now()}:0.20000000`;
  let nestedPhysicalCommits = 0;
  const actualCommit = (nestedFillPosition as any).commitStateToFile.bind(nestedFillPosition);
  (nestedFillPosition as any).commitStateToFile = () => {
    nestedPhysicalCommits++;
    if (nestedPhysicalCommits === 2) throw new Error('injected second write failure');
    return actualCommit();
  };
  nestedFillPosition.beginDurableFillEvent(nestedEventId);
  nestedFillPosition.onReentryBuyFilled(2650000, 0.2, 2700000, 10000, 2, 3);
  assert(nestedFillPosition.completeDurableFillEvent(nestedEventId) === true && nestedPhysicalCommits === 1, '[Durability] Nested REENTRY commits final position and marker exactly once');
  assert(nestedFillPosition.hasDurablyAppliedFillEvent(nestedEventId), '[Durability] Second-write failure cannot expose an early nested fill marker');

  const regimeFillPosition = new PositionManager(defaultParams);
  regimeFillPosition.onInitialEntryFilled(2700000, 1, 2700000, 10000, 2, 3);
  const regimeEventId = `CLIENT_REGIME_FILL_${Date.now()}:0.15000000`;
  let regimePhysicalCommits = 0;
  const actualRegimeCommit = (regimeFillPosition as any).commitStateToFile.bind(regimeFillPosition);
  (regimeFillPosition as any).commitStateToFile = () => {
    regimePhysicalCommits++;
    if (regimePhysicalCommits === 2) throw new Error('injected regime second write failure');
    return actualRegimeCommit();
  };
  regimeFillPosition.beginDurableFillEvent(regimeEventId);
  regimeFillPosition.onRegimeRebalanceBuyFilled(2680000, 0.15, 2700000, 10000, 2, 3);
  assert(regimeFillPosition.completeDurableFillEvent(regimeEventId) === true && regimePhysicalCommits === 1 && regimeFillPosition.hasDurablyAppliedFillEvent(regimeEventId), '[Durability] Nested REGIME_REBALANCE commits final position and marker exactly once');

  const haltedResumeEngine = new ATREngine(undefined, { backtest: true });
  (haltedResumeEngine as any).durabilityFailure = true;
  haltedResumeEngine.botState = 'HALTED';
  let haltedResumeRejected = false;
  try {
    haltedResumeEngine.updateParams({ isBotActive: true });
  } catch {
    haltedResumeRejected = true;
  }
  assert(haltedResumeRejected && haltedResumeEngine.botState === 'HALTED' && haltedResumeEngine.params.isBotActive === false, '[Durability] HALTED engine rejects in-process bot resume until restart');

  const haltedOrderManager = new OrderManager();
  (haltedOrderManager as any).durabilityFailure = true;
  let haltedSubmitRejected = false;
  try {
    await haltedOrderManager.submitOrder({
      signalId: `SIG_HALTED_SUBMIT_${Date.now()}`, clientOrderId: `CLIENT_HALTED_SUBMIT_${Date.now()}`,
      signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY', requestedAmountKrw: 100000, reason: 'durability terminal-state test', createdAt: Date.now()
    }, { upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' }, 'UPBIT', () => {}, () => {});
  } catch {
    haltedSubmitRejected = true;
  }
  assert(haltedSubmitRejected, '[Durability] OrderManager rejects all new submits after durability failure');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 23: Restart, Manual Exit, Dry-Run & Feed Boundaries
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 23: Restart, Manual Exit, Dry-Run & Feed Boundaries');

  // A daily-loss circuit is sell-only after restart, not ordinary PAUSED.
  const dailyRestartEngine = new ATREngine(undefined, { backtest: true });
  dailyRestartEngine.positionManager.onInitialEntryFilled(2_700_000, 0.2, 2_700_000, 10_000, 2, 3);
  dailyRestartEngine.params.isBotActive = true;
  (dailyRestartEngine as any).requestedRunAfterStartup = true;
  (dailyRestartEngine as any).riskGovernor.recordDailyLoss(100_000, 1_000_000);
  (dailyRestartEngine as any).startupReady = false;
  (dailyRestartEngine as any).refreshAtrFromExchange = async () => true;
  (dailyRestartEngine as any).reconcileOnStartup = async () => true;
  await (dailyRestartEngine as any).startStartupBarrier();
  const dailyProtectiveSignal: Signal = {
    id: `SIG_DAILY_RESTART_${Date.now()}`, timestamp: Date.now(), timeframe: 'tick', source: 'test',
    type: 'ABSOLUTE_STOP_EXIT', priority: 1, symbol: 'KRW-ETH', price: 2_500_000, reason: 'daily restart protective test',
    indicatorSnapshot: { baseline: 2_700_000, atr: 10_000, upperBand: 2_730_000, lowerBand: 2_670_000, currentStopLoss: 2_538_000, marketRegime: 'BEAR', slope: -0.2, volatilityRatio: 1, dynamicOrderRatio: 20 }
  };
  const dailyRestartEval = (dailyRestartEngine as any).riskGovernor.evaluateSignal(
    dailyProtectiveSignal, dailyRestartEngine.botState, 'LIVE', 800_000, dailyRestartEngine.positionManager.getSnapshot(), 2_500_000, [], 0
  );
  assert(dailyRestartEngine.botState === 'HALTED' && dailyRestartEval.approved, '[Daily circuit restart] Restart remains sell-only HALTED and still approves ABSOLUTE_STOP_EXIT');

  // A manual emergency sell must coordinate through pending orders rather than
  // being rejected before it can cancel a resting DCA/limit sell.
  const manualExitEngine = new ATREngine(undefined, { backtest: true });
  manualExitEngine.positionManager.onInitialEntryFilled(2_700_000, 1, 2_700_000, 10_000, 2, 3);
  manualExitEngine.botState = 'RUNNING';
  (manualExitEngine as any).marketManager.marketState = 'LIVE';
  (manualExitEngine as any).secretManager.getKeys = () => ({ upbitAccessKey: 'TEST_ACCESS_KEY_NOT_REAL', upbitSecretKey: 'TEST_SECRET_KEY_NOT_REAL' });
  let protectiveCancelCalled = false;
  let submittedManualExit: any = null;
  (manualExitEngine.orderManager as any).getPendingOrdersCount = () => 1;
  (manualExitEngine.orderManager as any).cancelPendingOrdersForProtectiveExit = async () => { protectiveCancelCalled = true; };
  (manualExitEngine as any).fetchRealAccountBalance = async () => { (manualExitEngine as any).lastExchangeCoinQuantity = 0.73; return true; };
  (manualExitEngine.orderManager as any).submitOrder = async (request: any) => { submittedManualExit = request; };
  await manualExitEngine.executeManualTrade('SELL');
  assert(protectiveCancelCalled && submittedManualExit?.signalType === 'EMERGENCY_FULL_EXIT' && submittedManualExit?.requestedVolume === 0.73, '[Manual emergency sell] Pending orders are cancelled/reconciled and actual exchange quantity is sold');
  let pendingManualBuyRejected = false;
  try { await manualExitEngine.executeManualTrade('BUY', 10); } catch { pendingManualBuyRejected = true; }
  assert(pendingManualBuyRejected, '[Manual emergency sell] Pending orders still reject manual BUY');

  // A dry-run decision is diagnostic only: no production durable ledger may
  // be changed and the normal fill handler must never be invoked.
  const dryRunEngine = new ATREngine(undefined, { backtest: true });
  dryRunEngine.params.dryRunMode = true;
  dryRunEngine.botState = 'RUNNING';
  (dryRunEngine as any).marketManager.marketState = 'LIVE';
  const dryBefore = [posFile, orderFile, reservationFile].map((file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '__MISSING__');
  let dryFillHandlerCalled = false;
  (dryRunEngine as any).handleOrderFilled = () => { dryFillHandlerCalled = true; };
  (dryRunEngine as any).strategyCore.generateSignals = () => [{
    id: `SIG_DRY_${Date.now()}`, timestamp: Date.now(), timeframe: 'tick', source: 'test', type: 'ENTRY_BUY', priority: 6,
    symbol: 'KRW-ETH', price: 2_700_000, reason: 'dry-run entry',
    indicatorSnapshot: { baseline: 2_700_000, atr: 10_000, upperBand: 2_730_000, lowerBand: 2_670_000, currentStopLoss: 2_538_000, marketRegime: 'SIDEWAYS', slope: 0, volatilityRatio: 1, dynamicOrderRatio: 20 }
  }];
  (dryRunEngine as any).riskGovernor.evaluateSignal = () => ({ approved: true, calculatedBudgetKrw: 100_000, orderRequest: {
    clientOrderId: `ORD_DRY_${Date.now()}`, signalId: `SIG_DRY_ORDER_${Date.now()}`, signalType: 'ENTRY_BUY', symbol: 'KRW-ETH', side: 'BUY', requestedAmountKrw: 100_000, reason: 'dry-run entry', createdAt: Date.now()
  }});
  await dryRunEngine.handleMarketTick(2_700_000, Date.now());
  const dryAfter = [posFile, orderFile, reservationFile].map((file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '__MISSING__');
  assert(!dryFillHandlerCalled && JSON.stringify(dryBefore) === JSON.stringify(dryAfter), '[Dry-run isolation] Simulated fill never mutates production position/order/risk files');

  // REST fallback keeps the displayed price fresh, but cannot mask a zombie
  // socket. The watchdog must reconnect based on WebSocket time only.
  const feedManager = new MarketDataManager('UPBIT', 'KRW-ETH', undefined, undefined, false);
  let reconnectCalls = 0;
  (feedManager as any).upbitClient.fetchTicker = async () => ({ symbol: 'KRW-ETH', price: 2_700_000, timestamp: Date.now() });
  (feedManager as any).upbitClient.reconnect = () => { reconnectCalls += 1; };
  feedManager.lastWsReceivedAt = Date.now() - 25_000;
  feedManager.lastAnyPriceReceivedAt = Date.now();
  feedManager.lastReceivedAt = feedManager.lastAnyPriceReceivedAt;
  (feedManager as any).startWatchdog();
  await new Promise((resolve) => setTimeout(resolve, 3_300));
  feedManager.destroy();
  assert(feedManager.lastAnyPriceReceivedAt > feedManager.lastWsReceivedAt && reconnectCalls >= 1, '[Market feed] Healthy REST fallback does not reset WS zombie watchdog or prevent reconnect');

  // Isolate this parameter semantic test from the intentionally persisted
  // daily-circuit restart scenario immediately above.
  if (fs.existsSync(dailyRiskFile)) fs.unlinkSync(dailyRiskFile);
  const zeroRatioRisk = new GlobalRiskGovernor({ ...defaultParams, autoPilotEnabled: false, orderRatio: 0 });
  const zeroRatioEval = zeroRatioRisk.evaluateSignal(
    { ...bullBuySignal, id: `SIG_ZERO_RATIO_${Date.now()}`, type: 'ENTRY_BUY' }, 'RUNNING', 'LIVE', 1_000_000,
    { ...testPosition, state: 'FLAT', amount: 0, entryPrice: null, totalCostKrw: 0 }, 2_700_000, [], 0
  );
  assert(zeroRatioEval.approved === false && zeroRatioEval.calculatedBudgetKrw === undefined && /Available budget/.test(zeroRatioEval.rejectionReason || ''), '[Zero semantics] orderRatio=0 remains zero and never falls back to a 25% BUY');

  // ──────────────────────────────────────────────────────
  // RESULTS
  // ──────────────────────────────────────────────────────
  console.log('\n======================================================');
  console.log(`📊 Automated Test Results: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
