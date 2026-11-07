@echo off
setlocal
set "TMPDIR=%LOCALAPPDATA%\Temp\dsh-qq"
echo.
echo  ============================================
echo   DSH temp dir diagnostic + fix  (v3)
echo   %TMPDIR%
echo  ============================================
if not exist "%TMPDIR%" mkdir "%TMPDIR%"

echo.
echo  [1] set label: Low with NoPolicy
icacls "%TMPDIR%" /setintegritylevel (OI)(CI)L(N)
echo     errorlevel=%errorlevel%

echo.
echo  [2] grant low-integrity SID full control
icacls "%TMPDIR%" /grant "*S-1-16-4096:(OI)(CI)(F)"
echo     errorlevel=%errorlevel%

echo.
echo  [3] current ACL
icacls "%TMPDIR%"

echo.
echo  [4] copy-paste the lines above back to the chat.
echo      What matters: does it still say (NW) on the Low Mandatory Label line?
echo.
pause