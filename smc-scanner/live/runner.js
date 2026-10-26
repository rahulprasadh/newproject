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
 * node smc-scanner/live/runner.js [--config FILE] [--source auto|mt5file|mt5|twelvedata|yahoo|csv|replay]
 *   [--symbol XAUUSD] [--timeframes 5,15] [--every 5] [--port 8787] [--once] [--open]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const SMC = require('../engine.js');
const P = require('../predict.js');
const Candles = require('../candles.js');
const LAB = require('../patternlab.js');
const ADV = require('../advisor.js');
const sources = require('./sources.js');
const alerts = require('./alerts.js');
const { createNews, NEWS_DEFAULTS } = require('./news.js');
const { request } = require('./http.js');

const ROOT = path.resolve(__dirname, '..');          // the smc-scanner folder the dashboard serves
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_CONFIG = path.join(__dirname, 'config.json');
const VENDOR_LWC = path.join(ROOT, 'vendor', 'lightweight-charts.standalone.production.js');
const CDN_LWC = /https:\/\/cdn\.jsdelivr\.net\/npm\/lightweight-charts@[\d.]+\/dist\/lightweight-charts\.standalone\.production\.js/;
const LOG_MAX = 2 * 1024 * 1024;  // scanner.log is rolled over to scanner.log.1 at this size
const MASK = '••••••';             // what /api/config shows instead of a saved secret
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
  source: 'auto',
  symbol: 'XAUUSD',
  timeZone: 'Asia/Kolkata',
  everyMinutes: 5,
  timeframes: [5, 15],
  port: 8787,
  historyCandles: 50000,
  marketHours: true,
  mt5file: { folder: '', path: '', symbol: '', maxStatusAgeSeconds: 180, dst: 'auto' },
  mt5: {
    python: '', pythonArgs: [], symbol: 'XAUUSD', serverUtcOffsetMinutes: 'auto', fallbackOffsetMinutes: null,
    terminalPath: '', dst: 'auto', findSymbol: true,
  },
  twelvedata: { apiKey: '', symbol: 'XAU/USD', maxCandles: 20000, base: '' },
  yahoo: { symbol: 'GC=F', base: '' },
  csv: { path: '', tzOffsetMinutes: 0 },
  replay: { startIndex: null, start: '', stepMinutes: null, path: '' },
  alerts: {
    on: 'entry', console: true, bell: true, results: true, maxAgeMinutes: 30, minGrade: 'C',
    telegram: { botToken: '', chatId: '', base: '' },
  },
  risk: { balance: 0, percent: 1, currency: 'USD', usdRate: 1, contractSize: 100, minLot: 0.01, lotStep: 0.01 },
  news: { ...NEWS_DEFAULTS },
  engine: { spread: 0.25 },
  predict: {},
};

// Settings that hold secrets: /api/config shows MASK instead, and MASK sent back keeps the saved value.
const SECRETS = [['twelvedata', 'apiKey'], ['alerts', 'telegram', 'botToken']];

const USAGE = `Gold SMC Scanner, live

  node smc-scanner/live/runner.js [options]

  --config FILE        settings file (default: live/config.json when it exists)
  --source NAME        auto (default: the first that works of mt5file, mt5, twelvedata, yahoo),
                       mt5file (MT5 through the GoldSMCExport expert), mt5 (MT5 through Python),
                       twelvedata, yahoo (free, gold futures, ~10 min late), csv,
                       or replay (the bundled sample, a demo)
  --symbol NAME        name used in alerts and data files (default XAUUSD)
  --timeframes 5,15    timeframes to scan; the smallest is fetched, the others are built from it
  --every 5            minutes between checks (5 to 15)
  --port 8787          dashboard port (http://localhost:8787)
  --once               run one check and exit
  --plan               run one check, print the full trade plan for every timeframe, and exit
  --cycles N           stop after N checks
  --fast               replay only: run the checks back to back instead of waiting for the clock
  --replay-start X     replay only: start at candle number X or at date X (e.g. 2026-09-01)
  --data-dir DIR       where history and state are kept (default live/data)
  --open               open the dashboard in the browser once it is up
  --stay               keep the dashboard open after --cycles or a --fast replay finish
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
  if (!sources.NAMES.includes(cfg.source)) throw new Error(`source "${cfg.source}" is not one of ${sources.NAMES.join(', ')}`);
  if (!SMC.GRADES.includes(cfg.alerts.minGrade)) {
    notes.push(`alerts.minGrade "${cfg.alerts.minGrade}" should be A+, A, B or C; using C (every grade).`);
    cfg.alerts.minGrade = 'C';
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timeZone });
  } catch (err) {
    notes.push(`timeZone "${cfg.timeZone}" is not a known zone name; using Asia/Kolkata.`);
    cfg.timeZone = 'Asia/Kolkata';
  }
  cfg.engine = cfg.engine || {};
  cfg.predict = cfg.predict || {};
  cfg.notes = notes;
  return cfg;
}

function readUserConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));   // Notepad may save a byte-order mark
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message})`);
  }
}

/*
 * Defaults, then the file, then command-line overrides. With lenient, a broken file is reported
 * in cfg.configError and the defaults are used, so the dashboard can still open and fix it.
 */
function loadConfig(file, overrides = {}, { lenient = false } = {}) {
  let user = {}, configError = null;
  // a settings file that does not exist yet is not an error: the Setup tab creates it
  if (file && lenient && !fs.existsSync(file)) file = null;
  if (file) {
    try {
      user = readUserConfig(file);
      if (!isObj(user)) throw new Error(`${file} should hold one { ... } object`);
    } catch (err) {
      if (!lenient) throw err;
      configError = err.message;
      user = {};
    }
  }
  let cfg;
  try {
    // a deep copy: merge shares untouched nested objects with DEFAULTS, and normalise edits in place
    cfg = normalise(structuredClone(merge(merge(DEFAULTS, user), overrides)));
  } catch (err) {
    if (!lenient) throw err;
    configError = configError || `${file || 'the settings'}: ${err.message}`;
    cfg = normalise(structuredClone(merge(DEFAULTS, overrides)));
  }
  cfg.configDir = file ? path.dirname(path.resolve(file)) : process.cwd();
  cfg.configFile = file ? path.resolve(file) : null;
  cfg.configError = configError;
  return cfg;
}

