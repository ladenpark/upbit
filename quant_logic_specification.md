# Upbit ATR AutoPilot Quant Engine: Architecture & Logic Specification

**Target Asset**: Upbit KRW-ETH (Spot Trading)  
**Core Framework**: TypeScript, Node.js (PM2 Cluster), React/Vite, Upbit Open API (REST & WebSocket)  
**Validation**: Automated Assertions (Custom Test Suite, `tradingEngine.test.ts`)

---

## 1. 시스템 전체 아키텍처 개요 (System Architecture)

- **데이터 파이프라인**: 
  - Upbit WebSocket 실시간 체결가 및 1분봉/15분봉 캔들 수신.
  - **워치독(Watchdog)**: 8초 이상 체결이 없으면 Upbit REST API(`/v1/ticker`)로 백업 폴링, 20초 이상 무응답 시 웹소켓 자동 재연결.
- **포지션 동기화 (Exchange Reconciliation)**:
  - Upbit 계좌 API(`/v1/accounts`)의 `avg_buy_price`(실제 매수 평단가)를 파싱하여 엔진의 `entryPrice`와 1원 단위까지 100% 일치 동기화.
  - **더스트(Dust) 잔여 수량 방어**: 실제 코인 보유 수량이 0.0001 미만일 경우 포지션을 `FLAT`(무포지션)으로 간주하여 잔여 더스트로 인한 신규 진입 차단 현상 방지.
  - 체결 직후 발생하는 업비트의 잔고 갱신 지연(Eventual Consistency)을 방어하기 위해, 잔고 동기화를 디바운싱 기반 1.5초(1500ms) 지연 비동기 실행.
- **상태 영속성 및 동시성 제어 (State Persistence)**:
  - PM2 다중 프로세스 환경 및 비동기 겹침 시 파일 무결성을 보장하기 위해 `.tmp` 파일 및 `fs.renameSync`를 활용한 원자적 쓰기(Atomic Write) 적용.
- **밴드 계산의 일관성 (Band Synchronization)**:
  - `handleMarketTick()` 시점에 `evaluateAdaptiveParams()`를 최우선 선행 계산하여, 트레일링 무장(`updateTrailingState`)과 재진입 게이트(`price > lowerBand`)에 전달되는 밴드 값과 전략 코어 내부 신호 판정용 밴드(`effectiveMultiplier = autoPilotEnabled ? adaptive.dynamicAtr : params.atrMultiplier`)가 100% 일치하도록 보장.

---

## 2. 시장 국면 분류 및 이중 타임프레임(MTF) 적응형 파라미터

### 2.1 시장 국면(Regime) 판정 로직
1분봉 20개 선형 회귀 기울기(`slope`), 캔들 변동성 비율(`volatilityRatio`), 15분봉 상위 타임프레임 EMA 추세(`higherTfTrend`)를 결합하여 3대 국면을 판정합니다.

1. **상승장 (BULL)**: 
   - `slope > 0.10` AND `(현재가 - Baseline) / Baseline > +0.05%` AND `15분봉 추세가 BEAR가 아님`
2. **하락장 (BEAR)**: 
   - `slope < -0.10` AND `(현재가 - Baseline) / Baseline < -0.05%` AND `15분봉 추세가 BULL이 아님`
3. **횡보장 (SIDEWAYS)**: 
   - 위 조건 외 모든 구간

### 2.2 오토파일럿(AutoPilot) 동적 파라미터 매트릭스

| 시장 국면 (Market Regime) | 밴드 승수 (`dynamicAtr`) | DCA 간격 (`dynamicDcaStep`) | 1차 진입 비중 (`dynamicOrderRatio`) | 스캘핑 진입 밴드 배율 (`dynamicScalpBandMultiplier`) |
|---|---|---|---|---|
| **상승장 (BULL)** | **1.8** (기회 포착 확대) | **1.5%** (빠른 회전) | **20.0%** (적극 진입) | **1.0** (돌파 우선) |
| **횡보장 (SIDEWAYS)** | **2.4** (노이즈 필터링) | **2.0%** (표준 분할) | **18.0%** (안정적 진입) | **1.0** (완전한 박스권 채널 확보) |
| **하락장 (BEAR)** | **3.5** (돌파 엄격화) | **3.0%** (낙폭 확대 방어) | **10.0%** (현금 보존 축소) | **1.4** (역추세 진입 억제) |

