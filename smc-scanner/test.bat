@echo off
rem Runs all the Gold SMC Scanner tests (npm test). Works without Node.js installed: like start.bat it
rem uses the private copy in runtime\node, downloading it the first time.
setlocal
set "SMC_TEST=1"
call "%~dp0start.bat" %*
exit /b %errorlevel%
