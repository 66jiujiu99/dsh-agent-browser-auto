@echo off
REM ---------------------------------------------------------------------------
REM  ASCII-only launcher. All real logic lives in unblock-folder.ps1.
REM  See the comment in start-dsh-debug.cmd for why this file must stay ASCII.
REM ---------------------------------------------------------------------------
setlocal
set "PS1=%~dp0unblock-folder.ps1"
if not exist "%PS1%" (
  echo [x] Missing "%~dp0unblock-folder.ps1"
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [x] exit code %RC%
  pause
)
exit /b %RC%
