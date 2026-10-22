"""Read recent candles from the MetaTrader 5 terminal and print them as JSON in true UTC.

Usage:
  python mt5_bars.py --symbol XAUUSD --timeframe M5 --count 5000 [--offset auto|180]
                     [--fallback-offset 180] [--terminal "C:\\Program Files\\MetaTrader 5\\terminal64.exe"]

Prints one line: {"bars": [{"t", "o", "h", "l", "c", "v"}], "serverOffsetMinutes": 180,
"offsetSource": "auto"|"config"|"fallback", "now": <UTC seconds>, "tickFresh": true, "error": null}

MetaTrader 5 gives candle times in the broker's server time written as if it were UTC.
With --offset auto the script measures the server's offset from a live tick:
round((tick time - this PC's time) / 30 min) * 30. That only works while ticks are arriving,
so when the market is closed it uses --fallback-offset (the last measured offset) instead.
It only reads prices; it never places orders.

Set MT5_FAKE to a JSON file to run without MetaTrader 5 (the tests do this). The file stands
in for the module: {"now", "ticks": [{"time", "time_msc", "bid", "ask"}], "rates": [{"time",
"open", "high", "low", "close", "tick_volume"}], "initialize", "connected", "symbols", "last_error"}.
"""
import argparse
import json
import os
import sys
import time
import types

TIMEFRAMES = ("M1", "M5", "M15", "M30", "H1")
MAX_OFFSET_MIN = 14 * 60


class Fail(Exception):
    pass


class FakeMT5:
    """Stands in for the MetaTrader5 module, driven by a JSON fixture. Sleeping moves a fake clock."""

    def __init__(self, spec):
        self.spec = spec
        self.clock = float(spec.get("now", time.time()))
        self.ticks = list(spec.get("ticks", []))
        for name in TIMEFRAMES:
            setattr(self, "TIMEFRAME_" + name, name)

    def initialize(self, path=None, **kw):
        return bool(self.spec.get("initialize", True))

    def last_error(self):
        return tuple(self.spec.get("last_error", [1, "Success"]))

    def terminal_info(self):
        return types.SimpleNamespace(connected=bool(self.spec.get("connected", True)),
                                     maxbars=self.spec.get("maxbars", 100000))

    def symbol_select(self, symbol, enable=True):
        return symbol in self.spec.get("symbols", [symbol])

    def symbol_info_tick(self, symbol):
        if not self.ticks:
            return None
        tick = self.ticks.pop(0) if len(self.ticks) > 1 else self.ticks[0]
        return types.SimpleNamespace(**tick)

    def copy_rates_from_pos(self, symbol, timeframe, start, count):
        rates = self.spec.get("rates")
        if rates is None:
            return None
        return rates[max(0, len(rates) - count):]

    def shutdown(self):
        pass

    def time(self):
        return self.clock

    def sleep(self, seconds):
        self.clock += seconds


def load():
    fake = os.environ.get("MT5_FAKE")
    if fake:
        with open(fake, encoding="utf-8") as fh:
            m = FakeMT5(json.load(fh))
        return m, m.time, m.sleep
    try:
        import MetaTrader5 as mt5
    except ImportError:
        raise Fail("The MetaTrader5 Python package is not installed. Run: pip install MetaTrader5 "
                   "(it works on Windows with the MT5 terminal installed).")
    return mt5, time.time, time.sleep


def err_text(mt5):
    try:
        code, msg = mt5.last_error()
        return "{} {}".format(code, msg)
    except Exception:
        return "no details"


def tick_ms(tick):
    msc = getattr(tick, "time_msc", None)
    return msc if msc else int(tick.time) * 1000


def measure_offset(mt5, symbol, clock, sleep, polls=12, gap=0.25):
    """Watch the tick for up to 3 s. If it changes, the market is live and the newest tick is
    about now in server time, so (tick - now) rounded to 30 min is the offset. Returns
    (offset minutes or None, latest tick or None)."""
    first = mt5.symbol_info_tick(symbol)
    if first is None:
        return None, None
    for _ in range(polls):
        sleep(gap)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            return None, first
        if tick_ms(tick) != tick_ms(first):
            diff = tick.time - clock()
            minutes = int(round(diff / 1800.0)) * 30
            if abs(diff - minutes * 60) <= 120 and abs(minutes) <= MAX_OFFSET_MIN:
                return minutes, tick
            return None, tick
    return None, first


