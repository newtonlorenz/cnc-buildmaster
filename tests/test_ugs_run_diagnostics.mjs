import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedSourceComments, isSelectedSourceComment, stationaryStopEvidence} from '../scripts/ugs_run_diagnostics.mjs';

const status = () => ({state:'HOLD', feedSpeed:0, spindleSpeed:1000,
  accessoryStates:{spindleCW:false,spindleCCW:false},
  machineCoord:{x:1,y:2,z:3,units:'MM'},workCoord:{x:4,y:5,z:6,units:'MM'}});
const samples = () => [100,400,700].map((observedAtMs,i)=>({sequence:i,observedAtMs,status:status()}));
const evidence = (value=samples(), options={}) => stationaryStopEvidence(value,{nowMs:800,requestedAtMs:0,...options});

test('empty processed source comment is accepted only by exact source membership',()=>{
  const comments=selectedSourceComments('(job header)\r\n ; note\r\nG1 X1 (inline)\r\n');
  assert.equal(isSelectedSourceComment({command:'',originalCommand:'(job header)'},comments),true);
  assert.equal(isSelectedSourceComment({command:'',originalCommand:' ; note'},comments),true);
  for(const command of [{command:'',originalCommand:'(different)'},{command:'',originalCommand:'(job header) '},
    {command:'G10 L20 P1 Z0',originalCommand:'(job header)'},{command:'',originalCommand:'G1 X1 (inline)'},
    {originalCommand:'(job header)'},null]) assert.equal(isSelectedSourceComment(command,comments),false);
});
test('malformed, nested, control and mixed executable lines are not comment permissions',()=>{
  const source=['(open','(outer (inner))','(note) G1X1','M3 ; comment','(note)\x18','', '(one) (two) ; note'];
  assert.deepEqual([...selectedSourceComments(source.join('\n'))],['(one) (two) ; note']);
});
test('three spaced stationary HOLD events verify translation independently of running spindle',()=>{
  const result=evidence();
  assert.equal(result.controllerStationaryVerified,true);
  assert.equal(result.spindleReportedOff,false);
  assert.equal(result.physicalStopVerified,false);
});
test('stationary IDLE and explicitly reported spindle off are independent evidence',()=>{
  const s=samples();for(const e of s){e.status.state='IDLE';e.status.spindleSpeed=0;}
  const r=evidence(s);assert.equal(r.controllerStationaryVerified,true);assert.equal(r.spindleReportedOff,true);
});
test('an acknowledgement, a single report and tightly clustered reports do not verify stop',()=>{
  assert.equal(evidence([]).controllerStationaryVerified,false);
  assert.equal(evidence(samples().slice(-1)).controllerStationaryVerified,false);
  const s=samples();s.forEach((e,i)=>e.observedAtMs=100+i);
  assert.equal(evidence(s).controllerStationaryVerified,false);
});
test('stale, future, duplicate and reordered samples do not verify stop',()=>{
  assert.equal(evidence(samples(),{nowMs:2500}).controllerStationaryVerified,false);
  assert.equal(evidence(samples(),{nowMs:2500}).spindleReportedOff,null);
  for(const change of [s=>s[2].sequence=1,s=>s[2].observedAtMs=400,s=>s[2].observedAtMs=900,
    s=>s[2].observedAtMs=-1,s=>s[1]=null]){
    const s=samples();change(s);assert.equal(evidence(s).controllerStationaryVerified,false);
  }
});
test('motion, nonzero feed, alarm, unknown coordinates and reference shift reset consecutive evidence',()=>{
  for(const change of [s=>s.state='RUN',s=>s.feedSpeed=1,s=>s.state='ALARM',s=>delete s.feedSpeed,
    s=>s.machineCoord.x=NaN,s=>s.workCoord.z+=1,s=>s.machineCoord.units='INCH']){
    const s=samples();change(s[1].status);assert.equal(evidence(s).controllerStationaryVerified,false);
  }
});
test('position is compared to anchor so slow drift cannot accumulate unnoticed',()=>{
  const s=samples();s[1].status.machineCoord.x+=.004;s[2].status.machineCoord.x+=.008;
  assert.equal(evidence(s).controllerStationaryVerified,false);
});
test('unknown spindle is never reported off even when stationary',()=>{
  for(const speed of [undefined,null,NaN,-1,'0']){
    const s=samples();s[2].status.spindleSpeed=speed;
    assert.equal(evidence(s).controllerStationaryVerified,true);assert.equal(evidence(s).spindleReportedOff,null);
  }
});
test('pre-request and gaps reset evidence; later fresh suffix can establish stop',()=>{
  const s=samples();assert.equal(evidence(s,{requestedAtMs:200}).controllerStationaryVerified,false);
  const later=s.map(e=>({...e,observedAtMs:e.observedAtMs+3000,sequence:e.sequence+4}));
  assert.equal(evidence([...s,...later],{nowMs:3800}).controllerStationaryVerified,false);
  // The first sample after a gap is discarded; three further fresh samples are required.
  later.push({sequence:7,observedAtMs:4000,status:status()});
  assert.equal(evidence([...s,...later],{nowMs:4100}).controllerStationaryVerified,true);
});

