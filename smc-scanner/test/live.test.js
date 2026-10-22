// Run with: node --test smc-scanner/test/*.test.js
// Live scanner tests. No internet: Twelve Data and Telegram are local mock servers, MT5 is a fixture.
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
const alerts = require('../live/alerts.js');

const LIVE = path.join(__dirname, '..', 'live');
const HELPER = path.join(LIVE, 'mt5_bars.py');
const OPTS = { spread: 0.25 };

let sampleCache = null;
const sample = () => sampleCache || (sampleCache = sources.loadSample().bars);

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smc-live-'));
const quiet = () => {
  const lines = [];
  const log = m => lines.push(String(m));
  log.lines = lines;
  return log;
};
const collector = () => {
  const sent = [];
  return { sent, telegramEnabled: false, send: async a => { sent.push(a); return { console: true, telegram: null }; } };
};

// Start a local HTTP server; handler(req, body, url) returns {status, headers, body} (body may be an object).
function mockServer(handler) {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push({ method: req.method, path: req.url, url, headers: req.headers, body });
        const r = handler(req, body, url) || {};
        const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {});
        res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
        res.end(text);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`, requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

function get(port, urlPath, { host, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = host ? { host } : {};
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- candles ----------

test('closed-candle filter drops the forming candle and keeps a candle 2 s after it closes', () => {
  const t0 = 1790000100;   // a 5-minute boundary
  const bars = [0, 1, 2, 3].map(k => ({ t: t0 + k * 300, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }));
  const ts = list => list.map(b => (b.t - t0) / 300);
  // halfway through candle 3: it is still forming
  assert.deepEqual(ts(runner.closedOnly(bars, 300, t0 + 3 * 300 + 150)), [0, 1, 2]);
  // candle 3 ends at t0 + 1200: 1 s later it is not trusted yet, 2 s later it is
  assert.deepEqual(ts(runner.closedOnly(bars, 300, t0 + 1201)), [0, 1, 2]);
  assert.deepEqual(ts(runner.closedOnly(bars, 300, t0 + 1202)), [0, 1, 2, 3]);
  // on 15m the same candles are all still inside one forming 15m candle until it ends
  assert.deepEqual(runner.closedOnly([{ t: t0 - 100 }], 900, t0 + 700).length, 0);
});

test('the replay feed includes a cut-short forming candle, which the filter drops', async () => {
  const bars = sample();
  const src = sources.replay({ startIndex: 500 }, { tfMinutes: 5, bars, startNow: bars[500].t + 130 });
  const got = await src.fetchBars({ count: 50 });
  assert.equal(got.length, 50);
  const last = got[got.length - 1];
  assert.equal(last.t, bars[500].t, 'the forming candle is in the feed');
  assert.notDeepEqual(last, bars[500], 'and it is only part-formed');
  const closed = runner.closedOnly(got, 300, src.lastNow);
  assert.equal(closed[closed.length - 1].t, bars[499].t);
  assert.deepEqual(closed[closed.length - 1], bars[499]);
  // the next fetch moves the virtual clock on by 5 minutes
  await src.fetchBars({ count: 5 });
  assert.equal(src.lastNow, bars[500].t + 130 + 300);
});

test('merge appends, corrects the newest candles, ignores the settled middle and backfills', () => {
  const t0 = 1790000100;
  const bar = (k, c = 100 + k) => ({ t: t0 + k * 300, o: c, h: c + 1, l: c - 1, c, v: 10 });
  const hist = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => bar(k));

  // first fetch: unsorted with a duplicate, the later copy wins
  let m = runner.mergeBars([], [bar(2), bar(0), bar(1), { ...bar(1), c: 101.5, h: 102 }]);
  assert.deepEqual(m.bars.map(b => b.t), [t0, t0 + 300, t0 + 600]);
  assert.equal(m.bars[1].c, 101.5);
  assert.equal(m.added, 3);

  // same candles again: nothing changes
  m = runner.mergeBars(hist, hist.slice(-5));
  assert.equal(m.bars, hist);
  assert.deepEqual([m.added, m.revised, m.inserted], [0, 0, 0]);

  // a revised last candle and two new ones
  m = runner.mergeBars(hist, [bar(8), { ...bar(9), c: 109.4, l: 108 }, bar(10), bar(11)]);
  assert.equal(m.revised, 1);
  assert.equal(m.added, 2);
  assert.equal(m.bars.length, 12);
  assert.equal(m.bars[9].c, 109.4);
  assert.deepEqual(m.bars.map(b => b.t), [...Array(12).keys()].map(k => t0 + k * 300));

  // an old candle with other prices (e.g. the broker clock shifted) does not overwrite history
  m = runner.mergeBars(hist, [{ ...bar(2), c: 50, l: 49 }]);
  assert.equal(m.ignored, 1);
  assert.equal(m.bars, hist);

  // a candle missing near the end is filled in, and older candles go in front
  const gappy = hist.filter((_, k) => k !== 8);
  m = runner.mergeBars(gappy, [bar(8), bar(-2), bar(-1)]);
  assert.equal(m.inserted, 1);
  assert.equal(m.prepended, 2);
  assert.deepEqual(m.bars.map(b => (b.t - t0) / 300), [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // the history file round-trips
  const dir = tmpdir(), file = path.join(dir, 'h.csv');
  fs.writeFileSync(file, runner.historyText(m.bars));
  assert.deepEqual(runner.readHistory(file), m.bars);
  assert.deepEqual(SMC.parseCSV(fs.readFileSync(file, 'utf8')), m.bars, 'the page can load the history file too');
  assert.deepEqual(runner.readHistory(path.join(dir, 'missing.csv')), []);
});

test('15m candles are built from 5m and the last one waits for its third 5m candle', () => {
  const bars = sample().slice(0, 9);   // nine 5m candles from a 15-minute boundary
  assert.equal(bars[0].t % 900, 0);
  assert.equal(bars[8].t - bars[0].t, 8 * 300);
  const full = runner.resampleClosed(bars, 300, 900);
  assert.deepEqual(full, SMC.resample(bars, 900));
  assert.equal(full.length, 3);
  // without the last 5m candle the third 15m candle is still forming and is left out
  const cut = runner.resampleClosed(bars.slice(0, -1), 300, 900);
  assert.deepEqual(cut, full.slice(0, 2));
  assert.equal(runner.resampleClosed(bars, 300, 300), bars);
});

// ---------- signals ----------

test('every event becomes an alert exactly once across checks of any size', () => {
  const bars = sample().slice(0, 9000);
  const steps = [1, 7, 150, 3, 90, 233, 1, 1, 60, 118, 2, 300];
  const seen = new Map();
  let lastT = bars[1499].t, c = 1500, k = 0;
  while (c < bars.length) {
    c = Math.min(bars.length, c + steps[k++ % steps.length]);
    const E = SMC.run(bars.slice(0, c), OPTS);
    for (const a of runner.collectAlerts(E, { lastT, mode: 'all' })) {
      const key = `${a.kind}:${a.dir}:${E.bars[a.at].t}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    lastT = E.bars[c - 1].t;
  }
  const full = SMC.run(bars, OPTS);
  const expected = runner.collectAlerts(full, { lastT: bars[1499].t, mode: 'all' })
    .map(a => `${a.kind}:${a.dir}:${bars[a.at].t}`);
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual([...seen.keys()].sort(), expected.sort());
  for (const [key, n] of seen) assert.equal(n, 1, `${key} was alerted ${n} times`);
  const kinds = new Set(expected.map(x => x.split(':')[0]));
  for (const kind of ['sweep', 'choch', 'armed', 'entry', 'result']) assert.ok(kinds.has(kind), `no ${kind} alert in the sample`);
  const entries = full.events.filter(e => e.type === 'entry' && e.at >= 1500).length;
  assert.equal(expected.filter(x => x.startsWith('entry:')).length, entries);
  // entry mode: entries and results only
  const quietKinds = new Set(runner.collectAlerts(full, { lastT: bars[1499].t, mode: 'entry' }).map(a => a.kind));
  assert.deepEqual([...quietKinds].sort(), ['entry', 'result']);
});

