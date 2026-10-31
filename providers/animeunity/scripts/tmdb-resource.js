'use strict';
const path = require('node:path');
const {DATA, readJson, writeJson, hash} = require('./lib');
const {seasonOf} = require('./mapping-policy');
const DAY = 86400000;

function resourcePath(url) {
  const parsed = new URL(url);
  if (!['api.themoviedb.org', 'www.themoviedb.org'].includes(parsed.hostname)) return null;
  // Only core resources: a missing translation/gallery does not invalidate the title.
  const route = parsed.pathname.replace(/^\/3(?=\/)/, '').replace(/\/$/, '');
  return /^\/(movie|tv)\/\d+(?:\/season\/\d+(?:\/episode\/\d+)?)?$/.test(route) ? route : null;
}
function createResourceCache({root = path.join(DATA, 'enrichment-cache', 'tmdb-resources'), now = Date.now} = {}) {
  const file = route => path.join(root, hash(route) + '.json');
  const read = route => {
    const value = readJson(file(route));
    return value?.nextCheckAt > now() ? value : null;
  };
  const save = (route, status, details = {}) => {
    const old = readJson(file(route));
    const attempts = status === 'error' ? (old?.attempts || 0) + 1 : 0;
    const wait = status === 'error' ? Math.min(7 * DAY, 3600000 * 2 ** Math.min(attempts - 1, 8)) : 30 * DAY;
    const value = {route, status, checkedAt: now(), nextCheckAt: now() + wait, attempts, ...details};
    writeJson(file(route), value); return value;
  };
  const missing = url => {
    const parsed = new URL(url);
    if (!['api.themoviedb.org', 'www.themoviedb.org'].includes(parsed.hostname)) return null;
    const parts = parsed.pathname.replace(/^\/3(?=\/)/, '').split('/');
    for (const length of [3, 5, 7]) {
      if (parts.length < length) continue;
      const route = parts.slice(0, length).join('/');
      if (!resourcePath('https://www.themoviedb.org' + route)) continue;
      const value = read(route);
      if (value?.status === 'missing') return value;
    }
    return null;
  };
  return {read, save, missing};
}

async function validateTarget(target, context, cache, apiKey = process.env.TMDB_API_KEY) {
  const base = `/${target.provider === 'tmdb_movie' ? 'movie' : 'tv'}/${target.id}`;
  const season = seasonOf(target);
  const route = base + (target.provider === 'tmdb_show' && season !== null ? `/season/${season}` : '');
  const cached = cache.read(route);
  if (cached) return cached;
  const key = String(apiKey || '').trim().replace(/^Bearer\s+/i, '');
  const token = /^eyJ[A-Za-z0-9_-]+\./.test(key);
  try {
    if (key) {
      const response = await context.axios.get(`https://api.themoviedb.org/3${route}`, {
        timeout: 15000, params: token ? {} : {api_key: key},
        headers: token ? {Authorization: `Bearer ${key}`} : {},
      });
      const body = response.data;
      if (!body || (season === null ? Number(body.id) !== Number(target.id) : Number(body.season_number) !== season))
        throw new Error('Unrecognized TMDB validation response');
    } else {
      const response = await context.axios.get(`https://www.themoviedb.org${route}`, {timeout: 15000});
      const $ = context.cheerio.load(response.data);
      const canonical = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content');
      const canonicalPath = canonical ? new URL(canonical).pathname.replace(/\/(tv|movie)\/(\d+)-[^/]+/, '/$1/$2').replace(/\/$/, '') : '';
      if (canonicalPath !== route || !$('h2 a, h2, h1').text().trim())
        throw new Error('Unrecognized TMDB validation page');
    }
    return cache.save(route, 'ok');
  } catch (error) {
    context.signal?.throwIfAborted();
    const status = Number(error?.response?.status) || 0;
    return cache.save(route, status === 404 ? 'missing' : 'error', {httpStatus: status || null});
  }
}
module.exports = {resourcePath, createResourceCache, validateTarget};
