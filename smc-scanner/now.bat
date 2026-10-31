@echo off
rem What now? Checks the latest gold prices once and prints the full trade plan for 5m and 15m:
rem BUY NOW, SELL NOW, IN A TRADE or WAIT, what each side needs next and at which price, the
rem scenarios, and the latest candles with what the pattern lab found. Nothing keeps running and
rem no Telegram message is sent. Same settings and data as start.bat; options go to live\runner.js.
setlocal
set "SMC_NOW=1"
call "%~dp0start.bat" %*
exit /b %errorlevel%
