import fs from 'fs';
import path from 'path';
import { OrderRequest, OrderRecord, OrderStatus, ApiKeys } from '../types/trading';
import { UpbitClient, UpbitOrderResponse } from '../exchanges/upbit';
import { ApiGateway } from '../gateway/apiGateway';
import { GlobalRiskGovernor } from '../risk/globalRiskGovernor';

const ORDERS_FILE = path.join(process.cwd(), 'data', 'order_history.json');
const PROCESSED_SIGNALS_FILE = path.join(process.cwd(), 'data', 'processed_signals.json');

const FILL_CONFIRM_MAX_RETRIES = 5;
const FILL_CONFIRM_INTERVAL_MS = 600; // 600ms between polls → max ~3s total

export class OrderManager {
  private upbitClient: UpbitClient;
  private apiGateway: ApiGateway;
  private riskGovernor?: GlobalRiskGovernor;
  private onOrderUpdated?: (record: OrderRecord, prevFilledVolume: number) => void;
  private lastApiKeys?: ApiKeys;
  private orders: Map<string, OrderRecord> = new Map();
  private processedSignalIds: Set<string> = new Set();
  private partialFillWatchTimer: NodeJS.Timeout | null = null;
  private watchingOrderIds: Set<string> = new Set();

  constructor(
    riskGovernor?: GlobalRiskGovernor,
    onOrderUpdated?: (record: OrderRecord, prevFilledVolume: number) => void
  ) {
    this.upbitClient = new UpbitClient();
    this.apiGateway = ApiGateway.getInstance();
    this.riskGovernor = riskGovernor;
    this.onOrderUpdated = onOrderUpdated;
    this.loadProcessedSignalIds();
    this.loadOrdersFromFile();
    this.startPartialFillWatcher();
  }

  public setRiskGovernor(governor: GlobalRiskGovernor) {
    this.riskGovernor = governor;
  }

  public setOnOrderUpdated(cb: (record: OrderRecord, prevFilledVolume: number) => void) {
    this.onOrderUpdated = cb;
  }

  public setApiKeysForWatcher(keys: ApiKeys) {
    this.lastApiKeys = keys;
  }

  /**
   * Returns list of currently pending orders (ORDER_SUBMITTING, ORDER_SUBMITTED, OPEN, PARTIALLY_FILLED, UNKNOWN).
   */
  public getPendingOrders(): OrderRecord[] {
    const list: OrderRecord[] = [];
    for (const order of this.orders.values()) {
      if (
        order.status === 'ORDER_SUBMITTING' ||
        order.status === 'ORDER_SUBMITTED' ||
        order.status === 'OPEN' ||
        order.status === 'PARTIALLY_FILLED' ||
        order.status === 'UNKNOWN_PENDING_RECONCILIATION'
      ) {
        list.push({ ...order });
      }
    }
    return list;
  }

  public getPendingOrdersCount(): number {
    return this.getPendingOrders().length;
  }

  public hasSignalBeenProcessed(signalId: string): boolean {
    return this.processedSignalIds.has(signalId);
  }

