// Run with: node --test smc-scanner/test/*.test.js
// The live app around the scanner: news, market hours, alert extras, the Setup API and startup.
// No internet: Telegram and the news calendar are local mocks or stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const SMC = require('../engine.js');
const runner = require('../live/runner.js');
const sources = require('../live/sources.js');
const alerts = require('../live/alerts.js');
const { createNews, parseCalendar } = require('../live/news.js');

const RUNNER = path.join(__dirname, '..', 'live', 'runner.js');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'smc-app-'));
const quiet = () => {
  const lines = [];
  const log = m => lines.push(String(m));
  log.lines = lines;
  return log;
};
const collector = (telegram = null) => {
  const sent = [];
  return {
    sent, telegramEnabled: telegram !== null,
    send: async (a, o = {}) => { sent.push({ a, o }); return { console: o.console !== false, telegram: typeof telegram === 'function' ? telegram(a) : telegram }; },
  };
};
let sampleCache = null;
const sample = () => sampleCache || (sampleCache = sources.loadSample().bars);

function call(port, urlPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data) h['content-length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const JSONH = { 'content-type': 'application/json' };

// ---------- news ----------

const CAL = [
  { title: 'CPI m/m', country: 'USD', date: '2026-10-21T08:30:00-04:00', impact: 'High', forecast: '0.2%', previous: '0.4%' },
  { title: 'Retail Sales', country: 'EUR', date: '2026-10-21T08:30:00-04:00', impact: 'High' },
  { title: 'Crude Oil Inventories', country: 'USD', date: '2026-10-21T10:30:00-04:00', impact: 'Medium' },
  { title: 'FOMC Statement', country: 'USD', date: '2026-10-21T14:00:00-04:00', impact: 'High' },
  { title: 'broken', country: 'USD', date: 'not a date', impact: 'High' },
];
const cpi = Date.parse('2026-10-21T12:30:00Z') / 1000;

test('news: high-impact USD events near a time, fetched at most hourly, last copy kept on failure', async () => {
  assert.equal(parseCalendar(CAL).length, 4);
  const dir = tmpdir(), log = quiet();
  let now = cpi * 1000 - 3600e3, calls = 0, fail = false;
  const news = createNews({}, {
    dataDir: dir, log, clock: () => now,
    fetchJson: async () => { calls++; if (fail) throw new Error('HTTP 503'); return CAL; },
  });
  assert.equal(await news.refresh(), true);
  assert.equal(await news.refresh(), false, 'not again within the hour');
  assert.equal(calls, 1);
  const near = news.near(cpi - 20 * 60);
  assert.deepEqual(near.map(e => [e.title, e.minutes]), [['CPI m/m', 20]]);
  assert.deepEqual(news.near(cpi + 10 * 60).map(e => e.minutes), [-10], 'shortly after counts too');
  assert.deepEqual(news.near(cpi - 45 * 60), [], 'too early');
  assert.deepEqual(news.upcoming(cpi - 60).map(e => e.title), ['CPI m/m', 'FOMC Statement']);
  assert.ok(fs.existsSync(path.join(dir, 'news.json')));
  // the feed fails: the copy stays, one log line, next try in about 15 minutes
  now += 3601e3;
  fail = true;
  assert.equal(await news.refresh(), false);
  assert.match(news.error, /News calendar unavailable: HTTP 503/);
  assert.equal(news.near(cpi).length, 1);
  await news.refresh({ force: true });
  assert.equal(log.lines.filter(l => /unavailable/.test(l)).length, 1);
  // a new scanner starts from the saved copy
  const again = createNews({}, { dataDir: dir, clock: () => now, fetchJson: async () => { throw new Error('offline'); } });
  assert.equal(again.near(cpi).length, 1);
  assert.equal(createNews({ enabled: false }, {}).near(cpi).length, 0);
});

test('alert text: grade, confluence, lot size and the news warning', () => {
  const s = {
    label: 'PDL', levelPrice: 4340.45, sweepT: cpi - 3600, chochT: cpi - 1800, fvgKind: 'IFVG', grade: 'A',
    factors: [{ label: 'Key liquidity (PDL)', ok: true }, { label: 'London or NY session', ok: true }, { label: 'OB in discount', ok: true }, { label: 'Volume 2× average or more (1.4×)', ok: false }],
  };
  const e = { dir: 'bull', entry: 4349.18, sl: 4341.67, tp: 4364.2, rr: 2, pattern: 'Pin bar', zone: 'OB', tpSrc: 'rr', grade: 'A' };
  const text = alerts.message({
    kind: 'entry', symbol: 'XAUUSD', tfMin: 5, dir: 'bull', t: cpi - 600, setup: s, entry: e, timeZone: 'Asia/Kolkata',
    risk: { balance: 5000, percent: 1 }, news: [{ country: 'USD', title: 'CPI m/m', t: cpi, minutes: 5 }],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'XAUUSD 5m BUY signal · Pin bar at OB · grade A');
  assert.equal(lines[2], 'Size: 0.06 lot risks $45.06 (1% of $5,000)');
  assert.ok(lines.includes('Confluence 3/4: Key liquidity (PDL), London or NY session, OB in discount'));
  assert.ok(lines.includes('⚠ High-impact news: USD CPI m/m in 5 min (18:00)'));
  assert.equal(alerts.sizeLine(e, { balance: 0 }), null, 'no balance, no size line');
  assert.match(alerts.sizeLine(e, { balance: 500, percent: 1 }), /less than 0\.01 lot/);
  assert.equal(alerts.positionSize(4349.18, 4341.67, { balance: 417500, percent: 1, currency: 'INR', usdRate: 84 }).lots, 0.06);
});

// ---------- the scanner ----------

test('market hours: one check after gold closes, then none until it opens', async () => {
  const at = s => Date.parse(s);
  const bars = sample().slice(0, 300);
  const shift = Math.floor(at('2026-10-23T20:50:00Z') / 1000) - bars[bars.length - 1].t;
  const feed = bars.map(b => ({ ...b, t: b.t + shift }));   // the last candle is Friday 16:50 New York
  let now = at('2026-10-23T20:55:08Z'), calls = 0;
  const source = { name: 'twelvedata', lastNow: null, info: {}, fetchBars: async () => { calls++; return feed; } };
  const S = new runner.LiveScanner(runner.loadConfig(null, { source: 'twelvedata' }), {
    dataDir: tmpdir(), source, notifier: collector(), log: quiet(), clock: () => now, news: null, lateRetryMs: 0,
  });
  assert.equal((await S.cycle()).ok, true);                 // Fri 16:55 New York, open
  now = at('2026-10-23T21:00:08Z');                         // 17:00: closed, but the last candles still come in
  assert.equal((await S.cycle()).skipped, undefined);
  assert.equal(calls, 2);
  now = at('2026-10-23T21:05:08Z');
  assert.equal((await S.cycle()).skipped, 'market closed');
  now = at('2026-10-24T12:00:08Z');                         // Saturday
  assert.equal((await S.cycle()).skipped, 'market closed');
  assert.equal(calls, 2, 'no requests while closed');
  assert.equal(S.apiState().health.market.open, false);
  assert.equal(S.apiState().health.market.opensAt, '2026-10-25T22:00:00.000Z');
  now = at('2026-10-25T22:05:08Z');                         // Sunday 18:05 New York
  await S.cycle();
  assert.equal(calls, 3);
  // marketHours false checks every time
  const T = new runner.LiveScanner(runner.loadConfig(null, { source: 'twelvedata', marketHours: false }), {
    dataDir: tmpdir(), source, notifier: collector(), log: quiet(), clock: () => at('2026-10-24T12:00:08Z'), news: null, lateRetryMs: 0,
  });
  await T.cycle();
  await T.cycle();
  assert.equal(calls, 5);
});

// A replay scanner that has just reached the first entry of the sample
async function toFirstEntry(extra = {}, notifier = collector()) {
  const bars = sample();
  const E = SMC.run(bars, { spread: 0.25 });
  const s = E.setups.find(x => x.entry);
  const cfg = runner.loadConfig(null, { source: 'replay', alerts: { on: 'all' }, ...extra });
  const source = sources.replay({ startIndex: s.entry.i - 2 }, { tfMinutes: 5, bars, everyMinutes: 5 });
  const S = new runner.LiveScanner(cfg, { dataDir: tmpdir(), source, notifier, log: quiet(), news: null });
  for (let k = 0; k < 6; k++) await S.cycle();
  return { S, s, notifier };
}

test('alerts.minGrade: graded steps below it stay on the dashboard only', async () => {
  const all = await toFirstEntry();
  const entry = all.notifier.sent.find(x => x.a.kind === 'entry' && x.a.tfMin === 5);
  assert.ok(entry, 'the entry is alerted');
  assert.equal(entry.a.setup.grade, all.s.grade);
  assert.match(entry.a.text, new RegExp(`grade ${all.s.grade.replace('+', '\\+')}`));
  if (all.s.grade === 'A+') return;
  const above = SMC.GRADES[SMC.GRADES.indexOf(all.s.grade) + 1];
  const some = await toFirstEntry({ alerts: { on: 'all', minGrade: above } });
  assert.ok(!some.notifier.sent.some(x => x.a.kind === 'entry' && x.a.setup.id === all.s.id && x.a.tfMin === 5));
  assert.ok(some.S.health.belowGrade >= 1);
});

test('Telegram: an alert it did not take is retried (Telegram only) at the next check', async () => {
  let up = false;
  const notifier = collector(() => up);
  const { S } = await toFirstEntry({}, notifier);
  const failed = notifier.sent.filter(x => x.a.kind === 'entry');
  assert.ok(failed.length >= 1);
  assert.ok(S.retry.length >= 1);
  up = true;
  const before = notifier.sent.length;
  await S.cycle();
  const resent = notifier.sent.slice(before).filter(x => x.o.console === false);
  assert.ok(resent.some(x => x.a.kind === 'entry'), 'the entry went to Telegram again');
  assert.equal(S.retry.length, 0);
});

test('logger: lines go to the console and to scanner.log, which rolls over', () => {
  const dir = tmpdir(), file = path.join(dir, 'scanner.log'), printed = [];
  const log = runner.makeLogger('Asia/Kolkata', { file, print: l => printed.push(l) });
  log('hello');
  assert.match(printed[0], /^\d\d:\d\d:\d\d  hello$/);
  assert.match(fs.readFileSync(file, 'utf8'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d  hello\n$/);
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1));
  log('after');
  assert.ok(fs.existsSync(file + '.1'));
  assert.match(fs.readFileSync(file, 'utf8'), /after/);
});

test('config: a broken file is reported and the defaults are used (lenient), unknown sources refused', () => {
  const dir = tmpdir(), f = path.join(dir, 'config.json');
  fs.writeFileSync(f, '{ "source": "mt5", }');
  assert.throws(() => runner.loadConfig(f), /not valid JSON/);
  const cfg = runner.loadConfig(f, {}, { lenient: true });
  assert.match(cfg.configError, /not valid JSON/);
  assert.equal(cfg.source, 'auto');
  assert.throws(() => runner.loadConfig(null, { source: 'nope' }), /not one of/);
  assert.equal(runner.loadConfig(null, { timeZone: 'Mars/Base' }).timeZone, 'Asia/Kolkata');
  assert.equal(runner.DEFAULTS.alerts.on, 'entry', 'loading never changes the defaults');
});

// ---------- the Setup API ----------

async function startApp({ telegramBase, files = {} } = {}) {
  const dir = tmpdir(), cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    _note: 'kept', source: 'replay', replay: { start: '2026-09-01' }, news: { enabled: false },
    twelvedata: { apiKey: 'TDSECRET' }, alerts: { telegram: { botToken: '123:TOKEN', chatId: '42', base: telegramBase || '' } }, ...files,
  }));
  const log = quiet();
  const app = new runner.App({ cfgFile, dataDir: path.join(dir, 'data'), log, scannerOpts: { notifier: collector() } });
  await app.init(runner.loadConfig(cfgFile, {}, { lenient: true }));
  const server = runner.createServer(app);
  const port = await runner.listen(server, 0);
  return {
    app, dir, cfgFile, port, log,
    close: async () => { app.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); },
  };
}

