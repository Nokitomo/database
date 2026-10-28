'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {sitemapItems, episodeBounds, fetchAnime, parseEmbedded} = require('../scripts/source');
const {catalogEntry, due, enrichmentDue, errorDue, shouldRefreshArchive} = require('../scripts/pipeline');
const {createContext, mergeSourceEpisodes} = require('../scripts/vega');
const {parseArgs} = require('../scripts/lib');

test('sitemap keeps stable IDs and skips non-anime URLs', () => {
  const xml = '<urlset><url><loc>https://www.animeunity.co/</loc></url>' +
    '<url><loc>https://www.animeunity.co/anime/4354-ippon-again/</loc></url></urlset>';
  const items = sitemapItems(xml, 'https://www.animeunity.co');
  assert.equal(items.size, 1);
  assert.deepEqual(items.get(4354), {id: 4354, slug: 'ippon-again', path: '/anime/4354-ippon-again/',
    url: 'https://www.animeunity.co/anime/4354-ippon-again/'});
});

test('embedded AnimeUnity metadata and absolute episode ranges', () => {
  const html = '<video-player anime="{&quot;title&quot;:&quot;Example&quot;}" episodes="[{&quot;id&quot;:7,&quot;number&quot;:&quot;1245-1246&quot;}]"></video-player>';
  const parsed = parseEmbedded(html);
  assert.equal(parsed.anime.title, 'Example');
  assert.deepEqual(episodeBounds(parsed.episodes[0].number), {start: 1245, end: 1246});
});

test('upcoming anime with no episodes does not request an episode range', async () => {
  const requests = [];
  const item = {id: 9, slug: 'upcoming', path: '/anime/9-upcoming'};
  const raw = await fetchAnime(item, 'https://www.animeunity.co', async (_method, url) => {
    requests.push(url);
    if (url.endsWith('/info_api/9/')) return {data: {id: 9, status: 'In Arrivo', episodes_count: 0}};
    return {data: '<video-player anime="{&quot;id&quot;:9}" episodes="[]"></video-player>'};
  });
  assert.deepEqual(raw.episodes, []);
  assert.equal(raw.embeddedAnime.id, 9);
  assert.equal(requests.length, 2);
});

test('planned episode on a completed anime is not treated as available', async () => {
  const requests = [];
  const item = {id: 6234, slug: 'panda-go-panda-rainy-day-circus', path: '/anime/6234-panda-go-panda-rainy-day-circus'};
  const raw = await fetchAnime(item, 'https://www.animeunity.co', async (_method, url) => {
    requests.push(url);
    if (url.endsWith('/info_api/6234/')) return {data: {id: 6234, status: 'Terminato', episodes_count: 0}};
    return {data: '<video-player anime="{&quot;id&quot;:6234,&quot;episodes_count&quot;:1}" episodes="[]"></video-player>'};
  });
  assert.deepEqual(raw.episodes, []);
  assert.equal(raw.embeddedAnime.episodes_count, 1);
  assert.equal(requests.length, 2);
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.equal(due({...raw, checkedAt: twoDaysAgo}, false), true);
});

test('info API remains usable when an anime page temporarily fails', async () => {
  const item = {id: 9, slug: 'upcoming', path: '/anime/9-upcoming'};
  const raw = await fetchAnime(item, 'https://www.animeunity.co', async (_method, url) => {
    if (url.endsWith('/info_api/9/')) return {data: {id: 9, episodes_count: 0}};
    throw new Error('Page unavailable');
  });
  assert.equal(raw.htmlError, 'Page unavailable');
  assert.equal(raw.embeddedAnime, null);
  assert.deepEqual(raw.episodes, []);
});

test('refresh policy revisits dynamic titles daily and completed titles monthly', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.equal(due({checkedAt: twoDaysAgo, info: {status: 'In Corso'}}, false), true);
  assert.equal(due({checkedAt: twoDaysAgo, info: {status: 'Terminato'}}, false), false);
  assert.equal(due({checkedAt: twoDaysAgo, info: {status: 'Terminato'}}, true), true);
});

