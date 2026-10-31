#!/usr/bin/env node
// Browser check of index.html (Playwright + Chromium). Not part of `node --test`.
//   node smc-scanner/tools/ui_check.js [shotDir]
// Scenario 1 serves the page the way the claude.ai artifact host does (no api/state).
// Scenario 2 runs the live runner on the replay source: the page opens in Live mode, then the
// Setup tab saves settings. Scenario 3 blocks the chart library and expects a clear message.
// The chart library comes from vendor/ (or LWC_PATH).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const LWC_PATH = process.env.LWC_PATH || path.join(ROOT, 'vendor', 'lightweight-charts.standalone.production.js');
const SHOTS = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'smc-ui-shots'));
const LWC_URL = 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js';
const ORIGIN = 'https://artifact.test';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };

if (!LWC_PATH || !fs.existsSync(LWC_PATH)) {
  console.error('vendor/lightweight-charts.standalone.production.js is missing; set LWC_PATH to a copy of lightweight-charts 4.2.3.');
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

const wrap = html => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + html + '</body></html>';
const results = [];
const ok = (name, cond, extra) => {
  results.push([name, !!cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// Console errors we expect: the aborted fonts and, in the artifact scenario, the missing api/state.
function watchErrors(page, allowApi404) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text(), url = (m.location() && m.location().url) || '';
    if (/fonts\.(googleapis|gstatic)\.com/.test(url + text) || /net::ERR_FAILED/.test(text) && /font/i.test(url)) return;
    if (/ERR_FAILED|ERR_BLOCKED/.test(text) && !url) return;   // aborted font requests carry no location
    if (allowApi404 && /404/.test(text) && (/api\/state/.test(url) || !url)) return;
    errors.push(text + (url ? ' @ ' + url : ''));
  });
  return errors;
}

async function routeExternal(context, serveOrigin) {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url === LWC_URL) return route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(LWC_PATH) });
    if (serveOrigin && url.startsWith(ORIGIN + '/')) {
      const p = decodeURIComponent(new URL(url).pathname);
      if (p === '/api/state') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
      if (p === '/' || p === '/index.html') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: wrap(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) });
      }
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    }
    if (url.startsWith('http://127.0.0.1:')) return route.continue();
    return route.abort();
  });
}

