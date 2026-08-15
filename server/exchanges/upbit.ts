import WebSocket, { RawData } from 'ws';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export interface UpbitCandle {
  market: string;
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_volume: number;
}

export interface UpbitTickerData {
  symbol: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  timestamp: number;
}

export class UpbitClient {
  private ws: WebSocket | null = null;
  private currentMarket: string = 'KRW-BTC';
  private onTickerCallback?: (data: UpbitTickerData) => void;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {}

  public static formatMarket(rawSymbol: string): string {
    if (rawSymbol.startsWith('KRW-')) return rawSymbol.toUpperCase();
    if (rawSymbol.includes('/')) {
      const parts = rawSymbol.split('/');
      if (parts[1] === 'USDT' || parts[1] === 'KRW') {
        return `KRW-${parts[0].toUpperCase()}`;
      }
    }
    return `KRW-${rawSymbol.replace('USDT', '').toUpperCase()}`;
  }

  // Fetch initial klines for ATR computation
  public async fetchCandles(market: string = 'KRW-BTC', count: number = 30): Promise<UpbitCandle[]> {
    const formattedMarket = UpbitClient.formatMarket(market);
    const url = `https://api.upbit.com/v1/candles/minutes/1?market=${formattedMarket}&count=${count}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Upbit API HTTP error: ${res.statusText}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) return [];
      return data.reverse().map((item: any) => ({
        market: item.market,
        candle_date_time_utc: item.candle_date_time_utc,
        opening_price: item.opening_price,
        high_price: item.high_price,
        low_price: item.low_price,
        trade_price: item.trade_price,
        timestamp: item.timestamp,
        candle_acc_trade_volume: item.candle_acc_trade_volume
      }));
    } catch (err) {
      console.error('[UpbitClient] Failed to fetch candles:', err);
      return [];
    }
  }

  // Start public WebSocket feed
  public subscribeTicker(market: string, onTicker: (data: UpbitTickerData) => void) {
    this.currentMarket = UpbitClient.formatMarket(market);
    this.onTickerCallback = onTicker;
    this.connectWs();
  }

  private connectWs() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }

    const wsUrl = 'wss://api.upbit.com/websocket/v1';
    console.log(`[Upbit WS] Connecting to ${wsUrl} for ${this.currentMarket}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log(`[Upbit WS] Connected. Subscribing to ${this.currentMarket}`);
      const subscribeMsg = JSON.stringify([
        { ticket: `atr-bot-${Date.now()}` },
        { type: 'ticker', codes: [this.currentMarket] }
      ]);
      this.ws?.send(subscribeMsg);
    });

    this.ws.on('message', (data: RawData) => {
      try {
        const text = data.toString('utf-8');
        const parsed = JSON.parse(text);
        if (parsed.type === 'ticker') {
          const ticker: UpbitTickerData = {
            symbol: parsed.code,
            price: parsed.trade_price,
            change24h: Number((parsed.signed_change_rate * 100).toFixed(2)),
            high24h: parsed.high_price,
            low24h: parsed.low_price,
            volume24h: parsed.acc_trade_volume_24h,
            timestamp: parsed.timestamp || Date.now()
          };
          if (this.onTickerCallback) {
            this.onTickerCallback(ticker);
          }
        }
      } catch (e) {
        console.error('[Upbit WS] Parse error:', e);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[Upbit WS] Error:', err.message);
    });

    this.ws.on('close', () => {
      console.log('[Upbit WS] Connection closed. Retrying in 3s...');
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

  // Create JWT Auth header for Upbit API
  private generateAuthToken(accessKey: string, secretKey: string, params?: Record<string, any>): string {
    const payload: any = {
      access_key: accessKey,
      nonce: crypto.randomUUID()
    };

    if (params && Object.keys(params).length > 0) {
      const query = new URLSearchParams(params).toString();
      const hash = crypto.createHash('sha512').update(query, 'utf-8').digest('hex');
      payload.query_hash = hash;
      payload.query_hash_alg = 'SHA512';
    }

    return jwt.sign(payload, secretKey);
  }

  // Real REST Order Execution for Upbit
  public async executeOrder(
    accessKey: string,
    secretKey: string,
    market: string,
    side: 'BUY' | 'SELL',
    amountOrPrice: { volume?: number; price?: number }
  ): Promise<{ success: boolean; orderId?: string; raw?: any; error?: string }> {
    if (!accessKey || !secretKey) {
      return { success: false, error: 'Missing Upbit Access Key or Secret Key' };
    }

    const formattedMarket = UpbitClient.formatMarket(market);
    const orderSide = side === 'BUY' ? 'bid' : 'ask';

    const params: Record<string, any> = {
      market: formattedMarket,
      side: orderSide
    };

    if (side === 'BUY') {
      // Upbit market buy uses ord_type: 'price' with total KRW amount ('price')
      if (amountOrPrice.price) {
        params.ord_type = 'price';
        params.price = amountOrPrice.price.toString();
      } else {
        return { success: false, error: 'Upbit market buy requires total KRW price' };
      }
    } else {
      // Upbit market sell uses ord_type: 'market' with volume
      if (amountOrPrice.volume) {
        params.ord_type = 'market';
        params.volume = amountOrPrice.volume.toString();
      } else {
        return { success: false, error: 'Upbit market sell requires volume' };
      }
    }

    try {
      const token = this.generateAuthToken(accessKey, secretKey, params);
      const res = await fetch('https://api.upbit.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
      });

      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error?.message || 'Upbit order failed', raw: data };
      }

      return {
        success: true,
        orderId: data.uuid,
        raw: data
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error executing Upbit order' };
    }
  }

  // Get Upbit Account Balances
  public async getAccountBalance(accessKey: string, secretKey: string): Promise<{ success: boolean; balances?: Record<string, number>; error?: string }> {
    if (!accessKey || !secretKey) {
      return { success: false, error: 'Upbit Access Key와 Secret Key를 모두 입력해 주세요.' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const token = this.generateAuthToken(accessKey, secretKey);
      const res = await fetch('https://api.upbit.com/v1/accounts', {
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await res.json();

      if (!res.ok) {
        return { success: false, error: data.error?.message || 'Upbit API 키 인증에 실패했습니다.' };
      }

      const balanceMap: Record<string, number> = {};
      if (Array.isArray(data)) {
        data.forEach((acc: any) => {
          const balance = parseFloat(acc.balance);
          if (balance > 0) {
            balanceMap[acc.currency] = balance;
          }
        });
      }

      return { success: true, balances: balanceMap };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { success: false, error: 'Upbit API 응답 시간 초과 (6초). 네트워크 연결을 확인하세요.' };
      }
      return { success: false, error: err.message || 'Upbit API 통신 실패' };
    }
  }
}
