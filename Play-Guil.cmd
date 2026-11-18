@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0tools\play_guil.ps1" %*
if errorlevel 1 (
    pause
    exit /b 1
)
exit /b 0
