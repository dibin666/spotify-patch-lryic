@echo off
rem Spot-Lyric for Spotify (Windows) - see patch.ps1
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch.ps1" %*
set rc=%errorlevel%
if "%~1"=="" pause
exit /b %rc%
