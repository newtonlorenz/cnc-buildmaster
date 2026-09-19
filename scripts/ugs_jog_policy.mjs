/** Limits for supervised teaching. No I/O or machine commands. */
export function jogPlan(input, baseline) {
  const {axis,delta,mode='step',feed}=input;
  if(!['x','y','z'].includes(axis) || !Number.isFinite(delta) || delta===0)throw Error('Invalid jog axis/direction');
  const maximum=Number(baseline[{x:110,y:111,z:112}[axis]]);
  if(!Number.isFinite(maximum)||maximum<=0||!Number.isFinite(feed)||feed<=0||feed>maximum)throw Error('Jog feed exceeds controller axis limit');
  if(mode==='step'){
    if(![.1,1,5,10,25,50].includes(Math.abs(delta))||(axis==='z'&&Math.abs(delta)>1))throw Error('Unsupported step');
    return {axis,sign:Math.sign(delta),step:Math.abs(delta),limit:Math.abs(delta),feed,mode};
  }
  if(mode!=='hold'||![-1,1].includes(delta)||typeof input.holdId!=='string'||!/^[-\w]{8,80}$/.test(input.holdId))throw Error('Invalid held jog');
  return {axis,sign:delta,step:axis==='z'?.1:1,limit:axis==='z'?5:100,feed,mode};
}
export function gotoPlan(input, baseline) {
  const {target,area,feed}=input,start=input.snapshot?.status?.machineCoord;
  if(!target||!area||!start||!Number.isFinite(feed)||feed<=0||feed>Math.min(Number(baseline[110]),Number(baseline[111])))throw Error('Invalid positioning request');
  for(const a of ['x','y','z'])if(!Number.isFinite(target[a])||!Number.isFinite(start[a]))throw Error('Invalid position');
  if(target.z!==start.z)throw Error('Click-to-move cannot change Z');
  for(const a of ['x','y']){
    const r=area[a];
    if(!Array.isArray(r)||r.length!==2||!r.every(Number.isFinite)||r[0]>=r[1]||[start[a],target[a]].some(v=>v<r[0]||v>r[1]))throw Error('Position outside taught area');
  }
  const distance=Math.hypot(target.x-start.x,target.y-start.y);
  if(!distance)throw Error('Already at target');
  return {mode:'goto',target,feed,limit:distance};
}
export class HoldLease {
  constructor(id,{now=Date.now,at=Date.now(),released=false,timeout=500}={}){
    this.id=id;this.now=now;this.timeout=timeout;this.released=released;
    if(!Number.isFinite(at)||Math.abs(now()-at)>timeout)this.released=true;
    this.lastAt=at;this.deadline=at+timeout;
  }
  active(){if(this.now()>this.deadline)this.released=true;return !this.released;}
  message(m){
    if(m.id!==this.id)return;
    if(m.kind==='release'){this.released=true;return;}
    if(m.kind!=='pulse')throw Error('Invalid jog control message');
    if(!this.active())return;
    if(Number.isFinite(m.at)&&m.at>=this.lastAt&&m.at<=this.now()+50&&this.now()-m.at<=this.timeout){
      this.lastAt=m.at;this.deadline=m.at+this.timeout;
    }
  }
}
export async function runJogPlan(session,plan,{lease=null,progress=()=>{}}={}){
  if(plan.mode==='goto'){
    session.alive();await session.move(plan.target,plan.feed);
    return {position:{...session.hold},moved:plan.limit,limitReached:true};
  }
  const origin={...session.hold};let moved=0;
  while(moved<plan.limit-1e-6){
    session.alive();
    if(plan.mode==='hold'&&!lease?.active())break;
    const distance=Math.min(plan.step,plan.limit-moved);
    const target={...session.hold,[plan.axis]:Number((origin[plan.axis]+plan.sign*(moved+distance)).toFixed(3))};
    await session.move(target,plan.feed);
    moved=Number((moved+distance).toFixed(3));progress({position:{...session.hold},moved,limit:plan.limit});
  }
  return {position:{...session.hold},moved,limitReached:moved>=plan.limit-1e-6};
}
