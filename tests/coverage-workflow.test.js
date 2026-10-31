'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('coverage downloader handles first-build absence, raw snapshots and WARP failure',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'coverage-workflow-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.resolve(__dirname,'..'),bin=path.join(root,'bin');fs.mkdirSync(bin);
 fs.mkdirSync(path.join(root,'shared/warp'),{recursive:true});
 fs.writeFileSync(path.join(root,'shared/warp/check.sh'),'exit "${WARP_RESULT:-0}"\n');
 fs.writeFileSync(path.join(bin,'gh'),'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> calls.txt\nif [[ "${API_RESULT:-0}" != 0 ]]; then exit 1; fi\nprintf \'{"schemaVersion":1}\\n\'\n',{mode:0o755});
 const slash=v=>v.replaceAll('\\','/'),binPath=process.platform==='win32'?slash(bin).replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase()):bin;
 const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
 const run=extra=>spawnSync(bash,['-c','export PATH="$COVERAGE_TEST_BIN:$PATH"; bash "$COVERAGE_SCRIPT" cinema'],{cwd:root,encoding:'utf8',env:{...process.env,COVERAGE_TEST_BIN:binPath,COVERAGE_SCRIPT:slash(path.join(repo,'shared/catalog/fetch-coverage.sh')),GITHUB_ENV:slash(path.join(root,'env.txt')),GH_REPO:'test/repo',...extra}});
 let r=run({API_RESULT:'1'});assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(path.join(root,'.cache/catalog/cinema-coverage.json'),'utf8').trim(),'null');
 r=run({API_RESULT:'0'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.cache/catalog/cinema-coverage.json'))).schemaVersion,1);
 assert(fs.readFileSync(path.join(root,'calls.txt'),'utf8').includes('ref=cinema-data'));assert(fs.readFileSync(path.join(root,'env.txt'),'utf8').includes('CATALOG_COVERAGE='));
 const before=fs.readFileSync(path.join(root,'calls.txt'),'utf8');r=run({WARP_RESULT:'1'});assert.notEqual(r.status,0);assert.equal(fs.readFileSync(path.join(root,'calls.txt'),'utf8'),before);
});