test('Setup API: settings with secrets masked, saved to config.json and applied by a restart', async () => {
  const A = await startApp();
  try {
    let r = await call(A.port, '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.json.config.twelvedata.apiKey, runner.MASK);
    assert.equal(r.json.config.alerts.telegram.botToken, runner.MASK);
    assert.equal(r.json.config.alerts.telegram.chatId, '42');
    assert.ok(!r.body.includes('TDSECRET') && !r.body.includes('123:TOKEN'));
    assert.ok(r.json.sources.some(s => s.name === 'yahoo'));

    const first = A.app.scanner;
    const config = { ...r.json.config, everyMinutes: 10, risk: { ...r.json.config.risk, balance: 2500 }, alerts: { ...r.json.config.alerts, on: 'all' } };
    r = await call(A.port, '/api/config', { method: 'POST', headers: JSONH, body: { config } });
    assert.equal(r.json.ok, true, r.json.error);
    assert.notEqual(A.app.scanner, first, 'a new scanner runs');
    assert.equal(first.running, false);
    const saved = JSON.parse(fs.readFileSync(A.cfgFile, 'utf8'));
    assert.equal(saved.everyMinutes, 10);
    assert.equal(saved.risk.balance, 2500);
    assert.equal(saved.twelvedata.apiKey, 'TDSECRET', 'a masked secret keeps its saved value');
    assert.equal(saved.alerts.telegram.botToken, '123:TOKEN');
    assert.equal(saved._note, 'kept', 'notes in the file survive');
    assert.equal(A.app.cfg.everyMinutes, 10);
    r = await call(A.port, '/api/state');
    assert.equal(r.json.risk.balance, 2500);

    // a bad value is refused and nothing changes
    const now = A.app.scanner;
    r = await call(A.port, '/api/config', { method: 'POST', headers: JSONH, body: { config: { timeframes: [5, 7] } } });
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /not a multiple/);
    assert.equal(A.app.scanner, now);
    assert.equal(JSON.parse(fs.readFileSync(A.cfgFile, 'utf8')).everyMinutes, 10);

    // check now runs one check straight away
    r = await call(A.port, '/api/check-now', { method: 'POST', headers: JSONH, body: {} });
    assert.equal(r.json.ok, true);
    // the source test does not disturb the running scanner
    r = await call(A.port, '/api/test-source', { method: 'POST', headers: JSONH, body: { config: { source: 'replay' } } });
    assert.equal(r.json.ok, true);
    assert.ok(r.json.candles > 0);
    assert.equal(A.app.scanner, now);
  } finally {
    await A.close();
  }
});

