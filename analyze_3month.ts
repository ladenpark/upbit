interface Candle {
  market: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_volume: number;
}

async function fetchUpbitCandles(market: string, unit: number = 60, totalCount: number = 2160): Promise<Candle[]> {
  let allCandles: Candle[] = [];
  let to = '';
  
  console.log(`[Data Fetcher] 업비트 ${market} 최근 3개월(${totalCount}개 캔들) 데이터 수집 시작...`);
  
  while (allCandles.length < totalCount) {
    const count = Math.min(200, totalCount - allCandles.length);
    const url = `https://api.upbit.com/v1/candles/minutes/${unit}?market=${market}&count=${count}${to ? `&to=${encodeURIComponent(to)}` : ''}`;
    try {
      const response = await fetch(url);
      const data = await response.json() as any;
      if (!Array.isArray(data) || data.length === 0) break;
      allCandles = allCandles.concat(data);
      const last = data[data.length - 1];
      to = last.candle_date_time_utc + 'Z';
      if (data.length < count) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    } catch (err) {
      console.error('Error fetching candles:', err);
      break;
    }
  }

  console.log(`[Data Fetcher] 총 ${allCandles.length}개 캔들 수집 완료 (${allCandles[allCandles.length - 1].candle_date_time_kst} ~ ${allCandles[0].candle_date_time_kst})`);
  return allCandles.reverse();
}

interface StrategyParams {
  atrMultiplier: number;
  stopLossMultiplier: number;
  orderRatio: number;
  dcaEnabled: boolean;
  maxSafetyOrders: number;
  safetyOrderStepPercent: number;
  trailingStopEnabled: boolean;
  trailingCallbackPercent: number;
  pyramidingEnabled: boolean;
  pyramidingStepPercent: number;
  trendAwareCutEnabled: boolean;
}

