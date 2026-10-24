// Run with: node --test smc-scanner/test/*.test.js
// Candlestick patterns: each one on a hand-built chart, its mirror image, the trend it needs,
// no look-ahead, and the follow-through statistics.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../candles.js');
const { loadSample } = require('../live/sources.js');

// Ten candles falling (or rising) 0.5 a candle, range 1 (so ATR is about 1), then the pattern.
// Pattern candles are [o, h, l, c] relative to the last lead close L.
function chart(trend, pattern, start = 100) {
  const B = [];
  let o = start;
  for (let k = 0; k < 10; k++) {
    const step = trend === 'down' ? -0.5 : trend === 'up' ? 0.5 : (k % 2 ? 0.5 : -0.5);
    const c = o + step;
    B.push({ t: 1790000000 + k * 300, o, h: Math.max(o, c) + 0.25, l: Math.min(o, c) - 0.25, c, v: 100 });
    o = c;
  }
  const L = o;
  pattern.forEach(([po, ph, pl, pc], k) => {
    B.push({ t: 1790000000 + (10 + k) * 300, o: L + po, h: L + ph, l: L + pl, c: L + pc, v: 100 });
  });
  return B;
}
// The same chart upside down: a bullish pattern after a fall becomes its bearish twin after a rise
const flip = B => B.map(b => ({ ...b, o: 200 - b.o, c: 200 - b.c, h: 200 - b.l, l: 200 - b.h }));

const BULL = {
  hammer: [[0, 0.25, -0.9, 0.2]],
  invertedHammer: [[0, 1.1, -0.3, 0.2]],
  dragonflyDoji: [[0, 0.04, -0.8, 0.02]],
  bullMarubozu: [[0, 1.25, 0, 1.2]],
  bullPin: [[0, 0.2, -0.8, 0.1]],
  bullEngulfing: [[0, 0.05, -0.5, -0.4], [-0.45, 0.35, -0.55, 0.3]],
  bullHarami: [[0, 0.05, -1.05, -1.0], [-0.8, -0.45, -0.85, -0.5]],
  bullHaramiCross: [[0, 0.05, -1.05, -1.0], [-0.6, -0.4, -0.8, -0.59]],
  piercing: [[0, 0.05, -0.85, -0.8], [-0.82, -0.25, -0.9, -0.3]],
  tweezerBottom: [[0, 0.1, -0.6, -0.4], [-0.4, 0.05, -0.62, 0]],
  bullKicker: [[0, 0.05, -0.65, -0.6], [0, 0.65, -0.05, 0.6]],
  morningStar: [[0, 0.05, -1.05, -1.0], [-1.05, -0.9, -1.2, -0.95], [-0.95, -0.35, -1.0, -0.4]],
  morningDojiStar: [[0, 0.05, -1.05, -1.0], [-1.05, -0.95, -1.2, -1.04], [-1.0, -0.35, -1.05, -0.4]],
  threeWhiteSoldiers: [[0, 0.7, -0.05, 0.6], [0.4, 1.2, 0.35, 1.1], [0.9, 1.7, 0.85, 1.6]],
  threeInsideUp: [[0, 0.05, -1.05, -1.0], [-0.8, -0.45, -0.85, -0.5], [-0.5, 0.15, -0.55, 0.1]],
  threeOutsideUp: [[0, 0.05, -0.5, -0.4], [-0.45, 0.35, -0.55, 0.3], [0.3, 0.65, 0.25, 0.6]],
  bullThreePins: [[0, 0.05, -0.6, -0.1], [-0.1, -0.05, -0.7, -0.15], [-0.15, 0, -0.75, -0.05]],
  invHeadShoulders: [[0, 0.1, -0.4, -0.2], [-0.2, -0.1, -0.8, -0.3], [-0.3, 0.15, -0.5, 0.1]],
};
const MIRROR = {
  hammer: 'shootingStar', invertedHammer: 'hangingMan', dragonflyDoji: 'gravestoneDoji', bullMarubozu: 'bearMarubozu',
  bullPin: 'bearPin', bullEngulfing: 'bearEngulfing', bullHarami: 'bearHarami', bullHaramiCross: 'bearHaramiCross',
  piercing: 'darkCloud', tweezerBottom: 'tweezerTop', bullKicker: 'bearKicker', morningStar: 'eveningStar',
  morningDojiStar: 'eveningDojiStar', threeWhiteSoldiers: 'threeBlackCrows', threeInsideUp: 'threeInsideDown',
  threeOutsideUp: 'threeOutsideDown', bullThreePins: 'bearThreePins', invHeadShoulders: 'headShoulders',
};

