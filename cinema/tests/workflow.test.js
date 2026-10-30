'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..');
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';

test('the actual runner creates and resumes its own data branch without changing main',t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cinema-workflow-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const slash=value=>value.replaceAll('\\','/');
  const globalConfig=path.join(tmp,'gitconfig'),remote=path.join(tmp,'remote.git'),seed=path.join(tmp,'seed');
  const env={...process.env,GIT_CONFIG_GLOBAL:globalConfig,GIT_CONFIG_NOSYSTEM:'1',
    GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
  function git(args,cwd=tmp){const r=spawnSync('git',args,{cwd,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
  git(['init','--bare',remote]);git(['init','-b','main',seed]);fs.writeFileSync(path.join(seed,'sentinel.txt'),'AnimeUnity unchanged');
  git(['add','.'],seed);git(['commit','-m','main sentinel'],seed);git(['remote','add','origin',remote],seed);git(['push','origin','main'],seed);
  const mainBefore=git(['rev-parse','main'],remote);
  git(['checkout','--orphan','streamingunity-data'],seed);git(['rm','-rf','.'],seed);
  fs.mkdirSync(path.join(seed,'providers/streamingunity/data'),{recursive:true});
  fs.writeFileSync(path.join(seed,'providers/streamingunity/data/manifest.json'),'{}');
  git(['add','.'],seed);git(['commit','-m','AW snapshot'],seed);git(['push','origin','streamingunity-data'],seed);
  git(['checkout','--orphan','altadefinizione-data'],seed);git(['rm','-rf','.'],seed);
  fs.mkdirSync(path.join(seed,'providers/altadefinizione/data'),{recursive:true});
  fs.writeFileSync(path.join(seed,'providers/altadefinizione/data/manifest.json'),'{}');
  git(['add','.'],seed);git(['commit','-m','AS snapshot'],seed);git(['push','origin','altadefinizione-data'],seed);
  git(['config','--file',globalConfig,`url.${slash(remote)}.insteadOf`,'https://github.com/test/cinema.git']);
  const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
  function executable(name,text){fs.writeFileSync(path.join(bin,name),'#!/usr/bin/env bash\n'+text+'\n',{mode:0o755});}
  executable('gh','[[ "$1 $2" == "auth setup-git" ]] || exit 80');
  executable('warp-cli','echo "Status update: Connected"');executable('curl','echo "warp=on"');
  executable('node','exec "$CINEMA_TEST_NODE" "$CINEMA_TEST_STUB" "$@"');
  executable('rsync','exec "$CINEMA_TEST_NODE" "$CINEMA_TEST_STUB" --copy "$@"');
  const stub=path.join(tmp,'stub.js');
  fs.writeFileSync(stub,`
const fs=require('fs'),path=require('path'),cp=require('child_process'),args=process.argv.slice(2);
if(args[0]==='--copy') {fs.cpSync(args.at(-2),args.at(-1),{recursive:true,filter:src=>!src.endsWith('.tmp')});}
else if(args[0]==='-e') {const r=cp.spawnSync(process.execPath,args,{stdio:'inherit'});process.exitCode=r.status;}
else if(args[0].endsWith('/pipeline.js')) {
  const root='cinema/data',file=path.join(root,'state.json');fs.mkdirSync(path.join(root,'items'),{recursive:true});
  const prior=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)).counter:0;
  if(prior!==Number(process.env.CINEMA_TEST_RUN)-1)throw new Error('Checkpoint not restored');
  fs.writeFileSync(file,JSON.stringify({counter:prior+1}));fs.writeFileSync(path.join(root,'items',(prior+1)+'.json'),JSON.stringify({id:prior+1}));
  console.log('CINEMA_BATCH '+JSON.stringify({hasImmediateWork:false,complete:true}));
} else if(!args[0].endsWith('/verify.js')) throw new Error('Unexpected command');
`);
  for(let run=1;run<=2;run++) {
    if(run===2){
      git(['checkout','--orphan','eurostreaming-data'],seed);git(['rm','-rf','.'],seed);
      fs.mkdirSync(path.join(seed,'providers/eurostreaming/data'),{recursive:true});
      fs.writeFileSync(path.join(seed,'providers/eurostreaming/data/manifest.json'),'{}');
      git(['add','.'],seed);git(['commit','-m','Eurostreaming snapshot'],seed);git(['push','origin','eurostreaming-data'],seed);
    }
    const work=path.join(tmp,`work-${run}`);fs.mkdirSync(path.join(work,'shared','warp'),{recursive:true});
    git(['init','-b','main',work]);git(['remote','add','origin',remote],work);
    fs.copyFileSync(path.join(repo,'shared/warp/check.sh'),path.join(work,'shared/warp/check.sh'));
    fs.copyFileSync(path.join(repo,'cinema/scripts/run-workflow.sh'),path.join(work,'runner.sh'));
    const binPath=process.platform==='win32'?slash(bin).replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()):bin;
    const r=spawnSync(bash,['-c','export PATH="$CINEMA_TEST_BIN:$PATH"; bash runner.sh'],{cwd:work,encoding:'utf8',timeout:30000,
      env:{...env,PATH:bin+path.delimiter+env.PATH,GH_REPO:'test/cinema',
        CINEMA_TEST_NODE:slash(process.execPath),CINEMA_TEST_STUB:slash(stub),CINEMA_TEST_RUN:String(run),CINEMA_TEST_BIN:binPath}});
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
    assert.equal(fs.existsSync(path.join(work,'providers/eurostreaming/data/manifest.json')),run===2);
  }
  assert.equal(git(['rev-parse','main'],remote),mainBefore);
  assert.deepEqual(JSON.parse(git(['show','cinema-data:cinema/data/state.json'],remote)),{counter:2});
  const files=git(['ls-tree','-r','--name-only','cinema-data'],remote).split('\n');
  assert.ok(files.every(file=>file.startsWith('cinema/data/')));
  assert.ok(files.includes('cinema/data/items/1.json'));
  assert.ok(files.includes('cinema/data/items/2.json'));
});