function parseArgs(argv) {
  const a = { config: null, overrides: {}, once: false, cycles: null, fast: false, noServer: false, dataDir: null, help: false, open: false, stay: false };
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
      case '--plan':
        // a one-off look: print only, so a scanner already running is the one that sends Telegram
        a.once = true;
        a.plan = true;
        a.overrides.alerts = merge(a.overrides.alerts, { telegram: { botToken: '' } });
        break;
      case '--cycles': a.cycles = Math.max(1, parseInt(value(), 10) || 1); break;
      case '--fast': a.fast = true; break;
      case '--no-server': a.noServer = true; break;
      case '--open': a.open = true; break;
      case '--stay': a.stay = true; break;
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

// the engine's own entry patterns under their candles.js names, so an alert does not repeat them
const SAME_AS_ENTRY = {
  'Pin bar': ['bullPin', 'bearPin'], 'Head & shoulders': ['invHeadShoulders', 'headShoulders'],
  'Three pins': ['bullThreePins', 'bearThreePins'], Engulfing: ['bullEngulfing', 'bearEngulfing'],
};

// What the dashboard gets from a pattern-lab study: everything but the fitted model itself.
function labSummary(res) {
  if (!res) return null;
  const { live, keys, ...rest } = res;
  return rest;
}

const KIND_ORDER = { sweep: 0, choch: 1, armed: 2, touch: 3, entry: 4, result: 5, cancel: 6 };

/*
 * Everything worth an alert that became known on a candle after lastT (a candle open time).
 * Entries always; trade results when `results`; with mode 'all' also sweeps, CHoCHs, marked
 * zones, price reaching a zone ("get ready") and armed setups that were cancelled. A step on
 * the candle where its setup also ended without an entry is left out (its cancel alert says
 * what happened), and so is a zone touch on the entry candle itself.
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
    if (all && s.touchAt !== null && s.touchAt >= cut && !(en && en.i === s.touchAt) && !diedOn(s, s.touchAt)) {
      out.push({ kind: 'touch', dir: s.dir, at: s.touchAt, setup: s, event: null });
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
function serialiseTimeframe(E, { tfSec, windowCandles = WINDOW, forecast = null, model = null, track = null, patternStats = null, plan = null, lab = null, patternsNow = null } = {}) {
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
    quality: qualityOf(model), forecastTrack: track, patternStats, plan, lab: labSummary(lab),
    // patterns on the last candles, each scored by the pattern lab
    patternsNow: patternsNow && patternsNow.map(h => ({ ...h, i: rb(h.i), from: rb(h.from), t: tOf(h.i) })),
  };
}

// ---------- the scanner ----------

const fileKey = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');

/*
 * Console lines with the time in the trader's zone. With a file, every line is also appended to
 * it (with the date), so what happened stays readable after the window is closed.
 */
function makeLogger(timeZone, { file = null, print = console.log } = {}) {
  const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  let fmt, dfmt;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone });
    dfmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
  } catch (err) {
    fmt = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });
    dfmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' });
  }
  let broken = false;
  const log = msg => {
    const now = new Date(), line = `${fmt.format(now)}  ${msg}`;
    print(line);
    if (!file || broken) return;
    try {
      try {
        if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + '.1');
      } catch (err) { /* no log yet */ }
      fs.appendFileSync(file, `${dfmt.format(now)} ${line}\n`);
    } catch (err) {
      broken = true;   // a full disk or a locked file must not stop the scanner
    }
  };
  log.file = file;
  return log;
}

const SOURCE_NAMES = {
  auto: 'automatic', mt5file: 'MetaTrader 5 (GoldSMCExport)', mt5: 'MetaTrader 5', twelvedata: 'Twelve Data',
  yahoo: 'Yahoo Finance gold futures (GC=F, about 10 min late)', csv: 'CSV file',
  replay: 'replay of the bundled sample (demo, not live prices)',
};

// Feeds with the same prices share one history: MT5 through Python or through the expert advisor.
const HISTORY_FAMILY = { mt5: 'mt5', mt5file: 'mt5', twelvedata: 'twelvedata', yahoo: 'yahoo', csv: 'csv', replay: 'replay' };

// The first moment of the closed period t is in (a weekend or the daily break), or null when open.
function closedSince(t) {
  if (SMC.marketStatus(t).open) return null;
  let x = Math.floor(t / 300) * 300;
  for (let k = 0; k < 700 && !SMC.marketStatus(x - 300).open; k++) x -= 300;
  return x;
}

class LiveScanner {
  /*
   * source "auto" has to be resolved first (LiveScanner.create does that); every other source
   * is created here unless one is passed in.
   */
  constructor(cfg, { source, notifier, log, clock, dataDir, lateRetryMs = LATE_MS, sleep, news, autoPick = null } = {}) {
    this.cfg = cfg;
    this.lateRetryMs = lateRetryMs;
    this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.dataDir = path.resolve(dataDir || DATA_DIR);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.log = log || makeLogger(cfg.timeZone, { file: path.join(this.dataDir, 'scanner.log') });
    this.clock = clock || (() => Date.now());
    this.tfs = cfg.timeframes;
    this.baseMin = this.tfs[0];
    this.baseSec = this.baseMin * 60;
    const name = source ? source.name : cfg.source;
    if (name === 'auto') throw new Error('source "auto" has to be resolved first: use LiveScanner.create');
    this.sourceName = name;
    this.autoPick = autoPick;
    // each feed keeps its own history (replay data stays apart from real history)
    const key = `${fileKey(cfg.symbol)}-${HISTORY_FAMILY[name] || fileKey(name)}`;
    const file = n => path.join(this.dataDir, n);
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
    // news times only mean something for live prices
    this.news = news !== undefined ? news : name === 'replay' ? null
      : createNews(cfg.news, { dataDir: this.dataDir, log: this.log, clock: this.clock });
    this.retry = [];   // alerts Telegram did not take, tried again at the next checks
    this.models = {};
    this.patternStats = {};
    this.labs = {};
    this.forecasts = this._loadForecasts();
    this.recentAlerts = [];
    this.health = {
      ok: null, error: null, lastFetchAt: null, lastOkAt: null, candles: this.history.length,
      lastCandle: this.history.length ? iso(this.history[this.history.length - 1].t) : null,
      clockSkewSec: null, volume: null, market: null, lagMinutes: null,
    };
    this.lastOkSec = null;
    this.said = new Set();
    this.nextRunAt = null;
    this.scheduled = false;
    this.retrying = false;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.latest = null;
  }

