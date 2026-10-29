'use strict';

const path = require('node:path');
const {DATA, hash, readJson, writeJson} = require('./lib');
const {canonical} = require('./incremental');
const DAY = 86400000;
const DEFAULT_FIELDS = ['logo', 'poster', 'background'];

function createMetadataTasks({root = path.join(DATA, 'enrichment-cache'), now = Date.now,
  failures = () => 0, log = console.log, signal, initialTasks = {}} = {}) {
  const used = new Map(Object.entries(initialTasks));
  const inFlight = new Map();
  const ttl = status => status === 'error' ? 30 * 60000 : status === 'missing' ? 30 * DAY : 90 * DAY;
  const fresh = entry => entry && now() - entry.checkedAt < ttl(entry.status);
  const run = async (task, load) => {
    signal?.throwIfAborted();
    const key = hash(canonical({version: 1, source: task.source, kind: task.kind, input: task.input}));
    // Different episode selections can share a season; serialize their cache merges.
    while (inFlight.has(key)) await inFlight.get(key).catch(() => {});
    signal?.throwIfAborted();
    const operation = (async () => {
      const filename = path.join(root, task.source, `${key}.json`);
      const old = readJson(filename);
      const numbers = task.episodeNumbers?.length ? [...new Set(task.episodeNumbers)].sort((a, b) => a - b) : null;
      const fields = task.fields || (task.kind === 'artwork' ? DEFAULT_FIELDS : null);
      const remember = entry => {
        const usedNumbers = numbers ? [...new Set([...(used.get(key)?.episodeNumbers || []), ...numbers])] : undefined;
        const usedFields = fields ? [...new Set([...(used.get(key)?.fields || []), ...fields])] : undefined;
        const parts = usedNumbers ? usedNumbers.map(number => entry.episodes?.[number]).filter(Boolean) :
          usedFields ? usedFields.map(field => entry.fields?.[field]).filter(Boolean) : [entry];
        const status = parts.some(part => part.status === 'error') ? 'error' :
          parts.some(part => part.status === 'missing') ? 'missing' : entry.status;
        used.set(key, {source: task.source, kind: task.kind, input: task.input, status,
          episodeNumbers: usedNumbers, fields: usedFields,
          nextCheckAt: Math.min(...(parts.length ? parts : [entry])
            .map(part => part.checkedAt + ttl(part.status)))});
      };
      const missingNumbers = numbers?.filter(number => !fresh(old?.episodes?.[number]));
      const reusable = numbers ? missingNumbers.length === 0 :
        fields ? fields.every(field => fresh(old?.fields?.[field])) : fresh(old);
      const select = value => numbers && value ? Array.isArray(value)
        ? value.filter(episode => numbers.includes(episode.episodeNumber))
        : {...value, episodes: (value.episodes || []).filter(episode => numbers.includes(episode.episodeNumber))}
        : value;
      if (reusable) {
        remember(old);
        log(`[metadata] ${task.source}/${task.kind}: cached`);
        return select(old.value);
      }
      const before = failures(task.source);
      let value;
      let thrown;
      try { value = await load(missingNumbers || undefined); }
      catch (error) { thrown = error; }
      signal?.throwIfAborted();
      const failed = !!thrown || failures(task.source) > before;
      const checkedAt = now();
      const status = failed ? 'error' : !value || (Array.isArray(value) && !value.length) ? 'missing' : 'ok';
      const entry = {schemaVersion: 1, source: task.source, kind: task.kind, input: task.input,
        checkedAt, status, value: value ?? old?.value ?? null,
        fields: {...old?.fields}, episodes: {...old?.episodes}};
      if (numbers) {
        const rows = Array.isArray(value) ? value : value?.episodes || [];
        const previousRows = Array.isArray(old?.value) ? old.value : old?.value?.episodes || [];
        const byNumber = new Map(previousRows.map(episode => [episode.episodeNumber, episode]));
        for (const episode of rows) {
          const previous = byNumber.get(episode.episodeNumber);
          byNumber.set(episode.episodeNumber, failed ? {
            ...previous,
            ...Object.fromEntries(Object.entries(episode).filter(([, field]) => field != null && field !== '')),
          } : episode);
        }
        for (const number of missingNumbers) {
          const row = rows.find(episode => episode.episodeNumber === number);
          if (!failed && !row) byNumber.delete(number);
          const complete = row && (row.title?.value || row.title) &&
            (row.overview?.value || row.synopsis) && row.thumbnail;
          entry.episodes[number] = {checkedAt, status: failed ? 'error' : complete ? 'ok' : 'missing'};
        }
        const merged = [...byNumber.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
        entry.value = Array.isArray(value) || Array.isArray(old?.value) ? merged :
          {...old?.value, ...value, episodes: merged};
      } else if (fields) {
        entry.value = {...old?.value, ...Object.fromEntries(Object.entries(value || {})
          .filter(([, field]) => !failed || (field != null && field !== '')))};
        for (const field of fields) {
          // Missing fields from a successful response replace old values; failures retain them.
          if (!failed && !value?.[field]) delete entry.value[field];
          entry.fields[field] = {checkedAt, status: failed ? 'error' : value?.[field] ? 'ok' : 'missing'};
        }
      }
      writeJson(filename, entry);
      remember(entry);
      log(`[metadata] ${task.source}/${task.kind}: ${status}${numbers ? `; ${missingNumbers.length}/${numbers.length} episodes refreshed` : ''}`);
      if (thrown && !old?.value) throw thrown;
      return select(entry.value);
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
  };
  return {run, snapshot: () => Object.fromEntries(used)};
}

module.exports = {createMetadataTasks};
