'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const {sleep} = require('./lib');
const {assertWarp} = require('./warp');

const PASTEBIN_URL = 'https://pastebin.com/raw/KgQ4jTy6';
const FALLBACK_URL = 'https://www.animeunity.co';
const HEADERS = {'User-Agent': 'Mozilla/5.0 (compatible; AnimeDatabase/1.0)', Accept: 'application/json, text/html, application/xml'};

async function request(method, url, data, extra = {}) {
  const {signal, ...headers} = extra;
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      signal?.throwIfAborted();
      assertWarp();
      const response = await axios({method, url, data, timeout: 20000, maxRedirects: 5,
        signal, headers: {...HEADERS, ...headers}, validateStatus: status => status < 500});
      if (response.status >= 400) throw new Error(`HTTP ${response.status} at ${url}`);
      return response;
    } catch (error) {
      last = error;
      signal?.throwIfAborted();
      if (attempt < 2) await sleep(700 * (attempt + 1));
    }
  }
  throw last;
}

function sitemapItems(xml, baseUrl) {
  const urls = [...String(xml).matchAll(/<loc>\s*([^<]+)\s*<\/loc>/g)].map(match => match[1].trim());
  const items = new Map();
  for (const value of urls) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/anime\/(\d+)-([^/]+)\/?$/i);
      if (!match) continue;
      items.set(Number(match[1]), {id: Number(match[1]), slug: match[2], path: url.pathname, url: new URL(url.pathname, baseUrl).href});
    } catch (_) { /* Invalid sitemap URL. */ }
  }
  return items;
}

async function discover() {
  let pasteError = null;
  let pasteUrl = null;
  try {
    const text = String((await request('get', PASTEBIN_URL)).data);
    pasteUrl = [...text.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(value => value[0])
      .find(value => { try { return /(^|\.)animeunity\./i.test(new URL(value).hostname); } catch { return false; } });
  } catch (error) { pasteError = error.message; }
  const candidates = [...new Set([pasteUrl, FALLBACK_URL].filter(Boolean))];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const origin = new URL(candidate).origin;
      const response = await request('get', `${origin}/sitemap.xml`);
      const final = new URL(response.request?.res?.responseUrl || `${origin}/sitemap.xml`);
      if (!/^https:$/.test(final.protocol) || !/(^|\.)animeunity\.[a-z]+$/i.test(final.hostname)) throw new Error('Invalid final host');
      const items = sitemapItems(response.data, final.origin);
      if (items.size < 1000) throw new Error(`Sitemap unexpectedly small: ${items.size}`);
      const probeId = items.keys().next().value;
      const probe = await request('get', `${final.origin}/info_api/${probeId}/`);
      if (Number(probe.data?.id) !== probeId) throw new Error('Info API returned unexpected content');
      return {baseUrl: final.origin, source: candidate === pasteUrl ? 'pastebin' : 'fallback', pasteUrl, pasteError, sitemap: items};
    } catch (error) { failures.push(`${candidate}: ${error.message}`); }
  }
  throw new Error(`AnimeUnity unavailable. Pastebin: ${pasteError || 'readable'}. ${failures.join(' | ')}`);
}

