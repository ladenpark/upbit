import { UpbitClient, UpbitTickerData } from '../exchanges/upbit';
import { MarketDataState, PricePoint, ExchangeType } from '../types/trading';

export interface TickRecord {
  timestamp: number;
  price: number;
  volume?: number;
}

export interface CandleRecord {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class MarketDataManager {
  private exchange: ExchangeType;
  private symbol: string;
  private upbitClient: UpbitClient;

  // Connection & Watchdog State
  public marketState: MarketDataState = 'DISCONNECTED';
  public lastReceivedAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private staleThresholdMs = 7000; // 7 seconds without tick = STALE

  // Layers
  // 1. Tick Layer (High frequency)
  public currentPrice = 0;
  public recentTicks: TickRecord[] = [];
  private maxTicksHistory = 100;

  // 2. Candle / Indicator Layer (Low frequency)
  public baseline = 0;
  public atr = 0;
  public upperBand = 0;
  public lowerBand = 0;
  public priceHistory: PricePoint[] = [];

  private onTickCallback?: (price: number, timestamp: number) => void;
  private onStateChangeCallback?: (state: MarketDataState) => void;

  constructor(
    exchange: ExchangeType = 'UPBIT',
    symbol: string = 'KRW-ETH',
    onTick?: (price: number, timestamp: number) => void,
    onStateChange?: (state: MarketDataState) => void
  ) {
    this.exchange = exchange;
    this.symbol = symbol;
    this.upbitClient = new UpbitClient();
    this.onTickCallback = onTick;
    this.onStateChangeCallback = onStateChange;

    this.startWatchdog();
    this.startStream();
  }

  public setSymbol(exchange: ExchangeType, symbol: string) {
    if (this.exchange !== exchange || this.symbol !== symbol) {
      this.exchange = exchange;
      this.symbol = symbol;
      this.recentTicks = [];
      this.startStream();
    }
  }

  public startStream() {
    this.upbitClient.unsubscribe();
    this.setMarketState('RECONNECTING');

    const upbitCode = this.symbol.startsWith('KRW-') ? this.symbol : `KRW-${this.symbol.replace('/USDT', '')}`;
    this.upbitClient.subscribeTicker(upbitCode, (data: UpbitTickerData) => {
      this.handleNewTick(data.price, data.timestamp || Date.now());
    });
  }

  private handleNewTick(price: number, timestamp: number) {
    if (!price || isNaN(price) || price <= 0) return;

    this.lastReceivedAt = Date.now();
    if (this.marketState !== 'LIVE') {
      this.setMarketState('LIVE');
    }

    this.currentPrice = price;
    this.recentTicks.push({ timestamp, price });
    if (this.recentTicks.length > this.maxTicksHistory) {
      this.recentTicks.shift();
    }

    if (this.onTickCallback) {
      this.onTickCallback(price, timestamp);
    }
  }

  public calculateDropSpeed(windowSeconds = 5): number {
    if (this.recentTicks.length < 2) return 0;

    const now = Date.now();
    const thresholdTime = now - windowSeconds * 1000;

    const ticksInWindow = this.recentTicks.filter((t) => t.timestamp >= thresholdTime);
    if (ticksInWindow.length < 2) return 0;

    const oldest = ticksInWindow[0].price;
    const latest = ticksInWindow[ticksInWindow.length - 1].price;

    if (oldest <= 0) return 0;
    return Number((((latest - oldest) / oldest) * 100).toFixed(3));
  }

  private startWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);

    this.watchdogTimer = setInterval(() => {
      if (this.lastReceivedAt > 0 && Date.now() - this.lastReceivedAt > this.staleThresholdMs) {
        if (this.marketState !== 'STALE' && this.marketState !== 'DISCONNECTED') {
          console.warn(`[MarketDataManager] ⚠️ No ticks received for >${this.staleThresholdMs / 1000}s. Setting market state to STALE.`);
          this.setMarketState('STALE');
        }
      }
    }, 2000);
  }

  private setMarketState(state: MarketDataState) {
    this.marketState = state;
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(state);
    }
  }

  public destroy() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.upbitClient.unsubscribe();
  }
}
