@echo off
title Twatter - First Time Setup
color 0B
echo.
echo  ==========================================
echo   TWATTER - First Time Setup
echo  ==========================================
echo.
echo  This will install all dependencies.
echo  Only needs to be run once.
echo.
pause

echo.
echo [1/4] Installing client dependencies...
call npm install
if errorlevel 1 ( echo ERROR in client install & pause & exit /b 1 )

echo.
echo [2/4] Installing relay dependencies...
cd relay
call npm install
if errorlevel 1 ( echo ERROR in relay install & pause & exit /b 1 )
cd ..

echo.
echo [3/4] Installing media server dependencies...
cd media-server
call npm install
if errorlevel 1 ( echo ERROR in media-server install & pause & exit /b 1 )
cd ..

echo.
echo [4/4] Installing payment server dependencies...
cd payment-server
call npm install
if errorlevel 1 ( echo ERROR in payment-server install & pause & exit /b 1 )
cd ..

echo.
echo  ==========================================
echo   Setup complete! You can now run:
echo   START_TWATTER.bat
echo  ==========================================
echo.
pause
