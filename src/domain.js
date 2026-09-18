export const segmentStates=['prepared','dispatched','arrived','accepted','rejected','returned'];
export const terminalStates=new Set(['accepted','returned']);

// 分段状态机：每个分段独立推进，终态不可倒退
export const segmentTransitions={
  prepared:['dispatched'],
  dispatched:['arrived'],
  arrived:['accepted','rejected'],
  rejected:['returned'],
  accepted:[],
  returned:[],
};
export const canTransition=(from,to)=>(segmentTransitions[from]??[]).includes(to);

export const withinTolerance=(declared,actual,tolerance)=>Math.abs(declared-actual)<=tolerance;

// 联单状态由分段状态派生，store/service/view 统一使用同一口径：
// completed=全部分段被接收；closed=全部到达终态但含退运；其余为 in-transit
export const deriveManifestState=manifest=>{
  const states=(manifest.segments??[]).map(s=>s.state);
  if(states.length===0) return 'in-transit';
  if(states.every(s=>s==='accepted')) return 'completed';
  if(states.every(s=>terminalStates.has(s))) return 'closed';
  return 'in-transit';
};
