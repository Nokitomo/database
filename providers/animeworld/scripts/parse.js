'use strict';

const cheerio = require('cheerio');
const {animePath, reference, normalizeData} = require('./urls');

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const integer = value => /^\d[\d.]*$/.test(clean(value)) ? Number(clean(value).replace(/\./g, '')) : null;
const unique = items => [...new Map(items.filter(Boolean).map(item => [JSON.stringify(item), item])).values()];
const attrs = node => Object.fromEntries(Object.entries(node?.attribs || {}).filter(([name]) => name.startsWith('data-')));

function document(html) {
  const $ = cheerio.load(html);
  if ($('#siteName').attr('content') !== 'AnimeWorld') throw new Error('Invalid AnimeWorld HTML (possibly a challenge)');
  return $;
}

function pageUnavailable(html) {
  const $ = cheerio.load(html);
  return $('#siteName').attr('content') === 'AnimeWorld' &&
    clean($('title').text()) === 'AnimeWorld - Pagina non trovata' && !$('#anime-title').length;
}

function tooltipUnavailable(html) {
  const $ = cheerio.load(html);
  return $('.inner .title h1').length === 1 && !clean($('.inner .title h1').text()) &&
    $('a.watch-now').attr('href') === '/play/.';
}

function card($, element, base, origins) {
  const node = $(element), link = node.find('a.name, a.sch-item').first();
  const href = link.attr('href') || node.find('a[href*="/play/"]').first().attr('href');
  const identity = animePath(href, base);
  const id = Number((node.find('[data-tip]').addBack('[data-tip]').first().attr('data-tip') || '')
    .match(/(?:^|\/)api\/tooltip\/(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Missing archive anime ID: ${identity.path}`);
  return {id, code: identity.code, path: identity.path, token: identity.token,
    title: clean(link.text()), originalTitle: link.attr('data-jtitle') || null,
    poster: reference(node.find('img').first().attr('src'), base, origins),
    synopsis: clean(node.find('p').first().text()) || null,
    dateLabel: link.attr('data-tippy-content') || null,
    episodeLabel: clean(node.find('.ep').text()) || null,
    badges: node.find('.status span:not(.bar)').map((_, e) => clean($(e).text())).get()};
}

function parseListing(html, base, {archive = false, page = 1, origins = {}} = {}) {
  const $ = document(html);
  const nodes = archive ? $('.az-list .items .item') : $('#main .film-list .item');
  const cards = nodes.map((_, e) => card($, e, base, origins)).get();
  const pages = integer($('#paging-form .total').text());
  const current = integer($('#page-input').attr('placeholder'));
  const total = archive ? integer($('.az-total').text().replace(/\s*anime\s*$/i, '')) : null;
  if (!pages || pages > 10000 || current !== page || !cards.length || page > pages ||
      (archive && (!total || cards.length !== Math.min(25, total - (page - 1) * 25) || pages !== Math.ceil(total / 25))))
    throw new Error(`Invalid ${archive ? 'archive' : 'feed'} pagination at page ${page}`);
  if (archive && new Set(cards.map(item => item.id)).size !== cards.length)
    throw new Error(`Duplicate archive IDs on page ${page}`);
  return {cards, pages, page, total};
}

function metadata($, root, base, origins) {
  return $(root).find('dl.meta dt').map((_, dt) => {
    const dd = $(dt).next('dd');
    return {label: clean($(dt).text()).replace(/:$/, ''), value: clean(dd.text()),
      links: dd.find('a[href]').map((_, a) => ({text: clean($(a).text()),
        link: reference($(a).attr('href'), base, origins)})).get()};
  }).get();
}

function parseAnime(html, base, expected, origins = {}) {
  const $ = document(html), info = $('.widget.info');
  const title = clean($('#anime-title').text());
  const scripts = $('script:not([src]):not([type])').map((_, e) => $(e).text()).get().join('\n');
  const id = Number(scripts.match(/window\.animeId\s*=\s*['"](\d+)['"]/)?.[1] || $('#loveButton').attr('data-id'));
  const code = scripts.match(/window\.animeIdentifier\s*=\s*['"]([\w-]+)['"]/)?.[1] || $('#animeId').attr('data-id');
  const canonical = $('meta[name="og:url"], meta[property="og:url"]').attr('content');
  const identity = animePath(canonical || expected.path, base);
  if (!title || info.length !== 1 || !id || code !== identity.code ||
      (expected && (id !== expected.id || code !== expected.code))) throw new Error('Anime identity or metadata mismatch');
  const fields = metadata($, info, base, origins);
  const field = label => fields.find(item => item.label === label)?.value || null;
  const links = label => fields.find(item => item.label === label)?.links || [];
  const statusLabel = field('Stato');
  const status = {'In corso': 'ongoing', Finito: 'completed', 'Non rilasciato': 'upcoming', Droppato: 'dropped'}[statusLabel] || 'unknown';
  if (!statusLabel || fields.length < 5 || !info.find('.desc').length) throw new Error('Incomplete anime metadata HTML');
  const episodes = new Map();
  $('.episodes .episode a').each((_, element) => {
    const a = $(element), raw = attrs(element);
    if (a.attr('href')?.endsWith('/tba') || a.hasClass('disabled') || !a.attr('data-episode-id')) return;
    const episodeId = Number(a.attr('data-episode-id'));
    const route = animePath(a.attr('href'), base);
    const number = a.attr('data-episode-num') || a.attr('data-num') || clean(a.text());
    if (!Number.isSafeInteger(episodeId) || episodeId <= 0 || route.code !== code || !route.token || !number)
      throw new Error('Invalid episode entry');
    const server = a.closest('.server');
    const variant = {token: route.token, path: `${identity.path}/${route.token}`,
      server: server.attr('data-name') || null, attributes: normalizeData(raw, base, origins)};
    const existing = episodes.get(episodeId);
    if (existing && existing.number !== number) throw new Error(`Conflicting episode ${episodeId}`);
    if (existing) existing.variants = unique([...existing.variants, variant]);
    else episodes.set(episodeId, {id: episodeId, number, label: clean(a.text()),
      title: a.attr('data-title') || null, synopsis: a.attr('data-description') || null,
      thumbnail: reference(a.attr('data-thumbnail') || a.find('img').attr('src'), base, origins),
      path: variant.path, token: route.token, variants: [variant]});
  });
  // No declared count is used to invent episodes. An empty list is a valid
  // provider state only when the site explicitly renders its unavailable panel.
  if (!episodes.size && !$('#unavailable').length)
    throw new Error('Episode list missing without an unavailable indicator');
  const images = [];
  const addImage = (kind, value) => { const url = reference(value, base, origins); if (url) images.push({kind, url}); };
  info.find('img').each((_, e) => {
    addImage('poster', $(e).attr('src'));
    if ($(e).attr('data-src')) addImage('poster', $(e).attr('data-src'));
    for (const part of ($(e).attr('srcset') || '').split(',')) if (part.trim()) addImage('poster', part.trim().split(/\s+/)[0]);
  });
  $('meta[name="og:image"],meta[property="og:image"],meta[name="twitter:image"]').each((_, e) => addImage('share', $(e).attr('content')));
  info.find('[style*="background-image"]').each((_, e) => {
    for (const match of $(e).attr('style').matchAll(/url\(['"]?([^'"\)]+)['"]?\)/g)) addImage('background', match[1]);
  });
  const related = $('.related .item').map((_, e) => card($, e, base, origins)).get();
  const recommendations = $('#main .film-list .item').map((_, e) => card($, e, base, origins)).get();
  const externalLinks = unique($('#mal-button,#anilist-button,#mangaworld-button').map((_, e) => ({
    service: $(e).attr('id').replace('-button', ''), url: $(e).attr('href')})).get().filter(item => /^https?:\/\//.test(item.url)));
  const sourceIds = Object.fromEntries(externalLinks.map(item => [item.service,
    Number(item.url.match(/\/(?:anime|manga)\/(\d+)/)?.[1]) || null]));
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, e) => {
    try {
      const value = JSON.parse($(e).text());
      if (value['@type'] !== 'WebSite') jsonLd.push(normalizeData(value, base, origins));
    } catch { /* Malformed optional SEO JSON is reported below, not executed. */ }
  });
  const dubValue = scripts.match(/window\.animeDub\s*=\s*(true|false)/)?.[1];
  const warnings = [];
  const jsonLdCount = $('script[type="application/ld+json"]').length;
  if (jsonLdCount && !jsonLd.length && episodes.size) warnings.push('Optional episode JSON-LD could not be parsed');
  const date = field('Data di Uscita');
  const declared = integer(field('Episodi'));
  return {schemaVersion: 1, provider: 'animeworld', id, code, path: identity.path,
    info: {title, originalTitle: $('#anime-title').attr('data-jtitle') || null,
      synopsis: clean(info.find('.desc').text()), type: field('Categoria'), status, statusLabel,
      audio: field('Audio'), dubbed: dubValue ? dubValue === 'true' : null,
      releaseDateLabel: date, year: Number(date?.match(/\b(19|20)\d{2}\b/)?.[0]) || null,
      season: field('Stagione'), studios: links('Studio').map(item => item.text),
      genres: links('Genere').map(item => item.text), durationLabel: field('Durata'),
      declaredEpisodeCount: declared, availableEpisodeCount: episodes.size,
      rating: Number(info.find('.rating[data-value]').attr('data-value')) || null,
      ratingCount: integer(info.find('.rating[data-count]').attr('data-count')),
      views: integer(field('Visualizzazioni')),
      poster: images.find(item => item.kind === 'poster')?.url || null,
      // The OpenGraph share cover is retained separately, not labelled a backdrop.
      shareImage: images.find(item => item.kind === 'share')?.url || null},
    images: unique(images), episodes: [...episodes.values()], related, recommendations,
    trailers: unique($('.trailer-show iframe[src],.widget.player iframe[src*="youtube"]').map((_, e) =>
      reference($(e).attr('src'), base, origins)).get()),
    externalLinks, sourceIds, sourceMetadata: {fields, jsonLd,
      nextEpisode: $('#next-episode').length ? {text: clean($('#next-episode').text()),
        attributes: normalizeData(attrs($('#next-episode')[0]), base, origins)} : null,
      seo: $('meta[name="description"],meta[name="keywords"],meta[name^="og:"],meta[property^="og:"]')
        .map((_, e) => ({name: $(e).attr('name') || $(e).attr('property'),
          value: normalizeData($(e).attr('content'), base, origins)})).get()}, warnings};
}

function parseTooltip(html, base, expected, origins = {}) {
  const $ = cheerio.load(html);
  const title = clean($('.inner .title h1').text());
  const identity = animePath($('a.watch-now').attr('href'), base);
  if (!title || identity.code !== expected.code) throw new Error('Invalid tooltip identity');
  const fields = $('.inner .meta').map((_, e) => ({
    label: clean($(e).find('label').text()).replace(/:$/, ''),
    value: clean($(e).clone().find('label').remove().end().text()),
    links: $(e).find('a').map((_, a) => ({text: clean($(a).text()),
      link: reference($(a).attr('href'), base, origins)})).get(),
  })).get();
  return {title, originalTitle: $('.inner .title h1').attr('data-jtitle') || null,
    aliases: fields.find(item => item.label === 'Nome alternativo')?.value || null,
    synopsisExcerpt: clean($('.inner .desc').text()), fields};
}

function parseHomeImages(html, base, origins = {}) {
  const $ = document(html), images = {};
  $('[style*="background-image"]').each((_, e) => {
    const href = $(e).find('a[href*="/play/"]').first().attr('href');
    if (!href) return;
    const {code} = animePath(href, base);
    const refs = [...$(e).attr('style').matchAll(/url\(['"]?([^'"\)]+)['"]?\)/g)]
      .map(match => ({kind: 'banner', url: reference(match[1], base, origins)})).filter(item => item.url);
    images[code] = unique([...(images[code] || []), ...refs]);
  });
  return images;
}

function parseSchedule(html, base, origins = {}) {
  const $ = document(html), entries = {};
  if (!$('.sch-tabs').length) throw new Error('Invalid schedule page');
  $('.sch-row').each((_, e) => {
    const a = $(e).find('a.sch-item');
    const {code, path} = animePath(a.attr('href'), base);
    const entry = {path, episodeLabel: clean(a.find('.sch-ep').text()),
      providerState: clean(a.find('.sch-st').text()), timeLabel: $(e).attr('data-time') || null,
      scheduledAt: Number($(e).attr('data-at')) || null,
      poster: reference(a.find('img').attr('src'), base, origins)};
    entries[code] = unique([...(entries[code] || []), entry]);
  });
  return entries;
}

module.exports = {clean, unique, integer, parseListing, parseAnime, parseTooltip, parseHomeImages, parseSchedule,
  pageUnavailable, tooltipUnavailable};