const nextText = page => page.$eval('#next', el => el.innerText);
const hasForecast = page => page.waitForFunction(() => /(Up|Down) \d+%/.test(document.querySelector('#next').innerText), null, { timeout: 90000 });
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function artifactScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await routeExternal(context, true);
  const page = await context.newPage();
  const errors = watchErrors(page, true);
  await page.goto(ORIGIN + '/index.html');
  await page.waitForFunction(() => document.querySelectorAll('#list .sig').length > 0, null, { timeout: 60000 });
  const training = await nextText(page);
  ok('next-move card shows training state or a result first', /Training on [\d,]+ candles|Up|Down/.test(training), JSON.stringify(training.slice(0, 60)));
  const t0 = Date.now();
  await hasForecast(page);
  const hist = await nextText(page);
  ok('history: next-move card renders numbers', /(Up|Down) \d+% in the next 1h/.test(hist) && /chance (buy|sell)-side is taken first|liquidity/.test(hist) && /right \d+%/.test(hist), `trained in ${Date.now() - t0} ms`);
  ok('history: forecast liquidity lines are listed', /Buy-side liquidity [\d,.]+/.test(hist));
  ok('history: the lean says which calls it counts',
    /Leaning (up|down)/.test(hist) ? /Counts only calls with a proven record: the /.test(hist) : /No clear lean/.test(hist),
    JSON.stringify(hist.split('\n').slice(2, 5).join(' / ')));
  ok('Live mode is hidden without api/state', await page.$eval('#liveBtn', b => b.hidden));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-light.png') });
  ok('desktop light: no horizontal overflow', (await overflow(page)) <= 0);

  // responsiveness while training: a settings change retrains; the page keeps answering
  await page.click('#tabSettings');
  const listBefore = await page.$eval('#list', el => el.innerText);
  const funnelBefore = await page.$eval('#funnel', el => el.innerText);
  await page.fill('#opt-spread', '1.5');
  await page.check('#opt-patterns-engulf');
  await page.waitForFunction(b => document.querySelector('#list').innerText !== b, listBefore, { timeout: 20000 }).catch(() => {});
  const listAfter = await page.$eval('#list', el => el.innerText);
  const funnelAfter = await page.$eval('#funnel', el => el.innerText);
  const rules = await page.$eval('#rules', el => el.innerText);
  ok('settings change re-runs the engine', listAfter !== listBefore || funnelAfter !== funnelBefore);
  ok('rules show live values', /spread of 1\.50/.test(rules) && /engulfing/.test(rules));
  const lag = await page.evaluate(() => new Promise(r => { const t = performance.now(); setTimeout(() => r(performance.now() - t), 0); }));
  ok('page stays responsive while retraining', lag < 300, `${Math.round(lag)} ms`);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-settings.png') });
  await page.click('#resetBtn');
  await page.click('#tabRules');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-rules.png') });
  await page.click('#tabSignals');
  await hasForecast(page);

  // replay: the card follows the cursor and Next signal still toasts
  await page.click('[data-mode="replay"]');
  await hasForecast(page).catch(() => {});
  const r1 = await nextText(page);
  for (let k = 0; k < 3; k++) await page.click('#rStep');
  const r2 = await nextText(page);
  ok('replay: next-move card updates as the cursor moves', r1 !== r2);
  await page.click('#rNext');
  await page.waitForSelector('.toast', { timeout: 5000 }).catch(() => {});
  const toast = await page.$$eval('.toast', els => els.map(e => e.innerText).join(' | '));
  ok('replay: Next signal finds an entry and toasts', /(BUY|SELL) NOW/.test(toast), toast.slice(0, 80));
  const detail = await page.$eval('#detail', el => el.innerText);
  ok('detail card shows liquidity label, session and HTF trend', /swept|Liquidity sweep ·/.test(detail) && /HTF trend/.test(detail));
  const planText = await page.$eval('#plan', el => el.innerText);
  ok('trade plan: BUY NOW / SELL NOW on the entry candle, with entry, stop and target', /(BUY|SELL) NOW at [\d,.]+/.test(planText) && /ENTRY/i.test(planText) && /STOP/i.test(planText), planText.slice(0, 120));
  ok('trade plan: both sides say what comes next', (planText.match(/Next:/g) || []).length === 2);
  await page.click('#rStep');
  await page.click('#rStep');
  await page.click('#rStep');
  const later = await page.$eval('#plan .verdict', el => el.innerText);
  ok('trade plan: a few candles later the signal is no longer "now"', !/NOW/.test(later) || /IN A/.test(later), later);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-plan.png') });
  await page.screenshot({ path: path.join(SHOTS, 'desktop-replay.png') });

  // Patterns tab: the table, a pattern's rules and record, and its marks on the chart
  await page.click('#tabPatterns');
  await page.waitForFunction(() => document.querySelectorAll('#patTable [data-pat]').length > 20, null, { timeout: 20000 });
  ok('patterns: the table lists the patterns found', (await page.$$('#patTable [data-pat]')).length > 20);
  await page.click('#patTable [data-pat="bullEngulfing"]');
  const pd = await page.$eval('#patDetail', el => el.innerText);
  ok('patterns: a pattern shows its rule and its record', /Rule\./.test(pd) && /Worked \d+%/.test(pd) && /for any candle/.test(pd), pd.slice(0, 100));
  await page.selectOption('#patCtx', 'zone');
  await page.waitForTimeout(300);
  ok('patterns: counting only inside SMC zones finds fewer', /inside an SMC zone/.test(await page.$eval('#patNote', el => el.innerText)));
  // the pattern lab: its verdict, every context measured, and the honest note
  await page.waitForFunction(() => document.querySelector('#patLab .labv'), null, { timeout: 30000 });
  const lab = await page.$eval('#patLab', el => el.innerText);
  ok('pattern lab: a verdict out of sample', /No proven edge on this data|Edge found, out of sample|Not enough patterns yet/i.test(lab), lab.slice(0, 120));
  ok('pattern lab: every context is in the table', (await page.$$('#patLab .ptable > span')).length >= 5 * 15);
  ok('pattern lab: the verdict reads in words', /NO PROVEN EDGE|EDGE FOUND|NOT ENOUGH/i.test(lab));
  ok('pattern lab: replay says the lab saw the whole data', /after the replay cursor/.test(lab));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-patterns.png') });
  await page.selectOption('#patCtx', 'all');
  await page.click('#patTable [data-pat="bullEngulfing"]');
  await page.click('#tabSignals');

  // a developing setup shows past-setup odds
  await page.check('#showMisses');
  const odds = await page.evaluate(async () => {
    for (const b of document.querySelectorAll('#misses .sig')) {
      b.click();
      await new Promise(r => setTimeout(r, 30));
      const o = document.querySelector('#detail .odds');
      if (o) return o.innerText;
    }
    return '';
  });
  ok('detail card shows setup odds for stopped setups', /Past (buy|sell) setups at this step/.test(odds), odds.slice(0, 100));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-odds.png') });

  // Load your CSV: an MT5 export from a broker on New York close time, converted candle by candle
  {
    const { loadSample } = require(path.join(ROOT, 'live', 'sources.js'));
    const SMC = require(path.join(ROOT, 'engine.js'));
    const bars = loadSample().bars.slice(-3000);
    const pad = n => String(n).padStart(2, '0');
    const rows = bars.map(b => {
      const d = new Date((b.t + (SMC.nyTime(b.t).offsetMin + 420) * 60) * 1000);
      return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}\t${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00\t${b.o}\t${b.h}\t${b.l}\t${b.c}\t${b.v}\t0\t20`;
    });
    const csv = '<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n' + rows.join('\n');
    await page.click('[data-mode="history"]');
    await page.click('#loadBtn');
    ok('csv: the New York close time zone is offered', (await page.$$('#fileTz option[value="nyclose"]')).length === 1);
    await page.selectOption('#fileTz', 'nyclose');
    await page.setInputFiles('#file', { name: 'XAUUSD_M5_export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForFunction(() => /XAUUSD_M5_export\.csv/.test(document.querySelector('#src').innerText), null, { timeout: 10000 });
    const src = await page.$eval('#src', el => el.innerText);
    ok('csv: an MT5 export loads with every candle', /3,000 5m candles/.test(src), src);
    ok('csv: no error', await page.$eval('#fileErr', el => el.hidden));
    // the newest candle is the sample's last one (25 Sept 20:40 UTC), so every time came back to UTC
    const { legend, utc } = await page.evaluate(() => ({
      legend: document.querySelector('#legend').innerText,
      utc: Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC',
    }));
    ok('csv: server times are converted back to UTC', !utc || /25 Sept, 20:40/.test(legend), legend.slice(0, 60));
    await page.click('#loadBtn');
    await page.click('#sampleBtn');
    await page.waitForFunction(() => /getdata\.finance/.test(document.querySelector('#src').innerText), null, { timeout: 10000 });
  }

  // dark theme
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('[data-mode="history"]');
  await hasForecast(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-dark.png') });
  ok('desktop dark: no horizontal overflow', (await overflow(page)) <= 0);

  // phone
  await page.setViewportSize({ width: 400, height: 860 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(400);
  ok('400 px phone: no horizontal overflow', (await overflow(page)) <= 0, `${await overflow(page)} px`);
  await page.screenshot({ path: path.join(SHOTS, 'phone.png'), fullPage: true });
  await page.screenshot({ path: path.join(SHOTS, 'phone-top.png'), fullPage: true, clip: { x: 0, y: 0, width: 400, height: 1900 } });
  await page.screenshot({ path: path.join(SHOTS, 'phone-panel.png'), fullPage: true, clip: { x: 0, y: 1300, width: 400, height: 1900 } });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('[data-mode="replay"]');
  await page.waitForTimeout(300);
  ok('400 px phone replay: no horizontal overflow', (await overflow(page)) <= 0);
  await page.screenshot({ path: path.join(SHOTS, 'phone-dark-replay.png'), fullPage: true, clip: { x: 0, y: 0, width: 400, height: 1900 } });

  ok('artifact scenario: no page or console errors', errors.length === 0, errors.join(' || '));
  await context.close();
}

async function liveScenario(browser) {
  const runner = require(path.join(ROOT, 'live', 'runner.js'));
  const sources = require(path.join(ROOT, 'live', 'sources.js'));
  const SMC = require(path.join(ROOT, 'engine.js'));
  const bars = sources.loadSample().bars;
  const base = runner.loadConfig(null, {});
  const full = SMC.run(bars, base.engine);
  // an entry with no other 5m or 15m entry close to it, so exactly one alert is expected
  const all = full.events.filter(e => e.type === 'entry');
  const full15 = SMC.run(SMC.resample(bars, 900), base.engine);
  const target = all.find(e => e.at > 12000 && !all.some(o => o !== e && Math.abs(o.at - e.at) < 40)
    && !full15.events.some(o => o.type === 'entry' && Math.abs(full15.bars[o.at].t - bars[e.at].t) < 6 * 3600));
  assert.ok(target, 'the sample has a lone 5m entry');
  const entryT = bars[target.at].t;
  const cfg = runner.loadConfig(null, {
    source: 'replay', replay: { startIndex: target.at - 3 }, alerts: { on: 'entry', console: false, bell: false },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-ui-live-'));
  const notifier = { telegramEnabled: false, send: async () => ({ console: false, telegram: null }) };
  const S = new runner.LiveScanner(cfg, { dataDir, notifier, log: () => {}, source: sources.replay(cfg.replay, { tfMinutes: 5, bars }) });
  let r = await S.cycle();
  assert.equal(r.ok, true, r.error);
  // an app around the scanner, so the Setup tab can save to a config file of its own
  const cfgFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ source: 'replay', replay: { startIndex: target.at - 3 }, news: { enabled: false } }));
  const app = new runner.App({ cfgFile, dataDir, log: () => {}, scannerOpts: { notifier } });
  app.scanner = S;
  app.cfg = cfg;
  const server = runner.createServer(app);
  const port = await runner.listen(server, 0);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await routeExternal(context, false);
  const page = await context.newPage();
  const errors = watchErrors(page, false);
  try {
    await page.goto(`http://127.0.0.1:${port}/?poll=1`);
    await page.waitForSelector('#liveBtn:not([hidden])', { timeout: 15000 });
    ok('live: Live mode button is visible when served by the runner', true);
    await page.waitForFunction(() => document.querySelector('#liveBtn').getAttribute('aria-pressed') === 'true', null, { timeout: 10000 }).catch(() => {});
    ok('live: the page opens in Live mode by itself', await page.$eval('#liveBtn', b => b.getAttribute('aria-pressed') === 'true'));
    await page.waitForFunction(() => /Updated \d\d:\d\d/.test(document.querySelector('#lStatus').innerText), null, { timeout: 10000 });
    const status = await page.$eval('#lStatus', el => el.innerText);
    ok('live: status line shows', /Updated \d\d:\d\d · next check|Updated \d\d:\d\d.*source/.test(status), status);
    await hasForecast(page).catch(() => {});
    const card = await nextText(page);
    ok('live: next-move card filled from the runner forecast', /(Up|Down) \d+%/.test(card) || /collecting history/.test(card), card.slice(0, 80));
    // count entry toasts from here on
    await page.evaluate(() => {
      window.__entryToasts = 0;
      new MutationObserver(ms => {
        for (const m of ms) for (const n of m.addedNodes) if (/(BUY|SELL) NOW ·/.test(n.textContent)) window.__entryToasts++;
      }).observe(document.querySelector('#toasts'), { childList: true });
    });
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => window.__entryToasts);
    ok('live: history already present raises no alert', before === 0, String(before));
    for (let k = 0; k < 20 && S.history[S.history.length - 1].t < entryT; k++) {
      r = await S.cycle();
      assert.equal(r.ok, true, r.error);
    }
    assert.equal(S.history[S.history.length - 1].t, entryT);
    await page.waitForFunction(() => window.__entryToasts > 0, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3500);   // several more polls of the same state
    await page.screenshot({ path: path.join(SHOTS, 'live.png') });
    const n = await page.evaluate(() => window.__entryToasts);
    ok('live: a new entry produces exactly one toast', n === 1, String(n));
    ok('live: no horizontal overflow', (await overflow(page)) <= 0);
    await page.setViewportSize({ width: 400, height: 860 });
    await page.waitForTimeout(300);
    ok('live 400 px: no horizontal overflow', (await overflow(page)) <= 0);
    await page.screenshot({ path: path.join(SHOTS, 'live-phone.png'), fullPage: true });
    // the Patterns tab in Live mode shows the scanner's own lab
    await page.click('#tabPatterns');
    await page.waitForFunction(() => document.querySelector('#patLab') && document.querySelector('#patLab').innerText.length > 20, null, { timeout: 15000 });
    const liveLab = await page.$eval('#patLab', el => el.innerText);
    ok('live: the pattern lab comes from the scanner', /of the scanner's history/.test(liveLab) && /No proven edge|Edge found|Not enough patterns/i.test(liveLab), liveLab.slice(-160));
    ok('live 400 px: Patterns tab has no horizontal overflow', (await overflow(page)) <= 0);
    await page.screenshot({ path: path.join(SHOTS, 'live-patterns-phone.png'), fullPage: true });
    await page.click('#tabSignals');
    // back to history still works
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('[data-mode="history"]');
    await page.waitForFunction(() => /Training|Up|Down/.test(document.querySelector('#next').innerText), null, { timeout: 30000 });
    ok('live: leaving Live returns to the loaded history', await page.$eval('#liveBar', b => b.hidden));

    // Setup tab: shows the running source, tests Telegram, saves and restarts the scanner;
    // the app loop runs from here, as it does in the real runner
    const loop = app.runForever({});
    await page.click('[data-mode="live"]');
    await page.waitForSelector('#tabSetup:not([hidden])', { timeout: 10000 });
    await page.click('#tabSetup');
    const st = await page.$eval('#setupStatus', el => el.innerText);
    ok('setup: status names the running source', /Running on replay|Running on/.test(st), st.slice(0, 80));
    ok('setup: every source is offered', (await page.$$('#setup input[name="src"]')).length === 7);
    await page.click('#tgTest');
    await page.waitForFunction(() => /✕|✓/.test(document.querySelector('#tgResult').innerText), null, { timeout: 10000 });
    ok('setup: a Telegram test without a token explains what is missing', /bot token/i.test(await page.$eval('#tgResult', el => el.innerText)));
    await page.check('#setup input[value="yahoo"]');
    ok('setup: choosing a source shows its own fields', await page.$eval('#setup .srcmore[data-for="yahoo"]', el => !el.hidden));
    await page.check('#setup input[value="replay"]');
    await page.fill('#setup [data-k="risk.balance"]', '5000');
    await page.selectOption('#setup [data-k="risk.currency"]', 'INR');
    ok('setup: the exchange rate shows for a non-USD account', await page.$eval('#setup [data-k="risk.usdRate"]', el => !el.closest('label').hidden));
    await page.selectOption('#setup [data-k="risk.currency"]', 'USD');
    await page.screenshot({ path: path.join(SHOTS, 'setup.png') });
    await page.click('#setupSave');
    await page.waitForFunction(() => /✓|✕/.test(document.querySelector('#setupMsg').innerText), null, { timeout: 60000 });
    const saved = await page.$eval('#setupMsg', el => el.innerText);
    ok('setup: save restarts the scanner', /Saved/.test(saved), saved);
    ok('setup: the file holds the new settings', JSON.parse(fs.readFileSync(cfgFile, 'utf8')).risk.balance === 5000);
    ok('setup: the app runs a new scanner', app.scanner !== S);
    await page.waitForFunction(() => /Updated \d\d:\d\d/.test(document.querySelector('#lStatus').innerText), null, { timeout: 30000 }).catch(() => {});
    const after = await page.$eval('#lStatus', el => el.innerText);
    ok('setup: the new scanner checks straight away and the page follows', /Updated \d\d:\d\d/.test(after), after);
    ok('setup: the chart is not empty after the restart', await page.evaluate(() => document.querySelectorAll('#list .sig').length > 0 || /\d/.test(document.querySelector('#legend').innerText)));
    await page.setViewportSize({ width: 400, height: 860 });
    await page.waitForTimeout(300);
    ok('setup 400 px: no horizontal overflow', (await overflow(page)) <= 0);
    await page.screenshot({ path: path.join(SHOTS, 'setup-phone.png'), fullPage: true });
    ok('live scenario: no page or console errors', errors.length === 0, errors.join(' || '));
    app.stop();
    await loop;
  } finally {
    await context.close();
    app.stop();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// No chart library (a blocked CDN, no internet): the page says so instead of staying blank.
async function noLibraryScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN + '/')) {
      const p = decodeURIComponent(new URL(url).pathname);
      if (p === '/' || p === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: wrap(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) });
      const file = path.join(ROOT, p);
      if (fs.existsSync(file) && file.startsWith(ROOT + path.sep)) return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'text/plain', body: fs.readFileSync(file) });
    }
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(ORIGIN + '/index.html');
  await page.waitForTimeout(800);
  const msg = await page.$eval('#chart', el => el.innerText);
  ok('no chart library: the page explains it', /chart library could not load/.test(msg), msg.slice(0, 60));
  ok('no chart library: no script errors', errors.length === 0, errors.join(' || '));
  await page.screenshot({ path: path.join(SHOTS, 'no-library.png') });
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await artifactScenario(browser);
    await liveScenario(browser);
    await noLibraryScenario(browser);
  } catch (err) {
    ok('ran without exceptions', false, err.stack);
  } finally {
    await browser.close();
  }
  const failed = results.filter(r => !r[1]).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})();
