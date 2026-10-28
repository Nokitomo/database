'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'anime_database');
const iso = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const file = (stage, id) => path.join(DATA, stage, 'items', `${id}.json`);

function readJson(filename, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  fs.renameSync(temporary, filename);
}

function listIds(stage) {
  const dir = path.join(DATA, stage, 'items');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name))
    .map(name => Number(name.slice(0, -5))).sort((a, b) => a - b);
}

function parseArgs(argv) {
  const options = {stage: 'all', limit: Infinity, ids: null, full: false, fullSince: null,
    providerRoot: process.env.VEGA_PROVIDERS_ROOT || '', allowPartial: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['raw', 'mapped', 'final', 'all'].includes(arg)) options.stage = arg;
    else if (arg === '--limit') options.limit = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--ids') options.ids = new Set(String(argv[++i] || '').split(',').map(Number).filter(value => Number.isInteger(value) && value > 0));
    else if (arg === '--provider-root') options.providerRoot = argv[++i] || '';
    else if (arg === '--full') options.full = true;
    else if (arg === '--full-since') {
      const value = argv[++i];
      if (!value || !Number.isFinite(Date.parse(value))) throw new Error('Invalid --full-since timestamp');
      options.full = true;
      options.fullSince = Date.parse(value);
    }
    else if (arg === '--allow-partial') options.allowPartial = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

module.exports = {ROOT, DATA, file, hash, iso, listIds, parseArgs, readJson, sleep, writeJson};
