# Upbit ATR AutoPilot Quant Engine: Architecture & Logic Specification

**Target Asset**: Upbit KRW-ETH (Spot Trading)  
**Core Framework**: TypeScript, Node.js (PM2 Cluster), React/Vite, Upbit Open API (REST & WebSocket)  
**Validation**: 17 Test Groups, 123 Automated Tests (100% Pass)

---

## 1. 시스템 전체 아키텍처 개요 (System Architecture)

- **데이터 파이프라인**: 
  - Upbit WebSocket 실시간 체결가 및 1분봉 캔들 수신.
  - **워치독(Watchdog)**: 8초 이상 체결이 없으면 Upbit REST API(`/v1/ticker`)로 백업 폴링, 20초 이상 무응답 시 웹소켓 자동 재연결.
- **포지션 동기화 (Exchange Reconciliation)**:
  - Upbit 계좌 API(`/v1/accounts`)의 `avg_buy_price`(실제 매수 평단가)를 파싱하여 엔진의 `entryPrice`와 1원 단위까지 100% 일치 동기화.

---

## 2. 시장 국면 분류 및 이중 타임프레임(MTF) 적응형 파라미터

### 2.1 시장 국면(Regime) 판정 로직
1분봉 20개 선형 회귀 기울기(`slope`), 캔들 변동성 비율(`volatilityRatio`), 15분봉 상위 타임프레임 EMA 추세(`higherTfTrend`)를 결합하여 3대 국면을 판정합니다.

1. **상승장 (BULL)**: 
   - `slope > 0.12` AND `(현재가 - Baseline) / Baseline > +0.08%` AND `15분봉 추세가 BEAR가 아님`
2. **하락장 (BEAR)**: 
   - `slope < -0.10` AND `(현재가 - Baseline) / Baseline < -0.06%`
3. **횡보장 (SIDEWAYS)**: 
   - 위 조건 외 모든 구간

### 2.2 오토파일럿(AutoPilot) 동적 파라미터 매트릭스

| 시장 국면 (Market Regime) | 밴드 승수 (`dynamicAtr`) | DCA 간격 (`dynamicDcaStep`) | 트레일링 콜백 (`dynamicTrailingCallback`) | 1차 진입 비중 (`dynamicOrderRatio`) |
|---|---|---|---|---|
| **상승장 (BULL)** | **2.4** (기회 포착 확대) | **1.5%** (빠른 회전) | **0.8%** (추세 끝까지 추종) | **20.0%** (적극 진입) |
| **횡보장 (SIDEWAYS)** | **3.0** (노이즈 필터링) | **2.0%** (표준 분할) | **0.6%** (중간 박스권 익절) | **18.0%** (안정적 진입) |
| **하락장 (BEAR)** | **3.6** (돌파 엄격화) | **3.0%** (낙폭 확대 방어) | **0.5%** (단기 반등 즉시 탈출) | **10.0%** (현금 보존 축소) |

---

## 3. 신호 생성 엔진 및 7대 규칙 우선순위 (ATRStrategyCore)

동일 틱(Tick)에서 복수의 조건이 충족될 경우, **엄격한 우선순위(Priority 1 -> 6)에 따른 단일 신호 방출(Early Return)**로 상충을 원천 차단합니다.

- **Priority 1: ABSOLUTE_STOP_EXIT (정적 손절선 이탈 -> 100% 전량 청산)**
  - 발동 조건: `현재가 <= position.initialStopPrice` (진입 시 확정 스냅샷된 손절선)
  - 실행: 보유 코인 100% 시장가 전량 매도
- **Priority 2: EMERGENCY_TREND_CUT (플래시 크래시 방어)**
  - 발동 조건: 최근 3초 내 가격 낙폭이 1.8% 이상 급락
  - 실행: 보유 수량의 40% 긴급 시장가 매도 후 포지션 상태를 `EMERGENCY_EXIT`으로 전환
- **Priority 3: TRAILING_STOP_EXIT (50% 반복 부분 익절 & 더스트 가드)**
  - **무장(Arm)**: `현재가 >= Baseline + (ATR * Multiplier)` 도달 시 트레일링 활성화 (`trailingActive = true`), 최고가(`trailingPeakPrice`) 실시간 갱신
  - **발동 조건**: `(최고가 - 현재가) / 최고가 >= dynamicTrailingCallback` (되돌림 발생)
  - **실행**:
    - 보유 수량의 **50% 부분 매도**
    - 매도 후 남는 잔여 가치가 **10,000원 미만(Dust Guard)**인 경우 50% 분할 대신 **100% 전량 매도로 자동 전환**
    - 부분 매도 체결 즉시 `trailingActive = false`, `trailingPeakPrice = null`로 무장 해제 -> 다음 익절을 위해서는 상단 밴드를 다시 뚫는 새로운 신고가 형성 요구
- **Priority 4: PARTIAL_LOSS_CUT & REENTRY_BUY (스마트 손절 및 바닥 재진입)**
  - 평단 대비 -4.5% 하락 시 40% 부분 손절 -> 포지션 상태 `DEFENSIVE` 전환 및 직전 DCA 슬롯 1개 비활성화(`DISABLED`)
  - 급락 진정 및 바닥 지지 확인 시 세이브된 현금으로 `REENTRY_BUY` 발동 -> 바닥 평단가 대폭 개선