test('every pattern has a name, a direction, a rule and a meaning, and every key is tested', () => {
  assert.ok(C.PATTERNS.length >= 39);
  const keys = new Set(C.PATTERNS.map(p => p.key));
  assert.equal(keys.size, C.PATTERNS.length, 'keys are unique');
  for (const p of C.PATTERNS) {
    assert.ok(p.name && p.rule && p.meaning, p.key);
    assert.ok(['bull', 'bear', 'neutral'].includes(p.dir), p.key);
  }
  const tested = new Set([...Object.keys(BULL), ...Object.values(MIRROR), 'doji', 'longLeggedDoji', 'spinningTop']);
  for (const k of keys) assert.ok(tested.has(k), `${k} has a test chart`);
});

test('each bullish pattern is found on its chart, and its bearish twin on the mirror image', () => {
  for (const [key, pat] of Object.entries(BULL)) {
    const p = C.describe(key);
    const B = chart(p.trend === 'down' ? 'down' : 'flat', pat), i = B.length - 1;
    const hit = C.match(B, i, key, { atr: C.atrSeries(B) });
    assert.ok(hit, `${key} on its chart`);
    assert.equal(hit.dir, 'bull');
    assert.equal(hit.from, i - p.bars + 1);
    assert.equal(hit.tip, Math.min(...B.slice(hit.from).map(b => b.l)), `${key}: tip is the pattern low`);
    const M = flip(B), twin = MIRROR[key];
    const h2 = C.match(M, i, twin, { atr: C.atrSeries(M) });
    assert.ok(h2, `${twin} on the mirror image`);
    assert.equal(h2.dir, 'bear');
    assert.equal(h2.tip, Math.max(...M.slice(h2.from).map(b => b.h)));
  }
});

test('reversal patterns need the trend they reverse; trend: false checks the shape only', () => {
  const ham = BULL.hammer;
  // a hammer shape at the top of a rise is a hanging man, not a hammer
  const up = chart('up', ham), i = up.length - 1, atr = C.atrSeries(up);
  assert.equal(C.match(up, i, 'hammer', { atr }), null);
  assert.ok(C.match(up, i, 'hangingMan', { atr }));
  assert.ok(C.match(up, i, 'hammer', { atr, trend: false }), 'the shape alone');
  // an engulfing candle in a sideways market is not a reversal
  const flat = chart('flat', BULL.bullEngulfing);
  assert.equal(C.match(flat, flat.length - 1, 'bullEngulfing', { atr: C.atrSeries(flat) }), null);
  assert.ok(C.match(flat, flat.length - 1, 'bullEngulfing', { atr: C.atrSeries(flat), trend: false }));
  // after a fall, but not at the low of it: no hammer
  const notLow = chart('down', [[1.5, 1.75, 0.6, 1.7]]);
  assert.equal(C.match(notLow, notLow.length - 1, 'hammer', { atr: C.atrSeries(notLow), trend: false }) !== null, true);
  assert.equal(C.match(notLow, notLow.length - 1, 'hammer', { atr: C.atrSeries(notLow) }), null);
});

test('the doji family and spinning top are told apart', () => {
  const at = pat => {
    const B = chart('flat', [pat]);
    return C.detectAt(B, B.length - 1, { keys: ['doji', 'longLeggedDoji', 'dragonflyDoji', 'gravestoneDoji', 'spinningTop'], trend: false }).map(h => h.key);
  };
  assert.deepEqual(at([0, 0.2, -0.2, 0.01]), ['doji']);
  assert.deepEqual(at([0, 0.6, -0.6, 0.02]), ['longLeggedDoji']);
  assert.deepEqual(at([0, 0.04, -0.8, 0.02]), ['dragonflyDoji']);
  assert.deepEqual(at([0, 0.8, -0.04, 0.02]), ['gravestoneDoji']);
  assert.deepEqual(at([0, 0.4, -0.4, 0.15]), ['spinningTop']);
  assert.deepEqual(at([0, 0.05, -0.05, 0.001]), [], 'a flat candle is too small to mean anything');
});

