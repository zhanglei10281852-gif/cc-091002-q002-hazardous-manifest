import { terminalStates } from './domain.js';

const signatureDigest = sig => ({
  seq: sig.seq,
  type: sig.type,
  at: sig.at,
  by: sig.by,
  role: sig.role,
  party: sig.party,
  materialVersion: sig.materialVersion,
  materialDigest: sig.materialDigest,
  eventDigest: sig.digest,
});

const segmentView = segment => ({
  id: segment.id,
  state: segment.state,
  closed: terminalStates.has(segment.state),
  declaredKg: segment.declaredKg,
  actualKg: segment.actualKg,
  discrepancyKg: segment.discrepancyKg,
  carrier: segment.carrier,
  disposalPoint: segment.disposalPoint,
  acceptedBy: segment.acceptedBy,
  reason: segment.reason,
  returnDestination: segment.returnDestination,
  signatures: (segment.signatures ?? []).map(signatureDigest),
});

// 监管视图：所有口径在此唯一计算，store / service 不再各自折算。
// - declaredKg：原始申报总量（始终来自联单头，不随后续称重改写）
// - acceptedKg：已接收（已处置）重量，按接收称重
// - returnedKg：已退运重量（未进入处置，按分段申报量计）
// - openKg：未闭合余量（尚在发运/在途/到场/拒收/冻结中的分段，按申报量计）
// - destinations：各处置点接收去向
// - signatures：联单级与各分段全部签名摘要，按事件序号排列
export function manifestView(manifest, chain) {
  const segments = manifest.segments.map(segmentView);

  const acceptedKg = manifest.segments
    .filter(x => x.state === 'accepted')
    .reduce((n, x) => n + (x.actualKg ?? 0), 0);
  const acceptedDeclaredKg = manifest.segments
    .filter(x => x.state === 'accepted')
    .reduce((n, x) => n + x.declaredKg, 0);
  const returnedKg = manifest.segments
    .filter(x => x.state === 'returned')
    .reduce((n, x) => n + x.declaredKg, 0);
  const closedDeclaredKg = manifest.segments
    .filter(x => terminalStates.has(x.state))
    .reduce((n, x) => n + x.declaredKg, 0);
  const openKg = manifest.declaredKg - closedDeclaredKg;

  const frozenSegmentIds = manifest.segments.filter(x => x.state === 'frozen').map(x => x.id);

  const destinations = new Map();
  for (const seg of manifest.segments.filter(x => x.state === 'accepted')) {
    const point = seg.acceptedBy ?? seg.disposalPoint ?? 'unknown';
    const entry = destinations.get(point) ?? { disposalPoint: point, acceptedKg: 0, segments: [] };
    entry.acceptedKg += seg.actualKg ?? 0;
    entry.segments.push(seg.id);
    destinations.set(point, entry);
  }

  const signatures = [
    ...(manifest.signatures ?? []).map(s => ({ ...signatureDigest(s), scope: 'manifest', segmentId: null })),
    ...manifest.segments.flatMap(seg =>
      (seg.signatures ?? []).map(s => ({ ...signatureDigest(s), scope: 'segment', segmentId: seg.id }))),
  ].sort((a, b) => a.seq - b.seq);

  const view = {
    id: manifest.id,
    state: manifest.state,
    version: manifest.version,
    declaredKg: manifest.declaredKg,
    toleranceKg: manifest.toleranceKg,
    acceptedKg,
    acceptedDeclaredKg,
    returnedKg,
    openKg,
    closed: openKg === 0,
    frozenSegmentIds,
    destinations: [...destinations.values()],
    segments,
    signatures,
  };
  if (chain) view.chain = { events: chain.events ?? null, head: chain.head ?? null, verified: chain.verified ?? null };
  return view;
}
