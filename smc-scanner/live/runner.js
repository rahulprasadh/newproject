#!/usr/bin/env node
/*
 * Gold SMC Scanner, live. Every few minutes, just after a candle closes, it:
 *   1. fetches the latest candles (MetaTrader 5, Twelve Data, a CSV file, or a replay of the sample)
 *   2. keeps only closed candles and merges them into the saved history in live/data
 *   3. runs the SMC engine on 5m, and on 15m built from the 5m candles
 *   4. alerts each new signal once (the last processed candle is saved, so a restart never repeats one)
 *   5. retrains the next-move forecaster on the growing history every 12 new candles
 *   6. forecasts from the latest candle, saves latest-<SYMBOL>.json and serves a local dashboard
 *
 * node smc-scanner/live/runner.js [--config FILE] [--source mt5|twelvedata|csv|replay]
 *   [--symbol XAUUSD] [--timeframes 5,15] [--every 5] [--port 8787] [--once]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const SMC = require('../engine.js');
const P = require('../predict.js');
const sources = require('./sources.js');
const alerts = require('./alerts.js');

const ROOT = path.resolve(__dirname, '..');          // the smc-scanner folder the dashboard serves
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_CONFIG = path.join(__dirname, 'config.json');
const RETRAIN_EVERY = 12;      // new candles between forecaster retrains
const REVISE_BARS = 3;         // the newest saved candles a fetch may still correct
const GRACE_SEC = 8;           // runs start this long after a candle closes
const RETRY_MS = 60 * 1000;    // one extra try this soon after a failed fetch
const LATE_MS = 20 * 1000;     // a feed that has not got the candle that just closed is asked again after this
const TRIM_SLACK = 1000;       // history may grow this far past historyCandles before it is cut
const SENT_KEEP = 500;
const FORECAST_KEEP = 20000;
const WINDOW = 1500;           // candles per timeframe sent to the dashboard
const MIN_ROWS = 900;          // forecaster training rows needed before it is trained at all

const DEFAULTS = {
  source: 'mt5',
  symbol: 'XAUUSD',
  timeZone: 'Asia/Kolkata',
  everyMinutes: 5,
  timeframes: [5, 15],
  port: 8787,
  historyCandles: 50000,
  mt5: { python: '', pythonArgs: [], symbol: 'XAUUSD', serverUtcOffsetMinutes: 'auto', fallbackOffsetMinutes: null, terminalPath: '' },
  twelvedata: { apiKey: '', symbol: 'XAU/USD', maxCandles: 20000, base: '' },
  csv: { path: '', tzOffsetMinutes: 0 },
  replay: { startIndex: null, start: '', stepMinutes: null, path: '' },
  alerts: {
    on: 'entry', console: true, bell: true, results: true, maxAgeMinutes: 30,
    telegram: { botToken: '', chatId: '', base: '' },
  },
  engine: { spread: 0.25 },
  predict: {},
};

const USAGE = `Gold SMC Scanner, live

  node smc-scanner/live/runner.js [options]

  --config FILE        settings file (default: live/config.json when it exists)
  --source NAME        mt5, twelvedata, csv or replay (replay = the bundled sample, for a demo)
  --symbol NAME        name used in alerts and data files (default XAUUSD)
  --timeframes 5,15    timeframes to scan; the smallest is fetched, the others are built from it
  --every 5            minutes between checks (5 to 15)
  --port 8787          dashboard port (http://localhost:8787)
  --once               run one check and exit
  --cycles N           stop after N checks
  --fast               replay only: run the checks back to back instead of waiting for the clock
  --replay-start X     replay only: start at candle number X or at date X (e.g. 2026-09-01)
  --data-dir DIR       where history and state are kept (default live/data)
  --no-server          do not start the dashboard`;

// ---------- config ----------

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep merge for plain objects; keys starting with "_" are notes in the example config.
function merge(a, b) {
  if (!isObj(b)) return b === undefined ? a : b;
  const out = isObj(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith('_') || v === undefined) continue;
    out[k] = isObj(v) ? merge(out[k], v) : v;
  }
  return out;
}

function normalise(cfg) {
  const notes = [];
  let tfs = (Array.isArray(cfg.timeframes) ? cfg.timeframes : String(cfg.timeframes).split(','))
    .map(Number).filter(x => Number.isInteger(x) && x > 0);
  tfs = [...new Set(tfs)].sort((a, b) => a - b);
  if (!tfs.length) tfs = [5, 15];
  for (const tf of tfs) if (tf % tfs[0]) throw new Error(`timeframe ${tf}m is not a multiple of ${tfs[0]}m`);
  cfg.timeframes = tfs;
  let every = Math.round(+cfg.everyMinutes) || 5;
  if (every < 5 || every > 15) {
    const fixed = Math.min(15, Math.max(5, every));
    notes.push(`everyMinutes ${every} is outside 5-15, so checks run every ${fixed} minutes.`);
    every = fixed;
  }
  cfg.everyMinutes = every;
  if (!['entry', 'all'].includes(cfg.alerts.on)) {
    notes.push(`alerts.on "${cfg.alerts.on}" should be "entry" or "all"; using "entry".`);
    cfg.alerts.on = 'entry';
  }
  cfg.alerts.maxAgeMinutes = Math.max(1, +cfg.alerts.maxAgeMinutes || 30);
  cfg.historyCandles = Math.max(500, Math.round(+cfg.historyCandles) || DEFAULTS.historyCandles);
  const port = +cfg.port;
  cfg.port = Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULTS.port;
  cfg.symbol = String(cfg.symbol || 'XAUUSD').trim() || 'XAUUSD';
  cfg.engine = cfg.engine || {};
  cfg.predict = cfg.predict || {};
  cfg.notes = notes;
  return cfg;
}

function loadConfig(file, overrides = {}) {
  let user = {};
  if (file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`could not read ${file}: ${err.message}`);
    }
    try {
      user = JSON.parse(text.replace(/^﻿/, ''));   // Notepad may save a byte-order mark
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${err.message})`);
    }
  }
  const cfg = merge(merge(DEFAULTS, user), overrides);
  cfg.configDir = file ? path.dirname(path.resolve(file)) : process.cwd();
  return normalise(cfg);
}

function parseArgs(argv) {
  const a = { config: null, overrides: {}, once: false, cycles: null, fast: false, noServer: false, dataDir: null, help: false };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k], eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      if (eq > 0) return arg.slice(eq + 1);
      const v = argv[++k];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--config': a.config = value(); break;
      case '--source': a.overrides.source = value(); break;
      case '--symbol': a.overrides.symbol = value(); break;
      case '--timeframes': a.overrides.timeframes = value().split(',').map(Number); break;
      case '--every': a.overrides.everyMinutes = +value(); break;
      case '--port': a.overrides.port = +value(); break;
      case '--once': a.once = true; break;
      case '--cycles': a.cycles = Math.max(1, parseInt(value(), 10) || 1); break;
      case '--fast': a.fast = true; break;
      case '--no-server': a.noServer = true; break;
      case '--data-dir': a.dataDir = value(); break;
      case '--replay-start': {
        const v = value();
        a.overrides.replay = /^\d+$/.test(v) ? { startIndex: +v } : { start: v };
        break;
      }
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`Unknown option ${arg}. Try --help.`);
    }
  }
  return a;
}

// ---------- candles ----------

// A candle is closed once its end (open time + timeframe) is at least 2 s in the past.
const closedOnly = (bars, tfSec, nowSec) => bars.filter(b => b.t + tfSec <= nowSec - 2);

const sameBar = (a, b) => a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && (a.v || 0) === (b.v || 0);

/*
 * Merge fetched closed candles into the saved history. New candles are appended, the newest
 * reviseBars saved candles may be corrected (a feed can revise its last candles), and candles
 * older than the whole history are prepended. Fetched candles in the settled middle are ignored,
 * so a feed whose clock shifted (a DST change on the broker server) cannot duplicate old candles.
 */
