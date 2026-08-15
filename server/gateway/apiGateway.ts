/**
 * Centralized API Gateway & Priority Rate Limiter for Exchange REST Calls
 */

export interface QueuedTask<T> {
  id: string;
  priority: number; // 1 = Highest (Emergency), 2 = Orders, 3 = Balances, 4 = Price queries
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  retries: number;
  maxRetries: number;
  createdAt: number;
}

export class ApiGateway {
  private static instance: ApiGateway;
  private queue: QueuedTask<any>[] = [];
  private isProcessing = false;

  // Upbit Limit: 8 order requests/sec, 30 general requests/sec
  private minIntervalMs = 125; // 8 req/sec = 125ms interval
  private lastCallTime = 0;

  public static getInstance(): ApiGateway {
    if (!ApiGateway.instance) {
      ApiGateway.instance = new ApiGateway();
    }
    return ApiGateway.instance;
  }

  public enqueue<T>(
    priority: number,
    task: () => Promise<T>,
    maxRetries = 2
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const item: QueuedTask<T> = {
        id: Math.random().toString(36).substring(7),
        priority,
        task,
        resolve,
        reject,
        retries: 0,
        maxRetries,
        createdAt: Date.now()
      };

      this.queue.push(item);
      // Sort priority ascending (1 before 2, 2 before 3)
      this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastCallTime;
      if (elapsed < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
      }

      const item = this.queue.shift();
      if (!item) break;

      this.lastCallTime = Date.now();

      try {
        const result = await item.task();
        item.resolve(result);
      } catch (err: any) {
        if (item.retries < item.maxRetries) {
          item.retries += 1;
          const backoff = Math.min(1000 * Math.pow(2, item.retries) + Math.random() * 200, 5000);
          console.warn(`[ApiGateway] Request ${item.id} failed (${err.message}). Retrying in ${Math.round(backoff)}ms (Attempt ${item.retries}/${item.maxRetries})...`);
          await new Promise((r) => setTimeout(r, backoff));
          this.queue.unshift(item); // Re-insert at front of its priority
        } else {
          item.reject(err);
        }
      }
    }

    this.isProcessing = false;
  }
}
