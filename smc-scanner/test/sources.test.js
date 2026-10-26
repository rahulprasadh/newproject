// Run with: node --test smc-scanner/test/*.test.js
// Data source tests. No internet and no MetaTrader 5: feeds are local mock servers and fixture files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const SMC = require('../engine.js');
const runner = require('../live/runner.js');
const sources = require('../live/sources.js');

// python3 on Linux and macOS, python on Windows; PYTHON overrides
const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const HELPER = path.join(__dirname, '..', 'live', 'mt5_bars.py');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smc-src-'));

function mockServer(handler) {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ url, headers: req.headers });
      const r = handler(req, url) || {};
      res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {}));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(r => server.close(r)),
    }));
  });
}

// Yahoo's chart answer for GC=F: aligned 5m candles, a gap (nulls) and the latest trade as a last, unaligned point
function yahooBody(t0, n) {
  const ts = [...Array(n).keys()].map(k => t0 + k * 300);
  ts.push(t0 + (n - 1) * 300 + 137);
  const col = base => ts.map((t, k) => (k === 2 ? null : base + k));
  return {
    chart: {
      result: [{
        meta: { symbol: 'GC=F', dataGranularity: '5m' }, timestamp: ts,
        indicators: { quote: [{ open: col(4300), high: col(4302), low: col(4298), close: col(4301), volume: ts.map((t, k) => 100 + k) }] },
      }],
      error: null,
    },
  };
}

test('Yahoo: no key, aligned candles only, gaps skipped, server clock and readable errors', async () => {
  const t0 = Date.UTC(2026, 9, 20, 10, 0) / 1000;
  let mode = 'ok';
  const mock = await mockServer((req, url) => {
    if (mode === 'limit') return { status: 429, body: 'Too Many Requests' };
    if (mode === 'error') return { status: 404, body: { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } } };
    return { headers: { date: new Date((t0 + 6 * 300 + 30) * 1000).toUTCString() }, body: yahooBody(t0, 7) };
  });
  try {
    const src = sources.yahoo({ base: mock.url }, { tfMinutes: 5 });
    assert.equal(src.name, 'yahoo');
    const bars = await src.fetchBars({ count: 100, now: t0 + 2000 });
    const req = mock.requests[0];
    assert.equal(req.url.pathname, '/v8/finance/chart/GC%3DF');
    assert.equal(req.url.searchParams.get('interval'), '5m');
    assert.match(req.headers['user-agent'], /Mozilla/);
    // 7 aligned candles, one of them empty, and the unaligned last trade dropped
    assert.deepEqual(bars.map(b => b.t), [0, 1, 3, 4, 5, 6].map(k => t0 + k * 300));
    assert.deepEqual(bars[0], { t: t0, o: 4300, h: 4302, l: 4298, c: 4301, v: 100 });
    assert.equal(src.lastNow, t0 + 6 * 300 + 30);
    assert.equal(runner.closedOnly(bars, 300, src.lastNow).length, 5, 'the forming candle is dropped by the runner');
    // about 10 min late, the newest candle Yahoo sends is the one forming 10 min ago, with seconds traded:
    // by the clock it has closed, but it only counts once a later candle comes or the delay has passed
    const late = t0 + 6 * 300 + 8 + 600;
    assert.equal(runner.closedOnly(bars, 300, late).length, 6, 'by the clock alone the stub would count');
    assert.deepEqual(runner.closedOnly(bars, 300, late, 600).map(b => b.t), [0, 1, 3, 4, 5].map(k => t0 + k * 300));
    assert.equal(runner.closedOnly(bars, 300, t0 + 7 * 300 + 600 + 2, 600).length, 6, 'after the delay it counts');
    assert.equal(src.info.delayedMinutes, 10);
    assert.equal((await src.fetchBars({ count: 2, now: t0 + 2000 })).length, 2);
    mode = 'error';
    await assert.rejects(src.fetchBars({ count: 3 }), /Yahoo Finance error: No data found/);
    mode = 'limit';
    await assert.rejects(src.fetchBars({ count: 3 }), /limiting requests/);
  } finally {
    await mock.close();
  }
});

test('MT5 server time: New York close brokers are converted per candle across US daylight saving', () => {
  const winter = Date.UTC(2026, 11, 1, 12) / 1000, summer = Date.UTC(2026, 6, 1, 12) / 1000;
  // UTC+2 in winter (New York UTC-5) is a New York close server; UTC+0 is not
  assert.equal(sources.serverDst(120, winter), 'us');
  assert.equal(sources.serverDst(180, summer), 'us');
  assert.equal(sources.serverDst(0, winter), 'none');
  assert.equal(sources.serverDst(120, winter, 'none'), 'none');
  // a July candle stamped 15:00 server time (UTC+3) is 12:00 UTC, though the offset today is +2
  const julyServer = Date.UTC(2026, 6, 1, 15) / 1000;
  const flat = julyServer - 120 * 60;
  const [fixed] = sources.fixServerDst([{ t: flat, o: 1, h: 1, l: 1, c: 1, v: 0 }], winter, 'us');
  assert.equal(fixed.t, summer);
  // a candle from the same half of the year is left alone
  const [same] = sources.fixServerDst([{ t: winter - 3600, o: 1, h: 1, l: 1, c: 1, v: 0 }], winter, 'us');
  assert.equal(same.t, winter - 3600);
});

