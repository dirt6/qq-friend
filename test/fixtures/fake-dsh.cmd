@echo off
REM Fake dsh wrapper for B1 tests.
REM dsh-gateway calls spawn('cmd', ['/c', <QQ_DSH_BIN>, ...args]),
REM so QQ_DSH_BIN must point to a .cmd file.
REM Real logic lives in fake-dsh.mjs; this only forwards.

node "%~dp0fake-dsh.mjs" %*
exit /b %ERRORLEVEL%
