/*
 * SMC setup engine for one instrument on one timeframe.
 *
 * The model, bullish side (bearish is the mirror image):
 *   1. Liquidity sweep  a candle wicks below a liquidity level and closes back above it
 *   2. CHoCH            a close above the last swing high that formed before the sweep
 *   3. Volume candle    a large, high-volume candle in that move that leaves a fair value gap
 *                       (FVG), or closes through an older bearish FVG (inverse FVG, IFVG)
 *   4. Order block      the last bearish candle before the volume candle
 *   5. Entry            price comes back to the OB (or FVG) and prints a pin bar or a
 *                       3-candle head & shoulders reversal
 *
 * Liquidity comes from swing highs/lows, equal highs/lows (EQH/EQL), the previous
 * trading day's high/low (PDH/PDL) and the Asia, London and New York session highs/lows.
 * Optional filters: session killzones, higher-timeframe trend, sweep depth and
 * premium/discount of the order block. Spread, stop/target placement and the
 * max favourable/adverse excursion make the results closer to a real fill.
 *
 * Bars go in one at a time and the engine only reads bars it has already seen,
 * so history, replay and live data produce the same signals at the same bar.
 * Every event carries `at`, the index of the bar on which it became known.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMC = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    liqLen: 10,          // bars on each side of a swing that marks a liquidity level
    structLen: 3,        // bars on each side of a swing used as the CHoCH level
    maxLevelAge: 600,    // liquidity levels older than this many bars are dropped
    chochWithin: 30,     // the CHoCH has to come within this many bars of the sweep
    atrLen: 14,
    volLen: 20,          // volume is compared with the average of this many previous bars
    dispBodyAtr: 1.2,    // volume candle body is at least this many ATRs
    dispBodyPct: 0.55,   // and at least this share of the candle's range
    dispVolMult: 1.5,    // and its volume is at least this multiple of average (skipped if no volume)
    fvgMinAtr: 0.05,     // ignore gaps smaller than this many ATRs
    fvgWait: 3,          // bars after the CHoCH allowed for the FVG to finish forming
    ifvgLookback: 60,    // an FVG older than this many bars can no longer be inverted
    obLookback: 5,       // how far before the sweep candle to look for the order block
    entryZone: 'ob',     // where to wait for the entry: 'ob', 'fvg' or 'either'
    entryWithin: 40,     // bars after the CHoCH allowed for the retest and entry
    // 'Three pins' and 'Engulfing' are extra entry patterns, off unless switched on
    patterns: { pin: true, hs: true, threePins: false, engulf: false },
    pinWick: 2,          // pin bar rejection wick is at least this many times the body
    pinWickPct: 0.5,     // and at least this share of the candle's range
    firstTouchOnly: false, // only the first return to the zone may give the entry
    slBufferAtr: 0.1,    // stop goes this many ATRs beyond the order block or pattern low
    slMode: 'ob',        // stop beyond the 'ob' (and pattern) or beyond the 'sweep' extreme
    rr: 2,               // take profit in multiples of the risk
    tpMode: 'rr',        // 'rr' or 'liquidity': the nearest opposite level worth at least minRR
    minRR: 1.5,
    spread: 0,           // in price; buys fill at the ask (close + spread), sells exit at the ask

    liqSources: { swing: true, equal: true, prevDay: true, session: true },
    eqTolAtr: 0.1,       // levels this close (in ATRs) count as one pool of liquidity
    keyLevelDays: 3,     // previous-day and session levels stay active this many trading days
    killzones: [],       // sessions a sweep must happen in: 'asia', 'london', 'ny' (empty = any time)
    htfMinutes: 60,      // higher timeframe used for the trend (0 = off)
    htfLen: 2,           // HTF candles on each side of an HTF swing
    htfFilter: false,    // only take setups in the direction of the HTF trend
    minSweepAtr: 0,      // the wick has to go at least this many ATRs past the level
    requireDiscount: false, // buy OB in the lower half of the range, sell OB in the upper half
  };

  // Sessions in New York time, minutes after midnight [start, end).
  const SESSIONS = { asia: [1200, 1440], london: [120, 300], ny: [420, 600] };
  const SESSION_NAMES = { asia: 'Asia', london: 'London', ny: 'NY' };
  const SESSION_IDX = { asia: 0, london: 1, ny: 2 };
  // when one candle takes several levels the setup is named after the most significant
  const RANK = { swing: 0, equal: 1, session: 2, prevDay: 3 };

  function sessionOfMinute(m) {
    for (const k in SESSIONS) if (m >= SESSIONS[k][0] && m < SESSIONS[k][1]) return k;
    return 'off';
  }

  // New York clock without Intl. US daylight saving runs from 02:00 local on the 2nd Sunday
  // of March to 02:00 local on the 1st Sunday of November. A trading day starts at 17:00 New
  // York, so dayKey (days since 1970-01-01) is the New York date the trading day ends on.
  let dstYear = null;
  function nyTime(t) {
    if (!dstYear || t < dstYear.from || t >= dstYear.to) {
      const y = new Date(t * 1000).getUTCFullYear();
      const sunday = (month, n) => {
        const d1 = Date.UTC(y, month, 1) / 1000, wd = ((Math.floor(d1 / 86400) + 4) % 7 + 7) % 7;
        return d1 + ((7 - wd) % 7 + 7 * (n - 1)) * 86400;
      };
      dstYear = {
        from: Date.UTC(y, 0, 1) / 1000, to: Date.UTC(y + 1, 0, 1) / 1000,
        start: sunday(2, 2) + 7 * 3600,   // 02:00 EST
        end: sunday(10, 1) + 6 * 3600,    // 02:00 EDT
      };
    }
    const offsetMin = t >= dstYear.start && t < dstYear.end ? -240 : -300;
    const local = t + offsetMin * 60, day = Math.floor(local / 86400);
    const mins = Math.floor((local - day * 86400) / 60);
    return {
      offsetMin, hour: Math.floor(mins / 60), minute: mins % 60,
      weekday: ((day + 4) % 7 + 7) % 7,   // 0 = Sunday
      dayKey: Math.floor((local + 7 * 3600) / 86400),
      session: sessionOfMinute(mins),
    };
  }

  const sessionOf = t => nyTime(t).session;

  function isPivot(B, p, len, key) {
    const v = B[p][key], high = key === 'h';
    for (let k = p - len; k <= p + len; k++) {
      if (k === p) continue;
      const w = B[k][key];
      // ties on the left disqualify, ties on the right do not
      if (high ? (k < p ? w >= v : w > v) : (k < p ? w <= v : w < v)) return false;
    }
    return true;
  }

  class Engine {
    constructor(opts = {}) {
      this.o = {
        ...DEFAULTS, ...opts,
        patterns: { ...DEFAULTS.patterns, ...(opts.patterns || {}) },
        liqSources: { ...DEFAULTS.liqSources, ...(opts.liqSources || {}) },
      };
      const p = this.o.patterns;
      // how many candles the longest enabled pattern spans
      this._span = Math.max(p.pin ? 1 : 0, p.engulf ? 2 : 0, p.hs || p.threePins ? 3 : 0);
      this.bars = [];
      this.atr = [];
      this.volAvg = [];       // average volume of the previous volLen bars
      this.hasVolume = false;
      this.events = [];
      this.setups = [];
      this.levels = [];       // liquidity levels not yet taken
      this.swings = { high: [], low: [] };
      this.fvgs = [];         // FVGs that can still be inverted
      this.inverted = {};     // bar index -> FVGs a close on that bar inverted
      this.active = { bull: null, bear: null };
      this.open = [];         // entries waiting for TP or SL
      // closed higher-timeframe candles, the latest HTF swings and the trend they give
      this.htf = { bars: [], high: null, low: null, bias: null };
      this._htfCur = null;    // the HTF candle still forming (never used for the trend)
      this._ny = null;        // New York clock of the current bar
      this._day = null;       // high/low of the trading day so far
      this._sess = null;      // high/low of the session so far
      this._days = [];        // recent trading day keys
      this._cands = [];       // lone swings kept only to spot equal highs/lows when swing levels are off
      this._trSum = 0;
      this._vSum = 0;
      this._id = 0;
    }

    push(bar) {
      const i = this.bars.length;
      this.bars.push(bar);
      const out = [];
      this._ny = nyTime(bar.t);
      this._indicators(i);
      this._htfStep(i);
      this._timeLevels(i, out);
      this._swings(i, out);
      this._imbalances(i, out);
      this._outcomes(i);
      this._sweeps(i, out);
      this._advance('bull', i, out);
      this._advance('bear', i, out);
      for (const e of out) this.events.push(e);
      return out;
    }

    _indicators(i) {
      const b = this.bars[i], p = this.bars[i - 1], n = this.o.atrLen, m = this.o.volLen;
      const tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
      if (i < n) {
        this._trSum += tr;
        this.atr.push(this._trSum / (i + 1));
      } else {
        this.atr.push((this.atr[i - 1] * (n - 1) + tr) / n);
      }
      const v = b.v || 0;
      if (v > 0) this.hasVolume = true;
      this.volAvg.push(i === 0 ? v : this._vSum / Math.min(i, m));
      this._vSum += v;
      if (i >= m) this._vSum -= this.bars[i - m].v || 0;
    }

    _isPivot(p, len, key) {
      return isPivot(this.bars, p, len, key);
    }

    // Build HTF candles from the base candles. An HTF candle only counts once a base candle
    // of a later bucket arrives, so the trend never reads a candle that is still forming.
    _htfStep(i) {
      const m = this.o.htfMinutes;
      if (!(m > 0)) return;
      const b = this.bars[i], sec = m * 60, t = Math.floor(b.t / sec) * sec, H = this.htf;
      let cur = this._htfCur;
      if (cur && cur.t !== t) {
        cur.at = i;
        H.bars.push(cur);
        if (H.bars.length > 300) H.bars.shift();
        this._htfClosed();
        cur = null;
      }
      if (!cur) {
        this._htfCur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, at: null };
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v || 0;
      }
    }

    _htfClosed() {
      const H = this.htf, B = H.bars, n = this.o.htfLen, k = B.length - 1, p = k - n;
      if (p >= n) {
        if (isPivot(B, p, n, 'h')) H.high = { t: B[p].t, price: B[p].h, at: B[k].at };
        if (isPivot(B, p, n, 'l')) H.low = { t: B[p].t, price: B[p].l, at: B[k].at };
      }
      const c = B[k].c;
      if (H.high && c > H.high.price) H.bias = 'bull';
      else if (H.low && c < H.low.price) H.bias = 'bear';
    }

    // Previous-day and session highs/lows become levels on the first candle after the
    // day or session ends. They are known at that candle's open, so it may already sweep them.
    _timeLevels(i, out) {
      const b = this.bars[i], ny = this._ny, src = this.o.liqSources;
      const mins = ny.hour * 60 + ny.minute;
      const start = (key, from, name) =>
        ({ key, name, hi: b.h, hiI: i, lo: b.l, loI: i, partial: i === 0 && mins !== from });
      const track = acc => {
        if (b.h > acc.hi) { acc.hi = b.h; acc.hiI = i; }
        if (b.l < acc.lo) { acc.lo = b.l; acc.loI = i; }
      };

      const d = this._day;
      if (!d || d.key !== ny.dayKey) {
        if (d && !d.partial && src.prevDay) this._keyLevels(d, 'prevDay', 'PDH', 'PDL', i, out);
        this._days.push(ny.dayKey);
        if (this._days.length > 30) this._days.shift();
        // a day that is already under way on the first candle loaded is incomplete; gold reopens at 18:00
        this._day = start(ny.dayKey, mins === 18 * 60 ? mins : 17 * 60);
      } else {
        track(d);
      }

      const key = ny.session === 'off' ? null : ny.dayKey * 4 + SESSION_IDX[ny.session];
      if (this._sess && this._sess.key !== key) {
        const s = this._sess, nm = SESSION_NAMES[s.name];
        if (!s.partial && src.session) this._keyLevels(s, 'session', `${nm} H`, `${nm} L`, i, out);
        this._sess = null;
      }
      if (key !== null) {
        if (!this._sess) this._sess = start(key, SESSIONS[ny.session][0], ny.session);
        else track(this._sess);
      }
    }

    _keyLevels(acc, src, hiLabel, loLabel, i, out) {
      const day = this._ny.dayKey;
      this._addLevel({ type: 'liq', kind: 'high', i: acc.hiI, at: i, price: acc.hi, endAt: null, end: null, src, label: hiLabel, day }, i, out);
      this._addLevel({ type: 'liq', kind: 'low', i: acc.loI, at: i, price: acc.lo, endAt: null, end: null, src, label: loLabel, day }, i, out);
    }

    // Add a liquidity level, merging it with active levels of the same kind within
    // eqTolAtr x ATR so the same pool of orders is never counted twice.
    _addLevel(lv, i, out) {
      const o = this.o, src = o.liqSources, high = lv.kind === 'high';
      const tol = o.eqTolAtr * this.atr[i];
      const isNear = x => x.kind === lv.kind && Math.abs(x.price - lv.price) <= tol;
      const near = this.levels.filter(isNear);
      const nearC = this._cands.length ? this._cands.filter(isNear) : [];
      const further = (x, y) => (high ? x.price > y.price : x.price < y.price);
      // the most significant level wins; between equals the newest, so its label and lifetime are current
      let top = lv;
      for (const x of near.concat(nearC)) if (RANK[x.src] > RANK[top.src]) top = x;
      const drop = list => {
        for (const x of list) { x.endAt = i; x.end = 'merged'; }
        this.levels = this.levels.filter(x => !list.includes(x));
        if (nearC.length) this._cands = this._cands.filter(x => !nearC.includes(x));
      };

      if (RANK[top.src] >= RANK.session) {
        // a previous-day or session level absorbs weaker levels at the same price
        if (top !== lv) return;
        drop(near);
      } else if (src.equal && near.length + nearC.length) {
        // two or more swings at the same price: one EQH/EQL at the furthest of them
        const group = near.concat(nearC, [lv]);
        const touches = [...new Set(group.flatMap(x => x.touches || [x.i]))].sort((a, b) => a - b);
        let price = lv.price;
        for (const x of group) if (further(x, { price })) price = x.price;
        drop(near);
        lv = {
          type: 'liq', kind: lv.kind, i: touches[0], at: i, price, endAt: null, end: null,
          src: 'equal', label: high ? 'EQH' : 'EQL', touches,
        };
      } else if (lv.src === 'swing' && !src.swing) {
        if (src.equal) this._cands.push(lv);
        return;
      }
      this.levels.push(lv);
      out.push(lv);
    }

    _swings(i, out) {
      const { liqLen, structLen } = this.o, src = this.o.liqSources;
      for (const kind of ['high', 'low']) {
        const key = kind === 'high' ? 'h' : 'l';
        let p = i - liqLen;
        if ((src.swing || src.equal) && p >= liqLen && this._isPivot(p, liqLen, key)) {
          const label = kind === 'high' ? 'Swing H' : 'Swing L';
          this._addLevel({ type: 'liq', kind, i: p, at: i, price: this.bars[p][key], endAt: null, end: null, src: 'swing', label }, i, out);
        }
        p = i - structLen;
        if (p >= structLen && this._isPivot(p, structLen, key)) {
          const list = this.swings[kind];
          const sw = { type: 'swing', kind, i: p, at: i, price: this.bars[p][key] };
          list.push(sw);
          if (list.length > 200) list.shift();
          out.push(sw);
        }
      }
    }

    _imbalances(i, out) {
      const B = this.bars, b = B[i];
      // a close through the far side of an older FVG turns it into an inverse FVG
      this.fvgs = this.fvgs.filter(f => {
        if (i - f.i > this.o.ifvgLookback) return false;
        const through = f.dir === 'bear' ? b.c > f.top : b.c < f.bottom;
        if (!through) return true;
        f.invAt = i;
        (this.inverted[i] = this.inverted[i] || []).push(f);
        return false;
      });
      if (i % 500 === 0) {
        for (const k in this.inverted) if (k < i - 500) delete this.inverted[k];
      }
      if (i < 2) return;
      const a = B[i - 2], min = this.o.fvgMinAtr * this.atr[i - 1];
      let f = null;
      if (b.l - a.h > min) f = { dir: 'bull', top: b.l, bottom: a.h };
      else if (a.l - b.h > min) f = { dir: 'bear', top: a.l, bottom: b.h };
      if (!f) return;
      Object.assign(f, { type: 'fvg', i: i - 1, at: i, invAt: null });
      this.fvgs.push(f);
      out.push(f);
    }

    _outcomes(i) {
      const b = this.bars[i], sp = this.o.spread;
      this.open = this.open.filter(e => {
        const bull = e.dir === 'bull';
        // chart prices are bids: buys exit on them, sells exit on the ask (bid + spread)
        const hi = bull ? b.h : b.h + sp, lo = bull ? b.l : b.l + sp;
        const hitSl = bull ? lo <= e.sl : hi >= e.sl;
        const hitTp = bull ? hi >= e.tp : lo <= e.tp;
        const fav = (bull ? hi - e.entry : e.entry - lo) / e.risk;
        const adv = (bull ? e.entry - lo : hi - e.entry) / e.risk;
        if (!hitSl && !hitTp) {
          e.mfeR = Math.max(e.mfeR, fav);
          e.maeR = Math.max(e.maeR, adv);
          return true;
        }
        // when one candle touches both we cannot tell which came first, so count it as a loss;
        // on the exit candle assume the worse order for the excursions too
        e.outcome = hitSl ? 'loss' : 'win';
        e.exitAt = i;
        e.exitPrice = hitSl ? e.sl : e.tp;
        if (hitSl) e.maeR = 1;
        else { e.mfeR = e.rr; e.maeR = Math.max(e.maeR, adv); }
        return false;
      });
    }

    _sweeps(i, out) {
      const b = this.bars[i], maxAge = this.o.maxLevelAge;
      const kd = Math.max(1, this.o.keyLevelDays), D = this._days;
      const minDay = D.length >= kd ? D[D.length - kd] : -Infinity;
      const swept = { bull: null, bear: null };
      // a new swing level cannot be swept by the candle that confirms it (that candle is
      // inside the swing), while day and session levels can be swept on their first candle
      this.levels = this.levels.filter(lv => {
        const age = i - (lv.touches ? lv.touches[lv.touches.length - 1] : lv.i);
        if (lv.day !== undefined ? lv.day < minDay : age > maxAge) {
          lv.endAt = i;
          lv.end = 'expired';
          return false;
        }
        const low = lv.kind === 'low';
        if (low ? b.l >= lv.price : b.h <= lv.price) return true;
        lv.endAt = i;
        if (low ? b.c > lv.price : b.c < lv.price) {
          lv.end = 'swept';
          const dir = low ? 'bull' : 'bear', cur = swept[dir];
          // one candle can take several levels: the most significant names the sweep, then the furthest
          const d = cur ? RANK[lv.src] - RANK[cur.src] : 1;
          if (d > 0 || (d === 0 && (low ? lv.price < cur.price : lv.price > cur.price))) swept[dir] = lv;
        } else {
          lv.end = 'broken';
        }
        return false;
      });
      if (this._cands.length) {
        this._cands = this._cands.filter(c => i - c.i <= maxAge && (c.kind === 'low' ? b.l >= c.price : b.h <= c.price));
      }
      for (const dir of ['bull', 'bear']) if (swept[dir]) this._start(dir, i, swept[dir], out);
    }

    _start(dir, i, level, out) {
      const o = this.o, bull = dir === 'bull', b = this.bars[i], session = this._ny.session;
      if (o.killzones && o.killzones.length && !o.killzones.includes(session)) return;
      // depth is measured against the ATR before the sweep candle so the sweep does not inflate it
      const atr = this.atr[Math.max(0, i - 1)];
      const depthAtr = atr > 0 ? Math.abs(level.price - (bull ? b.l : b.h)) / atr : 0;
      if (depthAtr < o.minSweepAtr) return;
      const cur = this.active[dir];
      if (cur && cur.stage !== 'swept') return;
      if (cur) this._finish(cur, i, 'replaced by a newer sweep');
      const refs = this.swings[bull ? 'high' : 'low'];
      let ref = null;
      for (let k = refs.length - 1; k >= 0; k--) {
        if (refs[k].i < i) { ref = refs[k]; break; }
      }
      const htfBias = this.htf.bias;
      const s = {
        id: ++this._id, dir, stage: 'swept', level, ref,
        src: level.src, label: level.label, session, htfBias, aligned: htfBias === dir, depthAtr,
        extreme: bull ? b.l : b.h,
        sweepAt: i, chochAt: null, armedAt: null, touchAt: null,
        disp: null, fvgZone: null, obZone: null, obPd: null, entry: null,
        endAt: null, reason: null,
      };
      this.setups.push(s);
      this.active[dir] = s;
      out.push({
        type: 'sweep', dir, i, at: i, price: level.price, levelIdx: level.i, setupId: s.id,
        src: level.src, label: level.label, depthAtr, session, htfBias,
      });
      if (!ref) this._finish(s, i, 'no earlier swing to break for a CHoCH');
      else if (o.htfFilter && !s.aligned) this._finish(s, i, 'against the higher-timeframe trend');
    }

    _finish(s, i, reason) {
      s.endAt = i;
      s.reason = reason;
      for (const z of [s.fvgZone, s.obZone]) if (z) z.endAt = i;
      if (this.active[s.dir] === s) this.active[s.dir] = null;
    }

    _advance(dir, i, out) {
      const s = this.active[dir];
      if (!s) return;
      const o = this.o, b = this.bars[i], bull = dir === 'bull';

      if (s.stage === 'swept') {
        s.extreme = bull ? Math.min(s.extreme, b.l) : Math.max(s.extreme, b.h);
        if (bull ? b.c < s.level.price : b.c > s.level.price) {
          return this._finish(s, i, 'closed back through the swept level');
        }
        if (!(bull ? b.c > s.ref.price : b.c < s.ref.price)) {
          if (i - s.sweepAt >= o.chochWithin) this._finish(s, i, `no CHoCH within ${o.chochWithin} bars`);
          return;
        }
        s.stage = 'choch';
        s.chochAt = i;
        out.push({ type: 'choch', dir, i, at: i, price: s.ref.price, fromIdx: s.ref.i, setupId: s.id });
      }

      if (s.stage === 'choch') {
        if (bull ? b.c < s.extreme : b.c > s.extreme) {
          return this._finish(s, i, 'closed beyond the sweep extreme');
        }
        if (!this._arm(s, i, out) && i - s.chochAt >= o.fvgWait) {
          this._finish(s, i, 'no volume candle with an FVG or IFVG');
        }
        // the retest has to come on a later bar than the one that finished the zones
        return;
      }

      if (s.stage === 'armed') {
        const floor = bull ? Math.min(s.obZone.bottom, s.extreme) : Math.max(s.obZone.top, s.extreme);
        if (bull ? b.c < floor : b.c > floor) return this._finish(s, i, 'closed through the order block');
        if (i - s.chochAt > o.entryWithin) return this._finish(s, i, `no entry within ${o.entryWithin} bars of the CHoCH`);
        const zones = o.entryZone === 'ob' ? [s.obZone]
          : o.entryZone === 'fvg' ? [s.fvgZone]
          : [s.fvgZone, s.obZone];
        for (const z of zones) {
          if (s.touchAt === null && (bull ? b.l <= z.top : b.h >= z.bottom)) s.touchAt = i;
          const pat = this._confirm(s, i, z);
          if (pat) return this._enter(s, i, z, pat, out);
        }
        // no pattern that includes the first touch can still complete
        if (o.firstTouchOnly && s.touchAt !== null && i - s.touchAt >= this._span - 1) {
          this._finish(s, i, 'first touch had no pattern');
        }
      }
    }

    // Find the volume candle between the sweep and now that left an FVG or inverted one,
    // then the order block before it. Returns true once the setup has its zones.
    _arm(s, i, out) {
      const B = this.bars, o = this.o, bull = s.dir === 'bull';
      let best = null;
      for (let d = Math.max(1, s.sweepAt); d <= i; d++) {
        const c = B[d], body = Math.abs(c.c - c.o), range = c.h - c.l;
        if (bull ? c.c <= c.o : c.c >= c.o) continue;
        if (body < o.dispBodyAtr * this.atr[d - 1] || body < o.dispBodyPct * range) continue;
        const volX = this.volAvg[d] > 0 ? c.v / this.volAvg[d] : null;
        if (this.hasVolume && !(volX >= o.dispVolMult)) continue;
        let zone = null;
        if (d + 1 <= i) {
          const a = B[d - 1], n = B[d + 1];
          if (bull ? n.l > a.h : n.h < a.l) {
            zone = { kind: 'FVG', i: d - 1, top: bull ? n.l : a.l, bottom: bull ? a.h : n.h };
          }
        }
        if (!zone) {
          const inv = (this.inverted[d] || []).filter(f => f.dir !== s.dir && f.i < d);
          if (inv.length) {
            const f = inv[inv.length - 1];
            zone = { kind: 'IFVG', i: f.i, top: f.top, bottom: f.bottom };
          }
        }
        if (zone && (!best || body > best.body)) best = { d, body, volX, zone };
      }
      if (!best) return false;

      // order block: the last opposite-colour candle before the volume candle
      let ob = null;
      for (let k = best.d - 1; k >= Math.max(0, s.sweepAt - o.obLookback); k--) {
        const c = B[k];
        if (bull ? c.c < c.o : c.c > c.o) { ob = k; break; }
      }
      if (ob === null) ob = s.sweepAt;

      const zoneEvt = (kind, i0, top, bottom) =>
        ({ type: 'zone', kind, dir: s.dir, i: i0, at: i, top, bottom, endAt: null, setupId: s.id });
      s.disp = { i: best.d, volX: best.volX };
      s.fvgZone = zoneEvt(best.zone.kind, best.zone.i, best.zone.top, best.zone.bottom);
      s.obZone = zoneEvt('OB', ob, B[ob].h, B[ob].l);
      // where the OB middle sits in the sweep-to-CHoCH range: 0 at the sweep extreme, 1 at the CHoCH level
      const mid = (B[ob].h + B[ob].l) / 2, span = Math.abs(s.ref.price - s.extreme);
      s.obPd = span > 0 ? (bull ? mid - s.extreme : s.extreme - mid) / span : null;
      s.stage = 'armed';
      s.armedAt = i;
      out.push({ type: 'disp', dir: s.dir, i: best.d, at: i, volX: best.volX, setupId: s.id });
      out.push(s.fvgZone, s.obZone);
      if (o.requireDiscount && !(s.obPd <= 0.5)) {
        this._finish(s, i, bull ? 'order block not in discount' : 'order block not in premium');
      }
      return true;
    }

    _confirm(s, i, z) {
      if (i <= s.armedAt) return null;
      const B = this.bars, b = B[i], o = this.o, bull = s.dir === 'bull';
      const reached = x => (bull ? x <= z.top : x >= z.bottom);
      const holds = c => (bull ? c >= z.bottom : c <= z.top);
      const turns = c => (bull ? c.c > c.o : c.c < c.o);
      // with firstTouchOnly the pattern has to include the first candle that touched the zone
      const ok = from => !o.firstTouchOnly || from <= s.touchAt;
      const body = Math.abs(b.c - b.o), range = b.h - b.l;

      if (o.patterns.pin && range > 0 && ok(i)) {
        const tip = bull ? b.l : b.h;
        const wick = bull ? Math.min(b.o, b.c) - b.l : b.h - Math.max(b.o, b.c);
        if (reached(tip) && holds(b.c) && wick >= o.pinWick * Math.max(body, 0.05 * range) && wick >= o.pinWickPct * range) {
          return { name: 'Pin bar', tip, from: i };
        }
      }
      if (o.patterns.hs && i - 1 > s.armedAt && ok(i - 2)) {
        const left = B[i - 2], mid = B[i - 1];
        const head = bull ? mid.l : mid.h;
        const isHead = bull ? head < left.l && head < b.l : head > left.h && head > b.h;
        const turnsPast = bull
          ? b.c > b.o && b.c > Math.max(mid.o, mid.c)
          : b.c < b.o && b.c < Math.min(mid.o, mid.c);
        if (isHead && turnsPast && reached(head) && holds(b.c)) {
          return { name: 'Head & shoulders', tip: head, from: i - 2 };
        }
      }
      if (o.patterns.threePins && i - 2 > s.armedAt && ok(i - 2)) {
        const three = [B[i - 2], B[i - 1], b];
        const rejects = c => {
          const r = c.h - c.l, wick = bull ? Math.min(c.o, c.c) - c.l : c.h - Math.max(c.o, c.c);
          return r > 0 && reached(bull ? c.l : c.h) && wick >= o.pinWickPct * r;
        };
        if (three.every(rejects) && turns(b) && holds(b.c)) {
          const tip = bull ? Math.min(...three.map(c => c.l)) : Math.max(...three.map(c => c.h));
          return { name: 'Three pins', tip, from: i - 2 };
        }
      }
      if (o.patterns.engulf && i - 1 > s.armedAt && ok(i - 1)) {
        const p = B[i - 1];
        const engulfs = Math.max(b.o, b.c) >= Math.max(p.o, p.c) && Math.min(b.o, b.c) <= Math.min(p.o, p.c)
          && body > Math.abs(p.c - p.o);
        if (turns(b) && engulfs && reached(bull ? p.l : p.h) && holds(b.c)) {
          return { name: 'Engulfing', tip: bull ? Math.min(p.l, b.l) : Math.max(p.h, b.h), from: i - 1 };
        }
      }
      return null;
    }

    _enter(s, i, z, pat, out) {
      const b = this.bars[i], bull = s.dir === 'bull', o = this.o;
      const buf = o.slBufferAtr * this.atr[i];
      const far = o.slMode === 'sweep' ? s.extreme : pat.tip;
      const sl = bull ? Math.min(far, pat.tip, s.obZone.bottom) - buf : Math.max(far, pat.tip, s.obZone.top) + buf;
      // chart prices are bids: a buy fills at the ask, a sell at the bid
      const entry = bull ? b.c + o.spread : b.c, risk = Math.abs(entry - sl);
      let tp = bull ? entry + o.rr * risk : entry - o.rr * risk, rr = o.rr, tpSrc = 'rr';
      if (o.tpMode === 'liquidity') {
        let best = null;
        for (const lv of this.levels) {
          if (lv.kind !== (bull ? 'high' : 'low')) continue;
          const r = (bull ? lv.price - entry : entry - lv.price) / risk;
          if (r >= o.minRR && (!best || r < best.r)) best = { lv, r };
        }
        if (best) { tp = best.lv.price; rr = best.r; tpSrc = best.lv.label; }
      }
      const e = {
        type: 'entry', dir: s.dir, i, at: i, patternFrom: pat.from, entry, sl, tp, risk, rr,
        pattern: pat.name, zone: z.kind, setupId: s.id, session: this._ny.session, tpSrc,
        outcome: null, exitAt: null, exitPrice: null, mfeR: 0, maeR: 0,
      };
      out.push(e);
      this.open.push(e);
      s.entry = e;
      s.stage = 'entered';
      this._finish(s, i, 'entry');
    }

    summary() {
      const S = this.setups, has = k => S.filter(s => s[k] !== null).length;
      const entries = S.filter(s => s.entry).map(s => s.entry);
      const wins = entries.filter(e => e.outcome === 'win').length;
      const losses = entries.filter(e => e.outcome === 'loss').length;
      const tally = keys => Object.fromEntries(keys.map(k => [k, { entries: 0, wins: 0, losses: 0 }]));
      const bySession = tally(['asia', 'london', 'ny', 'off']);
      const bySrc = tally(Object.keys(RANK));
      for (const s of S) {
        if (!s.entry) continue;
        for (const t of [bySession[s.entry.session], bySrc[s.src]]) {
          t.entries++;
          if (s.entry.outcome === 'win') t.wins++;
          if (s.entry.outcome === 'loss') t.losses++;
        }
      }
      return {
        sweeps: S.length, choch: has('chochAt'), armed: has('armedAt'), touched: has('touchAt'),
        entries: entries.length, wins, losses, open: entries.length - wins - losses,
        winRate: wins + losses ? wins / (wins + losses) : null,
        netR: entries.reduce((r, e) => r + (e.outcome === 'win' ? e.rr : e.outcome === 'loss' ? -1 : 0), 0),
        bySession, bySrc,
      };
    }
  }

  function run(bars, opts) {
    const e = new Engine(opts);
    for (const b of bars) e.push(b);
    return e;
  }

  // Combine candles into a higher timeframe on UTC-aligned buckets, e.g. 5m -> 15m.
  function resample(bars, tfSec) {
    const out = [];
    let cur = null;
    for (const b of bars) {
      const t = Math.floor(b.t / tfSec) * tfSec;
      if (!cur || cur.t !== t) {
        cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 };
        out.push(cur);
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v || 0;
      }
    }
    return out;
  }

  function detectTimeframe(bars) {
    const d = [];
    for (let k = 1; k < Math.min(bars.length, 500); k++) d.push(bars[k].t - bars[k - 1].t);
    d.sort((a, b) => a - b);
    return d.length ? d[d.length >> 1] : 0;
  }

  // Parse a candle CSV from TradingView, MetaTrader, Dukascopy or similar.
  // tzOffsetMin is the file's time zone for timestamps that carry none (MT5 server time is often +180).
  function parseCSV(text, tzOffsetMin = 0) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) throw new Error('The file is empty.');
    const delim = [',', '\t', ';'].reduce((a, b) => (lines[0].split(b).length > lines[0].split(a).length ? b : a));
    const cell = s => s.trim().replace(/^"|"$/g, '').replace(/^<|>$/g, '');
    const first = lines[0].split(delim).map(cell);
    const hasHeader = first.some(h => /^[a-z_ ]+$/i.test(h));
    let cols;
    if (hasHeader) {
      const names = first.map(h => h.toLowerCase().replace(/[_ ]+/g, ''));
      const find = (...keys) => {
        for (const k of keys) {
          const idx = names.indexOf(k);
          if (idx >= 0) return idx;
        }
        return -1;
      };
      cols = {
        date: find('datetime', 'date', 'timestamp', 'time', 'gmttime', 'localtime', 'opentime', 't'),
        time: -1,
        o: find('open', 'o'), h: find('high', 'h'), l: find('low', 'l'), c: find('close', 'c'),
        v: find('tickvolume', 'tickvol', 'volume', 'vol', 'realvolume', 'v'),
      };
      if (names[cols.date] === 'date' && find('time') >= 0) cols.time = find('time');
      if ([cols.date, cols.o, cols.h, cols.l, cols.c].some(x => x < 0)) {
        throw new Error('Could not find time, open, high, low and close columns in the header.');
      }
    } else {
      const twoPart = /:/.test(first[1] || '');
      const s = twoPart ? 2 : 1;
      cols = { date: 0, time: twoPart ? 1 : -1, o: s, h: s + 1, l: s + 2, c: s + 3, v: first.length > s + 4 ? s + 4 : -1 };
    }

    const parseTime = (d, t) => {
      const raw = t ? `${d} ${t}` : d;
      if (/^\d+(\.\d+)?$/.test(raw)) {
        const n = Number(raw);
        return n > 1e12 ? Math.floor(n / 1000) : n;
      }
      let s = raw.trim();
      let m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(.*)$/);   // dd.mm.yyyy or mm/dd/yyyy
      if (m) {
        const slash = s.includes('/');
        const [dd, mm] = slash ? [m[2], m[1]] : [m[1], m[2]];
        s = `${m[3]}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}${m[4]}`;
      }
      s = s.replace(/^(\d{4})[./](\d{2})[./](\d{2})/, '$1-$2-$3').replace(/\s+GMT.*$/i, '').replace(' ', 'T');
      const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
      const ms = Date.parse(zoned ? s : s + 'Z');
      if (Number.isNaN(ms)) return NaN;
      return Math.floor(ms / 1000) - (zoned ? 0 : tzOffsetMin * 60);
    };

    const bars = [];
    for (let k = hasHeader ? 1 : 0; k < lines.length; k++) {
      const f = lines[k].split(delim).map(cell);
      const t = parseTime(f[cols.date], cols.time >= 0 ? f[cols.time] : '');
      const b = { t, o: +f[cols.o], h: +f[cols.h], l: +f[cols.l], c: +f[cols.c], v: cols.v >= 0 ? +f[cols.v] || 0 : 0 };
      if ([b.t, b.o, b.h, b.l, b.c].some(x => !Number.isFinite(x))) continue;
      if (b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) continue;
      bars.push(b);
    }
    if (!bars.length) throw new Error('No valid candles found. Check that the file has time, open, high, low, close columns.');
    bars.sort((a, b) => a.t - b.t);
    return bars.filter((b, k) => k === 0 || b.t !== bars[k - 1].t);
  }

  return { Engine, DEFAULTS, SESSIONS, run, resample, detectTimeframe, parseCSV, nyTime, sessionOf };
}));
