'use strict';
function siteOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !/^(?:www\.)?animesaturn\.[a-z]{2,}$/i.test(url.hostname)) throw new Error('Invalid AnimeSaturn origin');
  return url.origin;
}
function animePath(value, base) {
  const url = new URL(value, base); siteOrigin(url.origin);
  const match = url.pathname.match(/^\/(anime|episode)\/([^/]+)-([A-Za-z0-9]{5})(?:\/(ep-[\w.-]+))?\/?$/);
  if (!match || (match[1] === 'episode' && !match[4])) throw new Error(`Invalid AnimeSaturn path: ${url.pathname}`);
  return {id: match[3], code: match[3], path: `/anime/${match[2]}-${match[3]}`, token: match[4] || null,
    episodePath: match[4] ? `/episode/${match[2]}-${match[3]}/${match[4]}` : null};
}
function reference(value, base, origins = {}) {
  if (!value) return null;
  let url; try {url = new URL(value, base);} catch {return null;}
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  let role;
  if (/^(?:www\.)?animesaturn\.[a-z]{2,}$/i.test(url.hostname)) role = 'site';
  else if (/^img\.saturncdn\.[a-z]{2,}$/i.test(url.hostname)) role = 'images';
  if (!role) return {url: url.href};
  origins[role] = role === 'site' ? new URL(base).origin : url.origin;
  return {base: role, path: url.pathname + url.search + url.hash};
}
function normalizeData(value, base, origins) {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return reference(value, base, origins);
  if (Array.isArray(value)) return value.map(item => normalizeData(item, base, origins));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalizeData(item,base,origins)]));
  return value;
}
module.exports = {siteOrigin, animePath, reference, normalizeData};
