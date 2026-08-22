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
  /** Today (KST) only. */
  ticksRecorded: number;
  candlesRecorded: number;
  shadowDifferences: number;
  /** Append-only archive totals, retained across KST date changes/restarts. */
  totalTicksRecorded: number;
  totalCandlesRecorded: number;
  totalShadowDifferences: number;
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
    totalTicksRecorded: 0,
    totalCandlesRecorded: 0,
    totalShadowDifferences: 0,
    startedAt: Date.now()
  };

  constructor() {
    fs.mkdirSync(path.join(RESEARCH_DIR, 'ticks'), { recursive: true });
    fs.mkdirSync(path.join(RESEARCH_DIR, 'candles'), { recursive: true });
    fs.mkdirSync(path.join(RESEARCH_DIR, 'shadow'), { recursive: true });
    this.initCountsFromDisk();
  }

  private countLines(filePath: string): number {
    try {
      if (!fs.existsSync(filePath)) return 0;
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  private listResearchFiles(kind: 'ticks' | 'candles' | 'shadow'): string[] {
    const directory = path.join(RESEARCH_DIR, kind);
    try {
      return fs.readdirSync(directory)
        .filter((name) => name.endsWith('.ndjson'))
        .map((name) => path.join(directory, name));
    } catch {
      return [];
    }
  }

  private candleTimestampsFromFile(filePath: string): number[] {
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').flatMap((line) => {
        try {
          const timestamp = JSON.parse(line).timestamp;
          return typeof timestamp === 'number' && Number.isFinite(timestamp) ? [timestamp] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private initCountsFromDisk() {
    const today = this.dateKey(Date.now());
    this.stats.ticksRecorded = this.countLines(path.join(RESEARCH_DIR, 'ticks', `${today}.ndjson`));
    const candleFiles = this.listResearchFiles('candles');
    const allCandleTimestamps = new Set<number>();
    const todayCandleTimestamps = new Set<number>();
    for (const file of candleFiles) {
      for (const timestamp of this.candleTimestampsFromFile(file)) {
        allCandleTimestamps.add(timestamp);
        if (this.dateKey(timestamp) === today) todayCandleTimestamps.add(timestamp);
      }
    }
    // Preload existing timestamps so a process restart cannot append the same
    // completed candle again when the exchange returns its recent lookback.
    this.recordedCandleTimes = allCandleTimestamps;
    this.stats.candlesRecorded = todayCandleTimestamps.size;
    this.stats.shadowDifferences = this.countLines(path.join(RESEARCH_DIR, 'shadow', `${today}.ndjson`));
    this.stats.totalTicksRecorded = this.listResearchFiles('ticks').reduce((total, file) => total + this.countLines(file), 0);
    this.stats.totalCandlesRecorded = allCandleTimestamps.size;
    this.stats.totalShadowDifferences = this.listResearchFiles('shadow').reduce((total, file) => total + this.countLines(file), 0);
  }

  private dateKey(timestamp: number) {
    // All user-facing research days are Korea Standard Time, not UTC.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(timestamp));
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
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
    if (this.dateKey(timestamp) === this.dateKey(Date.now())) this.stats.ticksRecorded++;
    this.stats.totalTicksRecorded++;
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
      if (this.dateKey(candle.timestamp) === this.dateKey(Date.now())) this.stats.candlesRecorded++;
      this.stats.totalCandlesRecorded++;
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
    if (this.dateKey(timestamp) === this.dateKey(Date.now())) this.stats.shadowDifferences++;
    this.stats.totalShadowDifferences++;
  }

  public getStats(): ResearchStats {
    return { ...this.stats };
  }
}
