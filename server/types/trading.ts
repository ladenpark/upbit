/**
 * Comprehensive Domain Types & State Models for Quantitative Trading Engine
 */

export type ExchangeType = 'UPBIT';

export type SignalType = 
  | 'ENTRY_BUY'
  | 'BREAKOUT_BUY'
  | 'MANUAL_ADD_BUY'
  | 'DCA_BUY'
  | 'PYRAMID_BUY'
  | 'BOX_PYRAMID_BUY'
  | 'REENTRY_BUY'
  | 'PARTIAL_LOSS_CUT'
  | 'EMERGENCY_TREND_CUT'
  | 'TRAILING_STOP_EXIT'
  | 'SCALP_TAKE_PROFIT'
  | 'SCALP_PARTIAL_TAKE_PROFIT'
  | 'ABSOLUTE_STOP_EXIT'
  | 'EMERGENCY_FULL_EXIT';

export type SignalPriority = 1 | 2 | 3 | 4 | 5 | 6; 
// 1 = EMERGENCY_FULL_EXIT, ABSOLUTE_STOP_EXIT (Highest)
// 2 = EMERGENCY_TREND_CUT, PARTIAL_LOSS_CUT
// 3 = TRAILING_STOP_EXIT, SCALP_TAKE_PROFIT
// 4 = REENTRY_BUY
// 5 = DCA_BUY
// 6 = ENTRY_BUY, BREAKOUT_BUY, PYRAMID_BUY, BOX_PYRAMID_BUY (Lowest)

export interface Signal {
  id: string;
  timestamp: number;
  timeframe: string; // e.g. '1m', 'tick'
  source: string; // e.g. 'ATR_STRATEGY_CORE'
  type: SignalType;
  priority: SignalPriority;
  symbol: string;
  price: number;
  reason: string;
  /** DCA 2차 접근 반등 매수처럼, 해당 DCA 슬롯 예산의 일부만 쓸 때의 비율 */
  dcaBudgetFraction?: number;
  /** 부분 집행 DCA 슬롯의 수명주기를 구분한다. */
  dcaExecution?: 'RECOVERY_PREBUY' | 'COMPLETE_REMAINDER';
  /** 상승 추세 불타기의 단계별 예산 비율(1차 0.50 Unit, 2차 0.35 Unit) */
  pyramidBudgetFraction?: number;
  indicatorSnapshot: {
    baseline: number;
    atr: number;
    upperBand: number;
    lowerBand: number;
    currentStopLoss: number;
    marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR';
    slope: number;
    volatilityRatio: number;
    dynamicOrderRatio: number;
    rsi?: number;
    volumeMultiplier?: number;
  };
}

export type OrderSide = 'BUY' | 'SELL';

export type OrderStatus = 
  | 'SIGNAL_CREATED'
  | 'ORDER_SUBMITTING'
  | 'ORDER_SUBMITTED'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'UNKNOWN_PENDING_RECONCILIATION'
  | 'UNKNOWN';

export const PROTECTIVE_SELL_SIGNALS: SignalType[] = [
  'ABSOLUTE_STOP_EXIT',
  'TRAILING_STOP_EXIT',
  'PARTIAL_LOSS_CUT',
  'EMERGENCY_TREND_CUT',
  'EMERGENCY_FULL_EXIT',
  'SCALP_TAKE_PROFIT',
  'SCALP_PARTIAL_TAKE_PROFIT'
];

export interface ExposureReservation {
  id: string;
  clientOrderId: string;
  amountKrw: number;
  createdAt: number;
  status: 'RESERVED' | 'COMMITTED' | 'RELEASED';
}

export interface OrderFill {
  id: string;
  timestamp: number;
  price: number;
  volume: number;
  fee: number;
}

