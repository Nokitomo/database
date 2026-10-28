'use strict';

const {sleep} = require('./lib');

const MIN_GAP_MS = Object.freeze({
  'api.themoviedb.org': 250,
  'www.themoviedb.org': 500,
  'www.thetvdb.com': 350,
});

function retryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function createPacedGet(get, options = {}) {
  const now = options.now || Date.now;
  const wait = options.sleep || sleep;
  const gaps = options.gaps || MIN_GAP_MS;
  const check = options.check || (() => {});
  const nextAt = new Map();
  const blockedUntil = new Map();
  return async (url, requestOptions) => {
    const host = new URL(url).hostname.toLowerCase();
    const gap = gaps[host] || 0;
    if (!gap) { check(); return get(url, requestOptions); }
    for (let attempt = 0; attempt < 5; attempt++) {
      const at = now();
      const slot = Math.max(at, nextAt.get(host) || 0, blockedUntil.get(host) || 0);
      nextAt.set(host, slot + gap);
      if (slot > at) await wait(slot - at);
      while ((blockedUntil.get(host) || 0) > now()) {
        await wait(blockedUntil.get(host) - now());
      }
      check();
      try { return await get(url, requestOptions); }
      catch (error) {
        if (Number(error?.response?.status) !== 429 || attempt === 4) throw error;
        const headers = error.response?.headers;
        const header = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
        const pause = Math.max(2000, retryAfterMs(header, now()) ?? Math.min(30000, 2000 * 2 ** attempt));
        blockedUntil.set(host, Math.max(blockedUntil.get(host) || 0, now() + pause));
      }
    }
  };
}

module.exports = {MIN_GAP_MS, createPacedGet, retryAfterMs};
