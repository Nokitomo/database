'use strict';

const path = require('node:path');
const {Client} = require('./http');
const {parseListing, parseAnime, parseTooltip, parseHomeImages, parseSchedule, unique,
  pageUnavailable, tooltipUnavailable} = require('./parse');
const {DEFAULT_DATA, hash, read, write, itemFile, initialState, activeIds, observe, publish} = require('./store');
const HOUR = 3600000, DAY = 24 * HOUR;
const retryDue = (error, now) => !error || now >= error.retryAt;
const failure = (error, now, previous) => ({message: error.message, status: error.status || null,
  at: now, attempts: (previous?.attempts || 0) + 1,
  retryAt: now + Math.max(error.retryMs || 0, Math.min(12 * HOUR, HOUR * 2 ** Math.min(previous?.attempts || 0, 4)))});
const signature = listing => hash(listing.cards.map(item => [item.id, item.path]));

function recordDue(state, id, now) {
  const known = state.known[id], record = state.records[id];
  if (!known.active || !retryDue(record?.error, now)) return false;
  return !record?.pageAt || !record?.tooltipAt || known.forceRefresh || known.missingScanAt ||
    (state.full && (record.pageAt < state.full.since || record.tooltipAt < state.full.since)) ||
    now >= record.nextCheckAt;
}

function workStatus(state, now, stage = 'all') {
  const ids = activeIds(state);
  const pending = ids.filter(id => recordDue(state, id, now));
  const missing = ids.filter(id => !state.records[id]?.pageAt || !state.records[id]?.tooltipAt);
  const hasRecordErrors = ids.some(id => state.records[id]?.error);
  const archiveDue = !state.archive.completedAt || now - state.archive.completedAt >= DAY ||
    Boolean(state.full && state.archive.completedAt < state.full.since);
  const discoveryWork = (Boolean(state.archive.scan) || archiveDue) && retryDue(state.errors.archive, now) ||
    ['newest', 'updated'].some(name => (state.feeds[name]?.scan || !state.feeds[name]?.checkedAt ||
      now - state.feeds[name].checkedAt >= 2 * HOUR) && retryDue(state.errors[name], now)) ||
    (!state.extras.checkedAt || now - state.extras.checkedAt >= 2 * HOUR) && retryDue(state.errors.extras, now);
  const complete = Boolean(state.archive.completedAt) && !state.archive.scan && missing.length === 0 &&
    !hasRecordErrors && Object.keys(state.errors).length === 0 && pending.length === 0 && !discoveryWork;
  return {complete, pendingCount: pending.length, missingCount: missing.length,
    hasImmediateWork: stage === 'publish' ? false : stage === 'discover' ? Boolean(discoveryWork) :
      stage === 'details' ? pending.length > 0 : Boolean(discoveryWork || pending.length)};
}

async function scanArchive(client, state, root, {pagesPerBatch, now, save}) {
  if (!retryDue(state.errors.archive, now)) return;
  if (!state.archive.scan && state.archive.completedAt && now - state.archive.completedAt < DAY &&
      (!state.full || state.archive.completedAt >= state.full.since)) return;
  let scan = state.archive.scan;
  try {
    for (let count = 0; count < pagesPerBatch; count++) {
      if (scan && scan.nextPage > scan.pages) {
        if (Object.keys(scan.items).length !== scan.total) throw new Error('Archive unique count mismatch');
        const first = parseListing((await client.get('/az-list?page=1')).html, client.baseUrl,
          {archive: true, page: 1, origins: state.origins});
        const last = parseListing((await client.get(`/az-list?page=${scan.pages}`)).html, client.baseUrl,
          {archive: true, page: scan.pages, origins: state.origins});
        if (first.total !== scan.total || last.total !== scan.total || signature(first) !== scan.firstSignature ||
            signature(last) !== scan.lastSignature) throw new Error('Archive changed before scan completion');
        for (const known of Object.values(state.known)) {
          if (!scan.items[known.id] && known.active && known.lastSeenAt < scan.startedAt) known.missingScanAt = now;
        }
        write(path.join(root, 'archive.json'), {schemaVersion: 1, checkedAt: now,
          total: scan.total, items: Object.values(scan.items).sort((a,b) => a.id-b.id)});
        state.archive = {completedAt: now, total: scan.total};
        delete state.errors.archive;
        save();
        console.log(`animeworld archive: complete, ${scan.total} unique titles`);
        return;
      }
      const page = scan?.nextPage || 1;
      const {html} = await client.get(`/az-list?page=${page}`);
      const listing = parseListing(html, client.baseUrl, {archive: true, page, origins: state.origins});
      if (!scan) scan = state.archive.scan = {startedAt: now, nextPage: 1,
        pages: listing.pages, total: listing.total, items: {}, firstSignature: signature(listing)};
      if (listing.total !== scan.total || listing.pages !== scan.pages) throw new Error('Archive total changed during scan');
      for (const card of listing.cards) {
        if (scan.items[card.id]) throw new Error(`Repeated anime ${card.id} across archive pages`);
        scan.items[card.id] = card;
        observe(state, card, now);
      }
      scan.nextPage = page + 1;
      scan.lastSignature = signature(listing);
      delete state.errors.archive;
      save();
      console.log(`animeworld archive: page ${page}/${scan.pages}, ${Object.keys(scan.items).length}/${scan.total} titles`);
    }
  } catch (error) {
    if (/WARP_REQUIRED/.test(error.message) || client.signal?.aborted) throw error;
    state.errors.archive = failure(error, now, state.errors.archive);
    // Restart inconsistent pagination; transient network failures keep the cursor.
    if (!error.status && /Archive|archive|pagination|Repeated|Invalid/.test(error.message)) delete state.archive.scan;
    save();
    console.error(`animeworld archive: ${error.message}; previous membership retained`);
  }
}

