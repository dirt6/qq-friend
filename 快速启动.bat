@echo off
rem ============================================================
rem  QQ Agent quick launcher (persona -> NapCat QR -> bot)
rem
rem  NOTE: keep this file ASCII-only. cmd parses .bat as GBK on
rem  Chinese Windows; UTF-8 Chinese comments swallow newlines and
rem  break parsing. All Chinese UI text lives in the .ps1 file.
rem
rem  Opens a GUI where you can:
rem    1) edit the bot persona and save it
rem    2) start NapCat and open the WEB QR page (the console QR
rem       cannot be scanned - the web one can)
rem    3) start / stop / restart QQ Agent
rem ============================================================
setlocal
set "HERE=%~dp0"
if not exist "%HERE%快速启动人设.ps1" (
  echo [QQ Agent] cannot find 快速启动人设.ps1 next to this file.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%HERE%快速启动人设.ps1" %*
if errorlevel 1 (
  echo.
  echo [QQ Agent] launcher exited with an error. Press any key to close.
  pause >nul
)
endlocal
