// Explicit QA preload only. Delay owned component state files; still call real fsync.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if(process.env.FLOWATLAS_SLOW_FSYNC_QA==='1') {
  const root=dirname(dirname(fileURLToPath(import.meta.url)));
  const storage=fs.realpathSync(resolve(root,'reports/storage'));
  const original={open:fs.openSync,sync:fs.fsyncSync,close:fs.closeSync};
  const descriptors=new Set(), wait=new Int32Array(new SharedArrayBuffer(4));
  let calls=0;
  fs.openSync=function(path,...args) {
    const fd=original.open.call(this,path,...args);
    try { if(typeof path==='string') {
      const rel=relative(storage,resolve(path)).replaceAll('\\','/');
      if(/^collector-cost-[\w-]+\/data\/actions\/\.state-[a-f0-9-]+\.tmp$/.test(rel)
        && fs.realpathSync(dirname(path))===resolve(storage,rel.split('/').slice(0,-1).join('/'))) descriptors.add(fd);
    } } catch(error) { original.close.call(this,fd); throw error; }
    return fd;
  };
  fs.fsyncSync=function(fd) {
    if(descriptors.has(fd)) { calls++; Atomics.wait(wait,0,0,120); }
    return original.sync.call(this,fd);
  };
  fs.closeSync=function(fd) { try { return original.close.call(this,fd); } finally { descriptors.delete(fd); } };
  syncBuiltinESMExports();
  process.once('exit',()=> { if(calls) console.log('FLOWATLAS_SLOW_SYNC '+JSON.stringify({delayMs:120,calls,openDescriptors:descriptors.size})); });
}
