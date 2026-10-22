"""Turn an OHLCV CSV into data/sample.js, which the scanner page loads as its example chart.

Usage: python3 tools/build_sample.py XAUUSD_5m.csv "source description" > data/sample.js
"""
import csv
import json
import sys
from datetime import datetime


def main(path, source):
    rows = []
    with open(path, newline="") as fh:
        for r in csv.DictReader(fh):
            t = int(datetime.fromisoformat(r["datetime"]).timestamp())
            o, h, l, c = (round(float(r[k]), 2) for k in ("open", "high", "low", "close"))
            rows.append(f"{t},{o:g},{h:g},{l:g},{c:g},{int(float(r['volume']))}")
    payload = {"symbol": "XAUUSD", "source": source, "csv": "t,open,high,low,close,volume\n" + "\n".join(rows)}
    sys.stdout.write("window.SMC_SAMPLE = " + json.dumps(payload) + ";\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
