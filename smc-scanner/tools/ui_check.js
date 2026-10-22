#!/usr/bin/env node
// Browser check of index.html (Playwright + Chromium). Not part of `node --test`.
//   LWC_PATH=/path/to/lightweight-charts.standalone.production.js node smc-scanner/tools/ui_check.js [shotDir]
// Scenario 1 serves the page the way the claude.ai artifact host does (no api/state).
// Scenario 2 runs the live runner on the replay source and opens it in Live mode.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const LWC_PATH = process.env.LWC_PATH;
const SHOTS = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'smc-ui-shots'));
const LWC_URL = 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js';
const ORIGIN = 'https://artifact.test';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };

if (!LWC_PATH || !fs.existsSync(LWC_PATH)) {
  console.error('Set LWC_PATH to a local copy of lightweight-charts 4.2.3 (standalone production build).');
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
  ok('replay: Next signal finds an entry and toasts', /(Buy|Sell) signal/.test(toast), toast.slice(0, 80));
  const detail = await page.$eval('#detail', el => el.innerText);
  ok('detail card shows liquidity label, session and HTF trend', /swept|Liquidity sweep ·/.test(detail) && /HTF trend/.test(detail));
  await page.screenshot({ path: path.join(SHOTS, 'desktop-replay.png') });

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
  const server = runner.createServer(S);
  const port = await runner.listen(server, 0);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await routeExternal(context, false);
  const page = await context.newPage();
  const errors = watchErrors(page, false);
  try {
    await page.goto(`http://127.0.0.1:${port}/?poll=1`);
    await page.waitForSelector('#liveBtn:not([hidden])', { timeout: 15000 });
    ok('live: Live mode button is visible when served by the runner', true);
    await page.click('#liveBtn');
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
        for (const m of ms) for (const n of m.addedNodes) if (/signal ·/.test(n.textContent)) window.__entryToasts++;
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
    // back to history still works
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('[data-mode="history"]');
    await page.waitForFunction(() => /Training|Up|Down/.test(document.querySelector('#next').innerText), null, { timeout: 30000 });
    ok('live: leaving Live returns to the loaded history', await page.$eval('#liveBar', b => b.hidden));
    ok('live scenario: no page or console errors', errors.length === 0, errors.join(' || '));
  } finally {
    await context.close();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  const browser = await chromium.launch();
  try {
    await artifactScenario(browser);
    await liveScenario(browser);
  } catch (err) {
    ok('ran without exceptions', false, err.stack);
  } finally {
    await browser.close();
  }
  const failed = results.filter(r => !r[1]).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})();