test('entry alert text matches the agreed format, in India time', () => {
  const view = {
    kind: 'entry', symbol: 'XAUUSD', tfMin: 5, dir: 'bull', timeZone: 'Asia/Kolkata',
    setup: { label: 'PDL', levelPrice: 4340.45, sweepT: Date.UTC(2026, 8, 20, 17, 35) / 1000, chochT: Date.UTC(2026, 8, 20, 18, 40) / 1000, fvgKind: 'IFVG' },
    entry: { dir: 'bull', pattern: 'Pin bar', zone: 'OB', entry: 4349.18, sl: 4341.67, tp: 4364.2, rr: 2, tpSrc: 'rr' },
    forecast: { horizons: [{ minutes: 60, pUp: 0.58, confidence: 'medium' }, { minutes: 240, pUp: 0.4, confidence: 'low' }] },
    odds: null,
  };
  assert.equal(alerts.message(view), 'XAUUSD 5m BUY signal · Pin bar at OB\nEntry 4,349.18  SL 4,341.67  TP 4,364.20 (2R)\n'
    + 'Swept PDL 4,340.45 at 23:05 · CHoCH 00:10 · IFVG · OB\nNext move: 58% up in the next 1h (medium confidence)');
  const sell = {
    ...view, dir: 'bear',
    entry: { ...view.entry, dir: 'bear', pattern: 'Head & shoulders', tpSrc: 'PDL', rr: 2.34 },
    forecast: { horizons: [{ minutes: 60, pUp: 0.3, confidence: 'low' }] },
    odds: { pWinFromHere: { p: 0.4, n: 10 } },
  };
  const lines = alerts.message(sell).split('\n');
  assert.equal(lines[0], 'XAUUSD 5m SELL signal · Head & shoulders at OB');
  assert.match(lines[1], /\(2\.3R at PDL\)$/);
  assert.equal(lines[3], 'Next move: 70% down in the next 1h (low confidence)');
  assert.equal(lines[4], 'Past sell entries: 4 of 10 won (40%)');
  assert.equal(alerts.clock(Date.UTC(2026, 8, 20, 17, 35) / 1000, 'Europe/London'), '18:35');
});

