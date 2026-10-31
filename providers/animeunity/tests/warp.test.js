'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {connected, assertWarp} = require('../scripts/warp');

test('WARP status must explicitly report Connected', () => {
  assert.equal(connected('Status update: Connected\nNetwork: healthy'), true);
  assert.equal(connected('Status update: Connecting\n'), false);
  assert.equal(connected('Status update: Disconnected\n'), false);
  assert.equal(connected('Connected: false'), false);
});

test('local tests do not require or install WARP', () => {
  const previous = process.env.WARP_REQUIRED;
  try {
    delete process.env.WARP_REQUIRED;
    assert.doesNotThrow(() => assertWarp());
  } finally {
    if (previous === undefined) delete process.env.WARP_REQUIRED;
    else process.env.WARP_REQUIRED = previous;
  }
});
