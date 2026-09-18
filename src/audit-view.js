import { deriveManifestState, terminalStates } from './domain.js';
import { verifyManifest } from './custody.js';

const signatureSummary=event=>({
  segmentId:event.segmentId??null,
  action:event.type,
  at:event.at??null,
  signer:event.signature.signer??null,
  role:event.signature.role??null,
  facilityId:event.signature.facilityId??null,
  manifestVersion:event.signature.manifestVersion??null,
  materialHash:event.signature.materialHash??null,
});

// 监管视图：原始总量、各分段去向、未闭合余量、每次签名摘要，全部按同一派生口径计算
export const manifestView=manifest=>{
  const events=manifest.events??[];
  const segments=manifest.segments??[];
  const open=segments.filter(s=>!terminalStates.has(s.state));
  const sum=(list,pick)=>list.reduce((n,s)=>n+(pick(s)??0),0);
  return {
    id:manifest.id,
    state:deriveManifestState(manifest),
    declaredKg:manifest.declaredKg, // 原始总量
    toleranceKg:manifest.toleranceKg??null,
    allocatedKg:sum(segments,s=>s.declaredKg),
    acceptedKg:sum(segments.filter(s=>s.state==='accepted'),s=>s.actualKg??s.declaredKg),
    returnedKg:sum(segments.filter(s=>s.state==='returned'),s=>s.actualKg??s.declaredKg),
    remainingKg:sum(open,s=>s.declaredKg), // 未闭合余量：拒收/在途分段的数量始终保留在余量中
    unclosedSegments:open.map(s=>s.id),
    segments:segments.map(segment=>({ // 各分段去向
      id:segment.id,
      state:segment.state,
      frozen:segment.frozen===true,
      declaredKg:segment.declaredKg,
      actualKg:segment.actualKg??null,
      destinationFacilityId:segment.destinationFacilityId??null,
      receivedBy:segment.receivedBy??null,
      reason:segment.reason??null,
      signatures:events.filter(e=>e.segmentId===segment.id&&e.signature).map(signatureSummary),
    })),
    signatures:events.filter(e=>e.signature).map(signatureSummary), // 每次签名摘要
    custodyVerified:verifyManifest(manifest).ok,
  };
};
