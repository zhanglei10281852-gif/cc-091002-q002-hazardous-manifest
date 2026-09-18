import test from 'node:test';
import assert from 'node:assert/strict';
import { ManifestStore } from '../src/manifest-store.js';
import { HandoverService } from '../src/handover-service.js';
import { manifestView } from '../src/audit-view.js';
import { verifyManifest } from '../src/custody.js';

const NOW='2026-09-18T08:00:00.000Z';
const setup=manifest=>{
  const store=new ManifestStore();
  store.create(manifest);
  const service=new HandoverService(store,{now:()=>NOW});
  return {store,service};
};
// 一张联单拆成两车运输
const twoTruck=()=>({
  id:'M-200',version:1,declaredKg:800,toleranceKg:20,state:'in-transit',
  segments:[
    {id:'S-1',declaredKg:400,state:'arrived',destinationFacilityId:'F-1'},
    {id:'S-2',declaredKg:400,state:'arrived',destinationFacilityId:'F-1'},
  ],
});
const receiver={id:'op-f1',role:'receiver',facilityId:'F-1'};

test('第一车接收不再误判整单完成，余量保持未闭合',()=>{
  const {store,service}=setup(twoTruck());
  assert.equal(service.accept('M-200','S-1',398,'sig-1',receiver).status,'accepted');
  const view=manifestView(store.get('M-200'));
  assert.equal(view.state,'in-transit');
  assert.equal(view.declaredKg,800);
  assert.equal(view.acceptedKg,398);
  assert.equal(view.remainingKg,400);
  assert.deepEqual(view.unclosedSegments,['S-2']);
});

test('第二车拒收恢复待处置余量，退运后联单闭合',()=>{
  const {store,service}=setup(twoTruck());
  service.accept('M-200','S-1',398,'sig-1',receiver);
  assert.equal(service.reject('M-200','S-2','包装破损',receiver,'sig-rj').status,'rejected');
  let view=manifestView(store.get('M-200'));
  assert.equal(view.state,'in-transit');
  assert.equal(view.remainingKg,400); // 拒收后余量恢复，不丢失
  assert.equal(service.returnSegment('M-200','S-2',{id:'gen-1',role:'generator'},'sig-rt').status,'returned');
  view=manifestView(store.get('M-200'));
  assert.equal(view.state,'closed');
  assert.equal(view.remainingKg,0);
  assert.equal(view.returnedKg,400);
  assert.equal(view.custodyVerified,true);
});

test('发运、途中交接、到场称重、接收围绕每个分段推进',()=>{
  const {store,service}=setup({
    id:'M-300',version:1,declaredKg:500,toleranceKg:10,state:'in-transit',
    segments:[{id:'S-1',declaredKg:500,state:'prepared',destinationFacilityId:'F-9'}],
  });
  assert.equal(service.weigh('M-300','S-1',500).status,'conflict'); // 未发运不得称重
  assert.equal(service.accept('M-300','S-1',500,'sig').status,'conflict'); // 未到场不得接收
  assert.equal(service.dispatch('M-300','S-1',{id:'shipper-1',role:'shipper'},'sig-d').status,'dispatched');
  assert.equal(service.handover('M-300','S-1',{id:'carrier-2',role:'carrier'},'sig-h1').status,'recorded');
  assert.equal(service.handover('M-300','S-1',{id:'carrier-3',role:'carrier'},'sig-h2').status,'recorded');
  assert.equal(store.get('M-300').segments[0].state,'dispatched'); // 交接不改变分段状态
  assert.equal(service.weigh('M-300','S-1',498,{id:'wb-1',role:'weigher'},'sig-w').status,'arrived');
  assert.equal(service.accept('M-300','S-1',null,'sig-a',{id:'op-f9',role:'receiver',facilityId:'F-9'}).status,'accepted');
  const view=manifestView(store.get('M-300'));
  assert.equal(view.state,'completed');
  assert.equal(view.acceptedKg,498);
  assert.equal(view.remainingKg,0);
  assert.equal(view.signatures.length,5); // 发运+两次交接+称重+接收
  assert.equal(view.segments[0].receivedBy,'F-9');
});