export interface OrderRequest {
  clientOrderId: string; // Idempotency key
  signalId: string;
  signalType?: SignalType;
  symbol: string;
  side: OrderSide;
  requestedAmountKrw?: number; // for Market BUY on Upbit
  requestedVolume?: number; // for Market SELL on Upbit
  limitPrice?: number; // Safety limit price for SELL to prevent slippage
  reason: string;
  createdAt: number;
}

export interface OrderRecord {
  id: string;
  clientOrderId: string;
  signalId: string;
  signalType?: SignalType;
  exchangeOrderId?: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  requestedBudgetOrVolume: number;
  filledVolume: number;
  avgFillPrice: number;
  fee: number;
  createdAt: number;
  updatedAt: number;
  reason: string;
  error?: string;
  fills: OrderFill[];
}

export type PositionState = 
  | 'FLAT'
  | 'ENTRY_PENDING'
  | 'ENTRY_FILLED'
  | 'DCA_MODE'
  | 'DEFENSIVE'
  | 'DEFENSIVE_1'
  | 'DEFENSIVE_2'
  | 'EMERGENCY_EXIT'
  | 'COOLDOWN'
  | 'REENTRY_WAIT'
  | 'REENTRY_ALLOWED'
  | 'REENTRY_PENDING'
  | 'TAKE_PROFIT'
  | 'CLOSED'
  | 'ERROR'
  | 'HALTED';

export interface PositionSnapshot {
  id: string;
  symbol: string;
  state: PositionState;
  amount: number;
  entryPrice: number | null;
  positionEntryAtr: number | null;
  initialStopPrice: number | null;
  initialBaseline: number | null;
  initialBand: number | null;
  totalCostKrw: number;
  realizedPnl: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  openedAt: number | null;
  lastUpdatedAt: number;
  // DCA Slots Lifecycle
  dcaSlots: {
    slotNumber: number;
    status: 'AVAILABLE' | 'RESERVED' | 'ORDER_PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'DISABLED';
    filledPrice?: number;
    filledVolume?: number;
    filledAt?: number;
    /** DCA 2차 접근 반등 선매수 후에도 유지할 원래의 -4.2% 잔여 집행 가격 */
    plannedTargetPrice?: number;
  }[];
  pyramidingCount: number;
  maxPyramidingOrders: number;
  boxPyramidCount: number;
  partialCutCount?: number;
  // Trailing Take Profit State
  trailingActive: boolean;
  trailingPeakPrice: number | null;
  trailingExitCount?: number;
  /** 불타기 1차 후 전체 평단의 수수료 포함 본전 이상을 지키는 보호 가격 */
  profitLockPrice?: number | null;
  // Cooldown
  cooldownUntil: number;
  cooldownReason?: string;
}

export type BotLifecycleState = 
  | 'RUNNING'
  | 'PAUSED'
  | 'HALTED'
  | 'ERROR'
  | 'RECONNECTING';

export type MarketDataState = 
  | 'LIVE'
  | 'STALE'
  | 'DISCONNECTED'
  | 'RECONNECTING';

export interface ExposureLimits {
  totalCapitalKrw: number;
  maxExposureRatio: number; // 0.0 ~ 1.0 (e.g. 0.85 = Max 85% in coin)
  maxPositionAmountKrw: number;
  currentExposureKrw: number;
  pendingExposureKrw: number;
  remainingAllowableExposureKrw: number;
}

export interface AdaptiveIndicators {
  dynamicAtr: number;
  dynamicOrderRatio: number;
  dynamicDcaStep: number;
  dynamicTrailingCallback: number;
  dynamicScalpBandMultiplier: number;
  dynamicScalpTakeProfitPercent: number;
  marketRegime: 'BULL' | 'SIDEWAYS' | 'BEAR';
  slope: number;
  volatilityRatio: number;
  rsi: number;
  volumeMultiplier: number;
  volumeMa: number;
}

