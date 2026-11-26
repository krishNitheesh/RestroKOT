@echo off
title RestroKOT - Manager PC Server & Web App
cd /d "%~dp0"

echo ============================================================
echo   RestroKOT - Manager PC Server (Offline LAN + Cloud Sync)
echo ============================================================
echo.

:: 1. Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed!
    echo Install Python 3.10+ from https://www.python.org/downloads/
    echo Make sure to tick "Add Python to PATH" during install.
    pause
    exit /b 1
)

:: 2. Install Flask if missing
python -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo [INFO] Installing Flask (one-time setup)...
    pip install flask
)

:: 3. Add Windows Firewall rule (ignores error if not admin)
netsh advfirewall firewall show rule name="RestroKOT POS (Port 3000)" >nul 2>&1
if errorlevel 1 (
    echo [INFO] Opening Firewall ports 3000 & 3001 for Wi-Fi devices...
    netsh advfirewall firewall add rule name="RestroKOT POS (Port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=private,domain >nul 2>&1
    netsh advfirewall firewall add rule name="RestroKOT Intercom (Port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private,domain >nul 2>&1
)

:: 4. Start server if port 3000 is not already listening
netstat -ano | find "3000" | find "LISTENING" >nul
if errorlevel 1 (
    echo [INFO] Starting RestroKOT Main Server on port 3000...
    start "RestroKOT Server (DO NOT CLOSE)" cmd /k "python app.py"
    timeout /t 2 /nobreak > nul
) else (
    echo [INFO] RestroKOT Server is already running on port 3000.
)

:: 5. Open Manager POS in Edge App Mode (clean app window)
echo [INFO] Opening Manager POS App Window...
start msedge --app="http://127.0.0.1:3000/login"

echo.
echo [DONE] Keep the "RestroKOT Server" window open while restaurant is running.
echo Other devices on Wi-Fi can now open: http://^<THIS_PC_IP^>:3000/login
echo.
timeout /t 4 >nul
exit
