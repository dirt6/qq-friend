@echo off
chcp 65001 >nul
rem ============================================================
rem  Launch QQ via NapCat (OneBot backend for QQ Agent)
rem
rem  Why admin: NapCat injects NapCatWinBootHook.dll into QQ,
rem  which requires elevation.
rem
rem  NOTE: keep this file ASCII-only (cmd parses .bat as GBK).
rem ============================================================
cd /d "%~dp0shell\napcat"

net session >nul 2>&1
if not %ERRORLEVEL% == 0 (
  echo [NapCat] Requesting administrator rights...
  rem 2026-11-03: -WindowStyle Minimized so the console does not sit on the desktop.
  rem Use Minimized, NOT Hidden: NapCat has fileLog disabled, so this console window
  rem is the only place its logs appear. Hiding it removes the only diagnostic clue.
  rem Minimized keeps it reachable from the taskbar.
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs -WindowStyle Minimized"
  exit /b
)

echo [NapCat] Admin mode OK. Looking up QQ install path...
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString" >nul 2>&1
if not %ERRORLEVEL% == 0 (
  echo [NapCat] ERROR: cannot find QQ in registry.
  echo          Install QQ first, or edit this file with an explicit QQ path.
  pause
  exit /b 1
)

for /f "tokens=2*" %%a in ('reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v "UninstallString"') do set "RetString=%%~b"
for %%a in ("%RetString%") do set "pathWithoutUninstall=%%~dpa"
set "QQPath=%pathWithoutUninstall%QQ.exe"

if not exist "%QQPath%" (
  echo [NapCat] ERROR: QQ.exe not found at "%QQPath%"
  pause
  exit /b 1
)
echo [NapCat] QQ found: %QQPath%

set "NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json"
set "NAPCAT_LOAD_PATH=%cd%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%cd%\NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%cd%\napcat.mjs"

setlocal enabledelayedexpansion
set "M=%NAPCAT_MAIN_PATH:\=/%"
echo (async () =^> {await import("file:///!M!")})() > "%NAPCAT_LOAD_PATH%"
endlocal

echo [NapCat] Starting QQ with NapCat, first run needs QR login...
"%NAPCAT_LAUNCHER_PATH%" "%QQPath%" "%NAPCAT_INJECT_PATH%"
echo.
echo [NapCat] QQ exited. Press any key to close.
pause >nul
