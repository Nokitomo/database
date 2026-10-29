'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {buildArtworkFallbacks, nextArtworkUrl} = require('../scripts/artwork-fallbacks');

test('selected artwork stays first and external images remain available after a provider image fails', () => {
  const info = {poster: 'https://img.animeunity.co/anime/7.jpg',
    extra: {artworkSources: {poster: 'provider'}}};
  const inventory = {poster: [
    {source: 'provider', url: 'https://img.animeunity.co/anime/7.jpg'},
    {source: 'tmdb', url: 'https://image.tmdb.org/t/p/original/7.jpg'},
    {source: 'tvdb', url: 'https://artworks.thetvdb.com/7.jpg'},
    {source: 'unsafe', url: 'http://example.com/7.jpg'},
  ]};
  const fallback = buildArtworkFallbacks(info, inventory);
  assert.deepEqual(fallback.poster.map(value => value.source), ['provider', 'tmdb', 'tvdb']);
  assert.equal(nextArtworkUrl(fallback.poster), info.poster);
  assert.equal(nextArtworkUrl(fallback.poster, [info.poster]), 'https://image.tmdb.org/t/p/original/7.jpg');
  assert.equal(nextArtworkUrl(fallback.poster, fallback.poster.map(value => value.url)), null);
  assert.deepEqual(fallback.logo, []);
});
