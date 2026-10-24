// Run with: node --test smc-scanner/test/*.test.js
// The trade plan: buy / sell / hold / wait at every candle of a hand-built setup, the projected
// trade against the engine's real one, and no look-ahead.
const test = require('node:test');
const assert = require('node:assert/strict');
const SMC = require('../engine.js');
const ADV = require('../advisor.js');

// the engine tests' textbook: swing low 98.0 at 5, lower high 101.0 at 8, sweep at 13,
// CHoCH and volume candle at 15 (zones known at 16), pin bar entry at 20, target hit at 23
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
const OPTS = { ...SMC.DEFAULTS, liqLen: 3, structLen: 2, atrLen: 5, volLen: 5, liqSources: { swing: true, equal: false, prevDay: false, session: false } };
const bars = () => ROWS.map(([o, h, l, c], k) => ({ t: 1790000000 + k * 300, o, h, l, c, v: k === 15 ? 400 : k === 13 ? 150 : 100 }));
const mirror = list => list.map(b => ({ ...b, o: 200 - b.o, c: 200 - b.c, h: 200 - b.l, l: 200 - b.h }));
const fmt = p => p.toFixed(2);

function planAt(E, c, extra = {}) {
  return ADV.plan({
    bars: E.bars, setups: E.setups, levels: E.events.filter(e => e.type === 'liq'), c, opts: E.o, tfSec: 300,
    price: fmt, time: t => String((t - 1790000000) / 300), ...extra,
  });
}

test('the plan follows the setup step by step: wait, forming, zone ready, BUY NOW, in a trade', () => {
  const E = SMC.run(bars(), OPTS);
  const s = E.setups.find(x => x.entry);

  let p = planAt(E, 12);
  assert.equal(p.verdict, 'wait');
  assert.equal(p.headline, 'WAIT · no setup');
  assert.equal(p.sides.buy.stage, 'none');
  assert.equal(p.sides.buy.levels.liquidity, 98, 'the swing low a sweep would take');
  assert.match(p.sides.buy.next, /wicking below Swing L 98\.00/);

  p = planAt(E, 13);
  assert.equal(p.sides.buy.stage, 'swept');
  assert.equal(p.headline, 'WAIT · buy setup forming');
  assert.match(p.sides.buy.next, /closing above 101\.00 \(CHoCH\) by the 43 candle/, 'CHoCH within 30 candles of the sweep at 13');
  assert.equal(p.sides.buy.cancel, 'a close below 98.00');

  p = planAt(E, 15);
  assert.equal(p.sides.buy.stage, 'choch', 'the zones are only known on the next candle');
  assert.match(p.sides.buy.next, /volume candle .* by the 18 candle/);
  assert.match(p.sides.buy.cancel, /below the sweep low 97\.20/);

  p = planAt(E, 19);
  assert.equal(p.sides.buy.stage, 'armed');
  const pr = p.sides.buy.projection;
  assert.deepEqual([pr.zone.bottom, pr.zone.top], [97.2, 98.9]);
  assert.equal(pr.entry, 98.9);
  assert.ok(Math.abs(pr.sl - s.entry.sl) < 0.05, `projected stop ${pr.sl} vs the engine's ${s.entry.sl}`);
  assert.ok(Math.abs(pr.tp - (pr.entry + 2 * (pr.entry - pr.sl))) < 1e-9);
  assert.equal(pr.inZone, false);
  assert.equal(p.headline, 'WAIT · buy zone ready at 97.20 – 98.90');
  assert.match(p.detail, /Buy only when a pin bar, head & shoulders closes in it\. Planned: entry ≈ 98\.90/);
  assert.equal(p.sides.buy.cancel, 'a close below 97.20');

  p = planAt(E, 20);
  assert.equal(p.verdict, 'buy');
  assert.equal(p.headline, 'BUY NOW at 99.10');
  assert.match(p.detail, /^Pin bar at the OB · grade [ABC+]+ · SL 97\.\d\d · TP 1\d\d\.\d\d \(2R\)$/);
  assert.equal(p.trade.entry, s.entry.entry);
  assert.equal(p.trade.sl, s.entry.sl);

  p = planAt(E, 22);
  assert.equal(p.verdict, 'hold', 'over 0.5R past the entry: too late to chase');
  assert.match(p.headline, /^IN A BUY from 99\.10$/);
  assert.match(p.detail, /^\+1\.\dR now/);

  p = planAt(E, 23);
  assert.equal(p.verdict, 'wait', 'the target was hit: no trade left');
  assert.equal(p.trade, null);
});

