'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../../..'),bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
test('AnimeUnity restores and publishes only its data branch and resumes its original full refresh',t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'au-reorganization-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const slash=p=>p.replaceAll('\\','/'),remote=path.join(tmp,'remote.git'),seed=path.join(tmp,'seed'),config=path.join(tmp,'config');
 const env={...process.env,GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
 function git(args,cwd=tmp){const r=spawnSync('git',args,{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
 git(['init','--bare',remote]);git(['init','-b','main',seed]);fs.writeFileSync(path.join(seed,'sentinel'),'code');git(['add','.'],seed);git(['commit','-m','code'],seed);git(['remote','add','origin',remote],seed);git(['push','origin','main'],seed);
 const main=git(['rev-parse','main'],remote);git(['checkout','--orphan','animeunity-data'],seed);git(['rm','-rf','.'],seed);
 const data='providers/animeunity/data';for(const file of ['raw/index.json','mapped/index.json','final/manifest.json']){fs.mkdirSync(path.dirname(path.join(seed,data,file)),{recursive:true});fs.writeFileSync(path.join(seed,data,file),'{}');}
 fs.writeFileSync(path.join(seed,data,'vega-providers.ref'),'a'.repeat(40));fs.writeFileSync(path.join(seed,data,'refresh-state.json'),JSON.stringify({stage:'all',since:'2026-10-28T10:54:47Z'}));fs.writeFileSync(path.join(seed,data,'counter.json'),'0');
 git(['add','.'],seed);git(['commit','-m','snapshot'],seed);git(['push','origin','animeunity-data'],seed);
 git(['config','--file',config,`url.${slash(remote)}.insteadOf`,'https://github.com/test/animeunity.git']);
 const bin=path.join(tmp,'bin');fs.mkdirSync(bin);const stub=path.join(tmp,'stub.js');
 const exe=(name,body)=>fs.writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\n'+body+'\n',{mode:0o755});
 exe('gh','[[ "$1 $2" == "auth setup-git" ]] || exit 80');exe('warp-cli','echo "Status update: Connected"');exe('curl','echo "warp=on"');exe('npm','exit 0');
 exe('node','exec "$AU_NODE" "$AU_STUB" "$@"');exe('rsync','exec "$AU_NODE" "$AU_STUB" --copy "$@"');
 fs.writeFileSync(stub,`const fs=require('fs'),path=require('path'),cp=require('child_process'),a=process.argv.slice(2);
 if(a[0]==='--copy'){fs.cpSync(a.at(-2),a.at(-1),{recursive:true});}
 else if(['-e','-p'].includes(a[0])){process.exitCode=cp.spawnSync(process.execPath,a,{stdio:'inherit'}).status;}
 else if(a[0].endsWith('/pipeline.js')){if(a[a.indexOf('--full-since')+1]!=='2026-10-28T10:54:47Z')throw Error('Full refresh reset');const p='${data}/counter.json',n=JSON.parse(fs.readFileSync(p));if(n!==Number(process.env.AU_RUN)-1)throw Error('Checkpoint not resumed');fs.writeFileSync(p,JSON.stringify(n+1));console.log('PIPELINE_BATCH '+JSON.stringify({selected:{raw:1},complete:false}));}
 else throw Error('Unexpected command');`);
 for(let run=1;run<=2;run++){
  const work=path.join(tmp,'work'+run),scripts=path.join(work,'providers/animeunity/scripts');fs.mkdirSync(scripts,{recursive:true});
  for(const file of ['checkpoint.sh','run-workflow.sh','check-warp.sh'])fs.copyFileSync(path.join(repo,'providers/animeunity/scripts',file),path.join(scripts,file));
  const binPath=process.platform==='win32'?slash(bin).replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase()):bin;
  const r=spawnSync(bash,['-c','export PATH="$AU_BIN:$PATH"; bash providers/animeunity/scripts/checkpoint.sh restore && bash providers/animeunity/scripts/run-workflow.sh'],{cwd:work,encoding:'utf8',timeout:60000,env:{...env,AU_BIN:binPath,AU_NODE:slash(process.execPath),AU_STUB:slash(stub),AU_RUN:String(run),GH_REPO:'test/animeunity',GITHUB_REF_NAME:'reorganize-animeunity',RUN_MODE:'update',RUN_STAGE:'all',RUN_SINGLE_BATCH:'true'}});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
 }
 assert.equal(git(['rev-parse','main'],remote),main);assert.equal(git(['show',`animeunity-data:${data}/counter.json`],remote),'2');
 assert.equal(JSON.parse(git(['show',`animeunity-data:${data}/refresh-state.json`],remote)).since,'2026-10-28T10:54:47Z');
 assert.ok(git(['ls-tree','-r','--name-only','animeunity-data'],remote).split('\n').every(p=>p.startsWith(data+'/')));
 git(['push','origin','--delete','animeunity-data'],seed);
 const missing=path.join(tmp,'missing');fs.mkdirSync(path.join(missing,'providers/animeunity/scripts'),{recursive:true});
 for(const f of ['checkpoint.sh','check-warp.sh'])fs.copyFileSync(path.join(repo,'providers/animeunity/scripts',f),path.join(missing,'providers/animeunity/scripts',f));
 const binPath=process.platform==='win32'?slash(bin).replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase()):bin;
 const failure=spawnSync(bash,['-c','export PATH="$AU_BIN:$PATH"; bash providers/animeunity/scripts/checkpoint.sh restore'],{cwd:missing,encoding:'utf8',env:{...env,AU_BIN:binPath,GH_REPO:'test/animeunity'}});
 assert.notEqual(failure.status,0);assert(!fs.existsSync(path.join(missing,data,'raw/index.json')));
});
test('migration workflows pin code, require the saved data and never publish main',()=>{
 const read=p=>fs.readFileSync(path.join(repo,p),'utf8');const yaml=read('.github/workflows/update-animeunity.yml'),shell=read('providers/animeunity/scripts/checkpoint.sh');
 assert.match(yaml,/ref: \$\{\{ github.sha \}\}/);assert.match(yaml,/npm run verify:all/);assert.match(yaml,/single_batch:/);assert.match(yaml,/verify_only:/);
 assert.match(yaml,/data\/vega-providers.ref/);assert(!yaml.includes('rev-parse HEAD > vega-providers.ref'));
 assert.match(shell,/Missing checkpoint/);assert.match(shell,/fetch --depth=1 origin "\$data_branch"/);assert(!shell.includes('pull --rebase'));assert(!shell.includes('push origin main'));
 assert.match(read('unified/scripts/run-workflow.sh'),/for provider in animeunity animeworld/);
 assert.match(read('.github/workflows/migrate-animeunity-links.yml'),/checkpoint.sh publish/);
 const {DATA,ROOT}=require('../scripts/lib');assert.equal(ROOT,repo);assert.equal(DATA,path.join(repo,'providers/animeunity/data'));
});
