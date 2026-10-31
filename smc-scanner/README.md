# Gold SMC Scanner

Finds this XAUUSD setup on 5m and 15m candles, shows it on a chart and alerts you when it completes:

1. **Liquidity sweep:** a candle wicks past a liquidity level (swing, equal highs/lows, previous day, session high/low) and closes back inside.
2. **CHoCH:** a close beyond the last opposite swing that formed before the sweep.
3. **Volume candle → FVG / IFVG:** a big, high-volume candle in the new direction that leaves a fair value gap, or closes through an older opposite gap (inverse FVG).
4. **Order block:** the last opposite-coloured candle before the volume candle.
5. **Entry:** price returns to the order block and prints a pin bar or a 3-candle head & shoulders.

Every setup also gets a **grade** (A+, A, B, C) from its confluences, and every entry alert carries the stop, the target, the **lot size** for your risk, any **high-impact news** close by, and a **next-move forecast**.

The **Trade plan** card says what to do at the current candle: **BUY NOW**, **SELL NOW**, **IN A TRADE**, or **WAIT**. For each side it shows what has to happen next, at which price, by when, and what cancels it. **`now.bat`** prints the same plan for 5m and 15m from live prices in one double-click.

The **Patterns** tab knows 48 candlestick and price-action patterns. Its **pattern lab** tests every one of them in its context (liquidity sweep, SMC zone, FVG, extremes, session, trend, volume), out of sample, on your own data, and says plainly whether any of it predicts the next move.

## Start it on Windows (no installs)

