'use strict';

const FIELDS = ['logo', 'poster', 'background'];

function buildArtworkFallbacks(info, inventory) {
  const result = {};
  for (const field of FIELDS) {
    const seen = new Set();
    const candidates = [
      {source: info?.extra?.artworkSources?.[field] || 'selected', url: info?.[field]},
      ...(inventory?.[field] || []),
    ];
    result[field] = candidates.filter(candidate => {
      if (!candidate?.url || seen.has(candidate.url)) return false;
      try {
        if (new URL(candidate.url).protocol !== 'https:') return false;
      } catch { return false; }
      seen.add(candidate.url);
      return true;
    });
  }
  return result;
}

function nextArtworkUrl(candidates, failedUrls = []) {
  const failed = new Set(failedUrls);
  return (candidates || []).find(candidate => !failed.has(candidate.url))?.url || null;
}

module.exports = {buildArtworkFallbacks, nextArtworkUrl};
