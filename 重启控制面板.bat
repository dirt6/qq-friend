@echo off
rem ============================================================
rem  Restart the QQ Agent control panel with admin rights.
rem
rem  Use this after the panel code changes: the old node process
rem  keeps the old code in memory, and killing an elevated
rem  process needs elevation too.
rem
rem  NOTE: keep this file ASCII-ONLY. cmd parses .bat as GBK on
rem  Chinese Windows; UTF-8 Chinese comments get executed as
rem  commands (that bug bit us once already).
rem ============================================================
setlocal
set "HERE=%~dp0"

net session >nul 2>&1
if not errorlevel 1 goto :run

echo [QQ Agent] Requesting administrator rights to restart the panel...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
echo [QQ Agent] Stopping the old panel on port 8899 (if any)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8899" ^| findstr "LISTENING"') do (
  echo   killing PID %%p
  taskkill /F /PID %%p >nul 2>&1
)
timeout /t 2 >nul

netstat -ano | findstr ":8899" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [QQ Agent] Port 8899 is still busy - close the old panel manually and retry.
  timeout /t 5 >nul
  exit /b 1
)

echo [QQ Agent] Starting a fresh panel...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath 'node' -ArgumentList '%HERE%scripts\web-panel-server.mjs' -WorkingDirectory '%HERE%' -WindowStyle Hidden -RedirectStandardOutput '%HERE%data\web-panel.console.log' -RedirectStandardError '%HERE%data\web-panel.console.err.log'"
timeout /t 3 >nul

start "" http://127.0.0.1:8899
echo [QQ Agent] Panel restarted: http://127.0.0.1:8899
timeout /t 3 >nul
exit /b 0
