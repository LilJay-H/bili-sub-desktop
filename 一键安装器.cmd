@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dpn0.ps1"
set "biliExitCode=%ERRORLEVEL%"
if not "%biliExitCode%"=="0" echo [ERROR] Setup failed. See the message above.
if /i not "%~1"=="--no-pause" pause
exit /b %biliExitCode%
