'use strict';

const {createContext, requireProvider, collectArtwork, fillTvdbEpisodeGaps} = require('../../providers/animeunity/scripts/vega');
const {ids} = require('./catalog');
const {hash} = require('../../providers/animeworld/scripts/store');
const {needsEpisodeIdentity, providerOnlyEpisode} = require('../../providers/animeunity/scripts/episode-safety');

// Only external resolvers are reused. No AnimeUnity source endpoint is called.
async function enrichWorld(record, {providerRoot, cacheRoot, signal, previous, services = {}}) {
  if(record.provider==='animetop'&&!ids(record).anilist&&!ids(record).mal)return {info:record.info,episodes:record.episodes.map(source=>providerOnlyEpisode({link:String(source.id),sourcePath:source.path},source)),enrichment:{status:'unmapped',reason:'provider-external-identity-missing'}};
  const load = name => services[name] || requireProvider(providerRoot, name);
  const context = services.context || createContext(providerRoot, 'https://source.invalid', null,
    {durableMetadata: true, componentCacheRoot: cacheRoot, signal});
  const mapping = load('mappings/index.js');
  const sourceIds = ids(record), isMovie = /movie|film/i.test(record.info.type || '');
  const resolution = await mapping.resolveAnimeMappings({providerContext: context,
    anilistId: sourceIds.anilist || undefined, malId: sourceIds.mal || undefined, isMovie});
  signal?.throwIfAborted();
  if ((sourceIds.anilist || sourceIds.mal) && !resolution.schemaVersion) throw new Error('AniBridge unavailable');
  const mapped = {...mapping.buildAniBridgeExtra(resolution), metadataTargets: resolution.metadataTargets,
    imdbId: resolution.imdbId, sourceIds};
  const info = {...record.info, sourceType: record.info.type, type: isMovie ? 'movie' : 'series',
    tags: [record.info.type, record.info.statusLabel, record.info.year].filter(Boolean).map(String), extra: mapped};
  const tmdb = load('tmdb/index.js');
  const target = (resolution.metadataTargets || []).find(value => value.provider === (isMovie ? 'tmdb_movie' : 'tmdb_show'));
  if (target) {
    const args = {providerContext: context, id: Number(target.id), type: isMovie ? 'movie' : 'tv'};
    const media = context.metadataTasks ? await context.metadataTasks.run({source: 'tmdb', kind: 'media',
      input: {id: args.id, type: args.type}}, () => tmdb.resolveTmdbMediaMetadata(args)) : await tmdb.resolveTmdbMediaMetadata(args);
    info.extra.tmdb = media;
    info.synopsis ||= media?.overview?.value;
  }
  const episodes = [], seasons = new Map();
  const episodeMappings = new Map();
  for (const source of record.episodes) {
    if ((needsEpisodeIdentity(source.number)||source.metadataMappingStatus==='unresolved')) continue;
    const number = /^\d+(?:\.\d+)?$/.test(String(source.number)) ? Number(source.number) : null;
    const resolved = number == null ? null : mapping.resolveAniBridgeEpisodeMappings(resolution, number);
    episodeMappings.set(source.id, resolved);
    for (const target of resolved?.mappings || []) {
      if (target.provider !== 'tmdb_show' || target.seasonNumber == null || target.episodeNumbers.length !== 1) continue;
      const key = `${target.id}:${target.seasonNumber}`;
      const group = seasons.get(key) || {target, numbers: new Set()};
      target.episodeNumbers.forEach(number => group.numbers.add(number));
      seasons.set(key, group);
    }
  }
  for (const group of seasons.values()) {
    signal?.throwIfAborted();
    group.result = await tmdb.resolveTmdbEpisodeSeasonMetadata({providerContext: context,
      mediaId: Number(group.target.id), seasonNumber: group.target.seasonNumber,
      episodeNumbers: [...group.numbers], sourceRevision: String(record.episodes.length)});
  }
  // A task cache persists individual season requests, including partial failures.
  // Identity includes the episode mapping, so changed ranges invalidate only affected tasks.
  for (const source of record.episodes) {
    if ((needsEpisodeIdentity(source.number)||source.metadataMappingStatus==='unresolved')) {
      episodes.push(providerOnlyEpisode({link: String(source.id), sourcePath: source.path}, source));
      continue;
    }
    signal?.throwIfAborted();
    const number = /^\d+(?:\.\d+)?$/.test(String(source.number)) ? Number(source.number) : null;
    const resolved = episodeMappings.get(source.id);
    const episode = {link: String(source.id), sourcePath: source.path, sourceEpisodeNumber: number,
      episodeNumber: number, title: source.title || `Episode ${source.number}`, synopsis: source.synopsis || undefined,
      thumbnail: source.thumbnail || undefined, externalMappings: resolved?.mappings,
      seasonNumber: resolved?.seasonNumber};
    const tm = resolved?.mappings.find(value => value.provider === 'tmdb_show' && value.seasonNumber != null);
    if (tm && tm.episodeNumbers.length === 1) {
      const result = seasons.get(`${tm.id}:${tm.seasonNumber}`)?.result;
      const item = result?.episodes?.find(value => value.episodeNumber === tm.episodeNumbers[0]);
      episode.metadataSources = {tmdb: {title: item?.title?.value, synopsis: item?.overview?.value, thumbnail: item?.thumbnail}};
      if (item?.title?.value) episode.title = item.title.value;
      if (item?.overview?.value) episode.synopsis = item.overview.value;
      if (item?.thumbnail) episode.thumbnail = item.thumbnail;
    }
    const old = previous?.episodes?.find(value => value.link === episode.link);
    if (old && hash(old.externalMappings || null) === hash(episode.externalMappings || null)) {
      for (const key of ['synopsis','thumbnail']) episode[key] ||= old[key];
    }
    episodes.push(episode);
  }
  const raw = {id: record.id, info: {title: record.info.title, type: isMovie ? 'Movie' : record.info.type,
    anilist_id: sourceIds.anilist, mal_id: sourceIds.mal, episodes_count: record.episodes.length}, episodes: []};
  await (services.fillGaps || fillTvdbEpisodeGaps)(providerRoot, context,
    new Map(episodes.map(episode => [episode.link, episode])), raw);
  if (!services.skipAniZip) {
    const missing = episodes.filter(episode => episode.metadataMappingStatus !== 'unresolved' &&
      (!episode.synopsis || !episode.thumbnail || /^Episode /i.test(episode.title)));
    if (missing.length) {
      const fallbacks = await load('anizip/index.js').resolveAniZipEpisodeFallbacks({providerContext: context,
        anilistId: sourceIds.anilist || undefined, malId: sourceIds.mal || undefined,
        sourceRevision: String(record.episodes.length), requests: missing.map(episode => ({
          sourceEpisodeNumber: episode.sourceEpisodeNumber, seasonNumber: episode.seasonNumber,
          externalMappings: episode.externalMappings}))});
      missing.forEach((episode, index) => {
        const fallback = fallbacks[index];
        if (!fallback) return;
        if (/^Episode /i.test(episode.title) && fallback.title) episode.title = fallback.title;
        episode.synopsis ||= fallback.synopsis;
        episode.thumbnail ||= fallback.thumbnail;
      });
    }
  }
  const artworkInventory = await (services.artwork || collectArtwork)(providerRoot, context, raw, mapped, info);
  for (const field of ['poster','background','logo']) info[field] = artworkInventory[field]?.[0]?.url || info[field];
  signal?.throwIfAborted();
  const tasks = context.metadataTasks?.snapshot() || {};
  const failed = Object.values(tasks).some(task => task.status === 'error') || context.externalStatus?.tmdbWeb?.transientFailures > 0;
  return {info, episodes, mappings: mapped.mappings, artworkInventory, artworkLibrary: context.artworkLibrary,
    metadataTasks: tasks, sourceStatus: context.externalStatus,
    enrichment: {status: failed ? 'retry' : resolution.targets?.length ? 'ready' : 'unmapped',
      mappingFingerprint: hash(resolution.targets || [])}};
}
module.exports = {enrichWorld, enrichSource:enrichWorld};
