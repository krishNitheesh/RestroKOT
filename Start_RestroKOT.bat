@echo off
title RestroKOT POS Server & App
cd /d "%~dp0"

echo ===================================================
echo     RestroKOT - Restaurant POS & KDS Suite
echo ===================================================
echo.

:: 1. Check if server is already running on port 3000
netstat -ano | find "3000" | find "LISTENING" >nul
if errorlevel 1 (
    echo [INFO] Starting RestroKOT Server in background...
    start /b python app.py > nul 2>&1
    timeout /t 2 /nobreak > nul
) else (
    echo [INFO] Server is already running.
)

:: 2. Launch in Edge App Mode (Clean, borderless native desktop window)
echo [INFO] Launching Cashier POS Window...
start msedge --app="http://localhost:3000/pos"

exit
