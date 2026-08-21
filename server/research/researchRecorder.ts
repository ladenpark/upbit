import fs from 'fs';
import path from 'path';
import { UpbitCandle } from '../exchanges/upbit';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const RESEARCH_DIR = path.join(DATA_DIR, 'research');

export interface ResearchDecision {
  type: string | null;
  dcaExecution?: string;
}

export interface ResearchStats {
  enabled: boolean;
  ticksRecorded: number;
  candlesRecorded: number;
  shadowDifferences: number;
  startedAt: number;
}

/**
 * Append-only research data recorder. It never reads or changes the live
 * position/order state. Files are JSONL so a malformed trailing line after an
 * unexpected shutdown does not invalidate prior research data.
 */
export class ResearchRecorder {
  private lastTickPrice: number | null = null;
  private lastTickTimestamp = 0;
  private recordedCandleTimes = new Set<number>();
  private lastShadowSignature = '';
  private lastShadowTimestamp = 0;
  private stats: ResearchStats = {
    enabled: true,
    ticksRecorded: 0,
    candlesRecorded: 0,
    shadowDifferences: 0,
    startedAt: Date.now()
  };

  constructor() {
    fs.mkdirSync(path.join(RESEARCH_DIR, 'ticks'), { recursive: true });
    fs.mkdirSync(path.join(RESEARCH_DIR, 'candles'), { recursive: true });
    fs.mkdirSync(path.join(RESEARCH_DIR, 'shadow'), { recursive: true });
  }

  private dateKey(timestamp: number) {
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private append(kind: 'ticks' | 'candles' | 'shadow', timestamp: number, value: Record<string, unknown>) {
    const file = path.join(RESEARCH_DIR, kind, `${this.dateKey(timestamp)}.ndjson`);
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf-8');
  }

  /** Record price changes and at least one heartbeat per second, not duplicate ticker noise. */
  public recordTick(symbol: string, price: number, timestamp: number) {
    if (price <= 0 || !Number.isFinite(price)) return;
    if (this.lastTickPrice === price && timestamp - this.lastTickTimestamp < 1000) return;
    this.lastTickPrice = price;
    this.lastTickTimestamp = timestamp;
    this.append('ticks', timestamp, { timestamp, symbol, price });
    this.stats.ticksRecorded++;
  }

  /** Only completed candles are persisted; the current forming candle is excluded by the caller. */
  public recordCompletedCandles(symbol: string, candles: UpbitCandle[]) {
    for (const candle of candles) {
      if (this.recordedCandleTimes.has(candle.timestamp)) continue;
      this.recordedCandleTimes.add(candle.timestamp);
      // Bound de-duplication memory while allowing long-running collection.
      if (this.recordedCandleTimes.size > 3000) {
        const oldest = this.recordedCandleTimes.values().next().value;
        if (oldest !== undefined) this.recordedCandleTimes.delete(oldest);
      }
      this.append('candles', candle.timestamp, {
        timestamp: candle.timestamp,
        symbol,
        openingPrice: candle.opening_price,
        highPrice: candle.high_price,
        lowPrice: candle.low_price,
        closePrice: candle.trade_price,
        volume: candle.candle_acc_trade_volume
      });
      this.stats.candlesRecorded++;
    }
  }

  /**
   * Save only material differences among current and candidate rules. A stable
   * difference is sampled at most once per minute to avoid an unbounded file.
   */
  public recordShadowDifference(
    timestamp: number,
    symbol: string,
    price: number,
    indicators: Record<string, number | string>,
    decisions: Record<string, ResearchDecision>
  ) {
    const signature = JSON.stringify(decisions);
    if (signature === this.lastShadowSignature && timestamp - this.lastShadowTimestamp < 60_000) return;
    this.lastShadowSignature = signature;
    this.lastShadowTimestamp = timestamp;
    this.append('shadow', timestamp, { timestamp, symbol, price, indicators, decisions });
    this.stats.shadowDifferences++;
  }

  public getStats(): ResearchStats {
    return { ...this.stats };
  }
}
