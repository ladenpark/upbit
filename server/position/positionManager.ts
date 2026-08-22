import fs from 'fs';
import path from 'path';
import { PositionSnapshot, PositionState, BotParams, OrderFill, SignalType } from '../types/trading';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const TRADE_LOGS_FILE = path.join(DATA_DIR, 'trade_logs.json');

const POSITION_FILE = path.join(DATA_DIR, 'position_state.json');

const POSITION_STATES = new Set<PositionState>([
  'FLAT', 'ENTRY_PENDING', 'ENTRY_FILLED', 'DCA_MODE', 'DEFENSIVE', 'DEFENSIVE_1', 'DEFENSIVE_2',
  'EMERGENCY_EXIT', 'COOLDOWN', 'REENTRY_WAIT', 'REENTRY_ALLOWED', 'REENTRY_PENDING', 'TAKE_PROFIT',
  'CLOSED', 'ERROR', 'HALTED'
]);
const DCA_SLOT_STATUSES = new Set(['AVAILABLE', 'RESERVED', 'ORDER_PENDING', 'PARTIALLY_FILLED', 'FILLED', 'DISABLED']);

export class PositionManager {
  private position: PositionSnapshot;
  private params: BotParams;
  private activeFillEventId: string | null = null;
  private activeFillDirty = false;
  private activeFillWatermark: { clientOrderId: string; volume: number; fee: number; funds: number; initialApplied: boolean } | null = null;
  private persistenceLoadFailure: Error | null = null;
  private persistedStateFound = false;

  constructor(params: BotParams) {
    this.params = params;
    this.position = this.createDefaultPosition();
    this.loadStateFromFile();
  }

  // ──── Static Utility: Trade Logs Persistence ────
  public static loadTradeLogs(): any[] {
    try {
      if (fs.existsSync(TRADE_LOGS_FILE)) {
        return JSON.parse(fs.readFileSync(TRADE_LOGS_FILE, 'utf-8'));
      }
    } catch {}
    return [];
  }

  public static saveTradeLogs(logs: any[]) {
    try {
      const dir = path.dirname(TRADE_LOGS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Keep max 1000 entries
      const trimmed = logs.slice(0, 1000);
      const tmpFile = TRADE_LOGS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(trimmed, null, 2), 'utf-8');
      fs.renameSync(tmpFile, TRADE_LOGS_FILE);
    } catch (e) {
      console.error('[PositionManager] Failed to save trade logs:', e);
    }
  }

  private createDefaultPosition(): PositionSnapshot {
    return {
      id: `POS_${Date.now()}`,
      symbol: this.params.symbol,
      state: 'FLAT',
      amount: 0,
      entryPrice: null,
      positionEntryAtr: null,
      initialStopPrice: null,
      initialBaseline: null,
      initialBand: null,
      totalCostKrw: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      openedAt: null,
      lastUpdatedAt: Date.now(),
      dcaSlots: [
        { slotNumber: 1, status: 'AVAILABLE' },
        { slotNumber: 2, status: 'AVAILABLE' },
        { slotNumber: 3, status: 'AVAILABLE' }
      ],
      pyramidingCount: 0,
      maxPyramidingOrders: this.params.maxPyramidingOrders,
      boxPyramidCount: 0,
      partialCutCount: 0,
      trailingActive: false,
      trailingPeakPrice: null,
      trailingExitCount: 0,
      profitLockPrice: null,
      lastRegimeRebalanceAt: 0,
      recycleCycleCount: 0,
      executionStages: {},
      appliedFillEventIds: [],
      durableFillWatermarks: {},
      cooldownUntil: 0
    };
  }

  public getSnapshot(): PositionSnapshot {
    return {
      ...this.position,
      dcaSlots: this.position.dcaSlots.map((s) => ({ ...s })),
      executionStages: Object.fromEntries(Object.entries(this.position.executionStages || {}).map(([id, stage]) => [id, { ...stage }])),
      appliedFillEventIds: [...(this.position.appliedFillEventIds || [])],
      durableFillWatermarks: { ...(this.position.durableFillWatermarks || {}) }
    };
  }

  public setAccountFingerprint(fingerprint: string) {
    if (this.position.accountFingerprint === fingerprint) return;
    this.position.accountFingerprint = fingerprint;
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
  }

  /** A default FLAT snapshot must not mask an unreadable persisted position. */
  public hasPersistenceLoadFailure(): boolean {
    return this.persistenceLoadFailure !== null;
  }

  public getPersistenceLoadFailure(): Error | null {
    return this.persistenceLoadFailure;
  }

  /** True only when a valid position_state.json existed when this process started. */
  public hasPersistedState(): boolean {
    return this.persistedStateFound;
  }

  /**
   * Makes the next position-state write include this exchange fill identity.
   * The marker and changed position are stored in the same atomic rename, so
   * a later order-ledger write failure can be recovered without replaying it.
   */
  public beginDurableFillEvent(eventId: string, clientOrderId?: string, cumulativeVolume?: number, cumulativeFee?: number, initialApplied = true, cumulativeFunds?: number): boolean {
    const existing = clientOrderId ? this.getDurableFillWatermark(clientOrderId) : undefined;
    if ((this.position.appliedFillEventIds || []).includes(eventId) || (existing && (cumulativeVolume || 0) <= existing.volume)) return false;
    this.activeFillEventId = eventId;
    this.activeFillDirty = false;
    this.activeFillWatermark = clientOrderId ? {
      clientOrderId,
      volume: Number((cumulativeVolume || 0).toFixed(8)),
      fee: Number((cumulativeFee || 0).toFixed(8)),
      funds: Number((cumulativeFunds || 0).toFixed(8)),
      initialApplied
    } : null;
    return true;
  }

  public completeDurableFillEvent(eventId: string): boolean {
    if (this.activeFillEventId !== eventId || !this.activeFillDirty) {
      this.activeFillEventId = null;
      this.activeFillDirty = false;
      this.activeFillWatermark = null;
      return false;
    }
    try {
      // All nested position-manager mutations are batched. This is the one
      // and only write that publishes both final state and the fill marker.
      this.commitStateToFile();
      return true;
    } catch {
      return false;
    } finally {
      this.activeFillEventId = null;
      this.activeFillDirty = false;
      this.activeFillWatermark = null;
    }
  }

  public hasDurablyAppliedFillEvent(eventId: string): boolean {
    return (this.position.appliedFillEventIds || []).includes(eventId);
  }

  public getDurableFillWatermark(clientOrderId: string) {
    return this.position.durableFillWatermarks?.[clientOrderId];
  }