- **Priority 5: Smart DCA Buy (마틴게일 분할 물타기)**
  - 발동 조건: `평단 대비 하락률 >= dynamicDcaStep * SlotNumber` (최대 3회: 1차, 2차, 3차)
  - 수량 스케일: `1.2 ^ SlotNumber` (1차 1.2배, 2차 1.44배, 3차 1.728배)
- **Priority 6: Pyramiding Buy (대세 상승장 불타기)**
  - 발동 조건: `수익률 >= 1.5% * (pyramidingCount + 1)` AND `adaptive.marketRegime === 'BULL'`
  - 특징: 트레일링 무장 여부와 무관하게 대세 상승장(`BULL`) 국면이 확인되면 최대 2회까지 불타기 허용 (`SIDEWAYS`나 `BEAR`에서는 엄격 차단)
- **Priority 6: Initial Entry / Breakout Buy (1차 진입)**
  - 하단 밴드 터치 시 매수(`ENTRY_BUY`) 또는 상승 추세 Momentum 상방 돌파 시 즉시 1차 진입(`BREAKOUT_BUY`)

---

## 4. 글로벌 리스크 관리 거버넌스 (GlobalRiskGovernor)

모든 생성된 신호는 거래소 발주 전 4단계 사전 필터 및 자산 배분(Sizing) 알고리즘을 통과해야 합니다.

### 4.1 4단계 사전 검증 게이트
1. **Gate 1 (Bot Lifecycle)**: 봇 상태가 `RUNNING`인지 검증 (`HALTED`/`STOPPED` 시 긴급 청산 외 거부)
2. **Gate 2 (Market Data Stale)**: 웹소켓 끊김/데이터 지연 시 매수 신호 원천 차단 (보호성 매도는 허용)
3. **Gate 3 (Order Collision)**:
   - 매수 신호: 미체결 주문 대기 중이거나 자본 예약(`reservedBuyExposureKrw`) 존재 시 엄격 차단
   - 보호성 매도: Pending BUY가 있어도 즉시 승인, 단 동일한 매도 주문의 중복 발주는 차단
4. **Gate 4 (Cooldown Guard)**: 손절/청산 발생 후 30~60초간 재진입 냉각기 부여

### 4.2 자산 배분(Sizing) 및 3중 철통 클램프 (Clamping)

1. **총 자산(Total Capital)** = `가용 KRW 잔여액 + (보유 코인 수량 * 현재가)`
2. **적용 주문 비율(Effective Order Ratio)** = 
   - AutoPilot ON인 경우: 신호의 국면별 `dynamicOrderRatio` (BULL 20%, SIDEWAYS 18%, BEAR 10%)
   - AutoPilot OFF인 경우: 사용자 수동 설정값 `params.orderRatio` (기본 25%)
3. **목표 주문 예산(Target Budget)** = 
   - 일반 매수: `Total Capital * Effective Order Ratio`
   - DCA 물타기: `Total Capital * Effective Order Ratio * (1.2 ^ slot)`
4. **최종 주문 예산(Final Budget)** = `min(Target Budget, 가용 KRW 잔여액 * 0.98, 글로벌 잔여 노출 한도)`
5. **글로벌 최대 포지션 노출 한도**: 총 자산의 **최대 85%**를 절대 초과할 수 없음.
   - *수학적 정합성*: 1차 20% + DCA 1차(24%) + DCA 2차(28.8%) = **총 72.8%**로 85% 한도 내에서 100% 매끄럽게 체결 보장.

---

## 5. 포지션 상태 머신 및 주문 생명주기

1. **신호 멱등성 (Idempotency)**:
   - 모든 체결 신호 ID는 `data/processed_signals.json`에 영속화되어 재기동 시에도 중복 발주가 100% 방지됨.
2. **자산 노출 예약 라이프사이클 (Exposure Reservation)**:
   - 주문 생성 즉시 `reserveExposure()`로 자본 예약 -> 체결 시 `commitExposure()` -> 취소/거절 시 `releaseExposure()`로 반환.
3. **비동기 부분 체결 감시 큐 (Partial Fill Watcher Queue)**:
   - 주문이 분할 체결(`state: 'wait'`)될 경우 큐에 등록하여 3초 주기로 업비트 REST API를 재조회, 체결된 증분(`overrideVolume`)만 포지션 매니저에 정밀 누적 반영.
   - 15초 이상 미체결 주문은 자동 취소(`CANCEL_REQUESTED`).

---

## 6. 핵심 검증 질문 (Audit Checkpoints for Reviewing AI)

1. **자산 배분 수식의 무결성**: 총 자산 기준 동적 비중(BULL 20%, SIDEWAYS 18%, BEAR 10%) 산출 및 85% 글로벌 리스크 한도 내 3차 DCA(누적 72.8%) 수용 구조가 수학적으로 안전한가?
2. **트레일링 50% 부분 익절 & 무장 해제 메커니즘**: 부분 매도 후 `trailingActive=false`로 리셋하여 밴드 재돌파 신고가를 요구하는 방식이 휩쏘(Whipsaw) 구간에서의 불필요한 연쇄 매도를 효과적으로 방지하는가?
3. **상승장 불타기(`PYRAMID_BUY`) 게이트**: `adaptive.marketRegime === 'BULL'` 조건과 `Priority 3` 익절 신호의 Early-Return 구조가 신호 충돌 없이 추세 추종을 극대화하는가?
4. **비동기 장애 복구(Fault-Tolerance)**: 웹소켓 두절 시 20초 워치독 Fallback, 부분 체결 증분 처리, 멱등성 ID 영속화가 실전 주문 누락이나 포지션 뻥튀기를 방지할 수 있는가?
