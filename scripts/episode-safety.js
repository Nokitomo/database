'use strict';

// Provider labels are not AniBridge coordinates. Zero, fractions and ranges
// require a separately verified correspondence; never infer one by rounding.
function needsEpisodeIdentity(number) {
  const label = String(number ?? '').trim();
  return !/^\d+$/.test(label) || !Number.isSafeInteger(Number(label)) || Number(label) < 1;
}

function providerOnlyEpisode(episode, source) {
  const label = String(source.number ?? '').trim();
  const numeric = /^\d+(?:\.\d+)?$/.test(label) ? Number(label) : undefined;
  return {
    link: episode.link, sourcePath: episode.sourcePath,
    sourceEpisodeLabel: label, sourceEpisodeNumber: numeric, episodeNumber: numeric,
    title: source.title || source.name || `Episode ${label}`,
    synopsis: source.synopsis || source.plot || source.description || undefined,
    thumbnail: source.thumbnail || source.imageurl || source.image || undefined,
    metadataMappingStatus: 'unresolved',
    metadataMappingReason: 'provider-episode-identity-required',
    ...(!(source.thumbnail || source.imageurl || source.image) ? {thumbnailFallback: {type: 'series-background'}} : {}),
  };
}

function protectSourceEpisodes(byId, sources) {
  for (const source of sources) {
    const key = String(source.id), episode = byId.get(key);
    if (episode && needsEpisodeIdentity(source.number)) byId.set(key, providerOnlyEpisode(episode, source));
  }
}

module.exports = {needsEpisodeIdentity, providerOnlyEpisode, protectSourceEpisodes};