// ---------- scheduling ----------

test('checks are aligned to candle closes plus 8 s', () => {
  const at = (h, m, s) => Date.UTC(2026, 9, 20, h, m, s);
  assert.equal(runner.nextRunAt(at(10, 5, 3), 5), at(10, 5, 8));
  assert.equal(runner.nextRunAt(at(10, 5, 8), 5), at(10, 10, 8));
  assert.equal(runner.nextRunAt(at(10, 5, 9), 5), at(10, 10, 8));
  assert.equal(runner.nextRunAt(at(10, 7, 0), 5), at(10, 10, 8));
  assert.equal(runner.nextRunAt(at(10, 9, 59), 10), at(10, 10, 8));
  assert.equal(runner.nextRunAt(at(10, 10, 9), 10), at(10, 20, 8));
  assert.equal(runner.nextRunAt(at(10, 5, 9), 15), at(10, 15, 8));
  assert.equal(runner.nextRunAt(at(23, 59, 30), 5), at(24, 0, 8));
});

test('a failed fetch is retried once after 60 s, then checks go back to the aligned times', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const at = (h, m, s) => Date.UTC(2026, 9, 20, h, m, s);
  let now = at(10, 5, 9), fails = 2;
  const calls = [];
  const bars = sample().slice(0, 400);
  const source = {
    name: 'csv', lastNow: null, info: {},
    fetchBars: async () => {
      calls.push(now);
      if (fails-- > 0) throw new Error('MetaTrader 5 is closed');
      return bars;
    },
  };
  const cfg = runner.loadConfig(null, { source: 'csv' });
  const log = quiet();
  const S = new runner.LiveScanner(cfg, { dataDir: tmpdir(), source, notifier: collector(), log, clock: () => now });
  const settle = () => new Promise(r => setImmediate(r));
  const done = S.run({ cycles: 3 });
  await settle();
  assert.deepEqual(calls, [at(10, 5, 9)]);
  assert.equal(S.health.ok, false);
  assert.equal(S.health.error, 'MetaTrader 5 is closed');
  assert.equal(S.nextRunAt, at(10, 6, 9), 'one retry a minute later');
  assert.match(log.lines.join('\n'), /Fetch failed: MetaTrader 5 is closed\. Keeping the last data; trying again at /);
  now = at(10, 6, 9);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(calls[1], at(10, 6, 9));
  assert.equal(S.nextRunAt, at(10, 10, 8), 'after the retry fails, back to the normal time');
  now = at(10, 10, 8);
  t.mock.timers.tick(at(10, 10, 8) - at(10, 6, 9));
  await done;
  assert.equal(calls[2], at(10, 10, 8));
  assert.equal(S.health.ok, true);
  assert.equal(S.history.length, 400);
});

test('a feed that is seconds late with the candle that just closed is asked once more', async () => {
  const bars = sample().slice(0, 400);
  assert.equal(bars[399].t - bars[398].t, 300);
  const now = bars[399].t + 300 + 8;   // 8 s after candle 399 closed
  const run = async (name, answers) => {
    const calls = [];
    const source = { name, lastNow: null, info: {}, fetchBars: async () => answers[Math.min(calls.push(1), answers.length) - 1] };
    const S = new runner.LiveScanner(runner.loadConfig(null, { source: 'csv' }), {
      dataDir: tmpdir(), source, notifier: collector(), log: quiet(), clock: () => now * 1000,
      lateRetryMs: 20000, sleep: async ms => { calls.push(`slept ${ms}`); },
    });
    const r = await S.cycle();
    assert.equal(r.ok, true);
    return { calls, last: S.history[S.history.length - 1].t };
  };
  let r = await run('twelvedata', [bars.slice(0, 399), bars]);
  assert.deepEqual(r.calls, [1, 'slept 20000', 1]);
  assert.equal(r.last, bars[399].t, 'the late candle is in');
  r = await run('twelvedata', [bars]);
  assert.deepEqual(r.calls, [1], 'no second fetch when nothing is missing');
  r = await run('twelvedata', [bars.slice(0, 300)]);
  assert.deepEqual(r.calls, [1], 'no second fetch when the market is closed (nothing for a while)');
});

test('checks never overlap', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const source = { name: 'csv', lastNow: null, info: {}, fetchBars: async () => { await gate; return sample().slice(0, 300); } };
  const S = new runner.LiveScanner(runner.loadConfig(null, { source: 'csv' }), { dataDir: tmpdir(), source, notifier: collector(), log: quiet() });
  const first = S.cycle();
  const second = await S.cycle();
  assert.equal(second.skipped, true);
  release();
  assert.equal((await first).ok, true);
});

// ---------- sources ----------

