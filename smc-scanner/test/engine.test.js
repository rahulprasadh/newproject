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
const SWING_ONLY = { swing: true, equal: false, prevDay: false, session: false };

// t0 = 1790000000 puts the textbook at 10:13-12:08 New York time, outside every session
function bars(edit = {}, t0 = 1790000000) {
  return ROWS.map(([o, h, l, c], k) => ({
    t: t0 + k * 300, o, h, l, c,
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
  const configs = {
    defaults: {},
    'every new option on': {
      killzones: ['london', 'ny'], htfFilter: true, requireDiscount: true, minSweepAtr: 0.1,
      spread: 0.25, slMode: 'sweep', tpMode: 'liquidity', firstTouchOnly: true,
      patterns: { threePins: true, engulf: true },
    },
    // fewer filters so that entries, exits and excursions are covered too
    'trade realism': {
      spread: 0.25, slMode: 'sweep', tpMode: 'liquidity', minSweepAtr: 0.1,
      patterns: { threePins: true, engulf: true },
    },
  };
  const late = ['endAt', 'end', 'invAt'];
  // what a setup knows at its sweep (and at arming) never changes later
  const setupView = (s, last) => ({
    id: s.id, dir: s.dir, sweepAt: s.sweepAt, levelIdx: s.level.i, src: s.src, label: s.label,
    session: s.session, htfBias: s.htfBias, aligned: s.aligned, depthAtr: s.depthAtr,
    obPd: s.armedAt !== null && s.armedAt <= last ? s.obPd : null,
  });
  for (const [name, opts] of Object.entries(configs)) {
    const full = SMC.run(all, opts);
    assert.ok(full.setups.length > 20, `${name}: expected setups to compare`);
    // besides fixed cuts, stop just before levels merge and just after sweeps and entries,
    // where late changes are most likely to leak into earlier events
    const liq = ofType(full, 'liq'), merged = liq.filter(x => x.end === 'merged');
    const isEq = x => liq.some(y => y.src === 'equal' && y.at === x.endAt);
    const entered = full.setups.filter(s => s.entry).slice(0, 2);
    const cuts = [1500, 4321, 7777, 11999,
      ...merged.filter(isEq).slice(0, 2).map(x => x.endAt),
      ...merged.filter(x => !isEq(x)).slice(0, 2).map(x => x.endAt),
      ...entered.flatMap(s => [s.sweepAt + 1, s.entry.i + 1])];
    for (const n of cuts) {
      const last = n - 1;
      const part = SMC.run(all.slice(0, n), opts);
      const view = (x, isFull) => {
        const y = { ...x };
        if (isFull) {
          for (const k of late) if (y[k] != null && y[k] > last) y[k] = null;
          if (y.type === 'liq' && y.endAt === null) y.end = null;
        }
        if (y.type === 'entry' && (y.exitAt === null || y.exitAt > last)) {
          // excursions of a trade that is still open keep changing
          y.outcome = null; y.exitAt = null; y.exitPrice = null;
          delete y.mfeR; delete y.maeR;
        }
        return y;
      };
      const expected = full.events.filter(x => x.at <= last).map(x => view(x, true));
      assert.equal(part.events.length, expected.length, `${name}: event count after ${n} bars`);
      assert.deepEqual(part.events.map(x => view(x, false)), expected, `${name}: events after ${n} bars`);
      assert.deepEqual(
        part.setups.map(s => setupView(s, last)),
        full.setups.filter(s => s.sweepAt <= last).map(s => setupView(s, last)),
        `${name}: setups after ${n} bars`,
      );
    }
    if (name === 'trade realism') {
      assert.ok(full.events.some(x => x.type === 'entry' && x.exitAt !== null), 'expected closed trades');
    }
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

// ---- New York clock, sessions and time-based liquidity ----

const utc = (...a) => Date.UTC(...a) / 1000;
// plain candles that make no swings: o = c = 100, high 100.5, low 99.5
function flat(t0, n, stepSec, edit = {}) {
  return Array.from({ length: n }, (_, k) => ({
    t: t0 + k * stepSec, o: 100, h: 100.5, l: 99.5, c: 100, v: 100, ...(edit[k] || {}),
  }));
}
const levelsOf = (e, src) => ofType(e, 'liq').filter(x => x.src === src)
  .map(x => ({ label: x.label, i: x.i, at: x.at, price: x.price }));

test('New York clock follows US daylight saving and the 17:00 trading-day start', () => {
  // DST starts 8 Mar 2026 at 02:00 EST (07:00 UTC) and ends 1 Nov 2026 at 02:00 EDT (06:00 UTC)
  assert.deepEqual([SMC.nyTime(utc(2026, 2, 8, 6, 59)).offsetMin, SMC.nyTime(utc(2026, 2, 8, 6, 59)).hour], [-300, 1]);
  assert.deepEqual([SMC.nyTime(utc(2026, 2, 8, 7, 0)).offsetMin, SMC.nyTime(utc(2026, 2, 8, 7, 0)).hour], [-240, 3]);
  assert.deepEqual([SMC.nyTime(utc(2026, 10, 1, 5, 59)).offsetMin, SMC.nyTime(utc(2026, 10, 1, 5, 59)).hour], [-240, 1]);
  assert.deepEqual([SMC.nyTime(utc(2026, 10, 1, 6, 0)).offsetMin, SMC.nyTime(utc(2026, 10, 1, 6, 0)).hour], [-300, 1]);

  // Monday 9 Mar 2026: 16:59 EDT is still Monday's trading day, 17:00 EDT (21:00 UTC) is Tuesday's
  const mon = SMC.nyTime(utc(2026, 2, 9, 20, 59)), tue = SMC.nyTime(utc(2026, 2, 9, 21, 0));
  assert.deepEqual([mon.hour, mon.minute, mon.weekday], [16, 59, 1]);
  assert.equal(mon.dayKey, utc(2026, 2, 9) / 86400);
  assert.equal(tue.dayKey, utc(2026, 2, 10) / 86400);
  // the Sunday-evening open belongs to Monday
  assert.equal(SMC.nyTime(utc(2026, 2, 8, 22, 0)).dayKey, utc(2026, 2, 9) / 86400);

  assert.equal(SMC.sessionOf(utc(2026, 8, 22, 0, 0)), 'asia');      // 20:00 EDT
  assert.equal(SMC.sessionOf(utc(2026, 8, 22, 7, 0)), 'london');    // 03:00 EDT
  assert.equal(SMC.sessionOf(utc(2026, 8, 22, 13, 55)), 'ny');      // 09:55 EDT
  assert.equal(SMC.sessionOf(utc(2026, 8, 22, 14, 0)), 'off');      // 10:00 EDT
  assert.equal(SMC.sessionOf(utc(2026, 0, 15, 12, 0)), 'ny');       // 07:00 EST

  // cross-check against the system time-zone database every hour for two years
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let t = utc(2025, 0, 1) + 1800; t < utc(2027, 0, 1); t += 3600) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map(p => [p.type, p.value]));
    const ny = SMC.nyTime(t);
    assert.deepEqual([ny.hour, ny.minute, days[ny.weekday]], [+parts.hour, +parts.minute, parts.weekday], `at ${new Date(t * 1000).toISOString()}`);
  }
});

// Hourly candles for a Friday (from its 18:00 open the evening before) and the next Monday.
// friStart / sunOpen are the UTC times of 18:00 New York, which move with daylight saving.
function weekendBars(friStart, sunOpen) {
  const fri = flat(friStart, 23, 3600, { 5: { h: 103 }, 22: { l: 97 } });
  const mon = flat(sunOpen, 25, 3600, { 7: { h: 101.5 }, 17: { l: 98.5 } });
  return fri.concat(mon);
}

test('previous-day high and low appear at 17:00 New York in March, across the DST change', () => {
  // Friday 6 Mar is on EST (day ends 22:00 UTC); Monday 9 Mar is on EDT (day ends 21:00 UTC)
  const list = weekendBars(utc(2026, 2, 5, 23), utc(2026, 2, 8, 22));
  assert.equal(list[22].t, utc(2026, 2, 6, 21));   // 16:00 EST, still Friday
  assert.equal(list[46].t, utc(2026, 2, 9, 21));   // 17:00 EDT, Tuesday's day starts
  const e = SMC.run(list, { liqSources: { swing: false, equal: false, prevDay: true, session: false } });
  assert.deepEqual(levelsOf(e, 'prevDay'), [
    { label: 'PDH', i: 5, at: 23, price: 103 },
    { label: 'PDL', i: 22, at: 23, price: 97 },
    { label: 'PDH', i: 30, at: 46, price: 101.5 },
    { label: 'PDL', i: 40, at: 46, price: 98.5 },
  ]);
  assert.equal(ofType(e, 'liq')[0].day, utc(2026, 2, 9) / 86400);
});

test('previous-day high and low appear at 17:00 New York in November, across the DST change', () => {
  // Friday 30 Oct is on EDT (day ends 21:00 UTC); Monday 2 Nov is on EST (day ends 22:00 UTC)
  const list = weekendBars(utc(2026, 9, 29, 22), utc(2026, 10, 1, 23));
  list[45].h = 101.8;                               // 21:00 UTC = 16:00 EST, still Monday
  assert.equal(list[46].t, utc(2026, 10, 2, 22));  // 17:00 EST
  const e = SMC.run(list, { liqSources: { swing: false, equal: false, prevDay: true, session: false } });
  assert.deepEqual(levelsOf(e, 'prevDay'), [
    { label: 'PDH', i: 5, at: 23, price: 103 },
    { label: 'PDL', i: 22, at: 23, price: 97 },
    { label: 'PDH', i: 45, at: 46, price: 101.8 },
    { label: 'PDL', i: 40, at: 46, price: 98.5 },
  ]);
});

test('previous-day levels last three trading days, counting over the weekend', () => {
  // Wednesday to the next Tuesday, hourly; Thursday's high stays the highest price
  const t0 = utc(2026, 8, 15, 22);                  // Tue 15 Sep 18:00 EDT = Wednesday's open
  const list = [];
  for (const d of [0, 1, 2, 5, 6]) list.push(...flat(t0 + d * 86400, 23, 3600));
  list[23 + 4].h = 104;                             // Thursday's high, becomes PDH at Friday's open
  const e = SMC.run(list, { liqSources: { swing: false, equal: false, prevDay: true, session: false } });
  const pdh = ofType(e, 'liq').find(x => x.label === 'PDH' && x.price === 104);
  assert.equal(pdh.at, 46);
  // Friday, Monday and Tuesday are its three trading days; the weekend does not count
  assert.equal(pdh.end, null, 'still active at the end of Tuesday');
  // it expires on the first candle of Wednesday
  const longer = SMC.run(list.concat(flat(t0 + 7 * 86400, 2, 3600)), { liqSources: { swing: false, equal: false, prevDay: true, session: false } });
  const again = ofType(longer, 'liq').find(x => x.label === 'PDH' && x.price === 104);
  assert.deepEqual([again.end, again.endAt], ['expired', 115]);
});

test('session highs and lows become levels when the session ends', () => {
  // 15-minute candles from 19:00 EDT on 21 Sep 2026; Asia 20:00-00:00, London 02:00-05:00
  const list = flat(utc(2026, 8, 21, 23), 44, 900, {
    2: { h: 105 },                 // before Asia: not part of the Asia high
    8: { h: 103 }, 15: { l: 97 },  // Asia
    30: { h: 102 }, 36: { l: 98 }, // London
  });
  const e = SMC.run(list, { liqSources: { swing: false, equal: false, prevDay: false, session: true } });
  assert.equal(list[20].t, utc(2026, 8, 22, 4));   // 00:00 EDT
  assert.equal(list[40].t, utc(2026, 8, 22, 9));   // 05:00 EDT
  assert.deepEqual(levelsOf(e, 'session'), [
    { label: 'Asia H', i: 8, at: 20, price: 103 },
    { label: 'Asia L', i: 15, at: 20, price: 97 },
    { label: 'London H', i: 30, at: 40, price: 102 },
    { label: 'London L', i: 36, at: 40, price: 98 },
  ]);
});

test('a session level absorbs a swing at the same price and names a multi-level sweep', () => {
  // 15-minute candles from 18:00 EDT; swing low 96 before Asia, Asia low 97 is also a swing low
  const list = flat(utc(2026, 8, 21, 22), 30, 900, {
    4: { l: 96 }, 12: { l: 97 },
    25: { o: 99.5, h: 100, l: 95.8, c: 99.6 },     // takes both 97 and 96, closes back above
  });
  const e = SMC.run(list, { ...OPTS, liqSources: { swing: true, equal: false, prevDay: false, session: true } });
  const at12 = ofType(e, 'liq').filter(x => x.i === 12);
  assert.deepEqual(at12.map(x => [x.label, x.end]), [['Swing L', 'merged'], ['Asia L', 'swept']]);
  const [sw] = ofType(e, 'sweep');
  // the session low wins over the deeper swing low
  assert.deepEqual([sw.i, sw.label, sw.src, sw.price, sw.session], [25, 'Asia L', 'session', 97, 'off']);
  assert.equal(ofType(e, 'liq').find(x => x.i === 4).end, 'swept');
  const s = e.setups[0];
  assert.deepEqual([s.src, s.label], ['session', 'Asia L']);
  assert.ok(Math.abs(s.depthAtr - 1.2 / e.atr[24]) < 1e-9);
});

test('two swing highs at the same price become one EQH level', () => {
  const H = [107, 107.5, 108, 108.5, 109, 110, 109, 108.5, 108, 108.5, 109, 109.5, 109.95, 109, 108.5, 108];
  const list = H.map((h, k) => ({ t: 1790000000 + k * 300, o: h - 0.7, h, l: h - 1, c: h - 0.3, v: 100 }));
  list.push({ t: 1790000000 + 16 * 300, o: 108.2, h: 110.3, l: 108, c: 109.6, v: 100 });
  const opts = { ...OPTS, liqSources: { swing: true, equal: true, prevDay: false, session: false } };
  const e = SMC.run(list, opts);
  const highs = ofType(e, 'liq').filter(x => x.kind === 'high');
  assert.deepEqual(highs.map(x => [x.label, x.i, x.at, x.price, x.end, x.endAt]), [
    ['Swing H', 5, 8, 110, 'merged', 15],
    ['EQH', 5, 15, 110, 'swept', 16],
  ]);
  assert.deepEqual(highs[1].touches, [5, 12]);
  const sweeps = ofType(e, 'sweep').filter(x => x.dir === 'bear');
  assert.deepEqual(sweeps.map(x => [x.i, x.label, x.price]), [[16, 'EQH', 110]]);

  // without EQH both swings stay separate levels and both are taken
  const plain = SMC.run(list, { ...opts, liqSources: SWING_ONLY });
  assert.deepEqual(ofType(plain, 'liq').filter(x => x.kind === 'high').map(x => [x.i, x.end]), [[5, 'swept'], [12, 'swept']]);

  // with swing levels off, a lone swing is not a level but two equal ones are
  const eqOnly = SMC.run(list, { ...opts, liqSources: { swing: false, equal: true, prevDay: false, session: false } });
  assert.deepEqual(ofType(eqOnly, 'liq').map(x => [x.label, x.i, x.end]), [['EQH', 5, 'swept']]);
});

test('killzones: a sweep outside the listed sessions starts no setup', () => {
  // move the textbook so the sweep candle (13) prints at 03:00 New York, inside London
  const t0 = utc(2026, 8, 22, 7) - 13 * 300;
  const e = SMC.run(bars({}, t0), { ...OPTS, killzones: ['london'] });
  const [s] = e.setups.filter(x => x.entry);
  assert.ok(s);
  assert.deepEqual([s.sweepAt, s.session, s.entry.session, s.entry.i], [13, 'london', 'london', 20]);
  const sum = e.summary();
  assert.deepEqual(sum.bySession.london, { entries: 1, wins: 1, losses: 0 });
  assert.deepEqual(sum.bySession.ny, { entries: 0, wins: 0, losses: 0 });
  assert.deepEqual(sum.bySrc.swing, { entries: 1, wins: 1, losses: 0 });
  assert.deepEqual(Object.keys(sum.bySrc), ['swing', 'equal', 'session', 'prevDay']);

  assert.equal(SMC.run(bars({}, t0), { ...OPTS, killzones: ['ny'] }).setups.length, 0);
  // at the default time the textbook is outside every session
  const off = SMC.run(bars(), OPTS);
  assert.equal(off.setups[0].session, 'off');
  assert.equal(SMC.run(bars(), { ...OPTS, killzones: ['london', 'ny'] }).setups.length, 0);
});

// ---- higher-timeframe trend ----

test('an HTF candle only counts once the next HTF candle has started', () => {
  // seven 1h candles made of four 15m candles each; H2 is a swing high at 104, H5 closes above it
  const H = [
    [100, 101, 99.5, 100.5], [100.5, 102, 100, 101.5], [101.5, 104, 101, 102], [102, 103, 100.5, 101],
    [101, 102.5, 100, 102], [102, 105, 101.5, 104.5], [104.5, 105, 104, 104.8], [104.8, 105, 104.5, 104.9],
  ];
  const t0 = utc(2026, 8, 22, 0);
  const list = [];
  H.forEach(([o, h, l, c], k) => {
    const t = t0 + k * 3600;
    list.push({ t, o, h: o, l: o, c: o, v: 1 }, { t: t + 900, o, h, l: o, c: h, v: 1 },
      { t: t + 1800, o: h, h, l, c: l, v: 1 }, { t: t + 2700, o: l, h: Math.max(l, c), l, c, v: 1 });
  });
  const e = new SMC.Engine({ htfMinutes: 60 });
  const seen = [];
  list.forEach((b, i) => { e.push(b); seen.push([i, e.htf.bars.length, e.htf.bias]); });
  // the first hour is complete in base candles at 3 but only closes when candle 4 arrives
  assert.deepEqual(seen[3], [3, 0, null]);
  assert.deepEqual(seen[4], [4, 1, null]);
  assert.deepEqual(e.htf.bars[0], { t: t0, o: 100, h: 101, l: 99.5, c: 100.5, v: 4, at: 4 });
  // H5's own candles go above 104 (candle 21 closes at 105) but the trend waits for H5 to close
  for (let i = 20; i <= 23; i++) assert.equal(seen[i][2], null, `bias at ${i}`);
  assert.equal(list[21].c, 105);
  assert.deepEqual(seen[24], [24, 6, 'bull']);
  assert.equal(e.htf.high.price, 104);

  const off = SMC.run(list, { htfMinutes: 0 });
  assert.deepEqual([off.htf.bars.length, off.htf.bias], [0, null]);
});

// six hourly candles before the textbook: HTF swing high 103 at P2, then P5 closes at 104.2
const PRE = [[101.6, 102, 101.5, 101.9], [101.9, 102.5, 101.8, 102.4], [102.4, 103, 102.2, 102.6],
  [102.6, 102.8, 101.9, 102.0], [102.0, 102.3, 101.7, 102.2], [102.2, 104.5, 102.1, 104.2]];
const withBullTrend = () => PRE.map(([o, h, l, c], k) => ({ t: 1790000000 - (6 - k) * 3600, o, h, l, c, v: 100 }))
  .concat(bars());

test('tags setups with the HTF trend and filters against it', () => {
  const e = SMC.run(withBullTrend(), { ...OPTS, liqSources: SWING_ONLY, htfFilter: true });
  const [s] = e.setups;
  assert.deepEqual([s.sweepAt, s.htfBias, s.aligned, s.reason], [19, 'bull', true, 'entry']);
  assert.equal(s.entry.i, 26);
  assert.equal(ofType(e, 'sweep')[0].htfBias, 'bull');

  const m = SMC.run(mirror(withBullTrend()), { ...OPTS, liqSources: SWING_ONLY, htfFilter: true });
  assert.deepEqual([m.setups[0].dir, m.setups[0].htfBias, m.setups[0].aligned, m.setups[0].entry.i], ['bear', 'bear', true, 26]);

  // the textbook alone has no HTF trend yet, so the filter stops it at the sweep
  const f = SMC.run(bars(), { ...OPTS, htfFilter: true });
  assert.deepEqual([f.setups[0].htfBias, f.setups[0].aligned, f.setups[0].endAt], [null, false, 13]);
  assert.equal(f.setups[0].reason, 'against the higher-timeframe trend');
  assert.equal(ofType(f, 'entry').length, 0);
  // without the filter it is only a tag
  assert.equal(SMC.run(bars(), OPTS).setups[0].aligned, false);
});

// ---- sweep depth and premium/discount ----

test('records sweep depth in ATRs and can require a minimum', () => {
  const e = SMC.run(bars(), OPTS);
  const [sw] = ofType(e, 'sweep');
  assert.deepEqual([sw.src, sw.label, sw.price], ['swing', 'Swing L', 98]);
  assert.ok(Math.abs(sw.depthAtr - (98 - 97.2) / e.atr[12]) < 1e-9);
  assert.equal(e.setups[0].depthAtr, sw.depthAtr);
  assert.equal(SMC.run(bars(), { ...OPTS, minSweepAtr: sw.depthAtr + 0.01 }).setups.length, 0);
  assert.equal(ofType(SMC.run(bars(), { ...OPTS, minSweepAtr: sw.depthAtr - 0.01 }), 'entry').length, 1);
});

// candle 14 turns bearish and tall, so it becomes the order block and sits in premium
const PREMIUM_OB = { 14: { o: 100.2, h: 100.5, l: 98.2, c: 99.0 } };

test('measures where the order block sits in the range and can require discount', () => {
  const e = SMC.run(bars(), { ...OPTS, requireDiscount: true });
  const [s] = e.setups;
  // OB 97.2-98.9 (middle 98.05) in the range from the sweep low 97.2 to the CHoCH level 101
  assert.ok(Math.abs(s.obPd - (98.05 - 97.2) / (101 - 97.2)) < 1e-9);
  assert.equal(s.entry.i, 20);

  const p = SMC.run(bars(PREMIUM_OB), { ...OPTS, requireDiscount: true }).setups[0];
  assert.equal(p.obZone.i, 14);
  assert.ok(Math.abs(p.obPd - (99.35 - 97.2) / 3.8) < 1e-9);
  assert.deepEqual([p.armedAt, p.endAt, p.reason, p.entry], [16, 16, 'order block not in discount', null]);
  assert.ok(SMC.run(bars(PREMIUM_OB), OPTS).setups[0].entry, 'without the option it still enters');

  const m = SMC.run(mirror(bars(PREMIUM_OB)), { ...OPTS, requireDiscount: true }).setups[0];
  assert.deepEqual([m.dir, m.reason], ['bear', 'order block not in premium']);
});

// ---- trade realism ----

test('spread: a buy fills at the ask and exits on the chart (bid) price', () => {
  const base = SMC.run(bars(), OPTS).setups[0].entry;
  const opts = { ...OPTS, spread: 0.25 };
  const e = SMC.run(bars(), opts).setups[0].entry;
  assert.ok(Math.abs(e.entry - 99.35) < 1e-9);
  assert.equal(e.sl, base.sl);
  assert.ok(Math.abs(e.risk - (e.entry - e.sl)) < 1e-9);
  assert.ok(Math.abs(e.tp - (e.entry + 2 * e.risk)) < 1e-9);
  // a bid high just short of the target is not a fill, even though the ask is past it
  const short = { 21: { h: e.tp - 0.01 }, 22: { h: e.tp - 0.01 }, 23: { h: e.tp - 0.01 } };
  assert.equal(SMC.run(bars(short), opts).setups[0].entry.outcome, null);
  const hit = SMC.run(bars({ 22: { h: e.tp } }), opts).setups[0].entry;
  assert.deepEqual([hit.outcome, hit.exitAt, hit.exitPrice], ['win', 22, e.tp]);
});

test('spread: a sell fills at the bid and exits when the ask (bid + spread) reaches SL or TP', () => {
  const opts = { ...OPTS, spread: 0.25 };
  const e = SMC.run(mirror(bars()), opts).setups[0].entry;
  assert.equal(e.dir, 'bear');
  assert.ok(Math.abs(e.entry - 100.9) < 1e-9);
  assert.ok(Math.abs(e.tp - (e.entry - 2 * e.risk)) < 1e-9);
  const run = edit => {
    const list = mirror(bars());
    for (const k in edit) Object.assign(list[k], edit[k]);
    return SMC.run(list, opts).setups[0].entry;
  };
  // the bid touching the target leaves the ask 0.25 short of it
  const flatAfter = { 21: { o: 100.9, h: 101, l: 100.5, c: 100.6 }, 22: { o: 100.6, h: 100.8, l: 100.5, c: 100.6 }, 23: { o: 100.6, h: 100.8, l: 100.5, c: 100.6 } };
  assert.equal(run({ ...flatAfter, 22: { o: 100.6, h: 100.8, l: e.tp, c: 100.6 } }).outcome, null);
  const tp = run({ ...flatAfter, 22: { o: 100.6, h: 100.8, l: e.tp - 0.25, c: 100.6 } });
  assert.deepEqual([tp.outcome, tp.exitAt], ['win', 22]);
  // and the ask reaches the stop 0.25 before the bid does
  assert.equal(run({ ...flatAfter, 21: { o: 100.9, h: e.sl - 0.26, l: 100.5, c: 100.6 } }).outcome, null);
  const sl = run({ ...flatAfter, 21: { o: 100.9, h: e.sl - 0.25, l: 100.5, c: 100.6 } });
  assert.deepEqual([sl.outcome, sl.exitAt, sl.exitPrice], ['loss', 21, e.sl]);
});

test('slMode sweep puts the stop beyond the sweep extreme', () => {
  // the order block (candle 14) is above the sweep low, so the two modes differ
  const ob = SMC.run(bars(PREMIUM_OB), OPTS);
  const sw = SMC.run(bars(PREMIUM_OB), { ...OPTS, slMode: 'sweep' });
  const buf = 0.1 * ob.atr[20];
  assert.ok(Math.abs(ob.setups[0].entry.sl - (97.8 - buf)) < 1e-9);   // below the pin bar low
  assert.ok(Math.abs(sw.setups[0].entry.sl - (97.2 - buf)) < 1e-9);   // below the sweep low
});

test('tpMode liquidity targets the nearest opposite level worth at least minRR', () => {
  const e = SMC.run(bars(), { ...OPTS, tpMode: 'liquidity' }).setups[0].entry;
  // the swing high at 102.3 (candle 17, confirmed on 20) is 1.57R away
  assert.deepEqual([e.tp, e.tpSrc], [102.3, 'Swing H']);
  assert.ok(Math.abs(e.rr - (102.3 - 99.1) / e.risk) < 1e-9);
  assert.deepEqual([e.outcome, e.exitAt, e.exitPrice], ['win', 23, 102.3]);

  const far = SMC.run(bars(), { ...OPTS, tpMode: 'liquidity', minRR: 2 }).setups[0].entry;
  assert.deepEqual([far.tpSrc, far.rr], ['rr', 2]);
  assert.ok(Math.abs(far.tp - (far.entry + 2 * far.risk)) < 1e-9);

  const m = SMC.run(mirror(bars()), { ...OPTS, tpMode: 'liquidity' }).setups[0].entry;
  assert.deepEqual([m.tp, m.tpSrc], [97.7, 'Swing L']);
});

test('tracks max favourable and adverse excursion in R until the exit', () => {
  const list = bars();
  const e = SMC.run(list, OPTS).setups[0].entry;
  // still open after candle 22: best high 102, worst low 99
  const open = SMC.run(list.slice(0, 23), OPTS).setups[0].entry;
  assert.equal(open.outcome, null);
  assert.ok(Math.abs(open.mfeR - (102 - 99.1) / e.risk) < 1e-9);
  assert.ok(Math.abs(open.maeR - (99.1 - 99) / e.risk) < 1e-9);
  // the target is hit on 23: MFE is the full 2R, and it stays frozen after the exit
  const more = list.concat([{ t: list[23].t + 300, o: 103.4, h: 110, l: 90, c: 100, v: 100 }]);
  const won = SMC.run(more, OPTS).setups[0].entry;
  assert.deepEqual([won.outcome, won.mfeR], ['win', 2]);
  assert.ok(Math.abs(won.maeR - open.maeR) < 1e-9);

  // a stop-out counts the full 1R against and ignores the rest of the exit candle
  const lost = SMC.run(bars({ 21: { o: 99.1, h: 101.5, l: 96.5, c: 97 } }), OPTS).setups[0].entry;
  assert.deepEqual([lost.outcome, lost.exitAt, lost.maeR, lost.mfeR], ['loss', 21, 1, 0]);
});

// ---- extra entry patterns and first touch ----

test('three pins: three candles rejecting the zone, the third closing up', () => {
  const pins = {
    18: { o: 99.2, h: 99.4, l: 97.9, c: 99.0 },
    19: { o: 99.0, h: 99.3, l: 97.8, c: 98.9 },
    20: { o: 98.9, h: 99.4, l: 97.8, c: 99.1 },
  };
  const opts = { ...OPTS, patterns: { pin: false, hs: false, threePins: true } };
  const [s] = SMC.run(bars(pins), opts).setups;
  assert.deepEqual([s.touchAt, s.entry.i, s.entry.patternFrom, s.entry.pattern], [18, 20, 18, 'Three pins']);
  assert.ok(Math.abs(s.entry.sl - (97.2 - 0.1 * SMC.run(bars(pins), opts).atr[20])) < 1e-9);
  const m = SMC.run(mirror(bars(pins)), opts).setups[0];
  assert.deepEqual([m.dir, m.entry.i, m.entry.pattern], ['bear', 20, 'Three pins']);
  // off by default
  assert.equal(SMC.run(bars(pins), { ...OPTS, patterns: { pin: false, hs: false } }).setups[0].entry, null);
  assert.equal(SMC.DEFAULTS.patterns.threePins, false);
});

test('engulfing: an up candle whose body engulfs a candle that touched the zone', () => {
  const eng = { 19: { o: 99.6, h: 99.7, l: 98.5, c: 98.8 }, 20: { o: 98.7, h: 99.9, l: 98.6, c: 99.8 } };
  const opts = { ...OPTS, patterns: { pin: false, hs: false, engulf: true } };
  const [s] = SMC.run(bars(eng), opts).setups;
  assert.deepEqual([s.entry.i, s.entry.patternFrom, s.entry.pattern, s.entry.entry], [20, 19, 'Engulfing', 99.8]);
  const m = SMC.run(mirror(bars(eng)), opts).setups[0];
  assert.deepEqual([m.dir, m.entry.i, m.entry.pattern], ['bear', 20, 'Engulfing']);
  assert.equal(SMC.run(bars(eng), { ...OPTS, patterns: { pin: false, hs: false } }).setups[0].entry, null);
  // a body that does not cover the previous body is not engulfing
  const small = { ...eng, 20: { o: 98.9, h: 99.9, l: 98.6, c: 99.5 } };
  assert.equal(SMC.run(bars(small), opts).setups[0].entry, null);
});

test('firstTouchOnly: only a pattern that includes the first touch counts', () => {
  // the textbook pin bar is the first touch
  assert.equal(SMC.run(bars(), { ...OPTS, firstTouchOnly: true }).setups[0].entry.i, 20);

  // candle 19 now dips into the OB without a pattern; the pin bar on 20 is a second touch
  const edit = { 19: { o: 100.2, h: 100.3, l: 98.8, c: 99.2 } };
  assert.equal(SMC.run(bars(edit), OPTS).setups[0].entry.i, 20);
  const pinOnly = SMC.run(bars(edit), { ...OPTS, firstTouchOnly: true, patterns: { hs: false } }).setups[0];
  assert.deepEqual([pinOnly.touchAt, pinOnly.endAt, pinOnly.reason, pinOnly.entry], [19, 19, 'first touch had no pattern', null]);
  // a head & shoulders on 19-21 starts with the first touch, so it still counts
  const hs = SMC.run(bars(edit), { ...OPTS, firstTouchOnly: true }).setups[0];
  assert.deepEqual([hs.entry.i, hs.entry.pattern, hs.entry.patternFrom], [21, 'Head & shoulders', 19]);
});
