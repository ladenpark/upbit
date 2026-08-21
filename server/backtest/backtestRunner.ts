import path from 'path';
import fs from 'fs';

import { ATREngine } from '../strategy/atrEngine';
import { MockUpbit } from '../exchanges/mockUpbit';
import { BotParams } from '../types/trading';

async function runBacktest() {
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  console.log(`[Backtest] Starting local backtest framework...`);
  console.log(`[Backtest] Working directory: ${process.cwd()}`);

  const currentHistoryFile = path.join(process.cwd(), 'data', 'history_eth.json');
  const legacyHistoryFile = path.join(process.cwd(), '../history_eth.json');
  const historyFile = fs.existsSync(currentHistoryFile) ? currentHistoryFile : legacyHistoryFile;
  if (!fs.existsSync(historyFile)) {
    console.error(`[Backtest] Error: ${historyFile} not found. Please run downloadHistory.ts first.`);
    process.exit(1);
  }

  console.log(`[Backtest] Loading historical data...`);
  const rawData = fs.readFileSync(historyFile, 'utf-8');
  const allCandles: any[] = JSON.parse(rawData);
  console.log(`[Backtest] Loaded total ${allCandles.length} candles from file.`);

  const daysArg = process.argv[2];
  const days = daysArg ? parseInt(daysArg, 10) : 180;
  const targetCandleCount = days * 24 * 60;
  
  const candles = allCandles.length > targetCandleCount 
    ? allCandles.slice(allCandles.length - targetCandleCount) 
    : allCandles;
  
  console.log(`[Backtest] Simulating for the last ${days} days (${candles.length} candles).`);

  // 2. ATREngine 인스턴스화
  const requestedExperiments = new Set(
    (process.env.BACKTEST_EXPERIMENTS || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const experimentParamMap = {
    dca2Rsi: 'experimentDca2RsiRecoveryEnabled',
    dca2Volume: 'experimentDca2VolumeConfirmationEnabled',
    pyramidRsi: 'experimentPyramidRsiGuardEnabled',
    pyramidVolume: 'experimentPyramidVolumeConfirmationEnabled',
    scalpExpansion: 'experimentScalpTrendExpansionEnabled',
    scalpCooldown: 'experimentScalpReentryCooldownEnabled',
    trendTrailingArm: 'experimentTrendTrailingArmingEnabled'
  } as const;
  const unknownExperiments = [...requestedExperiments].filter((name) => !(name in experimentParamMap));
  if (unknownExperiments.length > 0) {
    throw new Error(`Unknown BACKTEST_EXPERIMENTS value: ${unknownExperiments.join(', ')}`);
  }

  const params: any = {
    isBotActive: true,
    autoPilotEnabled: true,
    symbol: 'KRW-ETH',
    exchange: 'UPBIT',
    dcaEnabled: true,
    trailingStopEnabled: true,
    trendAwareCutEnabled: true,
    partialLossCutEnabled: true,
    pyramidingEnabled: true,
    breakoutEntryEnabled: true,
    atrMultiplier: 2.0,
    stopLossMultiplier: 3.5,
    orderRatio: 20,
    safetyOrderStepPercent: 2.0,
    trailingCallbackPercent: 1.0,
    partialLossCutThreshold: 4.5,
    partialLossCutPercent: 40,
    trendDropSpeedThreshold: 1.8,
    pyramidingStepPercent: 1.5,
    maxPyramidingOrders: 2,
    dryRunMode: false,
    experimentDca2RsiRecoveryEnabled: requestedExperiments.has('dca2Rsi'),
    experimentDca2VolumeConfirmationEnabled: requestedExperiments.has('dca2Volume'),
    experimentPyramidRsiGuardEnabled: requestedExperiments.has('pyramidRsi'),
    experimentPyramidVolumeConfirmationEnabled: requestedExperiments.has('pyramidVolume'),
    experimentScalpTrendExpansionEnabled: requestedExperiments.has('scalpExpansion'),
    experimentScalpReentryCooldownEnabled: requestedExperiments.has('scalpCooldown'),
    experimentTrendTrailingArmingEnabled: requestedExperiments.has('trendTrailingArm')
  };
  console.log(`[Backtest] Strategy Lab: ${requestedExperiments.size ? [...requestedExperiments].join(', ') : 'baseline (all OFF)'}`);

  // 엔진 생성 시점에 초기 ATR 계산이 될 수 있도록 과거 200개 캔들 세팅
  const startIndex = allCandles.length - candles.length;
  MockUpbit.recentCandles = allCandles.slice(Math.max(0, startIndex - 200), startIndex);

  // ATREngine is shared with live trading and normally logs every rejected
  // signal. Suppress per-tick noise during a simulation; the final report is
  // restored below. Set BACKTEST_VERBOSE=1 when investigating a single run.
  const isVerbose = process.env.BACKTEST_VERBOSE === '1';
  if (!isVerbose) {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
  }

  const engine = new ATREngine(() => {}, { backtest: true });
  engine.updateParams(params);

  // 3. 의존성 주입(Dependency Injection) - MockUpbit 덮어씌우기
  const mockUpbit = new MockUpbit();
  (engine as any).upbitClient = mockUpbit;
  (engine as any).orderManager.upbitClient = mockUpbit;
  
  // API 키 조회 모킹 (MockUpbit이 정상 작동하도록)
  (engine as any).secretManager = {
    getKeys: () => ({ upbitAccessKey: 'mock', upbitSecretKey: 'mock' }),
    getMaskedStatus: () => ({ upbitAccessKey: 'mock...', upbitSecretKey: 'mock...' })
  };

  // 초기 자본 설정 (1000만원)
  MockUpbit.mockKrwBalance = 10000000;
  MockUpbit.mockCoinBalance = 0;
  
  let peakCapital = 10000000;
  let maxDrawdown = 0;

  // 마켓 매니저 상태를 LIVE로 강제 지정하여 위험 관리 게이트 통과 허용
  (engine as any).marketManager.setMarketState('LIVE');
  
  // 초기 예수금 동기화
  engine.actualKrwBalance = MockUpbit.mockKrwBalance;

  // Rejection-level logging is opt-in; emitting it for every simulated tick
  // obscures the report and makes multi-scenario comparisons impractical.
  if (process.env.BACKTEST_DEBUG_REJECTIONS === '1') {
    const originalEvaluate = (engine as any).riskGovernor.evaluateSignal;
    (engine as any).riskGovernor.evaluateSignal = function(...args: any[]) {
      const result = originalEvaluate.apply(this, args);
      if (!result.approved) console.log(`[Backtest Debug] Signal ${args[0].type} rejected: ${result.rejectionReason || result.reason}`);
      return result;
    };
  }

  console.log(`[Backtest] Commencing simulation loop...`);
  
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    
    // 진행률 표시
    if (i % 1000 === 0) {
      process.stdout.write(`\r[Backtest] Processing candle ${i} / ${candles.length} (${((i/candles.length)*100).toFixed(2)}%)`);
    }

    // MockUpbit 최신 캔들 주입 (최대 과거 200개)
    // backtestRunner에서는 allCandles를 기준으로 인덱스를 찾아 200개를 슬라이스합니다.
    const allIndex = allCandles.length - candles.length + i;
    MockUpbit.recentCandles = allCandles.slice(Math.max(0, allIndex - 200), allIndex + 1);

    // 1분봉 캔들을 4개의 틱으로 세분화하여 엔진에 주입 (시가 -> 고가 -> 저가 -> 종가)
    const ticks = [
      candle.opening_price,
      candle.high_price,
      candle.low_price,
      candle.trade_price
    ];

    const baseTimestamp = candle.timestamp;
    let tickOffset = 0;

    for (const price of ticks) {
      // MockUpbit 현재가 갱신
      MockUpbit.currentPrice = price;
      
      // 엔진 틱 주입
      await engine.handleMarketTick(price, baseTimestamp + tickOffset);
      
      // 실제 환경에서는 15초마다 비동기로 실행되나, 
      // 백테스트에서는 동기적으로 호출하여 ATR/Baseline을 최신으로 갱신
      if (tickOffset === 0) { // 1분(캔들)마다 1회
        await engine.refreshAtrFromExchange();
        engine.actualKrwBalance = MockUpbit.mockKrwBalance;
      }

      tickOffset += 15000; // 15초 간격 시뮬레이션

      // MDD 계산을 위한 자본금 추적
      const currentCapital = MockUpbit.mockKrwBalance + (MockUpbit.mockCoinBalance * price);
      if (currentCapital > peakCapital) {
        peakCapital = currentCapital;
      }
      const drawdown = ((peakCapital - currentCapital) / peakCapital) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  if (!isVerbose) {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }

  console.log(`\n[Backtest] Simulation complete.`);

  // 4. 결과 리포팅
  const finalPrice = MockUpbit.currentPrice;
  const finalCapital = MockUpbit.mockKrwBalance + (MockUpbit.mockCoinBalance * finalPrice);
  const totalReturn = ((finalCapital - 10000000) / 10000000) * 100;

  // 거래 내역 분석
  const allOrders = engine.orderManager.getAllOrders();
  const filledOrders = allOrders.filter(o => o.status === 'FILLED');
  const buyOrders = filledOrders.filter(o => o.side === 'BUY');
  const sellOrders = filledOrders.filter(o => o.side === 'SELL');
  const totalFees = filledOrders.reduce((acc, o) => acc + (o.fee || 0), 0);

  console.log(`\n=================================================`);
  console.log(`📊 [백테스트 성과 리포트]`);
  console.log(`=================================================`);
  console.log(`🔹 테스트 기간: ${candles.length} 분 (약 ${(candles.length / 60 / 24).toFixed(1)} 일)`);
  console.log(`🔹 초기 자본: ₩10,000,000`);
  console.log(`🔹 최종 자본: ₩${Math.round(finalCapital).toLocaleString()} (총 수익률: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%)`);
  console.log(`🔹 최대 낙폭(MDD): -${maxDrawdown.toFixed(2)}%`);
  console.log(`🔹 총 지불 수수료: ₩${Math.round(totalFees).toLocaleString()}`);
  console.log(`-------------------------------------------------`);
  console.log(`🔹 총 체결 주문 수: ${filledOrders.length} 회`);
  console.log(`   - 매수(BUY): ${buyOrders.length} 회`);
  console.log(`   - 매도(SELL): ${sellOrders.length} 회`);
  console.log(`=================================================\n`);
  
  process.exit(0);
}

runBacktest().catch(console.error);