def main(argv=None):
    p = argparse.ArgumentParser(description="Print recent MetaTrader 5 candles as JSON in UTC.")
    p.add_argument("--symbol", default="XAUUSD")
    p.add_argument("--timeframe", default="M5", choices=TIMEFRAMES)
    p.add_argument("--count", type=int, default=5000)
    p.add_argument("--offset", default="auto", help="'auto' or the server's offset from UTC in minutes")
    p.add_argument("--fallback-offset", type=int, default=None)
    p.add_argument("--terminal", default=None, help="path to terminal64.exe when several are installed")
    a = p.parse_args(argv)

    out = {"bars": [], "serverOffsetMinutes": None, "offsetSource": None, "now": None,
           "tickFresh": False, "symbol": a.symbol, "error": None}
    mt5 = None
    try:
        mt5, clock, sleep = load()
        ok = mt5.initialize(path=a.terminal) if a.terminal else mt5.initialize()
        if not ok:
            raise Fail("Could not connect to the MetaTrader 5 terminal ({}). Open MT5, log in to your "
                       "broker account and keep it running.".format(err_text(mt5)))
        info = mt5.terminal_info()
        if info is not None and not getattr(info, "connected", True):
            raise Fail("MetaTrader 5 is open but not connected to the broker. Check the login and "
                       "the internet connection in the terminal.")
        if not mt5.symbol_select(a.symbol, True):
            raise Fail("Symbol {} was not found. Use the exact name from MT5's Market Watch "
                       "(for example XAUUSD, XAUUSD.m or GOLD) in mt5.symbol.".format(a.symbol))

        measured, tick = measure_offset(mt5, a.symbol, clock, sleep)
        fresh = measured is not None
        if a.offset != "auto":
            try:
                offset = int(float(a.offset))
            except ValueError:
                raise Fail("serverUtcOffsetMinutes must be 'auto' or a number of minutes, not {!r}".format(a.offset))
            source = "config"
        elif fresh:
            offset, source = measured, "auto"
        elif a.fallback_offset is not None:
            offset, source = a.fallback_offset, "fallback"
        else:
            raise Fail("No live ticks (the market looks closed), so the broker's server time offset "
                       "cannot be measured. Start the scanner while the market is open once, or set "
                       "mt5.serverUtcOffsetMinutes in config.json (often 120 in winter, 180 in summer).")

        tf = getattr(mt5, "TIMEFRAME_" + a.timeframe)
        count = max(1, a.count)
        maxbars = getattr(info, "maxbars", None) if info is not None else None
        if maxbars:
            count = min(count, int(maxbars))  # MT5 refuses more than "Max bars in chart"
        rates = mt5.copy_rates_from_pos(a.symbol, tf, 0, count)
        while rates is None and count > 1000:
            count //= 2
            rates = mt5.copy_rates_from_pos(a.symbol, tf, 0, count)
        if rates is None:
            raise Fail("MetaTrader 5 returned no candles for {} ({}). Open a {} chart once so the "
                       "terminal downloads its history.".format(a.symbol, err_text(mt5), a.timeframe))
        shift = offset * 60
        bars = []
        for r in rates:
            bars.append({
                "t": int(r["time"]) - shift,
                "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]), "c": float(r["close"]),
                "v": int(r["tick_volume"]),
            })
        out.update({
            "bars": bars, "serverOffsetMinutes": offset, "offsetSource": source, "tickFresh": fresh,
            # the broker's clock when a tick just arrived, otherwise this PC's
            "now": (int(tick.time) - shift) if fresh else int(clock()),
        })
    except Fail as e:
        out["error"] = str(e)
    except Exception as e:  # report anything else as JSON too, so the scanner can show it
        out["error"] = "The MetaTrader 5 helper failed: {}: {}".format(type(e).__name__, e)
    finally:
        if mt5 is not None:
            try:
                mt5.shutdown()
            except Exception:
                pass
    sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\n")
    return 0 if out["error"] is None else 1


if __name__ == "__main__":
    sys.exit(main())