  /** Records order-level progress in the same durable fill commit as position mutation. */
  public recordExecutionStage(
    clientOrderId: string,
    signalType: SignalType,
    cumulativeFilledVolume: number,
    orderCompleted: boolean,
    targetVolume?: number,
    targetBudgetKrw?: number
  ) {
    if (!clientOrderId || cumulativeFilledVolume <= 0) return;
    const previous = this.position.executionStages?.[clientOrderId];
    const now = Date.now();
    this.position.executionStages = {
      ...(this.position.executionStages || {}),
      [clientOrderId]: {
        signalType,
        targetVolume: targetVolume && targetVolume > 0 ? targetVolume : previous?.targetVolume,
        targetBudgetKrw: targetBudgetKrw && targetBudgetKrw > 0 ? targetBudgetKrw : previous?.targetBudgetKrw,
        cumulativeFilledVolume: Number(Math.max(previous?.cumulativeFilledVolume || 0, cumulativeFilledVolume).toFixed(8)),
        status: orderCompleted ? 'FILLED' : 'PARTIALLY_FILLED',
        startedAt: previous?.startedAt || now,
        updatedAt: now
      }
    };
    this.position.lastUpdatedAt = now;
    this.saveStateToFile();
  }

  /** Applies the explicit partial-complete policy when an exchange order is cancelled after a fill. */
  public finalizeCancelledPartialStage(clientOrderId: string, signalType: SignalType, cumulativeFilledVolume: number) {
    if (!clientOrderId || cumulativeFilledVolume <= 0) return;
    const existing = this.position.executionStages?.[clientOrderId];
    const now = Date.now();
    this.position.executionStages = {
      ...(this.position.executionStages || {}),
      [clientOrderId]: {
        signalType,
        targetVolume: existing?.targetVolume,
        targetBudgetKrw: existing?.targetBudgetKrw,
        cumulativeFilledVolume: Number(Math.max(existing?.cumulativeFilledVolume || 0, cumulativeFilledVolume).toFixed(8)),
        status: 'CANCELLED_PARTIAL',
        startedAt: existing?.startedAt || now,
        updatedAt: now
      }
    };
    if (signalType === 'DCA_BUY') {
      const partialSlot = [...this.position.dcaSlots].reverse().find((slot) => slot.status === 'PARTIALLY_FILLED');
      if (partialSlot) partialSlot.status = 'FILLED'; // partial-complete: do not resend the original full DCA budget
    } else if (signalType === 'TRAILING_STOP_EXIT') {
      this.position.trailingExitCount = (this.position.trailingExitCount || 0) + 1;
    }
    this.position.lastUpdatedAt = now;
    this.saveStateToFile();
  }

  /**
   * Upgrades a legacy durable watermark once OrderManager has reconstructed
   * its cumulative notional from authoritative exchange trades. This is a
   * standalone atomic commit: without that notional a later delta price
   * cannot be calculated safely.
   */
  public restoreDurableFillWatermarkFunds(clientOrderId: string, funds: number): void {
    const watermark = this.position.durableFillWatermarks?.[clientOrderId];
    if (!watermark || watermark.volume <= 0 || Number.isFinite(watermark.funds)) return;
    this.position.durableFillWatermarks = {
      ...(this.position.durableFillWatermarks || {}),
      [clientOrderId]: { ...watermark, funds: Number(funds.toFixed(8)) }
    };
    this.commitStateToFile();
  }

  public setParams(newParams: BotParams) {
    if (this.position.symbol !== newParams.symbol) {
      // ATREngine rejects symbol changes while a position is open. Keep this
      // defensive check here as well because PositionManager owns a single
      // asset state machine and must never silently relabel an open asset.
      if (this.position.state !== 'FLAT') {
        throw new Error('Cannot change PositionManager symbol while a position is open.');
      }
      this.position.symbol = newParams.symbol;
      this.position.lastUpdatedAt = Date.now();
      this.saveStateToFile();
    }
    this.params = newParams;
    this.syncDcaSlotsCapacity(newParams.maxSafetyOrders);
  }

  private syncDcaSlotsCapacity(maxSlots: number) {
    const currentSlots = this.position.dcaSlots;
    if (currentSlots.length < maxSlots) {
      for (let i = currentSlots.length + 1; i <= maxSlots; i++) {
        currentSlots.push({ slotNumber: i, status: 'AVAILABLE' });
      }
    } else if (currentSlots.length > maxSlots) {
      this.position.dcaSlots = currentSlots.slice(0, maxSlots);
    }
  }

  /**
   * Called when an Initial 1st Entry order fills.
   * Locks in the static stop loss snapshot that will NOT move with dynamic ATR!
   */
  public onInitialEntryFilled(
    fillPrice: number,
    fillVolume: number,
    baseline: number,
    atr: number,
    atrMultiplier: number,
    stopLossMultiplier: number
  ) {
    const lowerBand = baseline - (atr * atrMultiplier);
    // Absolute stop is deliberately independent from the dynamic ATR band.
    // It is the fixed final guard of this position cycle, leaving the
    // -1/-2/-3.2/-4.2/-5.5% defensive and DCA stages room to operate.
    const staticStopLossPrice = fillPrice * 0.94;

    this.position.id = `POS_${Date.now()}`;
    this.position.state = 'ENTRY_FILLED';
    this.position.amount = Number(fillVolume.toFixed(8));
    this.position.entryPrice = fillPrice;
    this.position.positionEntryAtr = atr;
    this.position.initialBaseline = baseline;
    this.position.initialBand = lowerBand;
    this.position.initialStopPrice = Number(staticStopLossPrice.toFixed(2));
    this.position.totalCostKrw = fillPrice * fillVolume;
    this.position.openedAt = Date.now();
    this.position.lastUpdatedAt = Date.now();

    // Reset DCA slots, Pyramiding & Partial Cuts
    this.position.dcaSlots = Array.from({ length: this.params.maxSafetyOrders }, (_, i) => ({
      slotNumber: i + 1,
      status: 'AVAILABLE'
    }));
    this.position.pyramidingCount = 0;
    this.position.boxPyramidCount = 0;
    this.position.partialCutCount = 0;
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;
    this.position.trailingExitCount = 0;
    this.position.profitLockPrice = null;
    this.position.lastRegimeRebalanceAt = 0;
    this.position.recycleCycleCount = 0;
    this.position.executionStages = {};

    this.saveStateToFile();
    console.log(`[PositionManager] Initial Entry Filled: Price=${fillPrice}, Qty=${fillVolume}, Static Absolute Stop Loss locked at ₩${Math.round(staticStopLossPrice).toLocaleString()}`);
  }

