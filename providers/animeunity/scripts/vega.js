'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const cheerio = require('cheerio');
const {ROOT, hash, readJson, writeJson} = require('./lib');
const {applyMappingPolicy, addTypedFallback, installMappingOverride, key: mappingKey} = require('./mapping-policy');
const {createResourceCache, resourcePath, validateTarget} = require('./tmdb-resource');
const {episodeBounds} = require('./source');
const {protectSourceEpisodes} = require('./episode-safety');
const {assertWarp} = require('./warp');
const {createPacedGet} = require('./rate-limit');
const {createTmdbGet} = require('./tmdb-http');
const {normalizeRelatedLinks} = require('./provider-links');
const {buildArtworkFallbacks} = require('./artwork-fallbacks');
const {createMetadataTasks} = require('./metadata-tasks');
const {refreshPlan, matchesMapping, componentDependencies, ENRICHMENT_SCHEMA_VERSION} = require('./incremental');
const {reusableEpisodes} = require('./episode-reuse');
const metrics = require('../../../shared/metrics');

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
  const failureCounts = {};
  const failureDetails = {};
  const resources = contextOptions.resources || createResourceCache({
    ...(raw ? {} : {root: path.join(contextOptions.componentCacheRoot || cacheDir, 'tmdb-resources')}),
    ...contextOptions.resourceCacheOptions,
  });
  const sourceOf = url => {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('themoviedb.org')) return 'tmdb';
    if (host.includes('thetvdb.com')) return 'tvdb';
    if (host.includes('ani.zip')) return 'anizip';
    if (host.includes('cinemeta')) return 'cinemeta';
    if (host.includes('anilist')) return 'anilist';
    return 'provider';
  };
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
            // Keep source ordering intact: Vega also supports record-aligned
            // ranges. Ambiguous results are stripped before checkpoints/fallbacks.
            const number = Number.parseFloat(String(value.number));
            return Number.isFinite(number) && number >= start && number <= end;
          });
          return Promise.resolve({data: {episodes}});
        }
      }
      const isTmdbWeb = new URL(url).hostname.toLowerCase() === 'www.themoviedb.org';
      const absent = resources.missing(url);
      if (absent) {
        metrics.add('cache', 'confirmedMissingHits');
        const error = new Error(`TMDB resource confirmed missing: ${absent.route}`);
        error.response = {status: 404};
        throw error;
      }
      if (isTmdbWeb) externalStatus.tmdbWeb.attempts++;
      try {
        return await (contextOptions.httpGet || tmdbGet)(url, boundedRequestOptions(options, contextOptions.signal));
      } catch (error) {
        const status = Number(error?.response?.status) || 0;
        const route = resourcePath(url);
        if (status === 404 && route) resources.save(route, 'missing', {httpStatus: 404});
        if (status !== 404) {
          const source = sourceOf(url);
          failureCounts[source] = (failureCounts[source] || 0) + 1;
          failureDetails[source] = {httpStatus: status || null,
            code: status === 401 ? 'AUTHENTICATION' : status === 403 ? 'BLOCKED' : status === 429 ? 'RATE_LIMIT' :
              String(error.code || 'REQUEST_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 40)};
        }
        if (isTmdbWeb && status !== 404) {
          externalStatus.tmdbWeb.transientFailures++;
          externalStatus.tmdbWeb.lastFailureCode = status ? `HTTP_${status}` :
            String(error?.code || 'NETWORK').replace(/[^A-Z0-9_]/gi, '').slice(0, 32);
        }
        throw error;
      }
    },
    post: async (url, data, options) => {
      contextOptions.signal?.throwIfAborted();
      assertWarp();
      try { return await metrics.request(url, () => axios.post(url, data, boundedRequestOptions(options, contextOptions.signal))); }
      catch (error) {
        if (Number(error?.response?.status) !== 404) {
          const source = sourceOf(url);
          failureCounts[source] = (failureCounts[source] || 0) + 1;
        }
        throw error;
      }
    },
  };
  return {
    axios: client, cheerio, Aes: {}, commonHeaders: {}, getBaseUrl: async () => baseUrl,
    externalStatus, resources, signal: contextOptions.signal,
    metadataTasks: contextOptions.durableMetadata ? createMetadataTasks({
      root: contextOptions.componentCacheRoot, failures: source => failureCounts[source] || 0,
      failureDetails: source => failureDetails[source] || null,
      signal: contextOptions.signal,
      initialTasks: contextOptions.initialTasks,
    }) : undefined,
    cache: {
      getString: key => {
        const cached=memory.get(key) ?? readJson(cachePath(key))?.value;
        metrics.add('cache', cached == null ? 'stringMisses' : 'stringHits');return cached;
      },
      setString: (key, value) => {memory.set(key, value); writeJson(cachePath(key), {value});},
      delete: key => {memory.delete(key);},
    },
    fileCache: {
      read: async key => {
        const cached=readJson(cachePath(`file:${key}`));
        metrics.add('cache', cached == null ? 'fileMisses' : 'fileHits');return cached;
      },
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
  let resolution = await resolveAnimeMappings({providerContext: context,
    anilistId, malId,
    isMovie: /movie/i.test(raw.info.type || raw.embeddedAnime?.type || '')});
  if ((anilistId || malId) && !resolution.schemaVersion)
    throw new Error(`AniBridge index unavailable for ${raw.id}`);
  const {getAniBridgeIndex} = requireProvider(providerRoot, 'mappings/anibridge.js');
  const index = await getAniBridgeIndex(context);
  let direct = (resolution.sourceDescriptors || []).flatMap(key => index?.records.get(key)?.targets || []);
  // Typed AniZip fallback is allowed; ONA/SPECIAL/unknown never implies a TMDB show.
  if ((resolution.metadataTargets || []).some(t => /^tmdb_/.test(t.provider) &&
    !direct.some(d => mappingKey(d) === mappingKey(t)))) {
    const {resolveAniZipMetadata} = requireProvider(providerRoot, 'anizip/client.js');
    const zip = await resolveAniZipMetadata({providerContext: context, anilistId, malId});
    ({resolution, directTargets: direct} = addTypedFallback(resolution, direct, zip));
  }
  resolution = await applyMappingPolicy(resolution, direct,
    target => validateTarget(target, context, context.resources));
  return {id: raw.id, sourceIds: {anilistId: anilistId || null, malId: malId || null},
    ...buildAniBridgeExtra(resolution), metadataTargets: resolution.metadataTargets || [],
    metadataMediaType: resolution.metadataMediaType, mappingPolicy: resolution.mappingPolicy,
    imdbId: resolution.imdbId || null, lookupSource: resolution.lookupSource || null};
}

async function enrichAnime(providerRoot, baseUrl, raw, mapped, options = {}) {
  const effectiveRaw = mapped.metadataMediaType === 'movie' ? {...raw,
    info: {...raw.info, type: 'Movie'}, embeddedAnime: {...raw.embeddedAnime, type: 'Movie'}} : raw;
  if (!options.getMeta || !options.getEpisodes) {
    installMappingOverride(requireProvider(providerRoot, 'mappings/resolver.js'));
  }
  const getMeta = options.getMeta || requireProvider(providerRoot, 'meta.js').getMeta;
  const getEpisodes = options.getEpisodes || requireProvider(providerRoot, 'episodes.js').getEpisodes;
  const fillGaps = options.fillTvdbEpisodeGaps || fillTvdbEpisodeGaps;
  const getArtwork = options.collectArtwork || collectArtwork;
  const context = createContext(providerRoot, baseUrl, effectiveRaw,
    {durableMetadata: true, initialTasks: options.progress?.metadataTasks,
      ...options.contextOptions, signal: options.signal || options.contextOptions?.signal});
  context.databaseMappingOverride = {
    anilistId: Number(raw.info.anilist_id || raw.embeddedAnime?.anilist_id),
    malId: Number(raw.info.mal_id || raw.embeddedAnime?.mal_id),
    resolution: {schemaVersion: mapped.mappings?.schemaVersion, generatedOn: mapped.mappings?.generatedOn,
      sourceDescriptors: mapped.mappings?.sourceDescriptors || [], targets: mapped.mappings?.targets || [],
      metadataTargets: mapped.metadataTargets || [], ids: mapped.ids || {}, imdbId: mapped.imdbId},
  };
  const plan = refreshPlan(options.previousFinal, raw, mapped);
  const resolveEpisode = options.resolveEpisode || (!options.getEpisodes
    ? requireProvider(providerRoot, 'mappings/index.js').resolveAniBridgeEpisodeMappings : undefined);
  const knownEpisodes = reusableEpisodes(options.previousFinal, raw, mapped, Date.now(), resolveEpisode);
  const knownIds = new Set(knownEpisodes.map(e => String(e.link)));
  plan.reuseEpisodes = plan.reuseEpisodes && knownEpisodes.length === raw.episodes.length;
  if (knownEpisodes.length) plan.retainedTasks = Object.fromEntries(Object.entries(options.previousFinal.metadataTasks || {})
    .filter(([,t]) => t.kind === 'episodes' || t.kind === 'season-layout'));
  const episodeCheckedAt = {...options.progress?.episodeCheckedAt};
  for (const e of knownEpisodes) episodeCheckedAt[e.link] = options.previousFinal.episodeCheckedAt?.[e.link] || options.previousFinal.updatedAt;
  if (options.previousFinal && !options.progress) console.log(`[enrichment] anime=${raw.id} reason=${plan.reason} reuseInfo=${plan.reuseInfo} reuseEpisodes=${plan.reuseEpisodes}`);
  const link = new URL(raw.path, baseUrl).href;
  const info = normalizeRelatedLinks(options.progress?.info ||
    (plan.reuseInfo ? structuredClone(options.previousFinal.info) : await getMeta({link, providerContext: context})));
  if (!info?.title || !Array.isArray(info.linkList)) throw new Error(`Vega metadata incomplete for ${raw.id}`);
  const previous = options.previousFinal;
  if (previous && !matchesMapping(previous, mapped) &&
      JSON.stringify(previous.info?.linkList) !== JSON.stringify(info.linkList)) {
    // A changed group layout may use record-aligned numbering. Rebuild those
    // groups rather than treating an ordinary episode mapping as proof.
    knownEpisodes.length = 0;
    knownIds.clear();
    plan.reuseEpisodes = false;
    plan.retainedTasks = {};
  }
  const dependencies = componentDependencies(mapped);
  const reusableArtwork = new Set();
  if (previous && previous.rawFingerprint === raw.fingerprint && previous.providerRef === mapped.providerRef &&
      previous.enrichmentSchemaVersion === ENRICHMENT_SCHEMA_VERSION && previous.artworkInventory &&
      Date.now() - Date.parse(previous.updatedAt || 0) < 30 * 86400000) {
    for (const [source, dependency] of Object.entries(dependencies.artworkServices || {})) {
      if (previous.componentDependencies?.artworkServices?.[source] !== dependency ||
          (source === 'cinemeta' && previous.info?.imdbId !== info.imdbId) ||
          (source === 'tmdb' && previous.sourceStatus?.tmdbWeb?.transientFailures) ||
          Object.values(previous.metadataTasks || {}).some(t => t.source === source &&
            (!Number.isFinite(t.nextCheckAt) || t.nextCheckAt <= Date.now()))) continue;
      reusableArtwork.add(source);
    }
  }
  context.artworkReuse = {previous, sources: reusableArtwork};
  for (const [key, task] of Object.entries(previous?.metadataTasks || {})) {
    if (reusableArtwork.has(task.source) && !['episodes', 'season-layout'].includes(task.kind)) plan.retainedTasks[key] = task;
  }
  const byId = new Map((options.progress?.episodes ||
    (plan.reuseEpisodes ? structuredClone(options.previousFinal.episodes) : knownEpisodes)).map(episode => [String(episode.link), episode]));
  const groups = info.linkList.filter(group => group.episodesLink);
  protectSourceEpisodes(byId, raw.episodes);
  const startGroup = options.progress?.nextGroup ?? (plan.reuseEpisodes ? groups.length : 0);
  const maxGroups = options.maxGroups ?? Infinity;
  const endGroup = Math.min(groups.length, startGroup + maxGroups);
  for (let groupIndex = startGroup; groupIndex < endGroup; groupIndex++) {
    options.signal?.throwIfAborted();
    const group = groups[groupIndex];
    const episodes = await getEpisodes({url: group.episodesLink, providerContext: context, knownEpisodes});
    const groupEpisodes = new Map();
    for (const episode of episodes) {
      byId.set(String(episode.link), episode);
      if (!knownIds.has(String(episode.link))) {
        groupEpisodes.set(String(episode.link), episode);
        episodeCheckedAt[episode.link] = new Date().toISOString();
      }
    }
    protectSourceEpisodes(groupEpisodes, raw.episodes);
    applySourceEpisodeMetadata(groupEpisodes, raw.episodes);
    await fillGaps(providerRoot, context, groupEpisodes, raw);
    options.signal?.throwIfAborted();
    for (const [id, episode] of groupEpisodes) byId.set(id, episode);
    if (options.checkpoint) await options.checkpoint({info, nextGroup: groupIndex + 1,
      episodes: [...byId.values()], episodeCheckedAt,
      metadataTasks: {...plan.retainedTasks, ...options.progress?.metadataTasks, ...context.metadataTasks?.snapshot()},
      sourceStatus: mergeSourceStatus(options.progress?.sourceStatus, context.externalStatus)});
  }
  options.signal?.throwIfAborted();
  if (endGroup < groups.length) return {partial: true, progress: {
    info, nextGroup: endGroup, episodes: [...byId.values()], episodeCheckedAt,
    metadataTasks: {...plan.retainedTasks, ...options.progress?.metadataTasks, ...context.metadataTasks?.snapshot()},
    sourceStatus: mergeSourceStatus(options.progress?.sourceStatus, context.externalStatus),
  }};
  mergeSourceEpisodes(byId, raw.episodes);
  protectSourceEpisodes(byId, raw.episodes);
  applySourceEpisodeMetadata(byId, raw.episodes);
  if (groups.length === 0 && !plan.reuseEpisodes) {
    const pending = new Map([...byId].filter(([id]) => !knownIds.has(id)));
    await fillGaps(providerRoot, context, pending, raw);
    for (const [id, episode] of pending) { byId.set(id, episode); episodeCheckedAt[id] = new Date().toISOString(); }
  }
  const artworkCandidates = await getArtwork(providerRoot, context, effectiveRaw, mapped, info);
  info.extra ||= {};
  info.extra.artworkCandidates = Object.fromEntries(Object.entries(artworkCandidates).map(
    ([field, candidates]) => [field, candidates.filter(value => value.source !== 'anilist')]));
  info.extra.artworkFallbacks = buildArtworkFallbacks(info, artworkCandidates);
  options.signal?.throwIfAborted();
  return {id: raw.id, path: raw.path, linkSchemaVersion: 2, enrichmentSchemaVersion: ENRICHMENT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(), episodeSafetyVersion: 1, info,
    episodes: [...byId.values()], episodeCheckedAt, sourceIds: mapped.sourceIds, mappings: mapped.mappings,
    sourceMetadata: {info: raw.info, embedded: raw.embeddedAnime, archive: raw.archiveRecord},
    sourceEpisodes: raw.episodes, artworkInventory: artworkCandidates,
    artworkLibrary: context.artworkLibrary,
    mappingPolicy: mapped.mappingPolicy,
    metadataTasks: {...plan.retainedTasks, ...options.progress?.metadataTasks, ...context.metadataTasks?.snapshot()},
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

async function fillTvdbEpisodeGaps(providerRoot, context, byId, raw, resolveFallbacks) {
  const resolveTvdbEpisodeFallbacks = resolveFallbacks || requireProvider(providerRoot, 'tvdb/index.js').resolveTvdbEpisodeFallbacks;
  const groups = new Map();
  for (const episode of byId.values()) {
    if (episode.metadataMappingStatus === 'unresolved') continue;
    const primary = episode.metadataSources?.tmdb || episode;
    if (primary.synopsis && primary.thumbnail && primary.title && !/^Episodes? \d/i.test(primary.title)) continue;
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
        const primary = episode.metadataSources?.tmdb || episode;
        episode.metadataSources ||= {};
        episode.metadataSources.tvdb = {title: fallback.title, synopsis: fallback.synopsis,
          thumbnail: fallback.thumbnail, titleLanguage: fallback.titleLanguage,
          synopsisLanguage: fallback.synopsisLanguage};
        if ((!primary.title || /^Episodes? \d/i.test(primary.title)) && fallback.title) {
          episode.title = fallback.title;
          delete episode.titleKey;
          delete episode.titleParams;
        }
        if (!primary.synopsis && fallback.synopsis) episode.synopsis = fallback.synopsis;
        if (!primary.thumbnail && fallback.thumbnail) episode.thumbnail = fallback.thumbnail;
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
  const {resolveTmdbArtworkLibrary} = requireProvider(providerRoot, 'tmdb/artworkLibrary.js');
  context.artworkLibrary = {schemaVersion: 1, tmdb: {}, tvdb: {}};
  const reuse = context.artworkReuse;
  const tmdbKind = isMovie ? 'tmdb_movie' : 'tmdb_show';
  for (const target of verified.metadataTargets.filter(value => value.provider === tmdbKind)) {
    const id = Number(target.id);
    if (!Number.isSafeInteger(id) || id <= 0 || context.artworkLibrary.tmdb[id]) continue;
    context.artworkLibrary.tmdb[id] = reuse?.sources.has('tmdb') && reuse.previous.artworkLibrary?.tmdb?.[id] || await resolveTmdbArtworkLibrary({
      providerContext: context, id, type: isMovie ? 'movie' : 'tv'});
  }
  const tvdbKind = isMovie ? 'tvdb_movie' : 'tvdb_show';
  const {resolveTvdbArtworkLibrary} = requireProvider(providerRoot, 'tvdb/artworkLibrary.js');
  for (const target of verified.metadataTargets.filter(value => value.provider === tvdbKind)) {
    const id = Number(target.id);
    if (!Number.isSafeInteger(id) || id <= 0 || context.artworkLibrary.tvdb[id]) continue;
    const mappedSeasons = verified.targets.filter(value => value.provider === tvdbKind && Number(value.id) === id)
      .map(value => Number(value.scope?.match(/season:(\d+)/i)?.[1])).filter(Number.isFinite);
    context.artworkLibrary.tvdb[id] = reuse?.sources.has('tvdb') && reuse.previous.artworkLibrary?.tvdb?.[id] || await resolveTvdbArtworkLibrary({providerContext: context,
      tvdbId: id, mediaType: isMovie ? 'movie' : 'series', mappedSeasons});
  }
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
    if (reuse?.sources.has(source)) return [source, Object.fromEntries(['poster', 'background', 'logo'].map(field =>
      [field, reuse.previous.artworkInventory[field]?.find(candidate => candidate.source === source)?.url]))];
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
  fillTvdbEpisodeGaps, mergeSourceEpisodes, requireProvider, uniqueEpisodeFallback};
