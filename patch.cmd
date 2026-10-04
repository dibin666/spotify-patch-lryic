@echo off
rem Spot-Lyric for Spotify (Windows) - runs spot-lyric through patch.ps1; same options as ./patch.sh
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch.ps1" %*
set rc=%errorlevel%
if "%~1"=="" pause
exit /b %rc%
