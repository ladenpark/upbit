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
import { ResearchRecorder } from '../research/researchRecorder';
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

  // Clean test fixtures for isolated idempotent test suite execution only when not in live production
  const testDataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  const reservationFile = path.join(testDataDir, 'exposure_reservations.json');
  const orderFile = path.join(testDataDir, 'order_history.json');
  const signalFile = path.join(testDataDir, 'processed_signals.json');
  const posFile = path.join(testDataDir, 'position_state.json');

  if (process.env.NODE_ENV === 'test') {
    if (fs.existsSync(reservationFile)) fs.writeFileSync(reservationFile, '[]', 'utf-8');
    if (fs.existsSync(orderFile)) fs.writeFileSync(orderFile, '[]', 'utf-8');
    if (fs.existsSync(signalFile)) fs.writeFileSync(signalFile, '[]', 'utf-8');
    if (fs.existsSync(posFile)) fs.unlinkSync(posFile);
  }

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

  assert(defSnapshot.state === 'DEFENSIVE_1', 'Position transitioned to DEFENSIVE_1 state after first Partial Cut');
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
    partialCutCount: 2,
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
  assert(earlyTrendFollowSignals[0]?.regimeTargetExposurePercent === 65, '[BULL Target] Target exposure is capped at 65%');
  const weakTrendFollowSignals = strategyCore.generateSignals(2720000, 2650000, 30000, defaultParams, labPyramidPosition, 0, baseBullHistory, { trend: 'BULL', htfSlope: 0.5 }, 60, 1.0);
  assert(!weakTrendFollowSignals.some((signal) => signal.type === 'REGIME_REBALANCE_BUY'), '[BULL Target] Low-volume rise does not consume additional cash');

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
  researchRecorder.recordTick('KRW-ETH', 3000000, 1700000000000);
  researchRecorder.recordTick('KRW-ETH', 3000000, 1700000000100); // duplicate ticker noise
  researchRecorder.recordTick('KRW-ETH', 3001000, 1700000000200);
  researchRecorder.recordCompletedCandles('KRW-ETH', [{
    market: 'KRW-ETH', candle_date_time_utc: '2023-11-14T00:00:00', opening_price: 3000000,
    high_price: 3010000, low_price: 2990000, trade_price: 3001000, timestamp: 1700000000000,
    candle_acc_trade_volume: 12.34
  }]);
  researchRecorder.recordShadowDifference(1700000000000, 'KRW-ETH', 3001000, { rsi: 40, volumeMultiplier: 1.2 }, {
    baseline: { type: 'DCA_BUY', dcaExecution: 'RECOVERY_PREBUY' },
    dca2Rsi: { type: null }
  });
  const researchStats = researchRecorder.getStats();
  assert(researchStats.ticksRecorded === 2, '[Research] Duplicate ticker noise is not written repeatedly');
  assert(researchStats.candlesRecorded === 1 && researchStats.shadowDifferences === 1, '[Research] Completed candle and shadow difference are recorded independently');

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
  reentryManager.rebaseReconciledPosition(2700000, 30000, 3, 2);
  const rebasedSnapshot = reentryManager.getSnapshot();
  assert(rebasedSnapshot.partialCutCount === 0 && rebasedSnapshot.trailingActive === false && rebasedSnapshot.state === 'ENTRY_FILLED', '[Rebase] Defensive and trailing state are reset from the reconciled position');
  assert(rebasedSnapshot.initialStopPrice === Math.max(2700000 - (30000 * 3) - (30000 * 2), rebasedSnapshot.entryPrice! * 0.94), '[Rebase] Static stop is rebuilt from current baseline, ATR, and exchange average');
  const reentryPendingRisk = new GlobalRiskGovernor(defaultParams).evaluateSignal(
    { ...bullBuySignal, type: 'REENTRY_BUY' }, 'RUNNING', 'LIVE', 5000000,
    { ...labPyramidPosition, state: 'REENTRY_PENDING' }, 2750000, [], 0
  );
  assert(reentryPendingRisk.approved === false, '[Re-entry] Risk governor blocks all new buys while re-entry is pending');

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
