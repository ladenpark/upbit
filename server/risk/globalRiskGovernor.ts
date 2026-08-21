import fs from 'fs';
import path from 'path';
import { roundDownToTick } from '../utils/priceUtils';
import {
  Signal,
  OrderRequest,
  OrderRecord,
  PositionSnapshot,
  BotParams,
  ExposureLimits,
  BotLifecycleState,
  MarketDataState,
  ExposureReservation,
  PROTECTIVE_SELL_SIGNALS
} from '../types/trading';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const RESERVATION_FILE = path.join(DATA_DIR, 'exposure_reservations.json');
const DAILY_RISK_FILE = path.join(DATA_DIR, 'daily_risk_state.json');

export interface RiskEvaluationResult {
  approved: boolean;
  orderRequest?: OrderRequest;
  rejectionReason?: string;
  calculatedBudgetKrw?: number;
  calculatedVolume?: number;
}

export class GlobalRiskGovernor {
  private params: BotParams;
  private reservations: Map<string, ExposureReservation> = new Map();
  public reservedBuyExposureKrw = 0;

  // Daily Loss Limit / Circuit Breaker
  private dailyRealizedLossKrw = 0;
  private dailyLossResetDate: string = '';
  public circuitBreakerTriggered = false;

  constructor(params: BotParams) {
    this.params = params;
    this.loadReservations();
    this.dailyLossResetDate = this.getTodayKST();
    this.loadDailyRiskState();
  }