async function scanFeed(client, state, name, {now, save, pagesPerBatch = 5}) {
  const feed = state.feeds[name] ||= {};
  if (!retryDue(state.errors[name], now) || !feed.scan && feed.checkedAt && now - feed.checkedAt < 2 * HOUR) return;
  try {
    for (let count = 0; count < pagesPerBatch; count++) {
      const scan = feed.scan ||= {page: 1, anchors: feed.head || [], head: null, signatures: []};
      const listing = parseListing((await client.get(`/${name}?page=${scan.page}`)).html,
        client.baseUrl, {page: scan.page, origins: state.origins});
      const keys = listing.cards.map(card => `${card.id}:${name === 'updated' ? card.token || card.episodeLabel : card.code}`);
      const pageHash = hash(keys);
      if (scan.signatures.includes(pageHash)) throw new Error('Repeated feed page');
      scan.signatures.push(pageHash);
      if (!scan.head) scan.head = keys;
      const anchors = new Set(scan.anchors);
      for (let i = 0; i < listing.cards.length; i++) observe(state, listing.cards[i], now, !anchors.has(keys[i]), name);
      const overlaps = new Set(keys.filter(key => anchors.has(key))).size;
      if (!anchors.size || overlaps >= Math.min(3, anchors.size) || scan.page === listing.pages) {
        feed.head = scan.head; feed.checkedAt = now; delete feed.scan; delete state.errors[name]; save(); return;
      }
      scan.page++;
      save();
    }
  } catch (error) {
    if (/WARP_REQUIRED/.test(error.message) || client.signal?.aborted) throw error;
    state.errors[name] = failure(error, now, state.errors[name]);
    // Re-scan from the head next time; the old watermark is unchanged.
    delete feed.scan; save();
    console.error(`animeworld ${name}: ${error.message}`);
  }
}

async function extras(client, state, home, {now, save}) {
  if (!retryDue(state.errors.extras, now) || state.extras.checkedAt && now - state.extras.checkedAt < 2 * HOUR) return;
  try {
    const images = parseHomeImages(home.html, client.baseUrl, state.origins);
    for (const [code, values] of Object.entries(images)) {
      const prior = state.extras.images[code] || [];
      const next = unique([...prior, ...values]);
      if (hash(prior) !== hash(next)) for (const known of Object.values(state.known)) if (known.code === code) known.forceRefresh = true;
      state.extras.images[code] = next;
    }
    const schedule = parseSchedule((await client.get('/schedule')).html, client.baseUrl, state.origins);
    for (const known of Object.values(state.known)) {
      if (hash(schedule[known.code] || []) !== hash(state.extras.schedule[known.code] || [])) known.forceRefresh = true;
    }
    state.extras.schedule = schedule;
    state.extras.checkedAt = now;
    delete state.errors.extras;
  } catch (error) {
    if (/WARP_REQUIRED/.test(error.message) || client.signal?.aborted) throw error;
    state.errors.extras = failure(error, now, state.errors.extras);
    console.error(`animeworld extra artwork/calendar: ${error.message}`);
  }
  save();
}

