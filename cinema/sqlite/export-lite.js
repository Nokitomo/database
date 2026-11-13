'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {read} = require('../../shared/storage/json');
const {verify} = require('../scripts/verify');
const {normalize} = require('./normalize');

const homeFields = [
  'title', 'name', 'original_title', 'original_name', 'original_language',
  'synopsis', 'type', 'year', 'genres', 'created_at', 'views', 'views_count',
];
const homeRoles = new Set(['poster', 'background', 'logo']);

function exportLite(root, output) {
  const manifest = read(path.join(root, 'manifest.json'));
  if (manifest?.complete !== true || manifest.pendingCount !== 0 ||
      !Object.keys(manifest.sources || {}).length ||
      Object.values(manifest.sources).some(source => source.complete !== true)) {
    throw Error('Lite requires a complete Cinema snapshot');
  }

  const fd = fs.openSync(output, 'wx');
  const rules = new Map();
  const write = value => fs.writeSync(fd, JSON.stringify(value) + '\n');
  try {
    verify(root, {onRecord(record) {
      if (!/^work-\d+$/.test(record.id)) throw Error('Unexpected Cinema work ID');
      if (Object.values(record.providers).flat().some(source => source.availability === 'unknown') ||
          (record.active && ['retry', 'pending'].includes(record.enrichment?.status))) {
        throw Error('Unresolved Cinema record');
      }

      const detail = fs.readFileSync(path.join(root, 'items', record.id + '.json'));
      const info = Object.fromEntries(homeFields
        .filter(field => Object.hasOwn(record.info, field))
        .map(field => [field, record.info[field]]));
      write(['work', record.id, Number(record.active), record.replacedBy ?? null,
        info, createHash('sha256').update(detail).digest('hex'), detail.length]);

      const rows = normalize(record, manifest.origins);
      const urls = new Map(rows.filter(row => row.kind === 'artwork')
        .map(row => [row.id, row.payload.url]));
      for (const row of rows) {
        if (row.kind !== 'artwork_assignment' || !row.payload.eligible) continue;
        const {scope, field, source, language, forced, rank, width, height} = row.payload;
        const rule = [scope, field, source, language];
        rules.set(JSON.stringify(rule), rule);
        if (scope === 'work' && homeRoles.has(field)) {
          write(['artwork', row.id, record.id, field, source, language,
            Number(forced), rank, width, height, urls.get(row.artworkId)]);
        }
      }
    }});
    for (const rule of [...rules.keys()].sort()) write(['rule', ...rules.get(rule)]);
    write(['source', manifest.count, manifest.activeCount, manifest.origins]);
  } finally {
    fs.closeSync(fd);
  }
}

if (require.main === module) exportLite(...process.argv.slice(2));
module.exports = {exportLite};
