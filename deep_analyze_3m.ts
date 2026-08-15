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
      break;
    }
  }
  return allCandles.reverse();
}

function runSim(candles: Candle[], atrMult: number, stopMult: number, ratio: number, dcaStep: number, trailingCallback: number) {
  const initial = 10000000;
  const feeRate = 0.0005;
  let capital = initial;
  let posQty = 0;
  let entryPrice = 0;
  let dcaCount = 0;
  let lastPrice = 0;
  let peakPrice = 0;
  let isTrailing = false;
  let trades: any[] = [];
  let prices: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const price = c.trade_price;
    prices.push(price);
    if (prices.length > 24) prices.shift();
    if (prices.length < 10) continue;

    const base = prices.reduce((a, b) => a + b, 0) / prices.length;
    let trSum = 0;
    for (let j = 1; j < prices.length; j++) trSum += Math.abs(prices[j] - prices[j - 1]);
    const atr = trSum / (prices.length - 1);

    const upper = base + atr * atrMult;
    const lower = base - atr * atrMult;
    const sl = entryPrice > 0 ? entryPrice - atr * stopMult : lower - atr * stopMult;

    // Entry: Only at oversold bottom
    if (posQty === 0 && price <= lower) {
      const budget = capital * (ratio / 100);
      if (budget >= 5000) {
        posQty = (budget * (1 - feeRate)) / price;
        entryPrice = price;
        lastPrice = price;
        dcaCount = 0;
        isTrailing = false;
        capital -= budget;
      }
    }
    // DCA Buy: When dropped by dcaStep
    else if (posQty > 0 && dcaCount < 3 && !isTrailing) {
      const drop = ((price - lastPrice) / lastPrice) * 100;
      if (drop <= -dcaStep) {
        const budget = Math.min(capital, capital * (ratio / 100));
        if (budget >= 5000) {
          const addQty = (budget * (1 - feeRate)) / price;
          const newQty = posQty + addQty;
          entryPrice = (posQty * entryPrice + addQty * price) / newQty;
          posQty = newQty;
          capital -= budget;
          dcaCount += 1;
          lastPrice = price;
        }
      }
    }

    // Trailing Take Profit or Stop Loss
    if (posQty > 0) {
      if (price >= upper || isTrailing) {
        isTrailing = true;
        peakPrice = Math.max(peakPrice || price, price);
        const dropFromPeak = ((price - peakPrice) / peakPrice) * 100;
        if (dropFromPeak <= -trailingCallback) {
          const net = posQty * price * (1 - feeRate);
          const pnl = net - (posQty * entryPrice);
          capital += net;
          trades.push({ type: 'TP', pnl });
          posQty = 0;
          entryPrice = 0;
          isTrailing = false;
          peakPrice = 0;
          dcaCount = 0;
        }
      } else if (price <= sl && !isTrailing) {
        const net = posQty * price * (1 - feeRate);
        const pnl = net - (posQty * entryPrice);
        capital += net;
        trades.push({ type: 'SL', pnl });
        posQty = 0;
        entryPrice = 0;
        dcaCount = 0;
      }
    }
  }

  const curPrice = candles[candles.length - 1].trade_price;
  const totalVal = capital + (posQty > 0 ? posQty * curPrice * (1 - feeRate) : 0);
  const ret = ((totalVal - initial) / initial) * 100;
  const wins = trades.filter(t => t.pnl > 0).length;
  const total = trades.length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  return { ret, total, wins, winRate, totalVal };
}

async function run() {
  const candles = await fetchUpbitCandles('KRW-ETH', 60, 2160);
  const first = candles[0].trade_price;
  const last = candles[candles.length - 1].trade_price;
  console.log(`ETH 3개월 시장 수익률: ${(((last - first)/first)*100).toFixed(2)}% (₩${first.toLocaleString()} ➡️ ₩${last.toLocaleString()})`);

  let best: any[] = [];
  for (const atr of [2.0, 2.5, 3.0, 3.5]) {
    for (const stop of [1.5, 2.0, 2.5, 3.0]) {
      for (const ratio of [25, 35, 50]) {
        for (const dca of [2.0, 2.5, 3.0, 4.0]) {
          for (const cb of [0.6, 0.8, 1.2]) {
            const res = runSim(candles, atr, stop, ratio, dca, cb);
            if (res.total >= 5) {
              best.push({ atr, stop, ratio, dca, cb, ...res });
            }
          }
        }
      }
    }
  }

  best.sort((a, b) => b.ret - a.ret);

  console.log(`\n🏆 [최근 3개월 KRW-ETH 백테스트 결과 TOP 5] 🏆\n`);
  best.slice(0, 5).forEach((b, i) => {
    console.log(`${i + 1}위: 수익률: ${b.ret >= 0 ? '+' : ''}${b.ret.toFixed(2)}% | 승률: ${b.winRate.toFixed(1)}% (${b.wins}/${b.total}회 성공)`);
    console.log(`    설정: ATR ${b.atr}x | SL ${b.stop}x | 진입비중 ${b.ratio}% | DCA간격 -${b.dca}% | 익절콜백 -${b.cb}%`);
  });
}

run();
