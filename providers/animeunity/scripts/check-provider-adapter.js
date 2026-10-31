'use strict';
const assert = require('node:assert/strict');
const {requireProvider} = require('./vega');
const {installMappingOverride} = require('./mapping-policy');
async function check(root) {
  const resolver = requireProvider(root, 'mappings/resolver.js');
  const index = requireProvider(root, 'mappings/index.js');
  installMappingOverride(resolver);
  const resolution = {targets: [], metadataTargets: [], ids: {}};
  const providerContext = {databaseMappingOverride: {anilistId: 42, resolution}};
  assert.equal(await index.resolveAnimeMappings({providerContext, anilistId: 42, isMovie: false}), resolution);
  const normal = await index.resolveAnimeMappings({providerContext: {}, isMovie: false});
  assert.deepEqual(normal.targets, []);
  console.log('Pinned Vega mapping adapter verified');
}
check(process.argv[2]).catch(error => {console.error(error); process.exitCode = 1;});
