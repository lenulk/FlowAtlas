import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,writeFileSync,realpathSync,lstatSync,existsSync,rmSync} from 'node:fs';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getCodeVersion} from '../src/flowatlas.mjs';
import {startServers} from '../src/server.mjs';
import {JsonActionStore} from '../src/action-store.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(){
 const parent=join(root,'reports/storage');mkdirSync(parent,{recursive:true});
 const workspace=realpathSync(mkdtempSync(join(parent,'startup-sink-')));
 const rel=relative(realpathSync(parent),workspace);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
 assert.equal(lstatSync(workspace).isSymbolicLink(),false);return workspace;
}
function cleanup(workspace){const rel=relative(realpathSync(join(root,'reports/storage')),realpathSync(workspace));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(lstatSync(workspace).isSymbolicLink(),false);assert.equal(existsSync(join(workspace,'data/actions/.writer.lock')),false);rmSync(workspace,{recursive:true,force:true});}
test('throwing startup diagnostics preserve exact packaged file version and unknown Git metadata',()=>{
 const workspace=fixture();let verified=false;
 try{
  for(const folder of ['src','public','examples'])mkdirSync(join(workspace,folder));
  writeFileSync(join(workspace,'src/app.mjs'),'export const value=1;\n');
  writeFileSync(join(workspace,'public/index.html'),'<!doctype html>\n');
  writeFileSync(join(workspace,'examples/demo.mjs'),'export const demo=true;\n');
  const baseline=getCodeVersion(workspace),phases=[];
  const observed=getCodeVersion(workspace,phase=>{phases.push(phase);throw Error('private diagnostic sink canary');});
  assert.deepEqual(observed,baseline);assert.equal(observed.commit,null);assert.equal(observed.dirty,null);
  assert.ok(phases.length>=4);assert.ok(phases.every(p=>typeof p==='string'&&/^[a-z-]+$/.test(p)));
  assert.equal(Object.isFrozen(observed.files),true);verified=true;
 }finally{if(verified)cleanup(workspace);}
});
test('throwing startup diagnostics preserve HTTP ingestion, durable state and released writer ownership',async()=>{
 const workspace=fixture(),phases=[];let servers,store,verified=false;
 const observer=phase=>{phases.push(phase);throw Error('private diagnostic sink canary');};
 try{
  servers=await startServers({port:0,inventoryPort:0,workspace,dataDir:'data/actions',onStartupPhase:observer});
  const result=await fetch(`http://127.0.0.1:${servers.port}/flowatlas/action-start`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'startup-qa0001',name:'view-product'})});
  assert.equal(result.status,201);await result.arrayBuffer();
  const expected=servers.atlas.store.load(100);assert.equal(expected.length,1);
  await servers.close();servers=null;
  assert.equal(existsSync(join(workspace,'data/actions/.writer.lock')),false);
  store=new JsonActionStore(join(workspace,'data/actions'),{onStartupPhase:observer});
  assert.deepEqual(store.load(100),expected);store.close();store=null;
  assert.ok(phases.length>=12);assert.ok(phases.every(p=>typeof p==='string'&&/^[a-z-]+$/.test(p)));verified=true;
 }finally{await servers?.close();store?.close();if(verified)cleanup(workspace);}
});
test('throwing startup diagnostics cannot hide listen failure or keep the writer lock',async()=>{
 const workspace=fixture(),busy=createServer();let store,verified=false;
 await new Promise((resolve,reject)=>{busy.once('error',reject);busy.listen(0,'127.0.0.1',resolve);});
 try{
  await assert.rejects(startServers({port:busy.address().port,inventoryPort:0,workspace,dataDir:'data/actions',onStartupPhase:()=>{throw Error('sink canary');}}),{code:'EADDRINUSE'});
  assert.equal(existsSync(join(workspace,'data/actions/.writer.lock')),false);
  store=new JsonActionStore(join(workspace,'data/actions'));assert.deepEqual(store.load(100),[]);store.close();store=null;verified=true;
 }finally{store?.close();await new Promise(resolve=>busy.close(resolve));if(verified)cleanup(workspace);}
});
