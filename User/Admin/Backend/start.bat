@echo off
rem MOWMMAS Admin backend - double-click to start the admin API (Firestore submissions).
rem It keeps this window open when the server stops, so any error message stays visible.
cd /d "%~dp0"
title MOWMMAS Admin backend
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org ^(version 20 or newer^), then try again.
  echo.
  pause
  exit /b 1
)
node server.js
echo.
echo The MOWMMAS Admin backend has stopped.
pause
