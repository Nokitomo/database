'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {buildQualityReport} = require('../scripts/quality');

test('quality report counts record coverage, missing fields and mapping candidates', () => {
  const records = [{id: 12, info: {title: 'Test', poster: 'https://example.test/poster',
    background: 'https://example.test/background', extra: {artworkSources: {poster: 'tmdb', background: 'tvdb'}}},
  sourceStatus: {tmdbWeb: {transientFailures: 1}}, episodes: [
    {title: 'Episode 1', externalMappings: [{provider: 'tmdb_show', episodeNumbers: [1, 101]}]},
    {title: 'Real title', synopsis: 'Story', thumbnail: 'https://example.test/still'},
  ]}];
  const report = buildQualityReport(records, {expectedIds: [12, 13], errors: {13: {}}},
    {errors: {}}, {}, '2026-10-29T00:00:00Z');
  assert.deepEqual(report.coverage, {expected: 2, final: 1, rawErrors: 1, mappedErrors: 0, finalErrors: 0});
  assert.equal(report.artwork.missing.logo, 1);
  assert.equal(report.artwork.selectedSources.poster.tmdb, 1);
  assert.equal(report.episodes.total, 2);
  assert.equal(report.episodes.missingTitle, 1);
  assert.equal(report.episodes.missingSynopsis, 1);
  assert.equal(report.episodes.missingThumbnail, 1);
  assert.equal(report.episodes.withoutExternalMapping, 1);
  assert.equal(report.episodes.multipleEpisodeCandidates, 1);
  assert.equal(report.retries.tmdbWebAnime, 1);
  assert.deepEqual(report.examples.multipleEpisodeCandidates, [12]);
});
