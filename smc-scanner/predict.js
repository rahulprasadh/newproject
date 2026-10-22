/*
 * Next-move forecaster for the SMC engine.
 *
 * At the close of every candle it reads what the engine knew then (liquidity above and
 * below, last structure break, setups in progress, recent sweeps and FVGs, momentum,
 * volume, session) and learns from history what came next:
 *   liq     whether the nearest liquidity above is taken before the nearest one below
 *   dir{H}  whether the close H minutes later is higher than now
 * The models are small L2-regularised logistic regressions tested walk-forward: a fold
 * trains only on rows whose whole label window ended before its first test candle, so
 * every accuracy it reports is out of sample. Expect small edges; the report says so.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMCPredict = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    horizons: [60, 240],  // minutes ahead for the up/down calls
    liqHorizon: 1440,     // minutes allowed for one side's liquidity to be taken
    stride: 3,            // every 3rd candle becomes a training row
    folds: 5,
    l2: 1,
    minTrain: 3000,       // rows before the first test fold
    warmup: 200,          // candles skipped at the start while indicators settle
  };

  const NAMES = [
    'liqAbove', 'liqBelow', 'liqGap', 'walkOdds', 'structure', 'bullSetup', 'bearSetup',
    'sinceBullSweep', 'sinceBearSweep', 'bullFvgs', 'bearFvgs', 'ret12', 'ret48',
    'rangePos', 'emaFastSlope', 'emaSlowSlope', 'vol1', 'vol6', 'asia', 'london', 'ny',
  ];
  const LIQ_CAP = 20;       // ATRs; liquidity further than this (or missing) counts as this far
  const WALK_CLIP = 5;      // log-odds
  const SWEEP_CAP = 500;    // candles
  const FVG_WINDOW = 50;
  const RANGE_LEN = 96;
  const SLOPE_LEN = 3;
  const VOL_CAP = 5;
  const STAGE = { swept: 1, choch: 2, armed: 3 };
  const MIN_DISTS = [0, 0.05, 0.1, 0.15, 0.2];

  // ---------- time ----------

  // Same rule as SMC.detectTimeframe: the median gap between the first 500 candles
  // (5 minutes when there are too few candles to tell).
  function timeframe(bars) {
    const d = [];
    for (let k = 1; k < Math.min(bars.length, 500); k++) d.push(bars[k].t - bars[k - 1].t);
    d.sort((a, b) => a - b);
    return (d.length ? d[d.length >> 1] : 0) || 300;
  }

  const dstCache = {};
  // US daylight saving runs from the 2nd Sunday of March to the 1st Sunday of November, 02:00 local.
  function nyOffset(t) {
    const y = new Date(t * 1000).getUTCFullYear();
    let r = dstCache[y];
    if (!r) {
      const sunday = (month, nth) => {
        const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
        return Date.UTC(y, month, 1 + (7 - first) % 7 + 7 * (nth - 1)) / 1000;
      };
      r = dstCache[y] = [sunday(2, 2) + 7 * 3600, sunday(10, 1) + 6 * 3600];
    }
    return t >= r[0] && t < r[1] ? -4 * 3600 : -5 * 3600;
  }

  function nyHour(t) {
    const s = t + nyOffset(t);
    return (((s % 86400) + 86400) % 86400) / 3600;
  }

  // Kill zones in New York time.
  function session(t) {
    const h = nyHour(t);
    if (h >= 20) return 'asia';
    if (h >= 2 && h < 5) return 'london';
    if (h >= 7 && h < 10) return 'ny';
    return 'other';
  }

  function horizonBars(o, tf) {
    const toBars = min => Math.max(1, Math.round(min * 60 / tf));
    const hz = { liq: toBars(o.liqHorizon) };
    for (const m of o.horizons) hz['dir' + m] = toBars(m);
    return hz;
  }

  const targetsOf = o => ['liq', ...o.horizons.map(m => 'dir' + m)];

  // ---------- features ----------

  function ema(bars, len, upto) {
    const a = 2 / (len + 1), out = new Float64Array(upto + 1);
    let v = upto >= 0 ? bars[0].c : 0;
    for (let k = 0; k <= upto; k++) {
      if (k) v += a * (bars[k].c - v);
      out[k] = v;
    }
    return out;
  }

  const slowLen = tf => Math.max(2, Math.round(240 * 60 / tf));

  function stageAt(s, c) {
    if (s.armedAt !== null && s.armedAt <= c) return STAGE.armed;
    if (s.chochAt !== null && s.chochAt <= c) return STAGE.choch;
    return STAGE.swept;
  }

  // The engine state both feature paths reduce to; finish() turns it into the vector.
  function blankState() {
    return {
      above: null, below: null, structure: 0, bullStage: 0, bearStage: 0,
      bullSweep: -1, bearSweep: -1, bullFvgs: 0, bearFvgs: 0,
    };
  }

  function finish(E, i, tf, emaF, emaS, s) {
    const B = E.bars, b = B[i], c = b.c, atr = Math.max(E.atr[i], 1e-9);
    const dist = lv => Math.log1p(lv === null ? LIQ_CAP : Math.min(LIQ_CAP, Math.abs(lv.price - c) / atr));
    const since = at => Math.log1p(at < 0 ? SWEEP_CAP : Math.min(SWEEP_CAP, i - at));
    const back = k => B[Math.max(0, i - k)].c;
    const slope = arr => (arr[i] - arr[Math.max(0, i - SLOPE_LEN)]) / atr;
    let hi = -Infinity, lo = Infinity, v6 = 0;
    for (let k = Math.max(0, i - RANGE_LEN + 1); k <= i; k++) {
      if (B[k].h > hi) hi = B[k].h;
      if (B[k].l < lo) lo = B[k].l;
    }
    for (let k = Math.max(0, i - 5); k <= i; k++) v6 += B[k].v || 0;
    const va = (E.volAvg && E.volAvg[i]) || 0;
    const sess = session(b.t + tf);
    const up = dist(s.above), down = dist(s.below);
    // log-odds that a driftless random walk takes the level above first: log(dBelow / dAbove)
    let walk = 0;
    if (s.above && s.below) {
      const ratio = Math.max(c - s.below.price, 0.05 * atr) / Math.max(s.above.price - c, 0.05 * atr);
      walk = Math.max(-WALK_CLIP, Math.min(WALK_CLIP, Math.log(ratio)));
    }
    return [
      up, down, up - down, walk, s.structure, s.bullStage, s.bearStage,
      since(s.bullSweep), since(s.bearSweep), s.bullFvgs, s.bearFvgs,
      (c - back(12)) / atr, (c - back(48)) / atr,
      hi > lo ? (c - lo) / (hi - lo) : 0.5,
      slope(emaF), slope(emaS),
      va > 0 ? Math.min(VOL_CAP, (b.v || 0) / va) : 0,
      va > 0 ? Math.min(VOL_CAP, v6 / Math.min(6, i + 1) / va) : 0,
      sess === 'asia' ? 1 : 0, sess === 'london' ? 1 : 0, sess === 'ny' ? 1 : 0,
    ];
  }

  const live = (e, i) => e.endAt === null || e.endAt === undefined || e.endAt > i;
  const notInverted = (f, i) => f.invAt === null || f.invAt === undefined || f.invAt > i;

  function nearer(s, lv, c) {
    if (lv.kind === 'high' && lv.price > c && (!s.above || lv.price < s.above.price)) s.above = lv;
    if (lv.kind === 'low' && lv.price < c && (!s.below || lv.price > s.below.price)) s.below = lv;
  }

  // Direct path: what the engine knew at the close of candle i, read straight from its
  // events and setups, treating any late field that is set after i as unknown.
  function stateAt(E, i) {
    const B = E.bars, c = B[i].c, s = blankState(), swings = [];
    for (const e of E.events) {
      if (e.at > i) continue;
      if (e.type === 'liq') {
        if (live(e, i)) nearer(s, e, c);
      } else if (e.type === 'sweep') {
        const k = e.dir === 'bull' ? 'bullSweep' : 'bearSweep';
        if (e.at > s[k]) s[k] = e.at;
      } else if (e.type === 'fvg') {
        if (i - e.at < FVG_WINDOW && notInverted(e, i)) s[e.dir === 'bull' ? 'bullFvgs' : 'bearFvgs']++;
      } else if (e.type === 'swing') {
        swings.push(e);
      }
    }
    swings.sort((a, b) => a.at - b.at);
    let hiRef = null, loRef = null, k = 0;
    for (let j = 0; j <= i; j++) {
      while (k < swings.length && swings[k].at <= j) {
        if (swings[k].kind === 'high') hiRef = swings[k]; else loRef = swings[k];
        k++;
      }
      if (hiRef && B[j].c > hiRef.price) s.structure = 1;
      if (loRef && B[j].c < loRef.price) s.structure = -1;
    }
    for (const st of E.setups) {
      if (st.sweepAt > i || !live(st, i)) continue;
      const key = st.dir === 'bull' ? 'bullStage' : 'bearStage';
      s[key] = Math.max(s[key], stageAt(st, i));
    }
    return s;
  }

  function features(E, i) {
    if (i === undefined) i = E.bars.length - 1;
    const tf = timeframe(E.bars);
    const x = finish(E, i, tf, ema(E.bars, 20, i), ema(E.bars, slowLen(tf), i), stateAt(E, i));
    return { names: NAMES.slice(), x };
  }

  // Fast path: one pass over all candles, same values as features(E, i).
  // keep(i) picks the candles whose vectors are built; the rest only advance the state.
  function scan(E, keep) {
    const B = E.bars, n = B.length, tf = timeframe(B);
    const emaF = ema(B, 20, n - 1), emaS = ema(B, slowLen(tf), n - 1);
    const byAt = new Array(n), starts = new Array(n);
    for (const e of E.events) if (e.at < n) (byAt[e.at] = byAt[e.at] || []).push(e);
    for (const st of E.setups) if (st.sweepAt < n) (starts[st.sweepAt] = starts[st.sweepAt] || []).push(st);
    const x = new Array(n).fill(null), above = new Array(n).fill(null), below = new Array(n).fill(null);
    let levels = [], fvgs = [], setups = [], hiRef = null, loRef = null, structure = 0;
    const sweep = { bull: -1, bear: -1 };
    for (let i = 0; i < n; i++) {
      for (const e of byAt[i] || []) {
        if (e.type === 'liq') levels.push(e);
        else if (e.type === 'fvg') fvgs.push(e);
        else if (e.type === 'sweep') sweep[e.dir] = Math.max(sweep[e.dir], e.at);
        else if (e.type === 'swing') {
          if (e.kind === 'high') hiRef = e; else loRef = e;
        }
      }
      if (starts[i]) setups.push(...starts[i]);
      const c = B[i].c;
      if (hiRef && c > hiRef.price) structure = 1;
      if (loRef && c < loRef.price) structure = -1;
      if (keep && !keep(i)) continue;
      // dropping ended items only on kept candles is safe: once ended they stay ended
      levels = levels.filter(lv => live(lv, i));
      fvgs = fvgs.filter(f => i - f.at < FVG_WINDOW && notInverted(f, i));
      setups = setups.filter(st => live(st, i));
      const s = blankState();
      for (const lv of levels) nearer(s, lv, c);
      for (const f of fvgs) s[f.dir === 'bull' ? 'bullFvgs' : 'bearFvgs']++;
      for (const st of setups) {
        const key = st.dir === 'bull' ? 'bullStage' : 'bearStage';
        s[key] = Math.max(s[key], stageAt(st, i));
      }
      s.structure = structure;
      s.bullSweep = sweep.bull;
      s.bearSweep = sweep.bear;
      x[i] = finish(E, i, tf, emaF, emaS, s);
      above[i] = s.above ? s.above.price : null;
      below[i] = s.below ? s.below.price : null;
    }
    return { tf, x, above, below };
  }

  function allFeatures(E, keep) {
    return { names: NAMES.slice(), x: scan(E, keep).x };
  }

  // ---------- labels ----------

  function labelAt(E, i, hz, horizons, above, below) {
    const B = E.bars, n = B.length, atr = Math.max(E.atr[i], 1e-9), c = B[i].c;
    const y = { liq: null };
    if (above !== null && below !== null) {
      for (let j = i + 1; j <= Math.min(n - 1, i + hz.liq); j++) {
        const up = B[j].h >= above, down = B[j].l <= below;
        if (up || down) {
          y.liq = up && down ? null : up ? 1 : 0;
          break;
        }
      }
    }
    const rangeAtr = {};
    for (const m of horizons) {
      const H = hz['dir' + m], j = i + H;
      if (j >= n) {
        y['dir' + m] = null;
        rangeAtr[m] = null;
        continue;
      }
      y['dir' + m] = B[j].c > c ? 1 : B[j].c < c ? 0 : null;
      let hi = -Infinity, lo = Infinity;
      for (let k = i + 1; k <= j; k++) {
        if (B[k].h > hi) hi = B[k].h;
        if (B[k].l < lo) lo = B[k].l;
      }
      rangeAtr[m] = (hi - lo) / atr;
    }
    return { y, rangeAtr };
  }

  // What happened after every candle: {y: {liq, dir60, ...}, rangeAtr: {60, ...}} per candle.
  function labels(E, opts) {
    const o = { ...DEFAULTS, ...opts }, sc = scan(E), hz = horizonBars(o, sc.tf);
    return E.bars.map((_, i) => labelAt(E, i, hz, o.horizons, sc.above[i], sc.below[i]));
  }

  function dataset(E, opts) {
    const o = { ...DEFAULTS, ...opts };
    const keep = i => i >= o.warmup && i % o.stride === 0;
    const sc = scan(E, keep), hz = horizonBars(o, sc.tf), rows = [];
    for (let i = 0; i < E.bars.length; i++) {
      if (!keep(i)) continue;
      const lab = labelAt(E, i, hz, o.horizons, sc.above[i], sc.below[i]);
      const c = E.bars[i].c, atr = Math.max(E.atr[i], 1e-9);
      const dist = {
        above: sc.above[i] === null ? null : (sc.above[i] - c) / atr,
        below: sc.below[i] === null ? null : (c - sc.below[i]) / atr,
      };
      rows.push({ i, x: sc.x[i], y: lab.y, rangeAtr: lab.rangeAtr, dist });
    }
    return { names: NAMES.slice(), rows, horizons: hz, tf: sc.tf };
  }

  // ---------- logistic regression ----------

  function sigmoid(z) {
    if (z >= 0) return 1 / (1 + Math.exp(-z));
    const e = Math.exp(z);
    return e / (1 + e);
  }

  const softplus = z => (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z)));
  const logit = p => Math.log(p / (1 - p));

  // Solve A x = g for symmetric positive definite A (lower triangle, row-major m x m).
  function cholSolve(A, g, m) {
    const L = new Float64Array(m * m), x = new Float64Array(m);
    for (let r = 0; r < m; r++) {
      for (let c = 0; c <= r; c++) {
        let s = A[r * m + c];
        for (let k = 0; k < c; k++) s -= L[r * m + k] * L[c * m + k];
        L[r * m + c] = r === c ? Math.sqrt(Math.max(s, 1e-12)) : s / L[c * m + c];
      }
    }
    for (let r = 0; r < m; r++) {
      let s = g[r];
      for (let k = 0; k < r; k++) s -= L[r * m + k] * x[k];
      x[r] = s / L[r * m + r];
    }
    for (let r = m - 1; r >= 0; r--) {
      let s = x[r];
      for (let k = r + 1; k < m; k++) s -= L[k * m + r] * x[k];
      x[r] = s / L[r * m + r];
    }
    return x;
  }

  // L2-regularised logistic regression on standardised features, solved by Newton (IRLS)
  // with step halving. The intercept is not penalised.
  function fit(rows, target, opts) {
    const o = { ...DEFAULTS, ...opts };
    const data = rows.filter(r => r.y[target] === 0 || r.y[target] === 1);
    const n = data.length, d = n ? data[0].x.length : NAMES.length, m = d + 1;
    const mean = new Array(d).fill(0), std = new Array(d).fill(0);
    for (const r of data) for (let k = 0; k < d; k++) mean[k] += r.x[k];
    for (let k = 0; k < d; k++) mean[k] = n ? mean[k] / n : 0;
    for (const r of data) for (let k = 0; k < d; k++) std[k] += (r.x[k] - mean[k]) ** 2;
    for (let k = 0; k < d; k++) {
      std[k] = n ? Math.sqrt(std[k] / n) : 0;
      if (!(std[k] > 1e-12)) std[k] = 1;
    }
    let pos = 0;
    for (const r of data) pos += r.y[target];
    const posRate = n ? pos / n : 0.5;
    const model = { target, names: NAMES.slice(0, d), mean, std, w: new Array(d).fill(0), b: 0, n, posRate };
    if (!n || pos === 0 || pos === n) {
      model.b = logit(Math.min(0.999, Math.max(0.001, posRate)));
      return model;
    }

    const Z = new Float64Array(n * d), Y = new Float64Array(n);
    data.forEach((r, q) => {
      Y[q] = r.y[target];
      for (let k = 0; k < d; k++) Z[q * d + k] = (r.x[k] - mean[k]) / std[k];
    });
    const theta = new Float64Array(m);
    theta[d] = logit(posRate);
    const eta = (th, q) => {
      let z = th[d];
      for (let k = 0; k < d; k++) z += th[k] * Z[q * d + k];
      return z;
    };
    const lossAt = th => {
      let s = 0;
      for (let q = 0; q < n; q++) {
        const z = eta(th, q);
        s += softplus(z) - Y[q] * z;
      }
      for (let k = 0; k < d; k++) s += 0.5 * o.l2 * th[k] * th[k];
      return s;
    };

    let loss = lossAt(theta);
    for (let it = 0; it < 50; it++) {
      const H = new Float64Array(m * m), g = new Float64Array(m);
      for (let q = 0; q < n; q++) {
        const p = sigmoid(eta(theta, q)), e = p - Y[q], wq = p * (1 - p), base = q * d;
        for (let a = 0; a < d; a++) {
          const za = Z[base + a], wa = wq * za;
          g[a] += e * za;
          for (let c = 0; c <= a; c++) H[a * m + c] += wa * Z[base + c];
          H[d * m + a] += wa;
        }
        g[d] += e;
        H[d * m + d] += wq;
      }
      for (let k = 0; k < d; k++) {
        g[k] += o.l2 * theta[k];
        H[k * m + k] += o.l2;
      }
      const step = cholSolve(H, g, m);
      let t = 1, next = null, nextLoss = Infinity;
      for (; t > 1e-8; t /= 2) {
        next = theta.map((v, k) => v - t * step[k]);
        nextLoss = lossAt(next);
        if (nextLoss <= loss + 1e-12 * Math.abs(loss)) break;
      }
      if (t <= 1e-8) break;
      let moved = 0;
      for (let k = 0; k < m; k++) moved = Math.max(moved, Math.abs(next[k] - theta[k]));
      theta.set(next);
      loss = nextLoss;
      if (moved < 1e-9) break;
    }
    model.w = Array.from(theta.subarray(0, d));
    model.b = theta[d];
    return model;
  }

  function prob(model, x) {
    let z = model.b;
    for (let k = 0; k < model.w.length; k++) z += model.w[k] * (x[k] - model.mean[k]) / model.std[k];
    return sigmoid(z);
  }

  // ---------- evaluation ----------

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

  const hitOf = r => (r.p >= 0.5 ? 1 : 0) === r.y;

  // A driftless random walk reaches the nearer level first with odds set by the two distances.
  const walkOdds = d => (d.above !== null && d.below !== null ? d.below / (d.above + d.below) : null);

  function score(recs) {
    const n = recs.length;
    const out = {
      n, accuracy: null, baseline: null, brier: null, brierBase: null, auc: null,
      logloss: null, loglossBase: null, testPosRate: null, calibration: [], confident: [],
    };
    if (!n) return out;
    const walk = recs.filter(r => r.walk !== undefined && r.walk !== null);
    const clamp = p => Math.min(1 - 1e-12, Math.max(1e-12, p));
    const ll = (p, y) => -(y ? Math.log(clamp(p)) : Math.log(1 - clamp(p)));
    let hit = 0, baseHit = 0, brier = 0, brierBase = 0, logl = 0, loglBase = 0, pos = 0;
    for (const r of recs) {
      hit += hitOf(r) ? 1 : 0;
      baseHit += (r.base >= 0.5 ? 1 : 0) === r.y ? 1 : 0;
      brier += (r.p - r.y) ** 2;
      brierBase += (r.base - r.y) ** 2;
      logl += ll(r.p, r.y);
      loglBase += ll(r.base, r.y);
      pos += r.y;
    }
    Object.assign(out, {
      accuracy: hit / n, baseline: baseHit / n, brier: brier / n, brierBase: brierBase / n,
      auc: auc(recs), logloss: logl / n, loglossBase: loglBase / n, testPosRate: pos / n,
    });
    if (walk.length) {
      // the honest reference for the liquidity call: "the nearer side gets taken first"
      out.randomWalk = {
        n: walk.length,
        accuracy: walk.filter(r => (r.walk >= 0.5 ? 1 : 0) === r.y).length / walk.length,
        brier: walk.reduce((s, r) => s + (r.walk - r.y) ** 2, 0) / walk.length,
        logloss: walk.reduce((s, r) => s + ll(r.walk, r.y), 0) / walk.length,
      };
    }
    for (let k = 0; k < 10; k++) {
      const lo = k / 10, hi = (k + 1) / 10;
      const bin = recs.filter(r => r.p >= lo && (k === 9 ? r.p <= hi : r.p < hi));
      if (!bin.length) continue;
      out.calibration.push({
        lo, hi, n: bin.length,
        meanP: bin.reduce((s, r) => s + r.p, 0) / bin.length,
        hitRate: bin.reduce((s, r) => s + r.y, 0) / bin.length,
      });
    }
    for (const minDist of MIN_DISTS) {
      const sel = recs.filter(r => Math.abs(r.p - 0.5) >= minDist);
      out.confident.push({
        minDist, coverage: sel.length / n,
        accuracy: sel.length ? sel.filter(hitOf).length / sel.length : null, n: sel.length,
      });
    }
    return out;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q, k = Math.floor(pos);
    const next = sorted[Math.min(k + 1, sorted.length - 1)];
    return sorted[k] + (next - sorted[k]) * (pos - k);
  }

  // Train every target on the rows whose label window ends before `cut`.
  function trainAt(rows, cut, o, hz) {
    const models = {};
    let trainEnd = -1;
    for (const t of targetsOf(o)) {
      const h = hz[t], use = rows.filter(r => r.i + h < cut && r.y[t] !== null);
      const model = fit(use, t, o);
      model.bars = h;
      model.trainEnd = use.length ? use[use.length - 1].i + h : -1;
      models[t] = model;
      trainEnd = Math.max(trainEnd, model.trainEnd);
    }
    const ranges = {};
    for (const m of o.horizons) {
      const h = hz['dir' + m];
      const v = rows.filter(r => r.i + h < cut && r.rangeAtr[m] !== null).map(r => r.rangeAtr[m]);
      v.sort((a, b) => a - b);
      ranges[m] = { p50: quantile(v, 0.5), p80: quantile(v, 0.8), n: v.length };
    }
    return { trainEnd, models, ranges };
  }

  function walkForward(E, opts) {
    const o = { ...DEFAULTS, ...opts };
    const ds = dataset(E, o), rows = ds.rows, hz = ds.horizons, N = rows.length, n = E.bars.length;
    const targets = targetsOf(o), folds = [], oos = {};
    for (const t of targets) oos[t] = [];
    const tested = N - o.minTrain;
    if (tested >= o.folds && o.folds > 0) {
      for (let k = 0; k < o.folds; k++) {
        const a = o.minTrain + Math.floor(k * tested / o.folds);
        const b = o.minTrain + Math.floor((k + 1) * tested / o.folds);
        const testStart = rows[a].i, testEnd = b < N ? rows[b].i : n;
        const fold = { trainEnd: -1, testStart, testEnd, ...trainAt(rows, testStart, o, hz) };
        folds.push(fold);
        for (let q = a; q < b; q++) {
          const r = rows[q];
          for (const t of targets) {
            if (r.y[t] === null) continue;
            const mdl = fold.models[t];
            const rec = { i: r.i, end: r.i + hz[t], p: prob(mdl, r.x), y: r.y[t], base: mdl.posRate };
            if (t === 'liq') rec.walk = walkOdds(r.dist);
            oos[t].push(rec);
          }
        }
      }
    }
    // the model for live use: everything whose label window has closed by the last candle
    const live = folds.length
      ? { trainEnd: -1, testStart: n - 1, testEnd: n - 1, live: true, ...trainAt(rows, n - 1, o, hz) }
      : null;
    const metrics = {};
    for (const t of targets) metrics[t] = score(oos[t]);
    const last = live || folds[folds.length - 1];
    const ranges = {};
    for (const m of o.horizons) ranges[m] = last ? { p50: last.ranges[m].p50, p80: last.ranges[m].p80 } : null;
    return { names: NAMES.slice(), opts: o, tf: ds.tf, horizons: hz, rows: N, folds, live, metrics, ranges, oos };
  }

  function modelAt(wf, c) {
    if (!wf) return null;
    if (wf.live && wf.live.trainEnd < c) return wf.live;
    for (let k = wf.folds.length - 1; k >= 0; k--) if (wf.folds[k].trainEnd < c) return wf.folds[k];
    return null;
  }

  // Out-of-sample record of calls at least as strong as p, using only labels known before c.
  // For the liquidity call it also says how often "the nearer side first" was right on the same calls.
  function trackRecord(recs, c, p) {
    const d = Math.abs(p - 0.5) - 1e-12;
    let n = 0, hits = 0, walkHits = 0, walkN = 0;
    for (const r of recs || []) {
      if (r.end >= c || Math.abs(r.p - 0.5) < d) continue;
      n++;
      if (hitOf(r)) hits++;
      if (r.walk !== undefined && r.walk !== null) {
        walkN++;
        if ((r.walk >= 0.5 ? 1 : 0) === r.y) walkHits++;
      }
    }
    const hitRate = n ? hits / n : null;
    const confidence = n >= 300 && hitRate >= 0.6 ? 'high' : n >= 300 && hitRate >= 0.55 ? 'medium' : 'low';
    const track = { hitRate, n };
    if (walkN) track.randomWalk = walkHits / walkN;
    return { confidence, track };
  }

  function qualityAt(recs, c, liq) {
    let n = 0, hits = 0, base = 0, walk = 0;
    for (const r of recs || []) {
      if (r.end >= c) continue;
      n++;
      if (hitOf(r)) hits++;
      if ((r.base >= 0.5 ? 1 : 0) === r.y) base++;
      if (liq && r.walk !== null && (r.walk >= 0.5 ? 1 : 0) === r.y) walk++;
    }
    const q = { accuracy: n ? hits / n : null, baseline: n ? base / n : null, n };
    if (liq) q.randomWalk = n ? walk / n : null;
    return q;
  }

  // ---------- plain-English drivers ----------

  function span(candles, tf) {
    const min = Math.round(candles * tf / 60);
    if (min < 60) return `${min} min`;
    const h = +(min / 60).toFixed(1);
    if (h === 24) return 'day';
    return h === 1 ? 'hour' : `${h} hours`;
  }

  const STAGE_TEXT = {
    bull: [
      'No bullish setup in progress',
      'A bullish setup swept sell-side liquidity and waits for its CHoCH',
      'A bullish setup has its CHoCH and waits for a volume candle',
      'A bullish setup is armed and waits for price to return to its OB',
    ],
    bear: [
      'No bearish setup in progress',
      'A bearish setup swept buy-side liquidity and waits for its CHoCH',
      'A bearish setup has its CHoCH and waits for a volume candle',
      'A bearish setup is armed and waits for price to return to its OB',
    ],
  };

  function describe(name, v, tf, both) {
    const atrText = a => `${a.toFixed(1)} ATR`;
    const ago = since => {
      const k = Math.round(Math.expm1(since));
      return k >= SWEEP_CAP ? null : k === 0 ? 'on this candle' : `${span(k, tf)} ago`;
    };
    switch (name) {
      case 'liqAbove': {
        const a = Math.expm1(v);
        return a >= LIQ_CAP - 1e-9
          ? `No buy-side liquidity within ${LIQ_CAP} ATR above` : `Buy-side liquidity is ${atrText(a)} above`;
      }
      case 'liqBelow': {
        const a = Math.expm1(v);
        return a >= LIQ_CAP - 1e-9
          ? `No sell-side liquidity within ${LIQ_CAP} ATR below` : `Sell-side liquidity is ${atrText(a)} below`;
      }
      case 'liqGap':
        return v > 0 ? 'Sell-side liquidity is closer than buy-side'
          : v < 0 ? 'Buy-side liquidity is closer than sell-side' : 'Buy-side and sell-side liquidity are equally far';
      case 'walkOdds':
        return both ? `Distance alone gives ${Math.round(100 * sigmoid(v))}% odds that buy-side liquidity goes first`
          : 'There is no liquidity level on one side';
      case 'structure':
        return v > 0 ? 'Last structure break was bullish (close above a swing high)'
          : v < 0 ? 'Last structure break was bearish (close below a swing low)' : 'No structure break yet';
      case 'bullSetup': return STAGE_TEXT.bull[v];
      case 'bearSetup': return STAGE_TEXT.bear[v];
      case 'sinceBullSweep': {
        const a = ago(v);
        return a ? `Sell-side liquidity was swept ${a}` : `No sell-side sweep in the last ${SWEEP_CAP} candles`;
      }
      case 'sinceBearSweep': {
        const a = ago(v);
        return a ? `Buy-side liquidity was swept ${a}` : `No buy-side sweep in the last ${SWEEP_CAP} candles`;
      }
      case 'bullFvgs':
      case 'bearFvgs': {
        const side = name === 'bullFvgs' ? 'bullish' : 'bearish';
        return `${v ? v : 'No'} ${side} FVG${v === 1 ? '' : 's'} from the last ${span(FVG_WINDOW, tf)} still holding`;
      }
      case 'ret12':
      case 'ret48': {
        const k = name === 'ret12' ? 12 : 48;
        return `Price is ${v >= 0 ? 'up' : 'down'} ${atrText(Math.abs(v))} over the last ${span(k, tf)}`;
      }
      case 'rangePos': {
        const where = v > 0.7 ? 'near the top of' : v < 0.3 ? 'near the bottom of' : 'in the middle of';
        return `Price is ${where} its range over the last ${span(RANGE_LEN, tf)}`;
      }
      case 'emaFastSlope':
      case 'emaSlowSlope': {
        const label = name === 'emaFastSlope' ? 'The 20-candle EMA' : 'The 4-hour EMA';
        return `${label} is ${Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'rising' : 'falling'}`;
      }
      case 'vol1': return v ? `Last candle's volume is ${v.toFixed(1)}x average` : 'No volume on the last candle';
      case 'vol6': return v ? `Volume over the last 6 candles is ${v.toFixed(1)}x average` : 'No recent volume';
      case 'asia': return v ? 'Asian session (20:00-24:00 New York)' : 'Outside the Asian session';
      case 'london': return v ? 'London open (02:00-05:00 New York)' : 'Outside the London open';
      case 'ny': return v ? 'New York open (07:00-10:00 New York)' : 'Outside the New York open';
      default: return name;
    }
  }

  // ---------- forecast ----------

  function levelInfo(lv, price, atr) {
    if (!lv) return null;
    return {
      price: lv.price,
      label: lv.label || (lv.kind === 'high' ? 'Swing H' : 'Swing L'),
      src: lv.src || 'swing',
      distAtr: Math.abs(lv.price - price) / Math.max(atr, 1e-9),
    };
  }

  function forecast(E, i, wf) {
    const fold = modelAt(wf, i);
    if (!fold) return null;
    const B = E.bars, b = B[i], atr = E.atr[i], tf = timeframe(B);
    const st = stateAt(E, i);
    const x = finish(E, i, tf, ema(B, 20, i), ema(B, slowLen(tf), i), st);
    const o = wf.opts;

    const horizons = o.horizons.map(m => {
      const t = 'dir' + m, pUp = prob(fold.models[t], x), r = fold.ranges[m];
      const tr = trackRecord(wf.oos[t], i, pUp);
      return {
        minutes: m, bars: wf.horizons[t], pUp,
        range: r && r.p50 !== null ? { p50: r.p50 * atr, p80: r.p80 * atr } : null,
        confidence: tr.confidence, track: tr.track,
      };
    });

    const both = st.above && st.below;
    const pAbove = both ? prob(fold.models.liq, x) : null;
    const ltr = both ? trackRecord(wf.oos.liq, i, pAbove) : { confidence: 'low', track: { hitRate: null, n: 0 } };
    const above = levelInfo(st.above, b.c, atr), below = levelInfo(st.below, b.c, atr);
    const liquidity = {
      above, below, pAboveFirst: pAbove,
      pRandomWalk: both ? walkOdds({ above: above.distAtr, below: below.distAtr }) : null,
      confidence: ltr.confidence, track: ltr.track,
    };

    // only calls with a proven out-of-sample record get a vote
    let lean = 0, votes = 0;
    for (const h of horizons) if (h.confidence !== 'low') { lean += h.pUp - 0.5; votes++; }
    if (pAbove !== null && liquidity.confidence !== 'low') { lean += pAbove - 0.5; votes++; }
    const bias = !votes || Math.abs(lean) < 0.02 ? 'neutral' : lean > 0 ? 'up' : 'down';

    // drivers explain the liquidity call; without both levels, the longest up/down call
    const dm = both ? fold.models.liq : fold.models['dir' + o.horizons[o.horizons.length - 1]];
    const drivers = dm.w
      .map((w, k) => ({
        name: NAMES[k], label: describe(NAMES[k], x[k], tf, !!both), effect: w * (x[k] - dm.mean[k]) / dm.std[k],
      }))
      .filter(d => d.effect !== 0)
      .sort((p, q) => Math.abs(q.effect) - Math.abs(p.effect))
      .slice(0, 3);

    const quality = {};
    for (const t of targetsOf(o)) quality[t] = qualityAt(wf.oos[t], i, t === 'liq');
    let trainedRows = 0;
    for (const t in fold.models) trainedRows = Math.max(trainedRows, fold.models[t].n);

    return {
      at: i, t: b.t, price: b.c, horizons, liquidity, bias, drivers, quality,
      model: { trainedThrough: fold.trainEnd, trainedRows },
    };
  }

  // ---------- setup odds ----------

  function wilson(k, n) {
    if (!n) return { p: null, lo: 0, hi: 1, n: 0 };
    const z = 1.96, z2 = z * z, p = k / n, den = 1 + z2 / n;
    const mid = (p + z2 / (2 * n)) / den;
    const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
    return { p, lo: Math.max(0, mid - half), hi: Math.min(1, mid + half), n };
  }

  function setupStage(s, c) {
    if (s.entry && s.entry.at <= c) return 'entered';
    if (s.armedAt !== null && s.armedAt <= c) return 'armed';
    if (s.chochAt !== null && s.chochAt <= c) return 'choch';
    return 'swept';
  }

  // How often earlier setups in the same direction went on from each step, using only
  // setups that had finished by candle c and trades that had hit TP or SL by c.
  function setupOdds(E, setup, c) {
    const stage = setupStage(setup, c);
    const done = E.setups.filter(s => s !== setup && s.id !== setup.id && s.dir === setup.dir
      && s.endAt !== null && s.endAt !== undefined && s.endAt <= c);
    let pool = done, scope = 'all';
    if (setup.session !== undefined && setup.session !== null) {
      const same = done.filter(s => s.session === setup.session);
      if (same.length >= 30) {
        pool = same;
        scope = 'session';
      }
    }
    const exited = s => s.entry && s.entry.exitAt !== null && s.entry.exitAt !== undefined && s.entry.exitAt <= c;
    const won = s => exited(s) && s.entry.outcome === 'win';
    const reached = {
      swept: () => true,
      choch: s => s.chochAt !== null,
      armed: s => s.armedAt !== null,
      entered: s => !!s.entry,
    };
    const count = (list, f) => list.filter(f).length;
    const choch = pool.filter(reached.choch), armed = pool.filter(reached.armed);
    const entered = pool.filter(reached.entered), settled = entered.filter(exited);
    // trades still open at c have no known result, so they leave the "from here" sample
    const fromHere = pool.filter(s => reached[stage](s) && (!s.entry || exited(s)));
    return {
      stage, n: pool.length, scope,
      rates: {
        choch: wilson(choch.length, pool.length),
        armed: wilson(armed.length, choch.length),
        entry: wilson(entered.length, armed.length),
        win: wilson(count(settled, won), settled.length),
      },
      pWinFromHere: wilson(count(fromHere, won), fromHere.length),
    };
  }

  return {
    DEFAULTS, NAMES, features, allFeatures, labels, dataset, fit, prob, walkForward,
    modelAt, forecast, setupOdds, session, nyHour, wilson,
  };
}));
