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
  /** Last price from any source; used only for price ordering/fallback health. */
  public lastAnyPriceReceivedAt = 0;
  /** Last genuine WebSocket tick; used exclusively by the socket watchdog. */
  public lastWsReceivedAt = 0;
  /** When the active WS stream began; also covers a connection with zero ticks. */
  public streamStartedAt = 0;
  /** Timestamp from which a WebSocket tick is expected for the active stream. */
  public wsExpectedSince = 0;
  /** @deprecated Compatibility alias for the last price from any source. */
  public lastReceivedAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private staleThresholdMs = 20000; // 20 seconds without tick = STALE (relaxed for low volatility)
  private readonly wsFallbackAfterMs = 8000;
  private readonly wsReconnectCooldownMs = 10000;
  private lastWsReconnectRequestedAt = 0;
  private marketGeneration = 0;

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
    onStateChange?: (state: MarketDataState) => void,
    autoStart: boolean = true
  ) {
    this.exchange = exchange;
    this.symbol = symbol;
    this.upbitClient = new UpbitClient();
    this.onTickCallback = onTick;
    this.onStateChangeCallback = onStateChange;

    if (autoStart) {
      this.startWatchdog();
      this.startStream();
    }
  }

  public setSymbol(exchange: ExchangeType, symbol: string) {
    if (this.exchange !== exchange || this.symbol !== symbol) {
      this.marketGeneration += 1;
      this.exchange = exchange;
      this.symbol = symbol;
      this.recentTicks = [];
      this.lastAnyPriceReceivedAt = 0;
      this.lastWsReceivedAt = 0;
      this.streamStartedAt = 0;
      this.wsExpectedSince = 0;
      this.lastWsReconnectRequestedAt = 0;
      this.lastReceivedAt = 0;
      this.startStream();
    }
  }

  public startStream() {
    const generation = this.marketGeneration;
    const symbol = this.symbol;
    this.upbitClient.unsubscribe();
    this.streamStartedAt = Date.now();
    this.wsExpectedSince = this.streamStartedAt;
    this.setMarketState('RECONNECTING');

    this.upbitClient.subscribeTicker(symbol, (ticker: UpbitTickerData) => {
      if (generation !== this.marketGeneration || ticker.symbol !== UpbitClient.formatMarket(this.symbol)) return;
      this.handleTick(ticker.price, ticker.timestamp, 'WS');
    });
  }

  public handleTick(price: number, timestamp: number, source: 'WS' | 'REST' = 'WS') {
    if (!Number.isFinite(price) || price <= 0) return;
    // REST fallbacks and old sockets can arrive out of order. A late price
    // must never rewind strategy time or overwrite the newest market state.
    if (timestamp && timestamp < this.lastAnyPriceReceivedAt) return;
    this.currentPrice = price;
    const receivedAt = timestamp || Date.now();
    this.lastAnyPriceReceivedAt = receivedAt;
    this.lastReceivedAt = receivedAt;
    if (source === 'WS') this.lastWsReceivedAt = receivedAt;

    if (this.marketState !== 'LIVE') {
      this.setMarketState('LIVE');
    }

    this.recentTicks.push({ timestamp: receivedAt, price });
    if (this.recentTicks.length > this.maxTicksHistory) {
      this.recentTicks.shift();
    }

    if (this.onTickCallback) {
      this.onTickCallback(price, receivedAt);
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

    this.watchdogTimer = setInterval(async () => {
      const now = Date.now();
      // A socket which connected but never emitted its first tick is just as
      // unhealthy as a socket that stopped after being live.
      const wsReferenceAt = this.lastWsReceivedAt || this.wsExpectedSince || this.streamStartedAt;
      const wsElapsed = wsReferenceAt > 0 ? now - wsReferenceAt : 0;

      // 1. If no WebSocket tick received for >8s, poll REST ticker as fallback heartbeat
      if (wsElapsed > this.wsFallbackAfterMs) {
        try {
          const generation = this.marketGeneration;
          const symbol = this.symbol;
          const restTicker = await this.upbitClient.fetchTicker(symbol);
          if (generation === this.marketGeneration && symbol === this.symbol && restTicker?.symbol === UpbitClient.formatMarket(symbol)) {
            this.handleTick(restTicker.price, restTicker.timestamp, 'REST');
          }
        } catch {}
      }

      // 2. If still no tick received for >staleThresholdMs (20s), mark STALE and trigger WS reconnect
      if (wsElapsed > this.staleThresholdMs) {
        if (this.marketState !== 'STALE' && this.marketState !== 'DISCONNECTED') {
          console.warn(`[MarketDataManager] ⚠️ No ticks received for >${this.staleThresholdMs / 1000}s. Setting market state to STALE.`);
          this.setMarketState('STALE');
        }
        if (now - this.lastWsReconnectRequestedAt >= this.wsReconnectCooldownMs) {
          this.lastWsReconnectRequestedAt = now;
          this.upbitClient.reconnect();
        }
      }
    }, 3000);
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
