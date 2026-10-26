# Gold SMC Scanner, live

Start it with **`start.bat`** one folder up, then use the dashboard's **Setup** tab for everything
else. See [`../README.md`](../README.md) for the quick start. This page covers the details.

The live scanner runs on your PC. Every 5 minutes, just after a candle closes, it:

1. fetches the latest XAUUSD candles from the source you chose,
2. adds the closed ones to the history it keeps in `live\data`,
3. runs the same SMC engine as the page on 5m, and on 15m built from the 5m candles,
4. alerts each new signal once: in the console, in the browser and on Telegram,
5. retrains the next-move forecaster and reruns the pattern lab on all the history collected so far (every 12 new candles),
6. and shows everything on a dashboard at http://localhost:8787.

It only reads prices. It never places orders.

## Command line

```
node live\runner.js                         live scanner with live\config.json (or the defaults)
node live\runner.js --open                  the same, and open the dashboard in the browser
node live\runner.js --source yahoo          a source for this run only
node live\runner.js --source replay --replay-start 2026-09-20 --fast --stay    the demo
node live\runner.js --once                  one check, then exit (exit code 1 if it failed)
node live\runner.js --plan                  one check, then the full trade plan for every timeframe (now.bat)
node live\runner.js --help                  every option
```

`npm start`, `npm run plan`, `npm run demo` and `npm test` run the same from the `smc-scanner` folder.
`--plan` never sends Telegram messages, so it is safe to run while the scanner is running.

## Sources

| `source` | What it needs |
|---|---|
| `auto` (default) | Nothing. Tries `mt5file`, `mt5`, `twelvedata` (only with a key) and `yahoo` in that order when the scanner starts, and keeps the first that answers until it restarts. The dashboard lists why the others were skipped. |
| `mt5file` | MT5 open with the `GoldSMCExport` expert on an XAUUSD chart. See [`mt5/README.md`](mt5/README.md). |
| `mt5` | Python 3.11+ with `pip install MetaTrader5`, and MT5 open and logged in. The broker's name for gold (XAUUSD.m, GOLD …) is found automatically. The server's UTC offset is measured from live ticks (`serverUtcOffsetMinutes: "auto"`). |
| `twelvedata` | A free key from twelvedata.com. 800 requests a day; a check uses one, and closed hours use none. No volume for gold. |
| `yahoo` | Nothing. COMEX gold futures (GC=F): about 10 minutes late and a few dollars above spot. An unofficial feed. |
| `csv` | A candle file that another program keeps writing (`csv.path`, `csv.tzOffsetMinutes`). |
| `replay` | Nothing. Replays the bundled sample on a virtual clock: a demo, not live prices. |

## Telegram by hand

The Setup tab does all of this with two buttons. Without it:

1. In Telegram, open **@BotFather**, send `/newbot` and follow the steps. It gives you a **bot token** like `123456789:AAH...`.
2. Open a chat with your new bot and send it `/start`. A bot cannot message you first.
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and find `"chat":{"id":123456789`. That number is the chat id. For a group, add the bot to the group, send a message there and use the group's id (it starts with `-`).
4. Put both in `config.json` under `alerts.telegram`.

The token is never written to the log or shown by the dashboard. An entry alert looks like this:

```
BUY NOW · XAUUSD 5m · Pin bar at OB · grade A
Entry 4,349.18  SL 4,341.67  TP 4,364.20 (2R)
Size: 0.06 lot risks $45.06 (1% of $5,000)
Swept PDL 4,340.45 at 23:05 · CHoCH 00:10 · IFVG · OB
Candles: Bullish engulfing ★★ (49% vs 48% usual, no edge)
Candle check: swept PDL 4,340.45, at the marked buy zone, London · tested: 1 ATR its way first 46% of 3,800 times vs 48% for any candle · no edge
Confluence 3/4: Key liquidity (PDL), London or NY session, OB in discount
⚠ High-impact news: USD CPI m/m in 25 min (18:00)
Next move: 58% up in the next 1h (medium confidence)
Past buy entries: 8 of 22 won (36%)
```

Times are candle open times (as on the chart) in your time zone, India by default. With `alerts.on`
set to `"all"` you also get the steps before an entry:
- sweeps and CHoCHs;
- marked zones, with the planned trade (`Plan: entry ≈ 4,346.30, SL ≈ 4,341.40, TP ≈ 4,356.10 (2R) · off if a close below 4,342.14`);
- **price is in the BUY zone**: get ready, and buy only when the pattern closes there;
- cancelled setups.

Each check prints the trade plan for every timeframe in the console, for example
`5m: +1 candle, WAIT · buy zone ready at 4,342.14 – 4,346.30`.

## Timing

Checks run every `everyMinutes` (5 by default, 5 to 15 allowed), 8 seconds after each 5-minute mark,
so each check sees the candle that just closed. The candle still forming is never used, and checks
never overlap. If a fetch fails, the scanner keeps the last data, shows the error on the dashboard,
tries once more after 60 seconds, then carries on at the normal times. A feed that is a few seconds
late with the newest candle is asked once more after 20 seconds.

While gold is closed (Friday 17:00 to Sunday 18:00 New York, and 17:00 to 18:00 daily) there is
one check after the close, then none until the open. Set `marketHours` to `false` to check anyway.

## What it remembers

Everything lives in `live\data` (not in git). Each source has its own files:

| File | What it is |
|---|---|
| `XAUUSD-<source>-5m.csv` | The candle history collected so far, up to `historyCandles`. Load it in the page with **Load your CSV**. |
| `state-XAUUSD-<source>.json` | The last candle processed per timeframe and the alerts already sent, so a restart never repeats an alert. |
| `latest-XAUUSD-<source>.json` | The last scan: what the dashboard shows. |
| `forecasts-XAUUSD-<source>.jsonl` | Every forecast made, so the dashboard can show how they turned out. |
| `news.json` | The last copy of the news calendar. |
| `scanner.log` | Everything the console printed, with dates. It rolls over at 2 MB. |

## The forecast

The forecaster (`predict.js`) learns from the collected history what usually came next: which
side's liquidity was taken first, and whether price was higher 1 hour and 4 hours later. It is tested
walk-forward, so its track record only counts calls made before their outcome was known.
**Confidence** is high only when similar calls were right at least 60% of the time over 300 or more
past calls; most calls are low confidence. It needs about 2,900 five-minute candles (about 10
trading days) before it starts. Treat it as context for a setup, not as a signal on its own.

## Safety

The dashboard listens on this PC only (127.0.0.1). Settings can only be changed from the dashboard
page itself: requests from other websites are refused. `config.json` holds your keys and is
git-ignored; the dashboard never shows them back.
