// Run with: node --test smc-scanner/test/*.test.js
// The pattern lab: outcomes, no look-ahead, and that it finds an edge when there is one and
// none when there is none.
const test = require('node:test');
const assert = require('node:assert/strict');
const SMC = require('../engine.js');
const C = require('../candles.js');
const LAB = require('../patternlab.js');
const { loadSample } = require('../live/sources.js');

// A random walk; with plant set, every bullish (bearish) pattern at a 20-candle low (high)
// is followed by 6 candles drifting its way: an edge the lab should find.
function walk(n, { seed = 7, plant = false } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const B = [], atr = [], vol = [];
  let drift = 0, dir = 0, vsum = 0;
  for (let k = 0; k < n; k++) {
    const o = k ? B[k - 1].c : 2000;
    const c = drift > 0 ? o + 0.8 * dir + 0.4 * gauss() : o + gauss();
    if (drift > 0) drift--;
    const b = { t: 1790000000 + k * 300, o, c, h: Math.max(o, c) + Math.abs(gauss()) * 0.5, l: Math.min(o, c) - Math.abs(gauss()) * 0.5, v: 100 + Math.floor(rnd() * 100) };
    B.push(b);
    const p = B[k - 1], tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
    atr.push(k < 14 ? ((atr[k - 1] || 0) * k + tr) / (k + 1) : (atr[k - 1] * 13 + tr) / 14);
    vol.push(k ? vsum / Math.min(k, 20) : 0);
    vsum += b.v;
    if (k >= 20) vsum -= B[k - 20].v;
    if (plant && drift === 0) {
      const h = C.detectAt(B, k, { atr, vol }).find(x => x.dir !== 'neutral' && x.extreme);
      if (h) { drift = 6; dir = h.dir === 'bull' ? 1 : -1; }
    }
  }
  return B;
}

test('the race and the trade are measured the way the engine trades', () => {
  const bar = (o, h, l, c) => ({ t: 0, o, h, l, c, v: 1 });
  const B = [bar(100, 101, 99, 100), bar(100, 100.5, 99.5, 100), bar(100, 101.2, 99.8, 101), bar(101, 103.5, 100.5, 103)];
  const atr = [1, 1, 1, 1];
  assert.equal(LAB.race(B, atr, 1, true, 5), 1, 'up 1 ATR first');
  assert.equal(LAB.race(B, atr, 1, false, 5), 0, 'the short loses');
  assert.equal(LAB.race(B, atr, 0, true, 1), null, 'not decided in 1 candle');
  // a candle that reaches both counts against the pattern
  const both = [bar(100, 100, 100, 100), bar(100, 101.5, 98.5, 100)];
  assert.equal(LAB.race(both, [1, 1], 0, true, 3), 0);
  // trade: entry 100.25 (ask), stop 99.5 - 0.1 = 99.4, risk 0.85, 2R target 101.95
  const o = { ...LAB.DEFAULTS, spread: 0.25, rr: 2, tradeBars: 5 };
  const t = LAB.trade(B, atr, 1, 99.5, true, o);
  assert.equal(t.win, 1);
  assert.equal(t.r, 2);
  assert.equal(t.exitAt, 3);
  assert.equal(LAB.trade(B, atr, 2, 99.8, true, { ...o, tradeBars: 5 }), null, 'data ends before it is decided');
});

test('no look-ahead: a pattern\'s context is the same whether or not later candles exist', () => {
  const bars = loadSample().bars.slice(0, 6000), cut = 4200;
  const full = SMC.run(bars), part = SMC.run(bars.slice(0, cut));
  const Vf = LAB.env(full), Vp = LAB.env(part);
  const hits = C.detectAll(bars.slice(0, cut), { atr: part.atr, vol: part.volAvg }).filter(h => h.dir !== 'neutral' && h.i > 100);
  assert.ok(hits.length > 500);
  let sweep = 0;
  for (const h of hits) {
    const a = LAB.contextOf(Vf, h), b = LAB.contextOf(Vp, h);
    assert.deepEqual(a.x, b.x, `${h.key} at ${h.i}`);
    sweep += a.f.sweep;
  }
  assert.ok(sweep > 10, 'sweeps are seen');
});

