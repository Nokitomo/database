'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const cheerio = require('cheerio');
const {ROOT, hash, readJson, writeJson} = require('./lib');
const {episodeBounds} = require('./source');
const {assertWarp} = require('./warp');
const {createPacedGet} = require('./rate-limit');
const {createTmdbGet} = require('./tmdb-http');
const {normalizeRelatedLinks} = require('./provider-links');
const {buildArtworkFallbacks} = require('./artwork-fallbacks');

const pacedGet = createPacedGet((url, options) => axios.get(url, options), {check: assertWarp});
const tmdbGet = createTmdbGet(pacedGet);
let tmdbArtworkSamples = 0;
const MAX_EXTERNAL_REQUEST_MS = 30_000;

function boundedRequestOptions(options = {}, signal) {
  const requested = Number(options.timeout);
  return {...options, signal: signal || options.signal,
    timeout: requested > 0 ? Math.min(requested, MAX_EXTERNAL_REQUEST_MS) : MAX_EXTERNAL_REQUEST_MS};
}

function requireProvider(providerRoot, modulePath) {
  const absolute = path.resolve(providerRoot, 'dist', 'animeunity', modulePath);
  if (!fs.existsSync(absolute)) throw new Error(`Vega provider build missing: ${absolute}`);
  return require(absolute);
}

function createContext(providerRoot, baseUrl, raw = null, contextOptions = {}) {
  const cacheDir = path.join(ROOT, '.cache', 'vega');
  const memory = new Map();
  const externalStatus = {tmdbWeb: {attempts: 0, transientFailures: 0, lastFailureCode: null}};
  const cachePath = key => path.join(cacheDir, `${hash(key)}.json`);
  const client = {
    ...axios,
    get: async (url, options) => {
      contextOptions.signal?.throwIfAborted();
      if (raw && new URL(url).origin === baseUrl) {
        const parsed = new URL(url);
        if (parsed.pathname === `/info_api/${raw.id}/`) return Promise.resolve({data: raw.info});
        if (parsed.pathname === `/anime/${raw.id}-${raw.slug}` || parsed.pathname === `/anime/${raw.id}-${raw.slug}/`) {
          const content = JSON.stringify(raw.embeddedAnime || {}).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
          return Promise.resolve({data: `<video-player anime="${content}"></video-player>`});
        }
        if (parsed.pathname === `/info_api/${raw.id}/1`) {
          const start = Number(parsed.searchParams.get('start_range') || 0);
          const end = Number(parsed.searchParams.get('end_range') || Infinity);
          const episodes = raw.episodes.filter(value => {
            const number = Number.parseFloat(String(value.number));
            return Number.isFinite(number) && number >= start && number <= end;
          });
          return Promise.resolve({data: {episodes}});
        }
      }
      const isTmdbWeb = new URL(url).hostname.toLowerCase() === 'www.themoviedb.org';
      if (isTmdbWeb) externalStatus.tmdbWeb.attempts++;
      try {
        return await (contextOptions.httpGet || tmdbGet)(url, boundedRequestOptions(options, contextOptions.signal));
      } catch (error) {
        const status = Number(error?.response?.status) || 0;
        if (isTmdbWeb && status !== 404) {
          externalStatus.tmdbWeb.transientFailures++;
          externalStatus.tmdbWeb.lastFailureCode = status ? `HTTP_${status}` :
            String(error?.code || 'NETWORK').replace(/[^A-Z0-9_]/gi, '').slice(0, 32);
        }
        throw error;
      }
    },
    post: (url, data, options) => {contextOptions.signal?.throwIfAborted(); assertWarp(); return axios.post(url, data, boundedRequestOptions(options, contextOptions.signal));},
  };
  return {
    axios: client, cheerio, Aes: {}, commonHeaders: {}, getBaseUrl: async () => baseUrl,
    externalStatus,
    cache: {
      getString: key => memory.get(key) ?? readJson(cachePath(key))?.value,
      setString: (key, value) => {memory.set(key, value); writeJson(cachePath(key), {value});},
      delete: key => {memory.delete(key);},
    },
    fileCache: {
      read: async key => readJson(cachePath(`file:${key}`)),
      write: async (key, value) => writeJson(cachePath(`file:${key}`), {value, updatedAt: Date.now()}),
    },
    kvStore: {
      get: async key => key === 'tmdbApiKey' ? process.env.TMDB_API_KEY || undefined : undefined,
      set: async () => {}, delete: async () => false, keys: async () => [], clear: async () => {},
    },
    extractors: {},
  };
}

