@echo off
rem Gold SMC Scanner, live. Double-click to start; close the window or press Ctrl+C to stop.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
  echo Created config.json from config.example.json. Edit it to set your source and Telegram alerts.
  echo.
)
node "%~dp0runner.js" --config "%~dp0config.json" %*
echo.
echo The scanner has stopped.
pause
