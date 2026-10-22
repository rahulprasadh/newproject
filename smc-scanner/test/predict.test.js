// Run with: node --test smc-scanner/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const SMC = require('../engine.js');
const P = require('../predict.js');

let cache = null;
function sample() {
  if (!cache) {
    global.window = global.window || {};
    require(path.join(__dirname, '..', 'data', 'sample.js'));
    const bars = SMC.parseCSV(window.SMC_SAMPLE.csv);
    cache = { bars, m5: SMC.run(bars), m15: SMC.run(SMC.resample(bars, 900)) };
  }
  return cache;
}

let wf5 = null;
const walk5 = () => wf5 || (wf5 = P.walkForward(sample().m5));

// Hand-built 5m candles with fixed ATR 2 and liquidity levels placed by hand.
const ROWS = [
  [100, 101, 99, 100], [100, 101, 99, 100.5], [100.5, 102, 100, 101], [101, 105.5, 100.5, 104],
  [104, 104.5, 103, 103], [103, 103.5, 102, 102], [102, 102.5, 99, 100], [100, 100.5, 94, 96],
  [96, 97, 95.5, 96], [96, 96.5, 95.8, 96],
];
const LEVELS = [
  { kind: 'high', price: 105, at: 0, endAt: 3 },
  { kind: 'low', price: 95, at: 0, endAt: 7 },
  { kind: 'high', price: 104.5, at: 5, endAt: null },
  { kind: 'low', price: 93, at: 8, endAt: null },
  // a "high" level under the close (e.g. a PDH price already traded through) is not liquidity above
  { kind: 'high', price: 99.5, at: 0, endAt: null },
];
const SHORT = { horizons: [10, 20], liqHorizon: 30 };   // 2, 4 and 6 candles on 5m

function fakeEngine(rows = ROWS, levels = LEVELS) {
  const t0 = Date.UTC(2026, 5, 1, 12) / 1000;
  const bars = rows.map(([o, h, l, c], k) => ({ t: t0 + k * 300, o, h, l, c, v: 0 }));
  return {
    bars, atr: bars.map(() => 2), volAvg: bars.map(() => 0), setups: [],
    events: levels.map(lv => ({ type: 'liq', i: lv.at, end: null, ...lv })),
  };
}

// Small deterministic random numbers for the synthetic fits.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

test('features at a candle are the same from a prefix run as from the full run (no lookahead)', () => {
  const { bars, m5, m15 } = sample();
  const fast = P.allFeatures(m5);
  assert.deepEqual(fast.names, P.NAMES);
  // also candles where a setup is live and its next step is already known to the full run
  const pending = [
    ...m5.setups.filter(s => s.chochAt !== null && s.chochAt > s.sweepAt + 1).slice(0, 2).map(s => s.chochAt - 1),
    ...m5.setups.filter(s => s.armedAt !== null && s.armedAt > s.chochAt).slice(0, 2).map(s => s.chochAt),
  ];
  assert.ok(pending.length >= 2);
  for (const i of [300, 2500, 9001, 17777, 26000, bars.length - 1, ...pending]) {
    const want = P.features(m5, i);
    assert.deepEqual(want.names, P.NAMES);
    assert.equal(want.x.length, P.NAMES.length);
    assert.ok(want.x.every(Number.isFinite), `finite features at ${i}`);
    const part = SMC.run(bars.slice(0, i + 1));
    assert.deepEqual(P.features(part, i).x, want.x, `prefix run, direct path, candle ${i}`);
    assert.deepEqual(P.allFeatures(part).x[i], want.x, `prefix run, fast path, candle ${i}`);
    assert.deepEqual(fast.x[i], want.x, `full run, fast path, candle ${i}`);
  }
  for (let i = 0; i < bars.length; i += 211) {
    assert.deepEqual(fast.x[i], P.features(m5, i).x, `fast path matches direct path at ${i}`);
  }
  const fast15 = P.allFeatures(m15), b15 = m15.bars;
  for (const i of [1000, 6000, b15.length - 1]) {
    const part = SMC.run(b15.slice(0, i + 1));
    assert.deepEqual(P.features(part, i).x, fast15.x[i], `15m prefix run at ${i}`);
  }
  // dataset rows carry the same vectors on every stride-th candle after the warm-up
  const ds = P.dataset(m5);
  assert.ok(ds.rows.every(r => r.i % P.DEFAULTS.stride === 0 && r.i >= P.DEFAULTS.warmup));
  for (const r of ds.rows.filter((_, k) => k % 500 === 0)) assert.deepEqual(r.x, fast.x[r.i]);
});