function mergeBars(history, fresh, { reviseBars = REVISE_BARS } = {}) {
  const res = { bars: history, added: 0, revised: 0, inserted: 0, prepended: 0, ignored: 0 };
  const incoming = sources.cleanBars(fresh);
  if (!incoming.length) return res;
  if (!history.length) return { ...res, bars: incoming, added: incoming.length };
  const first = history[0].t, last = history[history.length - 1].t;
  const tailStart = Math.max(0, history.length - reviseBars), tailT = history[tailStart].t;
  const tail = new Map(history.slice(tailStart).map(b => [b.t, b]));
  const prefix = [];
  for (const b of incoming) {
    if (b.t < first) {
      prefix.push(b);
      res.prepended++;
    } else if (b.t < tailT) {
      res.ignored++;
    } else if (tail.has(b.t)) {
      if (!sameBar(tail.get(b.t), b)) {
        tail.set(b.t, b);
        res.revised++;
      }
    } else {
      tail.set(b.t, b);
      if (b.t > last) res.added++;
      else res.inserted++;
    }
  }
  if (!res.added && !res.revised && !res.inserted && !res.prepended) return res;
  res.bars = prefix.concat(history.slice(0, tailStart), [...tail.values()].sort((a, b) => a.t - b.t));
  return res;
}

// Higher timeframe from the base candles. The last bucket only counts once its last base candle is in.
function resampleClosed(bars, baseSec, tfSec) {
  if (tfSec === baseSec || !bars.length) return bars;
  const out = SMC.resample(bars, tfSec);
  const last = out[out.length - 1], lastBase = bars[bars.length - 1];
  if (last && last.t + tfSec > lastBase.t + baseSec) out.pop();
  return out;
}

// Index of the first candle with t > after (bars.length when there is none).
function firstAfter(bars, after) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t > after) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function indexOfT(bars, t) {
  const k = firstAfter(bars, t - 1);
  return k < bars.length && bars[k].t === t ? k : -1;
}

function readHistory(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(',');
    if (f.length < 5 || !/^\d/.test(f[0])) continue;
    out.push({ t: +f[0], o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5] || 0 });
  }
  return sources.cleanBars(out);
}

const historyText = bars =>
  't,open,high,low,close,volume\n' + bars.map(b => `${b.t},${b.o},${b.h},${b.l},${b.c},${b.v || 0}`).join('\n') + '\n';

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses the rename while another program (Excel) has the file open
    try {
      fs.writeFileSync(file, text);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
    }
  }
}

// ---------- scheduling ----------

// Next run: the next multiple of everyMinutes plus the grace, strictly after now (10:05:08, 10:10:08 ...).
function nextRunAt(nowMs, everyMinutes, graceSec = GRACE_SEC) {
  const step = everyMinutes * 60000, g = graceSec * 1000;
  let next = Math.ceil((nowMs - g) / step) * step + g;
  if (next <= nowMs) next += step;
  return next;
}

// ---------- signals ----------

const KIND_ORDER = { sweep: 0, choch: 1, armed: 2, entry: 3, result: 4, cancel: 5 };

/*
 * Everything worth an alert that became known on a candle after lastT (a candle open time).
 * Entries always; trade results when `results`; with mode 'all' also sweeps, CHoCHs, marked
 * zones and armed setups that were cancelled. A step on the candle where its setup also ended
 * without an entry is left out (its cancel alert says what happened).
 */
