@echo off
title Twatter - Stopping Servers
color 0C
echo.
echo  ==========================================
echo   TWATTER - Stopping All Servers
echo  ==========================================
echo.
echo  Stopping all Node.js processes...

:: Kill all node processes (relay, media, payment, vite)
taskkill /F /IM node.exe >nul 2>&1

echo  Done. All Twatter servers stopped.
echo.
timeout /t 2 /nobreak >nul
