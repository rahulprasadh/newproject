/*
 * Where live candles come from. Every adapter has the same shape:
 *   { name, info, lastNow, async fetchBars({ count, now }) }
 * fetchBars resolves to candles {t, o, h, l, c, v} in true UTC, oldest first. It may include
 * the candle that is still forming; the runner drops it. lastNow is the source's own clock
 * (UTC seconds) at the last fetch, or null when the runner should use this PC's clock.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const SMC = require('../engine.js');
const { request } = require('./http.js');

const TD_INTERVAL = { 1: '1min', 5: '5min', 15: '15min', 30: '30min', 60: '1h' };
const MT5_TF = { 1: 'M1', 5: 'M5', 15: 'M15', 30: 'M30', 60: 'H1' };
const YH_INTERVAL = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '60m' };
const YH_MAX_DAYS = { 1: 7, 5: 59, 15: 59, 30: 59, 60: 700 };   // Yahoo's intraday history limits
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TD_PAGE = 5000;             // Twelve Data's largest outputsize
const SAMPLE = path.join(__dirname, '..', 'data', 'sample.js');

// Sorted by time, one candle per time (the later copy wins), invalid rows dropped.
function cleanBars(list) {
  const byT = new Map();
  for (const b of list || []) {
    const bar = { t: Math.floor(+b.t), o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v || 0 };
    if ([bar.t, bar.o, bar.h, bar.l, bar.c].some(x => !Number.isFinite(x))) continue;
    if (bar.h < Math.max(bar.o, bar.c) || bar.l > Math.min(bar.o, bar.c)) continue;
    byT.set(bar.t, bar);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// Bring candles to tfSec: finer data is combined, coarser data cannot be used.
function toTimeframe(bars, tfSec, what) {
  const have = SMC.detectTimeframe(bars);
  if (!have || have === tfSec) return bars;
  if (have < tfSec && tfSec % have === 0) return SMC.resample(bars, tfSec);
  throw new Error(`${what} has ${have / 60}-minute candles, which cannot make ${tfSec / 60}-minute candles`);
}

const utcText = t => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');

/*
 * MetaTrader 5 brokers stamp candles in their server time. Most gold brokers run "New York
 * close" time, UTC+2 in winter and UTC+3 in summer, which moves with US daylight saving; others
 * (Exness, for example) keep UTC+0 all year. A candle history converted with today's offset alone
 * is an hour out on every candle from the other half of the year, so for New York close servers
 * each candle is shifted by the change in New York's offset between its time and now.
 * mode: 'auto' (decide from the offset now), 'us' or 'none'.
 */
function serverDst(offsetNowMin, nowSec, mode = 'auto') {
  if (mode === 'none' || !Number.isFinite(+offsetNowMin)) return 'none';
  if (mode === 'us') return 'us';
  return +offsetNowMin - SMC.nyTime(nowSec).offsetMin === 420 ? 'us' : 'none';
}

function fixServerDst(bars, nowSec, dst) {
  if (dst !== 'us' || !bars.length) return bars;
  const nyNow = SMC.nyTime(nowSec).offsetMin;
  return bars.map(b => {
    const d = nyNow - SMC.nyTime(b.t).offsetMin;
    return d ? { ...b, t: b.t + d * 60 } : b;
  });
}

// ---------- Twelve Data ----------

function parseTwelveData(json, apiKey) {
  const hide = s => (apiKey ? String(s).split(apiKey).join('***') : String(s));
  if (!json || typeof json !== 'object') throw new Error('Twelve Data sent an empty answer');
  if (json.status === 'error') {
    throw new Error(`Twelve Data error${json.code ? ' ' + json.code : ''}: ${hide(json.message || 'unknown error')}`);
  }
  const values = Array.isArray(json.values) ? json.values : [];
  return cleanBars(values.map(r => {
    const d = String(r.datetime).trim();
    return {
      t: Date.parse(d.length <= 10 ? d + 'T00:00:00Z' : d.replace(' ', 'T') + 'Z') / 1000,
      o: r.open, h: r.high, l: r.low, c: r.close,
      v: r.volume === undefined ? 0 : r.volume,   // forex and metals have no volume
    };
  }));
}

