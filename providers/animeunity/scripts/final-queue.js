'use strict';

// Reserve most capacity for initial coverage, without starving existing records.
function selectFinalBatch(candidates, limit) {
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : candidates.length;
  const missing = candidates.filter(row => !row.final);
  const refresh = candidates.filter(row => row.final);
  // Oldest work first also prevents a short, repeatedly failing title monopolizing the queue.
  missing.sort((a, b) => (a.episodes - b.episodes) || b.id - a.id);
  refresh.sort((a, b) => (Date.parse(a.final.updatedAt || 0) || 0) -
    (Date.parse(b.final.updatedAt || 0) || 0) || a.id - b.id);
  const freshCount = Math.min(missing.length, Math.ceil(size * 0.8));
  const selected = [...missing.slice(0, freshCount), ...refresh.slice(0, size - freshCount)];
  return selected.concat(missing.slice(freshCount, freshCount + size - selected.length));
}

module.exports = {selectFinalBatch};
