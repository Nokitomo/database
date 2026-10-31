'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {animeUnityPath, normalizeRelatedLinks, resolveAnimeUnityLink, resolveRelatedLinks} = require('../scripts/provider-links');

test('AnimeUnity page links become domain-independent while images and external links are preserved', () => {
  const original = {poster: 'https://image.tmdb.org/t/p/original/poster.jpg', related: [
    {title: 'Sibling', link: 'https://www.animeunity.co/anime/7-sibling?dub=1',
      image: 'https://img.animeunity.co/anime/7.jpg', variants: [
        {link: 'https://animeunity.so/anime/7-sibling'},
        {link: 'https://www.themoviedb.org/tv/7'},
      ]},
  ]};
  const normalized = normalizeRelatedLinks(original);
  assert.equal(normalized.related[0].link, '/anime/7-sibling?dub=1');
  assert.equal(normalized.related[0].variants[0].link, '/anime/7-sibling');
  assert.equal(normalized.related[0].variants[1].link, 'https://www.themoviedb.org/tv/7');
  assert.equal(normalized.related[0].image, original.related[0].image);
  assert.equal(normalized.poster, original.poster);
  assert.equal(original.related[0].link, 'https://www.animeunity.co/anime/7-sibling?dub=1');
});

test('saved page paths resolve against the current verified AnimeUnity domain', () => {
  const info = normalizeRelatedLinks({related: [{link: 'https://www.animeunity.co/anime/7-sibling',
    variants: [{link: '/anime/8-variant'}], image: 'https://img.animeunity.co/anime/7.jpg'}]});
  const resolved = resolveRelatedLinks(info, 'https://www.animeunity.so');
  assert.equal(resolved.related[0].link, 'https://www.animeunity.so/anime/7-sibling');
  assert.equal(resolved.related[0].variants[0].link, 'https://www.animeunity.so/anime/8-variant');
  assert.equal(resolved.related[0].image, info.related[0].image);
  assert.equal(resolveAnimeUnityLink('/anime/9-main', 'https://www.animeunity.so'),
    'https://www.animeunity.so/anime/9-main');
  assert.equal(animeUnityPath('https://img.animeunity.co/anime/7.jpg'), null);
  assert.equal(animeUnityPath('http://www.animeunity.co/anime/7-old'), '/anime/7-old');
  assert.equal(animeUnityPath('https://evil.example/anime/7'), null);
  assert.throws(() => resolveAnimeUnityLink('/anime/7', 'https://evil.example'), /Invalid AnimeUnity/);
});