test('a random walk has no edge, and the lab says so', () => {
  const B = walk(9000);
  const res = LAB.study(SMC.run(B));
  assert.equal(res.model.status, 'tested');
  assert.equal(res.model.verdict, 'none');
  assert.ok(res.model.auc > 0.44 && res.model.auc < 0.56, `AUC ${res.model.auc}`);
  assert.ok(res.groups.every(g => g.verdict !== 'edge'), res.groups.filter(g => g.verdict === 'edge').map(g => g.key).join());
  assert.ok(Math.abs(res.base.bull - 0.5) < 0.03 && Math.abs(res.base.bear - 0.5) < 0.03);
  // it is plain data for the dashboard
  assert.deepEqual(JSON.parse(JSON.stringify(res)).groups.length, res.groups.length);
});

test('a planted edge is found: in its context group and by the walk-forward model', () => {
  const B = walk(9000, { plant: true });
  const E = SMC.run(B), res = LAB.study(E);
  const ext = res.groups.find(g => g.key === 'ext20');
  assert.equal(ext.verdict, 'edge', JSON.stringify(ext));
  assert.ok(ext.p > 0.6);
  assert.equal(res.model.verdict, 'edge', JSON.stringify({ auc: res.model.auc, top: res.model.top }));
  assert.ok(res.model.auc >= 0.55);
  const q = res.model.quintiles;
  assert.ok(q[4].p > q[0].p + 0.1, 'the best fifth beats the worst');
  assert.ok(res.model.weights.find(w => w.name === 'ext20').w > 0, 'it learnt what the edge was');
  // scoring a new pattern in that context gives a model probability with the tested record
  const V = LAB.env(E);
  const hit = C.detectAll(B, { atr: E.atr, vol: E.volAvg }).filter(h => h.dir !== 'neutral' && h.extreme).pop();
  const sc = LAB.score(res, V, hit);
  assert.equal(sc.verdict, 'edge');
  assert.ok(sc.p > 0.55, `p ${sc.p}`);
  assert.match(sc.text, /out of sample/);
  assert.ok(sc.reasons.some(r => /candle (low|high)/.test(r)));
});

test('on the sample: the study runs, every context is measured, and patterns alone show no proven edge', () => {
  const bars = loadSample().bars.slice(0, 15000);
  const E = SMC.run(bars, { spread: 0.25 });
  const t0 = Date.now(), res = LAB.study(E, { spread: 0.25 });
  assert.ok(Date.now() - t0 < 20000);
  assert.equal(res.candles, bars.length);
  assert.ok(res.labelled > 5000);
  assert.equal(res.groups.length, LAB.GROUPS.length);
  for (const g of res.groups) {
    assert.ok(['edge', 'none', 'worse', 'few'].includes(g.verdict), g.key);
    if (g.n) assert.ok(g.lo <= g.p && g.p <= g.hi, g.key);
  }
  assert.equal(res.groups[0].key, 'all');
  assert.ok(Math.abs(res.groups[0].p - 0.5) < 0.05, 'patterns as a whole are a coin flip here');
  assert.notEqual(res.model.verdict, 'edge');
  // a pattern's line says what it did and what was around it
  const V = LAB.env(E), hit = C.detectAll(bars, { atr: E.atr, vol: E.volAvg }).filter(h => h.dir !== 'neutral').pop();
  const sc = LAB.score(res, V, hit, { price: p => p.toFixed(2) });
  assert.match(sc.text, /tested|too few|not seen/);
  assert.ok(Array.isArray(sc.reasons));
  assert.equal(LAB.score(res, V, { ...hit, dir: 'neutral' }), null);
});

test('too few patterns: no model, and the verdict says so', () => {
  const B = walk(700);
  const res = LAB.study(SMC.run(B));
  assert.equal(res.model.status, 'few');
  assert.equal(res.model.verdict, 'few');
  assert.equal(res.live, null);
});
