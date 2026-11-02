'use strict';

function rememberedItem(item) {
  return {id: item.id, ...(item.slug ? {slug: item.slug} : {}),
    ...(item.path ? {path: item.path} : {})};
}

function archiveItem(item) {
  return {...rememberedItem(item), archiveRecord: item.archiveRecord};
}

function initialDiscoveryState(previousIndex, rawRecords) {
  const known = {};
  for (const id of previousIndex.expectedIds || []) known[id] = {id};
  for (const raw of rawRecords) {
    if (raw?.id) known[raw.id] = rememberedItem({...known[raw.id], ...raw});
  }
  for (const item of previousIndex.archiveOnly || []) known[item.id] = rememberedItem(item);
  return {schemaVersion: 1, archive: null, known, inactive: {}, reactivationPending: {}};
}

function mergeDiscoveredItems(sitemap, archive, remembered = []) {
  const merged = new Map(remembered.map(item => [item.id, item]));
  for (const [id, item] of archive || []) {
    merged.set(id, {...merged.get(id), ...item});
  }
  for (const [id, item] of sitemap) {
    merged.set(id, {...merged.get(id), ...item});
  }
  return merged;
}

async function reconcileDiscovery({sitemap, archive, state, verifyUnavailable}) {
  const known = {...state.known};
  const inactive = {...state.inactive};
  const reactivationPending = {...state.reactivationPending};
  const archived = archive?.items || new Map((state.archive?.items || []).map(item => [item.id, item]));
  const sighted = mergeDiscoveredItems(sitemap, archived);
  const reactivated = new Set();
  for (const [id, item] of sighted) {
    known[id] = rememberedItem({...known[id], ...item});
    if (inactive[id]) {
      delete inactive[id];
      reactivationPending[id] = {seenAt: new Date().toISOString()};
      reactivated.add(id);
    }
  }
  const merged = mergeDiscoveredItems(sitemap, archived, Object.values(known));
  const verifiedPaths = {...state.verifiedPaths};
  for (const [key, verified] of Object.entries(verifiedPaths)) {
    const id = Number(key), item = merged.get(id);
    if (!item) continue;
    // A newly changed archive path must be checked again. An old sitemap
    // alias cannot override the path confirmed by the provider's info API.
    const freshPath = archive?.items.get(id)?.path;
    if (freshPath && freshPath !== verified.archivePath && freshPath !== verified.path) {
      delete verifiedPaths[key];
      merged.set(id, {...item, ...archive.items.get(id)});
    } else {
      merged.set(id, {...item, path: verified.path, slug: verified.slug});
    }
  }
  const removed = [];
  // Only a newly completed archive scan can propose removals. A missing sitemap
  // entry or a failed archive scan cannot change availability.
  if (archive) {
    for (const [id, item] of merged) {
      if (sitemap.has(id) || archived.has(id) || inactive[id]) continue;
      if (await verifyUnavailable(id, item)) {
        inactive[id] = {confirmedAt: new Date().toISOString(), reason: 'archive-and-source-absent'};
        delete reactivationPending[id];
        removed.push(id);
      }
    }
  }
  for (const id of Object.keys(inactive)) merged.delete(Number(id));
  return {merged, reactivated, removed, state: {
    schemaVersion: 1,
    archive: archive ? {checkedAt: new Date().toISOString(), total: archive.total,
      items: [...archive.items.values()].map(archiveItem)} : state.archive || null,
    known, inactive, reactivationPending, verifiedPaths,
  }};
}

module.exports = {archiveItem, initialDiscoveryState, mergeDiscoveredItems, reconcileDiscovery, rememberedItem};