1. Extract the zip (right-click → **Extract All…**). Do not run it from inside the zip.
2. Double-click **`start.bat`** in the `smc-scanner` folder.
   - If Windows warns that the file came from the internet, choose **Run** (or **More info → Run anyway**).
   - No Node.js? It downloads a private copy into `smc-scanner\runtime` (about 30 MB, no admin rights, checked against nodejs.org's SHA-256 list).
3. Your browser opens **http://localhost:8787** in Live mode. Keep the black window open; close it to stop.

**What should I do right now?** Double-click **`now.bat`**. It checks the latest prices once and prints the full trade plan for 5m and 15m: BUY NOW, SELL NOW, IN A TRADE or WAIT, what each side needs next and at which price, what cancels it, the scenarios, the next-move odds, and the latest candles with what the pattern lab found. It sends no Telegram message and leaves nothing running, so it is safe to use while `start.bat` runs. (Same thing from a terminal: `node live\runner.js --plan`.)

From VS Code: open the `newproject` folder, then press **Ctrl+Shift+B** for the trade plan right now, or **Terminal → Run Task → Gold SMC: …** for the live scanner, the demo or the tests. These run the same `.bat` files, so they work without Node.js installed. With Node.js 18+ you can also press ▶ in **Run and Debug** (Ctrl+Shift+D) and pick *Trade plan now*, *Live scanner + dashboard*, *Demo: replay the sample* or *Run all tests*. Or open a terminal (Ctrl+`) and run `.\smc-scanner\start.bat`.

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

## The trade plan: when to buy, when to sell

The card at the top of **Signals** reads the chart at the current candle (the last one in Live, the cursor in Replay):

- **BUY NOW / SELL NOW at …** when an entry printed in the last 2 candles and price is still within 0.5R of it. It shows the entry, stop, target, lot size, and how often past setups that got this far won, with the expected R per trade.
- **IN A BUY / IN A SELL** when a trade is running. It says whether joining now still makes sense (near the entry) or it is too late.
- **WAIT · buy zone ready at …** when the zones are marked. It gives the planned entry, stop and target, worked out the way the engine trades them, and the patterns that would trigger the entry.
- **WAIT · setup forming** or **WAIT · no setup**. For each side, the exact next condition:
  - which liquidity a sweep would take, and how far away it is;
  - the close that makes the CHoCH, and the candle it must come by;
  - the volume candle it needs;
  - what cancels the setup.
- **Scenarios** from the forecaster, for example: "Sell-side EQL 4,340 taken first (62%): a sweep there can start a BUY setup".

In Replay the plan only knows candles up to the cursor, so it is exactly what you would have seen live. Every price comes from the rules in the **Rules** tab, and every percentage comes from the chart's own past. It is a disciplined way to read the chart, not a promise.

## Candlestick patterns

`candles.js` finds 48 patterns:

- **One candle:** hammer, inverted hammer, hanging man, shooting star, the doji family (doji, dragonfly, gravestone, long-legged), spinning top, marubozu, belt hold, pin bars.
- **Two candles:** engulfing, harami, harami cross, piercing line, dark cloud cover, tweezer top and bottom, kicker, inside bar, two-bar reversal (railroad tracks), key reversal (outside reversal bar).
- **Three candles:** morning and evening star, morning and evening doji star, three white soldiers, three black crows, three inside up/down, three outside up/down, three pins, fakey (a false break of an inside bar), and the 3-candle head & shoulders.

The rules follow the classic definitions, adapted to a market that trades around the clock:

- They use bodies, wicks and closes, not opening gaps.
- Sizes are measured in ATR(14) taken before the pattern.
- A reversal pattern only counts after the trend it reverses (the close 6 candles earlier at least 0.8 ATR away), and only at the low or high of that move.
- Stars mark the strong ones: volume at least 1.5× average, or a 20-candle low or high.

The **Patterns** tab:

- lists the patterns on the last three candles, with what each one means;
- has a table of every pattern on the loaded data: how often it worked after 3, 6 or 12 candles, against an ordinary candle;
- lets you count only patterns at a 20-candle low or high, with high volume, or **inside an SMC zone**;
- shows a pattern's exact rule, its record (with the 95% range and each half of the data) and every occurrence on the chart when you click it.

The **Candle patterns** chip on the chart marks the strong ones near the cursor.

On the 6-month sample, patterns on their own work about 50% of the time, the same as an ordinary candle. On 5m, at a 20-candle low or high, piercing lines, tweezer bottoms and the 3-candle head & shoulders did a little better.

That is why the strategy uses candles only as the **trigger** at a swept-liquidity order block, never as a signal by themselves. Seven more groups can be switched on as entry confirmations in **Settings → Entry**: stars, three inside/outside, piercing/dark cloud, tweezers, harami, dragonfly/gravestone doji, and the price-action set (fakey, two-bar reversal, key reversal, belt hold).

## The pattern lab: do candles predict anything here?

Reading candles is about **context**: the same hammer means more after a liquidity sweep, at an order block, at the low of the day, with volume. `patternlab.js` measures exactly that, on whatever data is loaded (in Live, the scanner's own history, retested every hour).

For every pattern it records, from what was known when the pattern closed:

- **liquidity:** a level swept by the pattern or the 2 candles before it, and whether it was key liquidity (PDH/PDL, session high/low, equal highs/lows);
- **SMC:** inside a marked OB/FVG zone of the same side, or into an open FVG;
- **location:** a 20- or 50-candle low/high, discount or premium in the last 8 hours;
- **trend:** the move into it, the stretch from the 50 EMA, the 1-hour trend;
- **strength:** volume against average, size in ATR, how near its high (low) it closed;
- **session:** Asia, London, New York.

Then it checks what followed: did price reach **1 ATR in the pattern's direction before 1 ATR against** (an ordinary candle does this about half the time), and what a trade from the pattern's close made (stop 0.1 ATR beyond the pattern, 2R target, spread included).

It reports each context against an ordinary candle, with a 95% range and both halves of the data. It also trains a small model **walk-forward**: each test period is judged by a model that only learned from earlier patterns, and the model also knows each pattern's own track record. The lab only says **edge** when the model's best-scored fifth beat the usual rate out of sample, in both halves of the test period, and made money at 2R. When that happens, every pattern shows the model's chance. Otherwise each pattern shows its tested record and **no edge**. Tests make sure it finds an edge that is really there (planted in synthetic data) and none in a random walk.

**What it found on the 6-month sample** (spread 0.25):

| Context | 5m: found | 5m: 1 ATR first | 5m: avg at 2R | 15m: found | 15m: 1 ATR first | 15m: avg at 2R |
|---|---|---|---|---|---|---|
| Every pattern | 22,684 | 49% | −0.07R | 7,223 | 49% | −0.01R |
| Right after a liquidity sweep | 1,917 | 48% | −0.11R | 884 | 46% | −0.05R |
| After a key-level sweep | 828 | 49% | −0.08R | 727 | 47% | −0.03R |
| At a marked SMC zone | 114 | 52% | +0.01R | 72 | 44% | −0.35R |
| At a 20-candle low/high | 6,758 | 49% | −0.06R | 2,191 | 48% | −0.04R |
| Volume 1.5× or more | 5,527 | 50% | −0.04R | 2,248 | 49% | −0.01R |
| Confirmed by the next candle | 6,716 | 49% | −0.05R | 2,074 | 50% | +0.05R |
| **Model, best fifth (out of sample)** | 2,723 | 50% | −0.01R | 867 | 50% | +0.04R |

An ordinary candle reaches 1 ATR its way first 49–50% of the time. The model's ranking scored an AUC of 0.50 on both timeframes, which is a coin flip. Busted patterns (trading the failure) and 5m patterns that agree with a 15m pattern did no better either. **On this data, no candlestick pattern predicts the next move, whatever its context.** Anyone selling one that does on intraday gold should show you this kind of out-of-sample test.

What the lab is for:

- it keeps you from trading a pattern because it looks good: every pattern in the Patterns tab, the trade plan, `now.bat` and the entry alerts (**Candle check**) carries its tested record;
- it reruns on your own broker's data as the scanner collects it, and will say **edge** if one shows up there and survives out of sample;
- it is why the strategy's edge, if there is one, has to come from the whole setup (sweep → CHoCH → volume candle → OB) and the 2R trade management, with the candle only as the timing trigger.

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
  - For an MT5 export, pick the file's time zone. Most gold brokers run **New York close time** (UTC+2 in winter, UTC+3 in US summer time; the daily candle opens at 00:00 on their clock). That choice converts each candle with its own offset, so sessions, PDH/PDL and kill zones stay right across the whole year.
  - Brokers on UTC all year (Exness, for example): pick UTC.
  - Years of history work: three years of 5m candles take about 20 seconds to test.

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
| `start.bat`, `now.bat`, `demo.bat` | Start the live scanner, print the trade plan right now, or run the replay demo, on Windows |
| `engine.js` | The detection engine. It reads one candle at a time and never looks ahead, so history, replay and live give the same signals. |
| `candles.js` | The 48 candlestick and price-action patterns, their rules and their statistics |
| `patternlab.js` | The pattern lab: every pattern in its context, tested walk-forward |
| `advisor.js` | The trade plan: buy, sell, hold or wait, with the levels for each side |
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
