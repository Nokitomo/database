'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('publication upload/activation interruption resumes; corrupt assets and incomplete sources fail closed',()=>{
  const result=spawnSync(process.env.PYTHON||'python',['-B',path.join(__dirname,'sqlite-publication.py')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
test('workflow has explicit trigger, serialization and no scraper dependency',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../../.github/workflows/publish-cinema-sqlite.yml'),'utf8');
  assert.match(source,/workflow_dispatch:/);assert.match(source,/cancel-in-progress: false/);assert.match(source,/contents: write/);
  assert.match(source,/python-version: '3.12'/);assert(!source.includes('WARP'));assert(!source.includes('pull_request'));
  assert.match(fs.readFileSync(path.join(__dirname,'../../.github/workflows/update-cinema.yml'),'utf8'),/gh workflow run publish-cinema-sqlite.yml --ref main/);
});