  public getAllOrders(): OrderRecord[] {
    return Array.from(this.orders.values());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ──────────────────────────────────────────────────────────
  // Processed Signals Persistence
  // ──────────────────────────────────────────────────────────
  private loadProcessedSignalIds() {
    try {
      if (fs.existsSync(PROCESSED_SIGNALS_FILE)) {
        const raw = fs.readFileSync(PROCESSED_SIGNALS_FILE, 'utf-8');
        const list: string[] = JSON.parse(raw);
        list.forEach((id) => this.processedSignalIds.add(id));
        console.log(`[OrderManager] Loaded ${this.processedSignalIds.size} processed signal IDs from file.`);
      }
    } catch (e) {
      console.error('[OrderManager] Failed to load processed signal IDs:', e);
    }
  }

  private saveProcessedSignalIds() {
    try {
      const dir = path.dirname(PROCESSED_SIGNALS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this.processedSignalIds).slice(-1000); // keep last 1000
      const tmpFile = PROCESSED_SIGNALS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), 'utf-8');
      fs.renameSync(tmpFile, PROCESSED_SIGNALS_FILE);
    } catch (e) {
      console.error('[OrderManager] Failed to save processed signal IDs:', e);
    }
  }

  // ──────────────────────────────────────────────────────────
  // State Mapping & Fill Data Extraction (Upbit)
  // ──────────────────────────────────────────────────────────
  private mapUpbitState(upbitState: string, executedVolume: number, remainingVolume: number): OrderStatus {
    if (upbitState === 'done') return 'FILLED';
    if (upbitState === 'cancel') {
      // In Upbit Market Orders, tiny remainder is cancelled after full fill.
      // If any volume was executed, the order is FILLED and finalized!
      if (executedVolume > 0) return 'FILLED';
      return 'CANCELLED';
    }
    if (upbitState === 'wait' || upbitState === 'watch') {
      if (executedVolume > 0 && remainingVolume > 0) return 'PARTIALLY_FILLED';
      return 'OPEN';
    }
    return 'UNKNOWN';
  }

  private extractUpbitFillData(order: UpbitOrderResponse): { executedVolume: number; avgFillPrice: number; totalFee: number } {
    const executedVolume = parseFloat(order.executed_volume) || 0;
    const totalFee = parseFloat(order.paid_fee) || 0;

    let avgFillPrice = 0;
    if (order.trades && order.trades.length > 0) {
      let totalFunds = 0;
      let totalVol = 0;
      for (const t of order.trades) {
        const tv = parseFloat(t.volume) || 0;
        const tp = parseFloat(t.price) || 0;
        totalFunds += tv * tp;
        totalVol += tv;
      }
      avgFillPrice = totalVol > 0 ? totalFunds / totalVol : 0;
    } else if (executedVolume > 0 && order.price) {
      const reserved = parseFloat(order.reserved) || 0;
      const locked = parseFloat(order.locked) || 0;
      const spent = reserved > 0 ? reserved : locked;
      avgFillPrice = executedVolume > 0 && spent > 0 ? spent / executedVolume : 0;
    }

    return { executedVolume, avgFillPrice, totalFee };
  }

  // ──────────────────────────────────────────────────────────
  // Polling Order Status (Upbit)
  // ──────────────────────────────────────────────────────────
  private async pollUpbitOrderStatus(
    accessKey: string,
    secretKey: string,
    uuid: string
  ): Promise<UpbitOrderResponse | null> {
    let currentInterval = 600;
    for (let attempt = 1; attempt <= FILL_CONFIRM_MAX_RETRIES; attempt++) {
      await this.sleep(currentInterval);
      try {
        const queryRes = await this.upbitClient.getOrder(accessKey, secretKey, uuid);
        if (queryRes.success && queryRes.order) {
          const state = queryRes.order.state;
          if (state === 'done' || state === 'cancel') {
            return queryRes.order;
          }
          if (attempt === FILL_CONFIRM_MAX_RETRIES) {
            return queryRes.order;
          }
        }
      } catch (e) {
        console.warn(`[OrderManager] Upbit poll attempt ${attempt}/${FILL_CONFIRM_MAX_RETRIES} failed:`, e);
      }
      currentInterval = Math.floor(currentInterval * 1.5);
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────
  // Reconciliation Logic (Upbit)
  // ──────────────────────────────────────────────────────────
  public async reconcileUpbitOrder(
    clientOrderId: string,
    exchangeUuid: string | undefined,
    symbol: string,
    side: 'BUY' | 'SELL',
    accessKey: string,
    secretKey: string
  ): Promise<{ found: boolean; order?: UpbitOrderResponse }> {
    // Step 1: Query by identifier
    try {
      const idRes = await this.upbitClient.getOrderByIdentifier(accessKey, secretKey, clientOrderId);
      if (idRes.success && idRes.order) {
        console.log(`[OrderManager] ✅ Upbit Reconcile Step 1: Found by identifier '${clientOrderId}' (state=${idRes.order.state})`);
        return { found: true, order: idRes.order };
      }
    } catch (e) {
      console.warn('[OrderManager] Upbit Reconcile Step 1 failed:', e);
    }

    // Step 2: Query by uuid
    if (exchangeUuid) {
      try {
        const uuidRes = await this.upbitClient.getOrder(accessKey, secretKey, exchangeUuid);
        if (uuidRes.success && uuidRes.order) {
          console.log(`[OrderManager] ✅ Upbit Reconcile Step 2: Found by uuid '${exchangeUuid}' (state=${uuidRes.order.state})`);
          return { found: true, order: uuidRes.order };
        }
      } catch (e) {
        console.warn('[OrderManager] Upbit Reconcile Step 2 failed:', e);
      }
    }

    // Step 3: Scan open orders
    try {
      const openRes = await this.upbitClient.getOpenOrders(accessKey, secretKey, symbol);
      if (openRes.success && Array.isArray(openRes.orders)) {
        const sideKey = side === 'BUY' ? 'bid' : 'ask';
        const match = openRes.orders.find((o: any) =>
          o.side === sideKey && o.identifier === clientOrderId
        );
        if (match) {
          console.log(`[OrderManager] ✅ Upbit Reconcile Step 3: Found in open orders list`);
          return { found: true, order: match };
        }
      }
    } catch (e) {
      console.warn('[OrderManager] Upbit Reconcile Step 3 failed:', e);
    }

    console.warn(`[OrderManager] ⚠️ Upbit Reconcile EXHAUSTED: Order '${clientOrderId}' not found on exchange.`);
    return { found: false };
  }

  // ──────────────────────────────────────────────────────────
  // Submit Order (Upbit Exclusive)
  // ──────────────────────────────────────────────────────────
  public async submitOrder(
    req: OrderRequest,
    apiKeys: ApiKeys,
    exchange: 'UPBIT' = 'UPBIT',
    onFilled: (record: OrderRecord) => void,
    onError: (error: string) => void
  ): Promise<OrderRecord> {
    if (this.processedSignalIds.has(req.signalId)) {
      throw new Error(`[OrderManager] Signal ID ${req.signalId} has already been processed (Duplicate prevented).`);
    }

    this.processedSignalIds.add(req.signalId);
    this.saveProcessedSignalIds();
    this.lastApiKeys = apiKeys;

    const record: OrderRecord = {
      id: `ORD_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      clientOrderId: req.clientOrderId,
      signalId: req.signalId,
      signalType: req.signalType,
      symbol: req.symbol,
      side: req.side,
      status: 'ORDER_SUBMITTING',
      requestedBudgetOrVolume: req.requestedAmountKrw || req.requestedVolume || 0,
      filledVolume: 0,
      avgFillPrice: 0,
      fee: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      reason: req.reason,
      fills: []
    };

    this.orders.set(record.id, record);
    this.saveOrdersToFile();

    // Auto-reserve exposure for BUY orders if riskGovernor is attached
    if (req.side === 'BUY' && req.requestedAmountKrw && this.riskGovernor) {
      this.riskGovernor.reserveExposure(req.clientOrderId, req.requestedAmountKrw);
    }

    try {
      const accessKey = apiKeys.upbitAccessKey;
      const secretKey = apiKeys.upbitSecretKey;
      if (!accessKey || !secretKey) {
        throw new Error('Upbit API keys are not configured.');
      }

      const priority = req.side === 'SELL' ? 1 : 2;
      let submitResponse: { success: boolean; orderId?: string; raw?: any; error?: string } | null = null;

      try {
        submitResponse = await this.apiGateway.enqueue(priority, async () => {
          if (req.side === 'BUY') {
            return await this.upbitClient.executeOrder(
              accessKey, secretKey, req.symbol, 'BUY',
              { price: req.requestedAmountKrw },
              req.clientOrderId
            );
          } else {
            return await this.upbitClient.executeOrder(
              accessKey, secretKey, req.symbol, 'SELL',
              { volume: req.requestedVolume, limitPrice: req.limitPrice },
              req.clientOrderId
            );
          }
        });
      } catch (netErr: any) {
        console.warn(`[OrderManager] ⚠️ Upbit network error on submit: ${netErr.message}. Starting reconciliation...`);
        record.status = 'UNKNOWN_PENDING_RECONCILIATION';
        record.error = netErr.message;
        this.saveOrdersToFile();

        await this.sleep(1500);

        const reconcileRes = await this.reconcileUpbitOrder(
          req.clientOrderId, record.exchangeOrderId, req.symbol, req.side, accessKey, secretKey
        );

        if (reconcileRes.found && reconcileRes.order) {
          this.applyUpbitOrderState(record, reconcileRes.order, onFilled, onError, 'SUBMIT_FLOW');
        } else {
          record.status = 'UNKNOWN_PENDING_RECONCILIATION';
          record.error = 'Timeout: order status unconfirmed after reconciliation. Blocking until resolved.';
          record.updatedAt = Date.now();
          this.saveOrdersToFile();
          onError(record.error);
        }
        return record;
      }

      if (submitResponse && submitResponse.success && submitResponse.orderId) {
        record.exchangeOrderId = submitResponse.orderId;
        record.status = 'ORDER_SUBMITTED';
        record.updatedAt = Date.now();
        this.saveOrdersToFile();

        const confirmedOrder = await this.pollUpbitOrderStatus(accessKey, secretKey, submitResponse.orderId);
        if (confirmedOrder) {
          this.applyUpbitOrderState(record, confirmedOrder, onFilled, onError, 'SUBMIT_FLOW');
        } else {
          const reconcileRes = await this.reconcileUpbitOrder(
            req.clientOrderId, submitResponse.orderId, req.symbol, req.side, accessKey, secretKey
          );
          if (reconcileRes.found && reconcileRes.order) {
            this.applyUpbitOrderState(record, reconcileRes.order, onFilled, onError, 'SUBMIT_FLOW');
          } else {
            record.status = 'UNKNOWN_PENDING_RECONCILIATION';
            record.updatedAt = Date.now();
            this.saveOrdersToFile();
            onError('Order submitted but fill status unconfirmed after reconciliation');
          }
        }
      } else if (submitResponse) {
        record.status = 'REJECTED';
        record.error = submitResponse.error || 'Upbit order rejected';
        record.updatedAt = Date.now();
        this.saveOrdersToFile();
        if (req.side === 'BUY' && this.riskGovernor) {
          this.riskGovernor.releaseExposure(req.clientOrderId);
        }
        onError(record.error);
      }
    } catch (err: any) {
      record.status = 'REJECTED';
      record.error = err.message;
      record.updatedAt = Date.now();
      this.saveOrdersToFile();
      if (req.side === 'BUY' && this.riskGovernor) {
        this.riskGovernor.releaseExposure(req.clientOrderId);
      }
      onError(err.message);
    }

    return record;
  }

  // ──────────────────────────────────────────────────────────
  // Applying Confirmed States (Upbit) & Fill Notification
  // ──────────────────────────────────────────────────────────
  public applyUpbitOrderState(
    record: OrderRecord,
    exchangeOrder: UpbitOrderResponse,
    onFilled: (record: OrderRecord) => void,
    onError: (error: string) => void,
    source: 'SUBMIT_FLOW' | 'WATCHER' = 'SUBMIT_FLOW'
  ) {
    const prevStatus = record.status;
    const prevFilledVolume = record.filledVolume;

    record.exchangeOrderId = exchangeOrder.uuid;
    const { executedVolume, avgFillPrice, totalFee } = this.extractUpbitFillData(exchangeOrder);
    const remainingVolume = parseFloat(exchangeOrder.remaining_volume) || 0;
    const status = this.mapUpbitState(exchangeOrder.state, executedVolume, remainingVolume);

    record.status = status;
    record.filledVolume = executedVolume;
    record.avgFillPrice = avgFillPrice;
    record.fee = totalFee;
    record.updatedAt = Date.now();
    record.error = undefined;
    this.saveOrdersToFile();

    console.log(`[OrderManager] 📊 Upbit confirmed (${source}): uuid=${exchangeOrder.uuid}, state=${exchangeOrder.state}, executed=${executedVolume}, avgPrice=₩${Math.round(avgFillPrice).toLocaleString()}`);

    if (status === 'FILLED') {
      if (record.side === 'BUY' && this.riskGovernor) {
        this.riskGovernor.commitExposure(record.clientOrderId);
      }
      this.watchingOrderIds.delete(record.id);
      onFilled(record);

      // Async fill notification guard: ONLY when coming from WATCHER/Reconciliation AND there is new fill progress
      if (source === 'WATCHER' && (prevStatus !== 'FILLED' || executedVolume > prevFilledVolume)) {
        this.onOrderUpdated?.(record, prevFilledVolume);
      }
    } else if (status === 'PARTIALLY_FILLED') {
      this.watchingOrderIds.add(record.id);
      if (executedVolume > 0) {
        onFilled(record);
      }
      if (source === 'WATCHER' && executedVolume > prevFilledVolume) {
        this.onOrderUpdated?.(record, prevFilledVolume);
      }
    } else if (status === 'CANCELLED' || status === 'REJECTED') {
      if (record.side === 'BUY' && this.riskGovernor) {
        this.riskGovernor.releaseExposure(record.clientOrderId);
      }
      this.watchingOrderIds.delete(record.id);
      onError(`Order ${status}: executed_volume=${executedVolume}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Startup Reconciliation for Pending Orders (Upbit)
  // ──────────────────────────────────────────────────────────
  public async reconcilePendingOrdersOnStartup(
    apiKeys: ApiKeys,
    exchange: 'UPBIT' = 'UPBIT',
    symbol: string = 'KRW-ETH'
  ): Promise<number> {
    console.log(`[OrderManager] 🔄 Reconciling pending orders on startup for Upbit...`);
    this.lastApiKeys = apiKeys;
    let reconciledCount = 0;

    const pending = this.getPendingOrders();
    for (const ord of pending) {
      try {
        if (apiKeys.upbitAccessKey && apiKeys.upbitSecretKey) {
          const res = await this.reconcileUpbitOrder(
            ord.clientOrderId,
            ord.exchangeOrderId,
            symbol,
            ord.side,
            apiKeys.upbitAccessKey,
            apiKeys.upbitSecretKey
          );
          if (res.found && res.order) {
            this.applyUpbitOrderState(ord, res.order, () => {}, () => {}, 'WATCHER');
            reconciledCount++;
          }
        }
      } catch (e) {
        console.error(`[OrderManager] Failed to reconcile pending order ${ord.clientOrderId} on startup:`, e);
      }
    }

    console.log(`[OrderManager] Startup reconciliation completed. Reconciled ${reconciledCount}/${pending.length} pending orders.`);
    return reconciledCount;
  }

  // ──────────────────────────────────────────────────────────
  // Background Partial Fill Watcher
  // ──────────────────────────────────────────────────────────
  private startPartialFillWatcher() {
    if (this.partialFillWatchTimer) return;
    this.partialFillWatchTimer = setInterval(async () => {
      if (!this.lastApiKeys?.upbitAccessKey || !this.lastApiKeys?.upbitSecretKey) return;

      const STALE_ORDER_TIMEOUT_MS = 60000;   // 60 seconds for OPEN/PARTIALLY_FILLED
      const UNKNOWN_ORDER_TIMEOUT_MS = 120000; // 120 seconds for UNKNOWN_PENDING_RECONCILIATION
      const now = Date.now();

      // 1. Check watched orders (PARTIALLY_FILLED / OPEN)
      for (const orderId of Array.from(this.watchingOrderIds)) {
        const ord = this.orders.get(orderId);
        if (!ord || (ord.status !== 'PARTIALLY_FILLED' && ord.status !== 'OPEN')) {
          this.watchingOrderIds.delete(orderId);
          continue;
        }

        const elapsed = now - ord.createdAt;

        // Auto-cancel stale orders after 60 seconds
        if (elapsed > STALE_ORDER_TIMEOUT_MS && ord.exchangeOrderId) {
          console.warn(`[OrderManager] ⏰ Stale order detected (${Math.round(elapsed / 1000)}s): ${ord.clientOrderId}. Auto-cancelling...`);
          try {
            const cancelRes = await this.upbitClient.cancelOrder(
              this.lastApiKeys.upbitAccessKey,
              this.lastApiKeys.upbitSecretKey,
              ord.exchangeOrderId
            );
            if (cancelRes.success && cancelRes.order) {
              this.applyUpbitOrderState(ord, cancelRes.order, () => {}, () => {}, 'WATCHER');
              console.log(`[OrderManager] ✅ Stale order auto-cancelled: ${ord.clientOrderId} (filled=${ord.filledVolume})`);
            } else {
              console.warn(`[OrderManager] ⚠️ Cancel failed for ${ord.clientOrderId}: ${cancelRes.error}`);
            }
          } catch (e) {
            console.warn(`[OrderManager] Cancel error for ${ord.clientOrderId}:`, e);
          }
          continue;
        }

        // Normal reconciliation for non-stale watched orders
        try {
          const res = await this.reconcileUpbitOrder(
            ord.clientOrderId,
            ord.exchangeOrderId,
            ord.symbol,
            ord.side,
            this.lastApiKeys.upbitAccessKey,
            this.lastApiKeys.upbitSecretKey
          );
          if (res.found && res.order) {
            this.applyUpbitOrderState(ord, res.order, () => {}, () => {}, 'WATCHER');
          }
        } catch (e) {
          console.warn(`[OrderManager] Partial fill watcher: reconcile failed for ${ord.clientOrderId}`, e);
        }
      }

      // 2. Check UNKNOWN_PENDING_RECONCILIATION orders (not in watchingOrderIds)
      for (const ord of this.orders.values()) {
        if (ord.status !== 'UNKNOWN_PENDING_RECONCILIATION') continue;
        const elapsed = now - ord.updatedAt;
        if (elapsed <= UNKNOWN_ORDER_TIMEOUT_MS) continue;

        console.warn(`[OrderManager] ⏰ UNKNOWN order timeout (${Math.round(elapsed / 1000)}s): ${ord.clientOrderId}. Force-releasing...`);

        // Try one last reconciliation
        try {
          const res = await this.reconcileUpbitOrder(
            ord.clientOrderId,
            ord.exchangeOrderId,
            ord.symbol,
            ord.side,
            this.lastApiKeys.upbitAccessKey,
            this.lastApiKeys.upbitSecretKey
          );
          if (res.found && res.order) {
            this.applyUpbitOrderState(ord, res.order, () => {}, () => {}, 'WATCHER');
            continue;
          }
        } catch {}

        // If still unresolved, force-release
        ord.status = 'CANCELLED';
        ord.error = 'Force-released after UNKNOWN timeout (120s)';
        ord.updatedAt = Date.now();
        if (ord.side === 'BUY' && this.riskGovernor) {
          this.riskGovernor.releaseExposure(ord.clientOrderId);
        }
        this.saveOrdersToFile();
        console.log(`[OrderManager] 🔓 Force-released UNKNOWN order: ${ord.clientOrderId}`);
      }
    }, 4000);

    if (this.partialFillWatchTimer.unref) {
      this.partialFillWatchTimer.unref();
    }
  }

  public getWatchingOrderIdsCount(): number {
    return this.watchingOrderIds.size;
  }

  private loadOrdersFromFile() {
    try {
      if (fs.existsSync(ORDERS_FILE)) {
        const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
        const list: OrderRecord[] = JSON.parse(raw);
        const now = Date.now();
        list.forEach((ord) => {
          // If a pending/partially filled order is older than 5 minutes on file restore, mark as CANCELLED (finalized)
          if ((ord.status === 'PARTIALLY_FILLED' || ord.status === 'OPEN' || ord.status === 'ORDER_SUBMITTING' || ord.status === 'ORDER_SUBMITTED' || ord.status === 'UNKNOWN_PENDING_RECONCILIATION') && (now - ord.createdAt) > 300000) {
            ord.status = 'CANCELLED';
            ord.error = 'Finalized on startup restore (stale order cleanup)';
          }
          this.orders.set(ord.id, ord);
          if (ord.signalId) {
            this.processedSignalIds.add(ord.signalId);
          }
        });
        console.log(`[OrderManager] Restored ${this.orders.size} orders from history file (stale ghost orders cleaned).`);
      }
    } catch (e) {
      console.error('[OrderManager] Failed to load order history:', e);
    }
  }

  private saveOrdersToFile() {
    try {
      const dir = path.dirname(ORDERS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const list = Array.from(this.orders.values()).slice(-200);
      const tmpFile = ORDERS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), 'utf-8');
      fs.renameSync(tmpFile, ORDERS_FILE);
    } catch (e) {
      console.error('[OrderManager] Failed to save order history:', e);
    }
  }
}
