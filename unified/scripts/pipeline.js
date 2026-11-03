'use strict';
const path = require('node:path');
const {read, write, hash} = require('../../providers/animeworld/scripts/store');
const {loadSources, groupEntries, episodeRelations, baseRecord, namespace, publish} = require('./catalog');
const {enrichSource} = require('./enrich');
const {needsEpisodeIdentity, protectSourceEpisodes} = require('../../providers/animeunity/scripts/episode-safety');
function worldInput(group) {
  const provider = group.entries.some(entry=>entry.provider==='animeworld')?'animeworld':group.entries.some(entry=>entry.provider==='animesaturn')?'animesaturn':'animetop';
  const variants = group.entries.filter(entry => entry.provider === provider)
    .map(entry => entry.record).sort((a,b)=>b.episodes.length-a.episodes.length);
  const primary = structuredClone(variants[0]), byNumber = new Map();
  for (const variant of variants) for (const episode of variant.episodes) {
    const key = provider==='animetop'?String(episode.id):String(episode.number);
    if (!byNumber.has(key)) byNumber.set(key, episode);
  }
  primary.episodes = [...byNumber.values()];
  primary.provider = provider;
  return primary;
}
async function run({auRoot, awRoot, output, providerRoot, limit = 10, budgetMs = 180000,
  enrich = enrichSource, now = Date.now, stage = 'all', additionalSources = {}, mappingFingerprint}) {
  const priorManifest = read(path.join(output, 'manifest.json'), {});
  const previouslyLoaded = Object.keys(priorManifest.sourceSnapshots || {});
  for (const provider of previouslyLoaded) {
    if (!['animeunity','animeworld'].includes(provider) && !additionalSources[provider])
      throw new Error(`Previously loaded source omitted: ${provider}`);
  }
  const source = loadSources(auRoot, awRoot, additionalSources, previouslyLoaded);
  const resolverRevision = require('node:fs').readFileSync(path.join(__dirname, '../../vega-providers.ref'), 'utf8').trim();
  let bridge, bridgeIndex;
  async function mappingDependency(input) {
    if (mappingFingerprint) return mappingFingerprint(input);
    // Injected offline enrichers do not require a real resolver checkout.
    if (enrich !== enrichSource) return null;
    const {ids} = require('./catalog');
    const direct = ids(input);
    if (!direct.anilist && !direct.mal) return 'no-direct-anime-identity';
    const {createContext, requireProvider} = require('../../providers/animeunity/scripts/vega');
    bridge ||= requireProvider(providerRoot, 'mappings/anibridge.js');
    bridgeIndex ||= await bridge.getAniBridgeIndex(createContext(providerRoot, 'https://source.invalid'));
    if (!bridgeIndex?.schemaVersion || !bridgeIndex.records?.size) throw new Error('AniBridge index unavailable');
    return require('../../providers/animeunity/scripts/mapping-dependencies').dependencyFingerprint(
      bridgeIndex, bridge.findAniBridgeSourceRecords, {info: {anilist_id: direct.anilist, mal_id: direct.mal,
        type: /movie|film/i.test(input.info.type || '') ? 'Movie' : input.info.type}});
  }
  const overrides = read(path.join(__dirname, '../overrides.json'), {});
  const {groups, registry, conflicts} = groupEntries(source.entries,
    read(path.join(output, 'registry.json'), {members: {}, nextId: 1}), overrides);
  const state = read(path.join(output, 'state.json'), {}), start = now();
  let processed = 0, hasImmediateWork = false;
  const records = [];
  for (const group of groups) {
    let record = baseRecord(group);
    const relations = episodeRelations(group, registry, overrides, source.entries);
    if (relations.length) record.episodeRelations = relations;
    const reviewedStandalone = group.entries.map(entry => entry.key)
      .filter(key => overrides.$reviewedStandalone?.[key]);
    if (reviewedStandalone.length) record.identityReview = {
      standaloneAtReview: reviewedStandalone.map(source =>
        ({source, reviewedAt: overrides.$reviewedStandalone[source]}))};
    const exclusive = !group.entries.some(entry => entry.provider === 'animeunity');
    if (exclusive) {
      const input = worldInput(group);
      const fingerprint = hash({version: input.episodes.some(episode => needsEpisodeIdentity(episode.number)) ? 3 : 2, provider: input.provider, sourceIds: input.sourceIds,
        title: input.info.title, type: input.info.type,
        resolverRevision,
        ...(input.provider==='animetop'?{providerInfo:input.info,sourceRows:input.sourceRows}:{}),
        episodes: input.episodes.map(({id,number,title,synopsis,thumbnail}) => ({id,number,title,synopsis,thumbnail}))});
      const file = path.join(output, 'enriched', `${group.id}.json`);
      const priorRecord = read(path.join(output, 'items', `${group.id}.json`));
      // A forced merge can change which provider supplies this work's metadata.
      // The old enrichment may contain provider-relative image references, so it
      // cannot be reused under the new provider's origin namespace.
      const providerChanged = priorRecord?.metadataProvider && priorRecord.metadataProvider !== input.provider;
      const previous = providerChanged ? null : read(file);
      const status = state[group.id];
      const canProcess = processed < limit && now()-start < budgetMs;
      const checkDependency = stage !== 'merge' && ((previous && status) || canProcess);
      const dependency = checkDependency ? await mappingDependency(input) : status?.mappingDependency;
      const due = (!previous && !status?.error) || !status || status.fingerprint !== fingerprint ||
        dependency !== status.mappingDependency || (status.nextCheckAt || 0) <= now();
      let enriched = previous;
      if (due && stage !== 'merge') {
        if (processed < limit && now()-start < budgetMs) {
          processed++;
          const reason = !status ? 'new' : status.fingerprint !== fingerprint ? 'source-or-resolver-changed' :
            dependency !== status.mappingDependency ? 'mapping-changed' : !previous && !status.error ? 'missing-output' : status.error ? 'retry' : 'metadata-task-or-refresh-due';
          console.log(`[unified] enriching ${group.id} ${input.provider}=${input.id} reason=${reason}`);
          try {
            enriched = await enrich(input, {providerRoot, cacheRoot: path.join(output, 'cache'), previous,
              signal: AbortSignal.timeout(Math.max(1, budgetMs-(now()-start)))});
            write(file, enriched);
            const taskDue = Object.values(enriched.metadataTasks || {}).map(value => value.nextCheckAt).filter(Number.isFinite);
            state[group.id] = {fingerprint, mappingDependency: dependency, nextCheckAt: Math.min(
              now() + (enriched.enrichment.status === 'retry' ? 3600000 : enriched.enrichment.status === 'unmapped' ? 7*86400000 : 30*86400000),
              ...taskDue.map(value => Math.max(now()+3600000, value)))};
          } catch (error) {
            state[group.id] = {fingerprint, mappingDependency: dependency, error: String(error.message).slice(0,200), nextCheckAt: now()+3600000};
            record.enrichment = {status: 'retry'};
            console.error(`[unified] ${group.id}: ${error.message}`);
          }
          write(path.join(output, 'state.json'), state);
        } else hasImmediateWork = true;
      }
      if (enriched) {
        enriched = structuredClone(enriched);
        const safeEpisodes = new Map((enriched.episodes || []).map(episode => [String(episode.link), episode]));
        protectSourceEpisodes(safeEpisodes, input.episodes);
        enriched.episodes = [...safeEpisodes.values()];
      }
      if (enriched) record = {...record, ...namespace(enriched, input.provider), metadataProvider:input.provider,
        info: {...namespace(enriched.info, input.provider), title: input.info.title,
          synopsis: input.info.synopsis || enriched.info?.synopsis,
          status: input.info.status, availableEpisodeCount: input.episodes.length}};
      if (state[group.id]?.error) record.enrichment = {status: 'retry'};
    }
    records.push(record);
  }
  const byId = new Map(records.map(record => [record.id, record]));
  for (const record of records) for (const relation of record.episodeRelations || []) {
    const target = byId.get(relation.targetWorkId);
    // A provider can temporarily disappear; its retained work still owns the target ID.
    if (!target) continue;
    (target.incomingEpisodeRelations ||= []).push({sourceWorkId: record.id, ...relation});
  }
  const manifest = publish(output, records, source, registry, conflicts);
  return {processed, hasImmediateWork, count: manifest.count, pendingCount: manifest.pendingCount, complete: manifest.complete};
}
if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  run({auRoot: path.join(root, 'providers/animeunity/data'), awRoot: path.join(root, 'providers/animeworld/data'),
    output: path.join(root, 'unified/data'), providerRoot: path.join(root, '.cache/vega-providers'),
    additionalSources: {animesaturn:path.join(root,'providers/animesaturn/data'),animetop:path.join(root,'providers/animetop/data')},
    stage: process.env.RUN_STAGE || 'all'})
    .then(result => console.log(`UNIFIED_BATCH ${JSON.stringify(result)}`))
    .catch(error => {console.error(error); process.exitCode = 1;});
}
module.exports = {run, worldInput};
