import { UpbitOrderResponse } from './upbit';
import crypto from 'crypto';

export class MockUpbit {
  // 백테스트 러너가 캔들을 주입할 때마다 현재가를 갱신하여 
  // 시장가 주문 시 체결 단가를 결정하는 데 사용합니다.
  public static currentPrice: number = 0;
  public static mockKrwBalance: number = 10000000; // 1000만원 시작
  public static mockCoinBalance: number = 0;
  public static recentCandles: any[] = [];
  
  private memoryOrders: Map<string, UpbitOrderResponse> = new Map();
  private identifierToUuid: Map<string, string> = new Map();

  public async getAccountBalance(accessKey: string, secretKey: string) {
    return {
      success: true,
      balances: {
        'KRW': MockUpbit.mockKrwBalance,
        'ETH': MockUpbit.mockCoinBalance
      },
      avgBuyPrices: {
        'ETH': MockUpbit.mockCoinBalance > 0 ? MockUpbit.currentPrice : 0
      }
    };
  }

  public async fetchCandles(market: string, count: number = 200, unit: string | number = 1): Promise<any[]> {
    return [...MockUpbit.recentCandles].reverse().slice(0, count);
  }

  public async executeOrder(
    accessKey: string, 
    secretKey: string, 
    symbol: string, 
    side: 'BUY' | 'SELL', 
    amountOrPrice: { volume?: number, price?: number, limitPrice?: number }, 
    identifier?: string
  ): Promise<{ success: boolean; orderId?: string; raw?: any; error?: string }> {
    
    const uuid = crypto.randomUUID();
    if (identifier) {
      this.identifierToUuid.set(identifier, uuid);
    }

    let executedVolume = 0;
    let fillPrice = 0;
    
    // 슬리피지(0.1%) 적용 (BUY는 비싸게, SELL은 싸게 체결)
    if (side === 'BUY') {
      fillPrice = MockUpbit.currentPrice * 1.001;
      if (amountOrPrice.price) {
        executedVolume = amountOrPrice.price / fillPrice;
      }
    } else {
      fillPrice = MockUpbit.currentPrice * 0.999;
      
      // limitPrice(하한가)가 걸려있을 때 슬리피지 적용가가 하한가보다 낮으면 안 됨
      if (amountOrPrice.limitPrice && fillPrice < amountOrPrice.limitPrice) {
        fillPrice = amountOrPrice.limitPrice; // 하한가에서 간신히 체결됨을 시뮬레이션
      }
      if (amountOrPrice.volume) {
        executedVolume = amountOrPrice.volume;
      }
    }

    // 업비트 원화 마켓 수수료: 0.05%
    const totalFee = executedVolume * fillPrice * 0.0005;

    // 모의 잔고 업데이트 로직 (백테스트 중 상태 관리를 위해)
    if (side === 'BUY') {
      MockUpbit.mockKrwBalance -= (executedVolume * fillPrice) + totalFee;
      MockUpbit.mockCoinBalance += executedVolume;
    } else {
      MockUpbit.mockKrwBalance += (executedVolume * fillPrice) - totalFee;
      MockUpbit.mockCoinBalance -= executedVolume;
      if (MockUpbit.mockCoinBalance < 0.0001) MockUpbit.mockCoinBalance = 0;
    }

    const mockOrder: UpbitOrderResponse = {
      uuid,
      side: side === 'BUY' ? 'bid' : 'ask',
      ord_type: amountOrPrice.limitPrice ? 'limit' : (side === 'BUY' ? 'price' : 'market'),
      price: fillPrice.toString(),
      state: 'done',
      market: symbol,
      created_at: new Date().toISOString(),
      volume: executedVolume.toString(),
      remaining_volume: '0',
      reserved: totalFee.toString(),
      remaining_fee: '0',
      paid_fee: totalFee.toString(),
      locked: '0',
      executed_volume: executedVolume.toString(),
      trades_count: 1,
      trades: [
        {
          market: symbol,
          uuid: crypto.randomUUID(),
          price: fillPrice.toString(),
          volume: executedVolume.toString(),
          funds: (executedVolume * fillPrice).toString(),
          side: side === 'BUY' ? 'bid' : 'ask',
          created_at: new Date().toISOString()
        }
      ]
    };

    (mockOrder as any).identifier = identifier;

    this.memoryOrders.set(uuid, mockOrder);

    // 즉시 성공 반환
    return { success: true, orderId: uuid, raw: mockOrder };
  }

  public async getOrderByIdentifier(accessKey: string, secretKey: string, identifier: string) {
    const uuid = this.identifierToUuid.get(identifier);
    if (!uuid) return { success: false, error: 'Not found' };
    const order = this.memoryOrders.get(uuid);
    if (order) {
      return { success: true, order };
    }
    return { success: false, error: 'Not found' };
  }

  public async getOrder(accessKey: string, secretKey: string, uuid: string) {
    const order = this.memoryOrders.get(uuid);
    if (order) {
      return { success: true, order };
    }
    return { success: false, error: 'Not found' };
  }

  public async getOpenOrders(accessKey: string, secretKey: string, symbol: string) {
    const openOrders = Array.from(this.memoryOrders.values()).filter(o => o.state === 'wait' || o.state === 'watch');
    return { success: true, orders: openOrders };
  }

  public async cancelOrder(accessKey: string, secretKey: string, uuid: string) {
    const order = this.memoryOrders.get(uuid);
    if (order) {
      order.state = 'cancel';
      return { success: true, order };
    }
    return { success: false, error: 'Not found' };
  }
}