function twelveData(cfg = {}, { tfMinutes = 5 } = {}) {
  const interval = TD_INTERVAL[tfMinutes];
  if (!interval) throw new Error(`Twelve Data has no ${tfMinutes}-minute candles here; use 1, 5, 15, 30 or 60`);
  const apiKey = cfg.apiKey || '';
  const symbol = cfg.symbol || 'XAU/USD';
  const base = String(cfg.base || 'https://api.twelvedata.com').replace(/\/+$/, '');
  const maxCandles = Math.max(1, +cfg.maxCandles || 20000);
  const src = { name: 'twelvedata', lastNow: null, info: { symbol, interval } };

  async function page(size, endDate) {
    const q = new URLSearchParams({
      symbol, interval, outputsize: String(size), timezone: 'UTC', order: 'ASC', apikey: apiKey,
    });
    if (endDate) q.set('end_date', endDate);
    let res;
    try {
      res = await request(`${base}/time_series?${q}`, { timeoutMs: 20000 });
    } catch (err) {
      throw new Error(`Could not reach Twelve Data: ${err.message}`);
    }
    // the server's Date header is the clock used to tell closed candles from the forming one
    const d = Date.parse(res.headers.date || '');
    if (!Number.isNaN(d)) src.lastNow = Math.floor(d / 1000);
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (err) {
      throw new Error(`Twelve Data sent an unreadable answer (HTTP ${res.status})`);
    }
    return parseTwelveData(json, apiKey);
  }

  src.fetchBars = async ({ count = TD_PAGE } = {}) => {
    if (!apiKey) throw new Error('No Twelve Data API key: set twelvedata.apiKey in config.json');
    src.lastNow = null;
    const want = Math.max(1, Math.min(count, maxCandles));
    let bars = await page(Math.min(want, TD_PAGE));
    // a longer first history comes in pages, walking back with end_date
    for (let n = 0; bars.length && bars.length < want && n < 8; n++) {
      let older;
      try {
        older = await page(Math.min(TD_PAGE, want - bars.length), utcText(bars[0].t - 1));
      } catch (err) {
        if (/no data/i.test(err.message)) break;
        throw err;
      }
      older = older.filter(b => b.t < bars[0].t);
      if (!older.length) break;
      bars = older.concat(bars);
    }
    return bars;
  };
  return src;
}

// ---------- Yahoo Finance (no key) ----------

function parseYahoo(json, tfSec) {
  const chart = json && json.chart;
  if (!chart) throw new Error('Yahoo Finance sent an unexpected answer');
  if (chart.error) {
    throw new Error(`Yahoo Finance error: ${chart.error.description || chart.error.code || 'unknown error'}`);
  }
  const r = chart.result && chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) return [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const out = [];
  r.timestamp.forEach((t, k) => {
    // the last point is often the latest trade, not a candle start: keep only aligned times
    if (t % tfSec) return;
    const b = { t, o: q.open && q.open[k], h: q.high && q.high[k], l: q.low && q.low[k], c: q.close && q.close[k], v: (q.volume && q.volume[k]) || 0 };
    if ([b.o, b.h, b.l, b.c].some(x => x === null || x === undefined)) return;
    out.push(b);
  });
  return cleanBars(out);
}

/*
 * Free, no sign-up: COMEX gold futures (GC=F) from Yahoo Finance, with real traded volume.
 * Futures trade a few dollars above spot XAUUSD and Yahoo's intraday data is about 10 minutes
 * late, so the levels differ from your broker's chart. Good for trying the scanner; use MT5 for
 * your broker's own prices. It is an unofficial feed and may change without notice.
 */
