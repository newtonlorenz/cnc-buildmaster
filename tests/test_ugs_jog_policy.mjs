import test from 'node:test';
import assert from 'node:assert/strict';
import {jogPlan,HoldLease,runJogPlan} from '../scripts/ugs_jog_policy.mjs';
const settings={110:'1000.000',111:'1000.000',112:'600.000'};
const input={axis:'x',delta:1,feed:600,mode:'hold',holdId:'hold-12345'};
test('larger steps and axis-specific maximum use verified baseline feed limits',()=>{
 for(const step of [.1,1,5,10,25,50])assert.equal(jogPlan({...input,mode:'step',delta:step,feed:1000},settings).limit,step);
 assert.equal(jogPlan({...input,axis:'z',feed:600},settings).step,.1);
 assert.throws(()=>jogPlan({...input,feed:1001},settings));
 assert.throws(()=>jogPlan({...input,axis:'z',feed:601},settings));
 assert.throws(()=>jogPlan({...input,mode:'step',axis:'z',delta:5},settings));
 assert.throws(()=>jogPlan({...input,delta:2},settings));
 assert.throws(()=>jogPlan({...input,feed:NaN},settings));
});
test('lease expires and stale, wrong-ID, future or subsequent keepalives cannot resurrect it',()=>{
 let t=0;const lease=new HoldLease('hold-12345',{now:()=>t,at:0});
 t=150;lease.message({kind:'pulse',id:'wrong-id',at:150});assert.equal(lease.deadline,500);
 lease.message({kind:'pulse',id:'hold-12345',at:10000});assert.equal(lease.deadline,500);
 lease.message({kind:'pulse',id:'hold-12345',at:150});assert.equal(lease.deadline,650);
 t=651;assert.equal(lease.active(),false);
 lease.message({kind:'pulse',id:'hold-12345',at:651});assert.equal(lease.active(),false);
});
test('release during a step allows that one bounded step to end, then no more commands',async()=>{
 const lease=new HoldLease(input.holdId);let moves=[];
 const session={hold:{x:0,y:0,z:0},alive(){},async move(target,feed){moves.push({target,feed});lease.message({kind:'release',id:input.holdId});this.hold=target;}};
 const result=await runJogPlan(session,jogPlan(input,settings),{lease});
 assert.equal(moves.length,1);assert.equal(result.moved,1);assert.equal(result.limitReached,false);
});
test('already released input produces no movement',async()=>{
 const session={hold:{x:0,y:0,z:0},alive(){},async move(){assert.fail('Released hold moved');}};
 const lease=new HoldLease(input.holdId,{released:true});
 assert.equal((await runJogPlan(session,jogPlan(input,settings),{lease})).moved,0);
});
test('hold travel is capped and every individual move remains small',async()=>{
 for(const axis of ['x','z']){
  const commands=[];const session={hold:{x:0,y:0,z:0},alive(){},async move(target){commands.push(target);this.hold=target;}};
  const result=await runJogPlan(session,jogPlan({...input,axis,delta:-1},settings),{lease:{active:()=>true}});
  assert.equal(result.limitReached,true);assert.equal(result.moved,axis==='z'?5:100);
  assert.equal(commands.length,axis==='z'?50:100);
  assert.ok(commands.every((p,i)=>Math.abs(p[axis]-(i?commands[i-1][axis]:0))<=(axis==='z'?.100001:1.000001)));
 }
});
test('a failed move is not retried and no following segment is issued',async()=>{
 let count=0;const session={hold:{x:0,y:0,z:0},alive(){},async move(){count++;throw Error('alarm');}};
 await assert.rejects(runJogPlan(session,jogPlan(input,settings),{lease:{active:()=>true}}),/alarm/);
 assert.equal(count,1);
});

test('click positioning is one diagonal move within taught bounds, preserving Z',async()=>{
 const {gotoPlan}=await import('../scripts/ugs_jog_policy.mjs');
 const request={mode:'goto',feed:1000,area:{x:[0,100],y:[0,80]},snapshot:{status:{machineCoord:{x:0,y:0,z:10}}},target:{x:75,y:40,z:10}};
 const plan=gotoPlan(request,settings),moves=[];
 const session={hold:{x:0,y:0,z:10},alive(){},async move(target,feed){moves.push({target,feed});this.hold=target;}};
 await runJogPlan(session,plan);assert.equal(moves.length,1);assert.deepEqual(moves[0].target,request.target);
 for(const target of [{x:101,y:0,z:10},{x:0,y:0,z:9},{x:NaN,y:0,z:10}])assert.throws(()=>gotoPlan({...request,target},settings));
 assert.throws(()=>gotoPlan({...request,feed:1001},settings));
});
