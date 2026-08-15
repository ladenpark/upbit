import WebSocket, { RawData } from 'ws';
import crypto from 'crypto';

export interface BinanceKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface BinanceTickerData {
  symbol: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  timestamp: number;
}

export class BinanceClient {
  private ws: WebSocket | null = null;
  private currentSymbol: string = 'BTCUSDT';
  private onTickerCallback?: (data: BinanceTickerData) => void;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {}

  public static formatSymbol(rawSymbol: string): string {
    return rawSymbol.replace('/', '').toUpperCase();
  }

  // Fetch initial klines for ATR computation
  public async fetchKlines(symbol: string = 'BTCUSDT', interval: string = '1m', limit: number = 30): Promise<BinanceKline[]> {
    const formatted = BinanceClient.formatSymbol(symbol);
    const url = `https://api.binance.com/api/v3/klines?symbol=${formatted}&interval=${interval}&limit=${limit}`;
    
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Binance API HTTP error: ${res.statusText}`);
      }
      const data = await res.json();
      return data.map((item: any) => ({
        openTime: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5]),
        closeTime: item[6]
      }));
    } catch (err) {
      console.error('[BinanceClient] Failed to fetch klines:', err);
      return [];
    }
  }

  // Start public WebSocket feed
  public subscribeTicker(symbol: string, onTicker: (data: BinanceTickerData) => void) {
    this.currentSymbol = BinanceClient.formatSymbol(symbol).toLowerCase();
    this.onTickerCallback = onTicker;
    this.connectWs();
  }

  private connectWs() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }

    const wsUrl = `wss://stream.binance.com:9443/ws/${this.currentSymbol}@ticker`;
    console.log(`[Binance WS] Connecting to ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log(`[Binance WS] Connected to ${this.currentSymbol}`);
    });

    this.ws.on('message', (data: RawData) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.e === '24hrTicker') {
          const ticker: BinanceTickerData = {
            symbol: parsed.s,
            price: parseFloat(parsed.c),
            change24h: parseFloat(parsed.P),
            high24h: parseFloat(parsed.h),
            low24h: parseFloat(parsed.l),
            volume24h: parseFloat(parsed.v),
            timestamp: parsed.E || Date.now()
          };
          if (this.onTickerCallback) {
            this.onTickerCallback(ticker);
          }
        }
      } catch (e) {
        console.error('[Binance WS] Parse error:', e);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[Binance WS] Error:', err.message);
    });

    this.ws.on('close', () => {
      console.log('[Binance WS] Connection closed. Retrying in 3s...');
      this.reconnectTimer = setTimeout(() => this.connectWs(), 3000);
    });
  }

  public unsubscribe() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  // Real REST execution with HMAC SHA256 API Key & Secret
  public async executeOrder(
    apiKey: string,
    apiSecret: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    quantityOrQuote: { quantity?: number; quoteOrderQty?: number }
  ): Promise<{ success: boolean; orderId?: string; raw?: any; error?: string }> {
    if (!apiKey || !apiSecret) {
      return { success: false, error: 'Missing Binance API Key or Secret' };
    }

    const formattedSymbol = BinanceClient.formatSymbol(symbol);
    const timestamp = Date.now();

    const queryParams: Record<string, string> = {
      symbol: formattedSymbol,
      side: side,
      type: 'MARKET',
      timestamp: timestamp.toString()
    };

    if (quantityOrQuote.quantity) {
      queryParams.quantity = quantityOrQuote.quantity.toString();
    } else if (quantityOrQuote.quoteOrderQty) {
      queryParams.quoteOrderQty = quantityOrQuote.quoteOrderQty.toString();
    } else {
      return { success: false, error: 'Must provide either quantity or quoteOrderQty' };
    }

    const queryString = new URLSearchParams(queryParams).toString();
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    const fullUrl = `https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`;

    try {
      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const resData = await response.json();
      if (!response.ok) {
        return { success: false, error: resData.msg || 'Binance order failed', raw: resData };
      }

      return {
        success: true,
        orderId: String(resData.orderId),
        raw: resData
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error executing Binance order' };
    }
  }

  // Get Account Balance
  public async getAccountBalance(apiKey: string, apiSecret: string): Promise<{ success: boolean; balances?: Record<string, number>; error?: string }> {
    if (!apiKey || !apiSecret) {
      return { success: false, error: 'Binance API Key와 Secret Key를 모두 입력해 주세요.' };
    }

    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(url, {
        headers: { 'X-MBX-APIKEY': apiKey },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.msg || 'Binance API 키 인증에 실패했습니다.' };
      }

      const balanceMap: Record<string, number> = {};
      if (Array.isArray(data.balances)) {
        data.balances.forEach((b: any) => {
          const free = parseFloat(b.free);
          if (free > 0) {
            balanceMap[b.asset] = free;
          }
        });
      }
      return { success: true, balances: balanceMap };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { success: false, error: 'Binance API 응답 시간 초과 (6초). 네트워크 연결을 확인하세요.' };
      }
      return { success: false, error: err.message || 'Binance API 통신 실패' };
    }
  }
}
