@echo off
rem ============================================================
rem  Emergency fix: the desktop icon still shows the OLD picture.
rem
rem  Rebuilds the "QQ Agent control panel" desktop shortcut
rem  (target / arguments / working dir / icon) and clears the
rem  Windows icon cache. Needs admin, so it asks for UAC once.
rem
rem  Look first, change nothing? In a normal PowerShell window:
rem    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-desktop-icon.ps1 -Check
rem
rem  NOTE: keep this file ASCII-ONLY (cmd parses .bat as GBK).
rem ============================================================
setlocal
set "HERE=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%scripts\fix-desktop-icon.ps1"

echo.
echo [QQ Agent] Still old after this? Log off and back on once.
timeout /t 8 >nul
exit /b 0
