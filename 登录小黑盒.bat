@echo off
cd /d "%~dp0"
echo.
echo ==========================================
echo   Xiaoheihe QR login
echo   QR expires in 120 seconds.
echo   Scan it as soon as the window opens.
echo ==========================================
echo.

node scripts\xhh-login.mjs --qr
if errorlevel 1 goto end
if not exist "data\xhh-qr-url.txt" goto end

set /p QRURL=<"data\xhh-qr-url.txt"
set PYTHONPATH=%~dp0data\pylibs
python scripts\xhh-qr.py "%QRURL%" "%~dp0data\xhh-qrcode.svg"
if errorlevel 1 goto end

start "" "%~dp0data\xhh-qrcode.svg"
echo.
echo QR code opened. Scan it with the Heybox app, then confirm on the phone.
echo Waiting up to 2 minutes...
echo.

node scripts\xhh-login.mjs --poll

:end
echo.
pause
