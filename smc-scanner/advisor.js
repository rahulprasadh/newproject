/*
 * The trade plan at one candle: what to do now (buy, sell, hold or wait) and, for each side,
 * exactly what has to happen next, at which prices, by when, and what cancels it.
 *
 * It reads the engine's setups and liquidity levels as they were at candle c, never later:
 * a setup's stage, its sweep extreme and the open trades are all rebuilt for c, so the plan in
 * replay is the plan you would have had live. The projected entry, stop and target follow the
 * engine's own rules; the final numbers depend on the candle that confirms the entry.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMCAdvisor = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FRESH = 2;        // an entry up to this many candles old is still "now"
  const CHASE_R = 0.5;    // past this many R from the entry it is too late to follow it

  const PATTERN_NAMES = {
    pin: 'pin bar', hs: 'head & shoulders', threePins: 'three pins', engulf: 'engulfing candle',
    star: 'morning/evening star', piercing: 'piercing line / dark cloud', tweezer: 'tweezer',
    harami: 'harami', three: 'three inside/outside', doji: 'dragonfly/gravestone doji',
  };

  const defaultPrice = p => (Number.isFinite(p)
    ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–');
  const defaultTime = t => new Date(t * 1000).toISOString().slice(11, 16);

  function atrAt(B, c, n = 14) {
    let a = 0;
    for (let i = 0; i <= c; i++) {
      const b = B[i], p = B[i - 1];
      const tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
      a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    }
    return a;
  }

  const known = (k, c) => k !== null && k !== undefined && k <= c;

  // The setup's stage at candle c, or null when it is over by then.
  function stageAt(s, c) {
    if (s.sweepAt > c) return null;
    if (s.entry && s.entry.i <= c) return known(s.entry.exitAt, c) ? null : 'entered';
    if (known(s.endAt, c)) return null;
    if (known(s.armedAt, c)) return 'armed';
    if (known(s.chochAt, c)) return 'choch';
    return 'swept';
  }

  // The sweep extreme as it stood at c (the engine keeps moving it until the CHoCH).
  function extremeAt(B, s, c) {
    const last = Math.min(c, known(s.chochAt, c) ? s.chochAt : c), bull = s.dir === 'bull';
    let x = bull ? Infinity : -Infinity;
    for (let k = s.sweepAt; k <= last; k++) x = bull ? Math.min(x, B[k].l) : Math.max(x, B[k].h);
    return x;
  }

  const activeLevels = (levels, c) => (levels || []).filter(lv => lv.type === 'liq' && lv.at <= c && !known(lv.endAt, c));

  // The last structure swing (len candles each side) confirmed by c: the CHoCH level a new setup would use.
  function lastSwing(B, c, len, high) {
    const key = high ? 'h' : 'l';
    for (let p = c - len; p >= Math.max(len, c - 400); p--) {
      const v = B[p][key];
      let ok = true;
      for (let k = p - len; k <= p + len && ok; k++) {
        if (k === p) continue;
        const w = B[k][key];
        if (high ? (k < p ? w >= v : w > v) : (k < p ? w <= v : w < v)) ok = false;
      }
      if (ok) return { i: p, price: v };
    }
    return null;
  }

  function lots(entry, sl, risk) {
    if (!risk || !(risk.balance > 0) || !(risk.percent > 0)) return null;
    const rate = risk.usdRate > 0 ? risk.usdRate : 1, perLot = Math.abs(entry - sl) * (risk.contractSize || 100) * rate;
    if (!(perLot > 0)) return null;
    const step = risk.lotStep || 0.01, minLot = risk.minLot || 0.01;
    const n = Math.floor(risk.balance * risk.percent / 100 / perLot / step + 1e-9) * step;
    return { lots: +n.toFixed(2), amount: n * perLot, tooSmall: n < minLot - 1e-9, minLot, minAmount: minLot * perLot, currency: risk.currency || 'USD' };
  }

  // Time of candle k, also for candles that have not happened yet.
  const timeOf = (B, k, c, tfSec) => (k <= c ? B[k].t : B[c].t + (k - c) * tfSec);

  /*
   * The trade the engine would take from an armed setup, as far as it is known at c.
   * Entry where price first reaches the zone, stop beyond the order block (or the sweep),
   * target at rr or at the next liquidity level, as the engine does.
   */
  function project(s, { bars: B, c, opts, levels, atr, risk }) {
    const o = opts, bull = s.dir === 'bull';
    const zones = o.entryZone === 'ob' ? [s.obZone] : o.entryZone === 'fvg' ? [s.fvgZone] : [s.fvgZone, s.obZone];
    // the zone price reaches first: the higher one for a buy, the lower one for a sell
    const zone = zones.filter(Boolean).sort((a, b) => (bull ? b.top - a.top : a.bottom - b.bottom))[0];
    const A = atr !== undefined ? atr : atrAt(B, c);
    const buf = (o.slBufferAtr || 0) * A, spread = o.spread || 0;
    const extreme = extremeAt(B, s, c);
    const entry = bull ? zone.top + spread : zone.bottom;
    const far = o.slMode === 'sweep' ? extreme : (bull ? s.obZone.bottom : s.obZone.top);
    const sl = bull ? Math.min(far, s.obZone.bottom) - buf : Math.max(far, s.obZone.top) + buf;
    const risk1 = Math.abs(entry - sl);
    let tp = bull ? entry + (o.rr || 2) * risk1 : entry - (o.rr || 2) * risk1, rr = o.rr || 2, tpSrc = 'rr';
    if (o.tpMode === 'liquidity' && risk1 > 0) {
      let best = null;
      for (const lv of activeLevels(levels, c)) {
        if (lv.kind !== (bull ? 'high' : 'low')) continue;
        const r = (bull ? lv.price - entry : entry - lv.price) / risk1;
        if (r >= (o.minRR || 1.5) && (!best || r < best.r)) best = { lv, r };
      }
      if (best) { tp = best.lv.price; rr = best.r; tpSrc = best.lv.label; }
    }
    const floor = bull ? Math.min(s.obZone.bottom, extreme) : Math.max(s.obZone.top, extreme);
    // plain copies: the engine's zone objects gain an end later, which the plan at c must not show
    const copy = z => ({ kind: z.kind, top: z.top, bottom: z.bottom });
    return {
      zone: copy(zone), zones: zones.filter(Boolean).map(copy), entry, sl, tp, rr, tpSrc, risk: risk1, floor, extreme,
      size: lots(entry, sl, risk), inZone: known(s.touchAt, c),
      deadline: s.chochAt + (o.entryWithin || 40),
    };
  }

  function plan(input) {
    const {
      bars: B, setups = [], levels = [], c = B.length - 1, opts = {}, tfSec = 300, risk = null,
      odds = null, forecast = null, patterns = [], patternStats = null, patternHorizon = 6,
      price: fmtP = defaultPrice, time: fmtT = defaultTime,
    } = input;
    const bar = B[c], A = input.atr !== undefined ? input.atr : atrAt(B, c), price = bar.c;
    const out = {
      i: c, t: bar.t, price, atr: A, verdict: 'wait', headline: '', detail: '', trade: null,
      sides: {}, scenarios: [], candles: [], warnings: [],
    };
    const pats = Object.entries(opts.patterns || { pin: true, hs: true }).filter(([, on]) => on).map(([k]) => PATTERN_NAMES[k] || k);
    const patText = pats.length ? pats.join(', ') : 'an entry pattern';
    const zoneName = { ob: 'order block', fvg: 'FVG / IFVG', either: 'FVG or order block' }[opts.entryZone || 'ob'];
    const levelsNow = activeLevels(levels, c);
    const evR = (p, rr) => (p === null || p === undefined ? null : p * rr - (1 - p));
    const oddsOf = (s, rr) => {
      const q = odds ? odds(s) : null, w = q && q.pWinFromHere;
      if (!w || !w.n) return null;
      return { p: w.p, n: w.n, lo: w.lo, hi: w.hi, evR: evR(w.p, rr) };
    };

    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull', word = bull ? 'buy' : 'sell';
      const mine = setups.filter(s => s.dir === dir && stageAt(s, c));
      const trade = mine.filter(s => stageAt(s, c) === 'entered').sort((a, b) => b.entry.i - a.entry.i)[0] || null;
      const dev = mine.filter(s => stageAt(s, c) !== 'entered').sort((a, b) => b.sweepAt - a.sweepAt)[0] || null;
      const side = { dir, word, stage: 'none', setupId: null, grade: null, steps: [], next: '', cancel: '', deadline: null, projection: null, odds: null, trade: null };

      if (trade) {
        const e = trade.entry, nowR = (bull ? price - e.entry : e.entry - price) / e.risk;
        side.trade = {
          setupId: trade.id, entry: e.entry, sl: e.sl, tp: e.tp, rr: e.rr, risk: e.risk, i: e.i, t: B[e.i].t,
          pattern: e.pattern, zone: e.zone, grade: trade.grade || e.grade || null, nowR, age: c - e.i,
          size: lots(e.entry, e.sl, risk), odds: oddsOf(trade, e.rr),
        };
      }
      if (dev) {
        const st = stageAt(dev, c);
        side.stage = st;
        side.setupId = dev.id;
        side.grade = known(dev.armedAt, c) ? dev.grade || null : null;
        const lvName = `${dev.label || (bull ? 'sell-side liquidity' : 'buy-side liquidity')} ${fmtP(dev.level.price)}`;
        const extreme = extremeAt(B, dev, c);
        side.steps.push(`${bull ? 'Sell' : 'Buy'}-side liquidity swept: ${lvName} at ${fmtT(B[dev.sweepAt].t)}`);
        if (st === 'swept') {
          const last = dev.sweepAt + (opts.chochWithin || 30);
          side.deadline = timeOf(B, last, c, tfSec);
          side.next = dev.ref
            ? `a candle closing ${bull ? 'above' : 'below'} ${fmtP(dev.ref.price)} (CHoCH) by the ${fmtT(side.deadline)} candle`
            : 'a CHoCH (no swing to break yet)';
          side.cancel = `a close ${bull ? 'below' : 'above'} ${fmtP(dev.level.price)}`;
          side.levels = { choch: dev.ref ? dev.ref.price : null, swept: dev.level.price, extreme };
        } else if (st === 'choch') {
          const last = dev.chochAt + (opts.fvgWait === undefined ? 3 : opts.fvgWait);
          side.deadline = timeOf(B, last, c, tfSec);
          side.steps.push(`CHoCH: closed ${bull ? 'above' : 'below'} ${fmtP(dev.ref.price)} at ${fmtT(B[dev.chochAt].t)}`);
          const vol = opts.dispVolMult ? `, volume at least ${opts.dispVolMult}× average` : '';
          side.next = `a ${bull ? 'bullish' : 'bearish'} volume candle (body at least ${fmtP((opts.dispBodyAtr || 1.2) * A)}${vol}) that leaves an FVG, by the ${fmtT(side.deadline)} candle`;
          side.cancel = `a close ${bull ? 'below' : 'above'} the sweep ${bull ? 'low' : 'high'} ${fmtP(extreme)}`;
          side.levels = { choch: dev.ref.price, extreme };
        } else if (st === 'armed') {
          const pr = project(dev, { bars: B, c, opts, levels, atr: A, risk });
          side.projection = pr;
          side.deadline = timeOf(B, pr.deadline, c, tfSec);
          side.steps.push(`CHoCH: closed ${bull ? 'above' : 'below'} ${fmtP(dev.ref.price)} at ${fmtT(B[dev.chochAt].t)}`);
          side.steps.push(`Zones: ${dev.fvgZone.kind} ${fmtP(dev.fvgZone.bottom)} – ${fmtP(dev.fvgZone.top)}, OB ${fmtP(dev.obZone.bottom)} – ${fmtP(dev.obZone.top)}${side.grade ? ` · grade ${side.grade}` : ''}`);
          const where = `the ${zoneName} (${fmtP(pr.zone.bottom)} – ${fmtP(pr.zone.top)})`;
          side.next = pr.inZone
            ? `price is in ${where}: ${word} when a ${patText} closes there`
            : `price coming back to ${where}, ${fmtP(Math.abs(price - (bull ? pr.zone.top : pr.zone.bottom)))} away, then a ${patText}; by the ${fmtT(side.deadline)} candle`;
          side.cancel = `a close ${bull ? 'below' : 'above'} ${fmtP(pr.floor)}`;
          side.odds = oddsOf(dev, pr.rr);
        }
      } else {
        // nothing yet: which liquidity a sweep would take, and the swing a CHoCH would break
        const pool = levelsNow.filter(lv => lv.kind === (bull ? 'low' : 'high') && (bull ? lv.price < price : lv.price > price))
          .sort((a, b) => (bull ? b.price - a.price : a.price - b.price));
        const near = pool[0] || null, sw = lastSwing(B, c, opts.structLen || 3, bull);
        side.levels = { liquidity: near ? near.price : null, choch: sw ? sw.price : null };
        side.next = near
          ? `a sweep of ${bull ? 'sell' : 'buy'}-side liquidity: a candle wicking ${bull ? 'below' : 'above'} ${near.label || ''} ${fmtP(near.price)} (${(Math.abs(price - near.price) / A).toFixed(1)} ATR away) and closing back ${bull ? 'above' : 'below'} it${sw ? `, then a close ${bull ? 'above' : 'below'} about ${fmtP(sw.price)}` : ''}`
          : `a sweep of ${bull ? 'sell' : 'buy'}-side liquidity; none is marked ${bull ? 'below' : 'above'} price yet`;
        if (opts.killzones && opts.killzones.length) side.next += ` (sweeps count only in ${opts.killzones.join(', ')})`;
      }
      out.sides[word] = side;
    }

    // what to do now
    const { buy, sell } = out.sides;
    const fresh = [buy, sell].map(x => x.trade).filter(t => t && t.age <= FRESH && t.nowR < CHASE_R && t.nowR > -CHASE_R)
      .sort((a, b) => a.age - b.age)[0];
    const running = [buy, sell].map(x => x.trade).filter(Boolean).sort((a, b) => a.age - b.age)[0];
    const rank = { armed: 3, choch: 2, swept: 1, none: 0 };
    const lead = [buy, sell].sort((a, b) => rank[b.stage] - rank[a.stage])[0];
    if (fresh) {
      const s = fresh, w = s === buy.trade ? 'buy' : 'sell';
      out.verdict = w;
      out.trade = { ...s, dir: w === 'buy' ? 'bull' : 'bear' };
      out.headline = `${w.toUpperCase()} NOW at ${fmtP(s.entry)}`;
      out.detail = `${s.pattern} at the ${s.zone}${s.grade ? ` · grade ${s.grade}` : ''} · SL ${fmtP(s.sl)} · TP ${fmtP(s.tp)} (${+s.rr.toFixed(1)}R)`;
    } else if (running) {
      const s = running, w = s === buy.trade ? 'buy' : 'sell';
      out.verdict = 'hold';
      out.trade = { ...s, dir: w === 'buy' ? 'bull' : 'bear' };
      out.headline = `IN A ${w.toUpperCase()} from ${fmtP(s.entry)}`;
      const note = s.nowR >= CHASE_R ? 'too far from the entry to join now; wait for the next setup'
        : s.nowR <= -CHASE_R ? 'running against the entry; the stop decides'
          : 'still near the entry: joining now keeps the same stop and target';
      out.detail = `${s.nowR >= 0 ? '+' : ''}${s.nowR.toFixed(1)}R now · SL ${fmtP(s.sl)} · TP ${fmtP(s.tp)} · ${note}`;
    } else if (lead.stage === 'armed') {
      const pr = lead.projection;
      out.headline = `WAIT · ${lead.word} zone ready at ${fmtP(pr.zone.bottom)} – ${fmtP(pr.zone.top)}`;
      out.detail = `${lead.word === 'buy' ? 'Buy' : 'Sell'} only when a ${patText} closes in it. Planned: entry ≈ ${fmtP(pr.entry)}, SL ≈ ${fmtP(pr.sl)}, TP ≈ ${fmtP(pr.tp)} (${+pr.rr.toFixed(1)}R)`;
    } else if (lead.stage !== 'none') {
      out.headline = `WAIT · ${lead.word} setup forming`;
      out.detail = `Next: ${lead.next}`;
    } else {
      out.headline = 'WAIT · no setup';
      out.detail = 'A setup starts with a liquidity sweep. Below: what each side needs.';
    }
    if (buy.stage !== 'none' && sell.stage !== 'none') {
      out.warnings.push('Buy and sell setups are both forming: the market has no clear side. Waiting is a position too.');
    }
    if (out.verdict === 'buy' && sell.trade || out.verdict === 'sell' && buy.trade) {
      out.warnings.push('A trade the other way is still open from an earlier signal.');
    }

    // scenarios from the forecaster: which liquidity goes first, and what each would start
    const q = forecast && forecast.liquidity;
    if (q && q.above && q.below && q.pAboveFirst !== null && q.pAboveFirst !== undefined) {
      out.scenarios.push({
        dir: 'bear', p: q.pAboveFirst, confidence: q.confidence,
        text: `Buy-side ${q.above.label} ${fmtP(q.above.price)} taken first (${Math.round(100 * q.pAboveFirst)}%): a sweep there can start a SELL setup`,
      });
      out.scenarios.push({
        dir: 'bull', p: 1 - q.pAboveFirst, confidence: q.confidence,
        text: `Sell-side ${q.below.label} ${fmtP(q.below.price)} taken first (${Math.round(100 * (1 - q.pAboveFirst))}%): a sweep there can start a BUY setup`,
      });
      out.scenarios.sort((a, b) => b.p - a.p);
    }

    // what the last candles say, and how that pattern has done on this data
    const zoneSide = dir => {
      const s = out.sides[dir === 'bull' ? 'buy' : 'sell'];
      return s.stage === 'armed' && s.projection && s.projection.inZone;
    };
    for (const h of patterns) {
      const st = patternStats && patternStats[h.key];
      out.candles.push({
        ...h, atZone: h.dir !== 'neutral' && zoneSide(h.dir),
        stat: st && st.horizons && st.horizons[patternHorizon] ? { ...st.horizons[patternHorizon] } : null,
      });
    }
    return out;
  }

  return { plan, project, stageAt, extremeAt, lastSwing, lots, PATTERN_NAMES, FRESH, CHASE_R };
}));
