'use strict';

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const faultMarker = path.join(__dirname, '../../..', '.cache', 'warp-fault');

function fail(message) {
  fs.mkdirSync(path.dirname(faultMarker), {recursive: true});
  fs.writeFileSync(faultMarker, `${new Date().toISOString()} ${message}\n`);
  throw new Error(message);
}

function connected(status) {
  return /Status update:\s*Connected(?:\s|$)/m.test(String(status));
}

function assertWarp() {
  if (process.env.WARP_REQUIRED !== '1') return;
  if (fs.existsSync(faultMarker)) throw new Error('Cloudflare WARP failed earlier in this run');
  let status;
  try {
    status = execFileSync('warp-cli', ['--accept-tos', 'status'],
      {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']});
  } catch {
    fail('Cloudflare WARP is required but its status is unavailable');
  }
  if (!connected(status)) fail('Cloudflare WARP disconnected; request blocked');
}

module.exports = {assertWarp, connected};