test('the mirror image gives SELL NOW with the same numbers turned over', () => {
  const E = SMC.run(mirror(bars()), OPTS);
  const p = planAt(E, 20);
  assert.equal(p.verdict, 'sell');
  assert.equal(p.headline, 'SELL NOW at 100.90');
  const z = planAt(E, 19).sides.sell.projection;
  assert.deepEqual([z.zone.bottom, z.zone.top], [101.1, 102.8]);
  assert.equal(z.entry, 101.1);
  assert.ok(z.sl > 102.8);
});

test('no look-ahead: the plan from the full run equals the plan from a run that stops at the candle', () => {
  const B = bars(), full = SMC.run(B, OPTS);
  const strip = p => JSON.stringify({ ...p, sides: Object.fromEntries(Object.entries(p.sides).map(([k, v]) => [k, { ...v, setupId: undefined }])) });
  for (let c = 9; c < B.length; c++) {
    const part = SMC.run(B.slice(0, c + 1), OPTS);
    assert.equal(strip(planAt(full, c)), strip(planAt(part, c)), `candle ${c}`);
  }
});

test('odds, lot size, scenarios and the candle reading', () => {
  const E = SMC.run(bars(), OPTS);
  const p = planAt(E, 19, {
    risk: { balance: 10000, percent: 1 },
    odds: () => ({ pWinFromHere: { p: 0.4, n: 50, lo: 0.27, hi: 0.54 } }),
    forecast: { liquidity: { above: { label: 'Swing H', price: 102.3 }, below: { label: 'EQL', price: 97 }, pAboveFirst: 0.3, confidence: 'low' } },
    patterns: [{ key: 'bullPin', name: 'Bullish pin bar', dir: 'bull', stars: 2 }],
    patternStats: { bullPin: { horizons: { 6: { n: 80, p: 0.55, base: 0.5, verdict: 'same' } } } },
  });
  const o = p.sides.buy.odds;
  assert.equal(o.n, 50);
  assert.ok(Math.abs(o.evR - (0.4 * 2 - 0.6)) < 1e-9, 'expected R = p × reward − (1 − p)');
  const size = p.sides.buy.projection.size;
  assert.ok(size.lots > 0 && size.amount <= 100.0001, 'never more than 1% of 10,000');
  assert.equal(p.scenarios[0].dir, 'bull', 'the more likely scenario first');
  assert.match(p.scenarios[0].text, /^Sell-side EQL 97\.00 taken first \(70%\): a sweep there can start a BUY setup$/);
  assert.equal(p.candles[0].stat.p, 0.55);
  assert.equal(p.candles[0].atZone, false, 'price is not in the zone at 19');
});

test('on the sample: a plan at every 25th candle, always a verdict, levels that make sense', () => {
  const { loadSample } = require('../live/sources.js');
  const B = loadSample().bars.slice(0, 8000);
  const E = SMC.run(B, { spread: 0.25 });
  const levels = E.events.filter(e => e.type === 'liq');
  const seen = new Set();
  for (let c = 200; c < B.length; c += 25) {
    const p = ADV.plan({ bars: B, setups: E.setups, levels, c, opts: E.o });
    assert.ok(['buy', 'sell', 'hold', 'wait'].includes(p.verdict));
    assert.ok(p.headline.length > 0);
    seen.add(p.verdict);
    for (const side of [p.sides.buy, p.sides.sell]) {
      const pr = side.projection;
      if (!pr) continue;
      if (side.dir === 'bull') assert.ok(pr.sl < pr.entry && pr.entry < pr.tp, `buy levels in order at ${c}`);
      else assert.ok(pr.tp < pr.entry && pr.entry < pr.sl, `sell levels in order at ${c}`);
    }
  }
  assert.ok(seen.has('wait'));
});
