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

async function fetchUpbitCandles(market: string, unit: number = 1, totalCount: number = 1440): Promise<Candle[]> {
  let allCandles: Candle[] = [];
  let to = '';
  
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

  return allCandles.reverse();
}

interface BacktestOptions {
  atrMultiplier: number;
  stopLossMultiplier: number;
  orderRatio: number;
  initialCapital: number;
  feeRate: number; // 0.05% per trade
  windowSize: number;
}

function runAtrBacktest(candles: Candle[], options: BacktestOptions) {
  let capital = options.initialCapital;
  let positionQty = 0;
  let entryPrice = 0;
  let trades: any[] = [];
  
  let prices: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    prices.push(c.trade_price);
    if (prices.length > options.windowSize) prices.shift();

    if (prices.length < 5) continue;

    const baseline = prices.reduce((a, b) => a + b, 0) / prices.length;

    let trSum = 0;
    for (let j = 1; j < prices.length; j++) {
      trSum += Math.abs(prices[j] - prices[j - 1]);
    }
    const atr = trSum / (prices.length - 1) || (c.trade_price * 0.005);

    const upperBand = baseline + atr * options.atrMultiplier;
    const lowerBand = baseline - atr * options.atrMultiplier;
    let stopLoss = entryPrice > 0 ? entryPrice - atr * options.stopLossMultiplier : lowerBand - atr * options.stopLossMultiplier;

    const curPrice = c.trade_price;

    if (positionQty === 0 && curPrice <= lowerBand) {
      const budget = capital * (options.orderRatio / 100);
      if (budget >= 5000) {
        const fee = budget * options.feeRate;
        positionQty = (budget - fee) / curPrice;
        entryPrice = curPrice;
        capital -= budget;
        trades.push({ type: 'BUY', price: curPrice, time: c.candle_date_time_kst });
      }
    } else if (positionQty > 0 && curPrice <= stopLoss) {
      const gross = positionQty * curPrice;
      const fee = gross * options.feeRate;
      const net = gross - fee;
      const pnl = net - (positionQty * entryPrice);
      capital += net;
      trades.push({ type: 'STOP_LOSS', price: curPrice, pnl, time: c.candle_date_time_kst });
      positionQty = 0;
      entryPrice = 0;
    } else if (positionQty > 0 && curPrice >= upperBand) {
      const gross = positionQty * curPrice;
      const fee = gross * options.feeRate;
      const net = gross - fee;
      const pnl = net - (positionQty * entryPrice);
      capital += net;
      trades.push({ type: 'SELL', price: curPrice, pnl, time: c.candle_date_time_kst });
      positionQty = 0;
      entryPrice = 0;
    }
  }

  const lastPrice = candles[candles.length - 1].trade_price;
  const holdingValue = positionQty > 0 ? positionQty * lastPrice : 0;
  const finalEquity = capital + holdingValue;
  const totalReturn = ((finalEquity - options.initialCapital) / options.initialCapital) * 100;
  const completed = trades.filter((t) => t.type !== 'BUY');
  const win = completed.filter((t) => t.pnl > 0).length;
  const loss = completed.filter((t) => t.pnl <= 0).length;
  const winRate = completed.length > 0 ? (win / completed.length) * 100 : 0;

  return { finalEquity, totalReturn, totalCompleted: completed.length, win, loss, winRate };
}

async function optimize() {
  const market = 'KRW-ETH';
  console.log(`[Optimizer] Fetching 15-minute and 60-minute candles for KRW-ETH...`);
  const candles15m = await fetchUpbitCandles(market, 15, 1000); // ~10 days
  const candles60m = await fetchUpbitCandles(market, 60, 720);  // ~30 days

  const atrMultipliers = [2.0, 2.5, 3.0, 3.5];
  const stopLossMultipliers = [1.5, 2.0, 2.5, 3.0];
  const orderRatios = [25, 50, 100];
  const windowSizes = [14, 20, 30];

  console.log(`\n=== 🧪 [15분봉 기준 최적 파라미터 시뮬레이션 TOP 5] ===\n`);
  let results15m: any[] = [];

  for (const atr of atrMultipliers) {
    for (const stop of stopLossMultipliers) {
      for (const ratio of orderRatios) {
        for (const win of windowSizes) {
          const res = runAtrBacktest(candles15m, {
            atrMultiplier: atr,
            stopLossMultiplier: stop,
            orderRatio: ratio,
            initialCapital: 10000000,
            feeRate: 0.0005,
            windowSize: win
          });
          if (res.totalCompleted >= 5) {
            results15m.push({ atr, stop, ratio, win, ...res });
          }
        }
      }
    }
  }

  results15m.sort((a, b) => b.totalReturn - a.totalReturn);
  results15m.slice(0, 5).forEach((r, idx) => {
    console.log(`${idx + 1}위: ATR승수 ${r.atr}x | 손절승수 ${r.stop}x | 주문비율 ${r.ratio}% | 이동평균기간 ${r.win}개`);
    console.log(`    👉 수익률: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(2)}% | 승률: ${r.winRate.toFixed(1)}% (${r.win}승 ${r.loss}패, 총 ${r.totalCompleted}회 거래)`);
  });

  console.log(`\n=== 🧪 [60분봉 (1시간봉) 기준 최적 파라미터 시뮬레이션 TOP 5] ===\n`);
  let results60m: any[] = [];

  for (const atr of atrMultipliers) {
    for (const stop of stopLossMultipliers) {
      for (const ratio of orderRatios) {
        for (const win of windowSizes) {
          const res = runAtrBacktest(candles60m, {
            atrMultiplier: atr,
            stopLossMultiplier: stop,
            orderRatio: ratio,
            initialCapital: 10000000,
            feeRate: 0.0005,
            windowSize: win
          });
          if (res.totalCompleted >= 4) {
            results60m.push({ atr, stop, ratio, win, ...res });
          }
        }
      }
    }
  }

  results60m.sort((a, b) => b.totalReturn - a.totalReturn);
  results60m.slice(0, 5).forEach((r, idx) => {
    console.log(`${idx + 1}위: ATR승수 ${r.atr}x | 손절승수 ${r.stop}x | 주문비율 ${r.ratio}% | 이동평균기간 ${r.win}개`);
    console.log(`    👉 수익률: ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn.toFixed(2)}% | 승률: ${r.winRate.toFixed(1)}% (${r.win}승 ${r.loss}패, 총 ${r.totalCompleted}회 거래)`);
  });
}

optimize();