**변동성 기반 동적 파라미터 & 최소 ATR 바닥값 (Minimum ATR Floor)**:
- **최소 유효 ATR 바닥값 (`minAtrFloor`)**:
  - 초저변동성 구간에서의 호가 단위 갇힘(Tick-Size Trap)을 방지하기 위해 `Math.max(5000, 현재가 * 0.0025)`를 적용하여 최소 5~8호가의 안정적인 스캘핑 버퍼를 확보합니다.
- **트레일링 콜백 (`dynamicTrailingCallback`)**:
  - 기본: **0.8%** (`volatilityRatio <= 2.0`)
  - 고변동성: **1.2%** (`volatilityRatio > 2.0`)
- **박스권 스캘핑 목표 수익률 (`dynamicScalpTakeProfitPercent`)**:
  - 기본: **+0.50%** (수수료 0.10% 차감 후 순수익 **+0.40%** 즉시 실현, `volatilityRatio <= 2.0`)
  - 고변동성: **+0.80%** (수수료 제외 순수익 **+0.70%** 실현, `volatilityRatio > 2.0`)

---

## 3. 신호 생성 엔진 및 규칙 우선순위 (ATRStrategyCore)

동일 틱(Tick)에서 복수의 조건이 충족될 경우, **엄격한 우선순위(Priority 1 -> 6)에 따른 단일 신호 방출(Early Return)**로 상충을 원천 차단합니다.

**[안전 지정가 래핑 (Slippage Defense)]**
- 모든 보호성 매도 신호(손절, 부분 익절, 스캘핑 익절, 긴급 청산 등)는 시장가 매도로 인한 막대한 슬리피지를 방지하기 위해, 현재가 대비 **-1.5% 수준의 하한가**를 계산하여 **지정가(limit)** 주문으로 제출합니다.
- 계산된 하한가는 업비트의 원화 마켓 호가 단위 규격(Tick Size)에 맞게 정밀하게 내림 처리(`roundDownToTick`)되어 API 에러(`invalid_price_tick`)를 방지합니다.

### 3.1 신호별 우선순위 및 세부 규칙

```
Priority 1: ABSOLUTE_STOP_EXIT          (절대 손절선 이탈 -> 100% 전량 청산)
Priority 2: EMERGENCY_TREND_CUT         (플래시 크래시 선제 40% 조기 손절)
Priority 2: PARTIAL_LOSS_CUT            (자금순환 40% 분할 손절)
Priority 3: SCALP_TAKE_PROFIT          (박스권 짤짤이 목표 도달 -> 100% 전량 익절)
Priority 3: TRAILING_STOP_EXIT          (트레일링 50% 분할 익절 & 더스트가드)
Priority 4: REENTRY_BUY                 (바닥 스마트 재매수)
Priority 5: DCA_BUY                     (마틴게일 분할 물타기)
Priority 6: PYRAMID_BUY                 (상승장 불타기)
Priority 6: ENTRY_BUY (Rule 8)          (1차 저점 하단밴드 과매도 반등 매수)
Priority 6: ENTRY_BUY (Rule 8-b)        (박스권 하단 스캘핑 매수 - 예산 50%)
Priority 6: BREAKOUT_BUY (Rule 9)       (1차 상승 모멘텀 돌파 매수)
Priority 6: BREAKOUT_BUY (Rule 9-b)     (박스권 상단 스캘핑 매수 - 예산 50%)
```

- **Priority 1: ABSOLUTE_STOP_EXIT (정적 손절선 이탈 -> 100% 전량 청산)**
  - 발동 조건: `hasPosition` AND `현재가 <= position.initialStopPrice` (진입 시 확정 스냅샷된 손절선)
  - 실행: 보유 코인 100% 전량 지정가 매도.

- **Priority 2: EMERGENCY_TREND_CUT (플래시 크래시 방어)**
  - 발동 조건: `hasPosition` AND `params.trendAwareCutEnabled` AND `현재가 < lowerBand` AND 최근 3초 내 낙폭 속도(`dropSpeed`)가 -1.8% 이하 급락.
  - 실행: 보유 수량의 40% 선제 손절 후 포지션 상태를 `EMERGENCY_EXIT`으로 전환.

