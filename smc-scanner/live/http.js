// Tiny HTTP(S) client on node:http/https, so Node 18 needs no fetch and prints no warnings.
'use strict';
const http = require('node:http');
const https = require('node:https');

function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(new Error('The address is not a valid URL'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) {
      reject(new Error(`Unsupported address type ${u.protocol}`));
      return;
    }
    const data = body === null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { 'user-agent': 'gold-smc-scanner', ...headers };
    if (data) h['content-length'] = data.length;
    const req = lib.request(u, { method, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { request };