  private getTodayKST(): string {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0, 10);
  }

  /**
   * Records a realized loss for daily tracking. Call this from ATREngine on every losing trade.
   * Positive value = loss amount (absolute), negative values are ignored (profits).
   */
  public recordDailyLoss(lossAmountKrw: number, totalCapitalKrw: number): { circuitBroken: boolean } {
    this.resetDailyStateIfNeeded();

    if (lossAmountKrw <= 0) return { circuitBroken: false };

    this.dailyRealizedLossKrw += lossAmountKrw;
    const maxLossPercent = this.params.dailyMaxLossPercent || 5;
    const maxLossKrw = totalCapitalKrw * (maxLossPercent / 100);

    console.log(`[GlobalRiskGovernor] 📉 Daily realized loss: ₩${Math.round(this.dailyRealizedLossKrw).toLocaleString()} / ₩${Math.round(maxLossKrw).toLocaleString()} (${maxLossPercent}% limit)`);

    if (this.dailyRealizedLossKrw >= maxLossKrw) {
      this.circuitBreakerTriggered = true;
      this.saveDailyRiskState();
      console.error(`[GlobalRiskGovernor] 🚨 CIRCUIT BREAKER TRIGGERED! Daily loss ₩${Math.round(this.dailyRealizedLossKrw).toLocaleString()} exceeds ${maxLossPercent}% limit (₩${Math.round(maxLossKrw).toLocaleString()})`);
      return { circuitBroken: true };
    }
    this.saveDailyRiskState();
    return { circuitBroken: false };
  }

  public getDailyLossStatus(): { dailyLossKrw: number; circuitBroken: boolean } {
    this.resetDailyStateIfNeeded();
    return { dailyLossKrw: this.dailyRealizedLossKrw, circuitBroken: this.circuitBreakerTriggered };
  }

  private resetDailyStateIfNeeded() {
    const today = this.getTodayKST();
    if (today !== this.dailyLossResetDate) {
      this.dailyRealizedLossKrw = 0;
      this.dailyLossResetDate = today;
      this.circuitBreakerTriggered = false;
      this.saveDailyRiskState();
      console.log(`[GlobalRiskGovernor] 📅 Daily loss counter reset for ${today}`);
    }
  }

  public setParams(newParams: BotParams) {
    this.params = newParams;
  }

  /**
   * Calculates Global Exposure & Capital Limits with Atomic Pending Buy Reservations
   */
  public calculateExposureLimits(
    actualKrwBalance: number,
    realCoinQuantity: number,
    currentPrice: number,
    externalPendingExposureKrw = 0
  ): ExposureLimits {
    const coinValueKrw = realCoinQuantity * currentPrice;
    const totalCapitalKrw = actualKrwBalance + coinValueKrw;
    const maxExposureRatio = (this.params.maxExposurePercent || 85) / 100;
    const maxPositionAmountKrw = totalCapitalKrw * maxExposureRatio;
    const currentExposureKrw = coinValueKrw;

    const totalPendingExposureKrw = this.reservedBuyExposureKrw + externalPendingExposureKrw;
    const remainingAllowableExposureKrw = Math.max(
      0,
      maxPositionAmountKrw - (currentExposureKrw + totalPendingExposureKrw)
    );

    return {
      totalCapitalKrw,
      maxExposureRatio,
      maxPositionAmountKrw,
      currentExposureKrw,
      pendingExposureKrw: totalPendingExposureKrw,
      remainingAllowableExposureKrw
    };
  }

  /**
   * Atomically reserve buying exposure prior to submitting an order.
   */
  public reserveExposure(clientOrderId: string, amountKrw: number): boolean {
    const reservation: ExposureReservation = {
      id: `RES_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      clientOrderId,
      amountKrw,
      createdAt: Date.now(),
      status: 'RESERVED'
    };
    this.reservations.set(clientOrderId, reservation);
    this.recalculateReservedExposure();
    this.saveReservations();
    console.log(`[GlobalRiskGovernor] 🔒 Atomically RESERVED ₩${Math.round(amountKrw).toLocaleString()} for ${clientOrderId}. Total Reserved: ₩${Math.round(this.reservedBuyExposureKrw).toLocaleString()}`);
    return true;
  }

  /**
   * Commit reservation upon successful fill (now becomes real coin exposure).
   */
  public commitExposure(clientOrderId: string) {
    const res = this.reservations.get(clientOrderId);
    if (res && res.status === 'RESERVED') {
      res.status = 'COMMITTED';
      this.recalculateReservedExposure();
      this.saveReservations();
      console.log(`[GlobalRiskGovernor] ✅ COMMITTED reservation for ${clientOrderId}`);
    }
  }

  /**
   * Release reservation upon order rejection, timeout failure, or cancellation.
   */
  public releaseExposure(clientOrderId: string) {
    const res = this.reservations.get(clientOrderId);
    if (res && res.status === 'RESERVED') {
      res.status = 'RELEASED';
      this.recalculateReservedExposure();
      this.saveReservations();
      console.log(`[GlobalRiskGovernor] 🔓 RELEASED reservation for ${clientOrderId}`);
    }
  }

  private recalculateReservedExposure() {
    let total = 0;
    for (const res of this.reservations.values()) {
      if (res.status === 'RESERVED') {
        total += res.amountKrw;
      }
    }
    this.reservedBuyExposureKrw = total;
  }

  /**
   * Evaluates a Signal against Global Risk rules before any order is submitted.
   * Allows protective SELL orders (ABSOLUTE_STOP, TRAILING_STOP, PARTIAL_CUT, EMERGENCY_CUT, EMERGENCY_FULL)
   * even when pending BUY orders exist, while strictly blocking duplicate protective sells of the same type.
   */
  public evaluateSignal(
    signal: Signal,
    botState: BotLifecycleState,
    marketState: MarketDataState,
    actualKrwBalance: number,
    position: PositionSnapshot,
    currentPrice: number,
    pendingOrdersInput: number | OrderRecord[] = 0,
    pendingOrdersAmountKrw = 0
  ): RiskEvaluationResult {
    const pendingOrders: OrderRecord[] = Array.isArray(pendingOrdersInput) ? pendingOrdersInput : [];
    const pendingOrdersCount = Array.isArray(pendingOrdersInput) ? pendingOrdersInput.length : pendingOrdersInput;
    const isProtectiveSell = PROTECTIVE_SELL_SIGNALS.includes(signal.type);

    // 0. Circuit Breaker Check — Only allow protective sells
    if (this.circuitBreakerTriggered && !isProtectiveSell) {
      return { approved: false, rejectionReason: `[Risk Block] 🚨 Circuit Breaker active — Daily loss limit exceeded. Only protective sells allowed.` };
    }

    // 1. Bot State Check
    if (botState !== 'RUNNING' && signal.type !== 'EMERGENCY_FULL_EXIT') {
      return { approved: false, rejectionReason: `[Risk Block] Bot is currently in ${botState} state.` };
    }

    // 2. Market Data Stale Check (Never open new buy orders on stale/disconnected market, allow protective stop exit)
    if (marketState !== 'LIVE' && !isProtectiveSell) {
      return { approved: false, rejectionReason: `[Risk Block] Market data feed is currently ${marketState}.` };
    }

    // 3. Pending Order Collision Check:
    if (isProtectiveSell) {
      // For protective SELLs: allow even if pending BUYs exist, BUT block if identical protective SELL is already pending!
      const hasIdenticalPendingSell = pendingOrders.some(
        (o) => o.side === 'SELL' && (o.signalType === signal.type || o.reason.includes(signal.type))
      );
      if (hasIdenticalPendingSell) {
        return {
          approved: false,
          rejectionReason: `[Risk Block] Identical protective SELL (${signal.type}) is already pending execution.`
        };
      }
    } else {
      // For BUYs and other normal signals: strictly block if ANY order is pending or exposure is reserved
      if (pendingOrdersCount > 0 || this.reservedBuyExposureKrw > 0) {
        return {
          approved: false,
          rejectionReason: `[Risk Block] Active order is currently pending execution (Collision strictly blocked).`
        };
      }
    }

    // 4. Cooldown Check (Except for Absolute Stop and Emergency Exit)
    if (
      Date.now() < position.cooldownUntil &&
      signal.type !== 'ABSOLUTE_STOP_EXIT' &&
      signal.type !== 'EMERGENCY_FULL_EXIT'
    ) {
      const remainingSec = Math.ceil((position.cooldownUntil - Date.now()) / 1000);
      return { approved: false, rejectionReason: `[Risk Block] Cooldown active for ${remainingSec}s (${position.cooldownReason}).` };
    }

    // 5. Handle SELL Signals
    if (signal.type === 'TRAILING_STOP_EXIT') {
      if (position.amount <= 0) {
        return { approved: false, rejectionReason: `[Risk Block] No coin position available for trailing take-profit.` };
      }

      const exitCount = position.trailingExitCount || 0;
      const isSecondOrLaterExit = exitCount >= 1;
      const remainingValueIfHalf = (position.amount * 0.5) * currentPrice;

      // 2-Step Trailing Model:
      // 1차: 보유 물량의 50% 분할 익절
      // 2차 (또는 잔여 평가금 50만 원 미만): 남은 잔여 물량 100% 전량 매도 (Full Exit)하여 FLAT 복귀
      let volume: number;
      if (isSecondOrLaterExit || remainingValueIfHalf < 500000) {
        volume = position.amount; // 100% 전량 매도
      } else {
        volume = Math.floor(position.amount * 0.5 * 1e8) / 1e8;
      }

      if (volume <= 0) {
        return { approved: false, rejectionReason: `[Risk Block] Trailing take-profit volume too small.` };
      }

      const clientOrderId = `ORD_${signal.type}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        approved: true,
        calculatedVolume: volume,
        orderRequest: {
          clientOrderId,
          signalId: signal.id,
          signalType: signal.type,
          symbol: signal.symbol,
          side: 'SELL',
          requestedVolume: volume,
          limitPrice: roundDownToTick(currentPrice * 0.985),
          reason: signal.reason,
          createdAt: Date.now()
        }
      };
    }

    if (
      signal.type === 'ABSOLUTE_STOP_EXIT' ||
      signal.type === 'EMERGENCY_FULL_EXIT' ||
      signal.type === 'SCALP_TAKE_PROFIT'
    ) {
      const volume = position.amount;
      if (volume <= 0) {
        return { approved: false, rejectionReason: `[Risk Block] No coin position available to sell.` };
      }
      const clientOrderId = `ORD_${signal.type}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        approved: true,
        calculatedVolume: volume,
        orderRequest: {
          clientOrderId,
          signalId: signal.id,
          signalType: signal.type,
          symbol: signal.symbol,
          side: 'SELL',
          requestedVolume: volume,
          limitPrice: roundDownToTick(currentPrice * 0.985),
          reason: signal.reason,
          createdAt: Date.now()
        }
      };
    }

    if (signal.type === 'PARTIAL_LOSS_CUT' || signal.type === 'EMERGENCY_TREND_CUT') {
      let cutRatio = 0.4;
      if (signal.type === 'PARTIAL_LOSS_CUT') {
        const cutCount = position.partialCutCount || 0;
        // 1st cut: 30%, 2nd cut: 50% of remaining
        cutRatio = cutCount === 0 ? 0.30 : 0.50;
      }
      const volume = Math.floor(position.amount * cutRatio * 1e8) / 1e8;
      if (volume <= 0 || position.amount <= 0) {
        return { approved: false, rejectionReason: `[Risk Block] Insufficient position volume for partial cut.` };
      }
      const clientOrderId = `ORD_${signal.type}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        approved: true,
        calculatedVolume: volume,
        orderRequest: {
          clientOrderId,
          signalId: signal.id,
          signalType: signal.type,
          symbol: signal.symbol,
          side: 'SELL',
          requestedVolume: volume,
          limitPrice: roundDownToTick(currentPrice * 0.985),
          reason: signal.reason,
          createdAt: Date.now()
        }
      };
    }

    // 6. Handle BUY Signals with Global Max Exposure & Reservation
    if (
      signal.type === 'ENTRY_BUY' ||
      signal.type === 'BREAKOUT_BUY' ||
      signal.type === 'DCA_BUY' ||
      signal.type === 'PYRAMID_BUY' ||
      signal.type === 'BOX_PYRAMID_BUY' ||
      signal.type === 'REENTRY_BUY'
    ) {
      const limits = this.calculateExposureLimits(actualKrwBalance, position.amount, currentPrice, pendingOrdersAmountKrw);

      // Trailing Exit Gate: 한 번이라도 트레일링 익절이 시작된 포지션은 전량 청산(FLAT)까지 불타기 일체 기각
      if (
        (signal.type === 'PYRAMID_BUY' || signal.type === 'BOX_PYRAMID_BUY') &&
        position.trailingExitCount &&
        position.trailingExitCount >= 1
      ) {
        return {
          approved: false,
          rejectionReason: `[Risk Block] Pyramiding strictly blocked during trailing exit/distribution phase (trailingExitCount: ${position.trailingExitCount}).`
        };
      }

      if (limits.remainingAllowableExposureKrw < 5000) {
        return {
          approved: false,
          rejectionReason: `[Risk Block] Global Max Position Exposure reached (Max: ₩${Math.round(limits.maxPositionAmountKrw).toLocaleString()}, Current + Pending: ₩${Math.round(limits.currentExposureKrw + limits.pendingExposureKrw).toLocaleString()}).`
        };
      }

      // Base order budget calculation — use dynamic (regime-aware) ratio when AutoPilot is on
      const dynamicRatio = signal.indicatorSnapshot?.dynamicOrderRatio;
      const effectiveOrderRatio = (this.params.autoPilotEnabled && typeof dynamicRatio === 'number' && dynamicRatio > 0)
        ? dynamicRatio / 100
        : (this.params.orderRatio || 25) / 100;
      let targetBudget = limits.totalCapitalKrw * effectiveOrderRatio;

      const isScalpEntry = signal.reason.includes('스캘핑 진입');
      const isBoxPyramidEntry = signal.reason.includes('박스권 불타기');

      if (isBoxPyramidEntry) {
        // Scaled Pyramiding: 0.50 Unit씩 적극 불타기
        targetBudget *= 0.50;
      } else if (isScalpEntry) {
        // 박스권 스캘핑 1차 진입도 넉넉한 물량 확보 (0.8 Unit)
        targetBudget *= 0.80;
      }

      if (signal.type === 'DCA_BUY') {
        const nextSlot = position.dcaSlots.find((s) => s.status === 'AVAILABLE');
        const slotNum = nextSlot ? nextSlot.slotNumber : 1;
        const DCA_SCALES = [1.5, 2.0, 1.5];
        const scale = DCA_SCALES[slotNum - 1] || 1.5;
        targetBudget *= scale;
      }

      // Strict Clamp: Never exceed actual available KRW or Global Max Exposure limit
      const finalBudget = Math.min(targetBudget, actualKrwBalance * 0.98, limits.remainingAllowableExposureKrw);

      if (finalBudget < 5000) {
        return { approved: false, rejectionReason: `[Risk Block] Available budget (₩${Math.round(finalBudget).toLocaleString()}) is below Upbit minimum order amount (₩5,000).` };
      }

      const clientOrderId = `ORD_${signal.type}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      return {
        approved: true,
        calculatedBudgetKrw: finalBudget,
        orderRequest: {
          clientOrderId,
          signalId: signal.id,
          signalType: signal.type,
          symbol: signal.symbol,
          side: 'BUY',
          requestedAmountKrw: Math.floor(finalBudget),
          reason: signal.reason,
          createdAt: Date.now()
        }
      };
    }

    return { approved: false, rejectionReason: `[Risk Block] Unknown signal type: ${signal.type}` };
  }

  private loadReservations() {
    try {
      if (fs.existsSync(RESERVATION_FILE)) {
        const raw = fs.readFileSync(RESERVATION_FILE, 'utf-8');
        const list: ExposureReservation[] = JSON.parse(raw);
        list.forEach((r) => {
          // Do not release reservations purely because the process was down
          // for five minutes.  The matching order must first be reconciled
          // against the exchange; otherwise an open buy can bypass exposure
          // limits after restart.
          this.reservations.set(r.clientOrderId, r);
        });
        this.recalculateReservedExposure();
        console.log(`[GlobalRiskGovernor] Exposure Reservations restored: ₩${Math.round(this.reservedBuyExposureKrw).toLocaleString()}`);
      }
    } catch (e) {
      console.error('[GlobalRiskGovernor] Failed to load exposure reservations:', e);
    }
  }

  private loadDailyRiskState() {
    try {
      if (!fs.existsSync(DAILY_RISK_FILE)) return;
      const parsed = JSON.parse(fs.readFileSync(DAILY_RISK_FILE, 'utf-8')) as {
        date?: string; dailyRealizedLossKrw?: number; circuitBreakerTriggered?: boolean;
      };
      if (parsed.date === this.dailyLossResetDate) {
        this.dailyRealizedLossKrw = Math.max(0, Number(parsed.dailyRealizedLossKrw) || 0);
        this.circuitBreakerTriggered = Boolean(parsed.circuitBreakerTriggered);
      }
    } catch (e) {
      console.error('[GlobalRiskGovernor] Failed to load daily risk state:', e);
    }
  }

  private saveDailyRiskState() {
    try {
      const dir = path.dirname(DAILY_RISK_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpFile = DAILY_RISK_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify({
        date: this.dailyLossResetDate,
        dailyRealizedLossKrw: this.dailyRealizedLossKrw,
        circuitBreakerTriggered: this.circuitBreakerTriggered
      }), 'utf-8');
      fs.renameSync(tmpFile, DAILY_RISK_FILE);
    } catch (e) {
      console.error('[GlobalRiskGovernor] Failed to save daily risk state:', e);
    }
  }

  private saveReservations() {
    try {
      const dir = path.dirname(RESERVATION_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this.reservations.values()).slice(-100);
      const tmpFile = RESERVATION_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), 'utf-8');
      fs.renameSync(tmpFile, RESERVATION_FILE);
    } catch (e) {
      console.error('[GlobalRiskGovernor] Failed to save exposure reservations:', e);
    }
  }
}