test('Twelve Data: request, parsing, server clock, paging and the error status', async () => {
  const t0 = Date.UTC(2026, 9, 20, 10, 0) / 1000;
  const series = [...Array(8000).keys()].map(k => t0 - (7999 - k) * 300);
  const row = t => {
    const d = new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');
    return { datetime: d, open: '4300.10', high: '4301.50', low: '4299.00', close: '4300.80' };
  };
  const serverTime = new Date((t0 + 130) * 1000).toUTCString();
  const mock = await mockServer((req, body, url) => {
    const q = url.searchParams;
    if (q.get('apikey') !== 'KEY') {
      return { body: { code: 401, message: `**apikey** ${q.get('apikey')} is incorrect`, status: 'error' } };
    }
    let list = series;
    if (q.get('end_date')) {
      const end = Date.parse(q.get('end_date').replace(' ', 'T') + 'Z') / 1000;
      list = list.filter(t => t <= end);
    }
    list = list.slice(-Math.min(5000, +q.get('outputsize')));
    return { headers: { date: serverTime }, body: { meta: { symbol: 'XAU/USD' }, values: list.map(row), status: 'ok' } };
  });
  try {
    const src = sources.twelveData({ apiKey: 'KEY', base: mock.url }, { tfMinutes: 5 });
    assert.equal(src.name, 'twelvedata');
    const bars = await src.fetchBars({ count: 3 });
    const q = mock.requests[0].url.searchParams;
    assert.equal(mock.requests[0].url.pathname, '/time_series');
    assert.deepEqual(
      ['symbol', 'interval', 'outputsize', 'timezone', 'order', 'apikey'].map(k => q.get(k)),
      ['XAU/USD', '5min', '3', 'UTC', 'ASC', 'KEY'],
    );
    assert.deepEqual(bars.map(b => b.t), series.slice(-3));
    assert.deepEqual(bars[0], { t: series[7997], o: 4300.1, h: 4301.5, l: 4299, c: 4300.8, v: 0 });
    assert.equal(src.lastNow, t0 + 130, 'the Date header is the clock');
    // the last value is the candle still forming
    assert.equal(runner.closedOnly(bars, 300, src.lastNow).length, 2);

    // a longer history comes in pages of 5000
    const long = await src.fetchBars({ count: 7000 });
    assert.equal(long.length, 7000);
    assert.deepEqual(long.map(b => b.t), series.slice(-7000));
    const paged = mock.requests.slice(1);
    assert.equal(paged.length, 2);
    assert.equal(paged[1].url.searchParams.get('end_date'), new Date((series[3000] - 1) * 1000).toISOString().slice(0, 19).replace('T', ' '));

    // the error status becomes a readable error without the key in it
    const bad = sources.twelveData({ apiKey: 'BADKEY123', base: mock.url }, { tfMinutes: 5 });
    await assert.rejects(bad.fetchBars({ count: 3 }), err => {
      assert.match(err.message, /^Twelve Data error 401: \*\*apikey\*\*/);
      assert.ok(!err.message.includes('BADKEY123'));
      return true;
    });
    await assert.rejects(sources.twelveData({}, {}).fetchBars({ count: 3 }), /No Twelve Data API key/);
    assert.deepEqual(sources.parseTwelveData({ status: 'ok', values: [] }), []);
  } finally {
    await mock.close();
  }
});