test('labels which liquidity is taken first, the close H minutes later and the range', () => {
  const e = fakeEngine();
  const lab = P.labels(e, SHORT);
  assert.deepEqual(lab.map(l => l.y.liq), [1, 1, 1, null, null, 0, 0, null, null, null]);
  assert.deepEqual(lab.map(l => l.y.dir10), [1, 1, 1, 0, 0, 0, 0, null, null, null]);
  assert.deepEqual(lab.map(l => l.y.dir20), [1, 1, 0, 0, 0, 0, null, null, null, null]);
  assert.equal(lab[0].rangeAtr[10], 1.5);    // candles 1-2: 102 - 99 over ATR 2
  assert.equal(lab[1].rangeAtr[10], 2.75);   // candles 2-3: 105.5 - 100
  assert.equal(lab[0].rangeAtr[20], 3.25);   // candles 1-4: 105.5 - 99
  assert.equal(lab[8].rangeAtr[10], null);

  // a shorter window: neither level is reached within 2 candles of candle 0
  const short = P.labels(e, { ...SHORT, liqHorizon: 10 });
  assert.deepEqual(short.map(l => l.y.liq).slice(0, 7), [null, 1, 1, null, null, 0, 0]);

  // one candle through both levels: we can't tell which went first
  const both = ROWS.map(r => r.slice());
  both[3] = [101, 105.5, 94.5, 104];
  assert.deepEqual(P.labels(fakeEngine(both), SHORT).map(l => l.y.liq).slice(0, 3), [null, null, null]);

  // dataset rows use the same labels
  const ds = P.dataset(e, { ...SHORT, warmup: 0, stride: 1 });
  assert.deepEqual(ds.rows.map(r => r.y), lab.map(l => l.y));
  assert.deepEqual(ds.horizons, { liq: 6, dir10: 2, dir20: 4 });
  assert.deepEqual(ds.rows[5].dist, { above: 1.25, below: 3.5 });
});

test('fit learns separable data and finds the optimum of the penalised loss', () => {
  const rnd = lcg(7);
  const rows = [];
  for (let k = 0; k < 400; k++) {
    const x = [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 10];
    rows.push({ x, y: { t: 2 * x[0] - x[1] + 0.5 > 0 ? 1 : 0 } });
  }
  const m = P.fit(rows, 't');
  assert.equal(m.n, 400);
  const acc = rows.filter(r => (P.prob(m, r.x) >= 0.5 ? 1 : 0) === r.y.t).length / rows.length;
  assert.ok(acc >= 0.98, `training accuracy ${acc}`);
  assert.ok(m.w[0] > 0 && m.w[1] < 0 && Math.abs(m.w[2]) < Math.abs(m.w[1]) / 4, `weights ${m.w}`);
  assert.ok(P.prob(m, [2, -2, 5]) > 0.99 && P.prob(m, [-2, 2, 5]) < 0.01);

  // noisy data from a known logistic model: the gradient vanishes and the slopes come back
  const r2 = lcg(11), noisy = [];
  for (let k = 0; k < 4000; k++) {
    const x = [r2() * 4 - 2, r2() * 6 - 3];
    const p = 1 / (1 + Math.exp(-(1.5 * x[0] - 0.8 * x[1] + 0.3)));
    noisy.push({ x, y: { t: r2() < p ? 1 : 0 } });
  }
  const f = P.fit(noisy, 't', { l2: 1 });
  const g = [0, 0, 0];
  for (const r of noisy) {
    const z = r.x.map((v, k) => (v - f.mean[k]) / f.std[k]), e = P.prob(f, r.x) - r.y.t;
    g[0] += e * z[0];
    g[1] += e * z[1];
    g[2] += e;
  }
  g[0] += f.w[0];
  g[1] += f.w[1];
  assert.ok(g.every(v => Math.abs(v) < 1e-6), `gradient ${g}`);
  assert.ok(Math.abs(f.w[0] / f.std[0] - 1.5) < 0.25 && Math.abs(f.w[1] / f.std[1] + 0.8) < 0.15, `slopes ${f.w}`);
  assert.ok(f.posRate > 0 && f.posRate < 1);
});

