'use strict';

const available = variant => ['present', 'unknown'].includes(variant.availability);
const variantFor = (record, key) => {
  const split = key.indexOf(':');
  if (split < 0) return null;
  const provider = key.slice(0, split), id = key.slice(split + 1);
  const variant = (record.providers?.[provider] || []).find(value => String(value.id) === id);
  return variant && available(variant) ? {provider, variant} : null;
};
const episodeNumber = episode => String(episode.number ?? episode.sourceEpisodeNumber ?? episode.episodeNumber);

// Source availability and catalog visibility are separate. An episode-only source
// stays active and addressable, while a single canonical card represents it.
function prepareEpisodeDisplay(records) {
  const byId = new Map(records.map(record => [record.id, record]));
  for (const record of records) {
    delete record.displayWorkId;
    delete record.episodeStreamSources;
    delete record.supplementalEpisodes;
    delete record.episodeOnlyProviders;
  }
  for (const record of records) {
    if (!record.active || !record.episodeRelations?.length) continue;
    const live = Object.entries(record.providers).flatMap(([provider, variants]) =>
      variants.filter(available).map(variant => ({provider, variant})));
    if (!live.length) continue;
    const relations = record.episodeRelations.filter(relation => {
      const target = byId.get(relation.targetWorkId);
      const source = variantFor(record, relation.source);
      const targetVariant = target && variantFor(target, relation.target);
      return target?.active && source && targetVariant &&
        (source.variant.episodes || []).length > 0 &&
        (source.variant.episodes || []).every(episode =>
          Object.hasOwn(relation.episodeMap, episodeNumber(episode))) &&
        (source.variant.episodes || []).every(episode =>
          (targetVariant.variant.episodes || []).some(targetEpisode =>
            episodeNumber(targetEpisode) === String(relation.episodeMap[episodeNumber(episode)])));
    });
    const targets = new Set(relations.map(relation => relation.targetWorkId));
    if (targets.size !== 1 || live.some(({provider, variant}) =>
      !relations.some(relation => relation.source === `${provider}:${variant.id}`))) continue;
    const target = byId.get([...targets][0]);
    record.displayWorkId = target.id;
    for (const relation of relations) {
      const source = variantFor(record, relation.source);
      const targetVariant = variantFor(target, relation.target);
      for (const episode of source.variant.episodes) {
        const targetNumber = String(relation.episodeMap[episodeNumber(episode)]);
        (target.episodeStreamSources ||= []).push({episodeNumber: targetNumber,
          sourceWorkId: record.id, provider: source.provider, providerId: String(source.variant.id),
          sourceEpisodeNumber: episodeNumber(episode), sourceEpisodeId: episode.id,
          sourceEpisodePath: episode.path, targetProvider: targetVariant.provider,
          targetProviderId: String(targetVariant.variant.id)});
        const exists = (target.episodes || []).some(value =>
          String(value.sourceEpisodeNumber ?? value.episodeNumber ?? value.number) === targetNumber);
        if (!exists && !(target.supplementalEpisodes || []).some(value => value.episodeNumber === targetNumber)) {
          const targetEpisode = targetVariant.variant.episodes.find(value => episodeNumber(value) === targetNumber);
          (target.supplementalEpisodes ||= []).push({episodeNumber: targetNumber,
            title: targetEpisode.title || `Episodio ${targetNumber}`,
            synopsis: targetEpisode.synopsis || undefined,
            thumbnail: targetEpisode.thumbnail || undefined,
            targetProvider: targetVariant.provider, targetProviderId: String(targetVariant.variant.id)});
        }
      }
    }
  }
  for (const record of records) if (record.episodeStreamSources?.length)
    record.episodeOnlyProviders = [...new Set(record.episodeStreamSources.map(value=>value.provider))];
}

module.exports = {prepareEpisodeDisplay};
