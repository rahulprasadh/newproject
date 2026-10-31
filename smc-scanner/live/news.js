/*
 * High-impact news from the free Forex Factory weekly calendar (no key). Gold jumps on US
 * releases (CPI, NFP, FOMC), so alerts say when one is close. The calendar is fetched at most
 * once an hour and kept in live/data/news.json; if it cannot be reached, the last copy is used
 * and alerts simply carry no news line.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { request } = require('./http.js');

const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NEWS_DEFAULTS = {
  enabled: true, currencies: ['USD'], impact: ['High'], beforeMinutes: 30, afterMinutes: 15,
  refreshMinutes: 60, url: '',
};

// [{t (unix s), title, country, impact, forecast, previous}], oldest first
function parseCalendar(list) {
  if (!Array.isArray(list)) throw new Error('the calendar is not a list of events');
  const out = [];
  for (const e of list) {
    const t = Date.parse(e && e.date) / 1000;
    if (!Number.isFinite(t) || !e.title) continue;
    out.push({
      t, title: String(e.title), country: String(e.country || ''), impact: String(e.impact || ''),
      forecast: e.forecast || '', previous: e.previous || '',
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

function createNews(cfg = {}, { dataDir, log = () => {}, clock = () => Date.now(), fetchJson } = {}) {
  const o = { ...NEWS_DEFAULTS, ...cfg };
  const file = dataDir ? path.join(dataDir, 'news.json') : null;
  const want = e => o.currencies.map(c => c.toUpperCase()).includes(e.country.toUpperCase())
    && o.impact.map(x => x.toLowerCase()).includes(e.impact.toLowerCase());
  let cache = { fetchedAt: 0, events: [], error: null };
  if (file) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(c.events)) cache = { fetchedAt: +c.fetchedAt || 0, events: c.events, error: null };
    } catch (err) { /* no copy yet */ }
  }
  const get = fetchJson || (async url => {
    const res = await request(url, { timeoutMs: 15000, headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    try {
      return JSON.parse(res.body);
    } catch (err) {
      throw new Error('the calendar sent something that is not JSON (too many requests?)');
    }
  });
  let warned = false;

  const api = {
    enabled: !!o.enabled,
    options: o,
    get error() { return cache.error; },
    get fetchedAt() { return cache.fetchedAt; },

    // Fetch the calendar if the copy is older than refreshMinutes. Never throws.
    async refresh({ force = false } = {}) {
      if (!o.enabled) return false;
      const now = clock();
      if (!force && now - cache.fetchedAt < o.refreshMinutes * 60000) return false;
      try {
        const events = parseCalendar(await get(o.url || FEED));
        cache = { fetchedAt: now, events, error: null };
        warned = false;
        if (file) {
          try {
            fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, events }));
          } catch (err) { /* the copy is a convenience */ }
        }
        return true;
      } catch (err) {
        // try again in 15 minutes, not on every check
        cache.fetchedAt = now - Math.max(0, o.refreshMinutes - 15) * 60000;
        cache.error = `News calendar unavailable: ${err.message}`;
        if (!warned) log(`${cache.error}. Alerts go out without news warnings until it is back.`);
        warned = true;
        return false;
      }
    },

    // Wanted events from beforeMinutes before t to afterMinutes after it, with minutes from t.
    near(t) {
      if (!o.enabled) return [];
      return cache.events.filter(e => want(e) && e.t >= t - o.afterMinutes * 60 && e.t <= t + o.beforeMinutes * 60)
        .map(e => ({ ...e, minutes: Math.round((e.t - t) / 60) }));
    },

    // Wanted events in the next `hours` hours after t (and the ones that just happened).
    upcoming(t, hours = 24) {
      if (!o.enabled) return [];
      return cache.events.filter(e => want(e) && e.t >= t - o.afterMinutes * 60 && e.t <= t + hours * 3600);
    },
  };
  return api;
}

module.exports = { createNews, parseCalendar, NEWS_DEFAULTS, FEED };