test('walk-forward never trains on a label that ends inside or after its test fold', () => {
  const { m5 } = sample();
  const wf = walk5(), o = P.DEFAULTS, n = m5.bars.length;
  const ds = P.dataset(m5), rows = ds.rows;
  assert.equal(wf.folds.length, o.folds);
  assert.equal(wf.folds[0].testStart, rows[o.minTrain].i);
  assert.equal(wf.folds[o.folds - 1].testEnd, n);
  wf.folds.forEach((f, k) => {
    assert.ok(f.testStart < f.testEnd);
    if (k) assert.equal(f.testStart, wf.folds[k - 1].testEnd);
  });
  for (const fold of [...wf.folds, wf.live]) {
    assert.ok(fold.trainEnd < fold.testStart, 'fold trains on labels known before its first test candle');
    for (const t of ['liq', 'dir60', 'dir240']) {
      const h = ds.horizons[t], m = fold.models[t];
      const eligible = rows.filter(r => r.i + h < fold.testStart && r.y[t] !== null);
      assert.equal(m.n, eligible.length, `${t} uses every purged row and nothing else`);
      assert.equal(m.trainEnd, Math.max(...eligible.map(r => r.i + h)));
      assert.ok(m.trainEnd < fold.testStart);
      assert.ok(m.trainEnd <= fold.trainEnd);
    }
  }
  // refitting on exactly the purged rows gives the stored model
  const mid = wf.folds[2];
  for (const t of ['liq', 'dir60']) {
    const h = ds.horizons[t];
    const again = P.fit(rows.filter(r => r.i + h < mid.testStart), t);
    assert.deepEqual([again.w, again.b], [mid.models[t].w, mid.models[t].b]);
  }
  // out-of-sample predictions come from a fold trained before them
  for (const t of ['liq', 'dir60', 'dir240']) {
    for (const r of wf.oos[t]) {
      const f = wf.folds.find(x => r.i >= x.testStart && r.i < x.testEnd);
      assert.ok(f && f.trainEnd < r.i);
    }
  }
  const all = [...wf.folds, wf.live];
  for (let c = 0; c <= n + 5; c += 7) {
    const got = P.modelAt(wf, c), ok = all.filter(f => f.trainEnd < c);
    if (!ok.length) {
      assert.equal(got, null, `no model at ${c}`);
      continue;
    }
    assert.ok(got.trainEnd < c, `model at ${c} was trained only on labels that ended before it`);
    assert.equal(got.trainEnd, Math.max(...ok.map(f => f.trainEnd)), `latest usable model at ${c}`);
  }
  assert.equal(P.modelAt(wf, wf.folds[0].trainEnd), null);
  assert.equal(P.modelAt(wf, n - 1), wf.live);
});

test('two runs give identical models and metrics', () => {
  const { m15 } = sample();
  assert.deepEqual(P.walkForward(m15), P.walkForward(m15));
  const again = P.walkForward(sample().m5), first = walk5();
  assert.deepEqual(again.folds, first.folds);
  assert.deepEqual(again.live, first.live);
  assert.deepEqual(again.metrics, first.metrics);
});

