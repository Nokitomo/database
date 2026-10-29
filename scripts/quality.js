'use strict';

function buildQualityReport(records, rawIndex, mappedIndex, finalErrors, generatedAt) {
  const report = {
    schemaVersion: 1, generatedAt,
    coverage: {expected: rawIndex.expectedIds.length, final: records.length,
      rawErrors: Object.keys(rawIndex.errors || {}).length,
      mappedErrors: Object.keys(mappedIndex.errors || {}).length,
      finalErrors: Object.keys(finalErrors || {}).length},
    artwork: {missing: {logo: 0, poster: 0, background: 0},
      selectedSources: {logo: {}, poster: {}, background: {}}},
    episodes: {total: 0, missingTitle: 0, missingSynopsis: 0, missingThumbnail: 0,
      withoutExternalMapping: 0, multipleEpisodeCandidates: 0},
    retries: {tmdbWebAnime: 0},
    examples: {missingLogo: [], missingPoster: [], missingBackground: [],
      missingEpisodeMetadata: [], withoutExternalMapping: [], multipleEpisodeCandidates: [], tmdbWebRetry: []},
  };
  const sample = (name, id) => {
    if (report.examples[name].length < 25) report.examples[name].push(id);
  };
  for (const record of records) {
    for (const field of ['logo', 'poster', 'background']) {
      if (!record.info?.[field]) {
        report.artwork.missing[field]++;
        sample(`missing${field[0].toUpperCase()}${field.slice(1)}`, record.id);
      } else {
        const source = record.info.extra?.artworkSources?.[field] || 'unknown';
        const counts = report.artwork.selectedSources[field];
        counts[source] = (counts[source] || 0) + 1;
      }
    }
    if (record.sourceStatus?.tmdbWeb?.transientFailures > 0) {
      report.retries.tmdbWebAnime++;
      sample('tmdbWebRetry', record.id);
    }
    for (const episode of record.episodes || []) {
      report.episodes.total++;
      const missingTitle = !episode.title || /^Episodes? \d/i.test(episode.title);
      const missingSynopsis = !episode.synopsis;
      const missingThumbnail = !episode.thumbnail;
      if (missingTitle) report.episodes.missingTitle++;
      if (missingSynopsis) report.episodes.missingSynopsis++;
      if (missingThumbnail) report.episodes.missingThumbnail++;
      if (missingTitle || missingSynopsis || missingThumbnail) sample('missingEpisodeMetadata', record.id);
      if (!episode.externalMappings?.length) {
        report.episodes.withoutExternalMapping++;
        sample('withoutExternalMapping', record.id);
      }
      if (episode.externalMappings?.some(mapping => mapping.episodeNumbers?.length > 1)) {
        report.episodes.multipleEpisodeCandidates++;
        sample('multipleEpisodeCandidates', record.id);
      }
    }
  }
  return report;
}

module.exports = {buildQualityReport};
