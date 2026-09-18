import { createHash } from 'node:crypto';
import { deriveManifestState } from './domain.js';

// 稳定的规范化序列化，保证同一材料在任何时刻算出同一摘要
export const canonicalize=value=>{
  if(value===undefined||value===null) return 'null';
  if(typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
};
export const digestOf=value=>createHash('sha256').update(canonicalize(value)).digest('hex');

// 签名只能覆盖签署时可见的材料版本：联单版本号、总量与容差、以及被操作分段的快照
export const signingMaterial=(manifest,segment,action)=>({
  manifestId:manifest.id,
  manifestVersion:manifest.version??1,
  declaredKg:manifest.declaredKg??null,
  toleranceKg:manifest.toleranceKg??null,
  action,
  segment:{
    id:segment.id,
    state:segment.state,
    declaredKg:segment.declaredKg??null,
    actualKg:segment.actualKg??null,
    destinationFacilityId:segment.destinationFacilityId??null,
  },
});

const hashableEvent=event=>({
  seq:event.seq,
  prevHash:event.prevHash,
  type:event.type,
  segmentId:event.segmentId??null,
  at:event.at??null,
  actor:event.actor??null,
  details:event.details??null,
  signature:event.signature?{
    signer:event.signature.signer??null,
    role:event.signature.role??null,
    facilityId:event.signature.facilityId??null,
    manifestVersion:event.signature.manifestVersion??null,
    materialHash:event.signature.materialHash??null,
    value:event.signature.value??null,
  }:null,
});
export const hashEvent=event=>digestOf(hashableEvent(event));

// 事件追加式写入并以前序哈希链接，已签署的历史不被改写
export const appendEvent=(manifest,event)=>{
  manifest.events??=[];
  const prevHash=manifest.events.length?manifest.events[manifest.events.length-1].hash:'GENESIS';
  const record={seq:manifest.events.length+1,prevHash,...event};
  record.hash=hashEvent(record);
  manifest.events.push(record);
  return record;
};

// 服务恢复后仍可验证整条保管链：哈希链、签名材料摘要、版本一致性、派生状态一致性
export const verifyManifest=manifest=>{
  const failures=[];
  let prevHash='GENESIS';
  let lastSignedVersion=0;
  (manifest.events??[]).forEach((event,index)=>{
    if(event.seq!==index+1) failures.push({event:event.seq??index+1,reason:'sequence-gap'});
    if(event.prevHash!==prevHash) failures.push({event:event.seq,reason:'broken-chain'});
    if(hashEvent(event)!==event.hash) failures.push({event:event.seq,reason:'event-tampered'});
    const sig=event.signature;
    if(sig){
      if(digestOf(sig.material)!==sig.materialHash) failures.push({event:event.seq,reason:'material-tampered'});
      if((sig.material?.manifestVersion??null)!==sig.manifestVersion) failures.push({event:event.seq,reason:'version-mismatch'});
      if((sig.material?.segment?.id??null)!==(event.segmentId??null)) failures.push({event:event.seq,reason:'segment-mismatch'});
      if(typeof sig.manifestVersion==='number'){
        if(sig.manifestVersion<lastSignedVersion) failures.push({event:event.seq,reason:'version-regression'});
        lastSignedVersion=Math.max(lastSignedVersion,sig.manifestVersion);
      }
    }
    prevHash=event.hash;
  });
  if(manifest.state!==undefined&&manifest.state!==deriveManifestState(manifest)) failures.push({reason:'state-inconsistent'});
  return {ok:failures.length===0,failures};
};