import {EventEmitter} from 'node:events';
import {observeRunDiagnostics} from '../scripts/ugs_run_diagnostics.mjs';
test('read-only observer consumes fresh events and never invokes a command method',async()=>{
  const socket=new EventEmitter();let clock=0;
  const pending=observeRunDiagnostics(socket,{durationMs:10,now:()=>clock,comments:selectedSourceComments('(header)')});
  socket.emit('message',JSON.stringify({eventType:'CommandEvent',event:{commandEventType:'COMMAND_SENT',command:{command:'',originalCommand:'(header)'}}}));
  for(const sample of samples()) { clock=sample.observedAtMs;socket.emit('message',JSON.stringify({eventType:'ControllerStatusEvent',event:{status:sample.status}})); }
  clock=800;const result=await pending;
  assert.equal(result.controllerStationaryVerified,true);assert.equal(result.spindleReportedOff,false);
  assert.equal(result.expectedCommentEvents,1);assert.equal(socket.listenerCount('message'),0);
});
test('event loss or malformed data invalidates earlier stationary evidence',async()=>{
  for(const fault of ['close','error','malformed']){
    const socket=new EventEmitter();let clock=0;
    const pending=observeRunDiagnostics(socket,{durationMs:5,now:()=>clock});
    for(const sample of samples()) {clock=sample.observedAtMs;socket.emit('message',JSON.stringify({eventType:'ControllerStatusEvent',event:{status:sample.status}}));}
    if(fault==='malformed') socket.emit('message','invalid');else socket.emit(fault);
    clock=800;const result=await pending;
    assert.equal(result.controllerStationaryVerified,false);assert.equal(result.spindleReportedOff,null);assert.ok(result.observerError);
  }
});
test('new unknown command and reconnect transition require fresh status evidence',async()=>{
  for(const event of [
    {eventType:'CommandEvent',event:{commandEventType:'COMMAND_SENT',command:{command:'',originalCommand:'(unknown)'}}},
    {eventType:'CommandEvent',event:{commandEventType:'COMMAND_SENT',command:{command:'M3'}}},
    {eventType:'ControllerStateEvent',event:{state:'IDLE',previousState:'CONNECTING'}},
  ]){
    const socket=new EventEmitter();let clock=0;
    const pending=observeRunDiagnostics(socket,{durationMs:5,now:()=>clock});
    for(const sample of samples()) {clock=sample.observedAtMs;socket.emit('message',JSON.stringify({eventType:'ControllerStatusEvent',event:{status:sample.status}}));}
    socket.emit('message',JSON.stringify(event));clock=800;
    assert.equal((await pending).controllerStationaryVerified,false);
  }
});


test('zero reported speed cannot override active or missing spindle accessories',()=>{
  for(const [accessoryStates,expected] of [
    [{spindleCW:true,flood:false,mist:false},false],
    [{spindleCW:false,spindleCCW:true},false],
    [{spindleCW:false,flood:false,mist:false},null],
    [undefined,null], [{spindleCW:false,spindleCCW:false},true],
  ]) {
    const s=samples();s[2].status.spindleSpeed=0;s[2].status.accessoryStates=accessoryStates;
    assert.equal(evidence(s).spindleReportedOff,expected);
    assert.equal(evidence(s).spindleSpeedReportedZero,true);
    assert.equal(evidence(s).spindleCWReported,accessoryStates?.spindleCW ?? null);
    assert.equal(evidence(s).spindleCCWReported,accessoryStates?.spindleCCW ?? null);
  }
});


import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('CLI rejects missing or example configuration before opening a socket',()=>{
  const script=fileURLToPath(new URL('../scripts/ugs_run_diagnostics.mjs',import.meta.url));
  const environment={...process.env};delete environment.CNC_BUILDMASTER_CONFIG;
  for(const configuration of [null,fileURLToPath(new URL('../config/example.json',import.meta.url))]) {
    const env={...environment};if(configuration)env.CNC_BUILDMASTER_CONFIG=configuration;
    const result=spawnSync(process.execPath,[script,'--seconds','1'],{env,encoding:'utf8',timeout:5000});
    assert.equal(result.status,1,result.stderr);
    assert.equal(result.stdout,'');
    assert.match(result.stderr,configuration ? /example configuration cannot control a machine/ : /Set CNC_BUILDMASTER_CONFIG/);
  }
});
