import test from 'node:test';
import assert from 'node:assert/strict';
import { ManifestStore } from '../src/manifest-store.js';
import { HandoverService } from '../src/handover-service.js';
import { manifestView } from '../src/audit-view.js';
import { buildSignature, hmacVerifier, secretFromEnv } from '../src/signing.js';

process.env.HAZWASTE_SIGNING_SECRET ??= 'test-secret-2026';
const SECRET = secretFromEnv();

const sign = (manifest, type, opts = {}) =>
  buildSignature(manifest, { type, secret: SECRET, ...opts });

const newManifest = (id = 'M-200', declaredKg = 800, toleranceKg = 20) => ({
  id, version: 1, declaredKg, toleranceKg, state: 'prepared', segments: [],
});

const serviceWith = (store, verify = true) =>
  new HandoverService(store, verify ? { verifySignature: hmacVerifier(SECRET) } : {});

test('一联单拆两车：第一车接收不等于整单完成，第二车拒收保留待处置量', () => {
  const store = new ManifestStore();
  store.create(newManifest());
  const svc = serviceWith(store);

  let m = store.get('M-200');
  assert.equal(svc.split('M-200', [{ id: 'S-1', declaredKg: 400 }, { id: 'S-2', declaredKg: 400 }],
    sign(m, 'segments-planned', { role: 'generator', party: 'GEN' })).status, 'split');

  m = store.get('M-200');
  assert.equal(svc.dispatch('M-200', 'S-1', 'CAR-A',
    sign(m, 'dispatched', { segmentId: 'S-1', role: 'generator', party: 'GEN' })).status, 'dispatched');
  m = store.get('M-200');
  assert.equal(svc.dispatch('M-200', 'S-2', 'CAR-B',
    sign(m, 'dispatched', { segmentId: 'S-2', role: 'generator', party: 'GEN' })).status, 'dispatched');

  // 第一车到场、接收
  m = store.get('M-200');
  assert.equal(svc.arrive('M-200', 'S-1', { actualKg: 402, disposalPoint: 'DP-A' },
    sign(m, 'arrived', { segmentId: 'S-1', role: 'receiver', party: 'DP-A' })).status, 'arrived');
  m = store.get('M-200');
  assert.equal(svc.accept('M-200', 'S-1', 402,
    sign(m, 'accepted', { segmentId: 'S-1', role: 'disposal-point', party: 'DP-A' })).status, 'accepted');

  let view = manifestView(store.get('M-200'));
  assert.notEqual(view.state, 'completed', '第一车接收后整单不得完成');
  assert.equal(view.declaredKg, 800);
  assert.equal(view.acceptedKg, 402);
  assert.equal(view.openKg, 400, '第二车 400kg 仍为未闭合余量');
  assert.equal(view.destinations[0].disposalPoint, 'DP-A');

  // 第二车到场后被拒收：余量不得清零
  m = store.get('M-200');
  assert.equal(svc.arrive('M-200', 'S-2', { actualKg: 398, disposalPoint: 'DP-A' },
    sign(m, 'arrived', { segmentId: 'S-2', role: 'receiver', party: 'DP-A' })).status, 'arrived');
  m = store.get('M-200');
  assert.equal(svc.reject('M-200', 'S-2', '包装破损拒收',
    sign(m, 'rejected', { segmentId: 'S-2', role: 'disposal-point', party: 'DP-A' })).status, 'rejected');
  view = manifestView(store.get('M-200'));
  assert.equal(view.openKg, 400, '拒收不闭合，待处置量保留');
  assert.equal(view.segments.find(x => x.id === 'S-2').state, 'rejected');

  // 退运后才闭合
  m = store.get('M-200');
  assert.equal(svc.returnToGenerator('M-200', 'S-2', 'GEN',
    sign(m, 'returned', { segmentId: 'S-2', role: 'carrier', party: 'CAR-B' })).status, 'returned');
  view = manifestView(store.get('M-200'));
  assert.equal(view.state, 'completed');
  assert.equal(view.openKg, 0);
  assert.equal(view.returnedKg, 400);
  assert.equal(view.acceptedKg, 402);
  assert.deepEqual(view.destinations, [{ disposalPoint: 'DP-A', acceptedKg: 402, segments: ['S-1'] }]);
});