function runComprehensiveBacktest(candles: Candle[], params: StrategyParams) {
  const initialCapital = 10000000; // 1,000만 원
  const feeRate = 0.0005; // 0.05% 매수/매도 각각 (왕복 0.10%)
  
  let capital = initialCapital;
  let positionQty = 0;
  let weightedEntryPrice = 0;
  let safetyOrderCount = 0;
  let pyramidingCount = 0;
  let lastOrderPrice = 0;
  let isTrailingActive = false;
  let trailingPeakPrice = 0;
  let awaitingReentry = false;
  let lowestDipPrice = 0;
  let stabilizationTicks = 0;

  let trades: { type: string; pnl: number; price: number; time: string }[] = [];
  let prices: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const price = c.trade_price;
    prices.push(price);
    if (prices.length > 20) prices.shift();
    if (prices.length < 5) continue;

    const baseline = prices.reduce((a, b) => a + b, 0) / prices.length;
    let trSum = 0;
    for (let j = 1; j < prices.length; j++) {
      trSum += Math.abs(prices[j] - prices[j - 1]);
    }
    const atr = trSum / (prices.length - 1) || (price * 0.015);

    const upperBand = baseline + atr * params.atrMultiplier;
    const lowerBand = baseline - atr * params.atrMultiplier;
    const stopLoss = weightedEntryPrice > 0 ? weightedEntryPrice - atr * params.stopLossMultiplier : lowerBand - atr * params.stopLossMultiplier;

    // Drop speed calculation
    let dropSpeed = 0;
    if (prices.length >= 4) {
      const pOld = prices[prices.length - 4];
      dropSpeed = ((price - pOld) / pOld) * 100;
    }

    // 1. Initial Buy
    if (positionQty === 0 && price <= lowerBand) {
      const budget = capital * (params.orderRatio / 100);
      if (budget >= 5000) {
        const netBudget = budget * (1 - feeRate);
        positionQty = netBudget / price;
        weightedEntryPrice = price;
        lastOrderPrice = price;
        safetyOrderCount = 0;
        pyramidingCount = 0;
        isTrailingActive = false;
        awaitingReentry = false;
        capital -= budget;
      }
    }
    // 2. Trend Early Cut
    else if (
      positionQty > 0 &&
      params.trendAwareCutEnabled &&
      !awaitingReentry &&
      !isTrailingActive &&
      price <= lowerBand &&
      dropSpeed <= -0.6
    ) {
      const cutQty = positionQty * 0.4;
      const gross = cutQty * price;
      const net = gross * (1 - feeRate);
      const cost = cutQty * weightedEntryPrice;
      const pnl = net - cost;
      capital += net;
      positionQty -= cutQty;
      awaitingReentry = true;
      lowestDipPrice = price;
      stabilizationTicks = 0;
      trades.push({ type: 'TREND_CUT', pnl, price, time: c.candle_date_time_kst });
    }
    // 3. Bottom Re-entry
    else if (positionQty > 0 && awaitingReentry) {
      lowestDipPrice = Math.min(lowestDipPrice || price, price);
      const rebound = ((price - lowestDipPrice) / lowestDipPrice) * 100;
      if (dropSpeed >= -0.15 && rebound >= 0.2) {
        stabilizationTicks += 1;
        if (stabilizationTicks >= 2) {
          const budget = Math.min(capital, capital * (params.orderRatio / 100));
          if (budget >= 5000) {
            const netBudget = budget * (1 - feeRate);
            const addQty = netBudget / price;
            const newTotalQty = positionQty + addQty;
            weightedEntryPrice = (positionQty * weightedEntryPrice + addQty * price) / newTotalQty;
            positionQty = newTotalQty;
            capital -= budget;
            awaitingReentry = false;
            lowestDipPrice = 0;
            stabilizationTicks = 0;
            lastOrderPrice = price;
          }
        }
      }
    }
    // 4. DCA Safety Buy
    else if (
      positionQty > 0 &&
      params.dcaEnabled &&
      !awaitingReentry &&
      safetyOrderCount < params.maxSafetyOrders
    ) {
      const dropFromLast = ((price - lastOrderPrice) / lastOrderPrice) * 100;
      if (dropFromLast <= -params.safetyOrderStepPercent) {
        const budget = Math.min(capital, capital * (params.orderRatio / 100) * 1.2);
        if (budget >= 5000) {
          const netBudget = budget * (1 - feeRate);
          const addQty = netBudget / price;
          const newTotalQty = positionQty + addQty;
          weightedEntryPrice = (positionQty * weightedEntryPrice + addQty * price) / newTotalQty;
          positionQty = newTotalQty;
          capital -= budget;
          safetyOrderCount += 1;
          lastOrderPrice = price;
        }
      }
    }
    // 5. Pyramiding Buy
    else if (
      positionQty > 0 &&
      params.pyramidingEnabled &&
      pyramidingCount < 2 &&
      !isTrailingActive &&
      !awaitingReentry &&
      price < upperBand
    ) {
      const gainFromEntry = ((price - weightedEntryPrice) / weightedEntryPrice) * 100;
      if (gainFromEntry >= params.pyramidingStepPercent) {
        const budget = Math.min(capital, capital * (params.orderRatio / 100));
        if (budget >= 5000) {
          const netBudget = budget * (1 - feeRate);
          const addQty = netBudget / price;
          const newTotalQty = positionQty + addQty;
          weightedEntryPrice = (positionQty * weightedEntryPrice + addQty * price) / newTotalQty;
          positionQty = newTotalQty;
          capital -= budget;
          pyramidingCount += 1;
          lastOrderPrice = price;
        }
      }
    }

    // 6. Trailing Take-Profit or Normal TP
    if (positionQty > 0) {
      if (params.trailingStopEnabled) {
        if (price >= upperBand || isTrailingActive) {
          isTrailingActive = true;
          trailingPeakPrice = Math.max(trailingPeakPrice || price, price);
          const dropFromPeak = ((price - trailingPeakPrice) / trailingPeakPrice) * 100;
          if (dropFromPeak <= -params.trailingCallbackPercent) {
            const gross = positionQty * price;
            const net = gross * (1 - feeRate);
            const cost = positionQty * weightedEntryPrice;
            const pnl = net - cost;
            capital += net;
            trades.push({ type: 'TRAILING_TP', pnl, price, time: c.candle_date_time_kst });
            positionQty = 0;
            weightedEntryPrice = 0;
            isTrailingActive = false;
            trailingPeakPrice = 0;
            safetyOrderCount = 0;
            pyramidingCount = 0;
            awaitingReentry = false;
          }
        }
      } else if (price >= upperBand) {
        const gross = positionQty * price;
        const net = gross * (1 - feeRate);
        const cost = positionQty * weightedEntryPrice;
        const pnl = net - cost;
        capital += net;
        trades.push({ type: 'SELL_TP', pnl, price, time: c.candle_date_time_kst });
        positionQty = 0;
        weightedEntryPrice = 0;
        safetyOrderCount = 0;
        pyramidingCount = 0;
      }

      // 7. Hard Stop Loss
      if (price <= stopLoss && !isTrailingActive && !awaitingReentry) {
        const gross = positionQty * price;
        const net = gross * (1 - feeRate);
        const cost = positionQty * weightedEntryPrice;
        const pnl = net - cost;
        capital += net;
        trades.push({ type: 'STOP_LOSS', pnl, price, time: c.candle_date_time_kst });
        positionQty = 0;
        weightedEntryPrice = 0;
        safetyOrderCount = 0;
        pyramidingCount = 0;
      }
    }
  }

  const lastPrice = candles[candles.length - 1].trade_price;
  const holdingValue = positionQty > 0 ? positionQty * lastPrice * (1 - feeRate) : 0;
  const finalEquity = capital + holdingValue;
  const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;
  const completed = trades.filter(t => t.type !== 'BUY');
  const win = completed.filter(t => t.pnl > 0).length;
  const loss = completed.filter(t => t.pnl <= 0).length;
  const winRate = completed.length > 0 ? (win / completed.length) * 100 : 0;

  return { finalEquity, totalReturn, totalCompleted: completed.length, win, loss, winRate, trades };
}