async function archiveItems(baseUrl) {
  const home = await request('get', `${baseUrl}/`);
  const cookie = (home.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
  const csrf = String(home.data).match(/name=["']csrf-token["']\s+content=["']([^"']+)/i)?.[1];
  const xsrf = (home.headers['set-cookie'] || []).join('; ').match(/XSRF-TOKEN=([^;]+)/)?.[1];
  const headers = {Origin: baseUrl, Referer: `${baseUrl}/archivio`, 'Content-Type': 'application/json',
    ...(cookie ? {Cookie: cookie} : {}), ...(xsrf || csrf ? {'X-XSRF-TOKEN': decodeURIComponent(xsrf || csrf)} : {})};
  const items = new Map();
  let total = null;
  for (let offset = 0; ; offset += 30) {
    const payload = {title: false, type: false, year: false, order: false, status: false,
      genres: false, offset, dubbed: false, season: false};
    const response = await request('post', `${baseUrl}/archivio/get-animes`, payload, headers);
    if (!Array.isArray(response.data?.records)) throw new Error(`Invalid archive response at offset ${offset}`);
    if (Number.isFinite(response.data.tot)) total = response.data.tot;
    for (const record of response.data.records) {
      const id = Number(record?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const slug = String(record.slug || '').trim();
      items.set(id, {id, slug, path: `/anime/${id}-${slug}`, url: `${baseUrl}/anime/${id}-${slug}`, archiveRecord: record});
    }
    if (response.data.records.length < 30 || (total != null && offset + 30 >= total)) break;
    if (offset > 50000) throw new Error('Archive pagination exceeded safety bound');
    await sleep(250);
  }
  if (total != null && items.size !== total) throw new Error(`Archive count mismatch: ${items.size}/${total}`);
  return {items, total};
}

function parseEmbedded(html) {
  const $ = cheerio.load(String(html));
  const node = $('video-player').first();
  const parse = name => {
    try { return JSON.parse(node.attr(name) || 'null'); } catch { return null; }
  };
  return {anime: parse('anime'), episodes: parse('episodes') || []};
}

function episodeBounds(number) {
  const match = String(number ?? '').trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
  return match ? {start: Number(match[1]), end: Number(match[2] || match[1])} : null;
}

async function fetchAnime(item, baseUrl, fetch = request, signal) {
  const [infoResult, htmlResult] = await Promise.allSettled([
    fetch('get', `${baseUrl}/info_api/${item.id}/`, null, {Referer: `${baseUrl}/`, signal}),
    fetch('get', new URL(item.path, baseUrl).href, null, {signal}),
  ]);
  signal?.throwIfAborted();
  if (infoResult.status === 'rejected') throw infoResult.reason;
  const info = infoResult.value.data;
  if (Number(info?.id) !== item.id) throw new Error(`Invalid info payload for anime ${item.id}`);
  const embedded = htmlResult.status === 'fulfilled'
    ? parseEmbedded(htmlResult.value.data) : {anime: null, episodes: []};
  const byId = new Map();
  const append = episode => { if (episode?.id != null) byId.set(String(episode.id), episode); };
  embedded.episodes.forEach(append);
  const bounds = embedded.episodes.map(e => episodeBounds(e.number)).filter(Boolean);
  // The embedded count can describe planned episodes even when none are available yet.
  const availableCount = Number(info.episodes_count);
  const count = availableCount === 0 && embedded.episodes.length === 0 ? 0 :
    Math.max(availableCount || 0, Number(embedded.anime?.episodes_count) || 0, embedded.episodes.length);
  const minimum = Math.min(...bounds.map(value => value.start));
  const maximum = Math.max(...bounds.map(value => value.end));
  const absolute = Number.isFinite(minimum) && (count ? minimum > count * 1.5 : minimum > 1);
  const from = absolute ? minimum : 0;
  const to = absolute ? maximum : count;
  if (count > 0 || embedded.episodes.length > 0) {
    for (let start = from; start <= to; start += 120) {
      const end = Math.min(to, start + 119);
      const response = await fetch('get', `${baseUrl}/info_api/${item.id}/1?start_range=${start}&end_range=${end}`, null, {Referer: `${baseUrl}/`, signal});
      signal?.throwIfAborted();
      if (!Array.isArray(response.data?.episodes)) throw new Error(`Invalid episodes payload for anime ${item.id}`);
      response.data.episodes.forEach(append);
      await sleep(150);
    }
  }
  return {id: item.id, path: item.path, slug: item.slug, info, embeddedAnime: embedded.anime,
    htmlError: htmlResult.status === 'rejected' ? htmlResult.reason.message : null,
    episodes: [...byId.values()].sort((a, b) => (episodeBounds(a.number)?.start ?? Infinity) - (episodeBounds(b.number)?.start ?? Infinity))};
}

module.exports = {FALLBACK_URL, PASTEBIN_URL, archiveItems, discover, episodeBounds, fetchAnime, parseEmbedded, request, sitemapItems};
