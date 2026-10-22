// Run with: node --test smc-scanner/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const SMC = require('../engine.js');

// A textbook bullish setup on small swing settings so it fits in 24 candles:
// swing low at 5 (98.0), lower high at 8 (101.0), sweep at 13, CHoCH + volume candle at 15,
// FVG between 14 and 16, OB = candle 13, pin bar back into the OB at 20, target hit at 23.
const ROWS = [
  [102, 103, 101, 101.5], [101.5, 102, 100.5, 100.8], [100.8, 101.2, 100, 100.2],
  [100.2, 100.6, 99.5, 99.8], [99.8, 100, 99, 99.2], [99.2, 99.6, 98, 98.6],
  [98.6, 99.8, 98.4, 99.6], [99.6, 100.6, 99.4, 100.4], [100.4, 101, 100, 100.8],
  [100.8, 100.9, 99.8, 100], [100, 100.2, 99, 99.3], [99.3, 99.8, 98.6, 98.8],
  [98.8, 99, 98.3, 98.5], [98.5, 98.9, 97.2, 98.4], [98.4, 99.2, 98.2, 99],
  [99, 101.6, 98.9, 101.5], [101.5, 102.2, 101, 102], [102, 102.3, 101.2, 101.4],
  [101.4, 101.5, 100, 100.2], [100.2, 100.3, 99, 99.2], [99.2, 99.4, 97.8, 99.1],
  [99.1, 100.5, 99, 100.4], [100.4, 102, 100.3, 101.9], [101.9, 103.5, 101.8, 103.4],
];
const OPTS = { liqLen: 3, structLen: 2, atrLen: 5, volLen: 5 };

function bars(edit = {}) {
  return ROWS.map(([o, h, l, c], k) => ({
    t: 1790000000 + k * 300, o, h, l, c,
    v: k === 15 ? 400 : k === 13 ? 150 : 100,
    ...(edit[k] || {}),
  }));
}

const mirror = list => list.map(b => ({ ...b, o: 200 - b.o, c: 200 - b.c, h: 200 - b.l, l: 200 - b.h }));
const ofType = (e, type) => e.events.filter(x => x.type === type);

test('marks each step of a bullish setup on the right candle', () => {
  const e = SMC.run(bars(), OPTS);
  const [s] = e.setups.filter(x => x.entry);
  assert.ok(s, 'expected a completed setup');
  assert.equal(s.dir, 'bull');
  assert.equal(s.sweepAt, 13);
  assert.equal(s.level.i, 5);
  assert.equal(s.chochAt, 15);
  assert.equal(s.ref.i, 8);
  assert.equal(s.disp.i, 15);
  assert.equal(s.fvgZone.kind, 'FVG');
  assert.deepEqual([s.fvgZone.bottom, s.fvgZone.top], [99.2, 101]);
  assert.equal(s.obZone.i, 13);
  assert.deepEqual([s.obZone.bottom, s.obZone.top], [97.2, 98.9]);
  assert.equal(s.entry.i, 20);
  assert.equal(s.entry.pattern, 'Pin bar');
  assert.equal(s.entry.zone, 'OB');
  assert.equal(s.entry.entry, 99.1);
  assert.ok(s.entry.sl < 97.2, 'stop sits below the order block');
  assert.ok(Math.abs(s.entry.tp - s.entry.entry - 2 * (s.entry.entry - s.entry.sl)) < 1e-9);
  assert.equal(s.entry.outcome, 'win');
  assert.equal(s.entry.exitAt, 23);
  // the zones become known on the candle after the volume candle, not before
  assert.equal(ofType(e, 'zone')[0].at, 16);
});

test('counts a volume candle that closes through an older bearish FVG as an IFVG', () => {
  // candle 11's high at 99.5 leaves a bearish gap under candle 9 (99.5 to 99.8); candle 15 closes through it
  const e = SMC.run(bars({ 11: { h: 99.5 } }), OPTS);
  const [s] = e.setups.filter(x => x.entry);
  assert.ok(s);
  assert.equal(s.fvgZone.kind, 'IFVG');
  assert.deepEqual([s.fvgZone.i, s.fvgZone.bottom, s.fvgZone.top], [10, 99.5, 99.8]);
  // an IFVG is known on the volume candle itself, one candle earlier than a plain FVG
  assert.equal(s.armedAt, 15);
  assert.equal(s.entry.i, 20);
});

test('finds the same setup as a bearish one when the chart is flipped', () => {
  const e = SMC.run(mirror(bars()), OPTS);
  const [s] = e.setups.filter(x => x.entry);
  assert.ok(s);
  assert.equal(s.dir, 'bear');
  assert.deepEqual([s.sweepAt, s.chochAt, s.disp.i, s.obZone.i, s.entry.i], [13, 15, 15, 13, 20]);
  assert.equal(s.entry.pattern, 'Pin bar');
  assert.ok(s.entry.sl > s.entry.entry && s.entry.tp < s.entry.entry);
  assert.equal(s.entry.outcome, 'win');
});