  // Resolves source "auto" (trying each feed), then builds the scanner.
  static async create(cfg, opts = {}) {
    if (cfg.source !== 'auto' || opts.source) return new LiveScanner(cfg, opts);
    const tfMinutes = cfg.timeframes[0];
    const pick = await sources.pickAuto(cfg, { tfMinutes, everyMinutes: cfg.everyMinutes, baseDir: cfg.configDir });
    if (!pick.source) {
      const why = pick.tried.map(t => `${SOURCE_NAMES[t.name] || t.name}: ${String(t.why).replace(/\.$/, '')}`).join('; ');
      throw new Error(`no data source answered (${why}). Check the internet connection, or open the Setup tab`);
    }
    return new LiveScanner(cfg, { ...opts, source: pick.source, autoPick: pick });
  }

  banner() {
    const a = this.cfg.alerts, tg = this.notifier.telegramEnabled ? ', Telegram' : '';
    const auto = this.autoPick ? ' (picked automatically)' : '';
    return `Gold SMC Scanner live · ${this.cfg.symbol} · source: ${SOURCE_NAMES[this.sourceName] || this.sourceName}${auto}`
      + ` · ${this.tfs.map(t => t + 'm').join(' + ')} · checks every ${this.cfg.everyMinutes} min`
      + ` · alerts: ${a.on === 'all' ? 'every step' : 'entries'} (${a.console !== false ? 'console' : ''}${tg})`;
  }

  _say(key, msg) {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.log(msg);
  }

