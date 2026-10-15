import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,existsSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const inside=(p,c)=>{const r=relative(p,c);return r&&!r.startsWith('..')&&!isAbsolute(r);};
const preload=String.raw`
import cp from 'node:child_process';import fs from 'node:fs';import {join,relative,isAbsolute} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const dir=fs.realpathSync(process.env.FLOWATLAS_QA_BUDGET_DIR),repo=fs.realpathSync(process.env.FLOWATLAS_QA_BUDGET_REPO),delayAt=Number(process.env.FLOWATLAS_QA_BUDGET_DELAY_AT);
if(!relative(join(repo,'reports/storage'),dir).startsWith('git-budget-'))throw Error('unsafe_qa_scope');
const original=cp.execFileSync;let calls=0;const timeouts=[];
cp.execFileSync=function(executable,args,options){if(executable!=='git')return original.call(this,executable,args,options);
 const cwd=fs.realpathSync(options.cwd);const rel=relative(dir,cwd);if(cwd!==repo&&(rel.startsWith('..')||isAbsolute(rel)))throw Error('unsafe_qa_cwd');
 calls++;timeouts.push(options.timeout);if(calls===1)fs.writeFileSync(join(dir,'apps/p15/app.mjs'),'export const value=999;\n');if(!Number.isSafeInteger(options.timeout)||options.timeout<1||options.timeout>1000)throw Error('unbounded_git_timeout');
 if(calls===delayAt)original.call(this,process.execPath,[join(dir,'delay.mjs'),join(dir,'delay.pid')],options);
 if(args[0]==='rev-parse'&&args[1]==='--show-toplevel')return Buffer.from(cwd+'\n');
 if(args[0]==='rev-parse'&&args[1]==='HEAD')return Buffer.from('a'.repeat(40)+'\n');
 if(args[0]==='status')return Buffer.from('');throw Error('unexpected_git_command');
};syncBuiltinESMExports();globalThis.qaBudgetCalls=()=>({calls,timeouts});
`;
const worker=String.raw`
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import fs from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const dir=process.env.FLOWATLAS_QA_BUDGET_DIR,repo=process.env.FLOWATLAS_QA_BUDGET_REPO;
const {getCodeVersion}=await import(pathToFileURL(join(repo,'src/flowatlas.mjs')));
const {ProjectSources}=await import(pathToFileURL(join(repo,'src/project-sources.mjs')));
const {startServers}=await import(pathToFileURL(join(repo,'src/server.mjs')));
const registrations=Array.from({length:16},(_,i)=>({id:'qa'+i,root:'apps/p'+i,files:['app.mjs']}));
const disabled={runGit(){throw Error('metadata unavailable baseline');}};
const baseline=getCodeVersion(repo,null,disabled),projects=new ProjectSources(dir,registrations,disabled);
const started=performance.now();let servers;
try{servers=await startServers({port:0,inventoryPort:0,workspace:dir,dataDir:'data/actions',projects:registrations});
 assert.equal(servers.atlas.version.digest,baseline.digest);assert.deepEqual(servers.atlas.version.files,baseline.files);
 const versions=[servers.atlas.version,...registrations.map(r=>{const v=servers.atlas.projectSources.version(r.id),expected=projects.version(r.id);if(r.id==='qa15'){assert.notEqual(v.digest,expected.digest);assert.equal(v.files['app.mjs'],createHash('sha256').update(fs.readFileSync(join(dir,r.root,'app.mjs'))).digest('hex'));}else{assert.equal(v.digest,expected.digest);assert.deepEqual(v.files,expected.files);}return v;})];
 const delayAt=Number(process.env.FLOWATLAS_QA_BUDGET_DELAY_AT),allUnknown=versions.every(v=>v.commit===null&&v.dirty===null),allKnown=versions.every(v=>v.commit==='a'.repeat(40)&&v.dirty===false);
 const pidFile=join(dir,'delay.pid'),pid=fs.existsSync(pidFile)?Number(fs.readFileSync(pidFile,'utf8')):null;let delayedChildStopped=null;
 if(Number.isSafeInteger(pid)&&pid>0&&pid!==process.pid){try{process.kill(pid,0);delayedChildStopped=false;}catch(e){delayedChildStopped=e.code==='ESRCH';}}
 await servers.close();servers=null;
 process.send({kind:'result',delayAt,elapsedMs:performance.now()-started,...globalThis.qaBudgetCalls(),snapshots:versions.length,allUnknown,allKnown,digestExact:true,delayChildStarted:pid!==null,delayedChildStopped,lockAbsent:!fs.existsSync(join(dir,'data/actions/.writer.lock'))},()=>process.disconnect());
}catch{await servers?.close();process.send({kind:'failed'},()=>process.disconnect());process.exitCode=1;}
`;
for(const delayAt of [0,1,2,3])test('shared metadata budget with16projects and owned delayed child at command '+delayAt,{timeout:20000},async()=>{
 const parent=join(root,'reports/storage');mkdirSync(parent,{recursive:true});const dir=realpathSync(mkdtempSync(join(parent,'git-budget-')));assert.ok(inside(realpathSync(parent),dir));assert.equal(lstatSync(dir).isSymbolicLink(),false);
 for(let i=0;i<16;i++){mkdirSync(join(dir,'apps/p'+i),{recursive:true});writeFileSync(join(dir,'apps/p'+i,'app.mjs'),'export const value='+i+';\n');}
 writeFileSync(join(dir,'preload.mjs'),preload);writeFileSync(join(dir,'worker.mjs'),worker);writeFileSync(join(dir,'delay.mjs'),"import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);\n");
 const env={...process.env,FLOWATLAS_QA_BUDGET_DIR:dir,FLOWATLAS_QA_BUDGET_REPO:root,FLOWATLAS_QA_BUDGET_DELAY_AT:String(delayAt)};delete env.NODE_OPTIONS;delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--import',pathToFileURL(join(dir,'preload.mjs')).href,join(dir,'worker.mjs')],{cwd:root,env,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 let result=null,watchdogFired=false,spawnFailed=false;child.on('message',m=>{if(m?.kind==='result')result=m;});child.once('error',()=>{spawnFailed=true;});
 const timer=setTimeout(()=>{watchdogFired=true;child.kill('SIGKILL');},15000);
 const outcome=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer);
 const evidence={evidenceKind:'QA owned Node child simulates delayed Git output; real timeout/kill, not physical Git speed or strict OS-spawn guarantee',delayAt,watchdogFired,spawnFailed,outcome,result,workspaceRetained:true};
 mkdirSync(join(root,'reports/diagnostics/git-budget'),{recursive:true});const report=join(root,'reports/diagnostics/git-budget',new Date().toISOString().replace(/[:.]/g,'-')+'-command'+delayAt+'.json');writeFileSync(report,JSON.stringify(evidence,null,2)+'\n');
 assert.equal(watchdogFired,false);assert.equal(spawnFailed,false);assert.deepEqual(outcome,{code:0,signal:null});assert.ok(result);assert.equal(result.snapshots,17);assert.equal(result.digestExact,true);assert.equal(result.lockAbsent,true);assert.ok(result.timeouts.every(v=>v>=1&&v<=1000));
 if(delayAt===0){assert.equal(result.calls,51);assert.equal(result.allKnown,true);assert.equal(result.delayChildStarted,false);}else{assert.equal(result.calls,delayAt);assert.equal(result.allUnknown,true);assert.equal(result.delayChildStarted,true);assert.equal(result.delayedChildStopped,true);assert.ok(result.elapsedMs<5000,'measured controlled startup must remain below5s without extending application deadlines');}
 assert.ok(inside(realpathSync(parent),realpathSync(dir)));assert.equal(lstatSync(dir).isSymbolicLink(),false);assert.equal(existsSync(join(dir,'data/actions/.writer.lock')),false);rmSync(dir,{recursive:true,force:true});evidence.workspaceRetained=false;writeFileSync(report,JSON.stringify(evidence,null,2)+'\n');
});