function collectAlerts(E, { lastT = null, mode = 'entry', results = true } = {}) {
  const B = E.bars, cut = lastT === null || lastT === undefined ? 0 : firstAfter(B, lastT);
  const out = [];
  if (cut >= B.length) return out;
  const byId = new Map(E.setups.map(s => [s.id, s]));
  const all = mode === 'all';
  const diedOn = (s, i) => s.endAt === i && !s.entry;
  for (const e of E.events) {
    if (e.at < cut || !e.setupId) continue;
    const s = byId.get(e.setupId);
    if (!s) continue;
    if (e.type === 'entry') out.push({ kind: 'entry', dir: e.dir, at: e.at, setup: s, event: e });
    else if (all && (e.type === 'sweep' || e.type === 'choch' || e.type === 'disp') && !diedOn(s, e.at)) {
      out.push({ kind: e.type === 'disp' ? 'armed' : e.type, dir: e.dir, at: e.at, setup: s, event: e });
    }
  }
  for (const s of E.setups) {
    const en = s.entry;
    if (results && en && en.exitAt !== null && en.exitAt >= cut) {
      out.push({ kind: 'result', dir: s.dir, at: en.exitAt, setup: s, event: en });
    }
    if (all && !en && s.armedAt !== null && s.endAt !== null && s.endAt >= cut) {
      out.push({ kind: 'cancel', dir: s.dir, at: s.endAt, setup: s, event: null });
    }
  }
  return out.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

// ---------- forecaster ----------

// The forecaster's defaults want ~9,000 candles; with less history it trains on 60% and tests on the rest.
function predictOptions(n, user = {}) {
  const o = { ...P.DEFAULTS, ...user };
  const rows = Math.floor((n - o.warmup) / o.stride);
  if (user.minTrain !== undefined || rows >= o.minTrain + 600) return o;
  if (rows < MIN_ROWS) return null;
  return { ...o, minTrain: Math.floor(rows * 0.6) };
}

const candlesNeeded = (user = {}) => {
  const o = { ...P.DEFAULTS, ...user };
  return MIN_ROWS * o.stride + o.warmup;
};

/*
 * How the scanner's own forecasts did once their windows closed. Each record is one forecast
 * made live: {tf, t, c, h: [[minutes, bars, pUp]], liq: [pAbove, abovePrice, belowPrice, bars] | null}.
 */
function scoreForecasts(records, bars) {
  const hz = {}, liq = { n: 0, hits: 0, hitRate: null };
  let pending = 0, since = null;
  const rate = s => { s.hitRate = s.n ? s.hits / s.n : null; };
  for (const r of records) {
    const k = indexOfT(bars, r.t);
    if (k < 0) continue;
    if (since === null || r.t < since) since = r.t;
    for (const [m, H, p] of r.h) {
      const s = hz[m] || (hz[m] = { minutes: m, n: 0, hits: 0, hitRate: null, confident: { n: 0, hits: 0, hitRate: null } });
      const j = k + H;
      if (j >= bars.length) { pending++; continue; }
      if (bars[j].c === bars[k].c) continue;
      const hit = (p >= 0.5) === (bars[j].c > bars[k].c);
      s.n++;
      if (hit) s.hits++;
      if (Math.abs(p - 0.5) >= 0.05) {
        s.confident.n++;
        if (hit) s.confident.hits++;
      }
    }
    if (r.liq) {
      if (r._liq === undefined) {
        const [p, above, below, H] = r.liq;
        let res = null;
        for (let j = k + 1; j <= Math.min(bars.length - 1, k + H); j++) {
          const up = bars[j].h >= above, down = bars[j].l <= below;
          if (up || down) {
            res = up && down ? 'skip' : ((p >= 0.5) === up ? 1 : 0);
            break;
          }
        }
        if (res === null && k + H < bars.length) res = 'skip';   // neither level taken in time
        if (res !== null) r._liq = res;
      }
      if (r._liq === undefined) pending++;
      else if (r._liq !== 'skip') {
        liq.n++;
        liq.hits += r._liq;
      }
    }
  }
  const horizons = Object.values(hz);
  for (const s of horizons) { rate(s); rate(s.confident); }
  rate(liq);
  return { since: since === null ? null : iso(since), forecasts: records.length, pending, horizons, liquidity: liq };
}

// ---------- dashboard state ----------

const iso = t => (t === null || t === undefined ? null : new Date(t * 1000).toISOString());

function qualityOf(model) {
  if (!model) return { ready: false, note: 'not trained yet' };
  const out = {
    ready: !!(model.wf && model.wf.live), note: model.note || null, trainedAt: iso(model.trainedAt / 1000),
    candles: model.n, seconds: +(model.ms / 1000).toFixed(2),
  };
  const wf = model.wf;
  if (!wf) return out;
  Object.assign(out, { rows: wf.rows, folds: wf.folds.length, horizons: wf.horizons, opts: { minTrain: wf.opts.minTrain, stride: wf.opts.stride }, targets: {} });
  for (const [t, m] of Object.entries(wf.metrics)) {
    out.targets[t] = {
      n: m.n, accuracy: m.accuracy, baseline: m.baseline, auc: m.auc, brier: m.brier, brierBase: m.brierBase,
      logloss: m.logloss, loglossBase: m.loglossBase, testPosRate: m.testPosRate,
      randomWalk: m.randomWalk || null, calibration: m.calibration, confident: m.confident,
    };
  }
  return out;
}

/*
 * One timeframe for the dashboard: the last `windowCandles` candles and everything drawn on
 * them, with every candle index re-based so bars[k] is the candle the index points at. An
 * index that starts before the window is clamped to 0; the object then also carries `t`,
 * the original candle time.
 */
function serialiseTimeframe(E, { tfSec, windowCandles = WINDOW, forecast = null, model = null, track = null } = {}) {
  const B = E.bars, n = B.length, off = Math.max(0, n - windowCandles), last = n - 1;
  const rb = k => (k === null || k === undefined ? k : Math.max(0, k - off));
  const tOf = k => (k === null || k === undefined ? null : B[k].t);
  const level = lv => lv && {
    ...lv, i: rb(lv.i), at: rb(lv.at), endAt: rb(lv.endAt), t: tOf(lv.i),
    ...(lv.touches ? { touches: lv.touches.map(rb) } : {}),
  };
  const zone = z => z && { ...z, i: rb(z.i), at: rb(z.at), endAt: rb(z.endAt), t: tOf(z.i) };
  const entry = e => e && {
    ...e, i: rb(e.i), at: rb(e.at), patternFrom: rb(e.patternFrom), exitAt: rb(e.exitAt), t: tOf(e.i), exitT: tOf(e.exitAt),
  };
  const setups = E.setups.filter(s => s.sweepAt >= off).map(s => {
    const out = {
      ...s,
      level: level(s.level),
      ref: s.ref && { ...s.ref, i: rb(s.ref.i), at: rb(s.ref.at), t: tOf(s.ref.i) },
      sweepAt: rb(s.sweepAt), chochAt: rb(s.chochAt), armedAt: rb(s.armedAt), touchAt: rb(s.touchAt), endAt: rb(s.endAt),
      disp: s.disp && { ...s.disp, i: rb(s.disp.i) },
      fvgZone: zone(s.fvgZone), obZone: zone(s.obZone), entry: entry(s.entry), sweepT: B[s.sweepAt].t,
    };
    // odds from earlier setups for the ones still in play
    if (s.endAt === null || (s.entry && s.entry.outcome === null)) out.odds = P.setupOdds(E, s, last);
    return out;
  });
  const liq = E.events.filter(e => e.type === 'liq' && (e.endAt === null || e.endAt >= off)).map(level);
  // the step events (sweep, CHoCH, volume candle, zones, entry) known inside the window
  const events = E.events.filter(e => e.setupId && e.at >= off).map(e => {
    const out = { ...e, i: rb(e.i), at: rb(e.at), t: tOf(e.i) };
    for (const k of ['endAt', 'exitAt', 'patternFrom', 'fromIdx', 'levelIdx']) if (k in e) out[k] = rb(e[k]);
    return out;
  });
  const recentSignals = E.setups.filter(s => s.entry).slice(-20).reverse().map(s => {
    const e = s.entry;
    return {
      setupId: s.id, dir: e.dir, side: e.dir === 'bull' ? 'BUY' : 'SELL', i: rb(e.i), inWindow: e.i >= off,
      time: iso(B[e.i].t), entry: e.entry, sl: e.sl, tp: e.tp, rr: e.rr, risk: e.risk,
      pattern: e.pattern, zone: e.zone, tpSrc: e.tpSrc, session: e.session,
      outcome: e.outcome, exitAt: rb(e.exitAt), exitTime: iso(tOf(e.exitAt)), exitPrice: e.exitPrice,
      mfeR: e.mfeR, maeR: e.maeR,
      label: s.label, src: s.src, sweptPrice: s.level.price, sweepTime: iso(B[s.sweepAt].t),
      chochPrice: s.ref ? s.ref.price : null, chochTime: iso(tOf(s.chochAt)), fvg: s.fvgZone ? s.fvgZone.kind : null,
      htfBias: s.htfBias, aligned: s.aligned,
      labels: [s.label, s.fvgZone ? s.fvgZone.kind : null, 'OB', e.pattern].filter(Boolean),
    };
  });
  const stage = s => (s ? { id: s.id, stage: s.stage, label: s.label } : null);
  return {
    tf: tfSec, totalCandles: n, windowStart: off, firstTime: iso(B[off].t), lastTime: iso(B[last].t),
    bars: B.slice(off).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 })),
    setups, liq, events, summary: E.summary(), recentSignals,
    active: { bull: stage(E.active.bull), bear: stage(E.active.bear) }, htfBias: E.htf ? E.htf.bias : null,
    forecast: forecast && { ...forecast, at: rb(forecast.at), time: iso(forecast.t) },
    quality: qualityOf(model), forecastTrack: track,
  };
}