test('差异超限冻结相关分段但不牵连已完成分段',()=>{
  const {store,service}=setup({
    id:'M-500',version:1,declaredKg:800,toleranceKg:20,state:'in-transit',
    segments:[
      {id:'S-1',declaredKg:400,state:'arrived',destinationFacilityId:'F-1'},
      {id:'S-2',declaredKg:400,state:'dispatched',destinationFacilityId:'F-1'},
    ],
  });
  assert.equal(service.accept('M-500','S-1',400,'sig-1',receiver).status,'accepted');
  assert.equal(service.weigh('M-500','S-2',500,{id:'wb-1'},'sig-w').status,'frozen'); // 超差 100 > 20
  let view=manifestView(store.get('M-500'));
  assert.equal(view.segments.find(s=>s.id==='S-2').frozen,true);
  assert.equal(view.segments.find(s=>s.id==='S-1').state,'accepted'); // 已完成分毫不受影响
  assert.equal(view.acceptedKg,400);
  assert.equal(view.remainingKg,400);
  assert.equal(service.accept('M-500','S-2',400,'sig-x',receiver).status,'conflict'); // 冻结中不得推进
  assert.equal(service.reject('M-500','S-2','x',receiver).status,'conflict');
  assert.equal(service.unfreeze('M-500','S-2',{id:'reg-1',role:'regulator'},'复秤确认').status,'unfrozen');
  assert.equal(service.accept('M-500','S-2',395,'sig-2',receiver).status,'accepted');
  view=manifestView(store.get('M-500'));
  assert.equal(view.state,'completed');
  assert.equal(view.custodyVerified,true);
});

test('迟到事件不得让终态倒退',()=>{
  const {store,service}=setup(twoTruck());
  service.accept('M-200','S-1',398,'sig-1',receiver);
  const before=store.get('M-200');
  for(const result of [
    service.weigh('M-200','S-1',410),
    service.reject('M-200','S-1','迟到拒收',receiver),
    service.accept('M-200','S-1',400,'sig-late',receiver),
    service.dispatch('M-200','S-1'),
    service.handover('M-200','S-1',{id:'c-9'}),
    service.returnSegment('M-200','S-1'),
  ]) assert.equal(result.status,'conflict');
  const after=store.get('M-200');
  assert.equal(after.segments[0].state,'accepted');
  assert.equal(after.segments[0].actualKg,398);
  assert.equal(after.events.length,before.events.length); // 迟到事件不入链、不改写历史
});

test('同一分段不能被两个处置点接收',()=>{
  const {store,service}=setup(twoTruck());
  const other={id:'op-f2',role:'receiver',facilityId:'F-2'};
  assert.equal(service.accept('M-200','S-1',400,'sig-f2',other).status,'conflict'); // 非目的处置点
  assert.equal(store.get('M-200').segments[0].state,'arrived');
  assert.equal(service.accept('M-200','S-1',400,'sig-f1',receiver).status,'accepted');
  assert.equal(service.accept('M-200','S-1',400,'sig-f2b',other).status,'conflict'); // 第二家再接收被拒
  assert.equal(manifestView(store.get('M-200')).segments[0].receivedBy,'F-1');
});

