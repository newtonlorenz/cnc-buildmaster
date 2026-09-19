import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ReferenceWatch, heartbeatExpired, runWatch, serialDevicePath, checkMachineProfile} from '../scripts/ugs_map_watch.mjs';
const settings={port:'/dev/test',portRate:115200,firmwareVersion:'GRBL',preferredUnits:'MM'};
const status=()=>({state:'IDLE',feedSpeed:0,spindleSpeed:0,fileName:'',remainingRowCount:0,
  machineCoord:{x:0,y:0,z:10,units:'MM'},workCoord:{x:0,y:0,z:30,units:'MM'},pins:{x:false,y:false,z:false,probe:false}});
const doctor=()=>({settings,status:status(),file:{fileName:''},listener:{pid:1}});
const watch=()=>new ReferenceWatch({settings,status:status(),firmwareSettings:{0:'10'}});
const event=(eventType,event)=>JSON.stringify({eventType,event});
const sent=command=>event('CommandEvent',{commandEventType:'COMMAND_SENT',command:{command}});

test('actual macOS UGS device name matches saved /dev path without changing settings',()=>{
 const machine={connection:{port:'/dev/cu.usbserial-11240',baud:115200},sender_defaults:{firmware:'GRBL'}};
 const actual=Object.freeze({...settings,port:'cu.usbserial-11240',portRate:'115200'});
 checkMachineProfile(actual,machine);
 checkMachineProfile({...actual,port:'/dev/cu.usbserial-11240',portRate:115200},machine);
 assert.equal(actual.port,'cu.usbserial-11240');
 for(const port of ['cu.usbserial-11241','tty.usbserial-11240'])
   assert.throws(()=>checkMachineProfile({...actual,port},machine),/port expected/);
 assert.throws(()=>checkMachineProfile({...actual,portRate:'9600'},machine),/baud expected/);
 assert.throws(()=>checkMachineProfile({...actual,portRate:'115200 '},machine),/baud expected/);
 assert.throws(()=>checkMachineProfile({...actual,firmwareVersion:'GRBLHAL'},machine),/controller expected/);
 assert.throws(()=>checkMachineProfile({...actual,preferredUnits:'INCH'},machine),/units must be MM/);
 assert.throws(()=>checkMachineProfile({...actual,preferredUnits:undefined},machine),/units must be MM/);
});
test('serial port equivalence is limited to the optional /dev prefix',()=>{
 assert.equal(serialDevicePath('cu.usbserial-11240'),'/dev/cu.usbserial-11240');
 for(const port of ['/tmp/cu.usbserial-11240','../cu.usbserial-11240','/dev/../dev/cu.usbserial-11240','/dev//cu.usbserial-11240',' cu.usbserial-11240','cu.usbserial-11240\n','',null,12])
   assert.throws(()=>serialDevicePath(port));
});