async function mapAnime(providerRoot, baseUrl, raw, signal) {
  const {resolveAnimeMappings, buildAniBridgeExtra} = requireProvider(providerRoot, 'mappings/index.js');
  const context = createContext(providerRoot, baseUrl, raw, {signal});
  const anilistId = Number(raw.info.anilist_id || raw.embeddedAnime?.anilist_id) || undefined;
  const malId = Number(raw.info.mal_id || raw.embeddedAnime?.mal_id) || undefined;
  const resolution = await resolveAnimeMappings({providerContext: context,
    anilistId, malId,
    isMovie: /movie/i.test(raw.info.type || raw.embeddedAnime?.type || '')});
  if ((anilistId || malId) && !resolution.schemaVersion)
    throw new Error(`AniBridge index unavailable for ${raw.id}`);
  return {id: raw.id, sourceIds: {anilistId: anilistId || null, malId: malId || null},
    ...buildAniBridgeExtra(resolution), metadataTargets: resolution.metadataTargets || [],
    imdbId: resolution.imdbId || null, lookupSource: resolution.lookupSource || null};
}

async function enrichAnime(providerRoot, baseUrl, raw, mapped, options = {}) {
  const getMeta = options.getMeta || requireProvider(providerRoot, 'meta.js').getMeta;
  const getEpisodes = options.getEpisodes || requireProvider(providerRoot, 'episodes.js').getEpisodes;
  const fillGaps = options.fillTvdbEpisodeGaps || fillTvdbEpisodeGaps;
  const getArtwork = options.collectArtwork || collectArtwork;
  const context = createContext(providerRoot, baseUrl, raw,
    {...options.contextOptions, signal: options.signal || options.contextOptions?.signal});
  const link = new URL(raw.path, baseUrl).href;
  const info = normalizeRelatedLinks(options.progress?.info || await getMeta({link, providerContext: context}));
  if (!info?.title || !Array.isArray(info.linkList)) throw new Error(`Vega metadata incomplete for ${raw.id}`);
  const byId = new Map((options.progress?.episodes || []).map(episode => [String(episode.link), episode]));
  const groups = info.linkList.filter(group => group.episodesLink);
  const startGroup = options.progress?.nextGroup || 0;
  const maxGroups = options.maxGroups ?? Infinity;
  const endGroup = Math.min(groups.length, startGroup + maxGroups);
  for (let groupIndex = startGroup; groupIndex < endGroup; groupIndex++) {
    options.signal?.throwIfAborted();
    const group = groups[groupIndex];
    const episodes = await getEpisodes({url: group.episodesLink, providerContext: context});
    const groupEpisodes = new Map();
    for (const episode of episodes) {
      byId.set(String(episode.link), episode);
      groupEpisodes.set(String(episode.link), episode);
    }
    applySourceEpisodeMetadata(groupEpisodes, raw.episodes);
    await fillGaps(providerRoot, context, groupEpisodes, raw);
    for (const [id, episode] of groupEpisodes) byId.set(id, episode);
  }
  options.signal?.throwIfAborted();
  if (endGroup < groups.length) return {partial: true, progress: {
    info, nextGroup: endGroup, episodes: [...byId.values()],
    sourceStatus: mergeSourceStatus(options.progress?.sourceStatus, context.externalStatus),
  }};
  mergeSourceEpisodes(byId, raw.episodes);
  applySourceEpisodeMetadata(byId, raw.episodes);
  if (groups.length === 0) await fillGaps(providerRoot, context, byId, raw);
  const artworkCandidates = await getArtwork(providerRoot, context, raw, mapped, info);
  info.extra ||= {};
  info.extra.artworkCandidates = Object.fromEntries(Object.entries(artworkCandidates).map(
    ([field, candidates]) => [field, candidates.filter(value => value.source !== 'anilist')]));
  info.extra.artworkFallbacks = buildArtworkFallbacks(info, artworkCandidates);
  options.signal?.throwIfAborted();
  return {id: raw.id, path: raw.path, linkSchemaVersion: 2,
    updatedAt: new Date().toISOString(), info,
    episodes: [...byId.values()], sourceIds: mapped.sourceIds, mappings: mapped.mappings,
    sourceMetadata: {info: raw.info, embedded: raw.embeddedAnime, archive: raw.archiveRecord},
    sourceEpisodes: raw.episodes, artworkInventory: artworkCandidates,
    sourceStatus: finalizeSourceStatus(mergeSourceStatus(options.progress?.sourceStatus, context.externalStatus),
      options.previousSourceStatus)};
}

