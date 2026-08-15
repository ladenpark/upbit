import { BinanceClient, BinanceTickerData } from '../exchanges/binance';
import { UpbitClient, UpbitTickerData } from '../exchanges/upbit';

export interface TradeLog {
  id: string;
  time: string;
  type: 'BUY' | 'SELL' | 'STOP_LOSS' | 'SYSTEM';
  price: number;
  reason: string;
  amount?: number;
  pnl?: number;
  pnlPercent?: number;
  exchange?: string;
  executionMode?: 'PAPER' | 'REAL';
}

export interface PricePoint {
  time: number;
  timeLabel: string;
  price: number;
  upperBand: number;
  baseline: number;
  lowerBand: number;
  stopLoss: number;
  event?: 'BUY' | 'SELL' | 'STOP_LOSS';
}

export interface BotParams {
  atrMultiplier: number;
  orderRatio: number;
  stopLossMultiplier: number;
  isBotActive: boolean;
  exchange: 'BINANCE' | 'UPBIT' | 'SIMULATION';
  symbol: string;
  executionMode: 'PAPER' | 'REAL';
}

export interface ApiKeys {
  binanceApiKey?: string;
  binanceApiSecret?: string;
  upbitAccessKey?: string;
  upbitSecretKey?: string;
}

export class ATREngine {
  private binanceClient: BinanceClient;
  private upbitClient: UpbitClient;

  // Bot State
  public params: BotParams = {
    atrMultiplier: 2.0,
    orderRatio: 25,
    stopLossMultiplier: 1.5,
    isBotActive: false,
    exchange: 'BINANCE',
    symbol: 'BTC/USDT',
    executionMode: 'PAPER'
  };

  public apiKeys: ApiKeys = {};

  public balance: number = 10000.0;
  public initialBalance: number = 10000.0;
  public position: { amount: number; entryPrice: number | null } = { amount: 0, entryPrice: null };

  public totalRealizedPnl: number = 0;
  public totalTrades: number = 0;
  public winTrades: number = 0;

  public currentPrice: number = 96450.0;
  public atrValue: number = 1250.0;
  public baselineValue: number = 96450.0;

  public priceHistory: PricePoint[] = [];
  public logs: TradeLog[] = [];
  private recentPrices: number[] = [];

  private broadcastCallback?: (payload: any) => void;
  private simulationTimer: NodeJS.Timeout | null = null;

  constructor(broadcastCallback?: (payload: any) => void) {
    this.binanceClient = new BinanceClient();
    this.upbitClient = new UpbitClient();
    this.broadcastCallback = broadcastCallback;
    this.initDefaultHistory();
  }

  public setBroadcastCallback(cb: (payload: any) => void) {
    this.broadcastCallback = cb;
  }

  private initDefaultHistory() {
    const base = this.currentPrice;
    const atr = this.atrValue;
    const now = Date.now();
    const history: PricePoint[] = [];

    let tempPrice = base;
    this.recentPrices = [];

    for (let i = 35; i >= 0; i--) {
      const time = now - i * 1000;
      const noise = (Math.random() - 0.5) * (atr * 0.35);
      tempPrice = Math.max(tempPrice + noise, base * 0.8);
      this.recentPrices.push(tempPrice);

      const baseline = base + Math.sin(i * 0.2) * (atr * 0.4);
      const upper = baseline + atr * this.params.atrMultiplier;
      const lower = baseline - atr * this.params.atrMultiplier;
      const stop = lower - atr * this.params.stopLossMultiplier;

      const d = new Date(time);
      const timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

      history.push({
        time,
        timeLabel,
        price: Number(tempPrice.toFixed(2)),
        baseline: Number(baseline.toFixed(2)),
        upperBand: Number(upper.toFixed(2)),
        lowerBand: Number(lower.toFixed(2)),
        stopLoss: Number(stop.toFixed(2))
      });
    }

    this.priceHistory = history;
    this.addLog({
      type: 'SYSTEM',
      price: tempPrice,
      reason: `백엔드 엔진 초기화 완료 (${this.params.exchange} - ${this.params.symbol})`
    });
  }