test('stars: volume at least 1.5x average and a 20-candle extreme each add one', () => {
  const B = chart('down', BULL.hammer), i = B.length - 1;
  const plain = C.match(B, i, 'hammer', { atr: C.atrSeries(B), vol: C.volSeries(B) });
  assert.equal(plain.extreme, true);
  assert.equal(plain.stars, 2);
  B[i].v = 400;
  const loud = C.match(B, i, 'hammer', { atr: C.atrSeries(B), vol: C.volSeries(B) });
  assert.ok(loud.volX >= 3.9);
  assert.equal(loud.stars, 3);
});

test('no look-ahead: patterns found on the first N candles are the same as in the full run', () => {
  const bars = loadSample().bars.slice(0, 6000);
  const full = C.detectAll(bars);
  for (const n of [800, 2500, 5999]) {
    const part = C.detectAll(bars.slice(0, n));
    const expect = full.filter(h => h.i < n);
    assert.deepEqual(part.map(h => `${h.i}:${h.key}:${h.stars}`), expect.map(h => `${h.i}:${h.key}:${h.stars}`), `cut at ${n}`);
  }
});

test('evaluate: hit rates against the base rate, the 1-ATR race, and a verdict that needs both halves', () => {
  // a steady rise: every bullish signal works, every bearish one fails
  const B = [];
  for (let k = 0; k < 200; k++) B.push({ t: k * 300, o: 100 + k * 0.1, h: 100.6 + k * 0.1, l: 99.9 + k * 0.1, c: 100.1 + k * 0.1, v: 1 });
  const hits = [20, 60, 100, 140].map(i => ({ key: 'bullEngulfing', dir: 'bull', i }))
    .concat([30, 70, 110, 150].map(i => ({ key: 'bearEngulfing', dir: 'bear', i })));
  const ev = C.evaluate(B, hits, { horizons: [3] });
  assert.equal(ev.base.horizons[3].up, 1);
  const bull = ev.rows.find(r => r.key === 'bullEngulfing'), bear = ev.rows.find(r => r.key === 'bearEngulfing');
  assert.equal(bull.n, 4);
  assert.equal(bull.horizons[3].p, 1);
  assert.equal(bull.horizons[3].edge, 0, 'no edge over a market that always rises');
  assert.equal(bull.horizons[3].verdict, 'same');
  assert.equal(bear.horizons[3].p, 0);
  assert.ok(Math.abs(bull.horizons[3].avgMoveAtr - 0.3 / C.atrSeries(B)[20]) < 0.2);
  assert.equal(ev.rows.find(r => r.key === 'hammer').n, 0);
  // a filter keeps only the hits it accepts
  const some = C.evaluate(B, hits, { horizons: [3], filter: h => h.i > 100 });
  assert.equal(some.rows.find(r => r.key === 'bullEngulfing').n, 1);
});

test('on the sample: counts are sensible and every directional pattern has measured follow-through', () => {
  const bars = loadSample().bars.slice(0, 12000);
  const hits = C.detectAll(bars);
  const ev = C.evaluate(bars, hits);
  const row = k => ev.rows.find(r => r.key === k);
  for (const k of ['hammer', 'shootingStar', 'bullEngulfing', 'bearEngulfing', 'doji', 'bullPin']) assert.ok(row(k).n > 10, k);
  assert.ok(row('bullPin').n > row('hammer').n, 'a hammer is a pin bar that also needs a fall into it');
  for (const r of ev.rows) {
    if (r.dir === 'neutral' || r.n < 30) continue;
    const h = r.horizons[6];
    assert.ok(h && h.n > 0 && h.p >= 0 && h.p <= 1 && h.lo <= h.p && h.p <= h.hi, r.key);
    assert.ok(['better', 'worse', 'same'].includes(h.verdict));
  }
});
