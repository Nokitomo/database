'use strict';

function animeUnityPath(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) ||
      !/^(?:www\.)?animeunity\.[a-z]{2,}$/i.test(parsed.hostname)) return null;
    if (!/^\/anime\/\d+(?:-[^/]*)?\/?$/i.test(parsed.pathname)) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return /^\/anime\/\d+(?:-[^/]*)?\/?(?:[?#].*)?$/i.test(value) ? value : null;
  }
}

function normalizeRelatedLinks(info) {
  if (!info || !Array.isArray(info.related)) return info;
  return {...info, related: info.related.map(entry => ({...entry,
    link: animeUnityPath(entry.link) || entry.link,
    variants: Array.isArray(entry.variants) ? entry.variants.map(variant => ({...variant,
      link: animeUnityPath(variant.link) || variant.link})) : entry.variants,
  }))};
}

function resolveAnimeUnityLink(value, baseUrl) {
  const path = animeUnityPath(value);
  if (!path) return value;
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || !/^(?:www\.)?animeunity\.[a-z]{2,}$/i.test(base.hostname))
    throw new Error('Invalid AnimeUnity base URL');
  return new URL(path, base.origin).href;
}

function resolveRelatedLinks(info, baseUrl) {
  if (!info || !Array.isArray(info.related)) return info;
  return {...info, related: info.related.map(entry => ({...entry,
    link: resolveAnimeUnityLink(entry.link, baseUrl),
    variants: Array.isArray(entry.variants) ? entry.variants.map(variant => ({...variant,
      link: resolveAnimeUnityLink(variant.link, baseUrl)})) : entry.variants,
  }))};
}

module.exports = {animeUnityPath, normalizeRelatedLinks, resolveAnimeUnityLink, resolveRelatedLinks};