  public async startExchangeStream() {
    this.stopExchangeStream();

    const { exchange, symbol } = this.params;

    if (exchange === 'BINANCE') {
      const formatted = BinanceClient.formatSymbol(symbol);
      console.log(`[ATREngine] Seeding klines from Binance for ${formatted}...`);
      const klines = await this.binanceClient.fetchKlines(formatted, '1m', 30);
      if (klines.length > 0) {
        this.updateHistoryFromKlines(
          klines.map((k) => ({ price: k.close, high: k.high, low: k.low, timestamp: k.closeTime }))
        );
      }

      this.binanceClient.subscribeTicker(symbol, (ticker: BinanceTickerData) => {
        this.processTick(ticker.price, ticker.symbol);
      });
    } else if (exchange === 'UPBIT') {
      const formatted = UpbitClient.formatMarket(symbol);
      console.log(`[ATREngine] Seeding candles from Upbit for ${formatted}...`);
      const candles = await this.upbitClient.fetchCandles(formatted, 30);
      if (candles.length > 0) {
        this.updateHistoryFromKlines(
          candles.map((c) => ({ price: c.trade_price, high: c.high_price, low: c.low_price, timestamp: c.timestamp }))
        );
      }

      this.upbitClient.subscribeTicker(symbol, (ticker: UpbitTickerData) => {
        this.processTick(ticker.price, ticker.symbol);
      });
    } else {
      // SIMULATION
      console.log('[ATREngine] Starting Simulation loop...');
      this.simulationTimer = setInterval(() => {
        const base = this.currentPrice;
        const atr = this.atrValue;
        const meanReversion = (base - this.currentPrice) * 0.05;
        const noise = (Math.random() - 0.49) * atr * 0.45;
        const nextPrice = Number((this.currentPrice + meanReversion + noise).toFixed(2));
        this.processTick(nextPrice, this.params.symbol);
      }, 1000);
    }
  }

