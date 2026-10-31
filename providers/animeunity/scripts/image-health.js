'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const {DATA, readJson, writeJson} = require('./lib');
const {assertWarp} = require('./warp');
const {buildArtworkFallbacks} = require('./artwork-fallbacks');
const DAY = 86400000;
const RETRY = 6 * 3600000;
const stateFile = root => path.join(root, 'image-health.json');

function imageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname) &&
      !/\.(?:local|internal)$/i.test(url.hostname) ? url : null;
  } catch { return null; }
}
function providerImage(value) {
  const url = imageUrl(value);
  return !!url && /^(?:img|images|cdn)\.animeunity\.[a-z]{2,}$/i.test(url.hostname);
}
function strings(value, output = new Set()) {
  if (typeof value === 'string') output.add(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(child => strings(child, output));
  return output;
}
function visibleImages(record = {}) {
  return [...strings([record.info, record.episodes, record.artworkInventory, record.artworkLibrary])]
    .filter(providerImage);
}
function replaceExact(value, replacements) {
  if (typeof value === 'string') return resolvedUrl(value, replacements);
  if (Array.isArray(value)) return value.map(child => replaceExact(child, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, replaceExact(child, replacements)]));
  return value;
}
function resolvedUrl(url, replacements) {
  const seen = new Set();
  let current = url;
  while (replacements[current]?.url) {
    if (seen.has(current)) return url;
    seen.add(current);
    current = replacements[current].url;
  }
  return current;
}
function applyImageReplacements(record, replacements) {
  const before = [record.info, record.episodes, record.artworkInventory, record.artworkLibrary];
  if (![...strings(before)].some(url => replacements[url])) return record;
  const [info, episodes, artworkInventory, artworkLibrary] = replaceExact(before, replacements);
  info.extra ||= {};
  info.extra.artworkFallbacks = buildArtworkFallbacks(info, artworkInventory);
  return {...record, info, episodes, artworkInventory, ...(artworkLibrary ? {artworkLibrary} : {})};
}

async function http(method, url, signal, extra = {}) {
  signal?.throwIfAborted();
  assertWarp();
  return axios({method, url, signal, timeout: 10000, maxRedirects: 3,
    maxContentLength: 256 * 1024, headers: {'User-Agent': 'Mozilla/5.0 (compatible; AnimeDatabase/1.0)'}, ...extra});
}
async function probeImage(url, signal, transport = http) {
  if (!imageUrl(url)) return false;
  const valid = response => response.status >= 200 && response.status < 300 &&
    /^image\//i.test(response.headers?.['content-type'] || '');
  try { if (valid(await transport('head', url, signal))) return true; } catch { /* Some CDNs reject HEAD. */ }
  signal?.throwIfAborted();
  try {
    return valid(await transport('get', url, signal, {responseType: 'arraybuffer',
      headers: {Range: 'bytes=0-4095'}, maxContentLength: 64 * 1024}));
  } catch { signal?.throwIfAborted(); return false; }
}

// Match the same provider field, never infer a new hostname by changing the site TLD.
function pairFields(old, current, pairs = new Map()) {
  if (!old || !current || typeof old !== 'object' || typeof current !== 'object') return pairs;
  for (const [key, value] of Object.entries(old)) {
    if (providerImage(value) && imageUrl(current[key]) && current[key] !== value) pairs.set(value, current[key]);
    else if (value && typeof value === 'object' && !Array.isArray(value)) pairFields(value, current[key], pairs);
  }
  return pairs;
}

