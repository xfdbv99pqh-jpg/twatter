@echo off
title Twatter Launcher
color 0A
echo.
echo  ==========================================
echo   TWATTER - Starting All Servers
echo  ==========================================
echo.

:: Check Node is installed
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

:: Check dependencies are installed
if not exist "node_modules" (
    echo Dependencies not installed. Run SETUP.bat first!
    pause
    exit /b 1
)

echo  Starting Relay        ^(port 7777^)...
start "Twatter Relay" cmd /k "cd /d %~dp0relay && node relay.js"

echo  Starting Media Server ^(port 7778^)...
start "Twatter Media" cmd /k "cd /d %~dp0media-server && node media.js"

echo  Starting Payment Server ^(port 7779^)...
start "Twatter Payments" cmd /k "cd /d %~dp0payment-server && node payment.js"

echo  Starting Client       ^(port 5173^)...
start "Twatter Client" cmd /k "cd /d %~dp0 && npx vite"

echo.
echo  Waiting for servers to start...
timeout /t 3 /nobreak >nul

echo.
echo  ==========================================
echo   All servers started!
echo.
echo   Open your browser to:
echo   http://localhost:5173
echo.
echo   Press any key to open it now...
echo  ==========================================
echo.
pause >nul

start http://localhost:5173
