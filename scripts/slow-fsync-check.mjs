import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

test('QA preload delays only owned state temporary descriptors and still syncs real files', () => {
  mkdirSync('reports/storage',{recursive:true}); mkdirSync('reports/benchmarks',{recursive:true});
  const probe=`import fs from 'node:fs'; import { join, relative, isAbsolute } from 'node:path';
    const parent=fs.realpathSync('reports/storage'), workspace=fs.realpathSync(fs.mkdtempSync(join(parent,'collector-cost-')));
    const rel=relative(parent,workspace); if(!rel||rel.startsWith('..')||isAbsolute(rel)) throw Error('unsafe');
    const directory=join(workspace,'data/actions'); fs.mkdirSync(directory,{recursive:true});
    for(const name of ['.unrelated.tmp','.state-00000000-0000-4000-8000-000000000001.tmp']) {
      const fd=fs.openSync(join(directory,name),'wx'); try { fs.writeFileSync(fd,'scope probe'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if(fs.realpathSync(workspace)!==workspace||fs.lstatSync(workspace).isSymbolicLink()) throw Error('unsafe');
    fs.rmSync(workspace,{recursive:true});`;
  const env={...process.env,FLOWATLAS_SLOW_FSYNC_QA:'1'}; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--import','./scripts/slow-fsync-preload.mjs','--input-type=module'],
    {env,input:probe,encoding:'utf8',timeout:10000,windowsHide:true});
  const tap=(result.stdout??'')+(result.stderr??'');
  writeFileSync(join('reports/benchmarks',`slow-fsync-scope-${Date.now()}.tap`),tap,{flag:'wx'});
  assert.equal(result.status,0); assert.equal(result.signal,null);
  const stats=[...tap.matchAll(/FLOWATLAS_SLOW_SYNC (\{[^\r\n]+\})/g)].map(m=>JSON.parse(m[1]));
  assert.deepEqual(stats,[{delayMs:120,calls:1,openDescriptors:0}]);
});

test('controlled slow durable sync reproduces bounded shutdown losses and preserves failed evidence', { timeout: 150000 }, () => {
  const directory='reports/benchmarks'; mkdirSync(directory,{recursive:true});
  mkdirSync('reports/storage',{recursive:true});
  const before=new Set(readdirSync(directory));
  const env={...process.env,FLOWATLAS_SLOW_FSYNC_QA:'1'};
  delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS; delete env.FLOWATLAS_COLLECTOR_COST_FAULT;
  const result=spawnSync(process.execPath,['--import','./scripts/slow-fsync-preload.mjs','--test','scripts/benchmark-collector-cost.mjs'],
    {env,encoding:'utf8',timeout:140000,maxBuffer:4*1024*1024,windowsHide:true});
  const id=new Date().toISOString().replace(/[:.]/g,'-');
  const tap=(result.stdout??'')+(result.stderr??'');
  writeFileSync(join(directory,`slow-fsync-${id}.tap`),tap,{flag:'wx'});
  assert.equal(result.status,1,'Slow sync must leave the component capture check failed');
  assert.match(tap,/Component capture\/reload failed/);
  const reports=readdirSync(directory).filter(f=>!before.has(f)&&/^collector-cost-.+\.json$/.test(f));
  assert.equal(reports.length,1);
  const report=JSON.parse(readFileSync(join(directory,reports[0])));
  assert.equal(report.performanceAcceptance.met,null); assert.equal(report.controlledFault,null);
  assert.equal(report.controlledSync.requestedDelayMs,120); assert.match(reports[0],/^collector-cost-slow-sync-/);
  assert.equal(report.workload.shutdownDeadlineMs,900); assert.equal(report.workload.uploadTimeoutMs,1000);
  const injected=[...tap.matchAll(/FLOWATLAS_SLOW_SYNC (\{[^\r\n]+\})/g)].map(m=>JSON.parse(m[1]));
  assert.equal(injected.length,1); assert.equal(injected[0].delayMs,120); assert.ok(injected[0].calls>=3);
  assert.equal(injected[0].openDescriptors,0);
  const disk=report.conditions.filter(r=>r.mode==='disk'); assert.equal(disk.length,3);
  for(const row of report.conditions) {
    const w=row.worker; assert.ok(w); assert.equal(w.summary.httpSpans,1051);
    assert.equal(w.summary.delivered+w.summary.dropped,1051); assert.equal(w.summary.queued+w.summary.inFlight,0);
    assert.equal(w.health.overflow+w.health.invalid+w.health.rejected+w.health.timeout+w.health.transport,0);
    if(row.mode==='disk') {
      assert.equal(row.complete,false); assert.equal(row.failure,'component_capture_or_reload_failed');
      assert.equal(w.timing.deadlineFired,1); assert.ok(w.health.shutdown>0);
      assert.equal(w.summary.dropped,w.health.shutdown); assert.equal(row.reloadVerified,true);
      assert.ok(row.storageTiming.syncMs>=row.storageTiming.saves*120); assert.equal(row.storageTiming.failures,0);
      assert.equal(row.workspaceRemoved,false);
      assert.match(row.retainedWorkspace,/^reports\/storage\/collector-cost-[\w-]+$/); assert.ok(existsSync(row.retainedWorkspace));
    } else { assert.equal(row.complete,true); assert.equal(row.workspaceRemoved,true); assert.equal(w.summary.delivered,1051); }
  }
  assert.equal(injected[0].calls,disk.reduce((sum,row)=>sum+row.storageTiming.saves,0));
  const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const evidence={id,evidenceKind:'controlled synthetic120ms pre-fsync pause; not actual disk speed or pilot',
    performanceAcceptance:{assessable:false,met:null,reason:'controlled_fault'},
    componentReport:reports[0],checkDigest:digest('scripts/slow-fsync-check.mjs'),
    preloadDigest:digest('scripts/slow-fsync-preload.mjs'),injected:injected[0],
    conditions:disk.map(r=>({round:r.round,delivered:r.worker.summary.delivered,shutdown:r.worker.health.shutdown,
      syncMs:r.storageTiming.syncMs,reloadVerified:r.reloadVerified,retainedWorkspace:r.retainedWorkspace}))};
  writeFileSync(join(directory,`slow-fsync-${id}.json`),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(evidence));
});