async function maintainImages({root = DATA, now = Date.now(), probe = probeImage,
  discoverBase = async signal => (await require('./source').discover(signal)).baseUrl,
  fetchInfo = async (base, id, signal) => (await http('get', `${base}/info_api/${id}/`, signal)).data,
  fetchEpisode = async (base, id, number, signal) => (await http('get',
    `${base}/info_api/${id}/1?start_range=${number}&end_range=${number}`, signal)).data?.episodes || [],
  log = console.log, budgetMs = 120000} = {}) {
  const state = readJson(stateFile(root), {schemaVersion: 1, cursor: 0, nextCheckAt: 0,
    replacements: {}, hosts: {}, pending: {}});
  const due = now >= state.nextCheckAt;
  const ready = Object.entries(state.pending).filter(([, entry]) => now >= entry.nextCheckAt).slice(0, 3).map(([id]) => Number(id));
  if (!due && !ready.length) return {changed: 0, checked: 0};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const signal = controller.signal;
  let checked = 0;
  let changed = 0;
  let processed = 0;
  try {
    const directory = path.join(root, 'final/items');
    if (!fs.existsSync(directory)) return {changed, checked};
    const ids = fs.readdirSync(directory).filter(name => /^\d+\.json$/.test(name))
      .map(name => Number(name.slice(0, -5))).sort((a, b) => a - b);
    const selected = new Set(ready);
    if (due) {
      for (let offset = 0; offset < Math.min(5, ids.length); offset++)
        selected.add(ids[(state.cursor + offset) % ids.length]);
      state.cursor = ids.length ? (state.cursor + 5) % ids.length : 0;
      state.sampleRound = (state.sampleRound || 0) + 1;
      state.nextCheckAt = now + DAY;
    }
    let base;
    const newlyChangedHosts = new Set();
    for (const id of selected) {
      signal.throwIfAborted();
      processed++;
      const filename = path.join(directory, `${id}.json`);
      const original = readJson(filename);
      if (!original) { delete state.pending[id]; continue; }
      let record = applyImageReplacements(original, state.replacements);
      const urls = visibleImages(record);
      const pending = state.pending[id];
      const ok = new Set(pending?.ok || []);
      const retry = {...pending?.retry};
      const candidates = pending ? urls.filter(url => new URL(url).origin === pending.origin &&
        !ok.has(url) && now >= (retry[url] || 0)) :
        urls.length ? [urls[((state.sampleRound || 0) + id) % urls.length]] : [];
      let remaining = false;
      let pairs;
      for (const oldUrl of candidates.slice(0, 3)) {
        signal.throwIfAborted();
        checked++;
        if (await probe(oldUrl, signal)) { ok.add(oldUrl); continue; }
        // A failed probe alone never changes or deletes an image.
        remaining = true;
        retry[oldUrl] = now + RETRY;
        state.pending[id] = {origin: new URL(oldUrl).origin, ok: [...ok], retry, nextCheckAt: now + RETRY};
        base ||= await discoverBase(signal);
        if (!pairs) {
          const info = await fetchInfo(base, id, signal);
          if (Number(info?.id) !== id) throw new Error('Unexpected provider image metadata');
          pairs = pairFields(record.sourceMetadata?.info, info);
          pairFields(record.sourceMetadata?.embedded, info, pairs);
        }
        let candidate = pairs.get(oldUrl);
        if (!candidate) for (const [originalUrl, currentUrl] of pairs) {
          if (resolvedUrl(originalUrl, state.replacements) === oldUrl) { candidate = currentUrl; break; }
        }
        if (!candidate) {
          const sourceEpisode = (record.sourceEpisodes || []).find(episode => [...strings(episode)]
            .some(value => resolvedUrl(value, state.replacements) === oldUrl));
          const number = Number(sourceEpisode?.number);
          if (sourceEpisode && Number.isFinite(number) && number >= 0) {
            const episodes = await fetchEpisode(base, id, number, signal);
            const current = episodes.find(episode => String(episode.id) === String(sourceEpisode.id));
            for (const [originalUrl, currentUrl] of pairFields(sourceEpisode, current)) {
              if (resolvedUrl(originalUrl, state.replacements) === oldUrl) { candidate = currentUrl; break; }
            }
          }
        }
        const origin = new URL(oldUrl).origin;
        // A host previously observed on a provider page is only a candidate;
        // this individual image still needs a successful content-type check.
        if (!candidate && state.hosts[origin]) {
          const parsed = new URL(oldUrl);
          candidate = new URL(parsed.pathname + parsed.search, state.hosts[origin]).href;
        }
        if (!candidate || candidate === oldUrl || !await probe(candidate, signal)) continue;
        state.replacements[oldUrl] = {url: candidate, verifiedAt: new Date(now).toISOString()};
        const newOrigin = new URL(candidate).origin;
        if (newOrigin !== origin) {
          state.hosts[origin] = newOrigin;
          newlyChangedHosts.add(origin);
        }
        record = applyImageReplacements(record, {[oldUrl]: state.replacements[oldUrl]});
        changed++;
        log(`[image-health] anime=${id}: verified image replacement`);
      }
      if (record !== original) writeJson(filename, record);
      if (pending || remaining) {
        const origin = pending?.origin || new URL(candidates[0]).origin;
        const unresolved = visibleImages(record).filter(url => new URL(url).origin === origin && !ok.has(url));
        if (unresolved.length) state.pending[id] = {origin, ok: [...ok], retry,
          nextCheckAt: Math.min(...unresolved.map(url => retry[url] || now))};
        else delete state.pending[id];
      }
    }
    // Build a repair queue; each record is refreshed and each replacement checked individually.
    if (newlyChangedHosts.size) for (const id of ids) {
      const record = readJson(path.join(directory, `${id}.json`));
      const origin = visibleImages(record).map(url => new URL(url).origin).find(host => newlyChangedHosts.has(host));
      if (origin && !state.pending[id]) state.pending[id] = {origin, nextCheckAt: now};
    }
    state.lastCheckAt = new Date(now).toISOString();
  } catch (error) {
    state.nextCheckAt = Math.min(state.nextCheckAt || Infinity, now + RETRY);
    log(`[image-health] check deferred: ${signal.aborted ? 'time budget' : 'provider or network unavailable'}`);
  } finally {
    clearTimeout(timer);
    writeJson(stateFile(root), state);
  }
  log(`[image-health] checked=${checked} replaced=${changed} pending=${Object.keys(state.pending).length}`);
  return {changed, checked, processed};
}

module.exports = {maintainImages, applyImageReplacements, probeImage, pairFields, providerImage};