test('forecast gives probabilities, ranges, liquidity targets and drivers from out-of-sample models', () => {
  const { m5, m15 } = sample();
  const wf = walk5(), last = m5.bars.length - 1;
  assert.equal(P.forecast(m5, wf.folds[0].trainEnd, wf), null);
  const cases = [[m5, wf, last], [m5, wf, wf.folds[2].testStart], [m15, P.walkForward(m15), m15.bars.length - 1]];
  for (const [e, w, i] of cases) {
    const f = P.forecast(e, i, w), b = e.bars[i];
    assert.ok(f, `forecast at ${i}`);
    assert.equal(f.at, i);
    assert.equal(f.t, b.t);
    assert.equal(f.price, b.c);
    assert.deepEqual(f.horizons.map(h => h.minutes), [60, 240]);
    for (const h of f.horizons) {
      assert.equal(h.bars, w.horizons['dir' + h.minutes]);
      assert.ok(h.pUp > 0 && h.pUp < 1);
      assert.ok(h.range.p50 > 0 && h.range.p80 >= h.range.p50);
      assert.ok(['low', 'medium', 'high'].includes(h.confidence));
    }
    const L = f.liquidity;
    if (L.above) assert.ok(L.above.price > b.c && L.above.distAtr > 0 && L.above.label && L.above.src);
    if (L.below) assert.ok(L.below.price < b.c && L.below.distAtr > 0 && L.below.label && L.below.src);
    if (L.above && L.below) {
      assert.ok(L.pAboveFirst > 0 && L.pAboveFirst < 1 && L.pRandomWalk > 0 && L.pRandomWalk < 1);
      assert.ok(L.track.n > 0 && L.track.randomWalk >= 0 && L.track.randomWalk <= 1);
    } else {
      assert.equal(L.pAboveFirst, null);
    }
    assert.ok(['low', 'medium', 'high'].includes(L.confidence));
    assert.ok(['up', 'down', 'neutral'].includes(f.bias));
    assert.ok(f.drivers.length > 0 && f.drivers.length <= 3);
    for (const d of f.drivers) {
      assert.ok(P.NAMES.includes(d.name) && Number.isFinite(d.effect));
      assert.ok(typeof d.label === 'string' && d.label.length > 5);
    }
    const size = f.drivers.map(d => Math.abs(d.effect));
    assert.deepEqual(size, size.slice().sort((a, b) => b - a));
    assert.deepEqual(Object.keys(f.quality), ['liq', 'dir60', 'dir240']);
    assert.ok(f.model.trainedThrough < i && f.model.trainedRows > 0);
  }
  // inside a test fold the forecast uses that fold's model
  const k = wf.folds[2];
  assert.equal(P.forecast(m5, k.testStart, wf).model.trainedThrough, k.trainEnd);
});

