import { createHash } from 'node:crypto';

// 联单分段状态机：
// prepared -> dispatched -> arrived -> accepted
//                        \-> rejected -> returned
// 任一需要称重的环节发现差异超限，分段进入 frozen（监督方解冻后回到 arrived）。
export const segmentStates = ['prepared', 'dispatched', 'arrived', 'accepted', 'rejected', 'returned', 'frozen'];
export const terminalStates = new Set(['accepted', 'returned']);
export const withinTolerance = (declared, actual, tolerance) => Math.abs(declared - actual) <= tolerance;

// 各类事件允许的签名主体（领域资料规定的签名主体）。
export const signerRoles = {
  'segments-planned': ['generator'],
  dispatched: ['generator'],
  'handed-over': ['carrier'],
  arrived: ['receiver', 'carrier'],
  accepted: ['disposal-point'],
  rejected: ['disposal-point'],
  'weight-discrepancy': ['receiver', 'disposal-point'],
  returned: ['carrier'],
  released: ['supervisor'],
};

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export const sha256 = text => createHash('sha256').update(text).digest('hex');
export const digestJson = value => sha256(stableStringify(value));
export const hashEvent = (prevHash, event) => digestJson({ prevHash, event });

export function normalizeSegment(segment) {
  return {
    id: segment.id,
    declaredKg: segment.declaredKg,
    state: segment.state ?? 'prepared',
    actualKg: segment.actualKg ?? null,
    carrier: segment.carrier ?? null,
    disposalPoint: segment.disposalPoint ?? null,
    acceptedBy: segment.acceptedBy ?? null,
    reason: segment.reason ?? null,
    discrepancyKg: segment.discrepancyKg ?? null,
    returnDestination: segment.returnDestination ?? null,
    signatures: segment.signatures ?? [],
  };
}

function normalizeManifest(manifest) {
  return {
    id: manifest.id,
    version: manifest.version ?? 1,
    declaredKg: manifest.declaredKg,
    toleranceKg: manifest.toleranceKg ?? 0,
    state: manifest.state ?? 'prepared',
    segments: (manifest.segments ?? []).map(normalizeSegment),
    signatures: manifest.signatures ?? [],
  };
}

// 签名时签名方可见的材料版本：联单头 + 该分段在本事件之前的快照，
// version 为该分段此前已累积的签名数。
export function signatureMaterial(snapshot, type, segmentId) {
  const head = {
    id: snapshot.id,
    version: snapshot.version,
    declaredKg: snapshot.declaredKg,
    toleranceKg: snapshot.toleranceKg,
  };
  if (type === 'segments-planned') {
    return { scope: 'manifest', manifest: head, planVersion: snapshot.segments.length };
  }
  if (type === 'manifest-created' || type === 'snapshot-saved' || !segmentId) {
    return { scope: 'manifest', manifest: head };
  }
  const seg = snapshot.segments.find(x => x.id === segmentId);
  if (!seg) return { scope: 'segment', manifest: head, segment: { id: segmentId, missing: true } };
  return {
    scope: 'segment',
    manifest: head,
    segment: {
      id: seg.id,
      version: seg.signatures.length,
      state: seg.state,
      declaredKg: seg.declaredKg,
      actualKg: seg.actualKg,
      carrier: seg.carrier,
      disposalPoint: seg.disposalPoint,
    },
  };
}

function signatureRecord(event) {
  const sig = event.signature;
  if (!sig) return null;
  return {
    seq: event.seq,
    type: event.type,
    at: event.at,
    by: sig.by ?? null,
    role: sig.role ?? null,
    party: sig.party ?? null,
    value: sig.value ?? null,
    materialVersion: sig.materialVersion ?? null,
    materialDigest: sig.materialDigest ?? null,
    digest: event.hash,
  };
}

function reconcileState(snapshot) {
  if (snapshot.segments.length > 0 && snapshot.segments.every(x => terminalStates.has(x.state))) {
    snapshot.state = 'completed';
  }
  return snapshot;
}

// 纯函数事件归约器：历史只能追加，当前状态由事件链重放得到。
export function applyEvent(snapshot, event) {
  let next;
  switch (event.type) {
    case 'manifest-created':
      next = normalizeManifest(event.payload.manifest);
      break;
    case 'snapshot-saved':
      next = normalizeManifest(event.payload.manifest);
      break;
    case 'segments-planned':
      next = structuredClone(snapshot);
      next.segments = event.payload.segments.map(normalizeSegment);
      break;
    default: {
      next = structuredClone(snapshot);
      const segment = next.segments.find(x => x.id === event.segmentId);
      if (!segment) throw new Error(`未知分段 ${event.segmentId}（联单 ${snapshot.id}，事件 #${event.seq}）`);
      const p = event.payload;
      switch (event.type) {
        case 'dispatched':
          segment.state = 'dispatched';
          segment.carrier = p.carrier ?? segment.carrier;
          break;
        case 'handed-over':
          segment.carrier = p.toCarrier;
          break;
        case 'arrived':
          segment.state = 'arrived';
          segment.actualKg = p.actualKg;
          segment.disposalPoint = p.disposalPoint ?? segment.disposalPoint;
          segment.reason = null;
          break;
        case 'weight-discrepancy':
          segment.state = 'frozen';
          segment.actualKg = p.actualKg;
          segment.disposalPoint = p.disposalPoint ?? segment.disposalPoint;
          segment.discrepancyKg = p.discrepancyKg;
          segment.reason = p.reason ?? '称重差异超出容差，分段冻结';
          break;
        case 'accepted':
          segment.state = 'accepted';
          segment.actualKg = p.actualKg;
          segment.disposalPoint = p.disposalPoint ?? segment.disposalPoint;
          segment.acceptedBy = event.signature?.party ?? event.signature?.by ?? segment.disposalPoint;
          break;
        case 'rejected':
          segment.state = 'rejected';
          segment.reason = p.reason;
          break;
        case 'returned':
          segment.state = 'returned';
          segment.returnDestination = p.destination ?? 'generator';
          break;
        case 'released':
          segment.state = 'arrived';
          segment.actualKg = null;
          segment.discrepancyKg = null;
          segment.reason = null;
          break;
        default:
          throw new Error(`未知事件类型 ${event.type}`);
      }
    }
  }

  const record = signatureRecord(event);
  if (record) {
    const target = event.segmentId ? next.segments.find(x => x.id === event.segmentId) : null;
    (target ?? next).signatures.push(record);
  }
  return reconcileState(next);
}