// ---------- the scanner ----------

const fileKey = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

function makeLogger(timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  } catch (err) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }
  return msg => console.log(`${fmt.format(new Date())}  ${msg}`);
}

const SOURCE_NAMES = {
  mt5: 'MetaTrader 5', twelvedata: 'Twelve Data', csv: 'CSV file', replay: 'replay of the bundled sample (demo, not live prices)',
};

class LiveScanner {
  constructor(cfg, { source, notifier, log, clock, dataDir, lateRetryMs = LATE_MS, sleep } = {}) {
    this.cfg = cfg;
    this.lateRetryMs = lateRetryMs;
    this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.log = log || makeLogger(cfg.timeZone);
    this.clock = clock || (() => Date.now());
    this.dataDir = path.resolve(dataDir || DATA_DIR);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.tfs = cfg.timeframes;
    this.baseMin = this.tfs[0];
    this.baseSec = this.baseMin * 60;
    // replay data stays apart from real history
    const key = fileKey(cfg.symbol) + (cfg.source === 'replay' ? '-replay' : '');
    const file = name => path.join(this.dataDir, name);
    this.files = {
      history: file(`${key}-${this.baseMin}m.csv`), state: file(`state-${key}.json`),
      latest: file(`latest-${key}.json`), forecasts: file(`forecasts-${key}.jsonl`),
    };
    this.state = this._loadState();
    this.history = readHistory(this.files.history);
    this.source = source || sources.create(cfg, {
      tfMinutes: this.baseMin, everyMinutes: cfg.everyMinutes, resumeNow: this.state.replayNow,
      knownOffset: this.state.mt5Offset, baseDir: cfg.configDir,
    });
    this.notifier = notifier || alerts.createNotifier({ ...cfg.alerts, timeZone: cfg.timeZone }, { log: this.log });
    this.models = {};
    this.forecasts = this._loadForecasts();
    this.recentAlerts = [];
    this.health = {
      ok: null, error: null, lastFetchAt: null, lastOkAt: null, candles: this.history.length,
      lastCandle: this.history.length ? iso(this.history[this.history.length - 1].t) : null,
      clockSkewSec: null, volume: null,
    };
    this.said = new Set();
    this.nextRunAt = null;
    this.scheduled = false;
    this.retrying = false;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.latest = null;
  }

  banner() {
    const a = this.cfg.alerts, tg = this.notifier.telegramEnabled ? ', Telegram' : '';
    return `Gold SMC Scanner live · ${this.cfg.symbol} · source: ${SOURCE_NAMES[this.cfg.source] || this.cfg.source}`
      + ` · ${this.tfs.map(t => t + 'm').join(' + ')} · checks every ${this.cfg.everyMinutes} min`
      + ` · alerts: ${a.on === 'all' ? 'every step' : 'entries'} (${a.console !== false ? 'console' : ''}${tg})`;
  }