  public stopExchangeStream() {
    this.binanceClient.unsubscribe();
    this.upbitClient.unsubscribe();
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }
  }

  private updateHistoryFromKlines(candles: { price: number; high: number; low: number; timestamp: number }[]) {
    if (candles.length === 0) return;
    this.recentPrices = candles.map((c) => c.price);
    const lastPrice = candles[candles.length - 1].price;
    this.currentPrice = lastPrice;

    // Estimate ATR from high-low ranges
    let trSum = 0;
    for (let i = 0; i < candles.length; i++) {
      trSum += Math.abs(candles[i].high - candles[i].low);
    }
    this.atrValue = Number((trSum / candles.length).toFixed(2)) || (lastPrice * 0.015);
    this.baselineValue = Number((this.recentPrices.reduce((a, b) => a + b, 0) / this.recentPrices.length).toFixed(2));
  }

  public processTick(price: number, rawSymbol: string) {
    this.currentPrice = price;
    this.recentPrices.push(price);
    if (this.recentPrices.length > 50) this.recentPrices.shift();

    // Recompute indicators
    const sum = this.recentPrices.reduce((a, b) => a + b, 0);
    this.baselineValue = Number((sum / this.recentPrices.length).toFixed(2));

    // Dynamic ATR estimation
    if (this.recentPrices.length > 5) {
      let trSum = 0;
      for (let i = 1; i < this.recentPrices.length; i++) {
        trSum += Math.abs(this.recentPrices[i] - this.recentPrices[i - 1]);
      }
      this.atrValue = Number((trSum / (this.recentPrices.length - 1)).toFixed(2)) || (price * 0.015);
    }

    const upperBand = Number((this.baselineValue + this.atrValue * this.params.atrMultiplier).toFixed(2));
    const lowerBand = Number((this.baselineValue - this.atrValue * this.params.atrMultiplier).toFixed(2));

    let stopLoss = lowerBand - this.atrValue * this.params.stopLossMultiplier;
    if (this.position.amount > 0 && this.position.entryPrice) {
      stopLoss = this.position.entryPrice - this.atrValue * this.params.stopLossMultiplier;
    }
    stopLoss = Number(stopLoss.toFixed(2));

    const now = Date.now();
    const d = new Date(now);
    const timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;

    let eventType: 'BUY' | 'SELL' | 'STOP_LOSS' | undefined = undefined;

    // Strategy Execution Logic
    if (this.params.isBotActive) {
      // 1. BUY Signal: Position is empty & Price touches or drops below lower band
      if (this.position.amount === 0 && price <= lowerBand) {
        this.handleBuySignal(price, lowerBand);
        eventType = 'BUY';
      }
      // 2. STOP LOSS Signal: Position active & Price drops below stop-loss threshold
      else if (this.position.amount > 0 && price <= stopLoss) {
        this.handleSellSignal(price, 'STOP_LOSS', `손절선(${stopLoss}) 이탈 긴급 매도`);
        eventType = 'STOP_LOSS';
      }
      // 3. SELL / TAKE PROFIT Signal: Position active & Price touches or exceeds upper band
      else if (this.position.amount > 0 && price >= upperBand) {
        this.handleSellSignal(price, 'SELL', `상단 밴드(${upperBand}) 익절 체결`);
        eventType = 'SELL';
      }
    }

    const point: PricePoint = {
      time: now,
      timeLabel,
      price,
      baseline: this.baselineValue,
      upperBand,
      lowerBand,
      stopLoss,
      event: eventType
    };

    this.priceHistory.push(point);
    if (this.priceHistory.length > 50) this.priceHistory.shift();

    this.notifyClients();
  }

  private async handleBuySignal(price: number, lowerBand: number) {
    const allocateBudget = this.balance * (this.params.orderRatio / 100);
    const buyQty = Number((allocateBudget / price).toFixed(4));

    if (allocateBudget < 10 || buyQty <= 0) return;

    if (this.params.executionMode === 'REAL') {
      // Execute on Real Exchange
      this.addLog({
        type: 'SYSTEM',
        price,
        reason: `[실제 매매 요청] ${this.params.exchange} 하단 밴드(${lowerBand}) 터치 매수 주문 발송...`
      });

      if (this.params.exchange === 'BINANCE') {
        const res = await this.binanceClient.executeOrder(
          this.apiKeys.binanceApiKey || '',
          this.apiKeys.binanceApiSecret || '',
          this.params.symbol,
          'BUY',
          { quoteOrderQty: allocateBudget }
        );

        if (res.success) {
          this.balance = Number((this.balance - allocateBudget).toFixed(2));
          this.position = { amount: buyQty, entryPrice: price };
          this.addLog({
            type: 'BUY',
            price,
            amount: buyQty,
            exchange: 'BINANCE',
            executionMode: 'REAL',
            reason: `Binance 실제 매수 성공 (OrderID: ${res.orderId})`
          });
        } else {
          this.addLog({
            type: 'SYSTEM',
            price,
            reason: `Binance 실제 매수 실패: ${res.error}`
          });
        }
      } else if (this.params.exchange === 'UPBIT') {
        const res = await this.upbitClient.executeOrder(
          this.apiKeys.upbitAccessKey || '',
          this.apiKeys.upbitSecretKey || '',
          this.params.symbol,
          'BUY',
          { price: allocateBudget }
        );

        if (res.success) {
          this.balance = Number((this.balance - allocateBudget).toFixed(2));
          this.position = { amount: buyQty, entryPrice: price };
          this.addLog({
            type: 'BUY',
            price,
            amount: buyQty,
            exchange: 'UPBIT',
            executionMode: 'REAL',
            reason: `Upbit 실제 매수 성공 (UUID: ${res.orderId})`
          });
        } else {
          this.addLog({
            type: 'SYSTEM',
            price,
            reason: `Upbit 실제 매수 실패: ${res.error}`
          });
        }
      }
    } else {
      // Paper Trading Execution
      this.balance = Number((this.balance - allocateBudget).toFixed(2));
      this.position = { amount: buyQty, entryPrice: price };
      this.addLog({
        type: 'BUY',
        price,
        amount: buyQty,
        exchange: this.params.exchange,
        executionMode: 'PAPER',
        reason: `[모의매매] 하단 밴드(${lowerBand}) 터치 매수 체결 (${this.params.orderRatio}%)`
      });
    }
  }

  private async handleSellSignal(price: number, type: 'SELL' | 'STOP_LOSS', reasonText: string) {
    const qty = this.position.amount;
    const entry = this.position.entryPrice || price;
    const sellValue = qty * price;
    const cost = qty * entry;
    const pnl = Number((sellValue - cost).toFixed(2));
    const pnlPercent = Number(((pnl / cost) * 100).toFixed(2));

    if (this.params.executionMode === 'REAL') {
      this.addLog({
        type: 'SYSTEM',
        price,
        reason: `[실제 매매 요청] ${this.params.exchange} 매도 주문 발송...`
      });

      if (this.params.exchange === 'BINANCE') {
        const res = await this.binanceClient.executeOrder(
          this.apiKeys.binanceApiKey || '',
          this.apiKeys.binanceApiSecret || '',
          this.params.symbol,
          'SELL',
          { quantity: qty }
        );

        if (res.success) {
          this.balance = Number((this.balance + sellValue).toFixed(2));
          this.position = { amount: 0, entryPrice: null };
          this.totalRealizedPnl = Number((this.totalRealizedPnl + pnl).toFixed(2));
          this.totalTrades += 1;
          if (pnl > 0) this.winTrades += 1;

          this.addLog({
            type,
            price,
            amount: qty,
            pnl,
            pnlPercent,
            exchange: 'BINANCE',
            executionMode: 'REAL',
            reason: `Binance 실제 매도 성공 (${reasonText})`
          });
        } else {
          this.addLog({
            type: 'SYSTEM',
            price,
            reason: `Binance 실제 매도 실패: ${res.error}`
          });
        }
      } else if (this.params.exchange === 'UPBIT') {
        const res = await this.upbitClient.executeOrder(
          this.apiKeys.upbitAccessKey || '',
          this.apiKeys.upbitSecretKey || '',
          this.params.symbol,
          'SELL',
          { volume: qty }
        );

        if (res.success) {
          this.balance = Number((this.balance + sellValue).toFixed(2));
          this.position = { amount: 0, entryPrice: null };
          this.totalRealizedPnl = Number((this.totalRealizedPnl + pnl).toFixed(2));
          this.totalTrades += 1;
          if (pnl > 0) this.winTrades += 1;

          this.addLog({
            type,
            price,
            amount: qty,
            pnl,
            pnlPercent,
            exchange: 'UPBIT',
            executionMode: 'REAL',
            reason: `Upbit 실제 매도 성공 (${reasonText})`
          });
        } else {
          this.addLog({
            type: 'SYSTEM',
            price,
            reason: `Upbit 실제 매도 실패: ${res.error}`
          });
        }
      }
    } else {
      // Paper Trading Execution
      this.balance = Number((this.balance + sellValue).toFixed(2));
      this.position = { amount: 0, entryPrice: null };
      this.totalRealizedPnl = Number((this.totalRealizedPnl + pnl).toFixed(2));
      this.totalTrades += 1;
      if (pnl > 0) this.winTrades += 1;

      this.addLog({
        type,
        price,
        amount: qty,
        pnl,
        pnlPercent,
        exchange: this.params.exchange,
        executionMode: 'PAPER',
        reason: `[모의매매] ${reasonText}`
      });
    }
  }

  public updateParams(newParams: Partial<BotParams>) {
    const symbolChanged = newParams.symbol && newParams.symbol !== this.params.symbol;
    const exchangeChanged = newParams.exchange && newParams.exchange !== this.params.exchange;

    this.params = { ...this.params, ...newParams };

    if (symbolChanged || exchangeChanged) {
      if (this.params.exchange === 'UPBIT' && !this.params.symbol.startsWith('KRW-')) {
        const coin = this.params.symbol.split('/')[0] || 'BTC';
        this.params.symbol = `KRW-${coin}`;
      } else if (this.params.exchange === 'BINANCE' && !this.params.symbol.includes('/')) {
        const coin = this.params.symbol.replace('KRW-', '');
        this.params.symbol = `${coin}/USDT`;
      }
      this.startExchangeStream();
    }

    this.addLog({
      type: 'SYSTEM',
      price: this.currentPrice,
      reason: `봇 설정 변경: [거래소: ${this.params.exchange}, 심볼: ${this.params.symbol}, ATR: ${this.params.atrMultiplier}x, 모드: ${this.params.executionMode}]`
    });

    this.notifyClients();
  }

  public realBalances: Record<string, number> = {};

  public async fetchRealAccountBalance() {
    try {
      if (this.params.exchange === 'UPBIT' && this.apiKeys.upbitAccessKey && this.apiKeys.upbitSecretKey) {
        const res = await this.upbitClient.getAccountBalance(this.apiKeys.upbitAccessKey, this.apiKeys.upbitSecretKey);
        if (res.success && res.balances) {
          this.realBalances = res.balances;
        }
      } else if (this.params.exchange === 'BINANCE' && this.apiKeys.binanceApiKey && this.apiKeys.binanceApiSecret) {
        const res = await this.binanceClient.getAccountBalance(this.apiKeys.binanceApiKey, this.apiKeys.binanceApiSecret);
        if (res.success && res.balances) {
          this.realBalances = res.balances;
        }
      }
      this.notifyClients();
    } catch (e) {}
  }

  public setApiKeys(keys: ApiKeys) {
    this.apiKeys = { ...this.apiKeys, ...keys };
    this.fetchRealAccountBalance();
    this.addLog({
      type: 'SYSTEM',
      price: this.currentPrice,
      reason: '거래소 API 키 설정이 업데이트되었습니다.'
    });
  }

  public addLog(log: Omit<TradeLog, 'id' | 'time'>) {
    const d = new Date();
    const timeLabel = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    const newLog: TradeLog = {
      ...log,
      id: Math.random().toString(36).substring(7),
      time: timeLabel
    };
    this.logs.unshift(newLog);
    if (this.logs.length > 50) this.logs.pop();
  }

  public getFullState() {
    return {
      params: this.params,
      balance: this.balance,
      initialBalance: this.initialBalance,
      position: this.position,
      totalRealizedPnl: this.totalRealizedPnl,
      totalTrades: this.totalTrades,
      winTrades: this.winTrades,
      currentPrice: this.currentPrice,
      atrValue: this.atrValue,
      baselineValue: this.baselineValue,
      priceHistory: this.priceHistory,
      logs: this.logs,
      realBalances: this.realBalances,
      hasApiKeys: {
        binance: Boolean(this.apiKeys.binanceApiKey && this.apiKeys.binanceApiSecret),
        upbit: Boolean(this.apiKeys.upbitAccessKey && this.apiKeys.upbitSecretKey)
      }
    };
  }

  public notifyClients() {
    if (this.broadcastCallback) {
      this.broadcastCallback(this.getFullState());
    }
  }
}