- **Priority 2: PARTIAL_LOSS_CUT (자금순환 부분 손절)**
  - 발동 조건: `hasPosition` AND `params.partialLossCutEnabled` AND `pnlPercent <= -4.5%` AND 포지션 상태가 `DEFENSIVE`/`EMERGENCY_EXIT`이 아님.
  - 실행: 보유 수량의 40% 분할 손절 후 포지션 상태를 `DEFENSIVE`로 전환.

- **Priority 3: SCALP_TAKE_PROFIT (박스권 짤짤이 전량 익절)**
  - 발동 조건: `hasPosition` AND `params.autoPilotEnabled` AND `adaptive.marketRegime === 'SIDEWAYS'` AND `!position.trailingActive` AND `pnlPercent >= adaptive.dynamicScalpTakeProfitPercent` (+0.5% ~ +0.8%)
  - 실행: 보유 코인 **100% 전량 매도**.
  - 체결 후 동작: 포지션 `FLAT` 복귀, 30초 쿨다운 적용 (봇 정지 `HALTED` 없음). 30초 후 가격 재등락 시 자동 재진입 사이클 가동.

- **Priority 3: TRAILING_STOP_EXIT (50% 반복 부분 익절 & 더스트 가드 & Profit Lock Gate)**
  - **무장(Arm)**: `현재가 >= Baseline + (ATR * Multiplier)` AND **`현재가 > 진입 평단가` (Profit Lock-in Gate)** 도달 시 트레일링 활성화 (`trailingActive = true`), 최고가(`trailingPeakPrice`) 실시간 갱신.
  - **발동 조건**: `(최고가 - 현재가) / 최고가 >= dynamicTrailingCallback` (되돌림 발생) AND **`현재가 > 진입 평단가` (수익 보장 Gate, pnlPercent >= +0.1%)**.
  - **원금 보존 보장**: 최고점에서 되돌림이 발생하더라도 현재가가 평단가 이하로 내려가면 트레일링 익절로 매도되지 않음 (손실 매도 방지).
  - **실행**:
    - 보유 수량의 **50% 부분 매도**.
    - 매도 후 남는 잔여 가치가 **10,000원 미만(Dust Guard)**인 경우 **100% 전량 매도로 자동 전환**.
    - 부분 매도 체결 즉시 `trailingActive = false`, `trailingPeakPrice = null`로 무장 해제 -> 다음 익절을 위해서는 상단 밴드를 다시 뚫는 새로운 신고가 형성 요구.

- **Priority 4: REENTRY_BUY (스마트 바닥 재진입)**
  - 발동 조건: 포지션 상태가 `REENTRY_ALLOWED` (DEFENSIVE/EMERGENCY_EXIT 상태에서 급락 진정 `dropSpeed >= -0.3%` 및 `현재가 > lowerBand` 확인 시 전환).
  - 실행: 세이브된 현금으로 최저점 재진입.

- **Priority 5: Smart DCA Buy (마틴게일 분할 물타기)**
  - 발동 조건: `hasPosition` AND `params.dcaEnabled` AND `평단 대비 하락률 >= dynamicDcaStep * SlotNumber` (최대 3회: 1차, 2차, 3차).
  - 수량 스케일: `1.2 ^ SlotNumber` (1차 1.2배, 2차 1.44배, 3차 1.728배).

- **Priority 6: Pyramiding Buy (대세 상승장 불타기)**
  - 발동 조건: `hasPosition` AND `params.pyramidingEnabled` AND `수익률 >= 1.5% * (pyramidingCount + 1)` AND `adaptive.marketRegime === 'BULL'` (최대 2회).
  - 특징: 대세 상승장(`BULL`) 국면에서만 허용 (`SIDEWAYS`나 `BEAR`에서는 엄격 차단).