test('迟到事件不能让终态倒退；同一分段不能被第二个处置点接收', () => {
  const store = new ManifestStore();
  store.create(newManifest('M-300'));
  const svc = serviceWith(store);
  let m = store.get('M-300');
  svc.split('M-300', [{ id: 'S-1', declaredKg: 800 }],
    sign(m, 'segments-planned', { role: 'generator', party: 'GEN' }));
  m = store.get('M-300');
  svc.dispatch('M-300', 'S-1', 'CAR-A',
    sign(m, 'dispatched', { segmentId: 'S-1', role: 'generator', party: 'GEN' }));
  m = store.get('M-300');
  svc.arrive('M-300', 'S-1', { actualKg: 800, disposalPoint: 'DP-A' },
    sign(m, 'arrived', { segmentId: 'S-1', role: 'receiver', party: 'DP-A' }));
  m = store.get('M-300');
  assert.equal(svc.accept('M-300', 'S-1', 800,
    sign(m, 'accepted', { segmentId: 'S-1', role: 'disposal-point', party: 'DP-A' })).status, 'accepted');

  m = store.get('M-300');
  // 已接收后再接收
  assert.equal(svc.accept('M-300', 'S-1', 800,
    sign(m, 'accepted', { segmentId: 'S-1', role: 'disposal-point', party: 'DP-A' })).status, 'conflict');
  // 另一处置点声称接收同一分段
  assert.equal(svc.accept('M-300', 'S-1', 800,
    sign(m, 'accepted', { segmentId: 'S-1', role: 'disposal-point', party: 'DP-B' })).status, 'conflict');
  // 迟到的拒收/到场不得倒退终态
  assert.equal(svc.reject('M-300', 'S-1', '迟到拒收',
    sign(m, 'rejected', { segmentId: 'S-1', role: 'disposal-point', party: 'DP-A' })).status, 'conflict');
  assert.equal(svc.arrive('M-300', 'S-1', { actualKg: 800, disposalPoint: 'DP-A' },
    sign(m, 'arrived', { segmentId: 'S-1', role: 'receiver', party: 'DP-A' })).status, 'conflict');

  assert.equal(store.get('M-300').segments[0].state, 'accepted');
});

test('称重超限只冻结相关分段，不牵连已完成分段；解冻后可继续', () => {
  const store = new ManifestStore();
  store.create(newManifest('M-400'));
  const svc = serviceWith(store);
  let m = store.get('M-400');
  svc.split('M-400', [{ id: 'S-1', declaredKg: 400 }, { id: 'S-2', declaredKg: 400 }],
    sign(m, 'segments-planned', { role: 'generator', party: 'GEN' }));
  for (const [id, dp] of [['S-1', 'DP-A'], ['S-2', 'DP-A']]) {
    m = store.get('M-400');
    svc.dispatch('M-400', id, `CAR-${id}`, sign(m, 'dispatched', { segmentId: id, role: 'generator', party: 'GEN' }));
    m = store.get('M-400');
    svc.arrive('M-400', id, { actualKg: 400, disposalPoint: dp },
      sign(m, 'arrived', { segmentId: id, role: 'receiver', party: dp }));
  }
  m = store.get('M-400');
  svc.accept('M-400', 'S-1', 400, sign(m, 'accepted', { segmentId: 'S-1', role: 'disposal-point', party: 'DP-A' }));

  // S-2 接收时称重差异超限（容差 20，实际 450）
  m = store.get('M-400');
  const over = svc.accept('M-400', 'S-2', 450, sign(m, 'accepted', { segmentId: 'S-2', role: 'disposal-point', party: 'DP-A' }));
  assert.equal(over.status, 'frozen');

  let view = manifestView(store.get('M-400'));
  assert.equal(view.segments.find(x => x.id === 'S-1').state, 'accepted', '已完成分段不受冻结牵连');
  assert.equal(view.segments.find(x => x.id === 'S-2').state, 'frozen');
  assert.deepEqual(view.frozenSegmentIds, ['S-2']);
  assert.equal(view.acceptedKg, 400);
  assert.equal(view.openKg, 400);
  // 冻结期间任何推进都被拒绝
  m = store.get('M-400');
  assert.equal(svc.accept('M-400', 'S-2', 400,
    sign(m, 'accepted', { segmentId: 'S-2', role: 'disposal-point', party: 'DP-A' })).status, 'frozen');

  // 监督方解冻，复核称重后接收
  m = store.get('M-400');
  assert.equal(svc.release('M-400', 'S-2', '复磅确认 400kg',
    sign(m, 'released', { segmentId: 'S-2', role: 'supervisor', party: 'ENV-BUREAU' })).status, 'released');
  m = store.get('M-400');
  svc.arrive('M-400', 'S-2', { actualKg: 400, disposalPoint: 'DP-A' },
    sign(m, 'arrived', { segmentId: 'S-2', role: 'receiver', party: 'DP-A' }));
  m = store.get('M-400');
  assert.equal(svc.accept('M-400', 'S-2', 400,
    sign(m, 'accepted', { segmentId: 'S-2', role: 'disposal-point', party: 'DP-A' })).status, 'accepted');
  view = manifestView(store.get('M-400'));
  assert.equal(view.state, 'completed');
  assert.equal(view.openKg, 0);
});

