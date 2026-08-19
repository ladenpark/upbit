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
    priceHistory: number[],
    higherTfTrend?: { trend: 'BULL' | 'SIDEWAYS' | 'BEAR'; htfSlope: number }
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

    // Multi-Timeframe Confluence Regime Determination (15m + 1m)
    let marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR' = 'SIDEWAYS';
    const htf = higherTfTrend?.trend || 'SIDEWAYS';

    if (slope > 0.10 && priceToBaseline > 0.05 && htf !== 'BEAR') {
      marketRegime = 'BULL';
    } else if (slope < -0.10 && priceToBaseline < -0.05 && htf !== 'BULL') {
      marketRegime = 'BEAR';
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
    priceHistory: number[],
    higherTfTrend?: { trend: 'BULL' | 'SIDEWAYS' | 'BEAR'; htfSlope: number }
  ): Signal[] {
    const signals: Signal[] = [];
    const now = Date.now();

    const adaptive = this.evaluateAdaptiveParams(currentPrice, baselineValue, atrValue, params, priceHistory, higherTfTrend);
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
      slope: adaptive.slope,
      volatilityRatio: adaptive.volatilityRatio,
      dynamicOrderRatio: adaptive.dynamicOrderRatio
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

    // --- Rule 3-b: Box-Range Scalp Take-Profit (Priority 3, SIDEWAYS only, Full Exit) ---
    if (
      hasPosition &&
      params.autoPilotEnabled &&
      adaptive.marketRegime === 'SIDEWAYS' &&
      !position.trailingActive &&
      pnlPercent >= adaptive.dynamicScalpTakeProfitPercent
    ) {
      signals.push({
        id: `SIG_SCALP_TP_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BOX_RANGE_SCALP_ENGINE',
        type: 'SCALP_TAKE_PROFIT',
        priority: 3,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[박스권 짤짤이 익절] 목표 수익률 +${adaptive.dynamicScalpTakeProfitPercent.toFixed(2)}% 도달 (수익률: +${pnlPercent.toFixed(2)}%) ➡️ 전량 매도`,
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
        
        // Profit Lock Gate: Trailing exit is strictly executed ONLY when in net profit above entry price
        const isNetProfit = pnlPercent >= 0.1 && (position.entryPrice ? currentPrice > position.entryPrice : true);

        if (pullbackPercent >= effectiveCallback && isNetProfit) {
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
      adaptive.marketRegime === 'BULL'
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

    // --- Rule 7-b: Sideways Box-Range Pyramid Buy (Priority 6, 독립 카운터, 최대 1회) ---
    const BOX_PYRAMID_MAX_ADDS = 1; // 박스권에서는 최대 1회만 (하락 리스크 제한)
    const BOX_PYRAMID_STEP_PERCENT = 0.25; // 짤짤이 목표수익(0.5~0.8%)보다 낮은 지점에서만

    if (
      hasPosition &&
      params.pyramidingEnabled &&
      params.autoPilotEnabled &&
      adaptive.marketRegime === 'SIDEWAYS' &&
      !position.trailingActive &&
      position.boxPyramidCount < BOX_PYRAMID_MAX_ADDS &&
      pnlPercent >= BOX_PYRAMID_STEP_PERCENT
    ) {
      signals.push({
        id: `SIG_BOX_PYRAMID_${now}`,
        timestamp: now,
        timeframe: 'tick',
        source: 'BOX_RANGE_SCALP_ENGINE',
        type: 'BOX_PYRAMID_BUY',
        priority: 6,
        symbol: params.symbol,
        price: currentPrice,
        reason: `[박스권 불타기 추가매수] 보유 포지션 +${pnlPercent.toFixed(2)}% 수익 중 소액 추가매수 (국면: SIDEWAYS)`,
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
        reason: `[1차 저점 진입] 하단 밴드(₩${Math.round(lowerBand).toLocaleString()}) 터치 과매도 반등 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 8-b: Sideways Box-Range Scalp Buy (Priority 6) ---
    if (
      !hasPosition &&
      position.state === 'FLAT' &&
      params.autoPilotEnabled &&
      adaptive.marketRegime !== 'BULL' &&
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
      adaptive.marketRegime !== 'BULL' &&
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
    if (
      !hasPosition &&
      position.state === 'FLAT' &&
      params.breakoutEntryEnabled !== false &&
      currentPrice > baselineValue &&
      (adaptive.marketRegime === 'BULL' || adaptive.slope >= 0.10)
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
        reason: `[1차 돌파 진입] 상승 추세(BULL) 모멘텀(기울기: +${adaptive.slope.toFixed(2)}%) 돌파 매수`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    // --- Rule 9-b: Sideways Box-Range Upside Scalp Buy (Priority 6) ---
    if (
      !hasPosition &&
      position.state === 'FLAT' &&
      params.autoPilotEnabled &&
      adaptive.marketRegime === 'SIDEWAYS' &&
      currentPrice > baselineValue &&
      currentPrice <= (baselineValue + (effectiveAtr * adaptive.dynamicScalpBandMultiplier))
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
        reason: `[박스권 상단 스캘핑 진입] 기준선 소폭 상향 돌파 포착 (국면: SIDEWAYS)`,
        indicatorSnapshot: snapshot
      });
      return signals;
    }

    return signals;
  }
}