test('ordinary worker motion, probes, dwells and native jog are permitted',()=>{
 const w=watch();for(const c of ['$G','$#','$$','$I','G90 G21 G94 G54 G1 X5 F600','G91 G38.2 Z-5 F50','G4 P1','M5','$J=G91 G21 X1 F600'])w.event(sent(c));
 const s=status();s.state='RUN';s.feedSpeed=600;s.machineCoord.x=5;s.workCoord.x=5;
 w.event(event('ControllerStatusEvent',{status:s}));
 w.event(event('ControllerStateEvent',{state:'IDLE',previousState:'RUN'}));
});
test('connection transitions including reconnect-to-idle invalidate continuity',()=>{
 for(const e of [{state:'DISCONNECTED',previousState:'IDLE'},{state:'CONNECTING'},{state:'ALARM'},{state:'IDLE',previousState:'CONNECTING'}])assert.throws(()=>watch().event(event('ControllerStateEvent',e)));
 assert.throws(()=>watch().event(event('AlarmEvent',{})),/alarm/);
});
test('reset, configuration, offsets, spindle and incompatible modes are rejected',()=>{
 for(const c of ['\x18','$RST=*','$X','$H','$100=900','G10 L20 P1 Z0','G92 Z0','G43.1 Z1','G55','G20','G93','M3 S0','M04','M6'])assert.throws(()=>watch().event(sent(c)),c);
});
test('firmware readback may repeat baseline but changes fail',()=>{
 const w=watch();w.event(event('FirmwareSettingEvent',{firmwareSetting:{key:'$0',value:'10',units:'microseconds',description:'Sets time length per step. Minimum 3usec.',shortDescription:'Step pulse time'}}));
 assert.throws(()=>w.event(event('FirmwareSettingEvent',{firmwareSetting:{key:'$0',value:'11'}})));
});
test('coordinate offsets, nonfinite position, spindle and profile changes fail',()=>{
 const w=watch();let s=status();s.workCoord.z+=1;assert.throws(()=>w.checkStatus(s));
 s=status();s.machineCoord.x=NaN;assert.throws(()=>w.checkStatus(s));
 s=status();s.spindleSpeed=1;assert.throws(()=>w.checkStatus(s));
 w.checkSettings({...settings,jogFeedRate:600});assert.throws(()=>w.checkSettings({...settings,preferredUnits:'INCH'}));
});
test('actual command-response startup banner and modal changes fail',()=>{
 const w=watch();assert.throws(()=>w.response("Grbl 1.1f ['$' for help]\n"),/startup/);
 w.response('[GC:G0 G54 G17 G21 G91 G94 M5]');assert.throws(()=>w.response('[GC:G0 G55 G17 G21 G90 G94 M5]'));
});
test('offset reports retain one reference and ignore historical PRB',()=>{
 const w=watch(),offsets=['G54','G55','G56','G57','G58','G59','G28','G30','G92'].map(k=>`[${k}:0,0,${k==='G54'?-20:0}]`).join('\n')+'\n[TLO:0]';
 w.response(offsets+'\n[PRB:0,0,4:1]');w.response(offsets+'\n[PRB:0,0,5:1]');
 assert.throws(()=>w.response(offsets.replace('[G55:0,0,0]','[G55:1,0,0]')));
});
test('heartbeat deadline is bounded',()=>{assert.equal(heartbeatExpired(0,7999),false);assert.equal(heartbeatExpired(0,8001),true);});

class MockSocket extends EventEmitter {
 static last;
 constructor(){super();MockSocket.last=this;this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.emit('open');});}
 ping(){queueMicrotask(()=>this.emit('pong'));}
 close(){this.readyState=3;this.emit('close');}
 terminate(){this.close();}
}
const request=async route=>{assert.ok(['status/getStatus','settings/getSettings'].includes(route));return route==='status/getStatus'?status():settings;};
test('ready requires socket/pong and checked snapshot; EOF closes observer without writes',async()=>{
 const stdin=new PassThrough(),events=[];
 const result=runWatch({WebSocketClass:MockSocket,doctor:doctor(),firmwareSettings:{0:'10'},request,stdin,
  emit:v=>{events.push(v);if(v.kind==='ready')stdin.end();},openTimeoutMs:100});
 assert.equal(await result,0);assert.equal(events[0].kind,'ready');assert.equal(events[0].listener.pid,1);assert.equal(events[0].g54.z,-20);assert.equal(events[0].status.state,'IDLE');assert.equal(MockSocket.last.readyState,3);
});
test('monitor reports disconnect once then closes with failure',async()=>{
 const stdin=new PassThrough(),events=[];
 const code=await runWatch({WebSocketClass:MockSocket,doctor:doctor(),firmwareSettings:{0:'10'},request,stdin,
  emit:v=>{events.push(v);if(v.kind==='ready')queueMicrotask(()=>MockSocket.last.emit('message',event('ControllerStateEvent',{state:'DISCONNECTED'})));},openTimeoutMs:100});
 assert.equal(code,1);assert.equal(events.filter(e=>e.kind==='failure').length,1);stdin.destroy();
});
test('missing pong never emits ready',async()=>{
 class SilentSocket extends MockSocket{ping(){}}
 const stdin=new PassThrough(),events=[];
 const code=await runWatch({WebSocketClass:SilentSocket,doctor:doctor(),firmwareSettings:{0:'10'},request,stdin,emit:v=>events.push(v),openTimeoutMs:15});
 assert.equal(code,1);assert.equal(events.some(e=>e.kind==='ready'),false);stdin.destroy();
});
test('unexpected socket close reports failure',async()=>{
 const stdin=new PassThrough(),events=[];
 const code=await runWatch({WebSocketClass:MockSocket,doctor:doctor(),firmwareSettings:{0:'10'},request,stdin,
  emit:v=>{events.push(v);if(v.kind==='ready')queueMicrotask(()=>MockSocket.last.close());},openTimeoutMs:100});
 assert.equal(code,1);assert.match(events.at(-1).error,/WebSocket closed/);stdin.destroy();
});
