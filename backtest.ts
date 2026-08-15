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
  feeRate: number;
}

function runAtrBacktest(candles: Candle[], options: BacktestOptions) {
  let capital = options.initialCapital;
  let positionQty = 0;
  let entryPrice = 0;
  let trades: any[] = [];
  
  const windowSize = 20;
  let prices: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    prices.push(c.trade_price);
    if (prices.length > windowSize) prices.shift();

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

async function runComparison() {
  const market = 'KRW-ETH';
  const timeframes = [
    { name: '1분봉 (최근 24시간)', unit: 1, count: 1440 },
    { name: '5분봉 (최근 3일)', unit: 5, count: 864 },
    { name: '15분봉 (최근 7일)', unit: 15, count: 672 },
    { name: '60분봉 (최근 30일)', unit: 60, count: 720 },
  ];

  console.log(`\n=== 📊 [업비트 ETH/KRW 타임프레임별 백테스트 비교 분석] ===\n`);

  for (const tf of timeframes) {
    const candles = await fetchUpbitCandles(market, tf.unit, tf.count);
    const res = runAtrBacktest(candles, {
      atrMultiplier: 2.0,
      stopLossMultiplier: 1.5,
      orderRatio: 50,
      initialCapital: 10000000,
      feeRate: 0.0005
    });

    console.log(`⏱️ [${tf.name}] (${candles.length}개 캔들)`);
    console.log(`   - 최종 자산: ₩${Math.round(res.finalEquity).toLocaleString()}`);
    console.log(`   - 총 수익률: ${res.totalReturn >= 0 ? '+' : ''}${res.totalReturn.toFixed(2)}%`);
    console.log(`   - 총 거래: ${res.totalCompleted}회 (승리: ${res.win}회, 패배: ${res.loss}회, 승률: ${res.winRate.toFixed(1)}%)\n`);
  }
}

runComparison();
