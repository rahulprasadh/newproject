# Gold SMC Scanner, live (Windows)

The live scanner runs on your laptop. Every 5 minutes, just after a candle closes, it:

1. fetches the latest XAUUSD candles from MetaTrader 5 (or Twelve Data),
2. adds the closed ones to the history it keeps in `live\data`,
3. runs the same SMC engine as the page on 5m, and on 15m built from the 5m candles,
4. alerts each new signal once, in the console and on Telegram,
5. retrains the next-move forecaster on all the history collected so far (every 12 new candles),
6. and shows everything on a dashboard at http://localhost:8787.

It only reads prices. It never places orders, so MT5 does not need Algo Trading switched on.

## 1. Install Node.js

Download the **LTS** installer from https://nodejs.org and run it with the default options. To check it, open a new Command Prompt and type `node -v`; it should print v18 or later.

## 2. Choose where the candles come from

### MetaTrader 5 (recommended)

Your broker's own prices and tick volume, straight from the terminal on this PC.

1. Install **Python 3.11 or later** from https://www.python.org/downloads/. On the first installer screen, tick **Add python.exe to PATH**.
2. Open a new Command Prompt and run:
   ```
   pip install MetaTrader5
   ```
3. Open the MT5 terminal and log in to your broker account (demo or live). Keep it open while the scanner runs.
4. Check the symbol name in **Market Watch**. If your broker calls gold `XAUUSD.m` or `GOLD`, put that name in `mt5.symbol` in `config.json`.

MT5 gives candle times in the broker's server time. With `"serverUtcOffsetMinutes": "auto"` the scanner measures that offset from live ticks and converts every candle to UTC, so the marks line up with TradingView. If you start it while the market is closed (weekend), set `fallbackOffsetMinutes` to your broker's offset (often 120 in winter, 180 in summer) or simply start it again once the market opens.

### Twelve Data (no MT5 needed)

1. Create a free account at https://twelvedata.com and copy your API key.
2. In `config.json`, set `"source": "twelvedata"` and put the key in `twelvedata.apiKey`.

The free plan allows 800 requests a day and 8 a minute. A check every 5 minutes uses 288 a day; the first start uses up to 4 more to load history. Twelve Data has no volume for gold, so the volume check on the displacement candle is skipped and only its size counts (the console says so once).

### CSV file

If an MT5 script or EA already writes candles to a file, set `"source": "csv"`, `csv.path` to the file and `csv.tzOffsetMinutes` to its time zone (MT5 server time is often 120 or 180). The file is re-read at every check.

## 3. Telegram alerts (optional)

1. In Telegram, open **@BotFather**, send `/newbot` and follow the steps. It gives you a **bot token** like `123456789:AAH...`.
2. Open a chat with your new bot and send it any message (for example `/start`). A bot cannot message you first.
3. Find your **chat id**: open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser (with your token in place of `<YOUR_TOKEN>`) and look for `"chat":{"id":123456789`. That number is the chat id. For a group, add the bot to the group, send a message there and use the group's id (it starts with `-`).
4. Put both in `config.json`:
   ```json
   "telegram": { "botToken": "123456789:AAH...", "chatId": "123456789" }
   ```

The token is never written to the log. If Telegram is down the alert still shows in the console and the scan carries on.

An entry alert looks like this:

```
XAUUSD 5m BUY signal · Pin bar at OB
Entry 4,349.18  SL 4,341.67  TP 4,364.20 (2R)
Swept PDL 4,340.45 at 23:05 · CHoCH 00:10 · IFVG · OB
Next move: 58% up in the next 1h (medium confidence)
Past buy entries: 8 of 22 won (36%)
```

Times are candle open times (as on the chart) in your time zone, India by default (`timeZone` in `config.json`). Set `alerts.on` to `"all"` to also get the steps before an entry: liquidity sweeps, CHoCHs, marked zones and cancelled setups.

## 4. Start it

1. In the `smc-scanner\live` folder, copy `config.example.json` to `config.json` and edit it (Notepad is fine). Every key is explained in the example file. `start-live.bat` makes the copy for you the first time if you skip this.
2. Double-click **`start-live.bat`**. A console window opens and prints one line per check.
3. Open **http://localhost:8787** in your browser for the dashboard.

To stop, close the window or press Ctrl+C. To start it with Windows, put a shortcut to `start-live.bat` in the Startup folder (Win+R, `shell:startup`).

From a Command Prompt in the repository folder you can also run:

```
node smc-scanner\live\runner.js --config smc-scanner\live\config.json
node smc-scanner\live\runner.js --source replay --fast --cycles 20     (demo on the bundled sample)
node smc-scanner\live\runner.js --help
```

## How often it checks

Checks run every `everyMinutes` (5 by default, 5 to 15 allowed), 8 seconds after each 5-minute mark: 10:05:08, 10:10:08 and so on, so each check sees the candle that just closed. The candle still forming is never used. Checks never overlap. If a fetch fails (MT5 closed, internet down) the scanner keeps the last data, shows the error on the dashboard, tries once more after 60 seconds, and then carries on at the normal times.

The 15m chart is built from the 5m candles, so a 15m candle is scanned as soon as its last 5m candle closes.

## What it remembers

Everything lives in `smc-scanner\live\data` (not in git):

| File | What it is |
|---|---|
| `XAUUSD-5m.csv` | The candle history the scanner has collected. It grows every check, up to `historyCandles`. You can load it into the page with **Load your CSV**. |
| `state-XAUUSD.json` | The last candle processed per timeframe and the alerts already sent, so a restart never repeats an alert. |
| `latest-XAUUSD.json` | The last scan, the same data the dashboard shows. |
| `forecasts-XAUUSD.jsonl` | Every forecast the scanner made, so the dashboard can show how they turned out. |

If the laptop was off or asleep, the next check fetches the missed candles. Signals from that gap are counted in the log but not sent, because they are older than `alerts.maxAgeMinutes` (30 by default).

## The forecast

The forecaster (`predict.js`) learns from the collected history what usually came next: which side's liquidity was taken first, and whether price was higher 1 hour and 4 hours later. It is tested walk-forward, so its track record only counts calls made before their outcome was known. **Confidence** is high only when similar calls were right at least 60% of the time over 300 or more past calls; most calls are low confidence. It needs about 2,900 five-minute candles (around 10 trading days) before it starts, and it is retrained every 12 new candles. Treat it as context for a setup, not a signal on its own.