function yahoo(cfg = {}, { tfMinutes = 5 } = {}) {
  const interval = YH_INTERVAL[tfMinutes];
  if (!interval) throw new Error(`Yahoo Finance has no ${tfMinutes}-minute candles here; use 1, 5, 15, 30 or 60`);
  const symbol = cfg.symbol || 'GC=F';
  const base = String(cfg.base || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
  const tfSec = tfMinutes * 60;
  const src = { name: 'yahoo', lastNow: null, info: { symbol, interval, delayedMinutes: 10 } };
  src.fetchBars = async ({ count = 5000, now } = {}) => {
    src.lastNow = null;
    const end = Math.floor(now || Date.now() / 1000);
    // weekends and the daily break take about a third of the calendar, hence the margin
    const days = Math.min(YH_MAX_DAYS[tfMinutes], Math.max(1, Math.ceil(count * tfSec * 1.5 / 86400) + 1));
    const q = new URLSearchParams({
      interval, period1: String(end - days * 86400), period2: String(end + 600), includePrePost: 'false',
    });
    let res;
    try {
      res = await request(`${base}/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`, {
        timeoutMs: 20000, headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
      });
    } catch (err) {
      throw new Error(`Could not reach Yahoo Finance: ${err.message}`);
    }
    const d = Date.parse(res.headers.date || '');
    if (!Number.isNaN(d)) src.lastNow = Math.floor(d / 1000);
    if (res.status === 429) throw new Error('Yahoo Finance is limiting requests right now (HTTP 429); the next check will try again');
    let json;
    try {
      json = JSON.parse(res.body);
    } catch (err) {
      throw new Error(`Yahoo Finance sent an unreadable answer (HTTP ${res.status})`);
    }
    if (res.status >= 400 && !(json && json.chart && json.chart.error)) throw new Error(`Yahoo Finance answered HTTP ${res.status}`);
    const bars = parseYahoo(json, tfSec);
    return count ? bars.slice(-count) : bars;
  };
  return src;
}

// ---------- MetaTrader 5 (through the Python helper) ----------

function runPython(cmd, args, { timeoutMs = 60000, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env: env || process.env, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '', errText = '', done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`the MetaTrader 5 helper did not answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errText += d; });
    child.on('error', err => {
      const msg = err.code === 'ENOENT'
        ? `Python was not found ("${cmd}"). Install Python 3.11+ from python.org (tick "Add python.exe to PATH") or set mt5.python to the full path of python.exe`
        : `Could not start Python: ${err.message}`;
      finish(reject, new Error(msg));
    });
    child.on('close', code => finish(resolve, { code, out, err: errText }));
  });
}

function mt5(cfg = {}, { tfMinutes = 5, knownOffset = null, helper, env } = {}) {
  const tf = MT5_TF[tfMinutes];
  if (!tf) throw new Error(`MetaTrader 5 timeframe ${tfMinutes}m is not supported here; use 1, 5, 15, 30 or 60`);
  const python = cfg.python || (process.platform === 'win32' ? 'python' : 'python3');
  const script = helper || path.join(__dirname, 'mt5_bars.py');
  const offset = cfg.serverUtcOffsetMinutes === undefined || cfg.serverUtcOffsetMinutes === null
    ? 'auto' : cfg.serverUtcOffsetMinutes;
  const src = { name: 'mt5', lastNow: null, info: { symbol: cfg.symbol || 'XAUUSD' }, knownOffset };

  src.fetchBars = async ({ count = 5000 } = {}) => {
    src.lastNow = null;
    const args = [...(cfg.pythonArgs || []), script, '--symbol', cfg.symbol || 'XAUUSD', '--timeframe', tf,
      '--count', String(Math.max(1, Math.floor(count))), '--offset', String(offset)];
    // when the market is closed the offset cannot be measured: use the last measured or configured one
    const fallback = src.knownOffset !== null && src.knownOffset !== undefined ? src.knownOffset : cfg.fallbackOffsetMinutes;
    if (offset === 'auto' && Number.isFinite(+fallback) && fallback !== null && fallback !== '') {
      args.push('--fallback-offset', String(+fallback));
    }
    if (cfg.terminalPath) args.push('--terminal', cfg.terminalPath);
    if (cfg.findSymbol !== false) args.push('--find-symbol');
    const r = await runPython(python, args, { timeoutMs: (cfg.timeoutSeconds || 60) * 1000, env });
    let json;
    try {
      json = JSON.parse(r.out.trim().split(/\r?\n/).pop() || '');
    } catch (err) {
      if (r.code === 9009) {
        throw new Error('Python is not installed (Windows only has its Microsoft Store shortcut). Install Python 3.11+ from python.org, tick "Add python.exe to PATH", then run: pip install MetaTrader5');
      }
      const why = (r.err || r.out || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
      throw new Error(`The MetaTrader 5 helper gave no answer (exit code ${r.code})${why ? ': ' + why : ''}`);
    }
    if (json.error) throw new Error(json.error);
    src.lastNow = Number.isFinite(json.now) ? json.now : null;
    const nowSec = src.lastNow || Math.floor(Date.now() / 1000);
    const dst = serverDst(json.serverOffsetMinutes, nowSec, cfg.dst);
    src.info = {
      symbol: json.symbol || src.info.symbol, serverOffsetMinutes: json.serverOffsetMinutes,
      offsetSource: json.offsetSource, tickFresh: !!json.tickFresh, dst,
    };
    if (json.symbol && json.symbol !== (cfg.symbol || 'XAUUSD')) src.info.symbolNote = `${cfg.symbol || 'XAUUSD'} is called ${json.symbol} at this broker`;
    if (json.offsetSource === 'auto') src.knownOffset = json.serverOffsetMinutes;
    return cleanBars(fixServerDst(cleanBars(json.bars), nowSec, dst));
  };
  return src;
}

// ---------- MetaTrader 5 (through the GoldSMCExport expert advisor, no Python) ----------

// Where MT5 keeps files shared by all terminals: %APPDATA%\MetaQuotes\Terminal\Common\Files
function mt5CommonDir(env = process.env) {
  const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : null);
  return appData ? path.join(appData, 'MetaQuotes', 'Terminal', 'Common', 'Files') : null;
}

// The exporter's files for a symbol: {csv, status}, or null when no folder is known.
function mt5FilePaths(cfg = {}, { tfMinutes = 5, env } = {}) {
  const tf = MT5_TF[tfMinutes] || `M${tfMinutes}`;
  if (cfg.path) {
    const csv = path.resolve(cfg.path);
    return { csv, status: csv.replace(/\.csv$/i, '') + '.json' };
  }
  const dir = cfg.folder || (mt5CommonDir(env) && path.join(mt5CommonDir(env), 'GoldSMC'));
  if (!dir) return null;
  let sym = cfg.symbol || '';
  if (!sym) {
    // whichever symbol the exporter runs on (XAUUSD, XAUUSD.m, GOLD ...): the newest status file
    try {
      // gold first (XAUUSD, XAUUSD.m, GOLD ...), then the most recently written
      const found = fs.readdirSync(dir).filter(f => f.endsWith(`_${tf}.json`))
        .map(f => ({ f, gold: /XAU|GOLD/i.test(f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.gold - a.gold || b.m - a.m);
      if (found.length) sym = found[0].f.slice(0, -(`_${tf}.json`.length));
    } catch (err) { /* no folder yet */ }
  }
  if (!sym) sym = 'XAUUSD';
  return { csv: path.join(dir, `${sym}_${tf}.csv`), status: path.join(dir, `${sym}_${tf}.json`), symbol: sym };
}

async function readRetry(file, tries = 3) {
  for (let k = 1; ; k++) {
    try {
      return await fs.promises.readFile(file, 'utf8');
    } catch (err) {
      // MT5 may be swapping the file in this instant
      if (k >= tries || err.code === 'ENOENT') throw err;
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

/*
 * Reads the candles GoldSMCExport.mq5 writes from the MT5 terminal into the Common Files folder:
 * <SYMBOL>_M5.csv (t in broker server time, open, high, low, close, tick volume, closed candles
 * only) and <SYMBOL>_M5.json (symbol, serverOffsetMinutes, writtenUtc, connected). The expert
 * advisor rewrites the status every 30 s, so an old one means MT5 or the expert is not running.
 */
function mt5File(cfg = {}, { tfMinutes = 5, env, clock = () => Date.now() } = {}) {
  const src = { name: 'mt5file', lastNow: null, info: {} };
  src.paths = () => mt5FilePaths(cfg, { tfMinutes, env });
  src.fetchBars = async ({ count } = {}) => {
    const p = src.paths();
    if (!p) throw new Error('Could not find the MT5 Common Files folder (APPDATA is not set); set mt5file.path in config.json');
    let st;
    try {
      st = JSON.parse((await readRetry(p.status)).replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error(err.code === 'ENOENT'
        ? `No candles from MT5 yet (${p.status} is missing). In MT5, attach the GoldSMCExport expert to an XAUUSD chart; see live/mt5/README.md`
        : `Could not read ${p.status}: ${err.message}`);
    }
    const nowSec = Math.floor(clock() / 1000);
    const age = nowSec - (+st.writtenUtc || 0);
    const maxAge = (+cfg.maxStatusAgeSeconds || 180);
    if (age > maxAge) {
      throw new Error(`MT5 has not updated the candles for ${Math.round(age / 60)} min. Is MT5 open with GoldSMCExport running on a chart (smiley face top right)?`);
    }
    if (st.connected === false) throw new Error('MetaTrader 5 is open but not connected to the broker');
    let text;
    try {
      text = await readRetry(p.csv);
    } catch (err) {
      throw new Error(`Could not read ${p.csv}: ${err.code === 'ENOENT' ? 'the file does not exist yet' : err.message}`);
    }
    const off = +st.serverOffsetMinutes || 0;
    const dst = serverDst(off, nowSec, cfg.dst);
    let bars = SMC.parseCSV(text, off);
    bars = toTimeframe(fixServerDst(bars, nowSec, dst), tfMinutes * 60, 'The MT5 export');
    src.info = { symbol: st.symbol || p.symbol, serverOffsetMinutes: off, dst, file: p.csv, written: st.writtenUtc };
    return count ? bars.slice(-count) : bars;
  };
  return src;
}

// ---------- CSV file ----------

// For an MT5 script or EA that keeps exporting candles to a file.
function csvFile(cfg = {}, { tfMinutes = 5, baseDir } = {}) {
  if (!cfg.path) throw new Error('No CSV file: set csv.path in config.json');
  const file = path.resolve(baseDir || process.cwd(), cfg.path);
  const src = { name: 'csv', lastNow: null, info: { file } };
  src.fetchBars = async ({ count } = {}) => {
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (err) {
      throw new Error(`Could not read ${file}: ${err.code === 'ENOENT' ? 'the file does not exist' : err.message}`);
    }
    const bars = toTimeframe(SMC.parseCSV(text, cfg.tzOffsetMinutes === 'nyclose' ? 'nyclose' : +cfg.tzOffsetMinutes || 0), tfMinutes * 60, 'The CSV file');
    return count ? bars.slice(-count) : bars;
  };
  return src;
}

// ---------- replay ----------

function loadSample(file = SAMPLE) {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  const s = ctx.window.SMC_SAMPLE;
  if (!s || !s.csv) throw new Error(`${file} has no SMC_SAMPLE data`);
  return { symbol: s.symbol, source: s.source, bars: SMC.parseCSV(s.csv) };
}

/*
 * Replays saved candles on a virtual clock, for demos and tests. The clock starts just after
 * candle startIndex - 1 closed; every later fetch moves it on by stepMinutes. Each fetch
 * returns the candles closed by then plus the forming one, cut short like a live feed.
 */
function replay(cfg = {}, { tfMinutes = 5, everyMinutes = 5, resumeNow = null, startNow = null, bars = null, baseDir } = {}) {
  let data = bars;
  let label = 'sample';
  if (!data) {
    if (cfg.path) {
      const file = path.resolve(baseDir || process.cwd(), cfg.path);
      const tz = cfg.tzOffsetMinutes === 'nyclose' ? 'nyclose' : +cfg.tzOffsetMinutes || 0;
      data = /\.js$/i.test(file) ? loadSample(file).bars : SMC.parseCSV(fs.readFileSync(file, 'utf8'), tz);
      label = path.basename(file);
    } else {
      data = loadSample().bars;
    }
  }
  const tfSec = tfMinutes * 60;
  data = toTimeframe(data, tfSec, 'The replay data');
  if (data.length < 2) throw new Error('The replay data has fewer than 2 candles');
  let start = cfg.startIndex;
  if (cfg.start) {
    const t = Date.parse(cfg.start) / 1000;
    if (Number.isNaN(t)) throw new Error(`replay.start "${cfg.start}" is not a date`);
    start = data.findIndex(b => b.t >= t);
    if (start < 0) start = data.length - 1;
  }
  if (!Number.isInteger(start)) start = Math.max(1, data.length - 2000);
  start = Math.min(Math.max(1, start), data.length - 1);
  const step = (cfg.stepMinutes || everyMinutes) * 60;

  const src = {
    name: 'replay', lastNow: null,
    info: { data: label, candles: data.length, from: data[0].t, to: data[data.length - 1].t },
    done: false,
  };
  // resumeNow: the clock was already used up to here (next fetch moves on); startNow: fetch exactly here
  let now = resumeNow !== null && resumeNow !== undefined ? resumeNow
    : startNow !== null && startNow !== undefined ? startNow : data[start].t + 8;
  let used = resumeNow !== null && resumeNow !== undefined;

  src.fetchBars = async ({ count } = {}) => {
    if (used) now += step;
    used = true;
    src.lastNow = now;
    let hi = 0;
    while (hi < data.length && data[hi].t <= now) hi++;
    const out = data.slice(Math.max(0, hi - (count || hi)), hi).map(b => ({ ...b }));
    const last = out[out.length - 1];
    if (last && last.t + tfSec > now) {
      // the forming candle: only part of it has traded so far
      const f = Math.max(0, Math.min(1, (now - last.t) / tfSec));
      const c = last.o + (last.c - last.o) * f;
      Object.assign(last, { c, h: Math.max(last.o, c), l: Math.min(last.o, c), v: Math.round(last.v * f) });
    }
    src.done = hi >= data.length && now >= data[data.length - 1].t + tfSec;
    return out;
  };
  // the clock the next fetch will see, so the runner asks only for the candles it is missing
  src.nextNow = () => (used ? now + step : now);
  return src;
}

const NAMES = ['auto', 'mt5file', 'mt5', 'twelvedata', 'yahoo', 'csv', 'replay'];

function create(cfg, opts = {}) {
  const name = cfg.source;
  if (name === 'mt5') return mt5(cfg.mt5, opts);
  if (name === 'mt5file') return mt5File(cfg.mt5file, opts);
  if (name === 'twelvedata') return twelveData(cfg.twelvedata, opts);
  if (name === 'yahoo') return yahoo(cfg.yahoo, opts);
  if (name === 'csv') return csvFile(cfg.csv, opts);
  if (name === 'replay') return replay(cfg.replay, opts);
  throw new Error(`Unknown source "${name}": use ${NAMES.join(', ')}`);
}

/*
 * source "auto": the first feed that answers, best prices first. MT5 through the expert
 * advisor, then MT5 through Python, then Twelve Data when there is a key, then Yahoo (no key).
 * The pick holds until the scanner restarts, so one history never mixes two feeds.
 * Resolves to {name, source, tried: [{name, ok, why}]}.
 */
async function pickAuto(cfg, opts = {}, { probeCount = 20 } = {}) {
  const tried = [];
  const files = mt5FilePaths(cfg.mt5file, opts);
  // a feed that cannot work is skipped without asking it
  const skip = {
    mt5file: files && fs.existsSync(files.status) ? null : 'the GoldSMCExport expert has not written any candles',
    mt5: cfg.auto && cfg.auto.tryPython === false ? 'skipped' : null,
    twelvedata: cfg.twelvedata && cfg.twelvedata.apiKey ? null : 'no API key',
    yahoo: null,
  };
  for (const name of ['mt5file', 'mt5', 'twelvedata', 'yahoo']) {
    if (skip[name]) {
      tried.push({ name, ok: false, why: skip[name] });
      continue;
    }
    let src;
    try {
      src = create({ ...cfg, source: name }, opts);
      const bars = await src.fetchBars({ count: probeCount, now: Math.floor(Date.now() / 1000) });
      if (!bars.length) throw new Error('no candles');
      tried.push({ name, ok: true, why: null });
      return { name, source: src, tried };
    } catch (err) {
      tried.push({ name, ok: false, why: err.message });
    }
  }
  return { name: null, source: null, tried };
}

module.exports = {
  create, pickAuto, mt5, mt5File, mt5FilePaths, mt5CommonDir, twelveData, yahoo, csvFile, replay,
  parseTwelveData, parseYahoo, cleanBars, loadSample, runPython, serverDst, fixServerDst,
  TD_INTERVAL, MT5_TF, YH_INTERVAL, NAMES,
};
