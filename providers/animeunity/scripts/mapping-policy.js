'use strict';
const VERSION = 1;
const key = target => `${target.provider}:${target.id}:${target.scope || ''}`;
const seasonOf = target => {
  const match = String(target.scope || '').match(/^(?:s|season:)(\d+)$/i);
  return match ? Number(match[1]) : null;
};
function needsMappingRepair(mapped, raw, final) {
  if (!mapped || mapped.mappingPolicy?.version === VERSION) return false;
  const targets = mapped.metadataTargets || mapped.mappings?.targets || [];
  return Object.values(final?.metadataTasks || {}).some(task => task.source === 'tmdb' && task.status === 'error') ||
    targets.some(t => t.provider === 'tmdb_show' && seasonOf(t) === 0) ||
    (!/movie/i.test(raw?.info?.type || '') && targets.some(t => t.provider === 'tmdb_movie'));
}

function addTypedFallback(resolution, directTargets, zip) {
  if (!zip?.tmdbId || !['movie', 'series'].includes(zip.mediaType)) return {resolution, directTargets};
  const provider = zip.mediaType === 'movie' ? 'tmdb_movie' : 'tmdb_show';
  // A generic AniZip ID must never override an already typed direct AniBridge target.
  if ((resolution.metadataTargets || []).some(t => t.provider === provider &&
    directTargets.some(d => d.provider === t.provider && d.id === t.id))) return {resolution, directTargets};
  const typed = {provider, id: String(zip.tmdbId), raw: `${provider}:${zip.tmdbId}`, ranges: {}};
  const append = targets => targets.some(t => key(t) === key(typed)) ? targets : [...targets, typed];
  return {directTargets: [...directTargets, typed], resolution: {...resolution,
    targets: append(resolution.targets || []), metadataTargets: append(resolution.metadataTargets || [])}};
}

async function applyMappingPolicy(resolution, directTargets, validate) {
  const direct = new Set(directTargets.map(key));
  const decisions = new Map();
  const rejected = [];
  const checks = [];
  const original = resolution.targets || [];
  for (const candidate of [...original, ...(resolution.metadataTargets || [])]) {
    if (!/^tmdb_(movie|show)$/.test(candidate.provider) || decisions.has(key(candidate))) continue;
    // AniZip's generic numeric ID and TVDB season layout are not typed TMDB mappings.
    if (!direct.has(key(candidate))) {
      rejected.push({target: candidate, reason: 'unverified-inferred-tmdb-target'});
      decisions.set(key(candidate), false);
      continue;
    }
    const result = await validate(candidate);
    checks.push({target: candidate, ...result});
    if (result.status === 'missing') rejected.push({target: candidate, reason: 'tmdb-resource-not-found'});
    // Transient failures are not evidence that a source mapping is invalid.
    decisions.set(key(candidate), result.status !== 'missing');
  }
  const keep = target => decisions.get(key(target)) !== false;
  const targets = original.filter(keep);
  const metadataTargets = (resolution.metadataTargets || original).filter(keep);
  const ids = {...resolution.ids};
  for (const [provider, name] of [['tmdb_movie', 'tmdbMovieIds'], ['tmdb_show', 'tmdbShowIds']]) {
    ids[name] = [...new Set(targets.filter(t => t.provider === provider).map(t => Number(t.id)))].sort((a,b) => a-b);
  }
  const movie = metadataTargets.some(t => t.provider === 'tmdb_movie');
  const ordinaryShow = metadataTargets.some(t => t.provider === 'tmdb_show' && seasonOf(t) !== 0);
  const nextChecks = checks.filter(c => c.status !== 'ok').map(c => c.nextCheckAt).filter(Number.isFinite);
  return {...resolution, targets, metadataTargets, ids,
    metadataMediaType: movie && !ordinaryShow ? 'movie' : undefined,
    mappingPolicy: {version: VERSION, rejected, checks,
      nextCheckAt: nextChecks.length ? Math.min(...nextChecks) : null}};
}

// Scope the adapter to database contexts only; the pinned provider files stay untouched.
function installMappingOverride(resolver) {
  if (resolver.__databaseMappingOverride) return;
  const original = resolver.resolveAnimeMappings;
  resolver.resolveAnimeMappings = async args => {
    const override = args.providerContext?.databaseMappingOverride;
    if (override && ((args.anilistId && Number(args.anilistId) === override.anilistId) ||
      (args.malId && Number(args.malId) === override.malId))) return override.resolution;
    return original(args);
  };
  Object.defineProperty(resolver, '__databaseMappingOverride', {value: true});
}
module.exports = {VERSION, key, seasonOf, needsMappingRepair, addTypedFallback, applyMappingPolicy, installMappingOverride};