test('drops the setup when price closes back below the swept low', () => {
  const e = SMC.run(bars({ 14: { o: 98.4, h: 98.6, l: 97.5, c: 97.8 } }), OPTS);
  const s = e.setups.find(x => x.sweepAt === 13);
  assert.equal(s.reason, 'closed back through the swept level');
  assert.equal(s.chochAt, null);
  assert.equal(ofType(e, 'entry').length, 0);
});

test('needs a high-volume candle after the CHoCH', () => {
  const e = SMC.run(bars({ 15: { v: 100 } }), OPTS);
  const s = e.setups.find(x => x.sweepAt === 13);
  assert.equal(s.chochAt, 15);
  assert.equal(s.reason, 'no volume candle with an FVG or IFVG');
  assert.equal(ofType(e, 'entry').length, 0);
});

test('skips the volume check when the data has no volume', () => {
  const noVol = bars().map(b => ({ ...b, v: 0 }));
  const e = SMC.run(noVol, OPTS);
  assert.equal(ofType(e, 'entry').length, 1);
});

test('waits for a pattern: a plain dip into the OB is not an entry', () => {
  // candle 20 dips into the OB but closes near its low, so it is not a pin bar
  const e = SMC.run(bars({ 20: { o: 99.2, h: 99.4, l: 97.8, c: 98.0 } }), OPTS);
  const s = e.setups.find(x => x.sweepAt === 13);
  assert.equal(s.touchAt, 20);
  assert.notEqual(s.entry && s.entry.i, 20);
});

test('never uses future candles (prefix runs match the full run)', () => {
  global.window = {};
  require(path.join(__dirname, '..', 'data', 'sample.js'));
  const all = SMC.parseCSV(window.SMC_SAMPLE.csv).slice(0, 12000);
  const full = SMC.run(all);
  const late = ['endAt', 'end', 'invAt'];
  for (const n of [1500, 4321, 7777, 11999]) {
    const last = n - 1;
    const part = SMC.run(all.slice(0, n));
    const expected = full.events.filter(x => x.at <= last).map(x => {
      const y = { ...x };
      for (const k of late) if (y[k] != null && y[k] > last) y[k] = null;
      if (y.type === 'liq' && y.endAt === null) y.end = null;
      if (y.type === 'entry' && (y.exitAt === null || y.exitAt > last)) {
        y.outcome = null; y.exitAt = null; y.exitPrice = null;
      }
      return y;
    });
    assert.equal(part.events.length, expected.length, `event count after ${n} bars`);
    assert.deepEqual(part.events, expected, `events after ${n} bars`);
  }
});

test('reads MetaTrader, TradingView, Dukascopy and headerless CSV exports', () => {
  const at = Date.UTC(2026, 8, 25, 20, 40) / 1000;
  const mt5 = '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n'
    + '2026.09.25\t23:40:00\t4285.69\t4286.00\t4284.52\t4284.76\t477\t0\t20';
  const [m] = SMC.parseCSV(mt5, 180);
  assert.deepEqual(m, { t: at, o: 4285.69, h: 4286, l: 4284.52, c: 4284.76, v: 477 });

  const tv = `time,open,high,low,close,Volume\n${at},4285.69,4286,4284.52,4284.76,477`;
  assert.equal(SMC.parseCSV(tv)[0].t, at);

  const duka = 'Gmt time,Open,High,Low,Close,Volume\n25.09.2026 20:40:00.000,4285.69,4286,4284.52,4284.76,0.12';
  assert.equal(SMC.parseCSV(duka)[0].t, at);

  const mt4 = '2026.09.25,20:40,4285.69,4286,4284.52,4284.76,477';
  assert.deepEqual(SMC.parseCSV(mt4)[0], { t: at, o: 4285.69, h: 4286, l: 4284.52, c: 4284.76, v: 477 });

  const iso = 'datetime,open,high,low,close,volume\n2026-09-25T20:40:00+00:00,1,2,0.5,1.5,9';
  assert.equal(SMC.parseCSV(iso)[0].t, at);

  assert.throws(() => SMC.parseCSV('foo,bar\n1,2'), /Could not find/);
});

test('combines 5m candles into 15m candles', () => {
  const t0 = Date.UTC(2026, 8, 25, 9, 0) / 1000;
  const five = [
    { t: t0, o: 10, h: 12, l: 9, c: 11, v: 5 },
    { t: t0 + 300, o: 11, h: 15, l: 10, c: 14, v: 7 },
    { t: t0 + 600, o: 14, h: 14, l: 8, c: 9, v: 3 },
    { t: t0 + 900, o: 9, h: 10, l: 9, c: 10, v: 1 },
  ];
  assert.deepEqual(SMC.resample(five, 900), [
    { t: t0, o: 10, h: 15, l: 8, c: 9, v: 15 },
    { t: t0 + 900, o: 9, h: 10, l: 9, c: 10, v: 1 },
  ]);
  assert.equal(SMC.detectTimeframe(five), 300);
});
