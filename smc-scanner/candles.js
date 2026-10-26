/*
 * Candlestick patterns for intraday gold, with the rules spelled out and a way to measure how
 * each one actually did on the loaded data.
 *
 * The classic definitions (Nison, Bulkowski) assume daily stock charts with opening gaps.
 * XAUUSD trades around the clock, so a candle opens where the last one closed: the rules
 * here use bodies, wicks and closes instead of gaps, and sizes are measured in ATR(14) taken
 * before the pattern started, so a big pattern candle does not lower its own bar.
 *
 * Reversal patterns only count in the trend they reverse: a bullish one needs a fall into it
 * (the close TREND_LEN candles before the pattern at least TREND_ATR ATRs higher) and has to
 * make the low of that stretch; bearish ones mirror this. With {trend: false} only the shape
 * is checked, which is how the SMC engine uses them at an order block (the zone is the context).
 *
 * A pattern is known when its last candle closes: detection at candle i reads candles up to i.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMCCandles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TREND_LEN = 6;      // candles before the pattern that make its trend
  const TREND_ATR = 0.8;    // the close has to move this many ATRs over them
  const EXTREME_LEN = 20;   // "at an extreme": the pattern's low (high) is the lowest (highest) of this many candles
  const VOL_LEN = 20;
  const VOL_STRONG = 1.5;   // pattern volume this many times the average earns a star

  const body = b => Math.abs(b.c - b.o);
  const range = b => b.h - b.l;
  const upper = b => b.h - Math.max(b.o, b.c);
  const lower = b => Math.min(b.o, b.c) - b.l;
  const top = b => Math.max(b.o, b.c);
  const bot = b => Math.min(b.o, b.c);
  const mid = b => (b.o + b.c) / 2;
  const up = b => b.c > b.o;
  const down = b => b.c < b.o;
  const doji = b => range(b) > 0 && body(b) <= 0.1 * range(b);

  // ---- shapes shared by several patterns (x = {k: candles oldest first, A: ATR before the pattern}) ----
  const hammerShape = (b, A) => range(b) >= 0.5 * A && body(b) > 0.1 * range(b)
    && lower(b) >= 2 * body(b) && lower(b) >= 0.6 * range(b) && upper(b) <= 0.25 * range(b);
  const invHammerShape = (b, A) => range(b) >= 0.5 * A && body(b) > 0.1 * range(b)
    && upper(b) >= 2 * body(b) && upper(b) >= 0.6 * range(b) && lower(b) <= 0.25 * range(b);
  const pinShape = (b, A, bull) => {
    const r = range(b), w = bull ? lower(b) : upper(b);
    return r >= 0.5 * A && w >= 2 * Math.max(body(b), 0.05 * r) && w >= 0.5 * r;
  };
  const engulfs = (p, b) => top(b) >= top(p) && bot(b) <= bot(p) && body(b) > body(p);
  const inside = (p, b) => top(b) <= top(p) && bot(b) >= bot(p);
  const soldiers = (k, A, bull) => k.every((b, n) => (bull ? up(b) : down(b)) && body(b) >= 0.5 * A
    && (bull ? upper(b) : lower(b)) <= 0.3 * body(b)
    && (n === 0 || ((bull ? b.c > k[n - 1].c : b.c < k[n - 1].c) && b.o >= bot(k[n - 1]) && b.o <= top(k[n - 1]))));
  const star = (k, A, bull, dojiStar) => {
    const [a, m, b] = k;
    const first = bull ? down(a) : up(a), last = bull ? up(b) : down(b);
    const sits = bull ? top(m) <= a.c + 0.1 * A : bot(m) >= a.c - 0.1 * A;
    const small = body(m) <= 0.35 * body(a) && (dojiStar ? doji(m) : !doji(m));
    const back = bull ? b.c >= mid(a) : b.c <= mid(a);
    return first && body(a) >= 0.8 * A && small && sits && last && body(b) >= 0.4 * A && back;
  };
  const threePins = (k, bull) => k.every(b => range(b) > 0 && (bull ? lower(b) : upper(b)) >= 0.5 * range(b))
    && (bull ? up(k[2]) : down(k[2]));
  // the whole range (wicks included) inside the previous candle's range
  const insideRange = (p, b) => b.h <= p.h && b.l >= p.l;
  // fakey: a mother candle, an inside candle, then a false break of the inside candle that closes back
  const fakey = ([m, ib, x], A, bull) => range(m) >= 0.8 * A && insideRange(m, ib) && range(x) > 0
    && (bull ? x.l < ib.l && x.c > ib.l && x.c <= m.h && x.c - x.l >= 0.5 * range(x)
      : x.h > ib.h && x.c < ib.h && x.c >= m.l && x.h - x.c >= 0.5 * range(x));
  // railroad tracks: two big opposite candles of about the same size, the second undoing the first
  const rails = ([p, b], A, bull) => (bull ? down(p) && up(b) : up(p) && down(b))
    && body(p) >= 0.8 * A && body(b) >= 0.8 * A && body(p) >= 0.6 * range(p) && body(b) >= 0.6 * range(b)
    && Math.abs(body(b) - body(p)) <= 0.25 * Math.max(body(p), body(b))
    && (bull ? b.c >= p.o - 0.15 * body(p) : b.c <= p.o + 0.15 * body(p));
  // key reversal: takes out the previous candle's low (high), then closes beyond its high (low)
  const keyReversal = ([p, b], A, bull) => range(b) >= A
    && (bull ? up(b) && b.l < p.l && b.c > p.h : down(b) && b.h > p.h && b.c < p.l);
  // belt hold: opens at its low (high) and drives the other way; a few cents of wick allowed
  const beltHold = (b, A, bull) => (bull ? up(b) && lower(b) <= 0.05 * range(b) : down(b) && upper(b) <= 0.05 * range(b))
    && body(b) >= 0.6 * range(b) && body(b) >= 0.8 * A;

  /*
   * dir: bull / bear / neutral. trend: the trend a reversal needs before it (null = any).
   * test(k, A) gets the pattern's candles, oldest first, and the ATR before it.
   */
  const PATTERNS = [
    // ---- one candle ----
    {
      key: 'hammer', name: 'Hammer', dir: 'bull', bars: 1, type: 'reversal', trend: 'down',
      meaning: 'Sellers drove price down, buyers closed it back near the high. A possible bottom after a fall.',
      rule: 'After a fall: lower wick at least 2x the body and 60% of the range, upper wick at most 25%, range at least 0.5 ATR.',
      test: ([b], A) => hammerShape(b, A),
    },
    {
      key: 'invertedHammer', name: 'Inverted hammer', dir: 'bull', bars: 1, type: 'reversal', trend: 'down',
      meaning: 'Buyers tried higher after a fall; weaker than a hammer and needs the next candle to confirm.',
      rule: 'After a fall: upper wick at least 2x the body and 60% of the range, lower wick at most 25%, range at least 0.5 ATR.',
      test: ([b], A) => invHammerShape(b, A),
    },
    {
      key: 'hangingMan', name: 'Hanging man', dir: 'bear', bars: 1, type: 'reversal', trend: 'up',
      meaning: 'A hammer shape after a rise: sellers showed up during the candle. Bearish only if the next candle confirms.',
      rule: 'After a rise: the hammer shape (long lower wick, small body near the high).',
      test: ([b], A) => hammerShape(b, A),
    },
    {
      key: 'shootingStar', name: 'Shooting star', dir: 'bear', bars: 1, type: 'reversal', trend: 'up',
      meaning: 'Buyers pushed up, sellers closed it back near the low. A possible top after a rise.',
      rule: 'After a rise: upper wick at least 2x the body and 60% of the range, lower wick at most 25%, range at least 0.5 ATR.',
      test: ([b], A) => invHammerShape(b, A),
    },
    {
      key: 'dragonflyDoji', name: 'Dragonfly doji', dir: 'bull', bars: 1, type: 'reversal', trend: 'down',
      meaning: 'Open, high and close together after a deep dip that was fully bought back.',
      rule: 'After a fall: body at most 10% of the range, lower wick at least 70%, upper wick at most 10%, range at least 0.3 ATR.',
      test: ([b], A) => doji(b) && range(b) >= 0.3 * A && lower(b) >= 0.7 * range(b) && upper(b) <= 0.1 * range(b),
    },
    {
      key: 'gravestoneDoji', name: 'Gravestone doji', dir: 'bear', bars: 1, type: 'reversal', trend: 'up',
      meaning: 'A rally inside the candle that was fully sold back to the open.',
      rule: 'After a rise: body at most 10% of the range, upper wick at least 70%, lower wick at most 10%, range at least 0.3 ATR.',
      test: ([b], A) => doji(b) && range(b) >= 0.3 * A && upper(b) >= 0.7 * range(b) && lower(b) <= 0.1 * range(b),
    },
    {
      key: 'longLeggedDoji', name: 'Long-legged doji', dir: 'neutral', bars: 1, type: 'indecision', trend: null,
      meaning: 'Big swings both ways and a close at the open: buyers and sellers are balanced.',
      rule: 'Body at most 10% of the range, both wicks at least 30%, range at least 1 ATR.',
      test: ([b], A) => doji(b) && range(b) >= A && upper(b) >= 0.3 * range(b) && lower(b) >= 0.3 * range(b),
    },
    {
      key: 'doji', name: 'Doji', dir: 'neutral', bars: 1, type: 'indecision', trend: null,
      meaning: 'Close equals open: indecision. It matters at a level, not on its own.',
      rule: 'Body at most 10% of the range, range at least 0.3 ATR, and not one of the other dojis.',
      test: ([b], A) => doji(b) && range(b) >= 0.3 * A
        && !(lower(b) >= 0.7 * range(b) && upper(b) <= 0.1 * range(b))
        && !(upper(b) >= 0.7 * range(b) && lower(b) <= 0.1 * range(b))
        && !(range(b) >= A && upper(b) >= 0.3 * range(b) && lower(b) >= 0.3 * range(b)),
    },
    {
      key: 'spinningTop', name: 'Spinning top', dir: 'neutral', bars: 1, type: 'indecision', trend: null,
      meaning: 'A small body between two real wicks: the move is losing force.',
      rule: 'Body 10-30% of the range, both wicks at least 25%, range at least 0.5 ATR.',
      test: ([b], A) => range(b) >= 0.5 * A && body(b) > 0.1 * range(b) && body(b) <= 0.3 * range(b)
        && upper(b) >= 0.25 * range(b) && lower(b) >= 0.25 * range(b),
    },
    {
      key: 'bullMarubozu', name: 'Bullish marubozu', dir: 'bull', bars: 1, type: 'momentum', trend: null,
      meaning: 'Buyers in control from open to close, with almost no wicks.',
      rule: 'Up candle, body at least 90% of the range and at least 1 ATR.',
      test: ([b], A) => up(b) && body(b) >= 0.9 * range(b) && body(b) >= A,
    },
    {
      key: 'bearMarubozu', name: 'Bearish marubozu', dir: 'bear', bars: 1, type: 'momentum', trend: null,
      meaning: 'Sellers in control from open to close, with almost no wicks.',
      rule: 'Down candle, body at least 90% of the range and at least 1 ATR.',
      test: ([b], A) => down(b) && body(b) >= 0.9 * range(b) && body(b) >= A,
    },
    {
      key: 'bullPin', name: 'Bullish pin bar', dir: 'bull', bars: 1, type: 'rejection', trend: null,
      meaning: 'A long lower wick: price below was rejected. The SMC entry candle at a buy zone.',
      rule: 'Lower wick at least 2x the body and half the range, range at least 0.5 ATR. Any trend.',
      test: ([b], A) => pinShape(b, A, true),
    },
    {
      key: 'bearPin', name: 'Bearish pin bar', dir: 'bear', bars: 1, type: 'rejection', trend: null,
      meaning: 'A long upper wick: price above was rejected. The SMC entry candle at a sell zone.',
      rule: 'Upper wick at least 2x the body and half the range, range at least 0.5 ATR. Any trend.',
      test: ([b], A) => pinShape(b, A, false),
    },
    {
      key: 'bullBeltHold', name: 'Bullish belt hold', dir: 'bull', bars: 1, type: 'reversal', trend: 'down',
      meaning: 'Opens at the low of a fall and drives up all candle: buyers were waiting right there.',
      rule: 'After a fall: an up candle with a lower wick of at most 5% of its range, body at least 60% of the range and 0.8 ATR.',
      test: ([b], A) => beltHold(b, A, true),
    },
    {
      key: 'bearBeltHold', name: 'Bearish belt hold', dir: 'bear', bars: 1, type: 'reversal', trend: 'up',
      meaning: 'Opens at the high of a rise and drives down all candle: sellers were waiting right there.',
      rule: 'After a rise: a down candle with an upper wick of at most 5% of its range, body at least 60% of the range and 0.8 ATR.',
      test: ([b], A) => beltHold(b, A, false),
    },

    // ---- two candles ----
    {
      key: 'insideBar', name: 'Inside bar', dir: 'neutral', bars: 2, type: 'indecision', trend: null,
      meaning: 'The whole candle fits inside the one before: price is coiling. The break of the mother candle shows the side; a false break is a fakey.',
      rule: 'The previous candle is at least 0.8 ATR; this candle\'s high and low are inside it and its range is at most 60% of it.',
      test: ([p, b], A) => range(p) >= 0.8 * A && insideRange(p, b) && range(b) <= 0.6 * range(p),
    },
    {
      key: 'bullRails', name: 'Bullish two-bar reversal (railroad tracks)', dir: 'bull', bars: 2, type: 'reversal', trend: 'down',
      meaning: 'A big down candle undone by an up candle of the same size: the sellers\' push was fully absorbed.',
      rule: 'After a fall: a down then an up candle, both bodies at least 0.8 ATR and 60% of their range, sizes within 25% of each other, the up candle closing back near the down candle\'s open.',
      test: (k, A) => rails(k, A, true),
    },
    {
      key: 'bearRails', name: 'Bearish two-bar reversal (railroad tracks)', dir: 'bear', bars: 2, type: 'reversal', trend: 'up',
      meaning: 'A big up candle undone by a down candle of the same size: the buyers\' push was fully absorbed.',
      rule: 'After a rise: an up then a down candle, both bodies at least 0.8 ATR and 60% of their range, sizes within 25% of each other, the down candle closing back near the up candle\'s open.',
      test: (k, A) => rails(k, A, false),
    },
    {
      key: 'bullKeyReversal', name: 'Bullish key reversal', dir: 'bull', bars: 2, type: 'reversal', trend: 'down',
      meaning: 'Takes out the previous low, then closes above the previous high: a full turn inside one candle (an outside reversal bar).',
      rule: 'After a fall: an up candle of at least 1 ATR whose low is below the previous low and whose close is above the previous high.',
      test: (k, A) => keyReversal(k, A, true),
    },
    {
      key: 'bearKeyReversal', name: 'Bearish key reversal', dir: 'bear', bars: 2, type: 'reversal', trend: 'up',
      meaning: 'Takes out the previous high, then closes below the previous low: a full turn inside one candle (an outside reversal bar).',
      rule: 'After a rise: a down candle of at least 1 ATR whose high is above the previous high and whose close is below the previous low.',
      test: (k, A) => keyReversal(k, A, false),
    },
    {
      key: 'bullEngulfing', name: 'Bullish engulfing', dir: 'bull', bars: 2, type: 'reversal', trend: 'down',
      meaning: 'An up candle whose body swallows the previous down body: buyers took over.',
      rule: 'After a fall: a down candle, then an up candle whose body covers it and is bigger, at least 0.5 ATR.',
      test: ([p, b], A) => down(p) && up(b) && engulfs(p, b) && body(b) >= 0.5 * A,
    },
    {
      key: 'bearEngulfing', name: 'Bearish engulfing', dir: 'bear', bars: 2, type: 'reversal', trend: 'up',
      meaning: 'A down candle whose body swallows the previous up body: sellers took over.',
      rule: 'After a rise: an up candle, then a down candle whose body covers it and is bigger, at least 0.5 ATR.',
      test: ([p, b], A) => up(p) && down(b) && engulfs(p, b) && body(b) >= 0.5 * A,
    },
    {
      key: 'bullHarami', name: 'Bullish harami', dir: 'bull', bars: 2, type: 'reversal', trend: 'down',
      meaning: 'A small up candle inside a big down candle: the selling has stalled.',
      rule: 'After a fall: a down candle of at least 0.8 ATR, then an up candle whose body sits inside it and is at most half its size.',
      test: ([p, b], A) => down(p) && body(p) >= 0.8 * A && up(b) && !doji(b) && inside(p, b) && body(b) <= 0.5 * body(p),
    },
    {
      key: 'bearHarami', name: 'Bearish harami', dir: 'bear', bars: 2, type: 'reversal', trend: 'up',
      meaning: 'A small down candle inside a big up candle: the buying has stalled.',
      rule: 'After a rise: an up candle of at least 0.8 ATR, then a down candle whose body sits inside it and is at most half its size.',
      test: ([p, b], A) => up(p) && body(p) >= 0.8 * A && down(b) && !doji(b) && inside(p, b) && body(b) <= 0.5 * body(p),
    },
    {
      key: 'bullHaramiCross', name: 'Bullish harami cross', dir: 'bull', bars: 2, type: 'reversal', trend: 'down',
      meaning: 'A doji inside a big down candle: stronger stall than a plain harami.',
      rule: 'After a fall: a down candle of at least 0.8 ATR, then a doji whose body sits inside it.',
      test: ([p, b], A) => down(p) && body(p) >= 0.8 * A && doji(b) && inside(p, b),
    },
    {
      key: 'bearHaramiCross', name: 'Bearish harami cross', dir: 'bear', bars: 2, type: 'reversal', trend: 'up',
      meaning: 'A doji inside a big up candle: stronger stall than a plain harami.',
      rule: 'After a rise: an up candle of at least 0.8 ATR, then a doji whose body sits inside it.',
      test: ([p, b], A) => up(p) && body(p) >= 0.8 * A && doji(b) && inside(p, b),
    },
    {
      key: 'piercing', name: 'Piercing line', dir: 'bull', bars: 2, type: 'reversal', trend: 'down',
      meaning: 'After a strong down candle, buyers close more than halfway back up into it.',
      rule: 'After a fall: a down candle of at least 0.6 ATR, then an up candle opening at or below its close and closing above the middle of its body (but not above its open).',
      test: ([p, b], A) => down(p) && body(p) >= 0.6 * A && up(b) && b.o <= p.c + 0.05 * A && b.c > mid(p) && b.c < p.o,
    },
    {
      key: 'darkCloud', name: 'Dark cloud cover', dir: 'bear', bars: 2, type: 'reversal', trend: 'up',
      meaning: 'After a strong up candle, sellers close more than halfway back down into it.',
      rule: 'After a rise: an up candle of at least 0.6 ATR, then a down candle opening at or above its close and closing below the middle of its body (but not below its open).',
      test: ([p, b], A) => up(p) && body(p) >= 0.6 * A && down(b) && b.o >= p.c - 0.05 * A && b.c < mid(p) && b.c > p.o,
    },
    {
      key: 'tweezerBottom', name: 'Tweezer bottom', dir: 'bull', bars: 2, type: 'reversal', trend: 'down',
      meaning: 'Two candles stop at the same low: a floor that held twice.',
      rule: 'After a fall: a down candle then an up candle, lows within 0.05 ATR, both ranges at least 0.4 ATR.',
      test: ([p, b], A) => down(p) && up(b) && Math.abs(p.l - b.l) <= 0.05 * A && range(p) >= 0.4 * A && range(b) >= 0.4 * A,
    },
    {
      key: 'tweezerTop', name: 'Tweezer top', dir: 'bear', bars: 2, type: 'reversal', trend: 'up',
      meaning: 'Two candles stop at the same high: a ceiling that held twice.',
      rule: 'After a rise: an up candle then a down candle, highs within 0.05 ATR, both ranges at least 0.4 ATR.',
      test: ([p, b], A) => up(p) && down(b) && Math.abs(p.h - b.h) <= 0.05 * A && range(p) >= 0.4 * A && range(b) >= 0.4 * A,
    },
    {
      key: 'bullKicker', name: 'Bullish kicker', dir: 'bull', bars: 2, type: 'reversal', trend: null,
      meaning: 'A down candle followed by an up candle that opens above it: a sudden change of mind (rare on gold).',
      rule: 'A down candle of at least 0.5 ATR, then an up candle of at least 0.5 ATR opening at or above its open.',
      test: ([p, b], A) => down(p) && up(b) && b.o >= p.o && body(p) >= 0.5 * A && body(b) >= 0.5 * A,
    },
    {
      key: 'bearKicker', name: 'Bearish kicker', dir: 'bear', bars: 2, type: 'reversal', trend: null,
      meaning: 'An up candle followed by a down candle that opens below it: a sudden change of mind (rare on gold).',
      rule: 'An up candle of at least 0.5 ATR, then a down candle of at least 0.5 ATR opening at or below its open.',
      test: ([p, b], A) => up(p) && down(b) && b.o <= p.o && body(p) >= 0.5 * A && body(b) >= 0.5 * A,
    },

    // ---- three candles ----
    {
      key: 'morningStar', name: 'Morning star', dir: 'bull', bars: 3, type: 'reversal', trend: 'down',
      meaning: 'A big down candle, a small pause at the low, then a strong up candle: a classic bottom.',
      rule: 'After a fall: a down candle of at least 0.8 ATR; a small candle (body at most 35% of it) sitting at or below its close; an up candle of at least 0.4 ATR closing above the middle of the first body.',
      test: (k, A) => star(k, A, true, false),
    },
    {
      key: 'eveningStar', name: 'Evening star', dir: 'bear', bars: 3, type: 'reversal', trend: 'up',
      meaning: 'A big up candle, a small pause at the high, then a strong down candle: a classic top.',
      rule: 'After a rise: an up candle of at least 0.8 ATR; a small candle (body at most 35% of it) sitting at or above its close; a down candle of at least 0.4 ATR closing below the middle of the first body.',
      test: (k, A) => star(k, A, false, false),
    },
    {
      key: 'morningDojiStar', name: 'Morning doji star', dir: 'bull', bars: 3, type: 'reversal', trend: 'down',
      meaning: 'A morning star whose middle candle is a doji: the pause is pure indecision.',
      rule: 'As the morning star, with a doji in the middle.',
      test: (k, A) => star(k, A, true, true),
    },
    {
      key: 'eveningDojiStar', name: 'Evening doji star', dir: 'bear', bars: 3, type: 'reversal', trend: 'up',
      meaning: 'An evening star whose middle candle is a doji.',
      rule: 'As the evening star, with a doji in the middle.',
      test: (k, A) => star(k, A, false, true),
    },
    {
      key: 'threeWhiteSoldiers', name: 'Three white soldiers', dir: 'bull', bars: 3, type: 'momentum', trend: null,
      meaning: 'Three solid up candles in a row, each closing higher: steady buying.',
      rule: 'Three up candles of at least 0.5 ATR, each closing higher, each opening inside the previous body, upper wicks at most 30% of the body.',
      test: (k, A) => soldiers(k, A, true),
    },
    {
      key: 'threeBlackCrows', name: 'Three black crows', dir: 'bear', bars: 3, type: 'momentum', trend: null,
      meaning: 'Three solid down candles in a row, each closing lower: steady selling.',
      rule: 'Three down candles of at least 0.5 ATR, each closing lower, each opening inside the previous body, lower wicks at most 30% of the body.',
      test: (k, A) => soldiers(k, A, false),
    },
    {
      key: 'threeInsideUp', name: 'Three inside up', dir: 'bull', bars: 3, type: 'reversal', trend: 'down',
      meaning: 'A bullish harami confirmed by a third candle closing above the big down candle.',
      rule: 'After a fall: a down candle of at least 0.8 ATR, an up candle inside its body (at most 60% of it), then an up candle closing above the first open.',
      test: ([a, m, b], A) => down(a) && body(a) >= 0.8 * A && up(m) && inside(a, m) && body(m) <= 0.6 * body(a) && up(b) && b.c > a.o,
    },
    {
      key: 'threeInsideDown', name: 'Three inside down', dir: 'bear', bars: 3, type: 'reversal', trend: 'up',
      meaning: 'A bearish harami confirmed by a third candle closing below the big up candle.',
      rule: 'After a rise: an up candle of at least 0.8 ATR, a down candle inside its body (at most 60% of it), then a down candle closing below the first open.',
      test: ([a, m, b], A) => up(a) && body(a) >= 0.8 * A && down(m) && inside(a, m) && body(m) <= 0.6 * body(a) && down(b) && b.c < a.o,
    },
    {
      key: 'threeOutsideUp', name: 'Three outside up', dir: 'bull', bars: 3, type: 'reversal', trend: 'down',
      meaning: 'A bullish engulfing confirmed by a higher close on the next candle.',
      rule: 'After a fall: a down candle, an up candle engulfing its body, then an up candle closing higher still.',
      test: ([a, m, b], A) => down(a) && up(m) && engulfs(a, m) && body(m) >= 0.5 * A && up(b) && b.c > m.c,
    },
    {
      key: 'threeOutsideDown', name: 'Three outside down', dir: 'bear', bars: 3, type: 'reversal', trend: 'up',
      meaning: 'A bearish engulfing confirmed by a lower close on the next candle.',
      rule: 'After a rise: an up candle, a down candle engulfing its body, then a down candle closing lower still.',
      test: ([a, m, b], A) => up(a) && down(m) && engulfs(a, m) && body(m) >= 0.5 * A && down(b) && b.c < m.c,
    },
    {
      key: 'bullThreePins', name: 'Three bullish pins', dir: 'bull', bars: 3, type: 'rejection', trend: null,
      meaning: 'Three candles in a row reject lower prices with long lower wicks, the third closing up.',
      rule: 'Three candles whose lower wicks are each at least half their range; the third closes up.',
      test: k => threePins(k, true),
    },
    {
      key: 'bearThreePins', name: 'Three bearish pins', dir: 'bear', bars: 3, type: 'rejection', trend: null,
      meaning: 'Three candles in a row reject higher prices with long upper wicks, the third closing down.',
      rule: 'Three candles whose upper wicks are each at least half their range; the third closes down.',
      test: k => threePins(k, false),
    },
    {
      key: 'bullFakey', name: 'Bullish fakey', dir: 'bull', bars: 3, type: 'rejection', trend: null,
      meaning: 'An inside candle breaks down, then the break fails and price closes back up: the sellers who sold the break are trapped.',
      rule: 'A mother candle of at least 0.8 ATR, an inside candle, then a candle that trades below the inside candle\'s low, closes back above it (inside the mother candle) and in the upper half of its own range.',
      test: (k, A) => fakey(k, A, true),
    },
    {
      key: 'bearFakey', name: 'Bearish fakey', dir: 'bear', bars: 3, type: 'rejection', trend: null,
      meaning: 'An inside candle breaks up, then the break fails and price closes back down: the buyers who bought the break are trapped.',
      rule: 'A mother candle of at least 0.8 ATR, an inside candle, then a candle that trades above the inside candle\'s high, closes back below it (inside the mother candle) and in the lower half of its own range.',
      test: (k, A) => fakey(k, A, false),
    },
    {
      key: 'invHeadShoulders', name: 'Inverse head & shoulders (3 candles)', dir: 'bull', bars: 3, type: 'rejection', trend: null,
      meaning: 'The middle candle makes the low, the next closes up past it: a small double rejection, your SMC entry candle.',
      rule: 'The middle candle has the lowest low of the three; the third closes up, above the middle candle\'s body.',
      test: ([a, m, b]) => m.l < a.l && m.l < b.l && up(b) && b.c > top(m),
    },
    {
      key: 'headShoulders', name: 'Head & shoulders (3 candles)', dir: 'bear', bars: 3, type: 'rejection', trend: null,
      meaning: 'The middle candle makes the high, the next closes down past it: a small double rejection, your SMC entry candle.',
      rule: 'The middle candle has the highest high of the three; the third closes down, below the middle candle\'s body.',
      test: ([a, m, b]) => m.h > a.h && m.h > b.h && down(b) && b.c < bot(m),
    },
  ];
  const BY_KEY = Object.fromEntries(PATTERNS.map(p => [p.key, p]));

  // Wilder ATR, the same as the engine's
  function atrSeries(B, n = 14) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i], p = B[i - 1];
      const tr = p ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
      if (i < n) {
        sum += tr;
        out.push(sum / (i + 1));
      } else {
        out.push((out[i - 1] * (n - 1) + tr) / n);
      }
    }
    return out;
  }

  // average volume of the VOL_LEN candles before each candle (0 without volume)
  function volSeries(B) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < B.length; i++) {
      out.push(i ? sum / Math.min(i, VOL_LEN) : 0);
      sum += B[i].v || 0;
      if (i >= VOL_LEN) sum -= B[i - VOL_LEN].v || 0;
    }
    return out;
  }

  // The trend into candle f (the pattern's first candle): 'up', 'down' or 'flat'.
  function trendInto(B, f, atr) {
    const e = f - 1, s = e - TREND_LEN;
    if (s < 0) return 'flat';
    const A = atr[e], move = B[e].c - B[s].c;
    if (!(A > 0)) return 'flat';
    return move <= -TREND_ATR * A ? 'down' : move >= TREND_ATR * A ? 'up' : 'flat';
  }

  // Lowest low (highest high) of the pattern against the TREND_LEN candles before it
  function makesExtreme(B, f, i, low, len) {
    const from = Math.max(0, f - len);
    let p = low ? Infinity : -Infinity, q = low ? Infinity : -Infinity;
    for (let k = f; k <= i; k++) p = low ? Math.min(p, B[k].l) : Math.max(p, B[k].h);
    for (let k = from; k < f; k++) q = low ? Math.min(q, B[k].l) : Math.max(q, B[k].h);
    return from === f || (low ? p <= q : p >= q);
  }

  function context(B, n) {
    return { atr: (n && n.atr) || atrSeries(B), vol: (n && n.vol) || volSeries(B) };
  }

  /*
   * One pattern ending at candle i, or null. opts: {atr, vol, trend (default true)}.
   * The result: {key, name, dir, type, i, from, tip (the extreme in the pattern's direction:
   * lowest low for bullish, highest high for bearish), stars (1-3), volX, extreme, trend}.
   */
  function match(B, i, key, opts = {}) {
    const p = BY_KEY[key];
    if (!p) return null;
    const atr = opts.atr || atrSeries(B.slice(0, i + 1));
    return matchDef(B, i, p, atr, opts.vol || null, opts.trend !== false);
  }

  function matchDef(B, i, p, atr, vol, withTrend) {
    const f = i - p.bars + 1;
    if (f < 1 || i >= B.length) return null;
    const A = atr[f - 1];
    if (!(A > 0)) return null;
    const k = p.bars === 1 ? [B[i]] : p.bars === 2 ? [B[i - 1], B[i]] : [B[i - 2], B[i - 1], B[i]];
    if (!p.test(k, A)) return null;
    const tr = trendInto(B, f, atr);
    const bull = p.dir === 'bull', bear = p.dir === 'bear';
    if (withTrend && p.trend) {
      if (tr !== p.trend) return null;
      if (!makesExtreme(B, f, i, p.trend === 'down', TREND_LEN)) return null;
    }
    const tip = bull ? Math.min(...k.map(b => b.l)) : bear ? Math.max(...k.map(b => b.h)) : null;
    const va = vol ? vol[f] : 0;
    const volX = va > 0 ? Math.max(...k.map(b => b.v || 0)) / va : null;
    const extreme = p.dir === 'neutral' ? false : makesExtreme(B, f, i, bull, EXTREME_LEN);
    let stars = 1;
    if (volX !== null && volX >= VOL_STRONG) stars++;
    if (extreme && (p.type === 'reversal' || p.type === 'rejection')) stars++;
    else if (p.type === 'momentum' && k.reduce((s, b) => s + body(b), 0) >= 1.5 * A * k.length) stars++;
    return {
      key: p.key, name: p.name, dir: p.dir, type: p.type, i, from: f, tip, stars: Math.min(3, stars),
      volX, extreme, trend: tr,
    };
  }

  const chosen = keys => (keys ? PATTERNS.filter(p => keys.includes(p.key)) : PATTERNS);

  // Every pattern ending at candle i. opts: {atr, vol, trend, keys}.
  function detectAt(B, i, opts = {}) {
    const n = context(B, opts), list = chosen(opts.keys), out = [];
    for (const p of list) {
      const h = matchDef(B, i, p, n.atr, n.vol, opts.trend !== false);
      if (h) out.push(h);
    }
    return out;
  }

  // Every pattern in the data (or from candle `from` on), in candle order.
  function detectAll(B, opts = {}) {
    const n = context(B, opts), list = chosen(opts.keys), out = [];
    for (let i = Math.max(1, opts.from || 1); i < B.length; i++) {
      for (const p of list) {
        const h = matchDef(B, i, p, n.atr, n.vol, opts.trend !== false);
        if (h) out.push(h);
      }
    }
    return out;
  }

  function wilson(k, n) {
    if (!n) return { p: null, lo: 0, hi: 1, n: 0 };
    const z = 1.96, z2 = z * z, p = k / n, den = 1 + z2 / n;
    const m = (p + z2 / (2 * n)) / den;
    const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
    return { p, lo: Math.max(0, m - half), hi: Math.min(1, m + half), n };
  }

  // +1 when price reaches entry + dist before entry - dist (long), -1 the other way round,
  // 0 when neither within `bars` candles. A candle that reaches both counts against the trade.
  function firstTouch(B, i, dist, bars, long) {
    const e = B[i].c;
    for (let j = i + 1; j <= Math.min(B.length - 1, i + bars); j++) {
      const hiHit = B[j].h >= e + dist, loHit = B[j].l <= e - dist;
      if (long) {
        if (loHit) return -1;
        if (hiHit) return 1;
      } else {
        if (hiHit) return -1;
        if (loHit) return 1;
      }
    }
    return 0;
  }

  /*
   * How each pattern did on this data. For a bullish pattern "worked" means the close
   * h candles after the pattern was higher than the pattern's close (lower for bearish);
   * "1 ATR first" means price reached 1 ATR in the pattern's direction before 1 ATR against
   * it, within `touchBars` candles. Every number is set against the base rate: the same
   * measure from every candle, so a pattern only has an edge if it beats that. Neutral
   * patterns get the size of the move that followed instead, against the usual move.
   * A verdict of better or worse also needs both halves of the data to agree, because with
   * this many patterns a few always look special by chance.
   * filter(hit) picks the hits to count (e.g. only those inside an SMC zone).
   */
  function evaluate(B, hits, { horizons = [3, 6, 12], touchBars = 12, atr, filter } = {}) {
    const A = atr || atrSeries(B), n = B.length;
    const base = { horizons: {}, touch: { long: null, short: null }, absMove: {} };
    for (const h of horizons) {
      let upN = 0, dnN = 0, abs = 0, cnt = 0;
      for (let i = 0; i + h < n; i++) {
        const d = B[i + h].c - B[i].c;
        if (d > 0) upN++;
        else if (d < 0) dnN++;
        if (A[i] > 0) { abs += Math.abs(d) / A[i]; cnt++; }
      }
      base.horizons[h] = { up: upN / Math.max(1, upN + dnN), down: dnN / Math.max(1, upN + dnN) };
      base.absMove[h] = cnt ? abs / cnt : null;
    }
    {
      let lw = 0, ln = 0, sw = 0, sn = 0;
      // every 3rd candle is plenty for a base rate and keeps this quick
      for (let i = 20; i + 1 < n; i += 3) {
        const l = firstTouch(B, i, A[i], touchBars, true), s = firstTouch(B, i, A[i], touchBars, false);
        if (l) { ln++; if (l > 0) lw++; }
        if (s) { sn++; if (s > 0) sw++; }
      }
      base.touch = { long: ln ? lw / ln : null, short: sn ? sw / sn : null };
    }
    const rows = new Map();
    for (const p of PATTERNS) {
      rows.set(p.key, {
        key: p.key, name: p.name, dir: p.dir, type: p.type, n: 0, horizons: {}, touch: null, absMove: {}, last: null,
      });
    }
    const acc = {};
    for (const hit of hits) {
      if (filter && !filter(hit)) continue;
      const r = rows.get(hit.key);
      if (!r) continue;
      r.n++;
      r.last = hit.i;
      const a = acc[hit.key] || (acc[hit.key] = { h: {}, abs: {}, tw: 0, tn: 0 });
      for (const h of horizons) {
        const j = hit.i + h;
        if (j >= n) continue;
        const d = B[j].c - B[hit.i].c, x = a.h[h] || (a.h[h] = { k: 0, n: 0, move: 0, half: [[0, 0], [0, 0]] });
        const ab = a.abs[h] || (a.abs[h] = { sum: 0, n: 0 });
        if (A[hit.i] > 0) { ab.sum += Math.abs(d) / A[hit.i]; ab.n++; }
        if (hit.dir === 'neutral' || d === 0) continue;
        const won = (d > 0) === (hit.dir === 'bull'), hv = x.half[hit.i < n / 2 ? 0 : 1];
        x.n++;
        hv[1]++;
        if (won) { x.k++; hv[0]++; }
        if (A[hit.i] > 0) x.move += (hit.dir === 'bull' ? d : -d) / A[hit.i];
      }
      if (hit.dir !== 'neutral' && A[hit.i] > 0) {
        const t = firstTouch(B, hit.i, A[hit.i], touchBars, hit.dir === 'bull');
        if (t) { a.tn++; if (t > 0) a.tw++; }
      }
    }
    for (const [key, a] of Object.entries(acc)) {
      const r = rows.get(key);
      for (const h of horizons) {
        const x = a.h[h];
        const ab = a.abs[h];
        r.absMove[h] = ab && ab.n ? ab.sum / ab.n : null;
        if (!x || !x.n) continue;
        const ci = wilson(x.k, x.n), b = base.horizons[h][r.dir === 'bull' ? 'up' : 'down'];
        // with ~40 patterns some look better or worse by luck: a verdict needs the confidence
        // interval clear of the base rate and both halves of the data on the same side of it
        const halves = x.half.map(([k, m]) => (m ? k / m : null));
        const both = sign => halves.every(q => q !== null && (sign > 0 ? q > b : q < b));
        r.horizons[h] = {
          n: x.n, p: ci.p, lo: ci.lo, hi: ci.hi, base: b, edge: ci.p - b, avgMoveAtr: x.move / x.n, halves,
          verdict: ci.lo > b && both(1) ? 'better' : ci.hi < b && both(-1) ? 'worse' : 'same',
        };
      }
      if (a.tn) {
        const ci = wilson(a.tw, a.tn), b = r.dir === 'bull' ? base.touch.long : base.touch.short;
        r.touch = { n: a.tn, p: ci.p, lo: ci.lo, hi: ci.hi, base: b, verdict: b === null ? 'same' : ci.lo > b ? 'better' : ci.hi < b ? 'worse' : 'same' };
      }
    }
    return { base, horizons, touchBars, rows: [...rows.values()] };
  }

  const describe = key => {
    const p = BY_KEY[key];
    return p && { key: p.key, name: p.name, dir: p.dir, bars: p.bars, type: p.type, trend: p.trend, meaning: p.meaning, rule: p.rule };
  };

  return {
    PATTERNS: PATTERNS.map(p => describe(p.key)), TREND_LEN, TREND_ATR, EXTREME_LEN,
    match, detectAt, detectAll, evaluate, describe, atrSeries, volSeries, trendInto, wilson,
  };
}));
