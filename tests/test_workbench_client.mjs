import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from '../scripts/cnc-map-ui/node_modules/esbuild/lib/main.js';
const bundle=await build({entryPoints:['scripts/cnc-map-ui/src/lib/machine-client.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {MachineClient}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const base=()=>({apiVersion:7,sessionId:'session-a',phase:'teach',armed:true,busy:false,nativeJog:true,corners:[],pcbRevision:1});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)}};
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture(){
 const requests=[];let state=base(),job={revision:1},pendingHold=null,failed=false;
 const previous=global.fetch;
 global.fetch=async(url,options)=>{
  const body=options.body?JSON.parse(options.body):undefined;requests.push({url,body,headers:options.headers});
  if(url==='/api/state'){if(failed)throw Error('Offline');return Response.json(state)}
  if(url==='/api/pcb')return Response.json(job);
  if(url==='/api/jog-hold'&&pendingHold)return pendingHold.promise;
  return Response.json({result:{}});
 };
 const client=new MachineClient('test-only-token','client-one');
 return {client,requests,setState:value=>state=value,setJob:value=>job=value,setHold:value=>pendingHold=value,setFailure:value=>failed=value,close:()=>{client.dispose();global.fetch=previous}};
}
test('holds keep release and Stop independent; conflicting actions do not queue',async()=>{
 const f=fixture();try{
  await f.client.poll();const hold=deferred();f.setHold(hold);f.client.startHold('x',1,'ArrowRight','maximum');
  assert.equal(f.client.getSnapshot().pending,true);
  assert.equal(await f.client.call('capture',{corner:'front-left'}),false);
  assert.equal(f.requests.filter(r=>r.url==='/api/capture').length,0);
  const id=f.client.getSnapshot().activeHold.id;const stop=f.client.stop();await stop;
  assert.ok(f.requests.find(r=>r.url==='/api/jog-release'&&r.body.id===id&&r.body.sessionId==='session-a'));
  assert.ok(f.requests.find(r=>r.url==='/api/stop'));
  assert.equal(f.client.getSnapshot().activeHold,null);
  hold.resolve(Response.json({result:{}}));await tick();await tick();
  assert.equal(f.client.getSnapshot().pending,false);
 }finally{f.close()}
});
test('reference replacement releases the hold with its original session',async()=>{
 const f=fixture();try{
  await f.client.poll();const hold=deferred();f.setHold(hold);f.client.startHold('y',-1,null,'normal');
  f.setState({...base(),sessionId:'session-b'});await f.client.poll();
  assert.equal(f.client.getSnapshot().activeHold,null);
  assert.equal(f.requests.find(r=>r.url==='/api/jog-release').body.sessionId,'session-a');
  hold.resolve(Response.json({result:{}}));await tick();
 }finally{f.close()}
});
test('connection failure locks actions and releases held motion',async()=>{
 const f=fixture();try{
  await f.client.poll();const hold=deferred();f.setHold(hold);f.client.startHold('x',1,null,'fast');
  f.setFailure(true);await f.client.poll();assert.equal(f.client.getSnapshot().online,false);
  assert.equal(f.client.getSnapshot().activeHold,null);assert.ok(f.requests.find(r=>r.url==='/api/jog-release'));
  hold.resolve(Response.json({result:{}}));await tick();await tick();
  const count=f.requests.length;assert.equal(await f.client.call('scan',{planId:'old'}),false);assert.equal(f.requests.length,count);
 }finally{f.close()}
});
test('job writes carry fresh revisions and authentication; stale API locks actions',async()=>{
 const f=fixture();try{
  await f.client.poll();await f.client.refreshJob();await f.client.post('pcb-configure',{settings:{name:'Draft'}});
  const request=f.requests.find(r=>r.url==='/api/pcb-configure');assert.equal(request.body.pcbRevision,1);assert.equal(request.body.sessionId,'session-a');
  assert.equal(request.headers.Authorization,'Bearer test-only-token');assert.equal(request.headers['X-Client-ID'],'client-one');
  f.setJob({revision:2});f.setState({...base(),pcbRevision:2});await f.client.poll();await f.client.refreshJob();await f.client.post('pcb-save');
  assert.equal(f.requests.find(r=>r.url==='/api/pcb-save').body.pcbRevision,2);
  f.setState({...base(),apiVersion:1});await f.client.poll();assert.equal(f.client.getSnapshot().online,false);assert.match(f.client.getSnapshot().error,/Restart the server/);
 }finally{f.close()}
});
test('Z steps are bounded and lock after a corner; unavailable native hold cannot start',async()=>{
 const f=fixture();try{
  await f.client.poll();await f.client.jog('z',-1,50,'maximum');assert.equal(f.requests.find(r=>r.url==='/api/jog').body.delta,-1);
  f.setState({...base(),corners:[{name:'front-left'}]});await f.client.poll();const count=f.requests.length;
  assert.equal(await f.client.jog('z',1,1,'normal'),false);f.client.startHold('z',1,null,'normal');assert.equal(f.requests.length,count);
  f.setState({...base(),nativeJog:false});await f.client.poll();f.client.startHold('x',1,null,'normal');assert.equal(f.client.getSnapshot().activeHold,null);
 }finally{f.close()}
});

test('hold acknowledgement does not release the active input lease',async()=>{
 const f=fixture();try{
  await f.client.poll();f.client.startHold('x',1,'ArrowRight','maximum');await tick();await tick();
  assert.equal(f.client.getSnapshot().pending,false);
  assert.equal(f.client.getSnapshot().activeHold?.key,'ArrowRight');
  assert.equal(f.requests.some(r=>r.url==='/api/jog-release'),false);
  await new Promise(r=>setTimeout(r,170));
  assert.ok(f.requests.some(r=>r.url==='/api/jog-pulse'));
  f.client.releaseHold();await tick();assert.equal(f.client.getSnapshot().activeHold,null);
  assert.ok(f.requests.some(r=>r.url==='/api/jog-release'));
 }finally{f.close()}
});


test('slow job geometry never blocks heartbeat, hold release or Stop',async()=>{
 const previous=global.fetch,geometry=deferred();let stateReads=0;
 const writes=[];global.fetch=async(url,options)=>{
  if(url==='/api/state'){stateReads++;return Response.json(base())}
  if(url==='/api/pcb')return geometry.promise;
  writes.push(url);return Response.json({result:{}});
 };
 const client=new MachineClient('test-token','test-owner');
 try{
  await Promise.race([client.poll(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Heartbeat waited for job preview')),500))]);
  assert.equal(client.getSnapshot().job,null);assert.equal(client.getSnapshot().online,true);
  await client.poll();assert.equal(stateReads,2);
  client.startHold('x',1,'ArrowRight','normal');await tick();client.releaseHold();
  await client.stop();assert.ok(writes.includes('/api/jog-release'));assert.ok(writes.includes('/api/stop'));
  assert.ok(stateReads>=3);assert.equal(client.getSnapshot().online,true);
 }finally{
  geometry.resolve(Response.json({revision:1}));await client.refreshJob();client.dispose();global.fetch=previous;
 }
});
