// QA experiment only: not a supported store, migration format or production journal.
import { createHash } from 'node:crypto';
const maxFrame=4*1024*1024, maxLog=64*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex');
export function frame(record) {
  const payload=Buffer.from(JSON.stringify(record));
  if(payload.length>maxFrame) throw Error('frame_size_limit');
  const header=Buffer.alloc(68); header.writeUInt32BE(payload.length); header.write(hash(payload),4,'ascii');
  return Buffer.concat([header,payload]);
}
export function replay(bytes) {
  if(bytes.length>maxLog) throw Error('log_size_limit');
  const actions=new Map(); let offset=0, sequence=0;
  while(offset<bytes.length) {
    if(bytes.length-offset<68) throw Error('incomplete_header');
    const length=bytes.readUInt32BE(offset);
    if(length<1||length>maxFrame) throw Error('frame_size_limit');
    if(bytes.length-offset-68<length) throw Error('incomplete_payload');
    const payload=bytes.subarray(offset+68,offset+68+length);
    if(hash(payload)!==bytes.toString('ascii',offset+4,offset+68)) throw Error('checksum_mismatch');
    const r=JSON.parse(payload.toString('utf8'));
    if(r.format!=='qa-journal-1'||r.sequence!==sequence+1||!Array.isArray(r.upserts)||!Array.isArray(r.removeIds)
      ||r.upserts.length>32||r.removeIds.length>32||new Set(r.upserts.map(a=>a?.id)).size!==r.upserts.length
      ||new Set(r.removeIds).size!==r.removeIds.length
      ||r.upserts.some(a=>!a||typeof a!=='object'||!/^[A-Za-z0-9_-]{8,80}$/.test(a.id??''))
      ||r.removeIds.some(id=>!actions.has(id)||r.upserts.some(a=>a.id===id))) throw Error('invalid_record');
    const next=new Map(actions);
    for(const id of r.removeIds) next.delete(id);
    for(const action of r.upserts) next.set(action.id,action);
    if(next.size>100) throw Error('retention_limit');
    actions.clear(); for(const [id,action] of next) actions.set(id,action);
    offset+=68+length; sequence++;
  }
  return {actions:[...actions.values()],frames:sequence};
}
