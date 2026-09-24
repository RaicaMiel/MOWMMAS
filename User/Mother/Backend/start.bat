@echo off
rem MOWMMAS Mother backend - double-click to start the mother-side website and API.
rem It keeps this window open when the server stops, so any error message stays visible.
cd /d "%~dp0"
title MOWMMAS Mother backend
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org ^(version 18 or newer^), then try again.
  echo.
  pause
  exit /b 1
)
node server.js
echo.
echo The MOWMMAS Mother backend has stopped.
pause
