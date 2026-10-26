/*
 * Pattern lab: does a candlestick pattern predict anything on this data, and in which context?
 *
 * Every pattern (candles.js) is described by where it formed, all of it known when its last
 * candle closed:
 *   liquidity   a level swept by the pattern (or the 2 candles before it), and whether it was
 *               key liquidity (previous day, session, equal highs/lows)
 *   SMC         inside a marked order block / FVG zone of the same side, or into an open FVG
 *   location    20- and 50-candle low/high, discount/premium in the last 96 candles
 *   trend       the move into it, the distance from the 50 EMA, the 1-hour trend
 *   strength    volume against average, size in ATR, how near its high (low) it closed
 *   session     Asia, London, New York
 * and by what followed:
 *   race        did price reach 1 ATR in the pattern's direction before 1 ATR against
 *               (within raceBars candles)? A random candle does this about half the time.
 *   trade       entry at the close, stop beyond the pattern by slBufferAtr ATR, target rr x
 *               the risk, closed at the market after tradeBars candles. Result in R.
 *
 * study() reports how each context did against an ordinary candle, with a 95% range and both
 * halves of the data, and trains a small logistic model walk-forward (each fold learns only
 * from patterns whose race had ended before its first test candle). The model gets one more
 * input, the pattern's own record on the training data. The lab only says a pattern has an
 * edge when the model's best fifth beat the base rate out of sample, in both halves of the
 * test period, and made money at 2R. Most of the time it does not: on 6 months of 5-minute
 * gold no pattern or context did, which is the honest answer and why the strategy uses
 * candles only as the trigger at a swept-liquidity order block.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./candles.js'), require('./predict.js'));
  else root.SMCPatternLab = factory(root.SMCCandles, root.SMCPredict);
}(typeof self !== 'undefined' ? self : this, function (CS, SP) {
  'use strict';

  const DEFAULTS = {
    raceBars: 12,      // candles allowed for the 1-ATR race
    tradeBars: 48,     // candles a trade may run before it is closed at the market
    rr: 2,             // target in multiples of the risk
    slBufferAtr: 0.1,  // stop this many ATRs beyond the pattern
    spread: 0,         // in price: buys fill at the ask, sells exit at it (chart prices are bids)
    folds: 5,
    firstTest: 0.4,    // share of the labelled patterns that only ever train
    minRows: 600,      // labelled patterns needed before the model is trained
    l2: 3,
    prior: 50,         // pseudo-count pulling a pattern's own record towards the base rate
    warmup: 100,       // candles skipped at the start while ATR and the EMA settle
  };

  const RANK = { swing: 0, equal: 1, session: 2, prevDay: 3 };
  const MIN_GROUP = 50;  // patterns a context needs before it gets a verdict
  const MIN_TOP = 100;   // tested patterns the model's best fifth needs before it can show an edge
  const RANGE_LEN = 96;
  const EMA_LEN = 50;
  const HTF_EMA = 20;    // hourly closes in the 1-hour trend's EMA
  const TYPES = ['reversal', 'rejection', 'momentum'];
  const NAMES = [
    'bull', 'bars', 'reversal', 'rejection', 'momentum', 'sweep', 'keySweep', 'zone', 'fvg',
    'ext20', 'ext50', 'move', 'ema', 'htf', 'london', 'ny', 'asia', 'volume', 'size', 'close',
    'discount', 'risk', 'prior',
  ];
  const LABELS = {
    bull: 'Bullish (rather than bearish)', bars: 'Candles in the pattern', reversal: 'Reversal pattern',
    rejection: 'Rejection pattern', momentum: 'Momentum pattern', sweep: 'Swept liquidity',
    keySweep: 'Swept key liquidity', zone: 'At a marked SMC zone', fvg: 'Into an open FVG',
    ext20: '20-candle low/high', ext50: '50-candle low/high', move: 'Move into it (ATR)',
    ema: 'Stretch from the 50 EMA', htf: 'With the 1-hour trend', london: 'London session',
    ny: 'New York session', asia: 'Asia session', volume: 'Volume against average', size: 'Size in ATR',
    close: 'Close strength', discount: 'Discount (buy) / premium (sell)', risk: 'Stop distance in ATR',
    prior: 'The pattern\'s own record',
  };
  const clip = (x, a, b) => Math.max(a, Math.min(b, x));
  const logit = p => Math.log(p / (1 - p));
  const mean = v => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
  const fmt = p => (Number.isFinite(p) ? p.toFixed(2) : '–');

  // ---------- what was known at each candle ----------

  /*
   * Everything the features read, built once from an engine run (engine.js: bars, atr,
   * volAvg, events, o). Events carry the candle they became known on, so a feature at
   * candle i only uses what had happened by i.
   */
  function env(E) {
    const B = E.bars, n = B.length;
    const atr = E.atr && E.atr.length === n ? E.atr : CS.atrSeries(B);
    const vol = E.volAvg && E.volAvg.length === n ? E.volAvg : CS.volSeries(B);
    // the most significant level swept on each candle, by the side it favours
    const swept = { bull: {}, bear: {} };
    for (const e of E.events || []) {
      if (e.type !== 'liq' || e.end !== 'swept' || e.endAt === null || e.endAt === undefined) continue;
      const side = swept[e.kind === 'low' ? 'bull' : 'bear'], cur = side[e.endAt];
      if (!cur || RANK[e.src] > RANK[cur.src]) side[e.endAt] = { src: e.src, label: e.label, price: e.price };
    }
    const zones = (E.events || []).filter(e => e.type === 'zone');
    const fvgs = (E.events || []).filter(e => e.type === 'fvg').sort((a, b) => a.i - b.i);
    const ema = new Array(n);
    {
      const k = 2 / (EMA_LEN + 1);
      let m = n ? B[0].c : 0;
      for (let i = 0; i < n; i++) { m += k * (B[i].c - m); ema[i] = m; }
    }
    // the 1-hour trend from closed hours only: +1 above its EMA, -1 below, 0 not known yet
    const htf = new Int8Array(n);
    {
      const k = 2 / (HTF_EMA + 1);
      let hour = null, em = null, last = null, seen = 0;
      for (let i = 0; i < n; i++) {
        const h = Math.floor(B[i].t / 3600);
        if (hour !== null && h !== hour) {
          last = B[i - 1].c;
          em = em === null ? last : em + k * (last - em);
          seen++;
        }
        hour = h;
        htf[i] = seen >= 3 ? (last > em ? 1 : last < em ? -1 : 0) : 0;
      }
    }
    const lookback = (E.o && E.o.ifvgLookback) || 60;
    return { B, n, atr, vol, swept, zones, fvgs, ema, htf, lookback };
  }

  function extreme(B, f, i, low, len) {
    const from = Math.max(0, f - len);
    let p = low ? Infinity : -Infinity, q = p;
    for (let k = f; k <= i; k++) p = low ? Math.min(p, B[k].l) : Math.max(p, B[k].h);
    for (let k = from; k < f; k++) q = low ? Math.min(q, B[k].l) : Math.max(q, B[k].h);
    return from < f && (low ? p <= q : p >= q);
  }

  function rangePos(B, i) {
    let hi = -Infinity, lo = Infinity;
    for (let k = Math.max(0, i - RANGE_LEN + 1); k <= i; k++) { hi = Math.max(hi, B[k].h); lo = Math.min(lo, B[k].l); }
    return hi > lo ? (B[i].c - lo) / (hi - lo) : 0.5;
  }

  // first FVG index whose middle candle is at or after i (fvgs are sorted by i)
  function fvgFrom(fvgs, i) {
    let a = 0, b = fvgs.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (fvgs[m].i < i) a = m + 1; else b = m;
    }
    return a;
  }

  /*
   * The context of one pattern (a candles.js hit) as {x (numbers in NAMES order, without the
   * prior), f (named values), sweptLevel}. Reads candles up to hit.i only.
   */
  function contextOf(V, hit, o = DEFAULTS) {
    const { B, atr } = V, i = hit.i, f = hit.from, bull = hit.dir === 'bull', sg = bull ? 1 : -1;
    const A = atr[Math.max(0, f - 1)] || atr[i];
    let sweptLevel = null;
    for (let k = Math.max(0, f - 2); k <= i; k++) {
      const lv = V.swept[hit.dir][k];
      if (lv && (!sweptLevel || RANK[lv.src] >= RANK[sweptLevel.src])) sweptLevel = lv;
    }
    let hi = -Infinity, lo = Infinity;
    for (let k = f; k <= i; k++) { hi = Math.max(hi, B[k].h); lo = Math.min(lo, B[k].l); }
    const tip = bull ? lo : hi, c = B[i].c;
    const zone = V.zones.some(z => z.dir === hit.dir && z.at < i && (z.endAt === null || z.endAt === undefined || z.endAt >= i)
      && (bull ? tip <= z.top && c >= z.bottom - 0.1 * A : tip >= z.bottom && c <= z.top + 0.1 * A));
    let fvg = false;
    for (let q = fvgFrom(V.fvgs, i - V.lookback); q < V.fvgs.length && !fvg; q++) {
      const z = V.fvgs[q];
      if (z.at >= f) break;
      if (z.dir !== hit.dir || (z.invAt !== null && z.invAt !== undefined && z.invAt <= i)) continue;
      fvg = bull ? tip <= z.top && tip >= z.bottom - 0.2 * A : tip >= z.bottom && tip <= z.top + 0.2 * A;
    }
    const back = f - 13 >= 0 ? -sg * (B[f - 1].c - B[f - 13].c) / A : 0;
    const sess = SP.session(B[i].t);
    const last = B[i], rng = last.h - last.l;
    const close = rng > 0 ? (bull ? last.c - last.l : last.h - last.c) / rng : 0.5;
    const rp = rangePos(B, Math.max(0, f - 1));
    const entry = bull ? c + o.spread : c;
    const sl = bull ? tip - o.slBufferAtr * atr[i] : tip + o.slBufferAtr * atr[i] + o.spread;
    const def = CS.describe(hit.key) || { type: hit.type, bars: i - f + 1 };
    const fv = {
      bull: bull ? 1 : 0, bars: def.bars,
      reversal: def.type === 'reversal' ? 1 : 0, rejection: def.type === 'rejection' ? 1 : 0, momentum: def.type === 'momentum' ? 1 : 0,
      sweep: sweptLevel ? 1 : 0, keySweep: sweptLevel && RANK[sweptLevel.src] >= RANK.equal ? 1 : 0,
      zone: zone ? 1 : 0, fvg: fvg ? 1 : 0,
      ext20: extreme(B, f, i, bull, 20) ? 1 : 0, ext50: extreme(B, f, i, bull, 50) ? 1 : 0,
      move: clip(back, -6, 6), ema: clip(sg * (B[f - 1].c - V.ema[f - 1]) / A, -6, 6), htf: sg * V.htf[i],
      london: sess === 'london' ? 1 : 0, ny: sess === 'ny' ? 1 : 0, asia: sess === 'asia' ? 1 : 0,
      volume: hit.volX ? Math.log(clip(hit.volX, 0.2, 5)) : 0, size: clip((hi - lo) / A, 0, 4), close,
      discount: bull ? 1 - rp : rp, risk: clip(Math.abs(entry - sl) / A, 0, 4),
    };
    return { x: NAMES.slice(0, -1).map(k => fv[k]), f: fv, sweptLevel, volX: hit.volX, tip };
  }

  // ---------- what followed ----------

  // 1 when price went 1 ATR its way before 1 ATR against within `bars`, 0 the other way round
  // (a candle that reaches both counts against it), null when neither happened in the data.
  function race(B, atr, i, bull, bars) {
    const A = atr[i], c = B[i].c;
    if (!(A > 0)) return null;
    for (let j = i + 1; j <= Math.min(B.length - 1, i + bars); j++) {
      const upHit = B[j].h >= c + A, dnHit = B[j].l <= c - A;
      if (bull ? dnHit : upHit) return 0;
      if (bull ? upHit : dnHit) return 1;
    }
    return null;
  }

  // A trade from the close of candle e with the stop beyond `tip`: {r, win, exitAt} or null when
  // the data ends before it is decided. As the engine: a candle touching both counts as the stop.
  function trade(B, atr, e, tip, bull, o) {
    const A = atr[e], sp = o.spread, entry = bull ? B[e].c + sp : B[e].c;
    const sl = bull ? tip - o.slBufferAtr * A : tip + o.slBufferAtr * A + sp, risk = Math.abs(entry - sl);
    if (!(risk > 0)) return null;
    const tp = bull ? entry + o.rr * risk : entry - o.rr * risk, end = e + o.tradeBars;
    for (let j = e + 1; j <= Math.min(B.length - 1, end); j++) {
      const hi = bull ? B[j].h : B[j].h + sp, lo = bull ? B[j].l : B[j].l + sp;
      if (bull ? lo <= sl : hi >= sl) return { r: -1, win: 0, exitAt: j };
      if (bull ? hi >= tp : lo <= tp) return { r: o.rr, win: 1, exitAt: j };
    }
    if (end >= B.length) return null;
    const x = bull ? B[end].c - entry : entry - (B[end].c + sp);
    return { r: Math.max(-1, x / risk), win: null, exitAt: end };
  }

  // How often any candle wins the race, long and short: the bar every pattern has to clear.
  function baseRates(B, atr, bars, warmup) {
    let lw = 0, ln = 0, sw = 0, sn = 0;
    for (let i = warmup; i + 1 < B.length; i += 3) {
      const l = race(B, atr, i, true, bars), s = race(B, atr, i, false, bars);
      if (l !== null) { ln++; lw += l; }
      if (s !== null) { sn++; sw += s; }
    }
    return { bull: ln ? lw / ln : 0.5, bear: sn ? sw / sn : 0.5, n: ln + sn };
  }

  // ---------- the study ----------

  const GROUPS = [
    ['all', 'Every pattern', () => true],
    ['sweep', 'Right after a liquidity sweep', r => r.f.sweep],
    ['keySweep', 'After a key-level sweep (PDH/PDL, session, EQH/EQL)', r => r.f.keySweep],
    ['zone', 'At a marked SMC zone (OB / FVG)', r => r.f.zone],
    ['fvg', 'Into an open FVG', r => r.f.fvg],
    ['ext20', 'At a 20-candle low/high', r => r.f.ext20],
    ['ext50', 'At a 50-candle low/high', r => r.f.ext50],
    ['withHtf', 'With the 1-hour trend', r => r.f.htf > 0],
    ['againstHtf', 'Against the 1-hour trend', r => r.f.htf < 0],
    ['london', 'London session', r => r.f.london],
    ['ny', 'New York session', r => r.f.ny],
    ['asia', 'Asia session', r => r.f.asia],
    ['volume', 'Volume 1.5x average or more', r => r.volX >= 1.5],
    ['stretched', 'After a move of 2 ATR or more against it', r => r.f.move >= 2],
    ['discount', 'Deep discount (buy) / premium (sell)', r => r.f.discount >= 0.75],
    ['strongClose', 'Closed in the top (bottom) quarter of its range', r => r.f.close >= 0.75],
    ['sweepZone', 'Sweep and an SMC zone or FVG together', r => r.f.sweep && (r.f.zone || r.f.fvg)],
    // entry one candle later, once the next close went beyond the pattern
    ['confirmed', 'Confirmed: the next candle closed beyond the pattern', r => r.conf, true],
  ];

  function groupStats(rows, name, key, half, baseOf, confirmed) {
    const use = rows.map(r => (confirmed ? r.conf : r)).filter(x => x && x.y !== null);
    const n = use.length, k = use.reduce((s, x) => s + x.y, 0), ci = CS.wilson(k, n);
    const base = n ? mean(use.map(baseOf)) : null;
    const tr = use.filter(x => x.trade).map(x => x.trade);
    const halves = [0, 1].map(h => {
      const part = use.filter(x => (x.i < half) === (h === 0));
      const t = part.filter(x => x.trade).map(x => x.trade.r);
      return { n: part.length, p: part.length ? part.reduce((s, x) => s + x.y, 0) / part.length : null, avgR: t.length ? mean(t) : null };
    });
    const avgR = tr.length ? mean(tr.map(t => t.r)) : null;
    const wins = tr.filter(t => t.win === 1).length;
    let verdict = 'none';
    if (n < MIN_GROUP) verdict = 'few';
    else if (ci.lo > base && halves.every(h => h.p !== null && h.p > base) && avgR > 0 && halves.every(h => h.avgR > 0)) verdict = 'edge';
    else if (ci.hi < base && halves.every(h => h.p !== null && h.p < base)) verdict = 'worse';
    return {
      key, name, n, p: ci.p, lo: ci.lo, hi: ci.hi, base, edge: n ? ci.p - base : null,
      avgR, winRate: tr.length ? wins / tr.length : null, trades: tr.length, halves, verdict,
    };
  }

  function auc(recs) {
    const idx = recs.map((_, k) => k).sort((a, b) => recs[a].p - recs[b].p);
    let nPos = 0, rankPos = 0;
    for (let k = 0; k < idx.length;) {
      let j = k;
      while (j + 1 < idx.length && recs[idx[j + 1]].p === recs[idx[k]].p) j++;
      const rank = (k + j) / 2 + 1;
      for (let q = k; q <= j; q++) if (recs[idx[q]].y === 1) { nPos++; rankPos += rank; }
      k = j + 1;
    }
    const nNeg = recs.length - nPos;
    return nPos && nNeg ? (rankPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : null;
  }

  // Each pattern's record on `rows`, pulled towards the base rate by `m` pseudo-patterns.
  function keyRecords(rows, base, m) {
    const out = {};
    for (const r of rows) {
      const a = out[r.key] || (out[r.key] = { n: 0, k: 0 });
      a.n++;
      a.k += r.y;
    }
    for (const a of Object.values(out)) a.prior = (a.k + m * base) / (a.n + m);
    out._base = base;
    out._m = m;
    return out;
  }
  // the prior a row gets: its own result is left out of its own pattern's record (no leak)
  function priorOf(rec, r, own) {
    const a = rec[r.key], b = rec._base, m = rec._m;
    if (!a) return logit(clip(b, 0.01, 0.99));
    const p = own ? (a.k - r.y + m * b) / (a.n - 1 + m) : a.prior;
    return logit(clip(p, 0.01, 0.99));
  }
  const withPrior = (r, rec, own) => ({ x: r.x.concat(priorOf(rec, r, own)), y: { t: r.y } });

  function fitRows(rows, rec, o) {
    const model = SP.fit(rows.map(r => withPrior(r, rec, true)), 't', { l2: o.l2 });
    model.names = NAMES.slice();
    return model;
  }

  /*
   * The whole study on an engine run E: {candles, base, groups, model, live, keys, options}.
   * opts: DEFAULTS, plus hits (default: candles.js detectAll with its trend rules).
   * The result is plain data (it goes to the dashboard as JSON).
   */
  function study(E, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const V = env(E), B = V.B, n = V.n, atr = V.atr;
    const hits = (o.hits || CS.detectAll(B, { atr, vol: V.vol })).filter(h => h.dir !== 'neutral');
    const base = baseRates(B, atr, o.raceBars, o.warmup);
    const rows = [];
    for (const h of hits) {
      if (h.i < o.warmup || h.from < 14) continue;
      const bull = h.dir === 'bull', cx = contextOf(V, h, o);
      const r = {
        key: h.key, dir: h.dir, i: h.i, x: cx.x, f: cx.f, volX: h.volX,
        y: race(B, atr, h.i, bull, o.raceBars), trade: trade(B, atr, h.i, cx.tip, bull, o), conf: null,
      };
      // the next candle closes beyond the pattern: the same trade one candle later
      const nx = B[h.i + 1];
      if (nx) {
        let hi = -Infinity, lo = Infinity;
        for (let k = h.from; k <= h.i; k++) { hi = Math.max(hi, B[k].h); lo = Math.min(lo, B[k].l); }
        if (bull ? nx.c > hi : nx.c < lo) {
          r.conf = { dir: h.dir, i: h.i + 1, y: race(B, atr, h.i + 1, bull, o.raceBars), trade: trade(B, atr, h.i + 1, cx.tip, bull, o) };
        }
      }
      rows.push(r);
    }
    const baseOf = r => base[r.dir];
    const groups = GROUPS.map(([key, name, test, confirmed]) => groupStats(rows.filter(test), name, key, n / 2, baseOf, confirmed));

    const lab = rows.filter(r => r.y !== null).sort((a, b) => a.i - b.i);
    const N = lab.length, overall = N ? mean(lab.map(r => r.y)) : 0.5;
    const model = { status: 'few', n: N, need: o.minRows, auc: null, oos: 0, quintiles: [], top: null, verdict: 'few', weights: [] };
    let live = null, keys = null;
    if (N >= o.minRows) {
      const start = Math.floor(N * o.firstTest), recs = [];
      for (let k = 0; k < o.folds; k++) {
        const a = start + Math.floor(k * (N - start) / o.folds), b = start + Math.floor((k + 1) * (N - start) / o.folds);
        if (a >= b) continue;
        const testStart = lab[a].i;
        // purge: only patterns whose race was over before the first test candle
        const train = lab.filter(r => r.i + o.raceBars < testStart);
        if (train.length < 100) continue;
        const rec = keyRecords(train, mean(train.map(r => r.y)), o.prior), m = fitRows(train, rec, o);
        for (let q = a; q < b; q++) {
          const r = lab[q];
          recs.push({ p: SP.prob(m, withPrior(r, rec, false).x), y: r.y, i: r.i, r: r.trade ? r.trade.r : null, base: base[r.dir] });
        }
      }
      model.oos = recs.length;
      model.auc = auc(recs);
      const sorted = recs.slice().sort((a, b) => a.p - b.p);
      for (let q = 0; q < 5; q++) {
        const s = sorted.slice(Math.floor(q * sorted.length / 5), Math.floor((q + 1) * sorted.length / 5));
        const ci = CS.wilson(s.reduce((t, x) => t + x.y, 0), s.length), rs = s.filter(x => x.r !== null).map(x => x.r);
        model.quintiles.push({ n: s.length, predicted: mean(s.map(x => x.p)), p: ci.p, lo: ci.lo, hi: ci.hi, avgR: rs.length ? mean(rs) : null });
      }
      const top = sorted.slice(Math.floor(sorted.length * 0.8));
      const bar = Math.max(mean(recs.map(x => x.base)) || 0.5, mean(recs.map(x => x.y)) || 0.5);
      const mid = recs.length ? recs[recs.length >> 1].i : 0;
      const halves = [top.filter(x => x.i < mid), top.filter(x => x.i >= mid)].map(s => ({
        n: s.length, p: s.length ? mean(s.map(x => x.y)) : null,
        avgR: s.filter(x => x.r !== null).length ? mean(s.filter(x => x.r !== null).map(x => x.r)) : null,
      }));
      const tci = CS.wilson(top.reduce((t, x) => t + x.y, 0), top.length), tr = top.filter(x => x.r !== null).map(x => x.r);
      model.top = { n: top.length, p: tci.p, lo: tci.lo, hi: tci.hi, bar, avgR: tr.length ? mean(tr) : null, halves };
      const edge = top.length >= MIN_TOP && model.auc !== null && model.auc >= 0.55 && tci.lo > bar && model.top.avgR > 0
        && halves.every(h => h.p !== null && h.p > bar && h.avgR !== null && h.avgR > 0);
      model.status = recs.length >= 200 ? 'tested' : 'few';
      model.verdict = model.status === 'tested' ? (edge ? 'edge' : 'none') : 'few';
      // the model for new patterns: everything whose result is known
      keys = keyRecords(lab, overall, o.prior);
      const m = fitRows(lab, keys, o);
      live = { names: m.names, mean: m.mean, std: m.std, w: m.w, b: m.b };
      model.weights = NAMES.map((name, k) => ({ name, label: LABELS[name], w: m.w[k] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    } else if (N) {
      keys = keyRecords(lab, overall, o.prior);
    }
    // each pattern's own record, for the per-pattern lines
    const records = {};
    if (keys) {
      for (const [k, a] of Object.entries(keys)) {
        if (k[0] === '_') continue;
        const ci = CS.wilson(a.k, a.n);
        const b = (CS.describe(k) || {}).dir === 'bear' ? base.bear : base.bull;
        records[k] = { n: a.n, p: ci.p, lo: ci.lo, hi: ci.hi, base: b, verdict: a.n < 30 ? 'few' : ci.lo > b ? 'better' : ci.hi < b ? 'worse' : 'same' };
      }
    }
    return {
      candles: n, patterns: rows.length, labelled: N, base, overall, groups, model, live,
      keys: keys ? { _base: keys._base, _m: keys._m, ...Object.fromEntries(Object.entries(keys).filter(([k]) => k[0] !== '_').map(([k, a]) => [k, { n: a.n, k: a.k, prior: a.prior }])) } : null,
      records,
      options: { raceBars: o.raceBars, tradeBars: o.tradeBars, rr: o.rr, slBufferAtr: o.slBufferAtr, spread: o.spread },
    };
  }

  // ---------- one pattern, now ----------

  /*
   * Why this pattern matters (or not), in words, from its context: the reasons a trader reads
   * a candle by. price(p) formats a price.
   */
  function reasons(cx, hit, price = fmt) {
    const f = cx.f, bull = hit.dir === 'bull', out = [];
    if (cx.sweptLevel) out.push(`swept ${cx.sweptLevel.label} ${price(cx.sweptLevel.price)}`);
    if (f.zone) out.push(`at the marked ${bull ? 'buy' : 'sell'} zone`);
    else if (f.fvg) out.push(`into an open ${bull ? 'bullish' : 'bearish'} FVG`);
    if (f.ext50) out.push(`50-candle ${bull ? 'low' : 'high'}`);
    else if (f.ext20) out.push(`20-candle ${bull ? 'low' : 'high'}`);
    if (f.move >= 1.5) out.push(`after a ${f.move.toFixed(1)} ATR ${bull ? 'fall' : 'rise'}`);
    if (f.htf) out.push(f.htf > 0 ? 'with the 1h trend' : 'against the 1h trend');
    if (cx.volX >= 1.5) out.push(`volume ${cx.volX.toFixed(1)}×`);
    if (f.discount >= 0.75) out.push(bull ? 'deep in discount' : 'deep in premium');
    if (f.close >= 0.75) out.push('strong close');
    if (f.london) out.push('London');
    else if (f.ny) out.push('New York');
    else if (f.asia) out.push('Asia');
    return out;
  }

  /*
   * Score a pattern with a study's results: {p, model, record, verdict, reasons, text}.
   * p is the model's chance that price goes 1 ATR its way first; it is only offered as a
   * prediction when the model proved an edge out of sample (verdict 'edge').
   */
  function score(res, V, hit, { price = fmt } = {}) {
    if (!res || hit.dir === 'neutral') return null;
    const o = { ...DEFAULTS, ...(res.options || {}) };
    const cx = contextOf(V, hit, o), rec = res.records && res.records[hit.key] ? res.records[hit.key] : null;
    let p = null;
    if (res.live && res.keys) {
      const x = cx.x.concat(priorOf(res.keys, { key: hit.key, y: 0 }, false));
      p = SP.prob(res.live, x);
    }
    const why = reasons(cx, hit, price);
    const verdict = res.model ? res.model.verdict : 'few';
    const pc = v => `${Math.round(100 * v)}%`;
    let text;
    if (verdict === 'edge' && p !== null) {
      text = `${pc(p)} to reach 1 ATR its way first (the model's best fifth won ${pc(res.model.top.p)} out of sample vs ${pc(res.model.top.bar)})`;
    } else if (rec && rec.n >= 30) {
      text = `tested: 1 ATR its way first ${pc(rec.p)} of ${rec.n.toLocaleString('en-US')} times vs ${pc(rec.base)} for any candle · ${rec.verdict === 'better' ? 'better than usual, but the context model found no edge' : rec.verdict === 'worse' ? 'worse than usual' : 'no edge'}`;
    } else {
      text = rec ? `only ${rec.n} past cases: too few to judge` : 'not seen on this data yet';
    }
    return { p, verdict, record: rec, reasons: why, text, context: cx.f };
  }

  return { DEFAULTS, NAMES, LABELS, GROUPS: GROUPS.map(([key, name]) => ({ key, name })), env, contextOf, race, trade, baseRates, study, score, reasons, auc };
}));
