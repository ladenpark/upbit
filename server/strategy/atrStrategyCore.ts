import { Signal, SignalType, BotParams, PositionSnapshot, SidewaysContext } from '../types/trading';

export class ATRStrategyCore {
  private recentPrices: number[] = [];

  /**
   * Deterministic calculation of adaptive indicators:
   * 1. Trend slope
   * 2. Volatility ratio
   * 3. Dynamic ATR multiplier (1.6x ~ 3.8x)
   * 4. Dynamic entry budget ratio (15% ~ 60%)
   * 5. Dynamic DCA step (-1.5% ~ -3.5%)
   * 6. Dynamic Trailing callback (0.6% ~ 1.5%)
   */
  public evaluateAdaptiveParams(
    currentPrice: number,
    baselineValue: number,
    atrValue: number,
    params: BotParams,
    priceHistory: number[],
    higherTfTrend?: { trend: 'BULL' | 'SIDEWAYS' | 'BEAR'; htfSlope: number },
    rsi: number = 50.0,
    volumeMultiplier: number = 1.0,
    volumeMa: number = 0.0
  ) {
    if (priceHistory.length < 15) {
      return {
        dynamicAtr: params.atrMultiplier,
        dynamicOrderRatio: params.orderRatio,
        dynamicDcaStep: params.safetyOrderStepPercent,
        dynamicTrailingCallback: params.trailingCallbackPercent,
        dynamicScalpBandMultiplier: 0.8,
        dynamicScalpTakeProfitPercent: 0.5,
        marketRegime: 'SIDEWAYS' as const,
        slope: 0,
        volatilityRatio: 1.5,
        rsi,
        volumeMultiplier,
        volumeMa
      };
    }

    const shortPeriod = priceHistory.slice(-5);
    const midPeriod = priceHistory.slice(-15);
    const shortMa = shortPeriod.reduce((a, b) => a + b, 0) / shortPeriod.length;
    const midMa = midPeriod.reduce((a, b) => a + b, 0) / midPeriod.length;

    const slope = ((shortMa - midMa) / midMa) * 100;
    const priceToBaseline = ((currentPrice - baselineValue) / baselineValue) * 100;
    const volatilityRatio = baselineValue > 0 ? (atrValue / baselineValue) * 100 : 1.5;

    // Multi-Timeframe Confluence Regime Determination (15m HTF + 1m Price Position + Micro Slope)
    let marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR' = 'SIDEWAYS';
    const htf = higherTfTrend?.trend || 'SIDEWAYS';

    const isBullConfluence =
      (htf === 'BULL' && priceToBaseline > 0) ||
      (priceToBaseline >= 0.20 && htf !== 'BEAR') ||
      (slope > 0.10 && priceToBaseline > 0.05 && htf !== 'BEAR');

    const isBearConfluence =
      (htf === 'BEAR' && priceToBaseline < 0) ||
      (priceToBaseline <= -0.20 && htf !== 'BULL') ||
      (slope < -0.10 && priceToBaseline < -0.05 && htf !== 'BULL');

    if (isBullConfluence) {
      marketRegime = 'BULL';
    } else if (isBearConfluence) {
      marketRegime = 'BEAR';
    }

    // SIDEWAYS is split internally because an uptrend pullback and a bear-market
    // pause must not be treated as a neutral box range.
    let sidewaysContext: SidewaysContext = 'NEUTRAL_RANGE';
    if (marketRegime === 'SIDEWAYS') {
      if (htf === 'BULL') sidewaysContext = 'BULL_PULLBACK';
      else if (htf === 'BEAR') sidewaysContext = 'BEAR_PAUSE';
    }

    // 1. Dynamic ATR Multiplier: 1.8x (BULL) ~ 3.5x (BEAR)
    let dynamicAtr = 2.4;
    if (marketRegime === 'BULL') {
      dynamicAtr = 1.8;
    } else if (marketRegime === 'BEAR') {
      dynamicAtr = 3.5;
    }

    // 2. Dynamic Order Ratio (Sizing): 10% (BEAR) ~ 20% (BULL) to prevent 85% exposure overflow
    let dynamicOrderRatio = 18;
    if (marketRegime === 'BULL') {
      dynamicOrderRatio = 20; // 20% + 24% + 28.8% = 72.8% (Fits well under 85%)
    } else if (marketRegime === 'BEAR') {
      dynamicOrderRatio = 10; // Defensive small unit
    }

    // 3. Dynamic DCA Step: 1.5% ~ 3.0%
    let dynamicDcaStep = 2.0;
    if (marketRegime === 'BULL') {
      dynamicDcaStep = 1.5;
    } else if (marketRegime === 'BEAR') {
      dynamicDcaStep = 3.0; // Wider gap in downtrend to avoid catching falling knives
    }

    // 4. Dynamic Trailing Callback: 0.8% ~ 1.2%
    let dynamicTrailingCallback = 0.8;
    if (volatilityRatio > 2.0) {
      dynamicTrailingCallback = 1.2;
    }

    // 5. Scalp Entry Band Multiplier (진입 전용 밴드 폭)
    let dynamicScalpBandMultiplier = 0.8; // SIDEWAYS: ATR의 0.8배
    if (marketRegime === 'BULL') {
      dynamicScalpBandMultiplier = 1.0; // BULL: Rule 9(돌파) 우선
    } else if (marketRegime === 'BEAR') {
      dynamicScalpBandMultiplier = 1.4; // BEAR: 함부로 저점 잡지 않도록 보수적
    }

    // 6. Box-Range Scalp Take-Profit Target: 0.5% ~ 0.8% (수수료 0.10% 제외 순수익 0.4%~0.7% 실현)
    let dynamicScalpTakeProfitPercent = 0.5;
    if (volatilityRatio > 2.0) {
      dynamicScalpTakeProfitPercent = 0.8;
    }

    return {
      dynamicAtr,
      dynamicOrderRatio,
      dynamicDcaStep,
      dynamicTrailingCallback,
      dynamicScalpBandMultiplier,
      dynamicScalpTakeProfitPercent,
      marketRegime,
      sidewaysContext,
      slope,
      volatilityRatio,
      rsi,
      volumeMultiplier,
      volumeMa
    };
  }

