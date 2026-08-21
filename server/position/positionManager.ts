import fs from 'fs';
import path from 'path';
import { PositionSnapshot, PositionState, BotParams, OrderFill } from '../types/trading';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const TRADE_LOGS_FILE = path.join(DATA_DIR, 'trade_logs.json');

const POSITION_FILE = path.join(DATA_DIR, 'position_state.json');

export class PositionManager {
  private position: PositionSnapshot;
  private params: BotParams;

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
      cooldownUntil: 0
    };
  }

  public getSnapshot(): PositionSnapshot {
    return { ...this.position, dcaSlots: this.position.dcaSlots.map((s) => ({ ...s })) };
  }

  public setParams(newParams: BotParams) {
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
    const dynamicStopLossPrice = lowerBand - (atr * stopLossMultiplier);
    // Absolute Stop-Loss Floor: 마지노선 손절선 -6.0% (중간 단계는 -1.0% 30% 덜어내기, -2.0% DCA 1차, -3.2% 50% 덜어내기, -4.5% DCA 2차로 방어)
    const MIN_STOP_LOSS_DROP_PERCENT = 6.0;
    const floorStopLossPrice = fillPrice * (1 - MIN_STOP_LOSS_DROP_PERCENT / 100);
    // The absolute floor is a maximum permitted loss, so never select a
    // stop below it when ATR expands.
    const staticStopLossPrice = Math.max(dynamicStopLossPrice, floorStopLossPrice);

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
    const dynamicStopLossPrice = lowerBand - (atr * stopLossMultiplier);
    const floorStopLossPrice = newWeightedAvgPrice * 0.94;

    this.position.state = 'ENTRY_FILLED';
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.positionEntryAtr = atr;
    this.position.initialBaseline = baseline;
    this.position.initialBand = lowerBand;
    this.position.initialStopPrice = Number((Math.max(dynamicStopLossPrice, floorStopLossPrice)).toFixed(2));
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
    this.onManualAdditionalBuyFilled(fillPrice, fillVolume, baseline, atr, atrMultiplier, stopLossMultiplier);
    this.position.lastRegimeRebalanceAt = Date.now();
    this.saveStateToFile();
    console.log(`[PositionManager] Regime rebalance filled: Added=${fillVolume}, next regime add delayed.`);
  }

  /**
   * Called when a DCA safety order fills.
   */
  public onDcaFilled(slotNumber: number, fillPrice: number, fillVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(8));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.state = 'DCA_MODE';
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.partialCutCount = 0; // Reset recycling cut gates on newly lowered weighted avg
    this.position.initialStopPrice = Number((newWeightedAvgPrice * 0.94).toFixed(2)); // Floor stop loss locked at -6.0% of new average
    this.position.lastUpdatedAt = Date.now();

    const slot = this.position.dcaSlots.find((s) => s.slotNumber === slotNumber);
    if (slot) {
      slot.status = 'FILLED';
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
    this.position.initialStopPrice = Number((newWeightedAvgPrice * 0.94).toFixed(2));
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
  public addAdditionalDcaFilled(fillPrice: number, additionalVolume: number) {
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
  public onTrailingPartialFilled(cutVolume: number, cutPrice: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(8));
    this.position.realizedPnl += pnl;
    this.position.lastUpdatedAt = Date.now();
    this.position.trailingExitCount = (this.position.trailingExitCount || 0) + 1;

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
    const dynamicStop = lowerBand - (atr * stopLossMultiplier);
    const absoluteFloor = this.position.entryPrice * 0.94;

    this.position.state = 'ENTRY_FILLED';
    this.position.positionEntryAtr = atr;
    this.position.initialBaseline = baseline;
    this.position.initialBand = lowerBand;
    this.position.initialStopPrice = Number(Math.max(dynamicStop, absoluteFloor).toFixed(2));
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

    if (realCoinQuantity < 0.0001) {
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
        const parsed = JSON.parse(raw);
        this.position = { ...this.position, ...parsed };
        console.log('[PositionManager] Saved Position State restored from file.');
      }
    } catch (e) {
      console.error('[PositionManager] Failed to load position state from file:', e);
    }
  }

  private saveStateToFile() {
    try {
      const dir = path.dirname(POSITION_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpFile = POSITION_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this.position, null, 2), 'utf-8');
      fs.renameSync(tmpFile, POSITION_FILE);
    } catch (e) {
      console.error('[PositionManager] Failed to save position state to file:', e);
    }
  }
}
