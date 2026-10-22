# Gold SMC Scanner

Marks this XAUUSD setup on 5m and 15m candles and tells you when it completes:

1. **Liquidity sweep:** a candle wicks past a swing high or low and closes back inside.
2. **CHoCH:** a close beyond the last opposite swing that formed before the sweep.
3. **Volume candle → FVG / IFVG:** a big, high-volume candle in the new direction that leaves a fair value gap, or closes through an older opposite gap (inverse FVG).
4. **Order block:** the last opposite-coloured candle before the volume candle.
5. **Entry:** price returns to the order block and prints a pin bar or a 3-candle head & shoulders.

The **Rules** tab in the page spells out every condition with the current numbers, and the **Settings** tab changes them.

## Use it

Open `index.html` in a browser. It needs internet only to load the chart library and fonts.

- **History:** every completed setup is drawn on the chart, and the signal list shows each step with its time and price, plus the result at a 2R target.
- **Replay:** pick a start date and play the chart candle by candle. Each mark appears on the candle where it became known, and an alert pops up (with sound) when an entry prints. Use **Every step** to also be alerted on sweeps, CHoCHs and new order blocks.
- **Your own data:** **Load your CSV** takes MetaTrader 5/4, TradingView or Dukascopy exports. Set the file's time zone; MT5 server time is usually UTC+2 or UTC+3.

The bundled data is a free sample from [getdata.finance](https://github.com/getdata-finance/xauusd-5m-ohlcv-metals-historical-data) (MIT): 35,954 five-minute candles, 26 Mar to 25 Sep 2026, UTC, with tick volume. Your broker's prices and volume will differ slightly, so load your own export before trusting exact levels.

## Files

| File | What it is |
|---|---|
| `engine.js` | The detection engine. It reads one candle at a time and never looks ahead, so the same code can run on live MT5 data later. |
| `index.html` | The page: chart, signal list, replay and settings. |
| `data/sample.js` | The sample candles, built with `tools/build_sample.py`. |
| `test/engine.test.js` | Tests: a hand-built setup with known answers, its bearish mirror, the failure cases, a check that no step uses future candles, and the CSV formats. |

Run the tests with `node --test smc-scanner/test/*.test.js`.

## Results on the sample (default settings)

| | 5m | 15m |
|---|---|---|
| Liquidity sweeps | 868 | 301 |
| CHoCH after the sweep | 164 | 53 |
| Volume candle + FVG / IFVG | 54 | 16 |
| Price back at the order block | 30 | 8 |
| Entries | 22 | 6 |
| Wins / losses at 2R | 8 / 14 | 3 / 3 |

These numbers are for checking that the marks are right, not proof of an edge: 6 months and 28 trades are far too few to judge the strategy.

## Live scanning and next-move forecast

- `live/runner.js` checks for new closed candles every 5 minutes (configurable). It reads them from MetaTrader 5, a Twelve Data key or a CSV, runs the scan on 5m and 15m, alerts on screen and on Telegram, and serves the dashboard at http://localhost:8787 with a **Live** mode. Setup steps are in `live/README.md`; on Windows, run `live\start-live.bat`.
- `predict.js` learns from the collected history and forecasts which liquidity (buy-side or sell-side) is likely to be taken first, plus the up/down odds for the next 1h and 4h. Every number is tested only on candles the model has not seen. On the sample, the up/down call is no better than chance (about 50%), and the liquidity call (about 67%) is no better than "the nearer level is hit first". The page says this next to every forecast.
- Engine precision options: previous-day, session and equal-high/low liquidity, killzones, higher-timeframe trend filter, minimum sweep depth, discount/premium, spread, stop at the sweep or the OB, target at the opposite liquidity, and extra entry patterns (three pins, engulfing). All are in the Settings tab.
- UI check: `LWC_PATH=<lightweight-charts standalone js> node smc-scanner/tools/ui_check.js <screenshot dir>`.