export interface NextOrderItem {
  category: 'DIP' | 'BREAKOUT' | 'DCA' | 'PYRAMID' | 'COMPLETED' | 'SCALP_DIP' | 'SCALP_BREAKOUT' | 'SCALP_TP' | 'TRAILING_TP';
  categoryLabel: string;
  type: string;
  budgetKrw: number;
  unitPercent: number;
  scaleMultiplier: number;
  targetPriceLabel: string;
  targetPrice?: number;
  themeColor: 'indigo' | 'emerald' | 'amber' | 'blue' | 'cyan' | 'purple' | 'rose' | 'teal';
}

export interface NextOrderInfo {
  type: string;
  budgetKrw: number;
  unitPercent: number;
  scaleMultiplier: number;
  targetPriceLabel: string;
  pages: NextOrderItem[];
}

export interface TradeLog {
  id: string;
  time: string;
  timestamp: number;
  type: 'BUY' | 'SELL' | 'STOP_LOSS' | 'SYSTEM';
  price: number;
  reason: string;
  amount?: number;
  pnl?: number;
  pnlPercent?: number;
  exchange?: string;
  orderId?: string;
  clientOrderId?: string;
  positionState?: PositionState;
}

export interface PricePoint {
  time: number;
  timeLabel: string;
  price: number;
  upperBand: number;
  baseline: number;
  lowerBand: number;
  stopLoss: number;
  rsi?: number;
  volume?: number;
  event?: 'BUY' | 'SELL' | 'STOP_LOSS';
}

export interface BotParams {
  atrMultiplier: number;
  orderRatio: number;
  stopLossMultiplier: number;
  isBotActive: boolean;
  exchange: ExchangeType;
  symbol: string;
  // Global Exposure Limit (%)
  maxExposurePercent: number; // e.g. 85%
  // DCA (물타기) 파라미터
  dcaEnabled: boolean;
  maxSafetyOrders: number;
  safetyOrderStepPercent: number;
  safetyOrderVolumeScale: number;
  // Trailing Take-Profit (트레일링 익절) 파라미터
  trailingStopEnabled: boolean;
  trailingCallbackPercent: number;
  // Pyramiding (상승 불타기) 파라미터
  pyramidingEnabled: boolean;
  maxPyramidingOrders: number;
  pyramidingStepPercent: number;
  // Partial Loss-Cut & Cash Recycling (자금순환 부분손절) 파라미터
  partialLossCutEnabled: boolean;
  partialLossCutPercent: number;
  partialLossCutThreshold: number;
  // Trend-Aware Predictive Loss-Cut & Bottom Re-entry
  trendAwareCutEnabled: boolean;
  trendDropSpeedThreshold: number; // 하락 속도 임계값 (%)
  trendDropWindowSeconds: number; // 급락 계산 기준 시간창(초), 기본 5초
  cooldownSecondsAfterCut: number; // 손절/청산 후 쿨다운 시간(초), 기본 60초
  // AI Auto-Pilot (시장 국면 자동 감지 및 자산 배분)
  autoPilotEnabled: boolean;
  // Breakout Entry (상승 추세 돌파 매수)
  breakoutEntryEnabled?: boolean;
  // Dry-Run Mode (실제 API 미호출, 시뮬레이션 전용)
  dryRunMode?: boolean;
  // Daily Maximum Loss Limit (일일 최대 손실 한도, 기본 5%)
  dailyMaxLossPercent?: number;
  // Strategy Lab — all experiments default to OFF and are only configurable while paused.
  experimentDca2RsiRecoveryEnabled: boolean;
  experimentDca2VolumeConfirmationEnabled: boolean;
  experimentPyramidRsiGuardEnabled: boolean;
  experimentPyramidVolumeConfirmationEnabled: boolean;
  experimentScalpTrendExpansionEnabled: boolean;
  experimentScalpReentryCooldownEnabled: boolean;
  experimentTrendTrailingArmingEnabled: boolean;
}

export interface ApiKeys {
  upbitAccessKey?: string;
  upbitSecretKey?: string;
}

export interface MaskedApiKeys {
  hasUpbitKeys: boolean;
  upbitAccessMasked?: string;
}