  /**
   * Called when additional volume fills for an existing initial entry (e.g., via background watcher).
   */
  public addAdditionalEntryFilled(fillPrice: number, additionalVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + additionalVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + additionalVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * additionalVolume;
    this.position.lastUpdatedAt = Date.now();
    if (this.position.pyramidingCount === 1) {
      this.position.profitLockPrice = Number((newWeightedAvgPrice * 1.001).toFixed(2));
    }

    this.saveStateToFile();
    console.log(`[PositionManager] Additional Entry Filled: Added=${additionalVolume}, New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /**
   * Manual add-ons deliberately do not consume an automated DCA slot. They
   * create a new weighted average and rebuild price-dependent protective
   * levels from the latest market inputs, while preserving DCA/pyramid usage.
   */
  public onManualAdditionalBuyFilled(
    fillPrice: number,
    fillVolume: number,
    baseline: number,
    atr: number,
    atrMultiplier: number,
    stopLossMultiplier: number
  ) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));
    const lowerBand = baseline - (atr * atrMultiplier);

    this.position.state = 'ENTRY_FILLED';
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.positionEntryAtr = atr;
    this.position.initialBaseline = baseline;
    this.position.initialBand = lowerBand;
    // A manual add explicitly re-bases the position, but its new final stop
    // remains a fixed -6% of that rebased average—not an ATR-derived value.
    this.position.initialStopPrice = Number((newWeightedAvgPrice * 0.94).toFixed(2));
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.partialCutCount = 0;
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;
    if (this.position.profitLockPrice !== null && this.position.profitLockPrice !== undefined) {
      this.position.profitLockPrice = Number((newWeightedAvgPrice * 1.001).toFixed(2));
    }
    this.position.lastUpdatedAt = Date.now();

    this.saveStateToFile();
    console.log(`[PositionManager] Manual Add Filled: Added=${fillVolume}, New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()} (DCA slots preserved)`);
  }

  /** 국면별 목표 비중을 향한 자동 소액 매수. DCA/불타기 슬롯은 소비하지 않는다. */
  public onRegimeRebalanceBuyFilled(fillPrice: number, fillVolume: number, baseline: number, atr: number, atrMultiplier: number, stopLossMultiplier: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    // Crucially, a small regime add is not a manual rebase: it must not
    // erase partial-cut count, cooldown, trailing state or fixed stop.
    this.position.lastRegimeRebalanceAt = Date.now();
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
    console.log(`[PositionManager] Regime rebalance filled: Added=${fillVolume}, defensive protection state preserved.`);
  }

  /**
   * Called when a DCA safety order fills.
   */
  public onDcaFilled(slotNumber: number, fillPrice: number, fillVolume: number, orderCompleted: boolean = true) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.state = 'DCA_MODE';
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.partialCutCount = 0; // Reset recycling cut gates on newly lowered weighted avg
    // DCA must not move the final stop.  Otherwise each lower fill extends
    // the loss boundary and makes the original maximum-loss guard drift.
    this.position.lastUpdatedAt = Date.now();

    const slot = this.position.dcaSlots.find((s) => s.slotNumber === slotNumber);
    if (slot) {
      // A DCA stage belongs to the exchange order, not its first fill
      // fragment. Keep it visibly/internally partial until the order reaches
      // FILLED; a cancelled partial remains an explicit partial-complete
      // position rather than silently consuming the next DCA stage.
      slot.status = orderCompleted ? 'FILLED' : 'PARTIALLY_FILLED';
      slot.filledPrice = fillPrice;
      slot.filledVolume = Number(((slot.filledVolume || 0) + fillVolume).toFixed(8));
      slot.filledAt = Date.now();
    }

    this.saveStateToFile();
    console.log(`[PositionManager] DCA #${slotNumber} Filled: New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()} (Recycling gates reset to new avg)`);
  }

  /**
   * DCA 2차 접근 구간에서 반등을 확인한 뒤 예산 일부만 먼저 체결한다.
   * 슬롯을 소진하지 않아, -4.2% 재하락 시 같은 2차 슬롯의 잔여 예산을 쓸 수 있다.
   */
  public onDcaRecoveryPrebuyFilled(slotNumber: number, fillPrice: number, fillVolume: number, plannedTargetPrice?: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.state = 'DCA_MODE';
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.partialCutCount = 0;
    // The DCA2 recovery fragment belongs to the same position cycle and
    // therefore preserves the original fixed absolute stop.
    this.position.lastUpdatedAt = Date.now();

    const slot = this.position.dcaSlots.find((s) => s.slotNumber === slotNumber);
    if (slot) {
      slot.status = 'PARTIALLY_FILLED';
      slot.filledPrice = fillPrice;
      slot.filledVolume = Number(((slot.filledVolume || 0) + fillVolume).toFixed(8));
      slot.filledAt = Date.now();
      slot.plannedTargetPrice = plannedTargetPrice;
    }

    this.saveStateToFile();
    console.log(`[PositionManager] DCA #${slotNumber} recovery pre-buy filled: New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()} (slot remains open)`);
  }

  /**
   * Called when additional volume fills for an existing DCA order (via watcher).
   * Does NOT consume a new DCA slot!
   */
  public addAdditionalDcaFilled(fillPrice: number, additionalVolume: number, orderCompleted: boolean = false) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + additionalVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + additionalVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * additionalVolume;
    this.position.lastUpdatedAt = Date.now();

    const lastFilledSlot = [...this.position.dcaSlots].reverse().find((s) => s.status === 'FILLED' || s.status === 'PARTIALLY_FILLED');
    if (lastFilledSlot) {
      lastFilledSlot.filledVolume = Number(((lastFilledSlot.filledVolume || 0) + additionalVolume).toFixed(8));
      if (orderCompleted) lastFilledSlot.status = 'FILLED';
    }