test('setup odds only count setups that had finished before the candle', () => {
  const s = (id, sweepAt, chochAt, armedAt, endAt, entry, extra) => ({
    id, dir: 'bull', stage: 'swept', sweepAt, chochAt, armedAt, endAt,
    entry: entry ? { at: endAt, ...entry } : null, ...extra,
  });
  const cur = s(7, 50, 52, null, null, null);
  const e = {
    setups: [
      s(1, 0, 2, 4, 6, { exitAt: 9, outcome: 'win' }),
      s(2, 10, null, null, 15),
      s(3, 20, 22, null, 25),
      s(4, 30, 31, 33, 35, { exitAt: 60, outcome: 'loss' }),
      s(5, 40, 41, null, 70),               // still running at 55
      { ...s(6, 1, 2, null, 5), dir: 'bear' },
      cur,
    ],
  };
  const at55 = P.setupOdds(e, cur, 55);
  assert.equal(at55.stage, 'choch');
  assert.equal(at55.scope, 'all');
  assert.equal(at55.n, 4);
  assert.deepEqual([at55.rates.choch.n, at55.rates.choch.p], [4, 3 / 4]);
  assert.deepEqual([at55.rates.armed.n, at55.rates.armed.p], [3, 2 / 3]);
  assert.deepEqual([at55.rates.entry.n, at55.rates.entry.p], [2, 1]);
  assert.deepEqual([at55.rates.win.n, at55.rates.win.p], [1, 1]);   // setup 4's trade is still open
  assert.deepEqual([at55.pWinFromHere.n, at55.pWinFromHere.p], [2, 1 / 2]);
  assert.ok(at55.rates.choch.lo < 0.75 && at55.rates.choch.hi > 0.75);
  const at60 = P.setupOdds(e, cur, 60);
  assert.deepEqual([at60.rates.win.n, at60.rates.win.p], [2, 1 / 2]);
  assert.deepEqual([at60.pWinFromHere.n, at60.pWinFromHere.p], [3, 1 / 3]);
  assert.equal(P.setupOdds(e, cur, 52).stage, 'choch');
  assert.equal(P.setupOdds(e, cur, 51).stage, 'swept');

  // same-session history is used once it has 30 setups
  const many = [];
  for (let k = 0; k < 40; k++) {
    many.push(s(100 + k, k * 10, null, null, k * 10 + 5, null, { session: k < 35 ? 'london' : 'asia' }));
  }
  const london = s(999, 500, null, null, null, null, { session: 'london' });
  const asia = { ...london, id: 998, session: 'asia' };
  const big = { setups: [...many, london, asia] };
  assert.deepEqual([P.setupOdds(big, london, 600).scope, P.setupOdds(big, london, 600).n], ['session', 35]);
  assert.deepEqual([P.setupOdds(big, asia, 600).scope, P.setupOdds(big, asia, 600).n], ['all', 40]);

  // on the sample, odds from the full run equal odds from a run that stops at the candle
  const { bars, m5 } = sample();
  const picks = m5.setups
    .filter(x => x.chochAt !== null && x.sweepAt > 3000)
    .filter((_, k) => k % 25 === 0)
    .slice(0, 4);
  assert.ok(picks.length >= 2);
  for (const x of picks) {
    const c = x.chochAt;
    const part = SMC.run(bars.slice(0, c + 1));
    const y = part.setups.find(q => q.id === x.id);
    assert.deepEqual(P.setupOdds(m5, x, c), P.setupOdds(part, y, c), `setup ${x.id} at ${c}`);
  }
});

test('New York sessions follow daylight saving', () => {
  const at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
  assert.equal(P.session(at(2026, 3, 6, 6, 30)), 'other');    // 01:30 EST
  assert.equal(P.session(at(2026, 3, 10, 6, 30)), 'london');  // 02:30 EDT
  assert.equal(P.session(at(2026, 10, 30, 6, 30)), 'london'); // 02:30 EDT
  assert.equal(P.session(at(2026, 11, 2, 6, 30)), 'other');   // 01:30 EST
  assert.equal(P.session(at(2026, 7, 1, 0, 30)), 'asia');     // 20:30 EDT
  assert.equal(P.session(at(2026, 1, 15, 13, 0)), 'ny');      // 08:00 EST
});

test('walk-forward runs fast enough to refresh every few minutes', () => {
  const { m5, m15 } = sample();
  let t0 = performance.now();
  const wf = P.walkForward(m5);
  const ms5 = performance.now() - t0;
  t0 = performance.now();
  P.walkForward(m15);
  const ms15 = performance.now() - t0;
  assert.ok(wf.folds.length === P.DEFAULTS.folds);
  assert.ok(ms5 < 2500, `5m walk-forward took ${ms5.toFixed(0)} ms`);
  assert.ok(ms15 < ms5, `15m (${ms15.toFixed(0)} ms) should be faster than 5m (${ms5.toFixed(0)} ms)`);
});
