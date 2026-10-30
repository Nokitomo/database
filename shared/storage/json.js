'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function read(file, fallback = null) {
  try {return JSON.parse(fs.readFileSync(file, 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return fallback; throw error;}
}
function write(file, value) {
  const body = JSON.stringify(value) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) return;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = file + `.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, file);
}

module.exports = {read,write,hash};