function finalizeSourceStatus(current, previous) {
  const tmdbWeb = current.tmdbWeb;
  tmdbWeb.retryCount = tmdbWeb.transientFailures > 0
    ? Math.min(16, (previous?.tmdbWeb?.retryCount || 0) + 1) : 0;
  return current;
}

function mergeSourceStatus(previous, current) {
  const old = previous?.tmdbWeb || {};
  const next = current?.tmdbWeb || {};
  return {tmdbWeb: {
    attempts: (old.attempts || 0) + (next.attempts || 0),
    transientFailures: (old.transientFailures || 0) + (next.transientFailures || 0),
    lastFailureCode: next.lastFailureCode || old.lastFailureCode || null,
  }};
}

function applySourceEpisodeMetadata(byId, sourceEpisodes) {
  for (const sourceEpisode of sourceEpisodes) {
    const episode = byId.get(String(sourceEpisode.id));
    if (!episode) continue;
    if ((!episode.title || /^Episodes? \d/i.test(episode.title)) && (sourceEpisode.title || sourceEpisode.name)) {
      episode.title = sourceEpisode.title || sourceEpisode.name;
      delete episode.titleKey;
      delete episode.titleParams;
    }
    episode.synopsis ||= sourceEpisode.plot || sourceEpisode.description || undefined;
    episode.thumbnail ||= sourceEpisode.imageurl || sourceEpisode.image || undefined;
  }
}

function mergeSourceEpisodes(byId, sourceEpisodes) {
  for (const source of sourceEpisodes) {
    const link = String(source.id || '').trim();
    if (!link || byId.has(link)) continue;
    const number = String(source.number ?? '').trim();
    const span = episodeBounds(number);
    const isRange = span && span.end > span.start;
    const title = source.title || source.name || (isRange
      ? `Episodes ${span.start}-${span.end}` : number ? `Episode ${number}` : 'Episode');
    byId.set(link, {
      link, title,
      ...(source.title || source.name ? {} : {
        titleKey: isRange ? 'Episodes {{start}}-{{end}}' : number ? 'Episode {{number}}' : 'Episode',
        titleParams: isRange ? {start: span.start, end: span.end} : number ? {number} : undefined,
      }),
      episodeNumber: span?.start,
      sourceEpisodeNumber: span?.start,
      sourceEpisodeEndNumber: isRange ? span.end : undefined,
      synopsis: source.plot || source.description || undefined,
      thumbnail: source.imageurl || source.image || undefined,
    });
  }
}

function uniqueEpisodeFallback(fallbacks, episodeNumbers) {
  const matches = fallbacks.filter(value => episodeNumbers.includes(value.episodeNumber));
  return matches.length === 1 ? matches[0] : null;
}

async function fillTvdbEpisodeGaps(providerRoot, context, byId, raw) {
  const {resolveTvdbEpisodeFallbacks} = requireProvider(providerRoot, 'tvdb/index.js');
  const groups = new Map();
  for (const episode of byId.values()) {
    if (episode.synopsis && episode.thumbnail && episode.title && !/^Episodes? \d/i.test(episode.title)) continue;
    const mapping = episode.externalMappings?.find(value => value.provider === 'tvdb_show' && value.seasonNumber != null && value.episodeNumbers?.length);
    if (!mapping) continue;
    const key = `${mapping.id}:${mapping.seasonNumber}`;
    const group = groups.get(key) || {id: Number(mapping.id), season: mapping.seasonNumber, numbers: new Set(), episodes: []};
    mapping.episodeNumbers.forEach(number => group.numbers.add(number));
    group.episodes.push({episode, mapping});
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    try {
      const fallbacks = await resolveTvdbEpisodeFallbacks({providerContext: context,
        tvdbShowId: group.id, seasonNumber: group.season, episodeNumbers: [...group.numbers],
        sourceRevision: String(raw.info.episodes_count || '')});
      for (const {episode, mapping} of group.episodes) {
        const fallback = uniqueEpisodeFallback(fallbacks, mapping.episodeNumbers);
        if (!fallback) continue;
        if ((!episode.title || /^Episodes? \d/i.test(episode.title)) && fallback.title) {
          episode.title = fallback.title;
          delete episode.titleKey;
          delete episode.titleParams;
        }
        episode.synopsis ||= fallback.synopsis;
        episode.thumbnail ||= fallback.thumbnail;
      }
    } catch { /* TVDB is an optional final fallback. */ }
  }
}