test('签名只覆盖签署时可见的材料版本',()=>{
  const {store,service}=setup({
    id:'M-400',version:1,declaredKg:500,toleranceKg:10,state:'in-transit',
    segments:[{id:'S-1',declaredKg:500,state:'prepared',destinationFacilityId:'F-9'}],
  });
  service.dispatch('M-400','S-1',{id:'shipper-1'},'sig-d');
  service.weigh('M-400','S-1',495,{id:'wb-1'},'sig-w');
  service.accept('M-400','S-1',null,'sig-a',{id:'op-f9',facilityId:'F-9'});
  const manifest=store.get('M-400');
  assert.equal(manifest.version,4);
  const [dispatch,weigh,accept]=manifest.events;
  assert.equal(dispatch.signature.manifestVersion,1); // 各签名锚定签署时版本
  assert.equal(weigh.signature.manifestVersion,2);
  assert.equal(accept.signature.manifestVersion,3);
  assert.equal(accept.signature.material.segment.state,'arrived'); // 签署时可见的分段快照
  assert.equal(accept.signature.material.segment.actualKg,495);
  assert.equal(verifyManifest(manifest).ok,true);
});

test('篡改已签署历史会被保管链校验发现',()=>{
  const {store,service}=setup(twoTruck());
  service.accept('M-200','S-1',398,'sig-1',receiver);
  service.accept('M-200','S-2',402,'sig-2',receiver); // 整单完成
  const tamperedMaterial=store.get('M-200');
  tamperedMaterial.events[0].signature.material.segment.actualKg=999;
  assert.equal(verifyManifest(tamperedMaterial).ok,false);
  const tamperedEvent=store.get('M-200');
  tamperedEvent.events[0].details.actualKg=999;
  assert.equal(verifyManifest(tamperedEvent).ok,false);
  const tamperedState=store.get('M-200');
  tamperedState.segments[0].state='rejected'; // 已完成的终态被倒退
  assert.equal(verifyManifest(tamperedState).ok,false);
});

test('服务恢复后仍可验证整条保管链并继续推进',()=>{
  const {store,service}=setup(twoTruck());
  service.accept('M-200','S-1',398,'sig-1',receiver);
  const restored=ManifestStore.restore(store.snapshot()); // 模拟服务重启恢复
  const lastHashBefore=restored.get('M-200').events.at(-1).hash;
  assert.equal(verifyManifest(restored.get('M-200')).ok,true);
  assert.equal(manifestView(restored.get('M-200')).custodyVerified,true);
  const revived=new HandoverService(restored,{now:()=>NOW});
  assert.equal(revived.accept('M-200','S-2',402,'sig-2',receiver).status,'accepted'); // 恢复后继续推进
  const manifest=restored.get('M-200');
  assert.equal(manifest.events.at(-1).prevHash,lastHashBefore); // 新事件接在恢复前的链尾
  assert.equal(verifyManifest(manifest).ok,true);
  assert.equal(manifestView(manifest).state,'completed');
});

test('监管视图展示原始总量、各分段去向、未闭合余量和每次签名摘要',()=>{
  const {store,service}=setup(twoTruck());
  service.accept('M-200','S-1',398,'sig-1',receiver);
  service.reject('M-200','S-2','包装破损',receiver,'sig-rj');
  const view=manifestView(store.get('M-200'));
  assert.equal(view.declaredKg,800);
  assert.equal(view.allocatedKg,800);
  assert.equal(view.remainingKg,400);
  const s1=view.segments.find(s=>s.id==='S-1');
  const s2=view.segments.find(s=>s.id==='S-2');
  assert.equal(s1.receivedBy,'F-1');
  assert.equal(s2.state,'rejected');
  assert.equal(s2.reason,'包装破损');
  assert.equal(view.signatures.length,2);
  for(const sig of view.signatures){
    assert.ok(sig.materialHash);
    assert.equal(typeof sig.manifestVersion,'number');
    assert.ok(sig.signer);
  }
  assert.deepEqual(s2.signatures.map(s=>s.action),['reject']);
});

test('联单或分段不存在时返回 not-found 而不是抛错',()=>{
  const {service}=setup(twoTruck());
  assert.equal(service.accept('M-X','S-1',1,'s').status,'not-found');
  assert.equal(service.reject('M-200','S-9','x').status,'not-found');
  assert.equal(service.weigh('M-200','S-9',1).status,'not-found');
});