    this.saveStateToFile();
    console.log(`[PositionManager] Additional DCA Volume Filled: Added=${additionalVolume}, New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /**
   * Called when a Pyramiding buy order fills.
   */
  public onPyramidFilled(fillPrice: number, fillVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.pyramidingCount += 1;
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.lastUpdatedAt = Date.now();

    // 첫 상승 불타기가 체결되면 전체 평단의 왕복 수수료를 넘는 가격을
    // 수익 보호선으로 고정한다. 이후 상승분을 잃고 손실 포지션으로
    // 되돌아가는 역피라미딩을 막는다.
    if (this.position.pyramidingCount === 1) {
      this.position.profitLockPrice = Number((newWeightedAvgPrice * 1.001).toFixed(2));
    }

    this.saveStateToFile();
    console.log(`[PositionManager] Pyramiding #${this.position.pyramidingCount} Filled: New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /**
   * Called when additional volume fills for an existing Pyramiding order (via watcher).
   * Does NOT increment pyramidingCount!
   */
  public addAdditionalPyramidFilled(fillPrice: number, additionalVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + additionalVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + additionalVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * additionalVolume;
    this.position.lastUpdatedAt = Date.now();

    if (this.position.pyramidingCount === 1) {
      this.position.profitLockPrice = Number((newWeightedAvgPrice * 1.001).toFixed(2));
    }

    this.saveStateToFile();
    console.log(`[PositionManager] Additional Pyramid Volume Filled: Added=${additionalVolume}, New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /**
   * Called when a Box-Range Pyramid buy order fills (SIDEWAYS regime add-on).
   * Completely independent from onPyramidFilled()/pyramidingCount — separate risk budget.
   */
  public onBoxPyramidFilled(fillPrice: number, fillVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.boxPyramidCount += 1;
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.lastUpdatedAt = Date.now();

    this.saveStateToFile();
    console.log(`[PositionManager] Box-Range Pyramid #${this.position.boxPyramidCount} Filled: New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /** Additional fill of the same box-pyramid order; never consumes a new stage. */
  public addAdditionalBoxPyramidFilled(fillPrice: number, additionalVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + additionalVolume).toFixed(8));
    this.position.amount = newTotalQty;
    this.position.entryPrice = Number(((currentQty * currentEntry + additionalVolume * fillPrice) / newTotalQty).toFixed(2));
    this.position.totalCostKrw += fillPrice * additionalVolume;
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
  }

  /**
   * Called on Partial Loss Cut:
   * Sells portion (1차 30%, 2차 50%), transitions to DEFENSIVE_1/2, frees cash for DCA dip buy.
   */
  public onPartialLossCutFilled(cutVolume: number, cutPrice: number, pnl: number, cutStep: number = 1) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(8));
    this.position.realizedPnl += pnl;
    this.position.partialCutCount = cutStep;
    this.position.state = cutStep === 1 ? 'DEFENSIVE_1' : 'DEFENSIVE_2';
    this.position.lastUpdatedAt = Date.now();
    this.setCooldown(this.params.cooldownSecondsAfterCut || 60, 'PARTIAL_LOSS_CUT');

