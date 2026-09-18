import { applyEvent, hashEvent, normalizeSegment } from './domain.js';

// 仅追加事件存储：联单当前状态由事件链归约得到，历史事件永不修改。
// 事件通过 (prevHash, hash) 串成保管链；每条记录同时保存联单快照，
// 服务中断恢复后可从最后一条快照继续，也可从链首重放核验整条链。
export class ManifestStore {
  #items = new Map(); // manifestId -> { events: Event[], snapshot: Manifest }

  create(manifest) {
    if (this.#items.has(manifest.id)) throw new Error(`联单 ${manifest.id} 已存在`);
    const payload = {
      ...manifest,
      segments: (manifest.segments ?? []).map(normalizeSegment),
    };
    const event = this.#materialize({ type: 'manifest-created', at: manifest.createdAt ?? null, payload: { manifest: payload } });
    return { event, snapshot: event.snapshot };
  }

  // 载入历史链（恢复 / 迁移用）：不重放状态变更，只做链校验与快照挂载，
  // 因此不会改写任何已签署的历史。
  loadHistory(manifestId, events) {
    let prevHash = null;
    for (const e of events) {
      if (e.prevHash !== prevHash) throw new Error(`联单 ${manifestId} 保管链在 #${e.seq} 断裂`);
      prevHash = e.hash;
    }
    const last = events[events.length - 1];
    this.#items.set(manifestId, { events: structuredClone(events), snapshot: structuredClone(last.snapshot) });
    return structuredClone(last.snapshot);
  }

  #materialize(input) {
    const id = input.manifestId ?? input.payload?.manifest?.id;
    const item = this.#items.get(id);
    const seq = item ? item.events.length + 1 : 1;
    const prevHash = item ? item.events[item.events.length - 1].hash : null;
    const event = {
      seq,
      type: input.type,
      manifestId: id ?? null,
      segmentId: input.segmentId ?? null,
      at: input.at ?? new Date().toISOString(),
      payload: input.payload ?? {},
      signature: input.signature ?? null,
      prevHash,
      hash: '',
    };
    event.hash = hashEvent(prevHash, { ...event, hash: '' });

    const snapshot = applyEvent(item ? item.snapshot : { id, segments: [], signatures: [] }, event);
    const stored = { ...event, snapshot };
    if (!item) this.#items.set(id, { events: [], snapshot: null });
    this.#items.get(id).events.push(stored);
    this.#items.get(id).snapshot = snapshot;
    return stored;
  }

  append(input) {
    if (!this.#items.has(input.manifestId)) throw new Error(`联单 ${input.manifestId} 不存在`);
    return this.#materialize(input);
  }

  get(id) {
    const item = this.#items.get(id);
    return item ? structuredClone(item.snapshot) : undefined;
  }

  events(id) {
    const item = this.#items.get(id);
    return item ? item.events.map(({ snapshot, ...e }) => structuredClone(e)) : [];
  }

  save(manifest) {
    // 兼容旧调用方：整单保存仅作为一次快照落库，旧快照进入历史，不被覆盖。
    if (!this.#items.has(manifest.id)) return this.create(manifest);
    return this.#materialize({ type: 'snapshot-saved', manifestId: manifest.id, payload: { manifest } });
  }

  // 服务恢复：仅依据无快照的事件链重放重建状态，并逐环核验哈希。
  restore(events) {
    if (!events.length) throw new Error('空事件链无法恢复');
    let prevHash = null;
    let snapshot;
    const stored = [];
    for (const e of events) {
      if (e.prevHash !== prevHash) throw new Error(`联单 ${e.manifestId} 保管链在 #${e.seq} 断裂`);
      if (hashEvent(prevHash, { ...e, hash: '' }) !== e.hash) throw new Error(`联单 ${e.manifestId} #${e.seq} 哈希不符`);
      snapshot = applyEvent(snapshot ?? { id: e.manifestId, segments: [], signatures: [] }, e);
      prevHash = e.hash;
      stored.push({ ...e, snapshot });
    }
    const id = events[0].manifestId;
    this.#items.set(id, { events: stored, snapshot });
    return structuredClone(snapshot);
  }

  // 重放整条事件链，验证哈希链完整且终态与落库快照一致。
  verify(id) {
    const item = this.#items.get(id);
    if (!item) return { ok: false, reason: 'missing' };
    let prevHash = null;
    let snapshot;
    for (const e of item.events) {
      if (e.prevHash !== prevHash) return { ok: false, reason: `链断裂于 #${e.seq}` };
      const { snapshot: savedSnapshot, ...unsigned } = e;
      const expected = hashEvent(prevHash, { ...unsigned, hash: '' });
      if (expected !== e.hash) return { ok: false, reason: `哈希不符于 #${e.seq}` };
      snapshot = applyEvent(snapshot ?? { id, segments: [], signatures: [] }, e);
      prevHash = e.hash;
    }
    const tail = item.events[item.events.length - 1];
    if (tail && JSON.stringify(snapshot) !== JSON.stringify(tail.snapshot)) {
      return { ok: false, reason: '终态与落库快照不一致' };
    }
    return { ok: true, verified: true, events: item.events.length, head: prevHash };
  }
}
