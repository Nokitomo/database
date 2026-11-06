'use strict';

const path = require('node:path');
const {DATA, hash, readJson, writeJson} = require('./lib');
const {canonical} = require('./incremental');
const metrics = require('../../../shared/metrics');
const DAY = 86400000;
const DEFAULT_FIELDS = ['logo', 'poster', 'background'];

function createMetadataTasks({root = path.join(DATA, 'enrichment-cache'), now = Date.now,
  failures = () => 0, failureDetails = () => null, log = console.log, signal, initialTasks = {}} = {}) {
  const used = new Map(Object.entries(initialTasks));
  const inFlight = new Map();
  let errorCount = 0;
  const ttl = entry => entry.status === 'error'
    ? Math.min(7 * DAY, 30 * 60000 * 2 ** Math.min(9, Math.max(0, (entry.retryCount || 1) - 1)))
    : entry.status === 'missing' ? 30 * DAY : 90 * DAY;
  const fresh = entry => entry && now() - entry.checkedAt < ttl(entry);
  const retryCount = (old, status) => status === 'error' ? Math.min(16, (old?.retryCount || 0) + 1) : 0;
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
        if (status === 'error') errorCount++;
        used.set(key, {source: task.source, kind: task.kind, input: task.input, status,
          episodeNumbers: usedNumbers, fields: usedFields,
          nextCheckAt: Math.min(...(parts.length ? parts : [entry])
            .map(part => part.checkedAt + ttl(part))),
          retryCount: Math.max(0, ...parts.map(part => part.retryCount || 0)),
          failure: entry.failure || null});
      };
      const missingNumbers = numbers?.filter(number => !fresh(old?.episodes?.[number]));
      const reusable = numbers ? missingNumbers.length === 0 :
        fields ? fields.every(field => fresh(old?.fields?.[field])) : fresh(old);
      const select = value => numbers && value ? Array.isArray(value)
        ? value.filter(episode => numbers.includes(episode.episodeNumber))
        : {...value, episodes: (value.episodes || []).filter(episode => numbers.includes(episode.episodeNumber))}
        : value;
      if (reusable) {
        metrics.add('metadataCache', 'hits');
        remember(old);
        log(`[metadata] ${task.source}/${task.kind}: cached`);
        return select(old.value);
      }
      const before = failures(task.source);
      metrics.add('metadataCache', 'misses');
      let value;
      let thrown;
      try { value = await load(missingNumbers || undefined); }
      catch (error) { thrown = error; }
      signal?.throwIfAborted();
      const notFound = Number(thrown?.response?.status) === 404;
      const failed = (!!thrown && !notFound) || failures(task.source) > before;
      const checkedAt = now();
      const status = failed ? 'error' : !value || (Array.isArray(value) && !value.length) ? 'missing' : 'ok';
      const entry = {schemaVersion: 1, source: task.source, kind: task.kind, input: task.input,
        checkedAt, status, retryCount: retryCount(old, status), value: value ?? old?.value ?? null,
        failure: failed ? (failureDetails(task.source) || {httpStatus: Number(thrown?.response?.status) || null,
          code: String(thrown?.code || 'REQUEST_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 40)}) : null,
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
          const status = failed ? 'error' : complete ? 'ok' : 'missing';
          entry.episodes[number] = {checkedAt, status, retryCount: retryCount(old?.episodes?.[number], status)};
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
          const status = failed ? 'error' : value?.[field] ? 'ok' : 'missing';
          entry.fields[field] = {checkedAt, status, retryCount: retryCount(old?.fields?.[field], status)};
        }
      }
      writeJson(filename, entry);
      remember(entry);
      log(`[metadata] ${task.source}/${task.kind}: ${status}${numbers ? `; ${missingNumbers.length}/${numbers.length} episodes refreshed` : ''}`);
      if (thrown && !notFound && !old?.value) throw thrown;
      return select(entry.value);
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
  };
  return {run, snapshot: () => Object.fromEntries(used), errorCount: () => errorCount};
}

module.exports = {createMetadataTasks};
