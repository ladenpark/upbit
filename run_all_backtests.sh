#!/bin/bash
set -e

echo "=========================================="
echo "Step 1: Downloading 6 Months History Data"
echo "=========================================="
npx tsx tools/downloadHistory.ts

echo -e "\n=========================================="
echo "Step 2: Running Backtest (Last 180 Days - 6 Months)"
echo "=========================================="
npx tsx server/backtest/backtestRunner.ts 180 | grep -E "테스트 기간|초기 자본|최종 자본|최대 낙폭|총 지불 수수료|총 체결 주문"

echo -e "\n=========================================="
echo "Step 3: Running Backtest (Last 90 Days - 3 Months)"
echo "=========================================="
npx tsx server/backtest/backtestRunner.ts 90 | grep -E "테스트 기간|초기 자본|최종 자본|최대 낙폭|총 지불 수수료|총 체결 주문"

echo -e "\n=========================================="
echo "Step 4: Running Backtest (Last 30 Days - 1 Month)"
echo "=========================================="
npx tsx server/backtest/backtestRunner.ts 30 | grep -E "테스트 기간|초기 자본|최종 자본|최대 낙폭|총 지불 수수료|총 체결 주문"

echo -e "\n=========================================="
echo "Step 5: Running Backtest (Last 7 Days - 1 Week)"
echo "=========================================="
npx tsx server/backtest/backtestRunner.ts 7 | grep -E "테스트 기간|초기 자본|최종 자본|최대 낙폭|총 지불 수수료|총 체결 주문"