function exportFiles(dir, sym, { offset = 120, written, rows }) {
  const folder = path.join(dir, 'GoldSMC');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = t => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '.');
  fs.writeFileSync(path.join(folder, `${sym}_M5.csv`), 'time,open,high,low,close,tickvolume\r\n'
    + rows.map(([t, o, h, l, c, v]) => `${stamp(t + offset * 60)},${o},${h},${l},${c},${v}`).join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(folder, `${sym}_M5.json`), JSON.stringify({
    symbol: sym, timeframe: 'M5', serverOffsetMinutes: offset, writtenUtc: written, lastCandle: '', connected: true, version: 1,
  }));
  return folder;
}

test('MT5 exporter file: finds the gold export, converts to UTC and spots a stopped MT5', async () => {
  const dir = tmpdir();
  const t0 = Date.UTC(2026, 11, 1, 10, 0) / 1000;   // December: broker at UTC+2, New York UTC-5
  const rows = [0, 1, 2].map(k => [t0 + k * 300, 4300 + k, 4302 + k, 4299 + k, 4301 + k, 50 + k]);
  exportFiles(dir, 'EURUSD', { written: t0 + 900, rows });
  const folder = exportFiles(dir, 'XAUUSD.m', { written: t0 + 900, rows });
  const env = { APPDATA: path.join(dir, 'nowhere') };
  const clock = () => (t0 + 930) * 1000;
  const src = sources.mt5File({ folder }, { tfMinutes: 5, env, clock });
  const bars = await src.fetchBars({ count: 10 });
  assert.equal(src.info.symbol, 'XAUUSD.m', 'gold is preferred over the newest file');
  assert.equal(src.info.dst, 'us');
  assert.deepEqual(bars.map(b => b.t), rows.map(r => r[0]));
  assert.deepEqual(bars[0], { t: t0, o: 4300, h: 4302, l: 4299, c: 4301, v: 50 });
  // the default folder is MT5's Common Files under APPDATA
  assert.equal(sources.mt5CommonDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }),
    path.join('C:\\Users\\me\\AppData\\Roaming', 'MetaQuotes', 'Terminal', 'Common', 'Files'));
  // MT5 closed: the status file stops changing
  const stale = sources.mt5File({ folder }, { tfMinutes: 5, env, clock: () => (t0 + 900 + 600) * 1000 });
  await assert.rejects(stale.fetchBars({}), /has not updated the candles for 10 min/);
  const none = sources.mt5File({ folder: path.join(dir, 'empty') }, { tfMinutes: 5, env, clock });
  await assert.rejects(none.fetchBars({}), /attach the GoldSMCExport expert/);
});

test('MT5 helper finds the broker name for XAUUSD (XAUUSD.m, GOLD) with --find-symbol', () => {
  const dir = tmpdir(), t0 = 1790000100, off = 10800;
  const rates = [{ time: t0 + off, open: 1, high: 2, low: 0.5, close: 1.5, tick_volume: 9 }];
  const ticks = [{ time: t0 + off, time_msc: (t0 + off) * 1000 }, { time: t0 + off + 1, time_msc: (t0 + off + 1) * 1000 }];
  const run = (symbols, extra = []) => {
    const f = path.join(dir, `f${Math.random()}.json`);
    fs.writeFileSync(f, JSON.stringify({ now: t0 + 1, rates, ticks, symbols }));
    const r = spawnSync(PY, ['-I', HELPER, '--count', '1', ...extra], { env: { ...process.env, MT5_FAKE: f }, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim());
  };
  assert.equal(run(['EURUSD', 'XAUUSDT', 'XAUUSD.m'], ['--find-symbol']).symbol, 'XAUUSD.m');
  assert.equal(run(['XAUUSDm', 'XAUEUR'], ['--find-symbol']).symbol, 'XAUUSDm');
  assert.equal(run(['GOLD', 'GOLDEUR'], ['--find-symbol']).symbol, 'GOLD');
  assert.match(run(['EURUSD'], ['--find-symbol']).error, /Symbol XAUUSD was not found/);
  assert.match(run(['XAUUSD.m']).error, /Symbol XAUUSD was not found/, 'only with --find-symbol');
});

test('source auto: the MT5 export first, otherwise the first feed that answers', async () => {
  const dir = tmpdir(), now = Math.floor(Date.now() / 1000);
  const t0 = Math.floor(now / 300) * 300 - 3000;
  const folder = exportFiles(dir, 'XAUUSD', { offset: 0, written: now, rows: [0, 1, 2].map(k => [t0 + k * 300, 1, 2, 0.5, 1.5, 1]) });
  const base = { ...runner.DEFAULTS, mt5: { python: 'no-such-python-here' }, twelvedata: { apiKey: '' } };
  let pick = await sources.pickAuto({ ...base, mt5file: { folder } }, { tfMinutes: 5 });
  assert.equal(pick.name, 'mt5file');
  assert.equal(pick.source.name, 'mt5file');

  const mock = await mockServer(() => ({ body: yahooBody(t0, 5) }));
  try {
    pick = await sources.pickAuto({ ...base, mt5file: { folder: path.join(dir, 'none') }, yahoo: { base: mock.url } }, { tfMinutes: 5 });
    assert.equal(pick.name, 'yahoo');
    const why = Object.fromEntries(pick.tried.map(x => [x.name, x.why]));
    assert.match(why.mt5file, /has not written/);
    assert.match(why.mt5, /Python was not found/);
    assert.equal(why.twelvedata, 'no API key');
    assert.equal(why.yahoo, null);
  } finally {
    await mock.close();
  }
  // nothing answers: no source, every reason listed
  pick = await sources.pickAuto({ ...base, mt5file: { folder: path.join(dir, 'none') }, yahoo: { base: 'http://127.0.0.1:9' } }, { tfMinutes: 5 });
  assert.equal(pick.name, null);
  assert.equal(pick.tried.length, 4);
});
