import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {settleReference} from '../scripts/ugs_map_reference.mjs';
const status=offset=>({state:'IDLE',spindleSpeed:0,feedSpeed:0,fileName:'',machineCoord:{x:0,y:0,z:0,units:'MM'},workCoord:{x:0,y:0,z:-offset,units:'MM'}});
const doctor=offset=>({status:status(offset),listener:{pid:1},settings:{port:'cu.usbserial-TEST',portRate:'115200',firmwareVersion:'GRBL',preferredUnits:'MM'}});
const offsets=['G54','G55','G56','G57','G58','G59','G28','G30','G92'].map(k=>`[${k}:0,0,${k==='G54'?-15.753:0}]`).join('\n')+'\n[TLO:0]\nok';
class Socket extends EventEmitter {
 static last;
 constructor(){super();Socket.last=this;queueMicrotask(()=>this.emit('open'));}
 terminate(){this.ended=true;}
}
function ack(){for(const kind of ['COMMAND_SENT','COMMAND_COMPLETE'])Socket.last.emit('message',JSON.stringify({eventType:'CommandEvent',event:{commandEventType:kind,command:{id:1,command:'$#',isOk:true,response:offsets}}}));}
test('initial zero cache must match fresh actual offset before teaching; query is read-only',async()=>{
 let snapshots=0,polls=0,t=0;const commands=[];
 const result=await settleReference({WebSocketClass:Socket,snapshot:async()=>doctor(snapshots++===0?0:-15.753),now:()=>t,pause:async()=>{t+=150;},request:async(route,body)=>{
  if(body){commands.push(body.commands);assert.equal(route,'machine/sendGcode');ack();return null;}
  assert.equal(route,'status/getStatus');return status(++polls<3?0:-15.753);
 }});
 assert.equal(result.status.workCoord.z,15.753);assert.ok(polls>=4);assert.deepEqual(commands,['$#']);assert.equal(Socket.last.ended,true);
});
test('cache that never matches actual offset fails without changing any offset',async()=>{
 let t=0,sends=0;const logs=[];
 await assert.rejects(settleReference({WebSocketClass:Socket,snapshot:async()=>doctor(0),now:()=>t,pause:async()=>{t+=1000;},log:e=>logs.push(e),request:async(route,body)=>{if(body){sends++;ack();return null;}return status(0);}}),/has not matched the acknowledged G54 offset/);
 assert.deepEqual(logs.at(-1),{kind:'referenceTimeout',commandId:1,sent:true,acknowledged:true,actualG54:[0,0,-15.753],observedOffset:[0,0,0]});
 assert.equal(sends,1);
 assert.equal(Socket.last.ended,true);
});
test('motion during startup is rejected',async()=>{
 await assert.rejects(settleReference({WebSocketClass:Socket,snapshot:async()=>doctor(0),request:async(route,body)=>{if(body){ack();return null;}return {...status(0),state:'JOG',feedSpeed:100};}}),/stopped/);
});

for(const sent of [false,true])test(`unanswered query distinguishes sent=${sent} from a real offset mismatch`,async()=>{
 let t=0,sends=0;const logs=[];
 await assert.rejects(settleReference({WebSocketClass:Socket,snapshot:async()=>doctor(0),now:()=>t,pause:async()=>{t+=1000;},log:e=>logs.push(e),request:async(route,body)=>{
  if(body){sends++;if(sent)Socket.last.emit('message',JSON.stringify({eventType:'CommandEvent',event:{commandEventType:'COMMAND_SENT',command:{id:7,command:'$#'}}}));return null;}return status(0);
 }}),sent?/did not acknowledge/:/did not send/);
 assert.equal(logs.at(-1).sent,sent);assert.equal(logs.at(-1).acknowledged,false);assert.equal(logs.at(-1).actualG54,null);assert.equal(Socket.last.ended,true);
 assert.equal(logs.at(-1).commandId,sent?7:null);assert.deepEqual(logs.at(-1).observedOffset,[0,0,0]);assert.equal(sends,1);
});

test('completion without a matching sent query is rejected even if its ID is null',async()=>{
 await assert.rejects(settleReference({WebSocketClass:Socket,snapshot:async()=>doctor(0),request:async(route,body)=>{
  if(body){Socket.last.emit('message',JSON.stringify({eventType:'CommandEvent',event:{commandEventType:'COMMAND_COMPLETE',command:{id:null,command:'$#',isOk:true,response:offsets}}}));return null;}
  return status(0);
 }}),/Reference query failed/);
 assert.equal(Socket.last.ended,true);
});
