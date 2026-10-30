'use strict';
const path = require('node:path');
const {read, write, hash} = require('../../providers/animeworld/scripts/store');
const {loadSources, groupEntries, baseRecord, namespace, publish} = require('./catalog');
const {enrichSource} = require('./enrich');
function worldInput(group) {
  const provider = group.entries.some(entry=>entry.provider==='animeworld')?'animeworld':'animesaturn';
  const variants = group.entries.filter(entry => entry.provider === provider)
    .map(entry => entry.record).sort((a,b)=>b.episodes.length-a.episodes.length);
  const primary = structuredClone(variants[0]), byNumber = new Map();
  for (const variant of variants) for (const episode of variant.episodes) {
    const key = String(episode.number);
    if (!byNumber.has(key)) byNumber.set(key, episode);
  }
  primary.episodes = [...byNumber.values()];
  primary.provider = provider;
  return primary;
}
async function run({auRoot, awRoot, output, providerRoot, limit = 10, budgetMs = 180000,
  enrich = enrichSource, now = Date.now, stage = 'all', additionalSources = {}}) {
  const source = loadSources(auRoot, awRoot, additionalSources);
  const {groups, registry, conflicts} = groupEntries(source.entries,
    read(path.join(output, 'registry.json'), {members: {}, nextId: 1}),
    read(path.join(__dirname, '../overrides.json'), {}));
  const state = read(path.join(output, 'state.json'), {}), start = now();
  let processed = 0, hasImmediateWork = false;
  const records = [];
  for (const group of groups) {
    let record = baseRecord(group);
    const exclusive = !group.entries.some(entry => entry.provider === 'animeunity');
    if (exclusive) {
      const input = worldInput(group);
      const fingerprint = hash({version: 2, provider: input.provider, sourceIds: input.sourceIds,
        title: input.info.title, type: input.info.type,
        episodes: input.episodes.map(({id,number,title,synopsis,thumbnail}) => ({id,number,title,synopsis,thumbnail}))});
      const file = path.join(output, 'enriched', `${group.id}.json`), previous = read(file);
      const status = state[group.id];
      const due = !status || status.fingerprint !== fingerprint || (status.nextCheckAt || 0) <= now();
      let enriched = previous;
      if (due && stage !== 'merge') {
        if (processed < limit && now()-start < budgetMs) {
          processed++;
          console.log(`[unified] enriching ${group.id} ${input.provider}=${input.id}`);
          try {
            enriched = await enrich(input, {providerRoot, cacheRoot: path.join(output, 'cache'), previous,
              signal: AbortSignal.timeout(Math.max(1, budgetMs-(now()-start)))});
            write(file, enriched);
            const taskDue = Object.values(enriched.metadataTasks || {}).map(value => value.nextCheckAt).filter(Number.isFinite);
            state[group.id] = {fingerprint, nextCheckAt: Math.min(now() + (enriched.enrichment.status === 'retry' ? 3600000 : 86400000), ...taskDue)};
          } catch (error) {
            state[group.id] = {fingerprint, error: String(error.message).slice(0,200), nextCheckAt: now()+3600000};
            record.enrichment = {status: 'retry'};
            console.error(`[unified] ${group.id}: ${error.message}`);
          }
          write(path.join(output, 'state.json'), state);
        } else hasImmediateWork = true;
      }
      if (enriched) record = {...record, ...namespace(enriched, input.provider), metadataProvider:input.provider,
        info: {...namespace(enriched.info, input.provider), title: input.info.title,
          status: input.info.status, availableEpisodeCount: input.episodes.length}};
      if (state[group.id]?.error) record.enrichment = {status: 'retry'};
    }
    records.push(record);
  }
  const manifest = publish(output, records, source, registry, conflicts);
  return {processed, hasImmediateWork, count: manifest.count, pendingCount: manifest.pendingCount, complete: manifest.complete};
}
if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  run({auRoot: path.join(root, 'anime_database'), awRoot: path.join(root, 'providers/animeworld/data'),
    output: path.join(root, 'unified/data'), providerRoot: path.join(root, '.cache/vega-providers'),
    additionalSources: {animesaturn:path.join(root,'providers/animesaturn/data')},
    stage: process.env.RUN_STAGE || 'all'})
    .then(result => console.log(`UNIFIED_BATCH ${JSON.stringify(result)}`))
    .catch(error => {console.error(error); process.exitCode = 1;});
}
module.exports = {run, worldInput};
