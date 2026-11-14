'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {read} = require('../../shared/storage/json');
const {verify} = require('../scripts/verify');
const {normalize} = require('./normalize');

const homeFields = [
  'title', 'name', 'original_title', 'original_name', 'original_language',
  'synopsis', 'type', 'year', 'genres', 'created_at', 'views', 'views_count',
];
const workRoles = new Set(['poster', 'background', 'logo', 'cover_mobile']);

function episodeDuration(episode, season, providerEpisodes, excludedSources) {
  if (Number.isFinite(episode.duration) && episode.duration > 0) return episode.duration;
  const sources = episode.playbackSources ?? Object.keys(episode.metadataSources ?? {})
    .filter(source => providerEpisodes.has(source))
    .map(source => ({source, season, episode: episode.number}));
  const durations = sources.map(ref => {
    const source = ref.source ?? `${ref.provider}:${ref.titleId}`;
    if (!episode.metadataSources?.[source] || excludedSources.has(source)) return null;
    return providerEpisodes.get(source)?.get(`${ref.season}:${ref.episode}`)?.duration;
  }).filter(duration => Number.isFinite(duration) && duration > 0);
  return new Set(durations).size === 1 ? durations[0] : null;
}

function exportEpisodes(record, rows, urls, origins, write) {
  const thumbnails = new Map();
  for (const row of rows) {
    const {scope, field, eligible, forced, rank, season, episode, sourcePaths} = row.payload;
    if (row.kind !== 'artwork_assignment' || !eligible || scope !== 'episode' || field !== 'thumbnail') continue;
    const key = `${season}:${episode}`;
    const priority = forced ? 0 : sourcePaths.some(sourcePath => sourcePath.startsWith('canonical/')) ? 1 : 2;
    const previous = thumbnails.get(key);
    if (!previous || priority < previous.priority || (priority === previous.priority && rank < previous.rank)) {
      thumbnails.set(key, {priority, rank, url: urls.get(row.artworkId)});
    }
  }

  const providerEpisodes = new Map();
  for (const variant of record.providers.streamingunity ?? []) {
    const episodes = new Map();
    for (const season of variant.seasons ?? []) {
      for (const episode of season.episodes ?? []) {
        episodes.set(`${season.number}:${episode.number}`, episode);
      }
    }
    providerEpisodes.set(`streamingunity:${variant.id}`, episodes);
  }

  const imageOrigin = origins['streamingunity:images']?.replace(/\/$/, '');
  const catalogExclusions = record.metadataPolicy?.catalog?.excludedMetadataSources ?? [];
  const conflicts = new Map();
  for (const warning of record.warnings ?? []) {
    if (warning.reason !== 'episode-title-conflict') continue;
    const key = `${warning.season}:${warning.episode}`;
    if (!conflicts.has(key)) conflicts.set(key, []);
    conflicts.get(key).push(warning.source);
  }
  for (const season of record.seasons ?? []) {
    for (const episode of season.episodes ?? []) {
      const key = `${season.number}:${episode.number}`;
      const url = thumbnails.get(key)?.url;
      const thumbnail = imageOrigin && url?.startsWith(imageOrigin + '/')
        ? url.slice(imageOrigin.length) : url ?? null;
      const excludedSources = new Set([...catalogExclusions, ...(conflicts.get(key) ?? [])]);
      write(['episode', record.id, season.number, episode.number, episode.title ?? null,
        thumbnail, episodeDuration(episode, season.number, providerEpisodes, excludedSources)]);
    }
  }
}

function exportLite(root, output) {
  const manifest = read(path.join(root, 'manifest.json'));
  if (manifest?.complete !== true || manifest.pendingCount !== 0 ||
      !Object.keys(manifest.sources || {}).length ||
      Object.values(manifest.sources).some(source => source.complete !== true)) {
    throw Error('Lite requires a complete Cinema snapshot');
  }

  const fd = fs.openSync(output, 'wx');
  const rules = new Map();
  const write = value => fs.writeSync(fd, JSON.stringify(value) + '\n');
  try {
    verify(root, {onRecord(record) {
      if (!/^work-\d+$/.test(record.id)) throw Error('Unexpected Cinema work ID');
      if (Object.values(record.providers).flat().some(source => source.availability === 'unknown') ||
          (record.active && ['retry', 'pending'].includes(record.enrichment?.status))) {
        throw Error('Unresolved Cinema record');
      }

      const detail = fs.readFileSync(path.join(root, 'items', record.id + '.json'));
      const info = Object.fromEntries(homeFields
        .filter(field => Object.hasOwn(record.info, field))
        .map(field => [field, record.info[field]]));
      write(['work', record.id, Number(record.active), record.replacedBy ?? null,
        info, createHash('sha256').update(detail).digest('hex'), detail.length]);

      const rows = normalize(record, manifest.origins);
      const urls = new Map(rows.filter(row => row.kind === 'artwork')
        .map(row => [row.id, row.payload.url]));
      for (const row of rows) {
        if (row.kind !== 'artwork_assignment' || !row.payload.eligible) continue;
        const {scope, field, source, language, forced, rank, width, height} = row.payload;
        const rule = [scope, field, source, language];
        rules.set(JSON.stringify(rule), rule);
        if (scope === 'work' && workRoles.has(field)) {
          write(['artwork', row.id, record.id, field, source, language,
            Number(forced), rank, width, height, urls.get(row.artworkId)]);
        }
      }
      if (record.active) exportEpisodes(record, rows, urls, manifest.origins, write);
    }});
    for (const rule of [...rules.keys()].sort()) write(['rule', ...rules.get(rule)]);
    write(['source', manifest.count, manifest.activeCount, manifest.origins]);
  } finally {
    fs.closeSync(fd);
  }
}

if (require.main === module) exportLite(...process.argv.slice(2));
module.exports = {exportLite};
