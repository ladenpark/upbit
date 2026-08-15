@echo off
chcp 65001 > nul
title Upbit ATR Quant Bot Manager
echo ======================================================
echo  🚀 UPBIT ATR QUANT TRADING BOT - WINDOWS LAUNCHER
echo ======================================================
echo.
echo  1. 봇 24시간 백그라운드 시작 (Start)
echo  2. 봇 재빌드 및 재시작 (Restart)
echo  3. 봇 중지 (Stop)
echo  4. 봇 실시간 상태 확인 (Status)
echo  5. 실시간 매매 로그 보기 (Logs)
echo  6. 대시보드 웹브라우저 열기 (Open Web Dashboard)
echo  0. 종료 (Exit)
echo.
set /p choice="선택하세요 (0-6): "

if "%choice%"=="1" (
    echo.
    echo ▶️ 봇을 시작합니다...
    npm run build && pm2 start ecosystem.config.cjs
    pause
) else if "%choice%"=="2" (
    echo.
    echo 🔄 봇을 재빌드하고 재시작합니다...
    npm run build && pm2 restart upbit-bot
    pause
) else if "%choice%"=="3" (
    echo.
    echo ⏹️ 봇을 중지합니다...
    pm2 stop upbit-bot
    pause
) else if "%choice%"=="4" (
    echo.
    pm2 status
    pause
) else if "%choice%"=="5" (
    echo.
    pm2 logs upbit-bot
) else if "%choice%"=="6" (
    start https://upbit.ikdevlab.com
)
