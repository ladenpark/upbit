import fs from 'fs';
import path from 'path';
import https from 'https';

const MARKET = 'KRW-ETH';
// CLI argument for target days (default 180)
const TARGET_DAYS = parseInt(process.argv[2] || '180', 10);
const TARGET_CANDLES = TARGET_DAYS * 24 * 60;
const BATCH_SIZE = 200;
const DATA_FILE = path.join(process.cwd(), 'data/history_eth.json');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fetchCandles(to?: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    let url = `https://api.upbit.com/v1/candles/minutes/1?market=${MARKET}&count=${BATCH_SIZE}`;
    if (to) {
      url += `&to=${encodeURIComponent(to)}`;
    }

    const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`API Error: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log(`[downloadHistory] Starting download for ${TARGET_CANDLES} candles of ${MARKET}...`);
  
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const allCandles: any[] = [];
  let toParam: string | undefined = undefined;

  for (let i = 0; i < TARGET_CANDLES; i += BATCH_SIZE) {
    try {
      const candles = await fetchCandles(toParam);
      if (candles.length === 0) {
        console.log(`[downloadHistory] No more data returned. Stopping.`);
        break;
      }

      allCandles.push(...candles);
      
      const lastCandle = candles[candles.length - 1];
      toParam = lastCandle.candle_date_time_utc + 'Z';

      const progress = ((allCandles.length / TARGET_CANDLES) * 100).toFixed(2);
      process.stdout.write(`\r[downloadHistory] Downloaded ${allCandles.length} candles (${progress}%)`);

      if (candles.length < BATCH_SIZE) {
        // Reached the end of available history
        break;
      }

      // Upbit API Rate limit (10 / sec) defense
      await sleep(150);
    } catch (e: any) {
      console.error(`\n[downloadHistory] Error fetching data: ${e.message}`);
      console.log(`Waiting 5 seconds before retrying...`);
      await sleep(5000);
      i -= BATCH_SIZE; // Retry the same batch
    }
  }

  console.log(`\n[downloadHistory] Download complete. Sorting and saving to file...`);
  // Upbit returns data in descending order (newest first). 
  // Backtest needs ascending order (oldest first).
  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  fs.writeFileSync(DATA_FILE, JSON.stringify(allCandles, null, 2), 'utf-8');
  console.log(`[downloadHistory] Saved ${allCandles.length} candles to ${DATA_FILE}.`);
}

main().catch(console.error);
