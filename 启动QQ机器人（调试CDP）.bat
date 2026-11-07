@echo off
rem QQ Agent launcher WITH CDP debugging port (2026-11-03, R7-D UI acceptance)
rem NOTE: keep this file ASCII-only (cmd parses .bat as GBK on Chinese Windows).
rem
rem This is a SEPARATE launcher from the normal one. It opens the same app
rem but with --remote-debugging-port=9222 so an automated test can attach via
rem Chrome DevTools Protocol.
rem
rem SECURITY: 9222 listens on 127.0.0.1 only, but ANY local process can attach
rem and drive the window. Close this instance when you are done testing; do not
rem use it as your daily launcher.

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [QQ Agent] electron.exe not found under node_modules\electron\dist\
  echo [QQ Agent] fix: run npm install first
  pause
  exit /b 1
)

echo [QQ Agent] Starting WITH CDP on http://127.0.0.1:9222
echo [QQ Agent] Verify: curl http://127.0.0.1:9222/json/version
echo.

start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox --remote-debugging-port=9222
