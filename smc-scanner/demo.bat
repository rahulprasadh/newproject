@echo off
rem Gold SMC Scanner demo: replays the bundled September 2026 sample at full speed, so you can see
rem alerts, grades and the forecast work at any time, even when the market is closed.
rem Prices are not live. Close this window to stop.
setlocal
call "%~dp0start.bat" --source replay --replay-start 2026-09-20 --fast --stay %*