test('Setup API: only the dashboard itself may post (JSON, same origin)', async () => {
  const A = await startApp();
  try {
    const before = fs.readFileSync(A.cfgFile, 'utf8');
    const body = { config: { everyMinutes: 15 } };
    const refused = [
      { headers: { 'content-type': 'text/plain' } },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { headers: { ...JSONH, origin: 'https://evil.example' } },
      { headers: { ...JSONH, origin: 'null' } },
      { headers: { ...JSONH, 'sec-fetch-site': 'cross-site' } },
      { headers: { ...JSONH, host: 'evil.example' } },
    ];
    for (const o of refused) {
      const r = await call(A.port, '/api/config', { method: 'POST', body, ...o });
      assert.equal(r.status, 403, JSON.stringify(o.headers));
    }
    assert.equal(fs.readFileSync(A.cfgFile, 'utf8'), before, 'nothing was saved');
    const ok = await call(A.port, '/api/config', { method: 'POST', body, headers: { ...JSONH, origin: `http://localhost:${A.port}`, 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.json.ok, true);
    assert.equal((await call(A.port, '/api/config', { method: 'POST', body: '{not json', headers: JSONH })).status, 400);
    assert.equal((await call(A.port, '/api/nothing', { method: 'POST', body: {}, headers: JSONH })).status, 404);
  } finally {
    await A.close();
  }
});

test('Setup API: test message and chat id finder talk to Telegram with the saved token', async () => {
  const calls = [];
  const tg = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      calls.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/getUpdates')) {
        res.end(JSON.stringify({ ok: true, result: [
          { update_id: 1, message: { chat: { id: 42, type: 'private', first_name: 'Rahul' }, text: '/start' } },
          { update_id: 2, message: { chat: { id: 42, type: 'private', first_name: 'Rahul' }, text: 'hi' } },
          { update_id: 3, my_chat_member: { chat: { id: -100123, type: 'supergroup', title: 'Gold alerts' } } },
        ] }));
      } else {
        res.end(JSON.stringify({ ok: true, result: {} }));
      }
    });
  });
  await new Promise(r => tg.listen(0, '127.0.0.1', r));
  const A = await startApp({ telegramBase: `http://127.0.0.1:${tg.address().port}` });
  try {
    let r = await call(A.port, '/api/telegram-chats', { method: 'POST', headers: JSONH, body: { botToken: runner.MASK } });
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.chats, [{ id: '42', name: 'Rahul', type: 'private' }, { id: '-100123', name: 'Gold alerts', type: 'supergroup' }]);
    assert.equal(calls[0].url, '/bot123:TOKEN/getUpdates');
    r = await call(A.port, '/api/test-telegram', { method: 'POST', headers: JSONH, body: { botToken: runner.MASK, chatId: '-100123' } });
    assert.equal(r.json.ok, true);
    assert.equal(JSON.parse(calls[1].body).chat_id, '-100123');
    assert.match(JSON.parse(calls[1].body).text, /can send you alerts/);
    r = await call(A.port, '/api/test-telegram', { method: 'POST', headers: JSONH, body: { botToken: '', chatId: '' } });
    assert.equal(r.json.ok, true, 'empty fields fall back to the saved ones');
  } finally {
    await A.close();
    tg.closeAllConnections();
    await new Promise(r => tg.close(r));
  }
});

