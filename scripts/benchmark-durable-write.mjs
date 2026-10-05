import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,writeSync,statSync,realpathSync,lstatSync,existsSync,rmSync } from 'node:fs';
import { join,dirname,relative,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { release } from 'node:os';
import { FlowAtlas,getCodeVersion } from '../src/flowatlas.mjs';
import { ingestHttpSpanBatch } from '../src/http-spans.mjs';
import { validateGraph } from '../src/evidence-contract.mjs';
import { JsonActionStore,replaceStateFile } from '../src/action-store.mjs';
import { frame,replay } from './durable-write-format.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const sha=value=>createHash('sha256').update(value).digest('hex');
const inside=(parent,path)=>{const r=relative(parent,path);return Boolean(r)&&!r.startsWith('..')&&!isAbsolute(r);};

function fixture(fileCount) {
  const files=Object.freeze(Object.fromEntries(Array.from({length:fileCount},(_,i)=>[`modules/unit-${i}.mjs`,'b'.repeat(64)]).sort(([a],[b])=>a.localeCompare(b))));
  const version={projectId:'component',commit:null,dirty:null,files,digest:sha(Object.keys(files).sort().map(f=>`${f}\0${files[f]}`).join('\n'))};
  const snapshots=[];
  const atlas=new FlowAtlas(version,100,{load:()=>[],save:actions=>{
    const captured=JSON.parse(JSON.stringify(actions));
    // Preserve the live captured source map's immutable identity, not mutable parsed maps.
    for(const action of captured) action.codeVersion.files=files;
    snapshots.push(captured);
  }},{version:()=>version});
  const span=(spanId,parentSpanId=null)=>({spanId,parentSpanId,kind:parentSpanId?'CLIENT':'SERVER',method:'GET',
    startedAt:'2026-10-01T00:00:00.000Z',endedAt:'2026-10-01T00:00:00.100Z',durationMs:100,httpStatus:200,error:false});
  const send=items=>ingestHttpSpanBatch(atlas,{kind:'otel-span-batch',projectId:'component',codeDigest:version.digest,items});
  for(let i=0;i<1051;i+=32) send(Array.from({length:Math.min(32,1051-i)},(_,n)=>({traceId:(i+n+1).toString(16).padStart(32,'0'),span:span('1'.padStart(16,'0'))})));
  for(let i=0;i<64;i+=32) send(Array.from({length:32},(_,n)=>({traceId:(1051-i-n).toString(16).padStart(32,'0'),span:span('2'.padStart(16,'0'),'1'.padStart(16,'0'))})));
  assert.equal(snapshots.length,35); assert.equal(snapshots.at(-1).length,100);
  // Capture JSON once outside all timed conditions so every condition uses identical values/order.
  const normalized=snapshots;
  for(const actions of normalized) for(const a of actions) assert.deepEqual(validateGraph(a),[]);
  const snapshotBuffers=normalized.map(actions=>Buffer.from(JSON.stringify({storageVersion:1,actions})));
  assert.equal(normalized[32].filter(a=>a.trace.spans.length===2).length,0,'Later updates cannot alter captured initial history');
  assert.equal(normalized[33].filter(a=>a.trace.spans.length===2).length,32);
  assert.equal(normalized[34].filter(a=>a.trace.spans.length===2).length,64);
  assert.ok(normalized.every(actions=>actions.every(a=>a.codeVersion.files===files&&Object.isFrozen(a.codeVersion.files))));
  let previous=new Map();
  const journalBuffers=normalized.map((actions,i)=>{
    const next=new Map(actions.map(a=>[a.id,JSON.stringify(a)]));
    const upserts=actions.filter(a=>previous.get(a.id)!==next.get(a.id));
    if(i>=33) assert.equal(upserts.length,32,'Each update commit must change32 previously captured graphs');
    const removeIds=[...previous.keys()].filter(id=>!next.has(id)); previous=next;
    return frame({format:'qa-journal-1',sequence:i+1,upserts,removeIds});
  });
  const expected=normalized.at(-1);
  assert.deepEqual(replay(Buffer.concat(journalBuffers)).actions,expected);
  return {fileCount,snapshots:normalized,snapshotBuffers,journalBuffers,expected,
    digest:sha(Buffer.concat(snapshotBuffers)),rawSnapshotBytes:snapshotBuffers.reduce((s,b)=>s+b.length,0),rawJournalBytes:journalBuffers.reduce((s,b)=>s+b.length,0)};
}

function condition(data,mode,round,parent) {
  const workspace=realpathSync(mkdtempSync(join(parent,'durable-write-')));
  assert.ok(inside(parent,workspace)&&!lstatSync(workspace).isSymbolicLink());
  const row={fileCount:data.fileCount,mode,round,fixtureDigest:data.digest,complete:false,reloadVerified:false,
    bytesWritten:0,finalBytes:0,syncCalls:0,elapsedMs:null,stages:mode==='production-snapshot'?null:{writeMs:0,syncMs:0,replaceMs:0},storeTiming:null,
    finalSnapshotBytesVerified:null,framesReplayed:null,
    failure:null,workspaceRemoved:false,retainedWorkspace:null};
  let store,fd; let safeClosed=false;
  try {
    const directory=join(workspace,'actions'); mkdirSync(directory);
    const path=join(directory,mode==='raw-journal'?'experiment.log':'state.json');
    if(mode==='production-snapshot') store=new JsonActionStore(directory,{timing:true});
    if(mode==='raw-journal') fd=openSync(path,'wx',0o600);
    const buffers=mode==='raw-journal'?data.journalBuffers:data.snapshotBuffers;
    const started=performance.now();
    if(store) {
      for(const actions of data.snapshots) store.save(actions);
      row.bytesWritten=data.rawSnapshotBytes; row.syncCalls=35; row.storeTiming=store.timingHealth();
    } else for(const buffer of buffers) {
      const temporary=join(directory,`.state-${randomUUID()}.tmp`);
      if(mode==='raw-snapshot') fd=openSync(temporary,'wx',0o600);
      let start=performance.now(), offset=0;
      while(offset<buffer.length) { const written=writeSync(fd,buffer,offset,buffer.length-offset); if(written===0) throw Error('zero_write'); offset+=written; }
      row.stages.writeMs+=performance.now()-start; row.bytesWritten+=offset;
      start=performance.now(); fsyncSync(fd); row.syncCalls++; row.stages.syncMs+=performance.now()-start;
      if(mode==='raw-snapshot') {closeSync(fd); fd=undefined; start=performance.now();replaceStateFile(temporary,path);row.stages.replaceMs+=performance.now()-start;}
    }
    row.elapsedMs=performance.now()-started;
    if(store){store.close();store=null;const reopened=new JsonActionStore(directory);try{row.reloadVerified=JSON.stringify(reopened.load(100))===JSON.stringify(data.expected);}finally{reopened.close();}}
    else { if(fd!==undefined){closeSync(fd);fd=undefined;} const bytes=readFileSync(path); const decoded=mode==='raw-journal'?replay(bytes):JSON.parse(bytes); if(mode==='raw-journal')row.framesReplayed=decoded.frames; row.reloadVerified=JSON.stringify(decoded.actions)===JSON.stringify(data.expected); }
    if(mode!=='raw-journal')row.finalSnapshotBytesVerified=readFileSync(path).equals(data.snapshotBuffers.at(-1));
    row.finalBytes=statSync(path).size;
    row.complete=row.reloadVerified&&row.syncCalls===35&&row.bytesWritten===(mode==='raw-journal'?data.rawJournalBytes:data.rawSnapshotBytes)
      &&(mode==='raw-journal'?row.framesReplayed===35:row.finalSnapshotBytesVerified);
    if(!row.complete) row.failure='accounting_or_reload_failed';
  } catch { row.failure='write_or_reload_failed'; }
  finally {
    try { if(fd!==undefined)closeSync(fd); if(store)store.close(); safeClosed=true; } catch {row.failure??='cleanup_failed';}
    if(row.complete&&!row.failure&&safeClosed&&realpathSync(workspace)===workspace&&inside(parent,workspace)
      &&!lstatSync(workspace).isSymbolicLink()&&!existsSync(join(workspace,'actions/.writer.lock'))) {
      try {rmSync(workspace,{recursive:true});row.workspaceRemoved=true;}catch{row.failure='cleanup_failed';}
    }
    if(!row.workspaceRemoved)row.retainedWorkspace=relative(root,workspace).replaceAll('\\','/');
  }
  return row;
}

test('isolated durable write comparison keeps real sync and exact replay without backend acceptance',{timeout:180000},()=>{
  mkdirSync(join(root,'reports/storage'),{recursive:true}); mkdirSync(join(root,'reports/benchmarks'),{recursive:true});
  const parent=realpathSync(join(root,'reports/storage'));
  assert.ok(inside(realpathSync(root),parent)&&!lstatSync(join(root,'reports/storage')).isSymbolicLink());
  assert.ok(inside(realpathSync(root),realpathSync(join(root,'reports/benchmarks')))&&!lstatSync(join(root,'reports/benchmarks')).isSymbolicLink());
  const datasets=[1,64].map(fixture),version=getCodeVersion(root);
  const id=new Date().toISOString().replace(/[:.]/g,'-');
  const report={id,sourceCommit:version.commit,sourceDigest:version.digest,sourceDirty:version.dirty,
    scriptDigest:sha(readFileSync(fileURLToPath(import.meta.url))),formatDigest:sha(readFileSync(join(root,'scripts/durable-write-format.mjs'))),
    runtime:{node:process.version,platform:process.platform,osRelease:release()},
    evidenceKind:'synthetic normalized HTTP graph write experiment; no application, SDK, exporter or production journal',
    performanceAcceptance:{assessable:false,met:null,reason:'isolated_write_diagnostic'},
    scope:{raw:'preencoded bytes; framing/serialization/validation/locking/replay excluded',production:'existing store.save with validation/serialization/write/sync/replace; initialization and reopen excluded',
      byteAccounting:'raw write return counts; production expected encoded state bytes; final snapshot verified byte-for-byte outside timing',
      journal:'QA delta framing only; no writer lock, compaction, migration, directory sync or crash recovery guarantee'},
    workload:{uniqueTraces:1051,updatedTraces:64,batchLimit:32,commits:35,historyLimit:100,rounds:3,syncsPerCondition:35},
    fixtures:datasets.map(d=>({fileCount:d.fileCount,digest:d.digest,snapshotBytes:d.rawSnapshotBytes,journalBytes:d.rawJournalBytes,
      updateCommits:2,upsertsPerUpdateCommit:32,sourceFilesIdentity:'one shared frozen map captured before all conditions'})),conditions:[]};
  for(let round=0;round<3;round++)for(const data of datasets) {
    const modes=['production-snapshot','raw-snapshot','raw-journal'];
    for(const mode of modes.slice(round).concat(modes.slice(0,round)))report.conditions.push(condition(data,mode,round+1,parent));
  }
  writeFileSync(join(root,`reports/benchmarks/durable-write-${id}.json`),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
  assert.ok(report.conditions.every(r=>r.complete&&!r.failure&&r.workspaceRemoved),'Write comparison failed; diagnostic report and failed workspace retained.');
});
