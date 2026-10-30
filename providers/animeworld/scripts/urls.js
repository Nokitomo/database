'use strict';

function siteOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^(?:www\.)?animeworld\.[a-z]{2,}$/i.test(url.hostname))
    throw new Error('Invalid AnimeWorld origin');
  return url.origin;
}

function animePath(value, base) {
  const url = new URL(value, base);
  siteOrigin(url.origin);
  const match = url.pathname.match(/^\/play\/([^/]+)\.([\w-]+)(?:\/([\w-]+))?\/?$/);
  if (!match) throw new Error(`Invalid anime path: ${url.pathname}`);
  return {path: `/play/${match[1]}.${match[2]}`, code: match[2], token: match[3] || null};
}

// Only host roles actually observed on the provider are registered. No CDN
// domain is guessed from the website domain. External URLs remain external.
function reference(value, base, origins = {}) {
  if (!value) return null;
  let url;
  try { url = new URL(value, base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const match = url.hostname.match(/^(?:(www|img|static)\.)?animeworld\.[a-z]{2,}$/i);
  if (!match) return {url: url.href};
  const role = !match[1] || match[1] === 'www' ? 'site' : match[1];
  // Old canonical/SEO links must not override the live origin that was verified.
  origins[role] = role === 'site' ? new URL(base).origin : url.origin;
  return {base: role, path: url.pathname + url.search + url.hash};
}

function resolveReference(ref, origins) {
  if (!ref) return null;
  if (ref.url) return ref.url;
  if (!origins[ref.base] || !/^\/(?!\/)/.test(ref.path)) throw new Error('Unresolvable URL reference');
  return new URL(ref.path, origins[ref.base]).href;
}

function normalizeData(value, base, origins) {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return reference(value, base, origins);
  if (Array.isArray(value)) return value.map(item => normalizeData(item, base, origins));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, normalizeData(item, base, origins)]));
  return value;
}

module.exports = {siteOrigin, animePath, reference, resolveReference, normalizeData};
