import { canTransition, terminalStates, withinTolerance, deriveManifestState } from './domain.js';
import { appendEvent, signingMaterial, digestOf } from './custody.js';

const normalizeActor=actor=>{
  if(actor==null) return null;
  if(typeof actor==='string') return {id:actor};
  return {id:actor.id??'unknown',role:actor.role??null,facilityId:actor.facilityId??null};
};
const invalidKg={status:'invalid-argument',reason:'actualKg'};

export class HandoverService {
  // 真实签名密钥由运行环境提供：options.signer(material)=>value，或由调用方传入签名值
  constructor(store,options={}){
    this.store=store;
    this.now=options.now??(()=>new Date().toISOString());
    this.signer=options.signer??null;
  }

  #load(manifestId,segmentId){
    const manifest=this.store.get(manifestId);
    if(!manifest) return {error:{status:'not-found',reason:'manifest-not-found'}};
    const segment=(manifest.segments??[]).find(item=>item.id===segmentId);
    if(!segment) return {error:{status:'not-found',reason:'segment-not-found'}};
    manifest.events??=[];
    manifest.version??=1;
    return {manifest,segment};
  }

  // 迟到事件不得让终态倒退；冻结分段在解冻前不得推进
  #blocked(segment){
    if(terminalStates.has(segment.state)) return {status:'conflict',reason:'segment-terminal',state:segment.state};
    if(segment.frozen) return {status:'conflict',reason:'segment-frozen',state:segment.state};
    return null;
  }

  #guarded(manifestId,segmentId,target){
    const {manifest,segment,error}=this.#load(manifestId,segmentId);
    if(error) return {error};
    const blocked=this.#blocked(segment);
    if(blocked) return {error:blocked};
    if(target&&!canTransition(segment.state,target)) return {error:{status:'conflict',reason:'invalid-transition',state:segment.state}};
    return {manifest,segment};
  }

  // 签名只绑定签署时可见的材料版本（提交前的联单版本与分段快照）
  #sign(manifest,segment,action,actor,signatureValue){
    const material=signingMaterial(manifest,segment,action);
    const value=signatureValue??(this.signer?this.signer(material):null);
    return {
      signer:actor?.id??'unknown',
      role:actor?.role??action,
      facilityId:actor?.facilityId??null,
      manifestVersion:manifest.version,
      material,
      materialHash:digestOf(material),
      value,
    };
  }

  #commit(manifest,segment,nextState,mutate,event){
    mutate?.();
    if(nextState) segment.state=nextState;
    appendEvent(manifest,event);
    manifest.version+=1;
    manifest.state=deriveManifestState(manifest);
    this.store.save(manifest);
  }

  // 发运：prepared -> dispatched
  dispatch(manifestId,segmentId,actor=null,signature=undefined){
    const {manifest,segment,error}=this.#guarded(manifestId,segmentId,'dispatched');
    if(error) return error;
    const who=normalizeActor(actor);
    const signed=this.#sign(manifest,segment,'dispatch',who,signature);
    this.#commit(manifest,segment,'dispatched',null,{
      type:'dispatch',segmentId,at:this.now(),actor:who,
      details:{destinationFacilityId:segment.destinationFacilityId??who?.facilityId??null},
      signature:signed,
    });
    return {status:'dispatched'};
  }

  // 途中交接：承运人之间转移保管责任，分段保持 dispatched
  handover(manifestId,segmentId,actor=null,signature=undefined){
    const {manifest,segment,error}=this.#guarded(manifestId,segmentId,null);
    if(error) return error;
    if(segment.state!=='dispatched') return {status:'conflict',reason:'invalid-transition',state:segment.state};
    const who=normalizeActor(actor);
    const signed=this.#sign(manifest,segment,'handover',who,signature);
    this.#commit(manifest,segment,null,null,{
      type:'handover',segmentId,at:this.now(),actor:who,
      details:{custodian:who?.id??null},
      signature:signed,
    });
    return {status:'recorded',state:segment.state};
  }

  // 到场称重：dispatched -> arrived；差异超限只冻结该分段，不牵连其他分段
  weigh(manifestId,segmentId,actualKg,actor=null,signature=undefined){
    const {manifest,segment,error}=this.#guarded(manifestId,segmentId,'arrived');
    if(error) return error;
    if(typeof actualKg!=='number'||Number.isNaN(actualKg)) return invalidKg;
    const who=normalizeActor(actor);
    segment.actualKg=actualKg; // 称重事实先于签名进入材料
    const details={actualKg,declaredKg:segment.declaredKg,toleranceKg:manifest.toleranceKg};
    const signed=this.#sign(manifest,segment,'weigh',who,signature);
    this.#commit(manifest,segment,'arrived',null,{type:'weigh',segmentId,at:this.now(),actor:who,details,signature:signed});
    if(!withinTolerance(segment.declaredKg,actualKg,manifest.toleranceKg)){
      this.#commit(manifest,segment,null,()=>{
        segment.frozen=true;
        segment.freezeReason='tolerance-exceeded';
      },{type:'freeze',segmentId,at:this.now(),actor:who,details:{...details,reason:'tolerance-exceeded'}});
      return {status:'frozen'};
    }
    return {status:'arrived'};
  }

  // 接收：arrived -> accepted。同一分段不能被两个处置点接收：
  // 目的处置点不符即冲突；已接收后分段进入终态，后续接收一律冲突
  accept(manifestId,segmentId,actualKg=null,signature=undefined,actor=null){
    const {manifest,segment,error}=this.#guarded(manifestId,segmentId,'accepted');
    if(error) return error;
    if(actualKg!=null&&(typeof actualKg!=='number'||Number.isNaN(actualKg))) return invalidKg;
    const who=normalizeActor(actor);
    if(who?.facilityId&&segment.destinationFacilityId&&who.facilityId!==segment.destinationFacilityId){
      return {status:'conflict',reason:'wrong-facility'};
    }
    const weighedKg=actualKg??segment.actualKg??null;
    if(weighedKg==null) return {status:'conflict',reason:'not-weighed'};
    if(!withinTolerance(segment.declaredKg,weighedKg,manifest.toleranceKg)){
      this.#commit(manifest,segment,null,()=>{
        segment.actualKg=weighedKg;
        segment.frozen=true;
        segment.freezeReason='tolerance-exceeded';
      },{type:'freeze',segmentId,at:this.now(),actor:who,
        details:{reason:'tolerance-exceeded',actualKg:weighedKg,declaredKg:segment.declaredKg,toleranceKg:manifest.toleranceKg}});
      return {status:'frozen'};
    }
    segment.actualKg=weighedKg; // 签署时可见的材料包含本次称重值
    const signed=this.#sign(manifest,segment,'accept',who,signature);
    const receivedBy=who?.facilityId??who?.id??null;
    this.#commit(manifest,segment,'accepted',()=>{
      segment.receivedBy=receivedBy;
    },{type:'accept',segmentId,at:this.now(),actor:who,
      details:{actualKg:weighedKg,declaredKg:segment.declaredKg,receivedBy},
      signature:signed});
    return {status:'accepted'};
  }

  // 拒收：arrived -> rejected。拒收分段的数量回到未闭合余量，联单不再误判完成
  reject(manifestId,segmentId,reason='',actor=null,signature=undefined){
    const {manifest,segment,error}=this.#guarded(manifestId,segmentId,'rejected');
    if(error) return error;
    const who=normalizeActor(actor);
    const signed=this.#sign(manifest,segment,'reject',who,signature);
    this.#commit(manifest,segment,'rejected',()=>{
      segment.reason=reason;
    },{type:'reject',segmentId,at:this.now(),actor:who,details:{reason},signature:signed});
    return {status:'rejected'};
  }

  // 退运：rejected -> returned
  returnSegment(manifestId,segmentId,actor=null,signature=undefined){
    const {manifest,segment,error}=this.#guarded(manifestId,segmentId,'returned');
    if(error) return error;
    const who=normalizeActor(actor);
    const signed=this.#sign(manifest,segment,'return',who,signature);
    this.#commit(manifest,segment,'returned',null,{
      type:'return',segmentId,at:this.now(),actor:who,
      details:{returnedKg:segment.actualKg??segment.declaredKg},
      signature:signed,
    });
    return {status:'returned'};
  }

  // 解冻：授权解除差异冻结，分段回到冻结前所在状态继续推进
  unfreeze(manifestId,segmentId,actor=null,reason=''){
    const {manifest,segment,error}=this.#load(manifestId,segmentId);
    if(error) return error;
    if(terminalStates.has(segment.state)) return {status:'conflict',reason:'segment-terminal',state:segment.state};
    if(!segment.frozen) return {status:'conflict',reason:'not-frozen'};
    const who=normalizeActor(actor);
    this.#commit(manifest,segment,null,()=>{
      delete segment.frozen;
      delete segment.freezeReason;
    },{type:'unfreeze',segmentId,at:this.now(),actor:who,details:{reason}});
    return {status:'unfrozen',state:segment.state};
  }
}
