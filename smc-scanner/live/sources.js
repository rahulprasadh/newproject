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
    src.info = {
      symbol: json.symbol || src.info.symbol, serverOffsetMinutes: json.serverOffsetMinutes,
      offsetSource: json.offsetSource, tickFresh: !!json.tickFresh,
    };
    if (json.offsetSource === 'auto') src.knownOffset = json.serverOffsetMinutes;
    return cleanBars(json.bars);
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
    const bars = toTimeframe(SMC.parseCSV(text, +cfg.tzOffsetMinutes || 0), tfMinutes * 60, 'The CSV file');
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
      data = /\.js$/i.test(file) ? loadSample(file).bars : SMC.parseCSV(fs.readFileSync(file, 'utf8'), +cfg.tzOffsetMinutes || 0);
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

function create(cfg, opts = {}) {
  const name = cfg.source;
  if (name === 'mt5') return mt5(cfg.mt5, opts);
  if (name === 'twelvedata') return twelveData(cfg.twelvedata, opts);
  if (name === 'csv') return csvFile(cfg.csv, opts);
  if (name === 'replay') return replay(cfg.replay, opts);
  throw new Error(`Unknown source "${name}": use mt5, twelvedata, csv or replay`);
}

module.exports = {
  create, mt5, twelveData, csvFile, replay, parseTwelveData, cleanBars, loadSample, runPython,
  TD_INTERVAL, MT5_TF,
};