- **Priority 6: 1차 진입 4대 규칙 (FLAT 상태)**
  1. **Rule 8 (ENTRY_BUY - 하단 밴드 과매도 진입)**: `현재가 <= lowerBand`
  2. **Rule 8-b (ENTRY_BUY - 박스권 하단 스캘핑 진입)**: `autoPilotEnabled` AND `regime !== 'BULL'` AND `현재가 <= Baseline - (ATR * dynamicScalpBandMultiplier)` AND `현재가 > lowerBand` (예산 50% 축소)
  3. **Rule 9 (BREAKOUT_BUY - 상승 모멘텀 돌파 진입)**: `현재가 > Baseline` AND (`marketRegime === 'BULL'` OR `slope >= 0.10`)
  4. **Rule 9-b (BREAKOUT_BUY - 박스권 상단 스캘핑 진입)**: `autoPilotEnabled` AND `regime === 'SIDEWAYS'` AND `현재가 > Baseline` AND `현재가 <= Baseline + (ATR * dynamicScalpBandMultiplier)` (예산 50% 축소)

---

## 4. 박스권(SIDEWAYS) 스캘핑 순환 사이클 & 국면 자동 전환 메커니즘

### 4.1 박스권 내 매매 사이클 (반복 순환)
1. **진입 (Entry)**:
   - 기준선 하단 소폭 눌림 (`Baseline - ATR*0.8`) -> **Rule 8-b** 발동 (예산 50%)
   - 기준선 상단 소폭 돌파 (`Baseline ~ Baseline + ATR*0.8`) -> **Rule 9-b** 발동 (예산 50%)
2. **익절 (Take Profit)**:
   - 목표 수익률 (+0.5% ~ +0.8%) 도달 시 **Rule 3-b (`SCALP_TAKE_PROFIT`)** 발동 -> 100% 전량 매도
3. **재진입 (Re-entry)**:
   - 체결 즉시 포지션 `FLAT` 복귀 및 30초 쿨다운 적용
   - 30초 후 가격이 다시 스캘핑 밴드에 닿으면 Rule 8-b / 9-b에 의해 별도 추가 로직 없이 자동으로 다음 사이클 시작

### 4.2 대세 상승장(BULL) 전환 시 자연스러운 인수인계
- 시장 국면이 `SIDEWAYS`에서 `BULL`로 전환되면 `marketRegime === 'SIDEWAYS'` 게이트에 의해 **Rule 3-b(짤짤이 전량 익절)가 자동으로 비활성화**됩니다.
- 포지션을 조기 매도하지 않고 유지하면서, **Rule 4(트레일링 50% 부분 익절)** 및 **Rule 7(불타기 `PYRAMID_BUY`)**가 추세 추종을 이어받아 대세 상승 파동의 수익을 극대화합니다.

---

## 5. 글로벌 리스크 관리 거버넌스 (GlobalRiskGovernor)

모든 생성된 신호는 거래소 발주 전 5단계 사전 필터 및 자산 배분(Sizing) 알고리즘을 통과해야 합니다.

### 5.1 5단계 사전 검증 게이트
1. **Gate 0 (Circuit Breaker)**: 일일 누적 실현 손실이 일일 한도(`dailyMaxLossPercent`, 기본 5%) 초과 시 신규 매수 차단, 보호성 매도만 허용.
2. **Gate 1 (Bot Lifecycle)**: 봇 상태가 `RUNNING`인지 검증 (`HALTED`/`PAUSED` 시 긴급 청산 외 거부).
3. **Gate 2 (Market Data Stale)**: 웹소켓 끊김/데이터 지연 시 매수 신호 원천 차단 (보호성 매도는 허용).
4. **Gate 3 (Order Collision)**:
   - 매수 신호: 미체결 주문 대기 중이거나 자본 예약(`reservedBuyExposureKrw`) 존재 시 엄격 차단.
   - 보호성 매도(`PROTECTIVE_SELL_SIGNALS` 6종): Pending BUY가 있어도 즉시 승인, 단 동일한 매도 주문의 중복 발주는 차단.
5. **Gate 4 (Cooldown Guard)**: 손절/청산 발생 후 30~60초간 재진입 냉각기 부여 (`ABSOLUTE_STOP_EXIT`, `EMERGENCY_FULL_EXIT` 제외).

### 5.2 자산 배분(Sizing) 및 3중 철통 클램프 (Clamping)