test('Telegram: payload shape, token never logged, failures tolerated', async () => {
  const TOKEN = '123456789:AAHsecretTOKEN-value_x';
  let mode = 'ok';
  const mock = await mockServer(() => {
    if (mode === 'ok') return { body: { ok: true, result: { message_id: 1 } } };
    if (mode === '401') return { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` } };
    if (mode === 'chat') return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
    return { status: 500, body: '<html>oops</html>' };
  });
  const log = quiet();
  const printed = [];
  const notifier = alerts.createNotifier(
    { console: true, bell: true, telegram: { botToken: TOKEN, chatId: '42', base: mock.url } },
    { log, write: s => printed.push(s), isTTY: false },
  );
  const alert = { kind: 'entry', dir: 'bull', text: 'XAUUSD 5m BUY signal · Pin bar at OB\nEntry 4,349.18' };
  try {
    assert.equal(notifier.telegramEnabled, true);
    let r = await notifier.send(alert);
    assert.deepEqual(r, { console: true, telegram: true });
    const req = mock.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url.pathname, `/bot${TOKEN}/sendMessage`);
    assert.match(req.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(req.body), { chat_id: '42', text: alert.text, disable_web_page_preview: true });
    assert.match(printed.join(''), /XAUUSD 5m BUY signal/);
    assert.ok(!printed.join('').includes('\x07'), 'no bell when not a terminal');

    for (mode of ['401', 'chat', '500']) {
      r = await notifier.send(alert);
      assert.equal(r.telegram, false, mode);
      assert.equal(r.console, true);
    }
    await mock.close();
    r = await notifier.send(alert);   // nothing listening any more
    assert.equal(r.telegram, false);
    const text = log.lines.join('\n');
    assert.match(text, /check the bot token/);
    assert.match(text, /check the chat id/);
    assert.match(text, /Telegram unreachable/);
    assert.ok(!text.includes(TOKEN) && !text.includes('AAHsecretTOKEN'), 'the token must never reach the log');
    // the direct call never throws either
    const direct = await alerts.sendTelegram({ botToken: TOKEN, chatId: '1', text: 'x', base: 'http://127.0.0.1:1' });
    assert.equal(direct.ok, false);
    assert.ok(!direct.error.includes(TOKEN));
  } finally {
    await mock.close().catch(() => {});
  }
});

function fixture(dir, name, spec) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

function helper(args, fake) {
  const env = { ...process.env };
  if (fake) env.MT5_FAKE = fake;
  else delete env.MT5_FAKE;
  const r = spawnSync('python3', ['-I', HELPER, ...args], { env, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: JSON.parse(r.stdout.trim()), err: r.stderr };
}

test('MT5 helper converts server time to UTC with the measured offset (python3 -I, fake MT5)', async () => {
  const dir = tmpdir();
  const t0 = 1790000100, now = t0 + 130, off = 10800;   // server is UTC+3
  const rates = [-600, -300, 0].map((d, k) => ({ time: t0 + d + off, open: 4300 + k, high: 4302 + k, low: 4299 + k, close: 4301 + k, tick_volume: 50 + k }));
  const live = fixture(dir, 'live.json', {
    now, rates,
    ticks: [{ time: now + off - 1, time_msc: (now + off - 1) * 1000, bid: 4301, ask: 4301.25 },
      { time: now + off, time_msc: (now + off) * 1000 + 250, bid: 4301.1, ask: 4301.35 }],
  });
  let r = helper(['--symbol', 'XAUUSD', '--timeframe', 'M5', '--count', '3'], live);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.error, null);
  assert.equal(r.out.serverOffsetMinutes, 180);
  assert.equal(r.out.offsetSource, 'auto');
  assert.equal(r.out.tickFresh, true);
  assert.equal(r.out.now, now);
  assert.deepEqual(r.out.bars.map(b => b.t), [t0 - 600, t0 - 300, t0]);
  assert.deepEqual(r.out.bars[0], { t: t0 - 600, o: 4300, h: 4302, l: 4299, c: 4301, v: 50 });

  // market closed: the tick never changes, so the fallback (last measured) offset is used
  const closed = fixture(dir, 'closed.json', { now, rates, ticks: [{ time: now + off - 7200, time_msc: (now + off - 7200) * 1000 }] });
  r = helper(['--count', '3', '--fallback-offset', '120'], closed);
  assert.equal(r.out.error, null);
  assert.equal(r.out.offsetSource, 'fallback');
  assert.equal(r.out.serverOffsetMinutes, 120);
  assert.equal(r.out.tickFresh, false);
  assert.deepEqual(r.out.bars.map(b => b.t), [t0 - 600 + 3600, t0 - 300 + 3600, t0 + 3600]);
  r = helper(['--count', '3', '--offset', '180'], closed);
  assert.equal(r.out.offsetSource, 'config');
  assert.equal(r.out.bars[2].t, t0);
  r = helper(['--count', '3'], closed);
  assert.equal(r.code, 1);
  assert.match(r.out.error, /market looks closed.*serverUtcOffsetMinutes/);

  // clear errors for the usual problems
  r = helper(['--count', '3'], fixture(dir, 'off.json', { now, rates, connected: false }));
  assert.match(r.out.error, /not connected to the broker/);
  r = helper(['--count', '3'], fixture(dir, 'init.json', { now, rates, initialize: false, last_error: [-10003, 'IPC initialize failed'] }));
  assert.match(r.out.error, /Could not connect to the MetaTrader 5 terminal \(-10003 IPC initialize failed\)/);
  r = helper(['--symbol', 'XAUUSD.m', '--count', '3'], fixture(dir, 'sym.json', { now, rates, symbols: ['XAUUSD'] }));
  assert.match(r.out.error, /Symbol XAUUSD\.m was not found/);
  r = helper(['--count', '3'], null);
  assert.match(r.out.error, /pip install MetaTrader5/);
  assert.deepEqual(r.out.bars, []);

  // through the Node adapter, which remembers the measured offset for when the market closes
  const src = sources.mt5({ python: 'python3', pythonArgs: ['-I'], symbol: 'XAUUSD' }, { tfMinutes: 5, env: { ...process.env, MT5_FAKE: live } });
  const bars = await src.fetchBars({ count: 3 });
  assert.deepEqual(bars.map(b => b.t), [t0 - 600, t0 - 300, t0]);
  assert.equal(src.lastNow, now);
  assert.equal(src.knownOffset, 180);
  assert.equal(runner.closedOnly(bars, 300, src.lastNow).length, 2);
  const later = sources.mt5({ python: 'python3', pythonArgs: ['-I'] }, { tfMinutes: 5, knownOffset: 180, env: { ...process.env, MT5_FAKE: closed } });
  const kept = await later.fetchBars({ count: 3 });
  assert.equal(later.info.offsetSource, 'fallback');
  assert.equal(kept[2].t, t0);
  const broken = sources.mt5({ python: 'python3', pythonArgs: ['-I'] }, { tfMinutes: 5, env: { ...process.env, MT5_FAKE: fixture(dir, 'x.json', { now, rates, connected: false }) } });
  await assert.rejects(broken.fetchBars({ count: 3 }), /not connected/);
  const noPython = sources.mt5({ python: 'no-such-python-here' }, { tfMinutes: 5 });
  await assert.rejects(noPython.fetchBars({ count: 3 }), /Python was not found/);
});

test('CSV source re-reads the file and builds 5m from 1m candles', async () => {
  const dir = tmpdir(), file = path.join(dir, 'm1.csv');
  const t0 = 1790000100;
  const rows = [...Array(15).keys()].map(k => `${new Date((t0 + k * 60) * 1000).toISOString().slice(0, 19).replace('T', ' ')},10,11,9,10.5,${k + 1}`);
  fs.writeFileSync(file, 'time,open,high,low,close,tick_volume\n' + rows.join('\n'));
  const src = sources.csvFile({ path: 'm1.csv', tzOffsetMinutes: 0 }, { tfMinutes: 5, baseDir: dir });
  const bars = await src.fetchBars({ count: 100 });
  assert.deepEqual(bars.map(b => b.t), [t0, t0 + 300, t0 + 600]);
  assert.equal(bars[0].v, 1 + 2 + 3 + 4 + 5);
  await assert.rejects(sources.csvFile({ path: 'nope.csv' }, { baseDir: dir }).fetchBars({}), /does not exist/);
});

// ---------- config ----------

test('config: the example parses, notes are ignored, command-line options win', () => {
  const cfg = runner.loadConfig(path.join(LIVE, 'config.example.json'));
  assert.equal(cfg.source, 'mt5');
  assert.equal(cfg.engine.spread, 0.25);
  assert.deepEqual(cfg.timeframes, [5, 15]);
  assert.equal(cfg.alerts.on, 'entry');
  assert.equal(cfg._source, undefined);
  assert.equal(cfg.mt5.serverUtcOffsetMinutes, 'auto');
  const args = runner.parseArgs(['--config', 'x.json', '--source', 'replay', '--timeframes', '15,5', '--every=10', '--port', '9000', '--once']);
  assert.equal(args.config, 'x.json');
  assert.equal(args.once, true);
  const over = runner.loadConfig(path.join(LIVE, 'config.example.json'), args.overrides);
  assert.equal(over.source, 'replay');
  assert.deepEqual(over.timeframes, [5, 15]);
  assert.equal(over.everyMinutes, 10);
  assert.equal(over.port, 9000);
  assert.equal(over.mt5.symbol, 'XAUUSD', 'nested defaults survive');
  assert.equal(runner.loadConfig(null, { everyMinutes: 1 }).everyMinutes, 5);
  assert.throws(() => runner.loadConfig(null, { timeframes: [5, 7] }), /not a multiple/);
  assert.throws(() => runner.parseArgs(['--bogus']), /Unknown option/);
});

// ---------- end to end ----------

test('replay end to end: an entry is alerted once, a restart does not repeat it, and /api/state is consistent', async () => {
  const bars = sample();
  const full = SMC.run(bars, OPTS);
  const target = full.events.find(e => e.type === 'entry' && e.at > 10000);
  assert.ok(target, 'the sample has an entry after candle 10,000');
  const entryT = bars[target.at].t;
  const cfg = runner.loadConfig(null, {
    source: 'replay', replay: { startIndex: target.at - 4 }, engine: OPTS,
    alerts: { on: 'all', maxAgeMinutes: 1e6 },
  });
  const dir = tmpdir();
  const A = new runner.LiveScanner(cfg, { dataDir: dir, notifier: collector(), log: quiet(), source: sources.replay(cfg.replay, { tfMinutes: 5, bars }) });
  for (let k = 0; k < 60 && A.history[A.history.length - 1]?.t !== entryT; k++) {
    const r = await A.cycle();
    assert.equal(r.ok, true, r.error);
  }
  assert.equal(A.history[A.history.length - 1].t, entryT, 'the entry candle is the newest candle');
  const sentA = A.notifier.sent;
  const entryAlerts = sentA.filter(a => a.kind === 'entry' && a.tfMin === 5 && a.t === entryT);
  assert.equal(entryAlerts.length, 1);
  assert.match(entryAlerts[0].text, /^XAUUSD 5m (BUY|SELL) signal · /);
  assert.ok(fs.existsSync(A.files.history) && fs.existsSync(A.files.state) && fs.existsSync(A.files.latest));
  assert.ok(/-replay-5m\.csv$/.test(A.files.history), 'replay data is kept apart from live history');

  // restart on the same candles: the saved state stops a second alert
  const again = () => sources.replay(cfg.replay, { tfMinutes: 5, bars, startNow: A.state.replayNow });
  const B = new runner.LiveScanner(cfg, { dataDir: dir, notifier: collector(), log: quiet(), source: again() });
  let r = await B.cycle();
  assert.equal(r.ok, true);
  assert.equal(B.history[B.history.length - 1].t, entryT);
  assert.equal(B.notifier.sent.length, 0, 'nothing is repeated after a restart');

  // without the saved state the same restart would alert the entry again
  const dir2 = tmpdir();
  fs.copyFileSync(A.files.history, path.join(dir2, path.basename(A.files.history)));
  const C = new runner.LiveScanner(cfg, { dataDir: dir2, notifier: collector(), log: quiet(), source: again() });
  await C.cycle();
  assert.equal(C.notifier.sent.filter(a => a.kind === 'entry' && a.t === entryT).length, 1);

  // B carries on: still exactly one alert per signal across both runs
  for (let k = 0; k < 4; k++) {
    r = await B.cycle();
    assert.equal(r.ok, true);
  }
  const keys = sentA.concat(B.notifier.sent).map(a => a.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.filter(k => k === `5:entry:${target.dir}:${entryT}`).length, 1);

  // the dashboard API
  const server = runner.createServer(B);
  const port = await runner.listen(server, 0);
  try {
    const res = await get(port, '/api/state');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    const s = JSON.parse(res.body);
    assert.equal(s.symbol, 'XAUUSD');
    assert.equal(s.source, 'replay');
    assert.equal(s.live, false);
    assert.equal(s.health.ok, true);
    assert.ok(s.updatedAt && s.health.lastFetchAt);
    assert.deepEqual(Object.keys(s.timeframes), ['5', '15']);
    const hist = runner.readHistory(B.files.history);
    const ref = { 5: SMC.run(hist, OPTS), 15: SMC.run(runner.resampleClosed(hist, 300, 900), OPTS) };
    for (const tf of ['5', '15']) {
      const T = s.timeframes[tf], E = ref[tf], n = E.bars.length;
      for (const k of ['tf', 'bars', 'setups', 'liq', 'summary', 'recentSignals', 'forecast', 'quality']) assert.ok(k in T, `${tf}m has ${k}`);
      assert.equal(T.tf, +tf * 60);
      assert.equal(T.bars.length, Math.min(1500, n));
      assert.equal(T.totalCandles, n);
      const off = T.windowStart;
      assert.equal(off, n - T.bars.length);
      assert.deepEqual(T.bars[T.bars.length - 1], E.bars[n - 1]);
      for (const b of T.bars) assert.equal(b.t % (+tf * 60), 0);
      assert.deepEqual(T.summary, E.summary());
      const byId = new Map(E.setups.map(x => [x.id, x]));
      assert.ok(T.setups.length > 0);
      for (const st of T.setups) {
        const o = byId.get(st.id);
        assert.ok(st.sweepAt >= 0 && st.sweepAt < T.bars.length);
        assert.equal(T.bars[st.sweepAt].t, E.bars[o.sweepAt].t);
        assert.equal(st.level.t, E.bars[o.level.i].t);
        if (o.level.i >= off) assert.equal(T.bars[st.level.i].t, st.level.t);
        else assert.equal(st.level.i, 0);
        for (const k of ['chochAt', 'armedAt', 'touchAt', 'endAt']) {
          if (o[k] === null) assert.equal(st[k], null);
          else assert.equal(T.bars[st[k]].t, E.bars[o[k]].t, k);
        }
        if (o.obZone) {
          assert.equal(st.obZone.t, E.bars[o.obZone.i].t);
          assert.equal(st.disp.i, Math.max(0, o.disp.i - off));
        }
        if (o.entry) {
          assert.equal(T.bars[st.entry.i].t, E.bars[o.entry.i].t);
          assert.equal(st.entry.t, E.bars[o.entry.i].t);
          assert.equal(T.bars[st.entry.patternFrom].t, E.bars[o.entry.patternFrom].t);
          if (o.entry.exitAt !== null) assert.equal(T.bars[st.entry.exitAt].t, E.bars[o.entry.exitAt].t);
        }
        if (st.endAt === null) assert.ok(st.odds && st.odds.pWinFromHere, 'live setups carry their odds');
      }
      for (const lv of T.liq) {
        assert.ok(lv.at < T.bars.length);
        if (lv.endAt !== null) assert.ok(lv.endAt >= 0 && lv.endAt < T.bars.length);
        if (lv.i > 0) assert.equal(T.bars[lv.i].t, lv.t);
      }
      assert.ok(T.liq.some(lv => lv.endAt === null), 'active levels are listed');
      assert.ok(T.events.some(ev => ev.type === 'sweep') && T.events.some(ev => ev.type === 'choch'));
      for (const ev of T.events) {
        assert.ok(ev.at >= 0 && ev.at < T.bars.length && ev.i <= ev.at);
        if (ev.i > 0) assert.equal(T.bars[ev.i].t, ev.t);
        if (ev.type === 'sweep') {
          const o = E.events.find(x => x.type === 'sweep' && E.bars[x.i].t === ev.t);
          assert.equal(ev.levelIdx, Math.max(0, o.levelIdx - off));
        }
        if (ev.type === 'choch') assert.ok(ev.fromIdx >= 0 && ev.fromIdx < ev.at);
      }
      for (const sig of T.recentSignals) {
        assert.match(sig.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/);
        assert.ok(['BUY', 'SELL'].includes(sig.side));
        assert.ok(Array.isArray(sig.labels) && sig.labels.length);
        if (sig.inWindow) assert.equal(T.bars[sig.i].t, Date.parse(sig.time) / 1000);
      }
      assert.ok(T.forecast, `${tf}m has a forecast`);
      assert.equal(T.forecast.at, T.bars.length - 1);
      assert.equal(T.forecast.t, T.bars[T.bars.length - 1].t);
      assert.equal(T.forecast.horizons.length, 2);
      assert.equal(T.quality.ready, true);
      assert.ok(T.forecastTrack && T.forecastTrack.forecasts >= 1);
    }
    const tf5 = s.timeframes['5'];
    const sig = tf5.recentSignals.find(x => Date.parse(x.time) / 1000 === entryT);
    assert.ok(sig, 'the alerted entry is in recentSignals');
    assert.ok(s.alerts && Array.isArray(s.alerts.recent));

    // the page itself, wrapped like the artifact host does
    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.ok(page.body.startsWith(runner.PAGE_HEAD));
    assert.ok(page.body.endsWith(runner.PAGE_TAIL));
    assert.ok(page.body.includes(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')));
    const js = await get(port, '/engine.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
  } finally {
    server.closeAllConnections();
    await new Promise(r2 => server.close(r2));
  }
});

test('static files: index.html wrapping, content types and no way out of the folder', async () => {
  const base = tmpdir(), root = path.join(base, 'site');
  fs.mkdirSync(path.join(root, 'live', 'data'), { recursive: true });
  fs.writeFileSync(path.join(base, 'secret.js'), 'TOP SECRET OUTSIDE');
  fs.writeFileSync(path.join(root, 'index.html'), '<title>T</title><p>hi</p>');
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'style.css'), 'p{}');
  fs.writeFileSync(path.join(root, '.hidden.js'), 'hidden');
  fs.writeFileSync(path.join(root, 'live', 'config.json'), '{"telegram":{"botToken":"SECRET"}}');
  fs.writeFileSync(path.join(root, 'live', 'data', 'latest-XAUUSD.json'), '{}');
  fs.writeFileSync(path.join(root, 'live', 'runner.py'), 'x');
  const scanner = { apiState: () => ({ symbol: 'XAUUSD', timeframes: {} }) };
  const server = runner.createServer(scanner, { root });
  const port = await runner.listen(server, 0);
  try {
    for (const p of ['/', '/index.html', '/index.html?x=1']) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.body, '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body><title>T</title><p>hi</p></body></html>');
    }
    assert.equal(runner.wrapPage('<!DOCTYPE html><p>x'), '<!DOCTYPE html><p>x', 'a full document is left alone');
    let r = await get(port, '/app.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.body, 'console.log(1)');
    r = await get(port, '/style.css');
    assert.equal(r.headers['content-type'], 'text/css; charset=utf-8');
    r = await get(port, '/api/state');
    assert.deepEqual(JSON.parse(r.body), { symbol: 'XAUUSD', timeframes: {} });
    assert.equal(r.headers['cache-control'], 'no-store');
    r = await get(port, '/app.js', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.body, '');

    const blocked = [
      '/../secret.js', '/..%2fsecret.js', '/%2e%2e/secret.js', '/%2e%2e%2fsecret.js', '/..%5csecret.js', '/site/../../secret.js',
      '/live/config.json', '/LIVE/Config.JSON', '/live/config.json.', '/live/config.json::$DATA', '/live/data/latest-XAUUSD.json',
      '/.hidden.js', '/live/runner.py', '/%00app.js', '/C:/Windows/win.ini',
    ];
    for (const p of blocked) {
      r = await get(port, p);
      assert.ok(r.status === 403 || r.status === 404, `${p} gave ${r.status}`);
      assert.ok(!/SECRET/.test(r.body), `${p} leaked`);
    }
    assert.equal((await get(port, '/missing.js')).status, 404);
    assert.equal((await get(port, '/%E0%A4%A')).status, 400);
    assert.equal((await get(port, '/app.js', { method: 'POST' })).status, 405);
    assert.equal((await get(port, '/app.js', { host: 'evil.example:80' })).status, 403, 'other host names are refused');
    assert.equal((await get(port, '/app.js', { host: `localhost:${port}` })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(r2 => server.close(r2));
  }
});

test('forecast track record scores only calls whose window has closed', () => {
  const t0 = 1790000100;
  const closes = [100, 101, 102, 101, 103, 104];
  const bars = closes.map((c, k) => ({ t: t0 + k * 300, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 }));
  const records = [
    { tf: 5, t: t0, c: 100, h: [[10, 2, 0.7]], liq: [0.6, 102.4, 99, 4] },          // up 2 bars later: hit; 102.4 is taken first: hit
    { tf: 5, t: t0 + 600, c: 102, h: [[10, 2, 0.3]], liq: [0.4, 104, 100.4, 3] },   // up: miss; 104 is taken first: miss
    { tf: 5, t: t0 + 4 * 300, c: 103, h: [[10, 2, 0.6]], liq: null },               // window still open
  ];
  const s = runner.scoreForecasts(records, bars);
  const h = s.horizons.find(x => x.minutes === 10);
  assert.equal(h.n, 2);
  assert.equal(h.hits, 1);
  assert.equal(h.hitRate, 0.5);
  assert.equal(s.liquidity.n, 2);
  assert.equal(s.liquidity.hits, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.forecasts, 3);
});