test('no source answers: the dashboard still runs and says why, and retries', async () => {
  const dir = tmpdir();
  const cfg = runner.loadConfig(null, {
    source: 'auto', mt5file: { folder: path.join(dir, 'none') }, mt5: { python: 'no-such-python-here' },
    yahoo: { base: 'http://127.0.0.1:9' }, news: { enabled: false },
  });
  const app = new runner.App({ cfgFile: path.join(dir, 'config.json'), dataDir: dir, log: quiet(), retryMs: 50 });
  await app.init(cfg);
  assert.ok(app.scanner instanceof runner.WaitingScanner);
  const st = app.scanner.apiState();
  assert.equal(st.health.waiting, true);
  assert.match(st.health.error, /no data source answered.*Yahoo Finance.*Could not reach/);
  // once a feed answers (here: the config now points at the replay), the waiting scanner hands over
  app.scanner.cfg = runner.loadConfig(null, { source: 'replay', news: { enabled: false } });
  const done = app.runForever({ cycles: 1, fast: true });
  await done;
  assert.ok(app.scanner instanceof runner.LiveScanner);
  assert.equal(app.scanner.sourceName, 'replay');
});

test('the page uses the local chart library when vendor/ has it', async () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'vendor'));
  fs.writeFileSync(path.join(root, 'vendor', 'lightweight-charts.standalone.production.js'), '/* lwc */');
  fs.writeFileSync(path.join(root, 'index.html'), '<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"></script>');
  const server = runner.createServer({ apiState: () => ({}) }, { root });
  const port = await runner.listen(server, 0);
  try {
    const r = await call(port, '/');
    assert.match(r.body, /<script src="vendor\/lightweight-charts\.standalone\.production\.js"><\/script>/);
    assert.equal((await call(port, '/vendor/lightweight-charts.standalone.production.js')).body, '/* lwc */');
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

// ---------- the command line ----------

function runCli(args, { timeoutMs = 120000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [RUNNER, ...args], { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('command line: a fast replay demo runs, and a second copy on the same port says it is already running', async () => {
  const dir = tmpdir();
  const r = await runCli(['--source', 'replay', '--replay-start', '2026-09-01', '--fast', '--cycles', '3', '--port', '0', '--data-dir', dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Dashboard: http:\/\/localhost:\d+/);
  assert.match(r.out, /source: replay of the bundled sample/);
  assert.ok(fs.existsSync(path.join(dir, 'scanner.log')));

  // a scanner already on the port
  const busy = await startApp();
  try {
    const second = await runCli(['--source', 'replay', '--port', String(busy.port), '--data-dir', tmpdir()]);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /already running: http:\/\/localhost:\d+/);
  } finally {
    await busy.close();
  }
  // another program on the port: the next free one is used
  const other = http.createServer((q, s) => s.end('not the scanner'));
  await new Promise(res => other.listen(0, '127.0.0.1', res));
  try {
    const third = await runCli(['--source', 'replay', '--fast', '--cycles', '1', '--port', String(other.address().port), '--data-dir', tmpdir()]);
    assert.equal(third.code, 0, third.out);
    assert.match(third.out, /is used by another program, so the dashboard uses \d+/);
  } finally {
    other.closeAllConnections();
    await new Promise(res => other.close(res));
  }
});