    this.saveStateToFile();
    console.log(`[PositionManager] 🛡️ Partial Loss Cut #${cutStep} Filled: Cut ${cutVolume} @ ₩${cutPrice.toLocaleString()}, PnL=₩${pnl.toLocaleString()}, State ➡️ ${this.position.state}`);
  }

  /**
   * Called when additional volume fills for an existing Partial Loss Cut (via watcher).
   * Does NOT re-disable another DCA slot or reset cooldown.
   */
  public addAdditionalPartialCutFilled(cutVolume: number, cutPrice: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(8));
    this.position.realizedPnl += pnl;
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
    console.log(`[PositionManager] Additional Partial Cut Volume Filled: Cut ${cutVolume} @ ₩${cutPrice.toLocaleString()}, PnL=₩${pnl.toLocaleString()}`);
  }

  /**
   * Called on Emergency Trend Cut (40% sold):
   * Transitions to EMERGENCY_EXIT and then REENTRY_WAIT.
   */
  public onEmergencyTrendCutFilled(cutVolume: number, cutPrice: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(8));
    this.position.realizedPnl += pnl;
    this.position.state = 'EMERGENCY_EXIT';
    this.position.lastUpdatedAt = Date.now();

    this.setCooldown(this.params.cooldownSecondsAfterCut || 60, 'EMERGENCY_TREND_CUT');
    this.saveStateToFile();
    console.log(`[PositionManager] Emergency Trend Cut: Cut ${cutVolume} @ ₩${cutPrice.toLocaleString()}, State ➡️ EMERGENCY_EXIT`);
  }

  /**
   * Called when a partial Trailing Take-Profit order fills.
   * Reduces position by cutVolume but keeps the position open.
   * Disarms trailing (trailingActive=false, trailingPeakPrice=null) so that
   * the NEXT trailing take-profit requires a genuinely new high (price must
   * cross upperBand again) before it can fire again.
   */
  public onTrailingPartialFilled(cutVolume: number, cutPrice: number, pnl: number, orderCompleted: boolean = true) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(8));
    this.position.realizedPnl += pnl;
    this.position.lastUpdatedAt = Date.now();
    // A fragmented exchange fill is one trailing exit. Increment only when
    // its order actually completes; the first fragment still disarms the
    // trailing trigger immediately for protection.
    if (orderCompleted) this.position.trailingExitCount = (this.position.trailingExitCount || 0) + 1;

    // Disarm trailing: require a fresh higher high before the next partial take-profit can fire.
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;

    if (this.position.amount <= 0) {
      this.position.entryPrice = null;
      this.position.positionEntryAtr = null;
      this.position.initialStopPrice = null;
      this.position.initialBaseline = null;
      this.position.initialBand = null;
      this.position.totalCostKrw = 0;
      this.position.unrealizedPnl = 0;
      this.position.unrealizedPnlPercent = 0;
      this.position.openedAt = null;
      this.position.state = 'FLAT';
      this.position.pyramidingCount = 0;
      this.position.boxPyramidCount = 0;
      this.position.partialCutCount = 0;
      this.position.trailingExitCount = 0;
      this.position.profitLockPrice = null;
      this.position.lastRegimeRebalanceAt = 0;
      this.position.dcaSlots = Array.from({ length: this.params.maxSafetyOrders }, (_, i) => ({
        slotNumber: i + 1,
        status: 'AVAILABLE' as const
      }));
      this.setCooldown(30, 'TRAILING_STOP_EXIT');
    }

    this.saveStateToFile();
    console.log(`[PositionManager] Trailing Partial Take-Profit (#${this.position.trailingExitCount}차): Sold ${cutVolume} @ ₩${cutPrice.toLocaleString()}, Remaining Qty=${this.position.amount}, PnL=₩${Math.round(pnl).toLocaleString()}`);
  }

  /** Strategy Lab: 추세 확장 중 박스권 수익의 절반만 실현하고 잔량을 보호한다. */
  public onScalpPartialTakeProfitFilled(cutVolume: number, cutPrice: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(8));
    this.position.realizedPnl += pnl;
    this.position.lastUpdatedAt = Date.now();
    if (this.position.amount <= 0) {
      this.onPositionClosed(0, 'SCALP_PARTIAL_TAKE_PROFIT');
      return;
    }
    const entryPrice = this.position.entryPrice || cutPrice;
    this.position.profitLockPrice = Number((entryPrice * 1.002).toFixed(2));
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;
    this.position.state = 'ENTRY_FILLED';
    this.saveStateToFile();
    console.log(`[PositionManager] Scalp expansion partial TP: Sold ${cutVolume}, remaining=${this.position.amount}, protected at ₩${Math.round(this.position.profitLockPrice).toLocaleString()}`);
  }

  /**
   * Called when partial fill occurs on a Full Exit order (Trailing Stop, Absolute Stop, Emergency Exit).
   * Reduces position amount without fully closing to FLAT until 100% completed.
   */
  public reducePositionOnPartialExit(cutVolume: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(8));
    this.position.realizedPnl += pnl;
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
    console.log(`[PositionManager] Full Exit Partial Fill: Sold ${cutVolume}, Remaining Position=${this.position.amount}`);
  }

  /**
   * Signal stabilization after dip: moves state to REENTRY_ALLOWED
   */
  public enableReentry() {
    if ((this.position.recycleCycleCount || 0) >= 2) return;
    if (
      this.position.state === 'EMERGENCY_EXIT' ||
      this.position.state === 'DEFENSIVE' ||
      this.position.state === 'DEFENSIVE_1' ||
      this.position.state === 'DEFENSIVE_2'
    ) {
      this.position.state = 'REENTRY_ALLOWED';
      this.saveStateToFile();
    }
  }

  /** Atomically consumes the one re-entry permission before an order is sent. */
  public markReentryPending(): boolean {
    if (this.position.state !== 'REENTRY_ALLOWED') return false;
    this.position.state = 'REENTRY_PENDING';
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
    return true;
  }

  /** Restores re-entry permission only when submission fails before any fill. */
  public restoreReentryAllowed() {
    if (this.position.state !== 'REENTRY_PENDING') return;
    this.position.state = 'REENTRY_ALLOWED';
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
  }

  /**
   * A re-entry is an additional buy using recycled cash. It preserves DCA
   * slots but rebuilds all price-dependent protection from the confirmed fill.
   */
  public onReentryBuyFilled(
    fillPrice: number,
    fillVolume: number,
    baseline: number,
    atr: number,
    atrMultiplier: number,
    stopLossMultiplier: number
  ) {
    this.onManualAdditionalBuyFilled(fillPrice, fillVolume, baseline, atr, atrMultiplier, stopLossMultiplier);
    this.position.recycleCycleCount = (this.position.recycleCycleCount || 0) + 1;
    this.position.state = 'ENTRY_FILLED';
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
  }

  /**
   * Additional execution of the same REENTRY order. It rebuilds the weighted
   * average and protection levels, but a recycle cycle is counted per order,
   * never per partial fill.
   */
  public addAdditionalReentryFilled(
    fillPrice: number,
    fillVolume: number,
    baseline: number,
    atr: number,
    atrMultiplier: number,
    stopLossMultiplier: number
  ) {
    this.onManualAdditionalBuyFilled(fillPrice, fillVolume, baseline, atr, atrMultiplier, stopLossMultiplier);
    this.position.state = 'ENTRY_FILLED';
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
    console.log(`[PositionManager] Additional Re-entry Volume Filled: Added=${fillVolume}, recycle cycle remains ${this.position.recycleCycleCount || 0}`);
  }

  /**
   * Repairs an existing exchange-reconciled position after a previously
   * unrecorded fill. DCA slot usage is retained, but price-dependent safety
   * fields and defensive cycle state are rebuilt from the authoritative average.
   */
  public rebaseReconciledPosition(
    baseline: number,
    atr: number,
    atrMultiplier: number,
    stopLossMultiplier: number
  ) {
    if (this.position.amount <= 0 || !this.position.entryPrice || atr <= 0 || baseline <= 0) {
      throw new Error('Cannot rebase without a confirmed open position and current indicators.');
    }
    const lowerBand = baseline - (atr * atrMultiplier);
    const absoluteFloor = this.position.entryPrice * 0.94;

    this.position.state = 'ENTRY_FILLED';
    this.position.positionEntryAtr = atr;
    this.position.initialBaseline = baseline;
    this.position.initialBand = lowerBand;
    this.position.initialStopPrice = Number(absoluteFloor.toFixed(2));
    this.position.totalCostKrw = this.position.amount * this.position.entryPrice;
    this.position.partialCutCount = 0;
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;
    this.position.trailingExitCount = 0;
    this.position.profitLockPrice = null;
    this.position.lastRegimeRebalanceAt = 0;
    this.position.recycleCycleCount = 0;
    this.position.cooldownUntil = 0;
    this.position.cooldownReason = 'RECONCILED_POSITION_REBASE';
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
  }

  /**
   * Explicitly adopts an exchange-confirmed position and builds all safety
   * fields in one state mutation/atomic write. This avoids the former
   * reconcile-save followed by rebase-save crash window.
   */
  public adoptAndRebaseExchangePosition(
    amount: number,
    entryPrice: number,
    baseline: number,
    atr: number,
    atrMultiplier: number
  ) {
    if (amount <= 1e-8 || entryPrice <= 0 || baseline <= 0 || atr <= 0) {
      throw new Error('Cannot adopt an incomplete exchange position.');
    }
    this.position.id = `POS_${Date.now()}`;
    this.position.symbol = this.params.symbol;
    this.position.state = 'ENTRY_FILLED';
    this.position.amount = Number(amount.toFixed(8));
    this.position.entryPrice = entryPrice;
    this.position.positionEntryAtr = atr;
    this.position.initialBaseline = baseline;
    this.position.initialBand = baseline - (atr * atrMultiplier);
    this.position.initialStopPrice = Number((entryPrice * 0.94).toFixed(2));
    this.position.totalCostKrw = amount * entryPrice;
    this.position.openedAt = this.position.openedAt || Date.now();
    this.position.partialCutCount = 0;
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;
    this.position.trailingExitCount = 0;
    this.position.profitLockPrice = null;
    this.position.pyramidingCount = 0;
    this.position.boxPyramidCount = 0;
    this.position.lastRegimeRebalanceAt = 0;
    this.position.recycleCycleCount = 0;
    this.position.cooldownUntil = 0;
    this.position.cooldownReason = 'RECONCILED_POSITION_REBASE';
    this.position.dcaSlots = Array.from({ length: this.params.maxSafetyOrders }, (_, i) => ({ slotNumber: i + 1, status: 'AVAILABLE' as const }));
    this.position.executionStages = {};
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
  }

  /**
   * Full Position Close (Take Profit, Absolute Stop Loss, or Emergency Full Exit)
   */
  public onPositionClosed(pnl: number, reason: string) {
    this.position.amount = 0;
    this.position.entryPrice = null;
    this.position.positionEntryAtr = null;
    this.position.initialStopPrice = null;
    this.position.initialBaseline = null;
    this.position.initialBand = null;
    this.position.totalCostKrw = 0;
    this.position.unrealizedPnl = 0;
    this.position.unrealizedPnlPercent = 0;
    this.position.openedAt = null;
    this.position.realizedPnl += pnl;
    this.position.state = 'FLAT';
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;
    this.position.trailingExitCount = 0;
    this.position.profitLockPrice = null;
    this.position.pyramidingCount = 0;
    this.position.boxPyramidCount = 0;
    this.position.partialCutCount = 0;
    this.position.dcaSlots = Array.from({ length: this.params.maxSafetyOrders }, (_, i) => ({
      slotNumber: i + 1,
      status: 'AVAILABLE' as const
    }));
    this.position.lastUpdatedAt = Date.now();

    // Differentiated Smart Cooldown:
    // 익절: 30초 빠른 회전 / 손절(STOP_LOSS/EMERGENCY): 180초(3분) 진정 쿨다운으로 연쇄 휩쏘 방지
    const isLossCut = reason.includes('STOP_EXIT') || reason.includes('STOP_LOSS') || reason.includes('손절') || pnl < 0;
    const cooldownSeconds = isLossCut ? 180 : 30;
    const cooldownReason = isLossCut ? `LOSS_CUT_COOLDOWN_${reason}` : reason;

    this.setCooldown(cooldownSeconds, cooldownReason);
    this.saveStateToFile();
    console.log(`[PositionManager] Position 100% CLOSED (${reason}). Realized PnL: ₩${Math.round(pnl).toLocaleString()}, Cooldown: ${cooldownSeconds}s`);
  }

  public updateTrailingState(currentPrice: number, upperBand: number, minProfitArmPercent: number = 1.0) {
    const entryPrice = this.position.entryPrice || 0;
    if (this.position.amount <= 0 || entryPrice <= 0) return;

    // Profit Recovery: 부분 손절 후 가격이 반등하여 본전(+0.2%)을 회복하면 방어 상태 해제 ➡️ 정상 진입 상태로 복귀
    if (currentPrice >= entryPrice * 1.002 && this.position.partialCutCount && this.position.partialCutCount > 0) {
      console.log(`[PositionManager] 📈 Position recovered into profit (+${(((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2)}%). Resetting defensive partial cut state.`);
      this.position.partialCutCount = 0;
      if (this.position.state === 'DEFENSIVE_1' || this.position.state === 'DEFENSIVE_2' || this.position.state === 'DEFENSIVE') {
        this.position.state = 'ENTRY_FILLED';
      }
      this.saveStateToFile();
    }

    // Minimum Profit Arming Gate:
    // 트레일링 콜백이 -0.8%이므로, 매도 시 확실한 플러스 수익(+0.2% 이상)을 보장하기 위해
    // 평단 대비 최소 +1.0% 이상(또는 상단 밴드) 도달 시에만 트레일링을 무장(Active)
    const minProfitArmingPrice = entryPrice * (1 + minProfitArmPercent / 100);
    const effectiveArmingPrice = Math.max(upperBand, minProfitArmingPrice);

    if (currentPrice >= effectiveArmingPrice) {
      if (!this.position.trailingActive) {
        this.position.trailingActive = true;
        this.position.trailingPeakPrice = currentPrice;
        this.position.state = 'TAKE_PROFIT';
        console.log(`[PositionManager] 🎯 Trailing Take Profit ARMED @ ₩${currentPrice.toLocaleString()} (Entry: ₩${Math.round(entryPrice).toLocaleString()}, Profit: +${(((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2)}%)`);
        this.saveStateToFile();
      } else if (this.position.trailingPeakPrice && currentPrice > this.position.trailingPeakPrice) {
        this.position.trailingPeakPrice = currentPrice;
        this.saveStateToFile();
      }
    } else if (this.position.trailingActive && this.position.trailingPeakPrice && currentPrice > this.position.trailingPeakPrice) {
      this.position.trailingPeakPrice = currentPrice;
      this.saveStateToFile();
    }
  }

  public setCooldown(seconds: number, reason: string) {
    this.position.cooldownUntil = Date.now() + (seconds * 1000);
    this.position.cooldownReason = reason;
  }

  /** Strategy Lab: 박스권 전량 익절 직후의 추격 돌파 진입을 지연한다. */
  public setScalpReentryCooldown(seconds: number) {
    this.setCooldown(seconds, 'SCALP_TAKE_PROFIT_REENTRY_GUARD');
    this.saveStateToFile();
  }

  public isUnderCooldown(): boolean {
    return Date.now() < this.position.cooldownUntil;
  }

  /**
   * Reconciles internal state with authoritative real exchange balance and average buy price.
   */
  public reconcileWithExchange(realCoinQuantity: number, authoritativeAvgBuyPrice?: number | null, fallbackPrice?: number) {
    let stateChanged = false;
    if (Math.abs(this.position.amount - realCoinQuantity) > 1e-8) {
      console.warn(`[PositionManager] State Reconciliation: Local Amount (${this.position.amount}) != Exchange Real (${realCoinQuantity})`);
      this.position.amount = realCoinQuantity;
      stateChanged = true;
    }

    // Quantity alone is not a valid dust policy: 0.00009 BTC can still have
    // material KRW value. Only an effectively zero exchange balance is FLAT.
    if (realCoinQuantity <= 1e-8) {
      if (this.position.state !== 'FLAT' || this.position.entryPrice !== null) {
        this.position.state = 'FLAT';
        this.position.entryPrice = null;
        this.position.amount = 0;
        stateChanged = true;
      }
    } else {
      // If exchange provides authoritative average buy price, synchronize it precisely!
      if (authoritativeAvgBuyPrice && authoritativeAvgBuyPrice > 0 && Math.abs((this.position.entryPrice || 0) - authoritativeAvgBuyPrice) > 1) {
        console.log(`[PositionManager] 🎯 Authoritative Entry Price Synchronized from Exchange: ₩${authoritativeAvgBuyPrice.toLocaleString()} (was: ₩${this.position.entryPrice?.toLocaleString() || 'null'})`);
        this.position.entryPrice = authoritativeAvgBuyPrice;
        stateChanged = true;
      } else if (this.position.entryPrice === null && fallbackPrice && fallbackPrice > 0) {
        this.position.entryPrice = fallbackPrice;
        stateChanged = true;
      }
      if (this.position.state === 'FLAT' || this.position.state === 'REENTRY_ALLOWED' || this.position.state === 'REENTRY_PENDING') {
        this.position.state = 'ENTRY_FILLED';
        stateChanged = true;
      }
      if (this.position.entryPrice && this.position.entryPrice > 0) {
        const reconciledCost = realCoinQuantity * this.position.entryPrice;
        if (Math.abs(this.position.totalCostKrw - reconciledCost) > 1) {
          this.position.totalCostKrw = reconciledCost;
          stateChanged = true;
        }
      }
    }

    if (stateChanged) {
      this.saveStateToFile();
    }
  }

  private loadStateFromFile() {
    try {
      if (fs.existsSync(POSITION_FILE)) {
        const raw = fs.readFileSync(POSITION_FILE, 'utf-8');
        const { state, migrated } = this.migrateAndValidatePersistedState(JSON.parse(raw));
        this.position = state;
        // A known older schema is upgraded before it is trusted. This keeps
        // future restarts on one validated shape instead of repeatedly
        // relying on implicit defaults.
        if (migrated) this.commitStateToFile();
        this.persistedStateFound = true;
        console.log('[PositionManager] Saved Position State restored from file.');
      }
    } catch (e) {
      console.error('[PositionManager] Failed to load position state from file:', e);
      this.persistenceLoadFailure = e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Migrates only known additive legacy fields, then validates business invariants. */
  private migrateAndValidatePersistedState(raw: unknown): { state: PositionSnapshot; migrated: boolean } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('position_state.json must contain a position object.');
    }
    const source = raw as Record<string, unknown>;
    const required = [
      'id', 'symbol', 'state', 'amount', 'entryPrice', 'positionEntryAtr', 'initialStopPrice', 'initialBaseline',
      'initialBand', 'totalCostKrw', 'realizedPnl', 'unrealizedPnl', 'unrealizedPnlPercent', 'openedAt',
      'lastUpdatedAt', 'dcaSlots', 'pyramidingCount', 'maxPyramidingOrders', 'trailingActive', 'trailingPeakPrice',
      'cooldownUntil'
    ];
    const missing = required.filter((key) => !(key in source));
    if (missing.length > 0) throw new Error(`position_state.json is incomplete (missing: ${missing.join(', ')}).`);

    const defaults = this.createDefaultPosition();
    const legacyDefaults: Partial<PositionSnapshot> = {
      boxPyramidCount: defaults.boxPyramidCount,
      partialCutCount: defaults.partialCutCount,
      trailingExitCount: defaults.trailingExitCount,
      profitLockPrice: defaults.profitLockPrice,
      lastRegimeRebalanceAt: defaults.lastRegimeRebalanceAt,
      recycleCycleCount: defaults.recycleCycleCount,
      executionStages: {},
      appliedFillEventIds: [],
      durableFillWatermarks: {},
      cooldownReason: undefined
    };
    let migrated = false;
    const candidate: Record<string, unknown> = { ...source };
    for (const [key, value] of Object.entries(legacyDefaults)) {
      if (!(key in candidate)) {
        candidate[key] = value;
        migrated = true;
      }
    }

    const finite = (value: unknown, label: string, min = -Infinity) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(`Invalid position field: ${label}.`);
    };
    const nullableFinite = (value: unknown, label: string, min = -Infinity) => {
      if (value !== null) finite(value, label, min);
    };
    if (typeof candidate.id !== 'string' || !candidate.id) throw new Error('Invalid position field: id.');
    if (typeof candidate.symbol !== 'string' || !candidate.symbol) throw new Error('Invalid position field: symbol.');
    if (typeof candidate.state !== 'string' || !POSITION_STATES.has(candidate.state as PositionState)) throw new Error('Invalid position field: state.');
    finite(candidate.amount, 'amount', 0);
    nullableFinite(candidate.entryPrice, 'entryPrice', 0);
    nullableFinite(candidate.positionEntryAtr, 'positionEntryAtr', 0);
    nullableFinite(candidate.initialStopPrice, 'initialStopPrice', 0);
    nullableFinite(candidate.initialBaseline, 'initialBaseline');
    nullableFinite(candidate.initialBand, 'initialBand');
    finite(candidate.totalCostKrw, 'totalCostKrw', 0);
    finite(candidate.realizedPnl, 'realizedPnl');
    finite(candidate.unrealizedPnl, 'unrealizedPnl');
    finite(candidate.unrealizedPnlPercent, 'unrealizedPnlPercent');
    nullableFinite(candidate.openedAt, 'openedAt', 0);
    finite(candidate.lastUpdatedAt, 'lastUpdatedAt', 0);
    finite(candidate.pyramidingCount, 'pyramidingCount', 0);
    finite(candidate.maxPyramidingOrders, 'maxPyramidingOrders', 0);
    finite(candidate.boxPyramidCount, 'boxPyramidCount', 0);
    finite(candidate.partialCutCount, 'partialCutCount', 0);
    finite(candidate.trailingExitCount, 'trailingExitCount', 0);
    nullableFinite(candidate.profitLockPrice, 'profitLockPrice', 0);
    finite(candidate.lastRegimeRebalanceAt, 'lastRegimeRebalanceAt', 0);
    finite(candidate.recycleCycleCount, 'recycleCycleCount', 0);
    finite(candidate.cooldownUntil, 'cooldownUntil', 0);
    if (typeof candidate.trailingActive !== 'boolean') throw new Error('Invalid position field: trailingActive.');
    nullableFinite(candidate.trailingPeakPrice, 'trailingPeakPrice', 0);

    if (!Array.isArray(candidate.dcaSlots) || candidate.dcaSlots.length === 0) throw new Error('Invalid position field: dcaSlots.');
    const slotNumbers = new Set<number>();
    for (const slot of candidate.dcaSlots) {
      if (!slot || typeof slot !== 'object') throw new Error('Invalid DCA slot.');
      const value = slot as Record<string, unknown>;
      if (typeof value.slotNumber !== 'number' || !Number.isInteger(value.slotNumber) || value.slotNumber < 1 || slotNumbers.has(value.slotNumber)) throw new Error('Invalid DCA slot number.');
      if (typeof value.status !== 'string' || !DCA_SLOT_STATUSES.has(value.status)) throw new Error('Invalid DCA slot status.');
      if (value.filledPrice !== undefined) finite(value.filledPrice, 'dcaSlots.filledPrice', 0);
      if (value.filledVolume !== undefined) finite(value.filledVolume, 'dcaSlots.filledVolume', 0);
      if (value.filledAt !== undefined) finite(value.filledAt, 'dcaSlots.filledAt', 0);
      if (value.plannedTargetPrice !== undefined) finite(value.plannedTargetPrice, 'dcaSlots.plannedTargetPrice', 0);
      slotNumbers.add(value.slotNumber);
    }
    if (!Array.isArray(candidate.appliedFillEventIds) || !candidate.appliedFillEventIds.every((id) => typeof id === 'string')) throw new Error('Invalid position fill-event ledger.');
    if (!candidate.durableFillWatermarks || typeof candidate.durableFillWatermarks !== 'object' || Array.isArray(candidate.durableFillWatermarks)) throw new Error('Invalid durable fill watermark ledger.');
    for (const [clientOrderId, watermark] of Object.entries(candidate.durableFillWatermarks as Record<string, unknown>)) {
      if (!clientOrderId || !watermark || typeof watermark !== 'object' || Array.isArray(watermark)) throw new Error('Invalid durable fill watermark.');
      const value = watermark as Record<string, unknown>;
      finite(value.volume, 'durableFillWatermarks.volume', 0);
      finite(value.fee, 'durableFillWatermarks.fee', 0);
      if (value.funds !== undefined) finite(value.funds, 'durableFillWatermarks.funds', 0);
      if (typeof value.initialApplied !== 'boolean') throw new Error('Invalid durable fill watermark initialApplied flag.');
    }
    if (!candidate.executionStages || typeof candidate.executionStages !== 'object' || Array.isArray(candidate.executionStages)) throw new Error('Invalid execution-stage ledger.');
    for (const [clientOrderId, stage] of Object.entries(candidate.executionStages as Record<string, unknown>)) {
      if (!clientOrderId || !stage || typeof stage !== 'object' || Array.isArray(stage)) throw new Error('Invalid execution stage.');
      const value = stage as Record<string, unknown>;
      if (typeof value.signalType !== 'string') throw new Error('Invalid execution stage signal type.');
      finite(value.cumulativeFilledVolume, 'executionStages.cumulativeFilledVolume', 0);
      if (value.targetVolume !== undefined) finite(value.targetVolume, 'executionStages.targetVolume', 0);
      if (value.targetBudgetKrw !== undefined) finite(value.targetBudgetKrw, 'executionStages.targetBudgetKrw', 0);
      if (value.status !== 'PARTIALLY_FILLED' && value.status !== 'FILLED' && value.status !== 'CANCELLED_PARTIAL') throw new Error('Invalid execution stage status.');
      finite(value.startedAt, 'executionStages.startedAt', 0);
      finite(value.updatedAt, 'executionStages.updatedAt', 0);
    }

    const amount = candidate.amount as number;
    const state = candidate.state as PositionState;
    if (amount > 1e-8) {
      const requiredPositiveProtectiveFields = ['entryPrice', 'positionEntryAtr', 'initialStopPrice', 'initialBaseline', 'initialBand'];
      const hasInvalidProtectiveNumber = requiredPositiveProtectiveFields.some((field) =>
        typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]) || (candidate[field] as number) <= 0
      );
      if (state === 'FLAT' || state === 'CLOSED' || hasInvalidProtectiveNumber) {
        throw new Error('Open position is missing required protective state.');
      }
      // Upgrade positions persisted by the former ATR/Math.max stop policy.
      // Their stop may sit just below the entry price and pre-empt every DCA
      // stage. The fixed -6% stop is the current safety-policy invariant.
      const exactAbsoluteStop = Number(((candidate.entryPrice as number) * 0.94).toFixed(2));
      if (Math.abs((candidate.initialStopPrice as number) - exactAbsoluteStop) > 0.01) {
        candidate.initialStopPrice = exactAbsoluteStop;
        migrated = true;
      }
    } else if (state === 'FLAT' && candidate.entryPrice !== null) {
      throw new Error('FLAT position cannot retain an entry price.');
    }
    return { state: candidate as unknown as PositionSnapshot, migrated };
  }

  private saveStateToFile() {
    if (this.activeFillEventId) {
      this.activeFillDirty = true;
      return;
    }

    this.commitStateToFile();
  }

  /** Performs the physical atomic rename. Durable fill transactions call this once at commit. */
  private commitStateToFile() {
    let addedActiveEvent = false;
    const activeWatermark = this.activeFillWatermark;
    const previousWatermark = activeWatermark ? this.position.durableFillWatermarks?.[activeWatermark.clientOrderId] : undefined;
    try {
      const dir = path.dirname(POSITION_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (this.activeFillEventId && !(this.position.appliedFillEventIds || []).includes(this.activeFillEventId)) {
        this.position.appliedFillEventIds = [...(this.position.appliedFillEventIds || []), this.activeFillEventId].slice(-500);
        addedActiveEvent = true;
      }
      if (activeWatermark) {
        this.position.durableFillWatermarks = {
          ...(this.position.durableFillWatermarks || {}),
          [activeWatermark.clientOrderId]: {
            volume: activeWatermark.volume,
            fee: activeWatermark.fee,
            funds: activeWatermark.funds,
            initialApplied: activeWatermark.initialApplied
          }
        };
      }
      const tmpFile = POSITION_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.position, null, 2), 'utf-8');
      fs.renameSync(tmpFile, POSITION_FILE);
      // The first successful runtime commit is authoritative persisted state
      // too; do not keep treating this process as a missing-ledger startup.
      this.persistedStateFound = true;
    } catch (e) {
      if (addedActiveEvent && this.activeFillEventId) {
        this.position.appliedFillEventIds = (this.position.appliedFillEventIds || []).filter((id) => id !== this.activeFillEventId);
      }
      if (activeWatermark) {
        const watermarks = { ...(this.position.durableFillWatermarks || {}) };
        if (previousWatermark) watermarks[activeWatermark.clientOrderId] = previousWatermark;
        else delete watermarks[activeWatermark.clientOrderId];
        this.position.durableFillWatermarks = watermarks;
      }
      console.error('[PositionManager] Failed to save position state to file:', e);
      throw e;
    }
  }
}