  _loadState() {
    const blank = { version: 1, symbol: this.cfg.symbol, lastProcessed: {}, sent: [], mt5Offset: null, replayNow: null, retry: [] };
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

  // How each candlestick pattern did on the whole history, alone and in context (the Patterns tab).
  _patternStats(tfMin, E) {
    let hits;
    try {
      hits = Candles.detectAll(E.bars, { atr: E.atr, vol: E.volAvg });
      const ev = Candles.evaluate(E.bars, hits, { atr: E.atr });
      this.patternStats[tfMin] = { candles: E.bars.length, base: ev.base, horizons: ev.horizons, rows: ev.rows };
    } catch (err) {
      this._say(`pat${tfMin}`, `Candlestick statistics failed on ${tfMin}m: ${err.message}`);
    }
    try {
      this.labs[tfMin] = LAB.study(E, { hits, spread: E.o.spread || 0 });
    } catch (err) {
      this._say(`lab${tfMin}`, `The pattern lab failed on ${tfMin}m: ${err.message}`);
    }
  }

  // A pattern scored by the pattern lab (null before the lab has run). V is LAB.env(E), built once per scan.
  _labScore(tfMin, V, h) {
    const lab = this.labs[tfMin];
    if (!lab || !V || h.dir === 'neutral') return null;
    try {
      return LAB.score(lab, V(), h, { price: alerts.price });
    } catch (err) {
      this._say(`labscore${tfMin}`, `Scoring a pattern failed on ${tfMin}m: ${err.message}`);
      return null;
    }
  }

  _train(tfMin, E) {
    this._patternStats(tfMin, E);
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
    const out = { tf: tfMin, tfSec, bars, engine: null, forecast: null, model: this.models[tfMin] || null, plan: null, alerts: [], stale: 0, newCandles: 0, first: false };
    if (!bars.length) return out;
    const E = SMC.run(bars, this.cfg.engine), n = bars.length;
    out.engine = E;
    let env = null;
    out.labEnv = () => env || (env = LAB.env(E));
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
    // the trade plan at the newest candle: what the console line and the API report
    try {
      const last = n - 1, st = this.patternStats[tfMin];
      out.patternsNow = [];
      for (let k = Math.max(1, last - 2); k <= last; k++) {
        for (const h of Candles.detectAt(bars, k, { atr: E.atr, vol: E.volAvg })) out.patternsNow.push({ ...h, t: bars[k].t, lab: this._labScore(tfMin, out.labEnv, h) });
      }
      out.plan = ADV.plan({
        bars, setups: E.setups, levels: E.events.filter(e => e.type === 'liq'), c: last, opts: E.o, tfSec,
        atr: E.atr[last], risk: this.cfg.risk, odds: s => P.setupOdds(E, s, last), forecast: out.forecast,
        patterns: out.patternsNow.filter(h => h.i === last),
        patternStats: st ? Object.fromEntries(st.rows.map(r => [r.key, r])) : null,
        price: alerts.price, time: t => alerts.clock(t, this.cfg.timeZone),
      });
    } catch (err) {
      this._say(`plan${tfMin}`, `Trade plan failed on ${tfMin}m: ${err.message}`);
    }

    const key = String(tfMin), prev = this.state.lastProcessed[key];
    const known = prev !== null && prev !== undefined;
    // first run: only what the newest candle brought counts as new
    const lastT = known ? prev : n >= 2 ? bars[n - 2].t : null;
    out.first = !known;
    out.newCandles = known ? n - firstAfter(bars, prev) : 0;
    const found = collectAlerts(E, { lastT, mode: this.cfg.alerts.on, results: this.cfg.alerts.results !== false });
    const sent = new Set(this.state.sent), maxAge = this.cfg.alerts.maxAgeMinutes * 60;
    const minRank = SMC.GRADES.indexOf(this.cfg.alerts.minGrade || 'C');
    out.belowGrade = 0;
    for (const raw of found) {
      const t = bars[raw.at].t, k = `${tfMin}:${raw.kind}:${raw.dir}:${t}`;
      if (sent.has(k)) continue;
      // after the scanner was off for a while, old signals are counted but not sent
      if (t + tfSec < now - maxAge) {
        out.stale++;
        continue;
      }
      // graded steps (zones, entries, results, cancels) below alerts.minGrade stay on the dashboard only
      const g = raw.setup.grade;
      if (minRank > 0 && g && SMC.GRADES.indexOf(g) < minRank) {
        out.belowGrade++;
        continue;
      }
      const a = this._alert(raw, E, tfMin, out.forecast, out.labEnv);
      a.key = k;
      out.alerts.push(a);
    }
    this.state.lastProcessed[key] = known ? Math.max(prev, bars[n - 1].t) : bars[n - 1].t;
    return out;
  }

  // The engine's entry pattern as candles.js sees it (shape only, as at a zone), scored by the lab.
  _entryCheck(E, s, tfMin, labEnv) {
    const e = s.entry;
    if (!e || !this.labs[tfMin] || !labEnv) return null;
    const keys = SAME_AS_ENTRY[e.pattern] || [];
    const h = Candles.detectAt(E.bars, e.i, { atr: E.atr, vol: E.volAvg, trend: false })
      .find(x => x.dir === e.dir && (keys.includes(x.key) || x.name === e.pattern));
    const sc = h && this._labScore(tfMin, labEnv, h);
    return sc ? { name: e.pattern, ...sc } : null;
  }

  _alert(raw, E, tfMin, forecast, labEnv = null) {
    const B = E.bars, s = raw.setup, at = raw.at, known = k => k !== null && k <= at;
    const graded = known(s.armedAt), zoneStep = raw.kind === 'armed' || raw.kind === 'touch';
    const levels = zoneStep ? E.events.filter(e => e.type === 'liq') : null;
    const a = {
      kind: raw.kind, symbol: this.cfg.symbol, tfMin, dir: raw.dir, t: B[at].t, time: iso(B[at].t),
      risk: this.cfg.risk,
      // news around the moment the alert goes out: the close of the candle
      news: this.news && (raw.kind === 'entry' || zoneStep) ? this.news.near(B[at].t + tfMin * 60) : [],
      // the trade the zone would give, as the engine would take it
      plan: zoneStep ? ADV.project(s, { bars: B, c: at, opts: E.o, levels, atr: E.atr[at], risk: this.cfg.risk }) : null,
      patternText: Object.entries(E.o.patterns).filter(([, on]) => on).map(([k]) => ADV.PATTERN_NAMES[k] || k).join(' or '),
      // classic candlestick patterns on the entry candle, with their trend rules
      candles: raw.kind === 'entry'
        ? Candles.detectAt(B, at, { atr: E.atr, vol: E.volAvg }).filter(h => h.dir === raw.dir && !SAME_AS_ENTRY[s.entry.pattern]?.includes(h.key))
          .map(h => ({ ...h, lab: this._labScore(tfMin, labEnv, h) })) : null,
      // the entry candle itself, as the pattern lab sees it: its context and its tested record
      check: raw.kind === 'entry' ? this._entryCheck(E, s, tfMin, labEnv) : null,
      timeZone: this.cfg.timeZone, entryZone: this.cfg.engine.entryZone || SMC.DEFAULTS.entryZone,
      setup: {
        id: s.id, label: s.label, src: s.src, levelPrice: s.level.price, sweepT: B[s.sweepAt].t,
        refPrice: s.ref ? s.ref.price : null, chochPrice: s.ref ? s.ref.price : null,
        chochT: known(s.chochAt) ? B[s.chochAt].t : null,
        fvgKind: known(s.armedAt) ? s.fvgZone.kind : null,
        fvg: s.fvgZone && { top: s.fvgZone.top, bottom: s.fvgZone.bottom },
        ob: s.obZone && { top: s.obZone.top, bottom: s.obZone.bottom },
        volX: s.disp ? s.disp.volX : null, reason: s.reason,
        grade: graded ? s.grade : null, factors: graded ? s.factors : null,
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

  // While gold is closed (weekend, daily break) one check after the close collects the last
  // candles; later checks are skipped until it opens, which also saves API requests.
  _marketClosed(nowSec) {
    if (this.cfg.marketHours === false || this.sourceName === 'replay') {
      this.health.market = null;
      return false;
    }
    const m = SMC.marketStatus(nowSec);
    this.health.market = { open: m.open, opensAt: iso(m.opensAt) };
    const since = closedSince(nowSec);
    if (since === null || !this.history.length || this.lastOkSec === null || this.lastOkSec < since) return false;
    this._say(`closed:${since}`, `Gold market closed; checks resume when it opens at ${alerts.dateTime(m.opensAt, this.cfg.timeZone)}.`);
    return true;
  }

  async _cycle() {
    const localNow = Math.floor(this.clock() / 1000);
    if (this._marketClosed(localNow)) {
      this._planNext(true);
      if (this.latest) Object.assign(this.latest, { nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null });
      return { ok: true, skipped: 'market closed' };
    }
    // the news calendar loads (at most hourly) while the candles are fetched
    const newsDone = this.news ? this.news.refresh().catch(() => false) : null;
    let fetched;
    try {
      fetched = await this.source.fetchBars({ count: this._fetchCount(localNow), now: localNow });
    } catch (err) {
      await newsDone;
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
    await newsDone;
    await this._retryTelegram(now);
    for (const a of pending) {
      if (this.news) {
        // the calendar may have arrived after the alert was built
        a.news = ['entry', 'armed', 'touch'].includes(a.kind) ? this.news.near(a.t + a.tfMin * 60) : [];
        a.text = alerts.message(a);
      }
      a.delivery = await Promise.resolve().then(() => this.notifier.send(a)).catch(err => ({ error: err.message }));
      if (a.delivery && a.delivery.telegram === false) this.retry.push(a);
      this.recentAlerts.unshift({
        time: a.time, kind: a.kind, tf: a.tfMin, dir: a.dir, text: a.text, sentAt: new Date(this.clock()).toISOString(),
        grade: a.setup && a.setup.grade, telegram: a.delivery ? a.delivery.telegram : null,
      });
    }
    this.retry = this.retry.slice(-20);
    this.recentAlerts = this.recentAlerts.slice(0, 30);
    const lastBar = bars[bars.length - 1];
    const lag = Math.round((now - (lastBar.t + this.baseSec)) / 60);
    const lagLimit = this.sourceName === 'yahoo' ? 25 : 15;
    this.lastOkSec = Math.floor(this.clock() / 1000);
    Object.assign(this.health, {
      ok: true, error: null, lastOkAt: new Date(this.clock()).toISOString(), volume: results[this.baseMin].engine.hasVolume,
      lagMinutes: lag,
      warning: this.health.market && this.health.market.open && lag > lagLimit
        ? `The newest candle is ${lag} min old: the feed may be stalled (is MT5 connected?)` : null,
      // alerts held back by alerts.minGrade since the scanner started
      belowGrade: (this.health.belowGrade || 0) + Object.values(results).reduce((n, r) => n + (r.belowGrade || 0), 0),
    });
    this.retrying = false;
    const next = this._planNext(true);
    this.latest = this._apiState(results, now);
    this._write(this.files.latest, JSON.stringify(this.latest), 'latest state');
    const line = this._summary(results, pending.length, stale, next);
    this.log(line);
    return { ok: true, now, fetched: fetched.length, merge: { ...m, bars: undefined }, trimmed, alerts: pending, stale, line, results };
  }

  // Alerts Telegram did not take are tried again (Telegram only) while they are still fresh.
  async _retryTelegram(nowSec) {
    if (!this.retry.length || !this.notifier.telegramEnabled) return;
    const keep = this.cfg.alerts.maxAgeMinutes * 60, queue = this.retry;
    this.retry = [];
    for (const a of queue) {
      if (a.t + a.tfMin * 60 < nowSec - keep) continue;
      let r;
      try {
        r = await this.notifier.send(a, { console: false });
      } catch (err) {
        r = { telegram: false };
      }
      if (r.telegram === false) this.retry.push(a);
      else this.log(`Telegram took the earlier ${a.kind} alert (${a.tfMin}m ${alerts.clock(a.t, this.cfg.timeZone)}) on a retry.`);
    }
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
      bits.push(r.plan ? r.plan.headline : act.length ? act.join(', ') : 'no setup');
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

  // The full trade plan of every timeframe after a check, as text (now.bat, --plan).
  planReport(r) {
    if (!r || !r.ok) return `No plan: the check failed (${(r && r.error) || 'unknown error'}).`;
    if (!r.results) return `No plan: ${r.skipped || 'nothing was checked'}.`;
    const nowSec = Math.floor(this.clock() / 1000);
    const news = this.news ? this.news.upcoming(nowSec, 12) : [];
    const out = this.tfs.map(tf => {
      const x = r.results[tf];
      return alerts.planText({ ...x, tfMin: tf, lab: this.labs[tf] || null }, {
        symbol: this.cfg.symbol, timeZone: this.cfg.timeZone, risk: this.cfg.risk, news,
      });
    });
    const src = SOURCE_NAMES[this.sourceName] || this.sourceName;
    out.push(`Source: ${src}. Rules, not certainty: every number comes from this chart's own past. Not financial advice.`);
    return '\n' + out.join('\n\n');
  }

  // What the dashboard shows about the feed, news and settings, apart from the scan itself.
  _context() {
    const nowSec = Math.floor(this.clock() / 1000);
    const info = this.source.info || {};
    return {
      symbol: this.cfg.symbol, source: this.source.name, sourceLabel: SOURCE_NAMES[this.source.name] || this.source.name,
      sourceInfo: {
        symbol: info.symbol || null, serverOffsetMinutes: info.serverOffsetMinutes === undefined ? null : info.serverOffsetMinutes,
        dst: info.dst || null, delayedMinutes: info.delayedMinutes || null, note: info.symbolNote || null,
      },
      auto: this.autoPick ? { tried: this.autoPick.tried } : null,
      live: this.source.name !== 'replay',
      everyMinutes: this.cfg.everyMinutes, timeZone: this.cfg.timeZone,
      risk: this.cfg.risk, configError: this.cfg.configError || null, notes: this.cfg.notes || [],
      news: this.news ? {
        enabled: this.news.enabled, error: this.news.error, fetchedAt: this.news.fetchedAt ? new Date(this.news.fetchedAt).toISOString() : null,
        upcoming: this.news.upcoming(nowSec, 36).slice(0, 12),
      } : null,
      engine: { ...SMC.DEFAULTS, ...this.cfg.engine },
      logFile: this.log.file || null,
    };
  }

  _apiState(results, now) {
    const out = {
      ...this._context(),
      updatedAt: new Date(this.clock()).toISOString(), dataTime: iso(now),
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null,
      health: { ...this.health },
      alerts: { on: this.cfg.alerts.on, minGrade: this.cfg.alerts.minGrade, telegram: !!this.notifier.telegramEnabled, recent: this.recentAlerts },
      timeframes: {},
    };
    for (const tf of this.tfs) {
      const r = results[tf];
      if (!r || !r.engine) continue;
      out.timeframes[String(tf)] = serialiseTimeframe(r.engine, {
        tfSec: r.tfSec, forecast: r.forecast, model: r.model, patternStats: this.patternStats[tf] || null,
        lab: this.labs[tf] || null, patternsNow: r.patternsNow || null,
        plan: r.plan ? { verdict: r.plan.verdict, headline: r.plan.headline, detail: r.plan.detail } : null,
        track: scoreForecasts(this.forecasts.filter(x => x.tf === tf), r.bars),
      });
    }
    return out;
  }

  // What GET /api/state returns: the last good scan with the current health and next run.
  apiState() {
    const base = this.latest || {
      updatedAt: null, alerts: { on: this.cfg.alerts.on, minGrade: this.cfg.alerts.minGrade, telegram: !!this.notifier.telegramEnabled, recent: [] },
      timeframes: {},
    };
    const health = { ...this.health };
    if (!this.latest && !health.error) health.error = 'waiting for the first check';
    // feed, news and settings are always current, even between checks
    return {
      ...base, ...this._context(), alerts: { ...base.alerts, recent: this.recentAlerts },
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null, busy: this.busy, health,
    };
  }

  /*
   * Check now, then on every aligned time until stop() or `cycles` checks. With fast (replay)
   * the checks run back to back. Checks never overlap: the next is planned after one ends.
   */
  run({ cycles = Infinity, fast = false, delayMs = 0 } = {}) {
    // back-to-back checks are for replays only, never for a real feed
    fast = fast && this.sourceName === 'replay';
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

// POST bodies come only from the dashboard itself: JSON (which a form on another site cannot
// send without asking first) and, when the browser says where it comes from, this PC.
function postAllowed(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return localHost(new URL(origin).host);
  } catch (err) {
    return false;
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new Error('not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer(target, { root = ROOT } = {}) {
  const rootDir = path.resolve(root);
  // either an App (settings can be changed from the page) or just a scanner
  const app = target && typeof target.reconfigure === 'function' ? target : null;
  const scanner = () => (app ? app.scanner : target);
  const vendor = path.join(rootDir, 'vendor', path.basename(VENDOR_LWC));
  const json = (res, status, obj, method) => send(res, status, TYPES['.json'], JSON.stringify(obj), method, { 'cache-control': 'no-store' });

  async function post(req, res, p) {
    if (!app) return send(res, 404, TEXT, 'Not found');
    if (!postAllowed(req)) return send(res, 403, TEXT, 'Forbidden');
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return send(res, 400, TEXT, `Bad request: ${err.message}`);
    }
    try {
      if (p === '/api/config') return json(res, 200, await app.reconfigure(body.config || {}));
      if (p === '/api/test-source') return json(res, 200, await app.testSource(body.config || {}));
      if (p === '/api/test-telegram') return json(res, 200, await app.testTelegram(body));
      if (p === '/api/telegram-chats') return json(res, 200, await app.telegramChats(body));
      if (p === '/api/check-now') return json(res, 200, await app.checkNow());
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message });
    }
    return send(res, 404, TEXT, 'Not found');
  }

  return http.createServer((req, res) => {
    const method = req.method;
    try {
      if (!localHost(req.headers.host)) return send(res, 403, TEXT, 'Forbidden', method);
      let p;
      try {
        p = decodeURIComponent(String(req.url || '/').split(/[?#]/)[0]);
      } catch (err) {
        return send(res, 400, TEXT, 'Bad request', method);
      }
      if (method === 'POST' && p.startsWith('/api/')) {
        post(req, res, p).catch(() => { if (!res.headersSent) send(res, 500, TEXT, 'Server error'); });
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, TEXT, 'Method not allowed', method, { allow: 'GET, HEAD' });
      if (p === '/api/state') return json(res, 200, scanner().apiState(), method);
      if (p === '/api/config' && app) return json(res, 200, app.publicConfig(), method);
      if (p === '/' || p === '/index.html') {
        return fs.readFile(path.join(rootDir, 'index.html'), 'utf8', (err, html) => {
          if (err) return send(res, 404, TEXT, 'index.html not found', method);
          // the chart library from this folder when it is there, so the page works without the CDN
          if (fs.existsSync(vendor)) html = html.replace(CDN_LWC, `vendor/${path.basename(vendor)}`);
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

// True when a Gold SMC Scanner already answers on this port.
async function isScannerAt(port) {
  try {
    const r = await request(`http://127.0.0.1:${port}/api/state`, { timeoutMs: 2500 });
    const j = JSON.parse(r.body);
    return r.status === 200 && !!j && typeof j === 'object' && 'timeframes' in j && 'health' in j;
  } catch (err) {
    return false;
  }
}

function openBrowser(url, log = () => {}) {
  const fail = () => log(`Open ${url} in your browser.`);
  try {
    // cmd's start needs the empty window title and its own quoting, hence verbatim arguments
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', fail);
    child.unref();
  } catch (err) {
    fail();
  }
}

// ---------- the app: one scanner at a time, settings from the dashboard ----------

const getIn = (o, keys) => keys.reduce((x, k) => (x !== null && typeof x === 'object' ? x[k] : undefined), o);
function setIn(o, keys, v) {
  let x = o;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(x[k])) x[k] = {};
    x = x[k];
  }
  x[keys[keys.length - 1]] = v;
}

// The settings the Setup tab can change.
const EDITABLE = [
  'source', 'symbol', 'timeZone', 'everyMinutes', 'timeframes', 'marketHours',
  'mt5file', 'mt5', 'twelvedata', 'yahoo', 'csv', 'replay', 'alerts', 'risk', 'news', 'engine',
];

/*
 * Shown while no feed has answered yet (source "auto" with no internet, say). It keeps trying
 * every minute and hands over to a real scanner as soon as one starts.
 */
class WaitingScanner {
  constructor(app, cfg, error, { retryMs = RETRY_MS } = {}) {
    Object.assign(this, { app, cfg, error, retryMs, running: false, busy: false, timer: null, nextRunAt: null });
  }

  banner() {
    return `Gold SMC Scanner live · ${this.cfg.symbol} · waiting for a data source`;
  }

  apiState() {
    return {
      symbol: this.cfg.symbol, source: null, sourceLabel: 'none yet', live: true, updatedAt: null, timeframes: {},
      everyMinutes: this.cfg.everyMinutes, timeZone: this.cfg.timeZone, risk: this.cfg.risk,
      configError: this.cfg.configError || null, notes: this.cfg.notes || [], news: null,
      alerts: { on: this.cfg.alerts.on, minGrade: this.cfg.alerts.minGrade, recent: [] },
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null, busy: this.busy,
      health: { ok: false, error: this.error, waiting: true },
    };
  }

  async cycle() {
    this.busy = true;
    try {
      const next = await this.app.build(this.cfg);
      // settings saved from the dashboard meanwhile have already replaced this one
      if (this.app.scanner !== this) return { ok: true };
      this.app.swap(next);
      return { ok: true };
    } catch (err) {
      this.error = err.message;
      return { ok: false, error: err.message };
    } finally {
      this.busy = false;
    }
  }

  run() {
    this.running = true;
    return new Promise(resolve => {
      this._resolve = resolve;
      const step = async () => {
        if (!this.running) return;
        this.nextRunAt = null;
        const r = await this.cycle();
        if (r.ok || !this.running) return resolve();
        this.app.log(`Still no data source: ${this.error}. Trying again in ${Math.round(this.retryMs / 1000)} s.`);
        this.nextRunAt = Date.now() + this.retryMs;
        this.timer = setTimeout(step, this.retryMs);
      };
      this.nextRunAt = Date.now() + this.retryMs;
      this.timer = setTimeout(step, this.retryMs);
    });
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this._resolve) this._resolve();
  }

  async idle() {}
}

class App {
  constructor({ cfgFile = DEFAULT_CONFIG, overrides = {}, dataDir, log = console.log, scannerOpts = {}, retryMs } = {}) {
    Object.assign(this, { cfgFile, overrides, dataDir, log, scannerOpts, retryMs });
    this.scanner = null;
    this.cfg = null;
    this.stopped = false;
  }

  build(cfg) {
    return LiveScanner.create(cfg, { dataDir: this.dataDir, log: this.log, ...this.scannerOpts });
  }

  async init(cfg) {
    this.cfg = cfg;
    try {
      this.scanner = await this.build(cfg);
    } catch (err) {
      this.log(`Could not start the scanner: ${err.message}.`);
      this.scanner = new WaitingScanner(this, cfg, err.message, { retryMs: this.retryMs });
    }
    return this.scanner;
  }

  // Replace the running scanner (its loop ends; runForever carries on with the new one).
  swap(next) {
    const old = this.scanner;
    this.scanner = next;
    this.cfg = next.cfg;
    if (old && old !== next) old.stop();
    this.log(next.banner());
    this._wakeUp();
  }

  _wakeUp() {
    const w = this._wake;
    this._wake = null;
    if (w) w();
  }

  /*
   * Runs the current scanner, and the next one after a swap. With stay, a scanner whose checks
   * are done (--cycles, the end of a replay) leaves the dashboard up until stop() or a swap.
   */
  async runForever(opts = {}) {
    const { stay = false, onDone = null, ...runOpts } = opts;
    for (;;) {
      const s = this.scanner;
      await s.run(runOpts);
      if (this.stopped) return;
      if (this.scanner !== s) continue;
      if (!stay) return;
      if (onDone) onDone();
      await new Promise(r => { this._wake = r; });
      if (this.stopped) return;
    }
  }

  stop() {
    this.stopped = true;
    if (this.scanner) this.scanner.stop();
    this._wakeUp();
  }

  publicConfig() {
    const cfg = this.cfg, out = {};
    for (const k of EDITABLE) out[k] = structuredClone(cfg[k]);
    for (const keys of SECRETS) if (getIn(out, keys)) setIn(out, keys, MASK);
    return {
      config: out, file: this.cfgFile, error: cfg.configError || null, mask: MASK,
      sources: sources.NAMES.map(name => ({ name, label: SOURCE_NAMES[name] })),
      grades: SMC.GRADES, defaults: { engine: SMC.DEFAULTS },
    };
  }

  // The user's file with `changes` merged in, secrets still masked resolved to the saved values.
  _proposed(changes) {
    let user = {};
    try {
      if (fs.existsSync(this.cfgFile)) user = readUserConfig(this.cfgFile);
      if (!isObj(user)) user = {};
    } catch (err) {
      user = {};
    }
    const incoming = {};
    for (const k of EDITABLE) if (changes[k] !== undefined) incoming[k] = structuredClone(changes[k]);
    for (const keys of SECRETS) {
      if (getIn(incoming, keys) === MASK) setIn(incoming, keys, getIn(this.cfg, keys) || '');
    }
    const next = merge(user, incoming);   // lists such as timeframes are replaced, not merged
    // the dashboard's choices win over command-line options, except the port this page is on
    const cfg = normalise(structuredClone(merge(merge(DEFAULTS, next), { port: this.cfg.port })));
    cfg.configDir = path.dirname(path.resolve(this.cfgFile));
    cfg.configFile = path.resolve(this.cfgFile);
    cfg.configError = null;
    return { user: next, cfg };
  }

  async reconfigure(changes) {
    const { user, cfg } = this._proposed(changes);
    const old = this.scanner;
    // a check in progress finishes first, so two scanners never write the same files
    for (let k = 0; k < 600 && old && old.busy; k++) await new Promise(r => setTimeout(r, 100));
    let next;
    try {
      next = await this.build(cfg);
    } catch (err) {
      return { ok: false, saved: false, error: `Not saved: ${err.message}` };
    }
    try {
      if (fs.existsSync(this.cfgFile)) {
        try {
          readUserConfig(this.cfgFile);
        } catch (err) {
          fs.copyFileSync(this.cfgFile, this.cfgFile.replace(/\.json$/i, '') + '.broken.json');   // keep what was there
        }
      }
      writeFileAtomic(this.cfgFile, JSON.stringify(user, null, 2) + '\n');
    } catch (err) {
      return { ok: false, saved: false, error: `Could not save ${this.cfgFile}: ${err.message}` };
    }
    this.log(`Settings saved from the dashboard to ${this.cfgFile}; restarting the scanner.`);
    this.swap(next);
    return { ok: true, saved: true, source: next.sourceName, banner: next.banner(), auto: next.autoPick ? next.autoPick.tried : null };
  }

  // Try a feed with the proposed settings without touching the running scanner.
  async testSource(changes) {
    const { cfg } = this._proposed(changes);
    const opts = { tfMinutes: cfg.timeframes[0], everyMinutes: cfg.everyMinutes, baseDir: cfg.configDir };
    if (cfg.source === 'auto') {
      const pick = await sources.pickAuto(cfg, opts);
      return { ok: !!pick.source, source: pick.name, tried: pick.tried, error: pick.source ? null : 'no source answered' };
    }
    const src = sources.create(cfg, opts);
    const bars = await src.fetchBars({ count: 50, now: Math.floor(Date.now() / 1000) });
    if (!bars.length) return { ok: false, source: cfg.source, error: 'the source answered with no candles' };
    const last = bars[bars.length - 1];
    return {
      ok: true, source: cfg.source, candles: bars.length, last: { time: iso(last.t), close: last.c },
      info: src.info || null, volume: bars.some(b => b.v > 0),
    };
  }

  _telegram(body) {
    const saved = this.cfg.alerts.telegram || {};
    const token = !body.botToken || body.botToken === MASK ? saved.botToken : String(body.botToken).trim();
    const chatId = body.chatId === undefined || body.chatId === '' ? saved.chatId : String(body.chatId).trim();
    return { token, chatId, base: saved.base };
  }

  async testTelegram(body = {}) {
    const { token, chatId, base } = this._telegram(body);
    if (!token) return { ok: false, error: 'Enter the bot token from @BotFather first' };
    if (!chatId) return { ok: false, error: 'Enter your chat id first (use "Find my chat id")' };
    return alerts.sendTelegram({ botToken: token, chatId, base, text: `✅ Gold SMC Scanner can send you alerts (${this.cfg.symbol}).` });
  }

  // The chats that have written to the bot lately, from getUpdates.
  async telegramChats(body = {}) {
    const { token, base } = this._telegram(body);
    if (!token) return { ok: false, error: 'Enter the bot token from @BotFather first' };
    const root = String(base || 'https://api.telegram.org').replace(/\/+$/, '');
    let res;
    try {
      res = await request(`${root}/bot${token}/getUpdates`, { timeoutMs: 15000 });
    } catch (err) {
      return { ok: false, error: alerts.hide(`Telegram unreachable: ${err.message}`, token) };
    }
    let j = null;
    try {
      j = JSON.parse(res.body);
    } catch (err) { /* judged below */ }
    if (!j || !j.ok) {
      const why = j && j.description ? j.description : `HTTP ${res.status}`;
      return { ok: false, error: alerts.hide(`Telegram said: ${why}${res.status === 401 || res.status === 404 ? ' (check the bot token)' : ''}`, token) };
    }
    const chats = new Map();
    for (const u of j.result || []) {
      const m = u.message || u.edited_message || u.channel_post || u.my_chat_member || u.chat_member;
      const c = m && m.chat;
      if (!c || chats.has(c.id)) continue;
      const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : String(c.id));
      chats.set(c.id, { id: String(c.id), name, type: c.type });
    }
    const list = [...chats.values()];
    return {
      ok: true, chats: list,
      error: list.length ? null : 'No messages yet: open your bot in Telegram, send it /start, then try again',
    };
  }

  async checkNow() {
    const s = this.scanner;
    if (s.busy) return { ok: false, error: 'a check is already running' };
    // the regular schedule stays as it is
    const r = await s.cycle();
    return { ok: !!r.ok, error: r.error || null, skipped: r.skipped || null };
  }
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
  const cfgFile = args.config || DEFAULT_CONFIG;
  let cfg;
  try {
    cfg = loadConfig(args.config || fs.existsSync(cfgFile) ? cfgFile : null, args.overrides, { lenient: !args.once });
  } catch (err) {
    console.error(`Could not start: ${err.message}`);
    return 1;
  }
  const dataDir = path.resolve(args.dataDir || DATA_DIR);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.error(`Could not create the data folder ${dataDir}: ${err.message}`);
    return 1;
  }
  const log = makeLogger(cfg.timeZone, { file: path.join(dataDir, 'scanner.log') });
  if (cfg.configError) {
    log(`Your settings file has a problem: ${cfg.configError}. Using the default settings for now; fix the file, or save settings from the dashboard's Setup tab.`);
  }
  if (!fs.existsSync(cfgFile)) log('No config.json yet, so the defaults are used. Open the dashboard\'s Setup tab to choose your source and alerts.');
  for (const note of cfg.notes) log(note);

  // a long-running monitor logs the unexpected and keeps going
  const guard = what => err => log(`${what} (the scanner keeps running): ${(err && err.stack) || err}`);
  const onRejection = guard('Unexpected error'), onException = guard('Unexpected error');
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  const app = new App({ cfgFile, overrides: args.overrides, dataDir, log });
  // until the scanner is ready the page shows "starting"
  app.scanner = new WaitingScanner(app, cfg, 'starting: looking for a data source');
  app.cfg = cfg;

  // the dashboard first, so the browser has something to show while the feed is found
  let server = null, port = null;
  if (!args.noServer && !args.once) {
    for (let k = 0; k <= 10; k++) {
      const want = cfg.port === 0 ? 0 : cfg.port + k;
      server = createServer(app);
      try {
        port = await listen(server, want);
        break;
      } catch (err) {
        server = null;
        if (err.code !== 'EADDRINUSE') {
          log(`Could not start the dashboard: ${err.message}`);
          return 1;
        }
        if (k === 0 && await isScannerAt(want)) {
          log(`The scanner is already running: http://localhost:${want}`);
          if (args.open) openBrowser(`http://localhost:${want}/`, log);
          return 0;
        }
        if (k === 10) {
          log(`Ports ${cfg.port}-${cfg.port + 10} are all in use. Set another port in config.json.`);
          return 1;
        }
      }
    }
    if (port !== cfg.port && cfg.port !== 0) log(`Port ${cfg.port} is used by another program, so the dashboard uses ${port}.`);
  }

  if (server) {
    log(`Dashboard: http://localhost:${port}  (press Ctrl+C to stop)`);
    if (args.open) openBrowser(`http://localhost:${port}/`, log);
  }
  if (cfg.source === 'auto') log('Looking for a data source: MT5 (GoldSMCExport expert), MT5 (Python), Twelve Data, then Yahoo Finance ...');
  await app.init(cfg);
  if (app.scanner instanceof LiveScanner) {
    log(app.scanner.banner());
    if (app.scanner.autoPick) {
      for (const t of app.scanner.autoPick.tried.filter(x => !x.ok)) log(`  not ${SOURCE_NAMES[t.name] || t.name}: ${t.why}`);
    }
  }

  if (args.once) {
    const r = await app.scanner.cycle();
    if (args.plan) console.log(app.scanner instanceof LiveScanner ? app.scanner.planReport(r) : 'No data source answered, so there is no plan. See the messages above.');
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
    return r.ok ? 0 : 1;
  }
  const stop = () => {
    log('Stopping.');
    app.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await app.runForever({
    cycles: args.cycles || Infinity, fast: args.fast, stay: args.stay && !!server,
    onDone: () => log(`Checks finished; the dashboard stays open at http://localhost:${port}. Press Ctrl+C or close this window to stop.`),
  });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
  if (server) {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(r => server.close(() => r()));
  }
  return app.scanner.health && app.scanner.health.ok === false ? 1 : 0;
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
  LiveScanner, WaitingScanner, App, createServer, listen, safePath, wrapPage, localHost, postAllowed, makeLogger,
  closedSince, isScannerAt, openBrowser, main, PAGE_HEAD, PAGE_TAIL, RETRAIN_EVERY, MASK, CDN_LWC,
};