test('签名只能覆盖签署时可见的材料版本；伪造或过期签名被拒', () => {
  const store = new ManifestStore();
  store.create(newManifest('M-500'));
  const svc = serviceWith(store);
  let m = store.get('M-500');
  svc.split('M-500', [{ id: 'S-1', declaredKg: 800 }],
    sign(m, 'segments-planned', { role: 'generator', party: 'GEN' }));
  m = store.get('M-500');
  svc.dispatch('M-500', 'S-1', 'CAR-A', sign(m, 'dispatched', { segmentId: 'S-1', role: 'generator', party: 'GEN' }));

  // 用发运前的旧材料签名去做到场 → 材料版本过期
  const stale = m;
  m = store.get('M-500');
  svc.handover('M-500', 'S-1', 'CAR-A2', sign(m, 'handed-over', { segmentId: 'S-1', role: 'carrier', party: 'CAR-A' }));
  assert.equal(svc.arrive('M-500', 'S-1', { actualKg: 800, disposalPoint: 'DP-A' },
    sign(stale, 'arrived', { segmentId: 'S-1', role: 'receiver', party: 'DP-A' })).status, 'stale-material');

  // 伪造 HMAC
  m = store.get('M-500');
  const forged = sign(m, 'arrived', { segmentId: 'S-1', role: 'receiver', party: 'DP-A' });
  forged.value = forged.value.replace(/^./, forged.value[0] === '0' ? '1' : '0');
  assert.equal(svc.arrive('M-500', 'S-1', { actualKg: 800, disposalPoint: 'DP-A' }, forged).status, 'bad-signature');

  // 错误签名主体：承运方不能做接收签名
  m = store.get('M-500');
  assert.equal(svc.arrive('M-500', 'S-1', { actualKg: 800, disposalPoint: 'DP-A' },
    sign(m, 'arrived', { segmentId: 'S-1', role: 'receiver', party: 'DP-A' })).status, 'arrived');
  m = store.get('M-500');
  assert.equal(svc.accept('M-500', 'S-1', 800,
    sign(m, 'accepted', { segmentId: 'S-1', role: 'carrier', party: 'CAR-A2' })).status, 'forbidden-signer');
});

test('服务恢复后可凭事件链重放并验证整条保管链，历史签名不可改写', () => {
  const store = new ManifestStore();
  store.create(newManifest('M-600'));
  const svc = serviceWith(store);
  let m = store.get('M-600');
  svc.split('M-600', [{ id: 'S-1', declaredKg: 500 }, { id: 'S-2', declaredKg: 300 }],
    sign(m, 'segments-planned', { role: 'generator', party: 'GEN' }));
  m = store.get('M-600');
  svc.dispatch('M-600', 'S-1', 'CAR-A', sign(m, 'dispatched', { segmentId: 'S-1', role: 'generator', party: 'GEN' }));
  m = store.get('M-600');
  svc.arrive('M-600', 'S-1', { actualKg: 500, disposalPoint: 'DP-A' },
    sign(m, 'arrived', { segmentId: 'S-1', role: 'receiver', party: 'DP-A' }));
  m = store.get('M-600');
  svc.accept('M-600', 'S-1', 500, sign(m, 'accepted', { segmentId: 'S-1', role: 'disposal-point', party: 'DP-A' }));

  const before = manifestView(store.get('M-600'));
  const events = store.events('M-600');
  assert.ok(events.length >= 5);

  // 模拟服务重启：仅靠事件链恢复
  const recovered = new ManifestStore();
  recovered.restore(events);
  const check = recovered.verify('M-600');
  assert.equal(check.ok, true);
  const after = manifestView(recovered.get('M-600'), check);
  assert.equal(after.openKg, before.openKg);
  assert.equal(after.acceptedKg, before.acceptedKg);
  assert.deepEqual(after.signatures.map(x => x.eventDigest), before.signatures.map(x => x.eventDigest));
  assert.equal(after.chain.verified, true);
  assert.equal(after.chain.head, events.at(-1).hash);

  // 视图含每次签名摘要，且每条摘要携带材料版本
  const acceptedSig = after.signatures.filter(x => x.type === 'accepted');
  assert.equal(acceptedSig.length, 1);
  assert.equal(acceptedSig[0].party, 'DP-A');
  assert.ok(acceptedSig[0].materialDigest);
  assert.ok(acceptedSig[0].eventDigest);

  // 篡改任一历史事件都会导致链校验失败
  const tampered = events.map(e => structuredClone(e));
  tampered[2].payload.carrier = 'CAR-FORGED';
  const store2 = new ManifestStore();
  assert.throws(() => store2.restore(tampered), /哈希不符/);
});
