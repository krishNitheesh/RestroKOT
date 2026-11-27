@echo off
title RestroKOT - Allow Wi-Fi / LAN Devices Through Windows Firewall
echo ============================================================
echo   RestroKOT Multi-Device Wi-Fi / LAN Firewall Setup
echo ============================================================
echo.
echo Adding Windows Firewall rules for ports 3000 (POS) and 3001 (Intercom) on ALL network profiles...
netsh advfirewall firewall delete rule name="RestroKOT POS (Port 3000)" >nul 2>&1
netsh advfirewall firewall delete rule name="RestroKOT Intercom (Port 3001)" >nul 2>&1
netsh advfirewall firewall add rule name="RestroKOT POS (Port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=any
netsh advfirewall firewall add rule name="RestroKOT Intercom (Port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=any
echo.
echo [DONE] Phones, tablets, Kitchen screens, and TVs on the same Wi-Fi
echo can now connect to RestroKOT!
echo.
pause
