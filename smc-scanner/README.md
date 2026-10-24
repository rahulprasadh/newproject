# Gold SMC Scanner

Finds this XAUUSD setup on 5m and 15m candles, shows it on a chart and alerts you when it completes:

1. **Liquidity sweep:** a candle wicks past a liquidity level (swing, equal highs/lows, previous day, session high/low) and closes back inside.
2. **CHoCH:** a close beyond the last opposite swing that formed before the sweep.
3. **Volume candle → FVG / IFVG:** a big, high-volume candle in the new direction that leaves a fair value gap, or closes through an older opposite gap (inverse FVG).
4. **Order block:** the last opposite-coloured candle before the volume candle.
5. **Entry:** price returns to the order block and prints a pin bar or a 3-candle head & shoulders.

Every setup also gets a **grade** (A+, A, B, C) from its confluences, and every entry alert carries the stop, the target, the **lot size** for your risk, any **high-impact news** close by, and a **next-move forecast**.

## Start it on Windows (no installs)

1. Extract the zip (right-click → **Extract All…**). Do not run it from inside the zip.
2. Double-click **`start.bat`** in the `smc-scanner` folder.
   - If Windows warns that the file came from the internet, choose **Run** (or **More info → Run anyway**).
   - No Node.js? It downloads a private copy into `smc-scanner\runtime` (about 30 MB, no admin rights, checked against nodejs.org's SHA-256 list).
3. Your browser opens **http://localhost:8787** in Live mode. Keep the black window open; close it to stop.

From VS Code: open the folder, open a terminal (Ctrl+`) and run `.\smc-scanner\start.bat`.

On first start the scanner picks a data source by itself (**auto**): MT5 if you have set it up, otherwise **Yahoo Finance gold futures**, which needs no account. Open the **Setup** tab in the dashboard to:

- choose your data source, with a **Test this source** button,
- set up **Telegram** alerts: paste the bot token, press **Find my chat id**, then **Send a test message**,
- set your **account size and risk %** for lot sizes, the lowest **grade** to alert, check interval and time zone,
- copy the page's **Settings** tab (your strategy tweaks) into the live scanner.

**Save and restart** writes `live\config.json` and restarts the scanner in place. You never have to edit JSON.

Want to see it work right now, even on a weekend? Double-click **`demo.bat`**. It replays the bundled September 2026 data at full speed, with alerts, grades and forecasts. These are not live prices.

## Which data source

| Source | Prices | Volume | Needs |
|---|---|---|---|
| **MT5, no Python** (`mt5file`) | Your broker's, live | Tick volume | MT5 open with the `GoldSMCExport` expert on an XAUUSD chart. Steps in [`live/mt5/README.md`](live/mt5/README.md). **Best.** |
| MT5 through Python (`mt5`) | Your broker's, live | Tick volume | Python 3.11+ and `pip install MetaTrader5` |
| Twelve Data (`twelvedata`) | Spot XAU/USD, live | None (volume check skipped) | Free API key |
| Yahoo Finance (`yahoo`) | COMEX futures GC=F, about 10 min late, a few $ above spot | Real futures volume | Nothing |
| CSV file (`csv`) | Whatever the file holds | If the file has it | A file another program keeps writing |

Each source keeps its own history in `live\data`, so switching never mixes two price series. MT5 server time is converted to UTC per candle, including brokers on "New York close" time (UTC+2 in winter, UTC+3 in summer) across daylight saving.

## What it does every 5 minutes

Just after each candle closes (10:05:08, 10:10:08 …) the scanner fetches the new candles, runs the engine on 5m and on 15m (built from the 5m), and alerts each new signal once: in the console, in the browser (sound and desktop notification) and on Telegram. If Telegram is unreachable, the alert is retried at the next checks while it is still fresh.

- **Market hours:** gold is closed from Friday 17:00 to Sunday 18:00 New York time, and 17:00–18:00 every day. The scanner makes one check after the close to collect the last candles, then waits for the open. The dashboard says when it reopens.
- **Missed time:** after sleep or a restart, the missing candles are fetched. Signals older than 30 minutes are counted but not sent.
- **Stalled feed:** if the newest candle is too old while the market is open, the status line warns you (is MT5 connected?).
- **News:** the free Forex Factory calendar is checked at most hourly. Entry and zone alerts within 30 minutes of a high-impact USD release say so, and the dashboard lists the next releases.
- **Problems:** everything is logged to `live\data\scanner.log`. A bad `config.json` never stops the start-up: the defaults are used and the Setup tab says what is wrong. If no source answers, the dashboard still opens, explains why, and the scanner retries every minute.

## The grade

When the zones are marked, a setup is graded on up to five confluences:

- the swept level is key liquidity (PDH/PDL, a session high or low, or equal highs/lows) rather than a plain swing,
- the sweep came in the London or New York session,
- the order block sits in discount for a buy or premium for a sell,
- the trade goes with the higher-timeframe trend,
- the volume candle has at least 2× average volume (only when the data has volume).

Meeting all of them is **A+**, three quarters **A**, half **B**, less **C**. Use "Lowest grade to alert" in Setup, or "Only setups graded at least" in Settings, to filter. The **By grade** table shows whether better grades actually win more on your data. On the 6-month sample there are far too few trades to tell, so judge it on your own MT5 history.

## The pages

- **History:** every completed setup on the loaded candles, with each step's time and price and the result at the target.
- **Replay:** play the chart candle by candle. Each mark appears on the candle where it became known, with alerts.
- **Live:** what the scanner sees now, updated every 20 seconds. Includes **Check now**, desktop alerts and the news list.
- **Settings / Rules:** every engine condition, with the current numbers spelled out.
- **Load your CSV:** MetaTrader 5/4, TradingView or Dukascopy exports, for checking your own history in the page.

Open `index.html` directly to use History and Replay without the scanner. It needs the internet for the chart library; the scanner serves its own copy.

## Results on the bundled sample (default settings, spread 0.25)

The sample is free data from [getdata.finance](https://github.com/getdata-finance/xauusd-5m-ohlcv-metals-historical-data) (MIT): 35,954 five-minute candles, 26 Mar to 25 Sep 2026, UTC, with tick volume.

| | 5m | 15m |
|---|---|---|
| Liquidity sweeps | 971 | 456 |
| CHoCH after the sweep | 178 | 78 |
| Volume candle + FVG / IFVG | 61 | 26 |
| Price back at the order block | 33 | 13 |
| Entries | 22 | 8 |
| Wins / losses at 2R | 8 / 14 | 4 / 4 |
| Net | +2.0R | +4.0R |

These numbers check that the marks are right. They do not prove an edge: 30 trades in 6 months are far too few. The forecaster is also honest about itself: on the sample its up/down call is no better than chance (about 50%), and its "which liquidity is taken first" call (about 67%) is no better than "the nearer level goes first". The dashboard prints its track record next to every forecast.

## Files

| File | What it is |
|---|---|
| `start.bat`, `demo.bat` | Start the live scanner, or the replay demo, on Windows |
| `engine.js` | The detection engine. It reads one candle at a time and never looks ahead, so history, replay and live give the same signals. |
| `predict.js` | The next-move forecaster, tested walk-forward |
| `index.html` | The dashboard |
| `live/runner.js` | The live scanner, its dashboard server and the Setup API |
| `live/sources.js` | Data sources: MT5 file and Python, Twelve Data, Yahoo, CSV, replay, auto |
| `live/alerts.js`, `live/news.js` | Alert text, Telegram, lot size, news calendar |
| `live/mt5/GoldSMCExport.mq5` | The MT5 expert that exports candles (reads prices only, never trades) |
| `live/mt5_bars.py` | The Python route to MT5 |
| `vendor/` | A local copy of TradingView Lightweight Charts 4.2.3 (Apache 2.0) |
| `test/` | Tests: `npm test`, or `node --test test/*.test.js` (Node 20+) |
| `tools/ui_check.js` | Browser check with Playwright: `node tools/ui_check.js` |

Live settings and keys go in `live/config.json` (the Setup tab writes it; it is git-ignored). The details of every option are in `live/config.example.json`, and more about the live scanner in `live/README.md`.

None of this is financial advice. The scanner only reads prices; it never places orders.
