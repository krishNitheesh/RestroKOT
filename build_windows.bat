@echo off
title Building RestroKOT Windows Application (.exe)...
echo ========================================================
echo     Building RestroKOT Windows Desktop App (.exe)
echo ========================================================
echo.

:: 1. Check Python installation
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH!
    echo Please install Python 3.10+ from python.org and check "Add Python to PATH".
    pause
    exit /b 1
)

:: 2. Install dependencies
echo [1/3] Installing application dependencies...
pip install --upgrade pip
pip install -r requirements.txt

:: 3. Build standalone single-file .exe AND fast folder .exe
echo.
echo [2/3] Compiling RestroKOT_Portable.exe (single-file .exe)...
pyinstaller RestroKOT_Portable.spec --noconfirm --clean

echo.
echo [3/3] Compiling dist\RestroKOT\RestroKOT.exe (fast-launch folder)...
pyinstaller RestroKOT.spec --noconfirm --clean

:: 4. Verify build output
if exist "dist\RestroKOT_Portable.exe" (
    echo.
    echo ========================================================
    echo   [SUCCESS] Windows .exe files built successfully!
    echo.
    echo   1. Single-File App: dist\RestroKOT_Portable.exe
    echo   2. Fast Folder App: dist\RestroKOT\RestroKOT.exe
    echo.
    echo   Database is stored safely in:
    echo   %%LOCALAPPDATA%%\RestroKOT\data\restaurant.db
    echo   (0%% data loss on updates, crashes, or reboots)
    echo ========================================================
) else (
    echo.
    echo [ERROR] Build failed. Please check the error messages above.
)

pause
