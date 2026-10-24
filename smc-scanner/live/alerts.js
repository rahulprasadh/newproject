/*
 * Alert text, console output and Telegram. Sending never throws: a failed alert is logged
 * and the scan goes on. The Telegram bot token is never written to the log.
 */
'use strict';
const { request } = require('./http.js');

// ---------- formatting ----------

const fmtCache = new Map();
function formatter(timeZone, withDate) {
  const key = `${timeZone}|${withDate}`;
  if (!fmtCache.has(key)) {
    const opts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    if (withDate) Object.assign(opts, { day: '2-digit', month: 'short' });
    let f;
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone });
    } catch (err) {
      f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' });   // unknown zone name
    }
    fmtCache.set(key, f);
  }
  return fmtCache.get(key);
}

// Candle times are shown in the trader's zone (India by default), as the chart's open time.
const clock = (t, timeZone = 'Asia/Kolkata') => formatter(timeZone, false).format(new Date(t * 1000));
const dateTime = (t, timeZone = 'Asia/Kolkata') => formatter(timeZone, true).format(new Date(t * 1000));
const price = p => (Number.isFinite(p)
  ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–');
const rText = rr => `${+(+rr).toFixed(1)}R`;
const pct = p => `${Math.round(100 * p)}%`;

function span(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = +(minutes / 60).toFixed(1);
  return `${h}h`;
}

// "Next move: 58% up in the next 1h (medium confidence)" from the forecaster's 1-hour call.
function nextMove(f) {
  if (!f || !f.horizons || !f.horizons.length) return null;
  const h = f.horizons.find(x => x.minutes === 60) || f.horizons[0];
  if (!Number.isFinite(h.pUp)) return null;
  const up = h.pUp >= 0.5;
  return `Next move: ${pct(up ? h.pUp : 1 - h.pUp)} ${up ? 'up' : 'down'} in the next ${span(h.minutes)} (${h.confidence} confidence)`;
}

function liquidityLine(f) {
  const q = f && f.liquidity;
  if (!q || q.pAboveFirst === null || q.pAboveFirst === undefined || !q.above || !q.below) return null;
  const up = q.pAboveFirst >= 0.5, lv = up ? q.above : q.below;
  return `Liquidity: ${pct(up ? q.pAboveFirst : 1 - q.pAboveFirst)} that ${lv.label} ${price(lv.price)} is taken first (${q.confidence} confidence)`;
}

function oddsLine(odds, what) {
  const w = odds && odds.pWinFromHere;
  if (!w || !(w.n >= 5) || w.p === null) return null;
  return `${what}: ${Math.round(w.p * w.n)} of ${w.n} won (${pct(w.p)})`;
}

/*
 * Lot size for a trade from the account size and the risk per trade. XAUUSD: 1 lot = 100 oz,
 * so a $1 move is $100 a lot. risk = {balance, percent, currency, usdRate (account currency per
 * 1 USD), contractSize, minLot, lotStep}. Returns null when no balance is set.
 */
function positionSize(entry, sl, risk) {
  if (!risk || !(+risk.balance > 0) || !(+risk.percent > 0)) return null;
  const contract = +risk.contractSize || 100, step = +risk.lotStep || 0.01, minLot = +risk.minLot || 0.01;
  const rate = +risk.usdRate > 0 ? +risk.usdRate : 1;
  const perLot = Math.abs(entry - sl) * contract * rate;        // account money lost per lot at the stop
  if (!(perLot > 0)) return null;
  const budget = +risk.balance * +risk.percent / 100;
  const lots = Math.floor(budget / perLot / step + 1e-9) * step;
  const dp = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const round = x => +x.toFixed(dp);
  return {
    lots: round(lots), tooSmall: lots < minLot - 1e-9, minLot, budget, perLot,
    riskAmount: Math.max(lots, 0) * perLot, minLotRisk: minLot * perLot, currency: risk.currency || 'USD',
    percent: +risk.percent, balance: +risk.balance,
  };
}

function money(x, currency = 'USD') {
  const sym = { USD: '$', INR: '₹', EUR: '€', GBP: '£', AED: 'AED ' }[String(currency).toUpperCase()];
  const digits = Math.abs(x) < 100 ? 2 : 0;
  const n = (+x).toLocaleString(String(currency).toUpperCase() === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return sym ? `${sym}${n}` : `${n} ${currency}`;
}

function sizeLine(e, risk) {
  const z = e && positionSize(e.entry, e.sl, risk);
  if (!z) return null;
  if (z.tooSmall) {
    return `Size: ${z.percent}% of ${money(z.balance, z.currency)} is less than ${z.minLot} lot here (${z.minLot} lot risks ${money(z.minLotRisk, z.currency)})`;
  }
  return `Size: ${z.lots} lot risks ${money(z.riskAmount, z.currency)} (${z.percent}% of ${money(z.balance, z.currency)})`;
}

function newsLine(list, timeZone) {
  if (!list || !list.length) return null;
  const parts = list.slice(0, 3).map(n => {
    const when = n.minutes > 0 ? `in ${n.minutes} min` : n.minutes === 0 ? 'now' : `${-n.minutes} min ago`;
    return `${n.country} ${n.title} ${when} (${clock(n.t, timeZone)})`;
  });
  return `⚠ High-impact news: ${parts.join('; ')}`;
}

const sideOf = dir => (dir === 'bull' ? 'BUY' : 'SELL');
const wordOf = dir => (dir === 'bull' ? 'buy' : 'sell');

// "Confluence 3/5: Key liquidity (PDL), London or NY session, Volume 2× average or more (2.3×)"
function gradeLine(s) {
  if (!s || !s.factors || !s.factors.length) return null;
  const met = s.factors.filter(f => f.ok).map(f => f.label);
  return `Confluence ${met.length}/${s.factors.length}${met.length ? ': ' + met.join(', ') : ''}`;
}

function story(a) {
  const s = a.setup, tz = a.timeZone, parts = [`Swept ${s.label || 'liquidity'} ${price(s.levelPrice)} at ${clock(s.sweepT, tz)}`];
  if (s.chochT) parts.push(`CHoCH ${clock(s.chochT, tz)}`);
  if (s.fvgKind) parts.push(s.fvgKind, 'OB');
  return parts.join(' · ');
}

/*
 * a = {kind: 'entry'|'sweep'|'choch'|'armed'|'result'|'cancel', symbol, tfMin, dir, t (candle time),
 *      setup: {label, levelPrice, sweepT, chochT, chochPrice, refPrice, fvgKind, fvg, ob, volX, reason},
 *      entry: engine entry, forecast, odds, timeZone}
 */
function message(a) {
  const head = `${a.symbol} ${a.tfMin}m`, tz = a.timeZone, s = a.setup || {}, e = a.entry;
  const lines = [];
  switch (a.kind) {
    case 'entry': {
      const tpNote = e.tpSrc && e.tpSrc !== 'rr' ? ` at ${e.tpSrc}` : '';
      lines.push(`${head} ${sideOf(e.dir)} signal · ${e.pattern} at ${e.zone}${e.grade ? ` · grade ${e.grade}` : ''}`);
      lines.push(`Entry ${price(e.entry)}  SL ${price(e.sl)}  TP ${price(e.tp)} (${rText(e.rr)}${tpNote})`);
      lines.push(sizeLine(e, a.risk));
      lines.push(story(a));
      lines.push(gradeLine(s));
      lines.push(newsLine(a.news, tz));
      lines.push(nextMove(a.forecast), oddsLine(a.odds, `Past ${wordOf(e.dir)} entries`));
      break;
    }
    case 'sweep':
      lines.push(`${head} ${a.dir === 'bull' ? 'Sell-side' : 'Buy-side'} liquidity swept · ${s.label} ${price(s.levelPrice)} at ${clock(a.t, tz)}`);
      if (Number.isFinite(s.refPrice)) {
        lines.push(`Watching for a ${a.dir === 'bull' ? 'bullish' : 'bearish'} CHoCH: a close ${a.dir === 'bull' ? 'above' : 'below'} ${price(s.refPrice)}`);
      }
      lines.push(nextMove(a.forecast));
      break;
    case 'choch':
      lines.push(`${head} ${a.dir === 'bull' ? 'Bullish' : 'Bearish'} CHoCH at ${clock(a.t, tz)} (close ${a.dir === 'bull' ? 'above' : 'below'} ${price(s.chochPrice)})`);
      lines.push(`${story(a)} · waiting for a volume candle with an FVG`);
      break;
    case 'armed': {
      const vol = Number.isFinite(s.volX) ? ` · volume ${s.volX.toFixed(1)}x` : '';
      lines.push(`${head} ${sideOf(a.dir)} zones marked at ${clock(a.t, tz)}${s.grade ? ` · grade ${s.grade}` : ''}`);
      lines.push(`OB ${price(s.ob.bottom)} – ${price(s.ob.top)} · ${s.fvgKind} ${price(s.fvg.bottom)} – ${price(s.fvg.top)}${vol}`);
      lines.push(`Wait for a pin bar or head & shoulders at the ${a.entryZone === 'fvg' ? s.fvgKind : 'OB'}`);
      lines.push(gradeLine(s));
      lines.push(newsLine(a.news, tz));
      lines.push(oddsLine(a.odds, `Past armed ${wordOf(a.dir)} setups`));
      break;
    }
    case 'result': {
      const win = e.outcome === 'win';
      lines.push(`${head} ${sideOf(e.dir)} ${win ? `hit TP +${rText(e.rr)}` : 'hit SL −1R'} at ${clock(a.t, tz)} · ${price(e.exitPrice)}`);
      lines.push(`Entry ${price(e.entry)} at ${clock(a.entryT, tz)} · ${e.pattern} at ${e.zone}`);
      break;
    }
    case 'cancel':
      lines.push(`${head} ${sideOf(a.dir)} setup cancelled at ${clock(a.t, tz)}: ${s.reason}`);
      lines.push(story(a));
      break;
    default:
      lines.push(`${head} ${a.kind}`);
  }
  return lines.filter(Boolean).join('\n');
}

// ---------- console ----------

const COLOR = { bull: '\x1b[32m', bear: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };

function consoleText(alert, { color = false, bell = false, timeZone } = {}) {
  const big = alert.kind === 'entry' || alert.kind === 'result';
  const c = color ? (alert.dir === 'bear' ? COLOR.bear : COLOR.bull) : '';
  const b = color && big ? COLOR.bold : '', r = color ? COLOR.reset : '';
  const [first, ...rest] = alert.text.split('\n');
  const when = clock(Math.floor(Date.now() / 1000), timeZone);
  return `${bell && big ? '\x07' : ''}\n${c}${b}>> ${first}${r}  ${color ? COLOR.dim : ''}(${when})${r}\n`
    + rest.map(l => `   ${l}\n`).join('');
}

// ---------- Telegram ----------

function hide(text, token) {
  let s = String(text);
  if (token) s = s.split(token).join('<token>');
  return s.replace(/bot\d+:[\w-]+/g, 'bot<token>');
}

// Resolves to {ok, error}; never rejects.
async function sendTelegram({ botToken, chatId, text, base, timeoutMs = 10000 }) {
  if (!botToken || !chatId) return { ok: false, error: 'Telegram is not set up (botToken and chatId)' };
  const root = String(base || 'https://api.telegram.org').replace(/\/+$/, '');
  try {
    const res = await request(`${root}/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs,
      body: { chat_id: chatId, text, disable_web_page_preview: true },
    });
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch (err) { /* not JSON: judged by the status below */ }
    if (res.status === 200 && json && json.ok) return { ok: true, error: null };
    const desc = json && json.description ? json.description : `HTTP ${res.status}`;
    const hint = res.status === 401 || res.status === 404 ? ' (check the bot token)'
      : /chat not found/i.test(desc) ? ' (check the chat id, and send /start to your bot first)' : '';
    return { ok: false, error: hide(`Telegram said: ${desc}${hint}`, botToken) };
  } catch (err) {
    return { ok: false, error: hide(`Telegram unreachable: ${err.message}`, botToken) };
  }
}

/*
 * cfg = config.alerts plus timeZone. send(alert) prints and/or posts alert.text and resolves to
 * {console, telegram}; it never rejects.
 */
function createNotifier(cfg = {}, { log = console.log, write = s => process.stdout.write(s), isTTY } = {}) {
  const tg = cfg.telegram || {};
  const tty = isTTY !== undefined ? isTTY : !!process.stdout.isTTY;
  const color = tty && !process.env.NO_COLOR;
  const safeLog = msg => {
    try {
      log(hide(msg, tg.botToken));
    } catch (err) { /* logging must not break a scan */ }
  };
  return {
    telegramEnabled: !!(tg.botToken && tg.chatId),
    async send(alert, { console: toConsole = true } = {}) {
      const out = { console: false, telegram: null };
      if (cfg.console !== false && toConsole) {
        try {
          write(consoleText(alert, { color, bell: cfg.bell !== false && tty, timeZone: cfg.timeZone }));
          out.console = true;
        } catch (err) {
          safeLog(`Could not print an alert: ${err.message}`);
        }
      }
      if (tg.botToken && tg.chatId) {
        try {
          const r = await sendTelegram({ botToken: tg.botToken, chatId: tg.chatId, text: alert.text, base: tg.base });
          out.telegram = r.ok;
          if (!r.ok) safeLog(`Telegram alert not sent: ${r.error}`);
        } catch (err) {
          out.telegram = false;
          safeLog(`Telegram alert not sent: ${err.message}`);
        }
      }
      return out;
    },
  };
}

module.exports = {
  message, nextMove, liquidityLine, oddsLine, consoleText, sendTelegram, createNotifier,
  clock, dateTime, price, hide, positionSize, sizeLine, newsLine, gradeLine, money,
};