  /**
   * Evaluates all strategy rules deterministically and returns candidate signals.
   */
  public generateSignals(
    currentPrice: number,
    baselineValue: number,
    atrValue: number,
    params: BotParams,
    position: PositionSnapshot,
    dropSpeed: number,
    priceHistory: number[],
    higherTfTrend?: { trend: 'BULL' | 'SIDEWAYS' | 'BEAR'; htfSlope: number },
    rsi: number = 50.0,
    volumeMultiplier: number = 1.0,
    volumeMa: number = 0.0
  ): Signal[] {
    const signals: Signal[] = [];
    const now = Date.now();

    const adaptive = this.evaluateAdaptiveParams(currentPrice, baselineValue, atrValue, params, priceHistory, higherTfTrend, rsi, volumeMultiplier, volumeMa);
    const effectiveAtrMultiplier = params.autoPilotEnabled ? adaptive.dynamicAtr : params.atrMultiplier;

    // Minimum ATR Floor to prevent tick-size quantization trap (minimum 0.25% of price or 5,000 KRW)
    const minAtrFloor = Math.max(5000, Math.round(currentPrice * 0.0025));
    const effectiveAtr = Math.max(atrValue, minAtrFloor);

    const lowerBand = baselineValue - (effectiveAtr * effectiveAtrMultiplier);
    const upperBand = baselineValue + (effectiveAtr * effectiveAtrMultiplier);

    const snapshot = {
      baseline: baselineValue,
      atr: effectiveAtr,
      upperBand,
      lowerBand,
      currentStopLoss: position.initialStopPrice || (lowerBand - (effectiveAtr * params.stopLossMultiplier)),
      marketRegime: adaptive.marketRegime,
      sidewaysContext: adaptive.sidewaysContext,
      slope: adaptive.slope,
      volatilityRatio: adaptive.volatilityRatio,
      dynamicOrderRatio: adaptive.dynamicOrderRatio,
      rsi: adaptive.rsi,
      volumeMultiplier: adaptive.volumeMultiplier
    };

    const hasPosition = position.amount > 0 && position.entryPrice !== null;
    const entryPrice = position.entryPrice || currentPrice;
    const pnlPercent = hasPosition ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
    const isNeutralRange = adaptive.marketRegime === 'SIDEWAYS' && adaptive.sidewaysContext === 'NEUTRAL_RANGE';
    const isBearPause = adaptive.marketRegime === 'SIDEWAYS' && adaptive.sidewaysContext === 'BEAR_PAUSE';

    // --- Rule 1: Absolute Stop Loss (Priority 1) ---
    // Uses position's static initialStopPrice snapshot if available (-6.0% absolute floor)
    const stopLossPrice = position.initialStopPrice || (entryPrice * 0.94);
    const profitLockPrice = position.profitLockPrice || 0;
    if (hasPosition && profitLockPrice > 0 && currentPrice <= profitLockPrice) {
      signals.push({
        id: `SIG_PROFIT_LOCK_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'PYRAMID_PROFIT_LOCK',
        type: 'ABSOLUTE_STOP_EXIT',
        priority: 1,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[불타기 수익 보호 청산] 1차 불타기 후 보호선(₩${Math.round(profitLockPrice).toLocaleString()}) 이탈 ➡️ 전체 평단 수수료 포함 본전 이상 보호`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }
    if (hasPosition && (currentPrice <= stopLossPrice || pnlPercent <= -6.0)) {
      signals.push({
        id: `SIG_STOP_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'ABSOLUTE_STOP_LOSS',
        type: 'ABSOLUTE_STOP_EXIT',
        priority: 1,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[마지노선 절대 손절] 진입가 대비 ${pnlPercent.toFixed(2)}% 이탈 ➡️ 원금보호 100% 전량 청산`,
        indicatorSnapshot: snapshot
      });
      return signals; // Absolute stop overrides everything
    }

    // --- Rule 2: Emergency Trend-Aware Cut (Priority 2) ---
    if (
      hasPosition &&
      params.trendAwareCutEnabled &&
      currentPrice < lowerBand &&
      dropSpeed <= -Math.abs(params.trendDropSpeedThreshold)
    ) {
      signals.push({
        id: `SIG_EMERGENCY_CUT_${now}`,
        timestamp: now,
        timeframe: '5s_window',
        source: 'TREND_AWARE_EMERGENCY_CUT',
        type: 'EMERGENCY_TREND_CUT',
        priority: 2,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[시세 흐름 긴급 감지] 급락 가속도(${dropSpeed.toFixed(2)}%) 포착 ➡️ 자금보호 40% 선제 조기손절`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 3: 2-Stage Capital Recycling Partial Loss Cuts (Priority 2) ---
    const cutCount = position.partialCutCount || 0;
    if (hasPosition && params.partialLossCutEnabled && position.state !== 'EMERGENCY_EXIT') {
      // 1st Stage: -1.0% drop -> trim 30% to secure cash for DCA #1
      if (cutCount === 0 && pnlPercent <= -1.0) {
        signals.push({
          id: `SIG_PARTIAL_CUT_1_${now}`,
          timestamp: now,
          timeframe: 'tick',
          source: 'PARTIAL_LOSS_CUT',
          type: 'PARTIAL_LOSS_CUT',
          priority: 2,
          symbol: params.symbol,
          price: currentPrice,
          reason: `[자금순환 1차 부분손절] 진입가 대비 ${pnlPercent.toFixed(2)}% 하락 ➡️ 30% 현금 회수 (DCA 1차 리사이클링 대기)`,
          indicatorSnapshot: snapshot
        });
        return signals;
      }
      // 2nd Stage: -3.2% drop -> trim 50% of remaining to secure cash for DCA #2
      else if (cutCount === 1 && pnlPercent <= -3.2) {
        signals.push({
          id: `SIG_PARTIAL_CUT_2_${now}`,
          timestamp: now,
          timeframe: 'tick',
          source: 'PARTIAL_LOSS_CUT',
          type: 'PARTIAL_LOSS_CUT',
          priority: 2,
          symbol: params.symbol,
          price: currentPrice,
          reason: `[자금순환 2차 부분손절] 진입가 대비 ${pnlPercent.toFixed(2)}% 하락 ➡️ 잔여 수량 50% 현금 회수 (DCA 2차 리사이클링 대기)`,
          indicatorSnapshot: snapshot
        });
        return signals;
      }
    }

    // --- Rule 3-b: Box-Range Scalp Take-Profit (Priority 3, SIDEWAYS only, Full Exit) ---
    // Scalp TP target dynamically scales up with pyramid count so multi-stage add-ons are fully realized:
    // 0 adds: 0.50% | 1 add: 0.60% | 2 adds: 0.70% | 3 adds: 0.85%
    let scalpTpTargetPercent = adaptive.dynamicScalpTakeProfitPercent;
    if (position.boxPyramidCount === 1) {
      scalpTpTargetPercent = Math.max(scalpTpTargetPercent, 0.60);
    } else if (position.boxPyramidCount === 2) {
      scalpTpTargetPercent = Math.max(scalpTpTargetPercent, 0.70);
    } else if (position.boxPyramidCount >= 3) {
      scalpTpTargetPercent = Math.max(scalpTpTargetPercent, 0.85);
    }

    if (
      hasPosition &&
      params.autoPilotEnabled &&
      isNeutralRange &&
      !position.trailingActive &&
      pnlPercent >= scalpTpTargetPercent
    ) {
      // Strategy Lab: a volume-backed upward expansion is not treated as a
      // normal box-range exit. Realize half, then protect the remaining half
      // at breakeven-plus-fees so it can participate in a regime transition.
      const isTrendExpansion = adaptive.volumeMultiplier >= 1.5 && adaptive.slope >= 0.05;
      if (params.experimentScalpTrendExpansionEnabled && isTrendExpansion) {
        signals.push({
          id: `SIG_SCALP_PARTIAL_TP_${now}`,
          timestamp: now,
          timeframe: 'tick',
          source: 'BOX_RANGE_SCALP_ENGINE',
          type: 'SCALP_PARTIAL_TAKE_PROFIT',
          priority: 3,
          symbol: params.symbol,
          price: currentPrice,
          reason: `[추세 확장 박스권 익절] 거래량 ${adaptive.volumeMultiplier.toFixed(2)}x·기울기 +${adaptive.slope.toFixed(2)}% 확인 ➡️ 50% 익절, 잔량 본전 보호`,
          indicatorSnapshot: snapshot
        });
        return signals;
      }
      signals.push({
        id: `SIG_SCALP_TP_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BOX_RANGE_SCALP_ENGINE',
        type: 'SCALP_TAKE_PROFIT',
        priority: 3,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[박스권 짤짤이 익절] 목표 수익률 +${scalpTpTargetPercent.toFixed(2)}% 도달 (수익률: +${pnlPercent.toFixed(2)}%) ➡️ 전량 매도`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 4: Trailing Take Profit (Priority 3) ---
    if (hasPosition && params.trailingStopEnabled) {
      const baseCallback = params.autoPilotEnabled ? adaptive.dynamicTrailingCallback : params.trailingCallbackPercent;
      // 2차 불타기까지 체결된 후에는 상단에서의 추가 매수를 금지하고,
      // 수익 되돌림을 줄이기 위해 콜백을 0.6%로 더 타이트하게 고정한다.
      const effectiveCallback = position.pyramidingCount >= 2 ? Math.min(baseCallback, 0.6) : baseCallback;
      
      if (position.trailingActive && position.trailingPeakPrice) {
        const peakPrice = position.trailingPeakPrice;
        const entryPrice = position.entryPrice || currentPrice;

        // Minimum Guaranteed Profit Floor: 트레일링 매도가는 평단 대비 최소 +0.2% 이상으로 하한선 고정
        const rawExitPrice = peakPrice * (1 - effectiveCallback / 100);
        const minFloorExitPrice = entryPrice * 1.002; // 평단 대비 +0.2% 보장선
        const targetExitPrice = Math.max(rawExitPrice, minFloorExitPrice);

        const pullbackPercent = ((peakPrice - currentPrice) / peakPrice) * 100;
        const isPullback = currentPrice <= targetExitPrice;
        const isNetProfit = pnlPercent >= 0.1 && (position.entryPrice ? currentPrice > position.entryPrice : true);

        if (isPullback && isNetProfit) {
          signals.push({
            id: `SIG_TRAILING_EXIT_${now}`,
            timestamp: now,
            timeframe: 'tick',
            source: 'TRAILING_TAKE_PROFIT',
            type: 'TRAILING_STOP_EXIT',
            priority: 3,
            symbol: params.symbol,
            price: currentPrice,
            reason: `[트레일링 익절] 최고점(₩${Math.round(peakPrice).toLocaleString()}) 대비 -${pullbackPercent.toFixed(2)}% 하락 꺾임 익절 (수익률: +${pnlPercent.toFixed(2)}%)`,
            indicatorSnapshot: snapshot
          });
          return signals;
        }
      }
    }

    // --- Rule 5: Bottom Re-entry Buy (Priority 4) ---
    if (position.state === 'REENTRY_ALLOWED') {
      signals.push({
        id: `SIG_REENTRY_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BOTTOM_REENTRY_ENGINE',
        type: 'REENTRY_BUY',
        priority: 4,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[바닥 스마트 재매수] 급락 진정 및 지지 확인 ➡️ 세이브된 현금으로 최저점 재진입`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 6: Smart DCA Buy (Priority 5) ---
    if (hasPosition && params.dcaEnabled && position.state !== 'EMERGENCY_EXIT') {
      const dropFromEntry = ((entryPrice - currentPrice) / entryPrice) * 100;
      
      // Find next available DCA slot
      // A partially-filled slot is intentionally kept open: DCA 2차의 접근 반등
      // 선매수(40%) 뒤, 본래 -4.2%에서 남은 60%를 같은 슬롯으로 집행한다.
      const nextSlot = position.dcaSlots.find((s) => s.status === 'AVAILABLE' || s.status === 'PARTIALLY_FILLED');
      if (nextSlot) {
        // Slot 1: -2.0% (1차 30% 덜어낸 후 저점 추매) | Slot 2: -4.2% (2차 50% 덜어낸 후 저점 추매) | Slot 3: -5.5%
        const slotDropTarget = nextSlot.slotNumber === 1 ? 2.0 : nextSlot.slotNumber === 2 ? 4.2 : 5.5;
        const slotTargetPrice = nextSlot.status === 'PARTIALLY_FILLED' && nextSlot.plannedTargetPrice
          ? nextSlot.plannedTargetPrice
          : entryPrice * (1 - slotDropTarget / 100);

        // DCA 2차 접근 반등 선매수: -3.5%~-4.15%에서 최근 20틱 저점 대비
        // 0.7% 이상 회복하고 단기 추세가 전환될 때에만, 2차 예산의 40%를 집행한다.
        // 단순히 -3.5%를 통과했다고 매수하지 않으므로 하락 중 추격 매수를 피한다.
        const recentWindow = priceHistory.slice(-20);
        const recoveryLow = Math.min(currentPrice, ...(recentWindow.length ? recentWindow : [currentPrice]));
        const reboundFromLow = recoveryLow > 0 ? ((currentPrice - recoveryLow) / recoveryLow) * 100 : 0;
        const recoveryLowDrop = entryPrice > 0 ? ((entryPrice - recoveryLow) / entryPrice) * 100 : 0;
        const isDca2RecoveryWindow =
          nextSlot.slotNumber === 2 &&
          nextSlot.status === 'AVAILABLE' &&
          recoveryLowDrop >= 3.5 &&
          recoveryLowDrop <= 4.15 &&
          // 반등이 너무 진행된 뒤의 추격 매수를 막는다. 저점 -3.5%에서
          // +0.7% 반등한 뒤에도 실행할 수 있도록 현재가 자체는 접근 구간 밖을 허용한다.
          dropFromEntry >= 2.5;
        const isRecoveryConfirmed = reboundFromLow >= 0.7 && adaptive.slope >= 0.05;
        // Strategy Lab filters are deliberately opt-in. They only gate the DCA 2
        // recovery prebuy; the original -4.2% remainder order is never blocked.
        const isDca2RsiRecoveryConfirmed = !params.experimentDca2RsiRecoveryEnabled || adaptive.rsi >= 35;
        const isDca2VolumeConfirmed = !params.experimentDca2VolumeConfirmationEnabled || adaptive.volumeMultiplier >= 1.05;

        if (isDca2RecoveryWindow && isRecoveryConfirmed && isDca2RsiRecoveryConfirmed && isDca2VolumeConfirmed) {
          signals.push({
            id: `SIG_DCA_2_RECOVERY_${now}`,
            timestamp: now,
            timeframe: 'tick',
            source: 'DCA_RECOVERY_ENGINE',
            type: 'DCA_BUY',
            priority: 5,
            symbol: params.symbol,
            price: currentPrice,
            dcaBudgetFraction: 0.4,
            dcaExecution: 'RECOVERY_PREBUY',
            reason: `[DCA 2차 접근 반등 선매수] -${dropFromEntry.toFixed(2)}% 구간에서 최근 저점 대비 +${reboundFromLow.toFixed(2)}% 반등·단기 추세 전환 확인${params.experimentDca2RsiRecoveryEnabled ? ` · RSI ${adaptive.rsi.toFixed(0)}≥35` : ''}${params.experimentDca2VolumeConfirmationEnabled ? ` · 거래량 ${adaptive.volumeMultiplier.toFixed(2)}x≥1.05x` : ''} ➡️ 2차 예산의 40%만 선매수`,
            indicatorSnapshot: snapshot
          });
          return signals;
        }

        if (currentPrice <= slotTargetPrice) {
          const isDca2Remainder = nextSlot.slotNumber === 2 && nextSlot.status === 'PARTIALLY_FILLED';
          signals.push({
            id: `SIG_DCA_${nextSlot.slotNumber}_${now}`,
            timestamp: now,
            timeframe: 'tick',
            source: 'DCA_ENGINE',
            type: 'DCA_BUY',
            priority: 5,
            symbol: params.symbol,
            price: currentPrice,
            dcaBudgetFraction: isDca2Remainder ? 0.6 : undefined,
            dcaExecution: isDca2Remainder ? 'COMPLETE_REMAINDER' : undefined,
            reason: isDca2Remainder
              ? `[DCA 2차 잔여 매수] 평단 대비 -${dropFromEntry.toFixed(2)}%로 본 기준(-4.2%) 도달 ➡️ 남은 2차 예산 60% 집행`
              : `[DCA ${nextSlot.slotNumber}차 리사이클링 추매] 평단 대비 -${dropFromEntry.toFixed(2)}% 저점 도달 ➡️ 세이브된 현금으로 평단가 대폭 인하 매수`,
            indicatorSnapshot: snapshot
          });
          return signals;
        }
      }
    }

    // Trailing Distribution Gate: 한 번이라도 트레일링 익절이 시작된 포지션은 전량 청산(FLAT)까지 모든 불타기 일체 금지
    const hasTrailingExitedThisCycle = Boolean(position.trailingExitCount && position.trailingExitCount >= 1);

    // Regime exposure controller: target allocation is reached gradually, not
    // by enlarging the initial order. The governor calculates the actual gap
    // to the target and caps every fill at 5% of total capital.
    const sinceLastRegimeAddMs = now - (position.lastRegimeRebalanceAt || 0);
    const canAddByTime = sinceLastRegimeAddMs >= 120_000;
    const recentPrices = priceHistory.slice(-10);
    const recentLow = recentPrices.length ? Math.min(...recentPrices) : currentPrice;
    const reboundFromRecentLow = recentLow > 0 ? ((currentPrice - recentLow) / recentLow) * 100 : 0;

    if (
      hasPosition && params.autoPilotEnabled && params.pyramidingEnabled &&
      adaptive.marketRegime === 'BULL' && higherTfTrend?.trend === 'BULL' &&
      !position.trailingActive && !hasTrailingExitedThisCycle && canAddByTime &&
      pnlPercent >= 0.30 && adaptive.slope >= 0.05 && adaptive.volumeMultiplier >= 1.05 &&
      adaptive.rsi >= 50 && adaptive.rsi <= 70
    ) {
      signals.push({
        id: `SIG_BULL_TARGET_ADD_${now}`, timestamp: now, timeframe: 'tick', source: 'REGIME_EXPOSURE_CONTROLLER',
        type: 'REGIME_REBALANCE_BUY', priority: 6, symbol: params.symbol, price: currentPrice,
        regimeTargetExposurePercent: 65,
        reason: `[BULL 목표비중 채우기] 상승 추세·거래량 ${adaptive.volumeMultiplier.toFixed(2)}x·기울기 +${adaptive.slope.toFixed(2)}% 확인 ➡️ 목표 코인 비중 65%까지 5%p 이내 추가`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    if (
      hasPosition && params.autoPilotEnabled && params.dcaEnabled &&
      adaptive.marketRegime === 'BEAR' && !position.trailingActive && canAddByTime &&
      pnlPercent <= -0.50 && reboundFromRecentLow >= 0.20 && adaptive.slope >= -0.15 &&
      adaptive.rsi >= 25 && adaptive.rsi <= 48
    ) {
      signals.push({
        id: `SIG_BEAR_TARGET_ADD_${now}`, timestamp: now, timeframe: 'tick', source: 'REGIME_EXPOSURE_CONTROLLER',
        type: 'REGIME_REBALANCE_BUY', priority: 6, symbol: params.symbol, price: currentPrice,
        regimeTargetExposurePercent: 40,
        reason: `[BEAR 목표비중 채우기] 최근 저점 대비 +${reboundFromRecentLow.toFixed(2)}% 반등·하락 둔화 확인 ➡️ 목표 코인 비중 40%까지 5%p 이내 추가`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 7: Pyramiding Buy (Priority 6) ---
    const isPyramidRsiConfirmed = !params.experimentPyramidRsiGuardEnabled || (adaptive.rsi >= 55 && adaptive.rsi <= 68);
    const isPyramidVolumeConfirmed = !params.experimentPyramidVolumeConfirmationEnabled || adaptive.volumeMultiplier >= 1.15;

    // BULL 지속 확인(15분 추세 상승) 뒤에는, 기존 +1.5% 불타기 전에
    // +0.7%~+1.0% 구간의 강한 상승 모멘텀을 0.35 Unit만 추종한다.
    // 트레일링 무장(+1.0%) 전 구간으로 제한해 상단 추격과 기존 불타기 규칙의
    // 중복을 피하고, 한 번 체결되면 pyramidingCount를 공유해 총 2회 제한도 유지한다.
    const isBullContinuationConfirmed =
      higherTfTrend?.trend === 'BULL' &&
      higherTfTrend.htfSlope > 0 &&
      adaptive.slope >= 0.10 &&
      adaptive.volumeMultiplier >= 1.30 &&
      adaptive.rsi >= 52 && adaptive.rsi <= 68;
    const isEarlyTrendFollowWindow = pnlPercent >= 0.70 && pnlPercent < 1.0;

    if (
      hasPosition &&
      params.pyramidingEnabled &&
      !hasTrailingExitedThisCycle &&
      !position.trailingActive &&
      position.pyramidingCount === 0 &&
      adaptive.marketRegime === 'BULL' &&
      isEarlyTrendFollowWindow &&
      isBullContinuationConfirmed &&
      isPyramidRsiConfirmed &&
      isPyramidVolumeConfirmed
    ) {
      signals.push({
        id: `SIG_BULL_TREND_FOLLOW_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BULL_TREND_FOLLOW_ENGINE',
        type: 'PYRAMID_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        pyramidBudgetFraction: 0.35,
        reason: `[BULL 추세추종 불타기] 15분 상승 추세·기울기 +${adaptive.slope.toFixed(2)}%·거래량 ${adaptive.volumeMultiplier.toFixed(2)}x·RSI ${adaptive.rsi.toFixed(0)} 확인, 수익 +${pnlPercent.toFixed(2)}% ➡️ 0.35 Unit 추가 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    if (
      hasPosition &&
      params.pyramidingEnabled &&
      !hasTrailingExitedThisCycle &&
      !position.trailingActive &&
      position.pyramidingCount < params.maxPyramidingOrders &&
      pnlPercent >= params.pyramidingStepPercent * (position.pyramidingCount + 1) &&
      adaptive.marketRegime === 'BULL' &&
      isPyramidRsiConfirmed &&
      isPyramidVolumeConfirmed
    ) {
      const nextStage = position.pyramidingCount + 1;
      const pyramidBudgetFraction = nextStage === 1 ? 0.50 : 0.35;
      signals.push({
        id: `SIG_PYRAMID_${nextStage}_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'PYRAMIDING_ENGINE',
        type: 'PYRAMID_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        pyramidBudgetFraction,
        reason: `[상승 불타기 ${nextStage}차] 평단 대비 +${pnlPercent.toFixed(2)}% 상승·추세 유지 확인${params.experimentPyramidRsiGuardEnabled ? ` · RSI ${adaptive.rsi.toFixed(0)} (55~68)` : ''}${params.experimentPyramidVolumeConfirmationEnabled ? ` · 거래량 ${adaptive.volumeMultiplier.toFixed(2)}x≥1.15x` : ''} ➡️ ${nextStage === 1 ? '0.50' : '0.35'} Unit만 추가 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 7-b: Sideways Box-Range Pyramid Buy (Priority 6, 2-Stage Scaled: 0.50 -> 0.50 Unit) ---
    const BOX_PYRAMID_MAX_ADDS = 2; // 최대 2회 분할 불타기 (0.50 Unit씩)
    const BOX_PYRAMID_STEP_PERCENT = 0.25; // 각 단계별 평단 대비 +0.25% 상승 시 추가 매수
    const BOX_PYRAMID_RATIOS = [0.50, 0.50];

    if (
      hasPosition &&
      params.pyramidingEnabled &&
      params.autoPilotEnabled &&
      !hasTrailingExitedThisCycle &&
      !position.trailingActive &&
      isNeutralRange &&
      position.boxPyramidCount < BOX_PYRAMID_MAX_ADDS &&
      pnlPercent >= BOX_PYRAMID_STEP_PERCENT
    ) {
      const stage = position.boxPyramidCount + 1;
      const unitScale = BOX_PYRAMID_RATIOS[position.boxPyramidCount] || 0.50;
      signals.push({
        id: `SIG_BOX_PYRAMID_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BOX_RANGE_SCALP_ENGINE',
        type: 'BOX_PYRAMID_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[박스권 불타기 #${stage}차] 보유 포지션 +${pnlPercent.toFixed(2)}% 수익 중 (${unitScale} Unit) 적극 추가매수 (국면: SIDEWAYS)`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // Falling Knife Shield: 상위 타임프레임이 하락세이면서 급락 속도가 빠르면 바닥 확인 전 진입 보류
    const isFallingKnife = snapshot.slope < -0.08 && (higherTfTrend?.trend === 'BEAR' || adaptive.marketRegime === 'BEAR');

    // --- Rule 8: Initial 1st Entry Buy (Priority 6) ---
    if (!hasPosition && position.state === 'FLAT' && currentPrice <= lowerBand && !isFallingKnife && !isBearPause) {
      signals.push({
        id: `SIG_ENTRY_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'INITIAL_ENTRY_ENGINE',
        type: 'ENTRY_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[1차 저점 진입] 하단 밴드(₩${Math.round(lowerBand).toLocaleString()}) 터치 과매도 반등 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 8-b: Sideways Box-Range Scalp Buy (Priority 6) ---
    if (
      !hasPosition &&
      position.state === 'FLAT' &&
      !isBearPause &&
      params.autoPilotEnabled &&
      isNeutralRange &&
      currentPrice <= (baselineValue - (effectiveAtr * adaptive.dynamicScalpBandMultiplier)) &&
      currentPrice > lowerBand
    ) {
      signals.push({
        id: `SIG_SCALP_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BOX_RANGE_SCALP_ENGINE',
        type: 'ENTRY_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[박스권 스캘핑 진입] 기준선 대비 소폭 눌림 포착 (국면: ${adaptive.marketRegime})`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 8-c: Box-Range Bounce-Confirmation Scalp Buy (Priority 6) ---
    // Rule 8-b(기준선 기반)가 완만한 하락에서는 기준선이 가격을 쫓아가느라 잘 안 걸리는 문제를 보완.
    // 기준선이 아니라 "실제로 확정된 최근 저점" 대비 소폭 반등을 확인하고 진입한다.
    const SCALP_BOUNCE_LOOKBACK = 10; // 최근 몇 개 캔들(약 10분)에서 저점을 찾을지
    const SCALP_BOUNCE_CONFIRM_PERCENT = 0.15; // 저점 대비 이만큼 반등해야 "돌아섰다"고 인정

    if (
      !hasPosition &&
      position.state === 'FLAT' &&
      params.autoPilotEnabled &&
      isNeutralRange &&
      priceHistory.length >= SCALP_BOUNCE_LOOKBACK
    ) {
      const lookbackSlice = priceHistory.slice(-SCALP_BOUNCE_LOOKBACK);
      const recentLow = Math.min(...lookbackSlice);

      // 그 저점이 실제로 기준선보다 낮았을 때만 유효한 "눌림"으로 인정 (노이즈성 미세 등락 배제)
      const wasGenuineDip = recentLow <= baselineValue;

      // 저점 대비 확인폭만큼 반등했는지
      const bounceThreshold = recentLow * (1 + SCALP_BOUNCE_CONFIRM_PERCENT / 100);
      const hasBounced = currentPrice > recentLow && currentPrice >= bounceThreshold;

      // 이미 기준선을 넘어버린 가격은 Rule 9/9-b 영역이니 여기선 제외
      const stillBelowBaseline = currentPrice <= baselineValue;

      if (wasGenuineDip && hasBounced && stillBelowBaseline) {
        signals.push({
          id: `SIG_SCALP_BOUNCE_${now}`,
          timestamp: now,
          timeframe: 'tick',
          source: 'BOX_RANGE_SCALP_ENGINE',
          type: 'ENTRY_BUY',
          priority: 6,
          symbol: params.symbol,
          price: currentPrice,
          reason: `[박스권 스캘핑 진입] 저점(₩${Math.round(recentLow).toLocaleString()}) 대비 +${SCALP_BOUNCE_CONFIRM_PERCENT}% 반등 확인 매수 (국면: ${adaptive.marketRegime})`,
          indicatorSnapshot: snapshot
        });
        return signals;
      }
    }

    // --- Rule 9: Breakout 1st Entry Buy (Priority 6) ---
    const isBreakoutOverbought = adaptive.rsi > 68;
    const isVolumeConfirmed = !snapshot.volumeMultiplier || snapshot.volumeMultiplier >= 1.15;

    if (
      !hasPosition &&
      position.state === 'FLAT' &&
      params.breakoutEntryEnabled !== false &&
      currentPrice > baselineValue &&
      (adaptive.marketRegime === 'BULL' || adaptive.slope >= 0.10) &&
      !isBreakoutOverbought &&
      isVolumeConfirmed
    ) {
      signals.push({
        id: `SIG_BREAKOUT_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BREAKOUT_ENTRY_ENGINE',
        type: 'BREAKOUT_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[1차 돌파 진입] 상승 추세(BULL) 모멘텀(기울기: +${adaptive.slope.toFixed(2)}%, RSI: ${adaptive.rsi.toFixed(0)}, 거래량: ${adaptive.volumeMultiplier.toFixed(2)}x) 돌파 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 9-b: Sideways Box-Range Upside Scalp Buy (Priority 6) ---
    const isBoxOverbought = adaptive.rsi > 65;

    if (
      !hasPosition &&
      position.state === 'FLAT' &&
      params.autoPilotEnabled &&
      isNeutralRange &&
      currentPrice > baselineValue &&
      currentPrice <= (baselineValue + (effectiveAtr * adaptive.dynamicScalpBandMultiplier)) &&
      !isBoxOverbought
    ) {
      signals.push({
        id: `SIG_SCALP_UP_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BOX_RANGE_SCALP_ENGINE',
        type: 'BREAKOUT_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[박스권 상단 스캘핑 진입] 기준선 소폭 상향 돌파 포착 (RSI: ${adaptive.rsi.toFixed(0)}, 국면: SIDEWAYS)`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    return signals;
  }
}