async function collectArtwork(providerRoot, context, raw, mapped, info) {
  const {resolveAnimeTmdbMetadata} = requireProvider(providerRoot, 'tmdb/index.js');
  const {resolveTvdbArtworkMetadata} = requireProvider(providerRoot, 'tvdb/index.js');
  const {resolveAniZipArtwork} = requireProvider(providerRoot, 'anizip/index.js');
  const {resolveAnimeUnityCinemetaMetadata} = requireProvider(providerRoot, 'cinemeta.js');
  const {verifyArtworkTargets} = requireProvider(providerRoot, 'artworkTargetValidation.js');
  const isMovie = /movie/i.test(raw.info.type || '');
  const resolution = {targets: mapped.mappings?.targets || [], metadataTargets: mapped.metadataTargets || [],
    ids: mapped.ids || {}, imdbId: mapped.imdbId || undefined};
  const verified = await verifyArtworkTargets({providerContext: context, mappingResolution: resolution,
    isMovie, titles: [raw.info.title_eng, raw.info.title, raw.info.title_it, info.title]});
  const tvdbKind = isMovie ? 'tvdb_movie' : 'tvdb_show';
  const tvdbTarget = verified.metadataTargets.find(target => target.provider === tvdbKind);
  const tvdbId = Number(tvdbTarget?.id);
  const season = tvdbTarget?.scope?.match(/season:(\d+)/i)?.[1];
  const jobs = {
    tmdb: () => resolveAnimeTmdbMetadata({providerContext: context, mappingResolution: verified, isMovie}),
    tvdb: () => Number.isFinite(tvdbId) && tvdbId > 0
      ? resolveTvdbArtworkMetadata({providerContext: context, tvdbId, mediaType: isMovie ? 'movie' : 'series', seasonNumber: season ? Number(season) : undefined,
        fields: ['logo', 'poster', 'background']}) : null,
    cinemeta: () => resolveAnimeUnityCinemetaMetadata({providerContext: context, imdbId: mapped.imdbId || info.imdbId, isMovie}),
    anizip: () => resolveAniZipArtwork({providerContext: context,
      anilistId: Number(raw.info.anilist_id) || undefined, malId: Number(raw.info.mal_id) || undefined}),
    anilist: async () => {
      const anilistId = Number(raw.info.anilist_id) || undefined;
      const malId = Number(raw.info.mal_id) || undefined;
      if (!anilistId && !malId) return {};
      const key = anilistId ? 'id' : 'idMal';
      const response = await context.axios.post('https://graphql.anilist.co', {
        query: `query ($${key}: Int) { Media(${key}: $${key}, type: ANIME) { bannerImage coverImage { extraLarge large } } }`,
        variables: {[key]: anilistId || malId},
      }, {timeout: 10000});
      return {background: response.data?.data?.Media?.bannerImage,
        poster: response.data?.data?.Media?.coverImage?.extraLarge || response.data?.data?.Media?.coverImage?.large};
    },
  };
  const results = Object.fromEntries(await Promise.all(Object.entries(jobs).map(async ([source, run]) => {
    try { return [source, await run() || {}]; } catch { return [source, {}]; }
  })));
  if (tmdbArtworkSamples < 5 && (mapped.metadataTargets || mapped.mappings?.targets || [])
    .some(target => target.provider === 'tmdb_show' || target.provider === 'tmdb_movie')) {
    tmdbArtworkSamples++;
    const artwork = results.tmdb || {};
    console.log(`[tmdb-artwork] anime=${raw.id} source=${artwork.source || 'none'} logo=${Boolean(artwork.logo)} poster=${Boolean(artwork.poster)} background=${Boolean(artwork.background)}`);
  }
  results.provider = {poster: raw.info.imageurl || raw.info.cover, background: raw.info.imageurl_cover};
  const add = (sources, field) => [...new Map(sources.map(source => ({source, url: results[source]?.[field] || (source === 'anizip' && field === 'background' ? results.anizip?.fanart || results.anizip?.banner : '')}))
    .filter(value => /^https:\/\//i.test(value.url || '')).map(value => [value.url, value])).values()];
  return {
    logo: add(['tmdb', 'cinemeta', 'tvdb', 'anizip', 'provider'], 'logo'),
    poster: add(['tmdb', 'tvdb', 'provider', 'cinemeta', 'anizip', 'anilist'], 'poster'),
    background: add(['tmdb', 'cinemeta', 'tvdb', 'anizip', 'provider', 'anilist'], 'background'),
  };
}

module.exports = {boundedRequestOptions, collectArtwork, createContext, enrichAnime, mapAnime,
  mergeSourceEpisodes, requireProvider, uniqueEpisodeFallback};
