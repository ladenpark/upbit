import fs from 'fs';
import path from 'path';
import { PositionSnapshot, PositionState, BotParams, OrderFill } from '../types/trading';

const TRADE_LOGS_FILE = path.join(process.cwd(), 'data', 'trade_logs.json');

const POSITION_FILE = path.join(process.cwd(), 'data', 'position_state.json');

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
      trailingActive: false,
      trailingPeakPrice: null,
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
    const staticStopLossPrice = lowerBand - (atr * stopLossMultiplier);

    this.position.id = `POS_${Date.now()}`;
    this.position.state = 'ENTRY_FILLED';
    this.position.amount = Number(fillVolume.toFixed(6));
    this.position.entryPrice = fillPrice;
    this.position.positionEntryAtr = atr;
    this.position.initialBaseline = baseline;
    this.position.initialBand = lowerBand;
    this.position.initialStopPrice = Number(staticStopLossPrice.toFixed(2));
    this.position.totalCostKrw = fillPrice * fillVolume;
    this.position.openedAt = Date.now();
    this.position.lastUpdatedAt = Date.now();

    // Reset DCA slots & Pyramiding
    this.position.dcaSlots = Array.from({ length: this.params.maxSafetyOrders }, (_, i) => ({
      slotNumber: i + 1,
      status: 'AVAILABLE'
    }));
    this.position.pyramidingCount = 0;
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;

    this.saveStateToFile();
    console.log(`[PositionManager] Initial Entry Filled: Price=${fillPrice}, Qty=${fillVolume}, Static Stop Loss locked at ₩${Math.round(staticStopLossPrice).toLocaleString()}`);
  }

  /**
   * Called when additional volume fills for an existing initial entry (e.g., via background watcher).
   */
  public addAdditionalEntryFilled(fillPrice: number, additionalVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + additionalVolume).toFixed(6));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + additionalVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * additionalVolume;
    this.position.lastUpdatedAt = Date.now();

    this.saveStateToFile();
    console.log(`[PositionManager] Additional Entry Filled: Added=${additionalVolume}, New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /**
   * Called when a DCA safety order fills.
   */
  public onDcaFilled(slotNumber: number, fillPrice: number, fillVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + fillVolume).toFixed(6));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.state = 'DCA_MODE';
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.lastUpdatedAt = Date.now();

    const slot = this.position.dcaSlots.find((s) => s.slotNumber === slotNumber);
    if (slot) {
      slot.status = 'FILLED';
      slot.filledPrice = fillPrice;
      slot.filledVolume = fillVolume;
      slot.filledAt = Date.now();
    }

    this.saveStateToFile();
    console.log(`[PositionManager] DCA #${slotNumber} Filled: New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /**
   * Called when additional volume fills for an existing DCA order (via watcher).
   * Does NOT consume a new DCA slot!
   */
  public addAdditionalDcaFilled(fillPrice: number, additionalVolume: number) {
    const currentQty = this.position.amount;
    const currentEntry = this.position.entryPrice || fillPrice;
    const newTotalQty = Number((currentQty + additionalVolume).toFixed(6));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + additionalVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * additionalVolume;
    this.position.lastUpdatedAt = Date.now();

    const lastFilledSlot = [...this.position.dcaSlots].reverse().find((s) => s.status === 'FILLED');
    if (lastFilledSlot) {
      lastFilledSlot.filledVolume = Number(((lastFilledSlot.filledVolume || 0) + additionalVolume).toFixed(6));
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
    const newTotalQty = Number((currentQty + fillVolume).toFixed(6));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + fillVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.pyramidingCount += 1;
    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * fillVolume;
    this.position.lastUpdatedAt = Date.now();

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
    const newTotalQty = Number((currentQty + additionalVolume).toFixed(6));
    const newWeightedAvgPrice = Number(((currentQty * currentEntry + additionalVolume * fillPrice) / newTotalQty).toFixed(2));

    this.position.amount = newTotalQty;
    this.position.entryPrice = newWeightedAvgPrice;
    this.position.totalCostKrw += fillPrice * additionalVolume;
    this.position.lastUpdatedAt = Date.now();

    this.saveStateToFile();
    console.log(`[PositionManager] Additional Pyramid Volume Filled: Added=${additionalVolume}, New Total Qty=${newTotalQty}, New Avg Price=₩${newWeightedAvgPrice.toLocaleString()}`);
  }

  /**
   * Called on Partial Loss Cut:
   * Sells portion, transitions to DEFENSIVE, frees 1 DCA slot for deeper dip, but requires REENTRY_WAIT before buying.
   */
  public onPartialLossCutFilled(cutVolume: number, cutPrice: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(6));
    this.position.realizedPnl += pnl;
    this.position.state = 'DEFENSIVE';
    this.position.lastUpdatedAt = Date.now();

    // Disable nearest filled DCA slot to prevent immediate re-DCA loop!
    const filledSlot = [...this.position.dcaSlots].reverse().find((s) => s.status === 'FILLED');
    if (filledSlot) {
      filledSlot.status = 'DISABLED'; // Must stabilize before slot becomes usable
    }

    this.setCooldown(this.params.cooldownSecondsAfterCut || 60, 'PARTIAL_LOSS_CUT');
    this.saveStateToFile();
    console.log(`[PositionManager] Partial Loss Cut Filled: Cut ${cutVolume} @ ₩${cutPrice.toLocaleString()}, PnL=₩${pnl.toLocaleString()}, State ➡️ DEFENSIVE`);
  }

  /**
   * Called when additional volume fills for an existing Partial Loss Cut (via watcher).
   * Does NOT re-disable another DCA slot or reset cooldown.
   */
  public addAdditionalPartialCutFilled(cutVolume: number, cutPrice: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(6));
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
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(6));
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
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(6));
    this.position.realizedPnl += pnl;
    this.position.lastUpdatedAt = Date.now();

    // Disarm trailing: require a fresh higher high before the next partial take-profit can fire.
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;

    if (this.position.amount <= 0) {
      this.position.entryPrice = null;
      this.position.state = 'FLAT';
      this.position.pyramidingCount = 0;
    }

    this.saveStateToFile();
    console.log(`[PositionManager] Trailing Partial Take-Profit: Sold ${cutVolume} @ ₩${cutPrice.toLocaleString()}, Remaining Qty=${this.position.amount}, PnL=₩${Math.round(pnl).toLocaleString()}`);
  }

  /**
   * Called when partial fill occurs on a Full Exit order (Trailing Stop, Absolute Stop, Emergency Exit).
   * Reduces position amount without fully closing to FLAT until 100% completed.
   */
  public reducePositionOnPartialExit(cutVolume: number, pnl: number) {
    this.position.amount = Number(Math.max(0, this.position.amount - cutVolume).toFixed(6));
    this.position.realizedPnl += pnl;
    this.position.lastUpdatedAt = Date.now();
    this.saveStateToFile();
    console.log(`[PositionManager] Full Exit Partial Fill: Sold ${cutVolume}, Remaining Position=${this.position.amount}`);
  }

  /**
   * Signal stabilization after dip: moves state to REENTRY_ALLOWED
   */
  public enableReentry() {
    if (this.position.state === 'EMERGENCY_EXIT' || this.position.state === 'DEFENSIVE') {
      this.position.state = 'REENTRY_ALLOWED';
      this.saveStateToFile();
    }
  }

  /**
   * Full Position Close (Take Profit, Absolute Stop Loss, or Emergency Full Exit)
   */
  public onPositionClosed(pnl: number, reason: string) {
    this.position.amount = 0;
    this.position.entryPrice = null;
    this.position.positionEntryAtr = null;
    this.position.initialStopPrice = null;
    this.position.realizedPnl += pnl;
    this.position.state = 'FLAT';
    this.position.trailingActive = false;
    this.position.trailingPeakPrice = null;
    this.position.pyramidingCount = 0;
    this.position.lastUpdatedAt = Date.now();

    this.setCooldown(30, reason);
    this.saveStateToFile();
    console.log(`[PositionManager] Position 100% CLOSED (${reason}). Total Realized PnL: ₩${this.position.realizedPnl.toLocaleString()}`);
  }

  public updateTrailingState(currentPrice: number, upperBand: number) {
    const entryPrice = this.position.entryPrice || 0;
    // Arming requires BOTH upper band touch AND price strictly above entry price (Profit Lock-in Gate)
    if (this.position.amount > 0 && currentPrice >= upperBand && currentPrice > entryPrice) {
      if (!this.position.trailingActive) {
        this.position.trailingActive = true;
        this.position.trailingPeakPrice = currentPrice;
        this.position.state = 'TAKE_PROFIT';
        console.log(`[PositionManager] Trailing Take Profit ACTIVATED @ ₩${currentPrice.toLocaleString()} (Entry: ₩${Math.round(entryPrice).toLocaleString()})`);
      } else if (this.position.trailingPeakPrice && currentPrice > this.position.trailingPeakPrice) {
        this.position.trailingPeakPrice = currentPrice;
      }
    }
  }

  public setCooldown(seconds: number, reason: string) {
    this.position.cooldownUntil = Date.now() + (seconds * 1000);
    this.position.cooldownReason = reason;
  }

  public isUnderCooldown(): boolean {
    return Date.now() < this.position.cooldownUntil;
  }

  /**
   * Reconciles internal state with authoritative real exchange balance and average buy price.
   */
  public reconcileWithExchange(realCoinQuantity: number, authoritativeAvgBuyPrice?: number | null, fallbackPrice?: number) {
    let stateChanged = false;
    if (Math.abs(this.position.amount - realCoinQuantity) > 0.0001) {
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
      if (this.position.state === 'FLAT') {
        this.position.state = 'ENTRY_FILLED';
        stateChanged = true;
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
