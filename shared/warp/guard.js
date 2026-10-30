'use strict';

const {execFileSync} = require('node:child_process');

function connected(value) { return /Status update:\s*Connected(?:\s|$)/m.test(String(value)); }
function assertWarp() {
  if (process.env.WARP_REQUIRED !== '1') return;
  let status;
  try { status = execFileSync('warp-cli', ['--accept-tos', 'status'],
    {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']}); }
  catch { throw new Error('WARP_REQUIRED: status unavailable; request blocked'); }
  if (!connected(status)) throw new Error('WARP_REQUIRED: disconnected; request blocked');
}

module.exports = {connected, assertWarp};
