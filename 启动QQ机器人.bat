@echo off
rem QQ Agent launcher (desktop app, no npm window)
rem NOTE: keep this file ASCII-only. cmd parses .bat in GBK on Chinese
rem Windows; UTF-8 Chinese comments swallow the newline and break parsing.
rem
rem 2026-09-23: check electron.exe exists; a missing exe would otherwise
rem make the double-click look completely dead with zero feedback.
rem
rem 2026-10-11: this machine needs --no-sandbox. Without it Chromium dies
rem with exception 0x80000003 (__debugbreak in the Electron main module)
rem BEFORE any JS runs: no window, no log, process gone in ~0.1s.
rem Verified on this machine: with --no-sandbox the window comes up.
rem (--disable-gpu was also tried; it is NOT required.)
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [QQ Agent] electron.exe not found under node_modules\electron\dist\
  echo [QQ Agent] fix: run npm install first
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox
