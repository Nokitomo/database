'use strict';

const {sleep} = require('./lib');
const metrics = require('../../../shared/metrics');

const MIN_GAP_MS = Object.freeze({
  'api.themoviedb.org': 250,
  'www.themoviedb.org': 500,
  'www.thetvdb.com': 350,
});
const MAX_RETRY_WAIT_MS = 60_000;

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
  const admissions = new Map();
  const limitedError = (host, until) => {
    const error = new Error(`Rate limit deferred for ${host}`);
    error.response = {status: 429};error.code = 'RATE_LIMIT_DEFERRED';
    error.retryAt = until;error.retryAfterMs = Math.max(0, until - now());return error;
  };
  return async (url, requestOptions, cooldownStore) => {
    const host = new URL(url).hostname.toLowerCase();
    const gap = gaps[host] || 0;
    const bucket = metrics.service(url);
    const pauseFor = async ms => {
      const start = now();
      try {
        if (requestOptions?.signal && !options.sleep) await require('node:timers/promises').setTimeout(ms, undefined, {signal: requestOptions.signal});
        else await wait(ms);
      } finally { metrics.add(bucket, 'limiterWaitMs', Math.max(0, now() - start)); }
    };
    if (!gap) { check(); return metrics.request(url, () => get(url, requestOptions)); }
    for (let attempt = 0; attempt < 5; attempt++) {
      const admission = (admissions.get(host) || Promise.resolve()).catch(() => {}).then(async () => {
        while (true) {
          requestOptions?.signal?.throwIfAborted();
          const at = now(), until = Math.max(blockedUntil.get(host) || 0, cooldownStore?.read(host) || 0);
          if (until - at > MAX_RETRY_WAIT_MS) throw limitedError(host, until);
          const slot = Math.max(at, nextAt.get(host) || 0, until);
          if (slot <= at) {nextAt.set(host, at + gap);return;}
          await pauseFor(slot - at);
        }
      });
      admissions.set(host, admission);
      await admission;
      check();
      try { return await metrics.request(url, () => get(url, requestOptions)); }
      catch (error) {
        if (Number(error?.response?.status) !== 429) throw error;
        const headers = error.response?.headers;
        const header = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
        const pause = Math.max(2000, retryAfterMs(header, now()) ?? Math.min(30000, 2000 * 2 ** attempt));
        blockedUntil.set(host, Math.max(blockedUntil.get(host) || 0, now() + pause));
        cooldownStore?.write(host, blockedUntil.get(host));
        if (pause > MAX_RETRY_WAIT_MS) {
          throw limitedError(host, blockedUntil.get(host));
        }
        if (attempt === 4) throw error;
        metrics.add(bucket, 'retryDecisions');
      }
    }
  };
}

module.exports = {MIN_GAP_MS, MAX_RETRY_WAIT_MS, createPacedGet, retryAfterMs};
