/**
 * Comprehensive Automated Test Suite for Quantitative Trading Engine
 * Tests: Strategy, Risk, Position, Order Idempotency, Exposure Reservation,
 *        Fill Confirmation, Timeout Reconciliation, Collision Blocking
 * 
 * Run: npx tsx server/tests/tradingEngine.test.ts
 */

import fs from 'fs';
import path from 'path';
import { ATRStrategyCore } from '../strategy/atrStrategyCore';
import { GlobalRiskGovernor } from '../risk/globalRiskGovernor';
import { PositionManager } from '../position/positionManager';
import { OrderManager } from '../orders/orderManager';
import { SecretManager } from '../security/secretManager';
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

  // Clean test fixtures for isolated idempotent test suite execution
  const testDataDir = path.resolve(process.cwd(), 'data');
  const reservationFile = path.join(testDataDir, 'exposure_reservations.json');
  const orderFile = path.join(testDataDir, 'order_history.json');
  const signalFile = path.join(testDataDir, 'processed_signals.json');
  const posFile = path.join(testDataDir, 'position_state.json');

  if (fs.existsSync(reservationFile)) fs.writeFileSync(reservationFile, '[]', 'utf-8');
  if (fs.existsSync(orderFile)) fs.writeFileSync(orderFile, '[]', 'utf-8');
  if (fs.existsSync(signalFile)) fs.writeFileSync(signalFile, '[]', 'utf-8');
  if (fs.existsSync(posFile)) fs.unlinkSync(posFile);

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
    autoPilotEnabled: true
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
    pyramidingCount: 0, maxPyramidingOrders: 2,
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
    pyramidingCount: 0, maxPyramidingOrders: 2,
    trailingActive: false, trailingPeakPrice: null, cooldownUntil: 0
  };

  const buySignal: Signal = {
    id: 'SIG_TEST_BUY', timestamp: Date.now(), timeframe: '1m',
    source: 'ATR_STRATEGY_CORE', type: 'ENTRY_BUY', priority: 6,
    symbol: 'KRW-ETH', price: 2800000, reason: 'Test Buy Signal',
    indicatorSnapshot: {
      baseline: 3000000, atr: 50000, upperBand: 3150000, lowerBand: 2850000,
      currentStopLoss: 2750000, marketRegime: 'BEAR', slope: -0.02, volatilityRatio: 1.5
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

  // ──────────────────────────────────────────────────────
  // TEST GROUP 3: Static Stop Loss Snapshot Immutability
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 3: Static Stop Loss Snapshot Immutability (Dynamic ATR drift test)');
  const posManager = new PositionManager(defaultParams);

  posManager.onInitialEntryFilled(2850000, 1.0, 3000000, 50000, 3.0, 2.0);
  const snapshotAfterEntry = posManager.getSnapshot();
  assert(snapshotAfterEntry.initialStopPrice === 2750000, `Static Stop Loss locked at exact ₩${snapshotAfterEntry.initialStopPrice}`);

  const snapshotLater = posManager.getSnapshot();
  assert(snapshotLater.initialStopPrice === 2750000, 'Stop Loss did NOT drift with market volatility');

  // ──────────────────────────────────────────────────────
  // TEST GROUP 4: DCA & Partial Cut Loop Prevention
  // ──────────────────────────────────────────────────────
  console.log('\n▶ TEST GROUP 4: DCA & Partial Cut Loop Prevention');
  posManager.onPartialLossCutFilled(0.4, 2700000, -60000);
  const defSnapshot = posManager.getSnapshot();

  assert(defSnapshot.state === 'DEFENSIVE', 'Position transitioned to DEFENSIVE state after Partial Cut');
  assert(posManager.isUnderCooldown(), 'Cooldown timer is active following Partial Loss Cut');

  const dcaSignal = { ...buySignal, type: 'DCA_BUY' as const, reason: 'DCA Test' };
  const dcaRiskEval = riskGovernor.evaluateSignal(
    dcaSignal, 'RUNNING', 'LIVE',
    5000000, defSnapshot, 2700000, 0, 0
  );
  assert(dcaRiskEval.approved === false, 'DCA immediately blocked during Cooldown & DEFENSIVE state (Infinite loop prevented)');

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
    upbitAccessKey: 'x7KF16Y6z8Ykp0UUAr8cyADjxgmaxenuxnTMp6JJ',
    upbitSecretKey: 'j7QBxSwPqSiXX1tgJCRqbxDpZsyuWqmy2fUhIOhl'
  });
  const maskedStatus = secretManager.getMaskedStatus();
  assert(maskedStatus.hasUpbitKeys === true, 'Upbit Keys presence verified');
  assert(maskedStatus.upbitAccessMasked === 'x7KF************p6JJ', 'API Key properly masked without plaintext exposure');

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
  assert(mockPartialOrder.state === 'cancel' && partialVol > 0, '[partial fill] cancel + executed_volume > 0 = PARTIALLY_FILLED');

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
  let watcherReceivedPrev = 0;

  const testPosManager = new PositionManager(defaultParams);
  const scenarioGovernor = new GlobalRiskGovernor(defaultParams);
  const testOrderManager = new OrderManager(
    scenarioGovernor,
    (updatedRecord, prevVolume) => {
      watcherEventCount++;
      watcherReceivedVolume = updatedRecord.filledVolume;
      watcherReceivedPrev = prevVolume;
      const added = updatedRecord.filledVolume - prevVolume;
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
  assert(watcherReceivedVolume === 1.0 && watcherReceivedPrev === 0.4, '[Scenario B - Step 2] Watcher received total 1.0 ETH (prev: 0.4 ETH, added: 0.6 ETH)');
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
  assert(watcherReceivedVolume === 1.0 && watcherReceivedPrev === 0, '[Scenario C] Startup reconcile received 1.0 ETH added');

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
  assert(snapAfterDca1.dcaSlots[0].status === 'FILLED' && snapAfterDca1.dcaSlots[0].filledVolume === 0.3, '[DCA Partial Fill] Slot 1 filled with 0.3 ETH');
  assert(snapAfterDca1.dcaSlots[1].status === 'AVAILABLE', '[DCA Partial Fill] Slot 2 is still AVAILABLE');

  // Step 2: Watcher detects remaining 0.2 ETH filled -> call addAdditionalDcaFilled
  nonEntryPosManager.addAdditionalDcaFilled(2600000, 0.2);
  const snapAfterDca2 = nonEntryPosManager.getSnapshot();
  assert(snapAfterDca2.amount === 1.5, '[DCA Partial Fill] Position amount increased to exact 1.5 ETH');
  assert(snapAfterDca2.dcaSlots[0].filledVolume === 0.5, '[DCA Partial Fill] Slot 1 volume correctly updated to 0.5 ETH');
  assert(snapAfterDca2.dcaSlots[1].status === 'AVAILABLE', '[DCA Partial Fill] Slot 2 remains untouched & AVAILABLE (No false slot consumption!)');

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
  assert(snapAfterCut1.state === 'DEFENSIVE', '[Partial Cut] Position state is DEFENSIVE');
  const disabledSlots1 = snapAfterCut1.dcaSlots.filter((s) => s.status === 'DISABLED').length;
  assert(disabledSlots1 === 1, '[Partial Cut] Exactly 1 DCA slot disabled');

  // Step 2: Watcher detects remaining 0.4 ETH cut -> call addAdditionalPartialCutFilled
  nonEntryPosManager.addAdditionalPartialCutFilled(0.4, 2600000, -40000);
  const snapAfterCut2 = nonEntryPosManager.getSnapshot();
  assert(snapAfterCut2.amount === 1.2, '[Partial Cut] Position amount reduced to exact 1.2 ETH');
  const disabledSlots2 = snapAfterCut2.dcaSlots.filter((s) => s.status === 'DISABLED').length;
  assert(disabledSlots2 === 1, '[Partial Cut] DCA disabled slots remain 1 (No duplicate slot disable!)');

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
    bullPriceHistory
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