1. **총 자산(Total Capital)** = `가용 KRW 잔여액 + (보유 코인 수량 * 현재가)`
2. **적용 주문 비율(Effective Order Ratio)** = 
   - AutoPilot ON인 경우: 신호의 국면별 `dynamicOrderRatio` (BULL 20%, SIDEWAYS 18%, BEAR 10%)
   - AutoPilot OFF인 경우: 사용자 수동 설정값 `params.orderRatio` (기본 20%)
3. **목표 주문 예산(Target Budget)** = 
   - 일반 매수 (Rule 8, Rule 9): `Total Capital * Effective Order Ratio`
   - 박스권 스캘핑 매수 (Rule 8-b, Rule 9-b): `(Total Capital * Effective Order Ratio) * 0.5` (50% 축소)
   - DCA 물타기: `Total Capital * Effective Order Ratio * (1.2 ^ slot)`
4. **최종 주문 예산(Final Budget)** = `min(Target Budget, 가용 KRW 잔여액 * 0.98, 글로벌 잔여 노출 한도)`
5. **글로벌 최대 포지션 노출 한도**: 총 자산의 **최대 85%**를 절대 초과할 수 없음.
   - *수학적 정합성*: 1차 20% + DCA 1차(24%) + DCA 2차(28.8%) = **총 72.8%**로 85% 한도 내에서 100% 매끄럽게 체결 보장.

---

## 6. 포지션 상태 머신 및 주문 생명주기

1. **신호 멱등성 (Idempotency)**:
   - 모든 체결 신호 ID는 `data/processed_signals.json`에 영속화되어 재기동 시에도 중복 발주가 100% 방지됨.
2. **자산 노출 예약 라이프사이클 (Exposure Reservation)**:
   - 주문 생성 즉시 `reserveExposure()`로 자본 예약 -> 체결 시 `commitExposure()` -> 취소/거절 시 `releaseExposure()`로 반환.
3. **비동기 부분 체결 감시 큐 (Partial Fill Watcher Queue)**:
   - 주문 제출 직후 최대 5회 폴링으로 체결 상태를 확인합니다. API Rate Limit 에러를 방지하기 위해 **지수 백오프(Exponential Backoff)** 대기(초기 600ms에서 1.5배씩 점진적 증가)를 적용하며, 미확인 시 3단계 Reconciliation(identifier → uuid → open orders 스캔)을 거칩니다.
   - 분할 체결(`state: 'wait'`)된 주문은 Background Partial Fill Watcher(4초 주기)가 지속 추적하여 증분(`overrideVolume`)만 포지션 매니저에 정밀 누적 반영합니다.
   - 최종 미확인 주문은 `UNKNOWN_PENDING_RECONCILIATION` 상태로 전환되어 다음 폴링에서 재검증됩니다.

---

## 7. 핵심 검증 체크포인트 (Audit Checkpoints)

1. **박스권 스캘핑 사이클과 추세 추종의 공존**: SIDEWAYS 국면에서는 좁은 밴드(ATR*0.8) 진입 + 단기 전량 익절(+0.5%~+0.8%)이 반복 작동하고, BULL 국면 전환 시 게이트에 의해 트레일링+불타기로 매끄럽게 전환되는가?
2. **트레일링 무장 밴드 일치성**: `handleMarketTick()`과 전략 신호 평가 엔진이 동일한 동적 국면별 ATR 배율을 사용하여 트레일링 무장 시점의 왜곡이 없는가?
3. **스캘핑 진입 예산 관리**: Rule 8-b / 9-b 진입 시 `GlobalRiskGovernor`에서 일반 진입의 50% 크기로 정확히 제한되어 박스권 잦은 진입 시의 과도한 자본 노출을 방지하는가?
4. **보호성 매도 즉시성**: `PROTECTIVE_SELL_SIGNALS`에 신규 `SCALP_TAKE_PROFIT`이 포함되어 미체결 매수 주문이 대기 중인 상태에서도 익절 타이밍을 놓치지 않고 즉시 집행되는가?
5. **더스트 가드 및 포지션 복구**: 잔여 수량 0.0001 미만 더스트 필터링과 거래소 공식 평단가(`avg_buy_price`) 동기화가 포지션 왜곡이나 진입 차단을 원천 방지하는가?