  _say(key, msg) {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.log(msg);
  }

  _loadState() {
    const blank = { version: 1, symbol: this.cfg.symbol, lastProcessed: {}, sent: [], mt5Offset: null, replayNow: null };
    try {
      const s = JSON.parse(fs.readFileSync(this.files.state, 'utf8'));
      return { ...blank, ...s, lastProcessed: { ...(s.lastProcessed || {}) }, sent: Array.isArray(s.sent) ? s.sent : [] };
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`Could not read ${this.files.state} (${err.message}); starting fresh.`);
      return blank;
    }
  }

  _saveState() {
    this.state.savedAt = new Date(this.clock()).toISOString();
    this._write(this.files.state, JSON.stringify(this.state, null, 1), 'state');
  }

  _write(file, text, what) {
    try {
      writeFileAtomic(file, text);
    } catch (err) {
      this.log(`Could not save the ${what} file ${file}: ${err.message}`);
    }
  }

  _loadForecasts() {
    let text = '';
    try {
      text = fs.readFileSync(this.files.forecasts, 'utf8');
    } catch (err) {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (err) { /* a line cut short by a crash */ }
    }
    return out.slice(-FORECAST_KEEP);
  }

  _logForecast(tfMin, f, model) {
    if (!f || !model || !model.wf) return;
    const mine = this.forecasts.filter(r => r.tf === tfMin);
    if (mine.length && f.t <= mine[mine.length - 1].t) return;
    const q = f.liquidity, r4 = x => Math.round(x * 1e4) / 1e4;
    const rec = {
      tf: tfMin, t: f.t, c: f.price, h: f.horizons.map(h => [h.minutes, h.bars, r4(h.pUp)]),
      liq: q && q.pAboveFirst !== null && q.above && q.below
        ? [r4(q.pAboveFirst), q.above.price, q.below.price, model.wf.horizons.liq] : null,
    };
    this.forecasts.push(rec);
    try {
      if (this.forecasts.length > FORECAST_KEEP * 1.25) {
        this.forecasts = this.forecasts.slice(-FORECAST_KEEP);
        writeFileAtomic(this.files.forecasts, this.forecasts.map(r => JSON.stringify({ ...r, _liq: undefined })).join('\n') + '\n');
      } else {
        fs.appendFileSync(this.files.forecasts, JSON.stringify(rec) + '\n');
      }
    } catch (err) {
      this._say('fclog', `Could not save the forecast log: ${err.message}`);
    }
  }

  // True when the newest closed candle (fetched or saved) is the one before the candle that just closed.
  _lateCandle(fetched, now) {
    const closed = closedOnly(fetched, this.baseSec, now);
    const saved = this.history.length ? this.history[this.history.length - 1].t : -Infinity;
    const newest = Math.max(saved, closed.length ? closed[closed.length - 1].t : -Infinity);
    const expected = Math.floor((now - 2) / this.baseSec) * this.baseSec - this.baseSec;
    return newest === expected - this.baseSec;
  }

  _fetchCount(localNow) {
    if (!this.history.length) return this.cfg.historyCandles;
    const now = this.source.nextNow ? this.source.nextNow() : localNow;
    const gap = Math.ceil((now - this.history[this.history.length - 1].t) / this.baseSec);
    return Math.min(this.cfg.historyCandles, Math.max(10, gap + REVISE_BARS + 2));
  }

  _train(tfMin, E) {
    const n = E.bars.length, opts = predictOptions(n, this.cfg.predict);
    const model = { n, firstT: E.bars[0].t, wf: null, trainedAt: this.clock(), ms: 0, note: null };
    if (!opts) {
      model.note = `collecting history: ${n.toLocaleString('en-US')} of about ${candlesNeeded(this.cfg.predict).toLocaleString('en-US')} candles needed`;
    } else {
      const t0 = Date.now();
      try {
        model.wf = P.walkForward(E, opts);
        if (!model.wf.live) model.note = 'not enough history for a tested model yet';
      } catch (err) {
        model.note = `training failed: ${err.message}`;
        this.log(`Forecaster training failed on ${tfMin}m: ${err.message}`);
      }
      model.ms = Date.now() - t0;
    }
    this.models[tfMin] = model;
    return model;
  }

  // Analyse one timeframe: engine, forecaster, and the alerts that are new since the last check.
  _scan(tfMin, now, reshaped) {
    const tfSec = tfMin * 60;
    const bars = tfMin === this.baseMin ? this.history : resampleClosed(this.history, this.baseSec, tfSec);
    const out = { tf: tfMin, tfSec, bars, engine: null, forecast: null, model: this.models[tfMin] || null, alerts: [], stale: 0, newCandles: 0, first: false };
    if (!bars.length) return out;
    const E = SMC.run(bars, this.cfg.engine), n = bars.length;
    out.engine = E;
    if (!E.hasVolume) {
      const feed = SOURCE_NAMES[this.source.name] && this.source.name !== 'replay' ? SOURCE_NAMES[this.source.name] : 'This feed';
      this._say('novol', `${feed} has no volume for ${this.cfg.symbol}, so the volume check on the displacement candle is skipped and only its size counts.`);
    }
    let model = this.models[tfMin];
    if (reshaped || !model || model.firstT !== bars[0].t || n - model.n >= RETRAIN_EVERY) model = this._train(tfMin, E);
    out.model = model;
    if (model.wf) {
      try {
        out.forecast = P.forecast(E, n - 1, model.wf);
      } catch (err) {
        this._say(`fc${tfMin}`, `Forecast failed on ${tfMin}m: ${err.message}`);
      }
    }
    this._logForecast(tfMin, out.forecast, model);

    const key = String(tfMin), prev = this.state.lastProcessed[key];
    const known = prev !== null && prev !== undefined;
    // first run: only what the newest candle brought counts as new
    const lastT = known ? prev : n >= 2 ? bars[n - 2].t : null;
    out.first = !known;
    out.newCandles = known ? n - firstAfter(bars, prev) : 0;
    const found = collectAlerts(E, { lastT, mode: this.cfg.alerts.on, results: this.cfg.alerts.results !== false });
    const sent = new Set(this.state.sent), maxAge = this.cfg.alerts.maxAgeMinutes * 60;
    for (const raw of found) {
      const t = bars[raw.at].t, k = `${tfMin}:${raw.kind}:${raw.dir}:${t}`;
      if (sent.has(k)) continue;
      // after the scanner was off for a while, old signals are counted but not sent
      if (t + tfSec < now - maxAge) {
        out.stale++;
        continue;
      }
      const a = this._alert(raw, E, tfMin, out.forecast);
      a.key = k;
      out.alerts.push(a);
    }
    this.state.lastProcessed[key] = known ? Math.max(prev, bars[n - 1].t) : bars[n - 1].t;
    return out;
  }

  _alert(raw, E, tfMin, forecast) {
    const B = E.bars, s = raw.setup, at = raw.at, known = k => k !== null && k <= at;
    const a = {
      kind: raw.kind, symbol: this.cfg.symbol, tfMin, dir: raw.dir, t: B[at].t, time: iso(B[at].t),
      timeZone: this.cfg.timeZone, entryZone: this.cfg.engine.entryZone || SMC.DEFAULTS.entryZone,
      setup: {
        id: s.id, label: s.label, src: s.src, levelPrice: s.level.price, sweepT: B[s.sweepAt].t,
        refPrice: s.ref ? s.ref.price : null, chochPrice: s.ref ? s.ref.price : null,
        chochT: known(s.chochAt) ? B[s.chochAt].t : null,
        fvgKind: known(s.armedAt) ? s.fvgZone.kind : null,
        fvg: s.fvgZone && { top: s.fvgZone.top, bottom: s.fvgZone.bottom },
        ob: s.obZone && { top: s.obZone.top, bottom: s.obZone.bottom },
        volX: s.disp ? s.disp.volX : null, reason: s.reason,
      },
      entry: s.entry ? { ...s.entry } : null,
      entryT: s.entry ? B[s.entry.i].t : null,
      forecast,
      odds: raw.kind === 'entry' || raw.kind === 'armed' ? P.setupOdds(E, s, at) : null,
    };
    a.text = alerts.message(a);
    return a;
  }

  async cycle() {
    if (this.busy) return { ok: false, skipped: true, error: 'a check is already running' };
    this.busy = true;
    try {
      return await this._cycle();
    } catch (err) {
      return this._fail(err, 'Check failed');
    } finally {
      this.busy = false;
    }
  }

  async _cycle() {
    const localNow = Math.floor(this.clock() / 1000);
    let fetched;
    try {
      fetched = await this.source.fetchBars({ count: this._fetchCount(localNow), now: localNow });
    } catch (err) {
      return this._fail(err, 'Fetch failed');
    }
    const src = this.source;
    let now = Number.isFinite(src.lastNow) ? src.lastNow : localNow;
    if (src.name !== 'replay' && this.lateRetryMs > 0 && this._lateCandle(fetched, now)) {
      // the feed was live a candle ago but lacks the one that just closed: it is usually seconds late
      await this.sleep(this.lateRetryMs);
      try {
        const more = await src.fetchBars({ count: REVISE_BARS + 2, now: Math.floor(this.clock() / 1000) });
        fetched = fetched.concat(more);
        now = Number.isFinite(src.lastNow) ? src.lastNow : Math.floor(this.clock() / 1000);
      } catch (err) { /* keep the first answer */ }
    }
    if (src.name === 'replay') {
      this.state.replayNow = src.lastNow;
    } else if (Number.isFinite(src.lastNow)) {
      this.health.clockSkewSec = src.lastNow - localNow;
      if (Math.abs(this.health.clockSkewSec) > 60) {
        this._say('skew', `This PC's clock is ${Math.abs(this.health.clockSkewSec)} s ${this.health.clockSkewSec > 0 ? 'behind' : 'ahead of'} the data source; the source's clock is used to tell closed candles.`);
      }
    }
    if (src.name === 'mt5' && src.info && src.info.offsetSource === 'auto') this.state.mt5Offset = src.info.serverOffsetMinutes;

    const m = mergeBars(this.history, closedOnly(fetched, this.baseSec, now));
    let bars = m.bars, trimmed = 0;
    if (bars.length > this.cfg.historyCandles + TRIM_SLACK) {
      trimmed = bars.length - this.cfg.historyCandles;
      bars = bars.slice(trimmed);
    }
    this.history = bars;
    if (m.added || m.revised || m.inserted || m.prepended || trimmed) this._write(this.files.history, historyText(bars), 'history');
    Object.assign(this.health, {
      lastFetchAt: new Date(this.clock()).toISOString(), sourceTime: iso(now), fetched: fetched.length, candles: bars.length,
      lastCandle: bars.length ? iso(bars[bars.length - 1].t) : null,
    });
    if (!bars.length) return this._fail(new Error('no closed candles yet'), 'Nothing to scan');

    // candles were inserted or cut at the front: indices moved, so the forecaster retrains
    const reshaped = m.inserted > 0 || m.prepended > 0 || trimmed > 0;
    const results = {}, pending = [];
    let stale = 0;
    for (const tf of this.tfs) {
      const r = this._scan(tf, now, reshaped);
      results[tf] = r;
      pending.push(...r.alerts);
      stale += r.stale;
    }
    // save what was processed before sending, so a crash or restart never sends an alert twice
    this.state.sent = this.state.sent.concat(pending.map(a => a.key)).slice(-SENT_KEEP);
    this._saveState();
    for (const a of pending) {
      a.delivery = await Promise.resolve().then(() => this.notifier.send(a)).catch(err => ({ error: err.message }));
      this.recentAlerts.unshift({ time: a.time, kind: a.kind, tf: a.tfMin, dir: a.dir, text: a.text, sentAt: new Date(this.clock()).toISOString() });
    }
    this.recentAlerts = this.recentAlerts.slice(0, 30);
    Object.assign(this.health, { ok: true, error: null, lastOkAt: new Date(this.clock()).toISOString(), volume: results[this.baseMin].engine.hasVolume });
    this.retrying = false;
    const next = this._planNext(true);
    this.latest = this._apiState(results, now);
    this._write(this.files.latest, JSON.stringify(this.latest), 'latest state');
    const line = this._summary(results, pending.length, stale, next);
    this.log(line);
    return { ok: true, now, fetched: fetched.length, merge: { ...m, bars: undefined }, trimmed, alerts: pending, stale, line, results };
  }

  _fail(err, what) {
    const msg = err && err.message ? err.message : String(err);
    Object.assign(this.health, { ok: false, error: msg, lastErrorAt: new Date(this.clock()).toISOString() });
    const next = this._planNext(false);
    const when = next ? `; trying again at ${this._clockText(next / 1000)}` : '';
    this.log(`${what}: ${msg}. Keeping the last data${when}.`);
    return { ok: false, error: msg };
  }

  // After a failure the next try comes after 60 s (once), otherwise at the next aligned time.
  _planNext(ok) {
    if (!this.scheduled) return null;
    const now = this.clock();
    let next = nextRunAt(now, this.cfg.everyMinutes);
    this.nextIsRetry = false;
    if (!ok && !this.retrying && now + RETRY_MS < next) {
      next = now + RETRY_MS;
      this.nextIsRetry = true;
    }
    this.nextRunAt = next;
    return next;
  }

  _clockText(t) {
    return alerts.clock(Math.floor(t), this.cfg.timeZone) + ':' + String(Math.floor(t) % 60).padStart(2, '0');
  }

  _summary(results, nAlerts, stale, next) {
    const tz = this.cfg.timeZone, last = this.history[this.history.length - 1], parts = [];
    parts.push(`${this.cfg.symbol} ${alerts.price(last.c)} (${alerts.clock(last.t, tz)} candle)`);
    for (const tf of this.tfs) {
      const r = results[tf];
      if (!r.engine) {
        parts.push(`${tf}m: no closed candle yet`);
        continue;
      }
      const bits = [r.first ? 'first check' : r.newCandles ? `+${r.newCandles} candle${r.newCandles === 1 ? '' : 's'}` : 'no new candle'];
      const act = ['bull', 'bear'].map(d => r.engine.active[d]).filter(Boolean).map(s => {
        const w = s.dir === 'bull' ? 'buy' : 'sell';
        if (s.stage === 'armed') return `${w} armed at OB ${alerts.price(s.obZone.bottom)}–${alerts.price(s.obZone.top)}`;
        if (s.stage === 'choch') return `${w} CHoCH, waiting for a volume candle`;
        return `${w} watch: ${s.label} swept`;
      });
      for (const e of r.engine.open) {
        act.push(`${e.dir === 'bull' ? 'buy' : 'sell'} trade open from ${alerts.price(e.entry)} (SL ${alerts.price(e.sl)}, TP ${alerts.price(e.tp)})`);
      }
      bits.push(act.length ? act.join(', ') : 'no setup');
      const f = r.forecast;
      if (f) {
        const h = f.horizons.find(x => x.minutes === 60) || f.horizons[0], up = h.pUp >= 0.5;
        bits.push(`next ${h.minutes >= 60 ? h.minutes / 60 + 'h' : h.minutes + 'm'} ${Math.round(100 * (up ? h.pUp : 1 - h.pUp))}% ${up ? 'up' : 'down'} (${h.confidence})`);
        const q = f.liquidity;
        if (q.pAboveFirst !== null) {
          const a = q.pAboveFirst >= 0.5, lv = a ? q.above : q.below;
          bits.push(`${lv.label} ${alerts.price(lv.price)} first ${Math.round(100 * (a ? q.pAboveFirst : 1 - q.pAboveFirst))}%`);
        }
      } else {
        bits.push(r.model && r.model.note ? `forecast: ${r.model.note}` : 'forecast not ready');
      }
      parts.push(`${tf}m: ${bits.join(', ')}`);
    }
    if (nAlerts) parts.push(`${nAlerts} alert${nAlerts === 1 ? '' : 's'}`);
    if (stale) parts.push(`${stale} older signal${stale === 1 ? '' : 's'} not sent (scanner was off)`);
    if (next) parts.push(`next check ${this._clockText(next / 1000)}`);
    return parts.join(' · ');
  }

  _apiState(results, now) {
    const out = {
      symbol: this.cfg.symbol, source: this.source.name, live: this.source.name !== 'replay',
      updatedAt: new Date(this.clock()).toISOString(), dataTime: iso(now),
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      everyMinutes: this.cfg.everyMinutes, timeZone: this.cfg.timeZone,
      health: { ...this.health },
      alerts: { on: this.cfg.alerts.on, telegram: !!this.notifier.telegramEnabled, recent: this.recentAlerts },
      timeframes: {},
    };
    for (const tf of this.tfs) {
      const r = results[tf];
      if (!r || !r.engine) continue;
      out.timeframes[String(tf)] = serialiseTimeframe(r.engine, {
        tfSec: r.tfSec, forecast: r.forecast, model: r.model,
        track: scoreForecasts(this.forecasts.filter(x => x.tf === tf), r.bars),
      });
    }
    return out;
  }

  // What GET /api/state returns: the last good scan with the current health and next run.
  apiState() {
    const base = this.latest || {
      symbol: this.cfg.symbol, source: this.source.name, live: this.source.name !== 'replay', updatedAt: null,
      everyMinutes: this.cfg.everyMinutes, timeZone: this.cfg.timeZone, alerts: { on: this.cfg.alerts.on, recent: [] }, timeframes: {},
    };
    const health = { ...this.health };
    if (!this.latest && !health.error) health.error = 'waiting for the first check';
    return { ...base, nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null, health };
  }

  /*
   * Check now, then on every aligned time until stop() or `cycles` checks. With fast (replay)
   * the checks run back to back. Checks never overlap: the next is planned after one ends.
   */
  run({ cycles = Infinity, fast = false, delayMs = 0 } = {}) {
    this.running = true;
    this.scheduled = !fast;
    return new Promise(resolve => {
      let done = 0;
      this._resolveRun = resolve;
      const step = async () => {
        this.timer = null;
        if (!this.running) return resolve();
        await this.cycle();
        done++;
        if (!this.running || done >= cycles || (fast && this.source.done)) {
          if (fast && this.source.done) this.log('The replay reached the end of its data.');
          this.running = false;
          this.nextRunAt = null;
          return resolve();
        }
        const now = this.clock();
        let next = now + delayMs;
        if (!fast) {
          next = this.nextRunAt || nextRunAt(now, this.cfg.everyMinutes);
          this.retrying = !!this.nextIsRetry;
        }
        this.timer = setTimeout(step, Math.max(0, next - now));
      };
      step();
    });
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this._resolveRun) this._resolveRun();
  }
}

