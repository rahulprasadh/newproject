# MetaTrader 5 without Python: GoldSMCExport

`GoldSMCExport.mq5` is a small expert advisor that writes the chart's closed candles to MT5's shared
**Common Files** folder every time a candle closes. The scanner reads them from there. You get your
broker's own prices and tick volume, and you need no Python.

It only reads prices. It never opens, changes or closes a trade.

## Set it up once (about 2 minutes)

1. In MT5: **File → Open Data Folder**. Open `MQL5`, then `Experts`.
2. Copy `GoldSMCExport.mq5` (this folder) into that `Experts` folder.
3. Back in MT5, open the **Navigator** (Ctrl+N). Right-click **Expert Advisors → Refresh**.
   If GoldSMCExport does not show up, double-click the file in MetaEditor and press **Compile** (F7).
4. Open an **XAUUSD** chart (your broker may call it XAUUSD.m, XAUUSDm or GOLD).
5. Drag **GoldSMCExport** onto the chart and press **OK**. Keep the defaults: M5 candles, 50,000 candles.
6. Check the **Experts** tab at the bottom of MT5. It prints the file it writes, for example:
   `GoldSMCExport: writing XAUUSD M5 candles to C:\Users\you\AppData\Roaming\MetaQuotes\Terminal\Common\Files\GoldSMC\XAUUSD_M5.csv`

That's it. With the source on **auto** (the default) or **MetaTrader 5, no Python** in the
Setup tab, the scanner finds the file on its own. Keep MT5 open and logged in while you scan; the
expert stays on the chart when MT5 restarts.

Algo Trading can stay off, because the expert never trades. If the dashboard says MT5 has not
updated the candles, check that the chart still shows the expert's icon in its top-right corner.

## What it writes

In `%APPDATA%\MetaQuotes\Terminal\Common\Files\GoldSMC`:

- `<SYMBOL>_M5.csv`: closed candles in broker server time (`time,open,high,low,close,tickvolume`),
  rewritten when a candle closes.
- `<SYMBOL>_M5.json`: the symbol, the server's offset from UTC, and when the file was last written.
  The expert rewrites it every 30 seconds, so the scanner can tell when MT5 has stopped.

The scanner converts the server time to UTC per candle. Brokers on "New York close" time (UTC+2
in winter, UTC+3 in summer) are handled across daylight saving changes, and so are brokers that
stay on one offset all year.
