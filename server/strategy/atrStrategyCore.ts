import { Signal, SignalType, BotParams, PositionSnapshot } from '../types/trading';

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
    priceHistory: number[]
  ) {
    if (priceHistory.length < 15) {
      return {
        dynamicAtr: params.atrMultiplier,
        dynamicOrderRatio: params.orderRatio,
        dynamicDcaStep: params.safetyOrderStepPercent,
        dynamicTrailingCallback: params.trailingCallbackPercent,
        marketRegime: 'SIDEWAYS' as const,
        slope: 0,
        volatilityRatio: 1.5
      };
    }

    const shortPeriod = priceHistory.slice(-5);
    const midPeriod = priceHistory.slice(-15);
    const shortMa = shortPeriod.reduce((a, b) => a + b, 0) / shortPeriod.length;
    const midMa = midPeriod.reduce((a, b) => a + b, 0) / midPeriod.length;

    const slope = ((shortMa - midMa) / midMa) * 100;
    const priceToBaseline = ((currentPrice - baselineValue) / baselineValue) * 100;
    const volatilityRatio = baselineValue > 0 ? (atrValue / baselineValue) * 100 : 1.5;

    // 1. Dynamic ATR Multiplier: 1.6x (aggressive uptrend) ~ 3.8x (deep defensive downtrend)
    const rawAtr = 2.6 - (slope * 2.2) + ((volatilityRatio - 1.2) * 0.4);
    const dynamicAtr = Number(Math.max(1.6, Math.min(3.8, rawAtr)).toFixed(1));

    // 2. Dynamic Order Ratio: 15% ~ 60%
    const rawRatio = 30 + (slope * 30);
    const dynamicOrderRatio = Math.round(Math.max(15, Math.min(60, rawRatio)));

    // 3. Dynamic DCA Step: 1.5% ~ 3.5%
    const rawDca = 2.0 + (volatilityRatio * 0.5);
    const dynamicDcaStep = Number(Math.max(1.5, Math.min(3.5, rawDca)).toFixed(1));

    // 4. Dynamic Trailing Callback: 0.6% ~ 1.5%
    const rawCallback = 0.8 + (volatilityRatio * 0.2);
    const dynamicTrailingCallback = Number(Math.max(0.6, Math.min(1.5, rawCallback)).toFixed(1));

    let marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR' = 'SIDEWAYS';
    if (slope > 0.12 && priceToBaseline > 0.08) {
      marketRegime = 'BULL';
    } else if (slope < -0.12 && priceToBaseline < -0.08) {
      marketRegime = 'BEAR';
    }

    return {
      dynamicAtr,
      dynamicOrderRatio,
      dynamicDcaStep,
      dynamicTrailingCallback,
      marketRegime,
      slope,
      volatilityRatio
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
    priceHistory: number[]
  ): Signal[] {
    const signals: Signal[] = [];
    const now = Date.now();

    const adaptive = this.evaluateAdaptiveParams(currentPrice, baselineValue, atrValue, params, priceHistory);
    const effectiveAtrMultiplier = params.autoPilotEnabled ? adaptive.dynamicAtr : params.atrMultiplier;

    const lowerBand = baselineValue - (atrValue * effectiveAtrMultiplier);
    const upperBand = baselineValue + (atrValue * effectiveAtrMultiplier);

    const snapshot = {
      baseline: baselineValue,
      atr: atrValue,
      upperBand,
      lowerBand,
      currentStopLoss: position.initialStopPrice || (lowerBand - (atrValue * params.stopLossMultiplier)),
      marketRegime: adaptive.marketRegime,
      slope: adaptive.slope,
      volatilityRatio: adaptive.volatilityRatio
    };

    const hasPosition = position.amount > 0 && position.entryPrice !== null;
    const entryPrice = position.entryPrice || currentPrice;
    const pnlPercent = hasPosition ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

    // --- Rule 1: Absolute Stop Loss (Priority 1) ---
    // Uses position's static initialStopPrice snapshot if available
    const stopLossPrice = position.initialStopPrice || (lowerBand - (atrValue * params.stopLossMultiplier));
    if (hasPosition && currentPrice <= stopLossPrice) {
      signals.push({
        id: `SIG_STOP_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'ABSOLUTE_STOP_LOSS',
        type: 'ABSOLUTE_STOP_EXIT',
        priority: 1,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[절대 손절선 이탈] 진입가 대비 ${pnlPercent.toFixed(2)}% 하락 (스탑가: ₩${Math.round(stopLossPrice).toLocaleString()})`,
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

    // --- Rule 3: Partial Loss Cut (Priority 2) ---
    if (
      hasPosition &&
      params.partialLossCutEnabled &&
      pnlPercent <= -Math.abs(params.partialLossCutThreshold) &&
      position.state !== 'DEFENSIVE' &&
      position.state !== 'EMERGENCY_EXIT'
    ) {
      signals.push({
        id: `SIG_PARTIAL_CUT_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'PARTIAL_LOSS_CUT',
        type: 'PARTIAL_LOSS_CUT',
        priority: 2,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[자금순환 부분손절] 손실률 ${pnlPercent.toFixed(2)}% 도달 ➡️ ${params.partialLossCutPercent}% 분할 손절로 바닥 물타기 현금 회수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 4: Trailing Take Profit (Priority 3) ---
    if (hasPosition && params.trailingStopEnabled) {
      const effectiveCallback = params.autoPilotEnabled ? adaptive.dynamicTrailingCallback : params.trailingCallbackPercent;
      
      if (position.trailingActive && position.trailingPeakPrice) {
        const peakPrice = position.trailingPeakPrice;
        const pullbackPercent = ((peakPrice - currentPrice) / peakPrice) * 100;
        if (pullbackPercent >= effectiveCallback) {
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
    if (hasPosition && params.dcaEnabled && position.state !== 'DEFENSIVE' && position.state !== 'EMERGENCY_EXIT') {
      const effectiveDcaStep = params.autoPilotEnabled ? adaptive.dynamicDcaStep : params.safetyOrderStepPercent;
      const dropFromEntry = ((entryPrice - currentPrice) / entryPrice) * 100;
      
      // Find next available DCA slot
      const nextSlot = position.dcaSlots.find((s) => s.status === 'AVAILABLE');
      if (nextSlot && dropFromEntry >= effectiveDcaStep * nextSlot.slotNumber) {
        signals.push({
          id: `SIG_DCA_${nextSlot.slotNumber}_${now}`,
          timestamp: now,
          timeframe: 'tick',
          source: 'DCA_ENGINE',
          type: 'DCA_BUY',
          priority: 5,
          symbol: params.symbol,
          price: currentPrice,
          reason: `[DCA ${nextSlot.slotNumber}차 물타기] 평단 대비 -${dropFromEntry.toFixed(2)}% 하락 분할 매수`,
          indicatorSnapshot: snapshot
        });
        return signals;
      }
    }

    // --- Rule 7: Pyramiding Buy (Priority 6) ---
    if (
      hasPosition &&
      params.pyramidingEnabled &&
      position.pyramidingCount < params.maxPyramidingOrders &&
      pnlPercent >= params.pyramidingStepPercent * (position.pyramidingCount + 1) &&
      !position.trailingActive
    ) {
      signals.push({
        id: `SIG_PYRAMID_${position.pyramidingCount + 1}_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'PYRAMIDING_ENGINE',
        type: 'PYRAMID_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[상승 불타기 ${position.pyramidingCount + 1}차] 평단 대비 +${pnlPercent.toFixed(2)}% 상승 추가 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 8: Initial 1st Entry Buy (Priority 6) ---
    if (!hasPosition && position.state === 'FLAT' && currentPrice <= lowerBand) {
      signals.push({
        id: `SIG_ENTRY_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'INITIAL_ENTRY_ENGINE',
        type: 'ENTRY_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[1차 진입] 하단 밴드(₩${Math.round(lowerBand).toLocaleString()}) 터치 과매도 반등 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    return signals;
  }
}