test('full refresh cutoff processes each record once and backs off failed records', () => {
  const cutoff = Date.now() - 1000;
  const before = new Date(cutoff - 1000).toISOString();
  const after = new Date(cutoff + 1000).toISOString();
  assert.equal(due({checkedAt: before, info: {status: 'Terminato'}}, true, cutoff), true);
  assert.equal(due({checkedAt: after, info: {status: 'Terminato'}}, true, cutoff), false);
  assert.equal(shouldRefreshArchive({archiveCheckedAt: after}, true, Date.now(), cutoff), false);
  assert.equal(errorDue({at: new Date().toISOString()}), false);
  assert.equal(errorDue({at: new Date(Date.now() - 31 * 60000).toISOString()}), true);
  const parsed = parseArgs(['all', '--full-since', before]);
  assert.equal(parsed.full, true);
  assert.equal(parsed.fullSince, Date.parse(before));
});

test('final metadata is revisited when images or episode details appear later', () => {
  const now = Date.now();
  const daysAgo = days => new Date(now - days * 86400000).toISOString();
  const info = {logo: 'https://image.test/logo', poster: 'https://image.test/poster',
    background: 'https://image.test/background'};
  const episode = {title: 'A real title', synopsis: 'Story', thumbnail: 'https://image.test/episode'};
  assert.equal(enrichmentDue({updatedAt: daysAgo(31), info, episodes: [episode]}, now), false);
  assert.equal(enrichmentDue({updatedAt: daysAgo(91), info, episodes: [episode]}, now), true);
  assert.equal(enrichmentDue({updatedAt: daysAgo(31), info: {...info, logo: null}, episodes: [episode]}, now), true);
  assert.equal(enrichmentDue({updatedAt: daysAgo(31), info, episodes: [{...episode, synopsis: ''}]}, now), true);
});

test('archive pagination is reconciled daily', () => {
  const now = Date.now();
  assert.equal(shouldRefreshArchive({}, false, now), true);
  assert.equal(shouldRefreshArchive({archiveCheckedAt: new Date(now - 3600000).toISOString()}, false, now), false);
  assert.equal(shouldRefreshArchive({archiveCheckedAt: new Date(now - 25 * 3600000).toISOString()}, false, now), true);
});

test('provider context reuses raw source data for metadata and episode requests', async () => {
  const raw = {id: 4354, slug: 'ippon-again', info: {id: 4354},
    embeddedAnime: {title: 'Example'}, episodes: [{id: 1, number: '1'}, {id: 2, number: '2'}]};
  const context = createContext('.', 'https://www.animeunity.co', raw);
  assert.deepEqual((await context.axios.get('https://www.animeunity.co/info_api/4354/')).data, raw.info);
  assert.equal((await context.axios.get('https://www.animeunity.co/info_api/4354/1?start_range=2&end_range=2')).data.episodes.length, 1);
  assert.match((await context.axios.get('https://www.animeunity.co/anime/4354-ippon-again')).data, /video-player/);
});

test('final enrichment retains source episodes when provider enrichment is partial', () => {
  const episodes = new Map([['10', {link: '10', title: 'From TMDB', thumbnail: 'https://image.test/10'}]]);
  mergeSourceEpisodes(episodes, [
    {id: 10, number: '1'},
    {id: 11, number: '2-3', description: 'Two episodes', imageurl: 'https://image.test/11'},
  ]);
  assert.equal(episodes.size, 2);
  assert.equal(episodes.get('10').title, 'From TMDB');
  assert.deepEqual(episodes.get('11'), {
    link: '11', title: 'Episodes 2-3', titleKey: 'Episodes {{start}}-{{end}}',
    titleParams: {start: 2, end: 3}, episodeNumber: 2, sourceEpisodeNumber: 2,
    sourceEpisodeEndNumber: 3, synopsis: 'Two episodes', thumbnail: 'https://image.test/11',
  });
});

test('catalog card retains fields needed for archive, calendar and latest sorting', () => {
  const card = catalogEntry({id: 7, path: '/anime/7-example', info: {title: 'Example', poster: 'https://images.test/poster.jpg',
    type: 'series', genres: ['Action'], tags: ['In Corso'], episodesCount: 2},
    sourceIds: {anilistId: 42, malId: 43}, sourceMetadata: {info: {status: 'In Corso', type: 'TV', date: '2026-04-01', dub: 1},
      embedded: {day: 'Martedì', visite: 120}}, sourceEpisodes: [{id: 10, number: '2', created_at: '2026-10-27'}]});
  assert.equal(card.id, 7);
  assert.equal(card.year, '2026');
  assert.equal(card.broadcastDay, 'Martedì');
  assert.equal(card.latestEpisode.id, 10);
  assert.equal(card.dubbed, true);
  assert.equal(card.artworkHints.anilistId, 42);
});
