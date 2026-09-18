import { digestJson, signatureMaterial, signerRoles, terminalStates, withinTolerance } from './domain.js';
// 每个分段独立推进；服务只做状态机守卫并把事件追加进保管链，
// 不做任何整单覆盖式写入。迟到事件若与当前状态冲突将被拒绝，终态不会倒退。
export class HandoverService {
  constructor(store, { verifySignature = null } = {}) {
    this.store = store;
    // 可选的签名校验回调 (signature, materialDigest) => boolean；
    // 现场真实密钥通过运行环境提供，由调用方注入校验器。
    this.verifySignature = verifySignature;
  }

  #load(manifestId, segmentId) {
    const manifest = this.store.get(manifestId);
    if (!manifest) return { error: { status: 'not-found' } };
    const segment = manifest.segments.find(x => x.id === segmentId);
    if (!segment) return { error: { status: 'not-found' } };
    return { manifest, segment };
  }

  #pinSignature(type, manifest, segmentId, signature) {
    if (signature === undefined || signature === null) return { value: null };
    // 兼容历史调用方传入的裸签名字符串（如基线联单）。
    if (typeof signature === 'string') return { value: signature, legacy: true };

    const allowed = signerRoles[type] ?? [];
    if (signature.role && !allowed.includes(signature.role)) {
      return { error: { status: 'forbidden-signer', detail: `${type} 仅允许 ${allowed.join('/')} 签名` } };
    }
    // 签名只能覆盖签署时可见的材料版本：按当前链上快照构造材料并计算摘要。
    const material = signatureMaterial(manifest, type, segmentId);
    const materialDigest = digestJson(material);
    // 签署方自行计算摘要提交，服务端按当前链上状态复核；不一致即视为迟到/失效签名。
    if (signature.materialDigest && signature.materialDigest !== materialDigest) {
      return { error: { status: 'stale-material', detail: '签名材料版本与当前联单不一致' } };
    }
    if (this.verifySignature && signature.value != null && !this.verifySignature(signature, materialDigest)) {
      return { error: { status: 'bad-signature', detail: '签名值与材料摘要核验失败' } };
    }
    return {
      value: signature.value ?? null,
      by: signature.by ?? null,
      role: signature.role ?? null,
      party: signature.party ?? null,
      materialVersion: material.scope === 'segment'
        ? manifest.segments.find(x => x.id === segmentId).signatures.length
        : manifest.segments.length,
      materialDigest,
    };
  }

  #append(type, manifestId, segmentId, payload, signatureRaw) {
    const pinned = this.#pinSignature(type, this.store.get(manifestId), segmentId, signatureRaw);
    if (pinned.error) return pinned.error;
    const event = this.store.append({ type, manifestId, segmentId, payload, signature: pinned.value === null && !pinned.legacy ? null : pinned });
    return { status: type, event };
  }

  // 发运前把一张联单拆成多个运输分段（多车运输）。仅当所有分段尚未发运时允许。
  split(manifestId, segments, signature) {
    const manifest = this.store.get(manifestId);
    if (!manifest) return { status: 'not-found' };
    if (manifest.segments.some(x => x.state !== 'prepared')) {
      return { status: 'conflict', detail: '已有分段发运，不能重新拆分联单' };
    }
    const plannedKg = segments.reduce((n, x) => n + x.declaredKg, 0);
    if (plannedKg !== manifest.declaredKg) {
      return { status: 'invalid-plan', detail: `分段合计 ${plannedKg}kg 与联单总量 ${manifest.declaredKg}kg 不一致` };
    }
    const pinned = this.#pinSignature('segments-planned', manifest, null, signature);
    if (pinned.error) return pinned.error;
    const event = this.store.append({
      type: 'segments-planned', manifestId,
      payload: { segments: segments.map(x => ({ ...x, state: 'prepared' })) },
      signature: pinned.value === null && !pinned.legacy ? null : pinned,
    });
    return { status: 'split', event };
  }

  // 发运：prepared -> dispatched
  dispatch(manifestId, segmentId, carrier, signature) {
    const loaded = this.#load(manifestId, segmentId);
    if (loaded.error) return loaded.error;
    const { segment } = loaded;
    if (terminalStates.has(segment.state)) return { status: 'conflict', detail: `分段已终态 ${segment.state}，迟到发运无效` };
    if (segment.state !== 'prepared') return { status: 'conflict', detail: `分段处于 ${segment.state}，不能发运` };
    return this.#append('dispatched', manifestId, segmentId, { carrier: carrier?.id ?? carrier ?? null }, signature);
  }

  // 途中交接：仅在途分段可在承运方之间移交，分段本身不改变重量与去向。
  handover(manifestId, segmentId, toCarrier, signature) {
    const loaded = this.#load(manifestId, segmentId);
    if (loaded.error) return loaded.error;
    const { segment } = loaded;
    if (segment.state !== 'dispatched') return { status: 'conflict', detail: `仅在途分段可交接，当前 ${segment.state}` };
    return this.#append('handed-over', manifestId, segmentId, { fromCarrier: segment.carrier, toCarrier: toCarrier?.id ?? toCarrier }, signature);
  }

  // 到场称重：在容差内进入 arrived；超限只冻结当前分段（weight-discrepancy）。
  arrive(manifestId, segmentId, weighing, signature) {
    const loaded = this.#load(manifestId, segmentId);
    if (loaded.error) return loaded.error;
    const { manifest, segment } = loaded;
    if (terminalStates.has(segment.state)) return { status: 'conflict', detail: `分段已终态 ${segment.state}，迟到到场无效` };
    if (!['prepared', 'dispatched'].includes(segment.state)) return { status: 'conflict', detail: `分段处于 ${segment.state}，不能登记到场` };
    const actualKg = weighing?.actualKg ?? weighing;
    const disposalPoint = weighing?.disposalPoint ?? null;
    const discrepancyKg = actualKg - segment.declaredKg;
    const type = withinTolerance(segment.declaredKg, actualKg, manifest.toleranceKg) ? 'arrived' : 'weight-discrepancy';
    const payload = type === 'arrived'
      ? { actualKg, disposalPoint }
      : { actualKg, disposalPoint, discrepancyKg, reason: `称重差异 ${discrepancyKg}kg 超过容差 ${manifest.toleranceKg}kg` };
    return this.#append(type, manifestId, segmentId, payload, signature);
  }

  // 接收：仅 arrived 分段可接收；同一分段只能被到场登记的处置点接收一次。
  accept(manifestId, segmentId, actualKg, signature) {
    const loaded = this.#load(manifestId, segmentId);
    if (loaded.error) return loaded.error;
    const { manifest, segment } = loaded;
    if (segment.state === 'accepted') return { status: 'conflict', detail: '该分段已被接收，不能重复接收' };
    if (segment.state === 'returned') return { status: 'conflict', detail: '该分段已退运终结' };
    if (terminalStates.has(segment.state)) return { status: 'conflict', detail: `分段已终态 ${segment.state}` };
    if (segment.state === 'frozen') return { status: 'frozen', detail: '分段因称重差异冻结，需监督方解冻' };
    if (segment.state !== 'arrived') return { status: 'conflict', detail: `分段尚未到场称重（当前 ${segment.state}）` };

    // 先核验签名主体与材料版本，再校验处置点归属，避免越权方提前拿到业务冲突信息。
    if (signature && typeof signature === 'object') {
      const pinned = this.#pinSignature('accepted', manifest, segmentId, signature);
      if (pinned.error) return pinned.error;
      if (signature.party && segment.disposalPoint && signature.party !== segment.disposalPoint) {
        return { status: 'conflict', detail: `到场处置点为 ${segment.disposalPoint}，${signature.party} 不能接收该分段` };
      }
    }
    const disposalPoint = (signature && typeof signature === 'object' && signature.party) || segment.disposalPoint;
    if (!withinTolerance(segment.declaredKg, actualKg, manifest.toleranceKg)) {
      const discrepancyKg = actualKg - segment.declaredKg;
      const frozen = this.#append('weight-discrepancy', manifestId, segmentId,
        { actualKg, disposalPoint, discrepancyKg, reason: `接收称重差异 ${discrepancyKg}kg 超过容差 ${manifest.toleranceKg}kg` },
        signature);
      return frozen.status === 'weight-discrepancy' ? { ...frozen, status: 'frozen' } : frozen;
    }
    const result = this.#append('accepted', manifestId, segmentId, { actualKg, disposalPoint }, signature);
    return result.status === 'accepted' ? { status: 'accepted', event: result.event } : result;
  }

  // 拒收：arrived -> rejected；拒收不终结分段，待处置量在监管视图中保留。
  reject(manifestId, segmentId, reason, signature) {
    const loaded = this.#load(manifestId, segmentId);
    if (loaded.error) return loaded.error;
    const { segment } = loaded;
    if (terminalStates.has(segment.state)) return { status: 'conflict', detail: `分段已终态 ${segment.state}，迟到拒收无效` };
    if (segment.state === 'frozen') return { status: 'frozen', detail: '分段冻结中，需先解冻' };
    if (segment.state !== 'arrived') return { status: 'conflict', detail: `仅到场分段可拒收，当前 ${segment.state}` };
    const result = this.#append('rejected', manifestId, segmentId, { reason }, signature);
    return result.status === 'rejected' ? { status: 'rejected', event: result.event } : result;
  }

  // 退运：rejected -> returned（终态）。
  returnToGenerator(manifestId, segmentId, destination, signature) {
    const loaded = this.#load(manifestId, segmentId);
    if (loaded.error) return loaded.error;
    const { segment } = loaded;
    if (segment.state === 'returned') return { status: 'conflict', detail: '分段已退运' };
    if (segment.state !== 'rejected') return { status: 'conflict', detail: `仅已拒收分段可退运，当前 ${segment.state}` };
    return this.#append('returned', manifestId, segmentId, { destination: destination ?? 'generator' }, signature);
  }

  // 监督方解冻：frozen -> arrived（清除争议称重，等待复核称重）。
  release(manifestId, segmentId, note, signature) {
    const loaded = this.#load(manifestId, segmentId);
    if (loaded.error) return loaded.error;
    const { segment } = loaded;
    if (segment.state !== 'frozen') return { status: 'conflict', detail: `分段未冻结（当前 ${segment.state}）` };
    return this.#append('released', manifestId, segmentId, { note: note ?? '监督方解冻' }, signature);
  }
}
