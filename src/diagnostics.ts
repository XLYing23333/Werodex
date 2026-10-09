const enabled=()=>process.env.WERODEX_PROFILE==='1';
const totals:Record<string,number>={};
export function count(name:string,value=1){if(enabled())totals[name]=(totals[name]??0)+value;}
export function diagnostics(){return {enabled:enabled(),counters:{...totals},memory:process.memoryUsage()};}
