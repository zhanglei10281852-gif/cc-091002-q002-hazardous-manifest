export const segmentStates=['prepared','dispatched','arrived','accepted','rejected','returned'];
export const terminalStates=new Set(['accepted','returned']);
export const withinTolerance=(declared,actual,tolerance)=>Math.abs(declared-actual)<=tolerance;
