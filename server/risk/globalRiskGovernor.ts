import fs from 'fs';
import path from 'path';
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

const RESERVATION_FILE = path.join(process.cwd(), 'data', 'exposure_reservations.json');

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

  constructor(params: BotParams) {
    this.params = params;
    this.loadReservations();
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
      const TRAILING_PARTIAL_RATIO = 0.5; // 한 번에 보유 물량의 50%만 익절
      const DUST_GUARD_KRW = 10000; // 업비트 최소 주문(5,000원)보다 여유 있게 설정한 안전 버퍼

      if (position.amount <= 0) {
        return { approved: false, rejectionReason: `[Risk Block] No coin position available for trailing take-profit.` };
      }

      let volume = Number((position.amount * TRAILING_PARTIAL_RATIO).toFixed(6));
      const remainingValueKrw = (position.amount - volume) * currentPrice;

      // 부분 매도 후 남는 물량이 더스트 수준이면, 어차피 다음 사이클에서 또 팔아야 하니 그냥 전량 매도
      if (remainingValueKrw < DUST_GUARD_KRW) {
        volume = position.amount;
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
          reason: signal.reason,
          createdAt: Date.now()
        }
      };
    }

    if (
      signal.type === 'ABSOLUTE_STOP_EXIT' ||
      signal.type === 'EMERGENCY_FULL_EXIT'
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
          reason: signal.reason,
          createdAt: Date.now()
        }
      };
    }

    if (signal.type === 'PARTIAL_LOSS_CUT' || signal.type === 'EMERGENCY_TREND_CUT') {
      const cutRatio = signal.type === 'EMERGENCY_TREND_CUT' ? 0.4 : (this.params.partialLossCutPercent / 100);
      const volume = Number((position.amount * cutRatio).toFixed(6));
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
      signal.type === 'REENTRY_BUY'
    ) {
      const limits = this.calculateExposureLimits(actualKrwBalance, position.amount, currentPrice, pendingOrdersAmountKrw);

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

      if (signal.type === 'DCA_BUY') {
        const nextSlot = position.dcaSlots.find((s) => s.status === 'AVAILABLE');
        const scale = Math.pow(this.params.safetyOrderVolumeScale, nextSlot ? nextSlot.slotNumber : 1);
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
          // If a reservation is older than 5 minutes and still RESERVED, auto-release it
          if (r.status === 'RESERVED' && (Date.now() - r.createdAt) > 300000) {
            r.status = 'RELEASED';
          }
          this.reservations.set(r.clientOrderId, r);
        });
        this.recalculateReservedExposure();
        console.log(`[GlobalRiskGovernor] Exposure Reservations restored: ₩${Math.round(this.reservedBuyExposureKrw).toLocaleString()}`);
      }
    } catch (e) {
      console.error('[GlobalRiskGovernor] Failed to load exposure reservations:', e);
    }
  }

  private saveReservations() {
    try {
      const dir = path.dirname(RESERVATION_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this.reservations.values()).slice(-100);
      fs.writeFileSync(RESERVATION_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.error('[GlobalRiskGovernor] Failed to save exposure reservations:', e);
    }
  }
}
