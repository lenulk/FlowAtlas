import test from 'node:test';
import assert from 'node:assert/strict';
import { frame,replay } from './durable-write-format.mjs';
const record=(sequence,upserts,removeIds=[])=>({format:'qa-journal-1',sequence,upserts,removeIds});
test('experimental framing rejects every truncated prefix and corrupted payload rather than guessing recovery',()=>{
  const first=frame(record(1,[{id:'action_0001',value:1}]));
  const second=frame(record(2,[{id:'action_0001',value:2}]));
  const full=Buffer.concat([first,second]);
  assert.deepEqual(replay(full),{actions:[{id:'action_0001',value:2}],frames:2});
  for(let length=1;length<full.length;length++) if(length!==first.length) assert.throws(()=>replay(full.subarray(0,length)),/incomplete/);
  const corrupted=Buffer.from(full); corrupted[corrupted.length-2]^=1; assert.throws(()=>replay(corrupted),/checksum/);
  const header=Buffer.from(full); header.writeUInt32BE(0xffffffff,first.length); assert.throws(()=>replay(header),/frame_size/);
  assert.deepEqual(replay(first),{actions:[{id:'action_0001',value:1}],frames:1});
  assert.throws(()=>replay(Buffer.concat([first,frame(record(3,[]))])),/invalid_record/);
  assert.throws(()=>replay(Buffer.concat([first,first])),/invalid_record/);
  assert.throws(()=>frame(record(1,[{id:'action_0001',value:'x'.repeat(4*1024*1024)}])),/frame_size/);
});
test('experimental replay preserves update order and explicit eviction and rejects ambiguous changes',()=>{
  const initial=frame(record(1,[{id:'action_0001',value:1},{id:'action_0002',value:2}]));
  const update=frame(record(2,[{id:'action_0001',value:3},{id:'action_0003',value:4}],['action_0002']));
  assert.deepEqual(replay(Buffer.concat([initial,update])).actions,[{id:'action_0001',value:3},{id:'action_0003',value:4}]);
  for(const r of [record(2,[{id:'action_0001'},{id:'action_0001'}]),record(2,[],['missing_0001']),record(2,[{id:'action_0001'}],['action_0001'])])
    assert.throws(()=>replay(Buffer.concat([initial,frame(r)])),/invalid_record/);
  const frames=Array.from({length:4},(_,batch)=>frame(record(batch+1,Array.from({length:32},(_,i)=>({id:`action_${batch*32+i}`.padEnd(8,'0')})))));
  assert.throws(()=>replay(Buffer.concat(frames)),/retention_limit/);
});
