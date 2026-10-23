@echo off
REM ---------------------------------------------------------------------------
REM  DSH deep-mode launcher (ASCII-only shim). Real logic: start-dsh-debug.ps1
REM
REM  Do NOT put non-ASCII text in this file. cmd.exe decodes .cmd files with the
REM  OEM code page (936 on zh-CN), so UTF-8 Chinese comments get garbled, swallow
REM  the following REM and newline, and cmd then tries to run Chinese text as a
REM  command: the window floods with errors and closes instantly. Chinese docs
REM  live in README.md, never in this file.
REM ---------------------------------------------------------------------------
setlocal
set "PS1=%~dp0start-dsh-debug.ps1"
if not exist "%PS1%" (
  echo [x] Missing "%~dp0start-dsh-debug.ps1"
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