async function scrapeRecord(client, state, root, id, now) {
  const known = state.known[id], meta = state.records[id] ||= {};
  let record = read(itemFile(root, id));
  try {
    const needPage = !record || !meta.pageAt || known.forceRefresh || known.missingScanAt ||
      state.full && meta.pageAt < state.full.since || now >= meta.nextCheckAt;
    if (needPage) {
      let response;
      try {
        response = await client.get(known.path);
        if (pageUnavailable(response.html)) throw Object.assign(new Error('Provider reports page not found'), {unavailable: true});
      }
      catch (error) {
        // A verified complete archive omission AND two independent provider
        // endpoints must confirm absence before excluding an existing record.
        if (known.missingScanAt && (error.unavailable || [404,410].includes(error.status))) {
          let missing = false;
          try {missing = tooltipUnavailable((await client.get(`/api/tooltip/${id}`)).html);}
          catch (tooltipError) {
            missing = [404,410].includes(tooltipError.status);
            if (/WARP_REQUIRED/.test(tooltipError.message)) throw tooltipError;
          }
          if (missing) {
            known.active = false; known.removedAt = now; known.forceRefresh = false;
            delete meta.error; return;
          }
        }
        throw error;
      }
      const next = parseAnime(response.html, client.baseUrl, known, state.origins);
      // The URL can change its slug without changing the provider identity.
      known.path = next.path;
      next.tooltip = record?.tooltip || null;
      next.images = unique([...next.images, ...(record?.images || []).filter(image => image.kind === 'banner'),
        ...(state.extras.images[known.code] || []), ...(known.poster ? [{kind: 'listing-poster', url: known.poster}] : [])]);
      next.schedule = state.extras.schedule[known.code] || [];
      record = next;
      meta.pageAt = now;
      // Refresh tooltip metadata alongside the page; retain prior successful
      // fields on failure and retry only the missing task in the next batch.
      meta.tooltipAt = null;
      known.forceRefresh = false;
      known.missingScanAt = null;
      meta.nextCheckAt = now + (record.episodes.length === 0 || ['ongoing','upcoming','unknown'].includes(record.info.status) ? 12 * HOUR : 30 * DAY);
      write(itemFile(root, id), record);
    }
    if (!meta.tooltipAt || state.full && meta.tooltipAt < state.full.since) {
      record.tooltip = parseTooltip((await client.get(`/api/tooltip/${id}`)).html, client.baseUrl, known, state.origins);
      meta.tooltipAt = now;
    }
    record.images = unique([...record.images, ...(state.extras.images[known.code] || [])]);
    record.schedule = state.extras.schedule[known.code] || [];
    record.images = unique([...record.images, ...record.schedule.filter(entry => entry.poster)
      .map(entry => ({kind: 'schedule-poster', url: entry.poster}))]);
    write(itemFile(root, id), record);
    delete meta.error;
    console.log(`animeworld ${id}: ${record.info.title}, ${record.episodes.length} episodes`);
  } catch (error) {
    if (/WARP_REQUIRED/.test(error.message) || client.signal?.aborted) throw error;
    meta.error = failure(error, now, meta.error);
    console.error(`animeworld ${id}: ${error.message}; saved data retained`);
  }
}

async function runBatch({root = DEFAULT_DATA, mode = 'update', stage = 'all', batchSize = 50,
  pagesPerBatch = 20, client = new Client(), now = Date.now()} = {}) {
  if (!['update','full'].includes(mode) || !['all','discover','details','publish'].includes(stage)) throw new Error('Invalid run mode/stage');
  const statePath = path.join(root, 'state.json');
  const state = read(statePath, initialState());
  if (state.schemaVersion !== 1 || state.provider !== 'animeworld') throw new Error('Unsupported state schema');
  const save = () => write(statePath, state);
  if (mode === 'full' && !state.full && stage !== 'publish') state.full = {since: now};
  let processed = 0, fatal;
  try {
    if (stage !== 'publish') {
      const home = await client.discover();
      state.origins.site = client.baseUrl;
      state.discovery = {source: home.source, pastebin: home.pastebin, pasteError: home.pasteError};
      if (['all','discover'].includes(stage)) {
        await scanArchive(client, state, root, {pagesPerBatch, now, save});
        await scanFeed(client, state, 'newest', {now, save});
        await scanFeed(client, state, 'updated', {now, save});
        await extras(client, state, home, {now, save});
      }
      if (['all','details'].includes(stage)) {
        const ids = activeIds(state).filter(id => recordDue(state,id,now)).sort((a,b) =>
          (state.records[a]?.pageAt || 0) - (state.records[b]?.pageAt || 0) || b-a).slice(0,batchSize);
        for (const id of ids) { await scrapeRecord(client,state,root,id,now); processed++; save(); }
      }
      delete state.errors.connection;
    }
  } catch (error) {
    if (/WARP_REQUIRED/.test(error.message)) throw error;
    if (!client.signal?.aborted) {
      state.errors.connection = failure(error, now, state.errors.connection);
      fatal = error;
    }
  }
  const status = workStatus(state, now, stage);
  if (status.complete) delete state.full;
  save();
  const manifest = publish(root,state,status,now);
  const result = {...status, processed, expected: manifest.expectedCount, available: manifest.availableCount,
    fatal: fatal?.message || null};
  console.log(`ANIMEWORLD_BATCH ${JSON.stringify(result)}`);
  return result;
}

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i], value = argv[++i];
    if (name === '--data-dir') result.root = path.resolve(value);
    else if (name === '--mode') result.mode = value;
    else if (name === '--stage') result.stage = value;
    else if (['--batch-size','--archive-pages'].includes(name)) {
      if (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>1000) throw new Error(`Invalid ${name}`);
      result[name === '--batch-size' ? 'batchSize' : 'pagesPerBatch'] = Number(value);
    } else throw new Error(`Unknown argument ${name}`);
  }
  return result;
}
if (require.main === module) {
  // End each batch in time to validate and publish its checkpoint.
  runBatch({...options(process.argv.slice(2)), client: new Client({signal: AbortSignal.timeout(180000)})})
    .then(result => {if (result.fatal) process.exitCode = 1;})
    .catch(error => {console.error(error.message);process.exitCode=1;});
}

module.exports = {runBatch, recordDue, workStatus, scanArchive, scanFeed, scrapeRecord, options};
