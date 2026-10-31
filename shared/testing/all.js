'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),files=[];
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['data','node_modules','.cache'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())visit(p);else if(e.name.endsWith('.test.js'))files.push(p);}}
for(const dir of ['tests','providers','unified/tests','cinema/tests'])visit(path.join(root,dir));
const result=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit'});process.exitCode=result.status??1;