async function run3MonthAnalysis() {
  const market = 'KRW-ETH';
  // 3 months = 90 days = 2160 hours (60m candles)
  const candles60m = await fetchUpbitCandles(market, 60, 2160);

  const ethFirst = candles60m[0].trade_price;
  const ethLast = candles60m[candles60m.length - 1].trade_price;
  const ethBuyAndHoldReturn = ((ethLast - ethFirst) / ethFirst) * 100;

  console.log(`\n======================================================`);
  console.log(`📊 [최근 3개월 KRW-ETH 시장 개요]`);
  console.log(`• 시작가: ₩${ethFirst.toLocaleString()} ➡️ 현재가: ₩${ethLast.toLocaleString()}`);
  console.log(`• 단순 보유(Buy & Hold) 수익률: ${ethBuyAndHoldReturn >= 0 ? '+' : ''}${ethBuyAndHoldReturn.toFixed(2)}%`);
  console.log(`======================================================\n`);

  console.log(`🔍 [파라미터 그리드 서치 (Grid Search) 시뮬레이션 가동 중...]`);

  const atrList = [2.0, 2.5, 3.0, 3.5];
  const stopList = [1.5, 2.0, 2.5];
  const ratioList = [25, 35, 50];
  const dcaStepList = [1.5, 2.0, 2.5];
  const trailingCallbackList = [0.6, 0.8, 1.2];
  const pyramidingStepList = [1.2, 1.5, 2.0];

  let allResults: any[] = [];

  for (const atr of atrList) {
    for (const stop of stopList) {
      for (const ratio of ratioList) {
        for (const dcaStep of dcaStepList) {
          for (const callback of trailingCallbackList) {
            for (const pyr of pyramidingStepList) {
              const res = runComprehensiveBacktest(candles60m, {
                atrMultiplier: atr,
                stopLossMultiplier: stop,
                orderRatio: ratio,
                dcaEnabled: true,
                maxSafetyOrders: 3,
                safetyOrderStepPercent: dcaStep,
                trailingStopEnabled: true,
                trailingCallbackPercent: callback,
                pyramidingEnabled: true,
                pyramidingStepPercent: pyr,
                trendAwareCutEnabled: true
              });

              if (res.totalCompleted >= 8) {
                allResults.push({
                  atr,
                  stop,
                  ratio,
                  dcaStep,
                  callback,
                  pyr,
                  ...res
                });
              }
            }
          }
        }
      }
    }
  }

  allResults.sort((a, b) => b.totalReturn - a.totalReturn);

  console.log(`\n🏆 [최근 3개월 업비트 ETH 실제 데이터 기반 최적 세팅 TOP 3] 🏆\n`);

  allResults.slice(0, 3).forEach((r, idx) => {
    console.log(`🥇 ${idx + 1}위 세팅 (수익률: +${r.totalReturn.toFixed(2)}% | 승률: ${r.winRate.toFixed(1)}%)`);
    console.log(`   • ATR 밴드 배수: ${r.atr}x | 비상 손절 배수: ${r.stop}x`);
    console.log(`   • 1회 진입 비중: ${r.ratio}%`);
    console.log(`   • 트레일링 익절 콜백: ${r.callback}%`);
    console.log(`   • 스마트 DCA 물타기 간격: -${r.dcaStep}%`);
    console.log(`   • 상승 불타기 수익 기준: +${r.pyr}%`);
    console.log(`   • 실전 매매 통계: 총 ${r.totalCompleted}회 거래 (${r.win}승 ${r.loss}패) | 최종 자산: ₩${Math.round(r.finalEquity).toLocaleString()} (시드 1,000만원 기준)`);
    console.log(`------------------------------------------------------`);
  });
}

run3MonthAnalysis();
