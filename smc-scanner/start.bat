@echo off
rem Gold SMC Scanner: double-click to start. The dashboard opens in your browser.
rem Close this window (or press Ctrl+C) to stop. Extra options go to live\runner.js (try --help).
setlocal EnableExtensions
cd /d "%~dp0"
title Gold SMC Scanner

rem Opened straight from a zip, Windows runs it from a temporary copy that disappears.
echo "%~dp0" | findstr /r /i /c:"\\Temp[0-9]*_" >nul
if not errorlevel 1 (
  echo This is running from inside the zip file. Right-click the zip, choose "Extract All...",
  echo then double-click start.bat in the extracted folder.
  echo.
  pause
  exit /b 1
)

rem Node.js 18 or later: the one on this PC, else a private copy in runtime\node (no admin rights).
set "NODE="
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)" >nul 2>nul
if not errorlevel 1 set "NODE=node"
if not defined NODE if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
if not defined NODE (
  echo Node.js is not installed, so a private copy is downloaded into this folder.
  echo It is about 30 MB, needs no admin rights and changes nothing else on this PC.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-node.ps1" -Dest "%~dp0runtime"
  if errorlevel 1 (
    echo.
    echo Could not get Node.js. See the message above, or install the LTS version from https://nodejs.org
    pause
    exit /b 1
  )
  set "NODE=%~dp0runtime\node\node.exe"
)

echo.
rem now.bat: one check, the trade plan printed here, nothing left running
if defined SMC_NOW goto now
rem test.bat: the test suite, through the npm next to this Node.js
if defined SMC_TEST goto test
echo Starting the Gold SMC Scanner. The dashboard opens in your browser (http://localhost:8787).
echo Keep this window open while you use it; close it to stop.
echo.
"%NODE%" "%~dp0live\runner.js" --open %*
set "CODE=%errorlevel%"
echo.
echo The scanner has stopped (exit code %CODE%). Its log is in live\data\scanner.log
pause
exit /b %CODE%

:now
echo Checking the latest prices once, then printing the trade plan for 5m and 15m.
echo.
"%NODE%" "%~dp0live\runner.js" --plan %*
set "CODE=%errorlevel%"
echo.
echo Double-click now.bat again for a fresh plan. For alerts as they happen, use start.bat.
pause
exit /b %CODE%

:test
rem npm test calls "node", so the private copy goes first on PATH (npm.cmd sits next to it)
if not "%NODE%"=="node" set "PATH=%~dp0runtime\node;%PATH%"
echo Running all the tests.
echo.
call npm test %*
set "CODE=%errorlevel%"
echo.
if "%CODE%"=="0" (echo All tests passed.) else (echo Some tests failed, see above.)
pause
exit /b %CODE%