// ---------- HTTP server ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};
const TEXT = 'text/plain; charset=utf-8';

// The same skeleton the artifact host puts around index.html.
const PAGE_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>';
const PAGE_TAIL = '</body></html>';
const wrapPage = html => (/^\s*<!doctype/i.test(html) ? html : PAGE_HEAD + html + PAGE_TAIL);

// Only this PC's own addresses, so a web page on another site cannot reach the server by DNS tricks.
function localHost(host) {
  if (!host) return true;
  const h = String(host).toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

// The file a URL path points at inside root, or null when it is outside root, hidden or private.
function safePath(root, urlPath) {
  if (urlPath.includes('\0')) return null;
  const rel = urlPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = rel.split('/').filter(s => s !== '');
  if (!segs.length) return null;
  // dot files and "..", Windows device/stream syntax, names Windows would silently trim
  if (segs.some(s => s.startsWith('.') || /[:*?"<>|]/.test(s) || /[. ]$/.test(s))) return null;
  const clean = segs.join('/');
  if (/^live\/(data(\/|$)|[^/]*config[^/]*\.json$)/i.test(clean)) return null;   // secrets and runtime data
  if (!TYPES[path.extname(clean).toLowerCase()]) return null;
  const file = path.resolve(root, ...segs);
  const r = path.relative(root, file);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return file;
}

function send(res, status, type, body, method = 'GET', headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-type': type, 'content-length': buf.length, 'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache', ...headers,
  });
  res.end(method === 'HEAD' ? undefined : buf);
}

function createServer(scanner, { root = ROOT } = {}) {
  const rootDir = path.resolve(root);
  return http.createServer((req, res) => {
    const method = req.method;
    try {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, TEXT, 'Method not allowed', method, { allow: 'GET, HEAD' });
      if (!localHost(req.headers.host)) return send(res, 403, TEXT, 'Forbidden', method);
      let p;
      try {
        p = decodeURIComponent(String(req.url || '/').split(/[?#]/)[0]);
      } catch (err) {
        return send(res, 400, TEXT, 'Bad request', method);
      }
      if (p === '/api/state') {
        return send(res, 200, TYPES['.json'], JSON.stringify(scanner.apiState()), method, { 'cache-control': 'no-store' });
      }
      if (p === '/' || p === '/index.html') {
        return fs.readFile(path.join(rootDir, 'index.html'), 'utf8', (err, html) => {
          if (err) return send(res, 404, TEXT, 'index.html not found', method);
          send(res, 200, TYPES['.html'], wrapPage(html), method);
        });
      }
      const file = safePath(rootDir, p);
      if (!file) return send(res, 403, TEXT, 'Forbidden', method);
      fs.readFile(file, (err, buf) => {
        if (err) return send(res, 404, TEXT, 'Not found', method);
        send(res, 200, TYPES[path.extname(file).toLowerCase()], buf, method);
      });
    } catch (err) {
      if (!res.headersSent) send(res, 500, TEXT, 'Server error', method);
    }
  });
}

function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = err => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

// ---------- command line ----------

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const cfgFile = args.config || (fs.existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : null);
  let cfg, scanner;
  try {
    cfg = loadConfig(cfgFile, args.overrides);
    scanner = new LiveScanner(cfg, { dataDir: args.dataDir || undefined });
  } catch (err) {
    console.error(`Could not start: ${err.message}`);
    return 1;
  }
  const log = scanner.log;
  log(scanner.banner());
  if (!cfgFile) log('No config.json yet, so the defaults are used. Copy live/config.example.json to live/config.json to choose your source and alerts.');
  for (const note of cfg.notes) log(note);

  if (args.once) {
    const r = await scanner.cycle();
    return r.ok ? 0 : 1;
  }
  let server = null;
  if (!args.noServer) {
    server = createServer(scanner);
    try {
      const port = await listen(server, cfg.port);
      log(`Dashboard: http://localhost:${port}  (press Ctrl+C to stop)`);
    } catch (err) {
      log(err.code === 'EADDRINUSE'
        ? `Port ${cfg.port} is already in use. Is the scanner already running in another window? Close it, or set another port in config.json.`
        : `Could not start the dashboard: ${err.message}`);
      return 1;
    }
  }
  const stop = () => {
    log('Stopping.');
    scanner.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await scanner.run({ cycles: args.cycles || Infinity, fast: args.fast });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (server) {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(r => server.close(() => r()));
  }
  return scanner.health.ok === false ? 1 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, err => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS, USAGE, loadConfig, parseArgs, merge, closedOnly, mergeBars, resampleClosed, firstAfter,
  readHistory, historyText, nextRunAt, collectAlerts, predictOptions, scoreForecasts, serialiseTimeframe,
  LiveScanner, createServer, listen, safePath, wrapPage, localHost, main,
  PAGE_HEAD, PAGE_TAIL, RETRAIN_EVERY,
};
