import test from 'node:test';
import assert from 'node:assert/strict';
import {validateConfig, planRoute, parseEvent, probeContact, commandBounds, checkStatus,
  commandDeadline, parseOffsets, checkModes, checkBaseline, InputGate, JsonInputGate, ContactMonitor, exportMap, Session} from '../scripts/ugs_puck_map.mjs';

const raw = () => ({version: 1, grid: {x: [0, 50, 100], y: [1, 51, 81], spacing: 50},
  start: {x: 100, y: 1, z: -4.754}, travelZ: -4.754,
  envelope: {x: [0, 100], y: [1, 81], z: [-9.955, -3.754]},
  expectedG54: {x: 2, y: -3, z: -20}, puckHeight: 14, outputDir: 'offline-tests'});
const config = () => validateConfig(raw());
const status = (c, p = c.start, state = 'IDLE') => ({machineCoord: {...p, units: 'MM'},
  workCoord: {...Object.fromEntries(['x','y','z'].map(a => [a, p[a] - c.expectedG54[a]])), units: 'MM'},
  state, spindleSpeed: 0, feedSpeed: state === 'IDLE' ? 0 : 10, fileName: '', remainingRowCount: 0});
const commandEvent = (kind, id, command, response = 'ok', extra = {}) => JSON.stringify({eventType: 'CommandEvent',
  event: {commandEventType: kind, command: {id, command, response, isOk: true, ...extra}}});
const controllerStatus = s => JSON.stringify({eventType:'ControllerStatusEvent',event:{status:s}});
const measurements = c => planRoute(c).points.map((p, i, all) => ({...p,
  contactZ: i === all.length - 1 ? -7 + .005 : -7 + p.x * .001 + p.y * .001 - all[0].x * .001 - all[0].y * .001, spread: .005}));

test('defaults frozen; no implicit old data and no stock-based bounds', () => {
  const c = config(); assert.equal(c.feeds.xy, 600); assert.equal(c.probe.firstSearch, 5);
  assert.throws(() => c.grid.x.push(150));
  assert.throws(() => validateConfig({...raw(), stockWidth: 300}), /unknown key/);
  const x = raw(); x.start.x = 75; assert.throws(() => validateConfig(x), /grid point/);
  assert.throws(() => validateConfig({...raw(), travelZ: 0}), /travelZ/);
});
test('profile feeds, explicit extended search and command-resolution constraints', () => {
  for (const [key, max] of Object.entries({xy:600,z:60,first:50,second:10})) {
    assert.throws(() => validateConfig({...raw(), feeds:{[key]:max+1}}));
    assert.throws(() => validateConfig({...raw(), feeds:{[key]:0}}));
  }
  assert.throws(() => validateConfig({...raw(), probe:{firstSearch: 6}}));
  const x = raw(); x.envelope.z[0] = -15;
  assert.equal(validateConfig({...x, probe:{firstSearch:10,allowExtendedSearch:true}}).probe.firstSearch, 10);
  assert.throws(() => validateConfig({...x, probe:{firstSearch:10.001,allowExtendedSearch:true}}));
  assert.throws(() => validateConfig({...x, probe:{repeatTolerance:.021}}));
  assert.throws(() => validateConfig({...x, probe:{retract:2}}));
  assert.equal(validateConfig({...raw(), puckHeight:18}).puckHeight,18);
  for (const puckHeight of [0,-1,101,NaN]) assert.throws(() => validateConfig({...raw(),puckHeight}));
});
test('rectangular common grid with shortened boundary; import first Y interval guard', () => {
  assert.doesNotThrow(config);
  const x = raw(); x.grid.y = [1,31,81]; assert.throws(() => validateConfig(x), /spacing/);
  x.grid.y = [1,31]; assert.throws(() => validateConfig(x), /First Y/);
  x.grid.y = [1,51,51]; assert.throws(() => validateConfig(x));
  x.grid.y = [1,51,101]; assert.throws(() => validateConfig(x), /envelope/);
});
test('Z envelope includes full second-search and upward retract bounds', () => {
  const x = raw(); x.envelope.z[0] = -9.754; assert.throws(() => validateConfig(x), /Z envelope/);
  x.envelope.z = [-10,-4]; assert.throws(() => validateConfig(x), /Z envelope/);
});
test('every grid point can start; reference closes the route without startup move', () => {
  for (const x of raw().grid.x) for (const y of raw().grid.y) {
    const c = validateConfig({...raw(), start:{...raw().start,x,y}}), route = planRoute(c).points;
    assert.deepEqual(route[0], {x,y}); assert.deepEqual(route.at(-1), {x,y});
    assert.equal(route.length, 10); assert.equal(new Set(route.slice(0,-1).map(p=>`${p.x},${p.y}`)).size,9);
  }
});
test('only native bare ABC NaN normalised; invalid XYZ never repaired', () => {
  assert.equal(parseEvent('{"a":NaN,"b":NaN,"c":NaN,"x":1}').a,null);
  for (const text of ['{"x":NaN}', '{"x":"NaN"}', '{"x":null}', '{"y":1e999}', '{"z":Infinity}', '{"v":NaN}']) assert.throws(()=>parseEvent(text));
});
test('PRB success, uniqueness and command-specific bounds', () => {
  const p = {x:1,y:2,z:10}; assert.equal(probeContact('[PRB:1,2,7:1]\nok',p,5).z,7);
  for (const bad of ['[PRB:1,2,7:0]', '[PRB:1,2,7:1][PRB:1,2,7:1]', '[PRB:1,2,4:1]', '[PRB:2,2,7:1]', '[PRB:1,2,10:1]', '[PRB:1,2,NaN:1]']) assert.throws(()=>probeContact(bad,p,5));
  assert.throws(()=>probeContact('[PRB:1,2,7:1]',p,1.2));
});
test('status rejects wrong offsets, outside command bounds, unexpected movement and file', () => {
  const c = config(), bounds=commandBounds(c.start,c.start); assert.doesNotThrow(()=>checkStatus(status(c),bounds,c.expectedG54));
  for (const s of [status(c,{...c.start,z:c.start.z+.1}),status(c,c.start,'RUN'),{...status(c),fileName:'cut.nc'},{...status(c),spindleSpeed:1}]) assert.throws(()=>checkStatus(s,bounds,c.expectedG54));
  const s=status(c); s.workCoord.x += 1; assert.throws(()=>checkStatus(s,bounds,c.expectedG54));
  assert.ok(commandDeadline(100,600)>10000); assert.ok(commandDeadline(10,50)>12000);
});
test('modal and offset guards are exact, retain all stored offsets excluding historical PRB', () => {
  checkModes('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]');
  assert.throws(()=>checkModes('[GC:G54 G21 G91 G94 M5]'));
  const offsets=['G54','G55','G56','G57','G58','G59','G28','G30','G92'].map(k=>`[${k}:0.000,0.000,0.000]`).join('\n')+'\n[TLO:0.000]';
  assert.equal(parseOffsets(offsets+'\n[PRB:0,0,0:0]').G54[2],0);
  assert.throws(()=>parseOffsets(offsets.replace('TLO:0.000','TLO:0.100')));
  assert.throws(()=>parseOffsets(offsets.replace('G92:0.000','G92:1.000')));
  const baseline=Object.fromEntries(Array.from({length:34},(_,i)=>[i,'0']));
  checkBaseline(Object.keys(baseline).map(k=>`$${k}=0`).join('\n'),baseline);
  assert.throws(()=>checkBaseline('$0=0',baseline));
});
test('input ENTER accepts once; buffered and partial busy input cannot trigger next cycle', async () => {
  const gate=new InputGate({write:()=>{}});
  gate.feed('\n'); const first=gate.ask('place',''); gate.feed('\n\n'); await first;
  gate.feed('go\n\npartial');
  let secondResolved=false; const second=gate.ask('place','').then(()=>secondResolved=true);
  await Promise.resolve(); assert.equal(secondResolved,false);
  gate.feed('\n'); await second;
});
test('EOF/quit/SIGINT close gate and trigger cancellation, including while busy', async () => {
  for (const reason of ['EOF','SIGINT','quit']) {
    let cancelled=false; const gate=new InputGate({write:()=>{},cancel:()=>cancelled=true});
    const waiting=gate.ask('place',''); gate.end(reason);
    await assert.rejects(waiting,new RegExp(reason)); assert.equal(cancelled,true);
  }
  let cancelled=false; const gate=new InputGate({write:()=>{},cancel:()=>cancelled=true}); gate.feed('quit\n'); assert.equal(cancelled,true);
});
test('contact cycle must be observed; unchanged open remains valid without new event', () => {
  const p=new ContactMonitor(); assert.throws(()=>p.requireOpen());
  p.observe({probe:true}); p.observe({probe:false}); assert.throws(()=>p.requireCycle());
  p.observe({probe:true}); p.observe({probe:false}); p.requireCycle(); p.observe({}); p.requireOpen();
});
test('export sorted native order, work XY and relative heights; G54 left unresolved', () => {
  const c=config(), records=measurements(c), out=exportMap(c,records), lines=out.xyz.trim().split('\n').map(l=>l.split(' ').map(Number));
  assert.deepEqual(lines[0].slice(0,2),[-2,4]); assert.equal(lines[1][1]-lines[0][1],50);
  assert.equal(lines.length,9); assert.equal(out.requiredG54Z,-21); assert.equal(out.datumMatches,false);
  assert.ok(Math.abs(out.drift-.005)<1e-9);
});
test('no XYZ export for incomplete, wrong membership, excessive spread/drift or flat map', () => {
  const c=config(), r=measurements(c); assert.throws(()=>exportMap(c,r.slice(0,-1)),/Incomplete/);
  let copy=structuredClone(r); copy[1].x=123; assert.throws(()=>exportMap(c,copy));
  copy=structuredClone(r); copy[2].spread=.021; assert.throws(()=>exportMap(c,copy));
  copy=structuredClone(r); copy.at(-1).contactZ+=.1; assert.throws(()=>exportMap(c,copy),/drift/);
  copy=structuredClone(r).map(p=>({...p,contactZ:-7})); assert.throws(()=>exportMap(c,copy),/Flat map/);
});

test('mocked command requires matching SENT/id/COMPLETE and stopped target', async () => {
  const c=config(); let session, sent=[], current=status(c);
  session=new Session(c,{request:async(route,body)=>{
    if(route==='machine/sendGcode') {
      sent.push(body.commands); session.event(commandEvent('COMMAND_SENT',1,body.commands));
      current=status(c,{...c.start,x:50});
      session.event(commandEvent('COMMAND_COMPLETE',1,body.commands));
      session.event(controllerStatus(current)); return null;
    } return current;
  }});
  await session.move({...c.start,x:50},600); assert.equal(sent.length,1); assert.equal(session.hold.x,50); assert.equal(session.outstanding,false);
});
test('mocked stale PRB completion cannot satisfy new command; reset once if outstanding', async () => {
  const c=config(); let session, resets=0;
  session=new Session(c,{request:async(route,body)=>{
    if(route==='machine/softReset') {resets++;return null;}
    if(route==='machine/sendGcode') {
      session.event(commandEvent('COMMAND_SENT',2,body.commands));
      session.event(commandEvent('COMMAND_COMPLETE',1,body.commands,'[PRB:100,1,-7:1]'));return null;
    }return status(c);
  }});
  await assert.rejects(session.touch(5,50,.1),/probe input/); // Unknown input never moves.
  session.contact.observe({probe:false});
  await assert.rejects(session.touch(5,50,.1),/stale/);
  session.fail(Error('another failure')); await session.close(); assert.equal(resets,1);
});
test('concurrent command while waiting fails and requests reviewed stop once', async () => {
  let resets=0; const session=new Session(config(),{request:async route=>{assert.equal(route,'machine/softReset');resets++;}});
  session.event(commandEvent('COMMAND_SENT',10,'G0 X1'));
  assert.match(session.failure.message,/Concurrent/); await session.close(); assert.equal(resets,1);
});
test('mocked probe uses latched result, rejects out-of-bounds or invalid stopping distance', async () => {
  for (const [contact,stopped,pass] of [[-7,-7.01,true],[-11,-7,false],[-7,-7.2,false]]) {
    const c=config(); let session, clock=0;
    session=new Session(c,{now:()=>clock,pause:async ms=>{clock+=ms;},request:async(route,body)=>{
      if(route==='machine/softReset')return null;
      if(route==='machine/sendGcode') {session.event(commandEvent('COMMAND_SENT',1,body.commands));session.event(commandEvent('COMMAND_COMPLETE',1,body.commands,`[PRB:100,1,${contact}:1]\nok`));session.event(controllerStatus(status(c,{...c.start,z:stopped})));return null;}
      return status(c,{...c.start,z:stopped});
    }});
    session.contact.observe({probe:false});
    if(pass) assert.equal((await session.touch(5,50,.1)).z,contact);
    else await assert.rejects(session.touch(5,50,.1));
  }
});
test('actual UGS event permits boolean limit-switch pins but checks machine/work coordinates', () => {
  const c=config(), s=status(c); s.pins={x:false,y:false,z:false,probe:true};
  const event={eventType:'ControllerStatusEvent',event:{status:s}};
  assert.equal(parseEvent(JSON.stringify(event)).event.status.pins.x,false);
  event.event.status.machineCoord.x=null;
  assert.throws(()=>parseEvent(JSON.stringify(event)),/finite/);
});
test('complete mocked two-touch cycle lifts to fixed travelZ and preserves every offset', async () => {
  const c=config(); const offsets=['G54','G55','G56','G57','G58','G59','G28','G30','G92'].map(k=>`[${k}:${k==='G54'?'2,-3,-20':'0,0,0'}]`).join('\n')+'\n[TLO:0]';
  let session, pos={...c.start}, id=0, touches=0, commands=[];
  session=new Session(c,{request:async(route,body)=>{
    if(route==='status/getStatus')return {...status(c,pos),pins:{x:false,y:false,z:false,probe:false}};
    assert.equal(route,'machine/sendGcode'); const line=body.commands; commands.push(line);
    session.event(commandEvent('COMMAND_SENT',++id,line));
    let response='ok';
    if(line==='$G')response='[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\nok';
    else if(line==='$#')response=offsets+'\nok';
    else if(line.includes('G38.2')) {touches++; const z=touches===1?-7:-7.005; pos.z=z-.001;response=`[PRB:100,1,${z}:1]\nok`;}
    else if(line.includes('G1 X'))for(const a of ['x','y','z'])pos[a]=Number(line.match(new RegExp(`${a.toUpperCase()}(-?[\\d.]+)`))[1])+c.expectedG54[a];
    session.event(commandEvent('COMMAND_COMPLETE',id,line,response));
    session.event(controllerStatus({...status(c,pos),pins:{x:false,y:false,z:false,probe:false}}));return null;
  }});
  session.offsets=parseOffsets(offsets);session.contact.observe({probe:false});
  const r=await session.measure({x:100,y:1});
  assert.equal(touches,2);assert.ok(r.spread<.006);assert.ok(Math.abs(session.hold.z-c.travelZ)<1e-9);
  assert.ok(commands.every(line=>!/^G10|G92|\$X|\$H/.test(line)));
  assert.equal(commands.filter(line=>line.includes('G38.2')).length,2);
});
test('unexpected live motion from idle requests stop, even without a pending command', async () => {
  let resets=0; const c=config(), session=new Session(c,{request:async()=>{resets++;}});
  session.event(JSON.stringify({eventType:'ControllerStatusEvent',event:{status:status(c,c.start,'RUN')}}));
  await session.close();assert.equal(resets,1);assert.ok(session.failure);
});
test('web stdio prompt IDs are single use, token-authenticated, and discard early/stale Enter', async () => {
  const events=[], token='a'.repeat(32), gate=new JsonInputGate({token,emit:v=>events.push(v)});
  const first=gate.ask('place',''), id=events.at(-1).id;
  const message=JSON.stringify({id,answer:'',token})+'\n';
  gate.feed(message+message);await first;
  assert.equal(events.filter(e=>e.kind==='consumed').length,1);
  let resolved=false;const second=gate.ask('next','').then(()=>resolved=true), next=events.at(-1).id;
  gate.feed(message);await Promise.resolve();assert.equal(resolved,false);
  gate.feed(JSON.stringify({id:next,answer:'',token})+'\n');await second;
});
test('web bad token, malformed messages, EOF and authenticated cancel reject and stop', async () => {
  for(const chunk of ['not json\n',JSON.stringify({id:'x',answer:'',token:'wrong'})+'\n',JSON.stringify({kind:'cancel',token:'a'.repeat(32)})+'\n']) {
    let cancelled=false;const gate=new JsonInputGate({token:'a'.repeat(32),emit:()=>{},cancel:()=>cancelled=true});
    const p=gate.ask('ready','');gate.feed(chunk);await assert.rejects(p);assert.equal(cancelled,true);
  }
  const gate=new JsonInputGate({token:'a'.repeat(32),emit:()=>{}}),p=gate.ask('ready','');gate.end('EOF');await assert.rejects(p,/EOF/);
});
test('dwell RUN is accepted only inside stationary bounds', async () => {
  const c=config();let session;
  session=new Session(c,{request:async(route,body)=>{
    if(route==='machine/sendGcode') {
      session.event(commandEvent('COMMAND_SENT',1,body.commands));
      session.event(JSON.stringify({eventType:'ControllerStatusEvent',event:{status:status(c,c.start,'RUN')}}));
      session.event(commandEvent('COMMAND_COMPLETE',1,body.commands));return null;
    }return status(c);
  }});
  await session.command('G4 P1');assert.equal(session.failure,null);
  session.pending={allowRun:true,bounds:commandBounds(c.start,c.start)};
  assert.throws(()=>session.status(status(c,{...c.start,z:c.start.z-.1},'RUN')),/bounds/);
});

test('recorded 1 mm jog: acknowledgement plus cached Idle must wait, without reset or resend', async()=>{
  const {readFileSync}=await import('node:fs');
  const f=JSON.parse(readFileSync(new URL('./fixtures/ugs-jog-early-ack.json',import.meta.url)));
  const start=Object.fromEntries(['x','y','z'].map(a=>[a,f.start.machineCoord[a]]));
  const target={...start,y:0};
  const c={start,envelope:{x:[100,100],y:[0,1],z:[start.z,start.z]},expectedG54:{x:0,y:0,z:-15.753}};
  let session,clock=0,reads=0,resets=0,sends=0,current=f.staleStatus;
  session=new Session(c,{now:()=>clock,pause:async ms=>{
    clock+=ms;assert.equal(session.failure,null);assert.equal(resets,0);
    if(clock===150){current=status(c,{...start,y:.7},'RUN');session.event(controllerStatus(current));}
    if(clock===225){current=status(c,target);session.event(controllerStatus(current));}
  },request:async(route,body)=>{
    if(route==='machine/sendGcode'){sends++;assert.equal(body.commands,f.command);f.events.forEach(e=>session.event(e));return null;}
    if(route==='machine/softReset'){resets++;return null;}
    reads++;return current;
  }});
  await session.move(target,600);
  assert.ok(reads>=4);assert.equal(clock,225);assert.equal(sends,1);assert.equal(resets,0);
  assert.deepEqual(session.hold,target);assert.equal(session.outstanding,false);
});

test('cached REST endpoint alone cannot establish movement completion',async()=>{
  const c=config(),target={...c.start,x:99};let session,clock=0,resets=0,sends=0;
  session=new Session(c,{now:()=>clock,pause:async ms=>{clock+=ms;},request:async(route,body)=>{
    if(route==='machine/sendGcode'){sends++;session.event(commandEvent('COMMAND_SENT',1,body.commands));session.event(commandEvent('COMMAND_COMPLETE',1,body.commands));return null;}
    if(route==='machine/softReset'){resets++;return null;}
    return status(c,target);
  }});
  await assert.rejects(session.move(target,600),/deadline.*fresh stopped/);
  await session.close();assert.equal(sends,1);assert.equal(resets,1);
});

test('short jog may finish between polls without RUN; fresh endpoint and ack are both required',async()=>{
  const c=config(),target={...c.start,x:99.9};let session;
  session=new Session(c,{request:async(route,body)=>{
    if(route==='machine/sendGcode'){
      session.event(commandEvent('COMMAND_SENT',1,body.commands));
      session.event(controllerStatus(status(c,target)));
      session.event(commandEvent('COMMAND_COMPLETE',1,body.commands));return null;
    }return status(c,target);
  }});
  await session.move(target,600);assert.equal(session.failure,null);assert.deepEqual(session.hold,target);
});

test('fresh endpoint event with lagging REST waits for matching readback',async()=>{
  const c=config(),target={...c.start,x:99};let session,clock=0,current=status(c);
  session=new Session(c,{now:()=>clock,pause:async ms=>{clock+=ms;current=status(c,target);},request:async(route,body)=>{
    if(route==='machine/sendGcode'){
      session.event(commandEvent('COMMAND_SENT',1,body.commands));session.event(commandEvent('COMMAND_COMPLETE',1,body.commands));
      session.event(controllerStatus(status(c,target)));return null;
    }return current;
  }});
  await session.move(target,600);assert.equal(clock,75);assert.equal(session.failure,null);
});

test('probe acknowledgement with old Idle waits for fresh stopped contact position before retract',async()=>{
  const c=config(),stopped={...c.start,z:-7.01};let session,clock=0,current=status(c),sends=0;
  session=new Session(c,{now:()=>clock,pause:async ms=>{
    clock+=ms;assert.equal(sends,1);assert.equal(session.failure,null);
    current=status(c,stopped);session.event(controllerStatus(current));
  },request:async(route,body)=>{
    if(route==='machine/sendGcode'){
      sends++;session.event(commandEvent('COMMAND_SENT',1,body.commands));
      session.event(commandEvent('COMMAND_COMPLETE',1,body.commands,'[PRB:100,1,-7:1]\nok'));return null;
    }return current;
  }});
  session.contact.observe({probe:false});
  assert.equal((await session.touch(5,50,.1)).z,-7);assert.equal(clock,75);assert.equal(sends,1);
});

test('fresh wrong endpoint remains bounded and eventually stops once, without retry',async()=>{
  const c=config(),target={...c.start,x:99};let session,clock=0,resets=0,sends=0;
  const wrong=status(c,{...c.start,x:99.5});
  session=new Session(c,{now:()=>clock,pause:async ms=>{clock+=ms;},request:async(route,body)=>{
    if(route==='machine/sendGcode'){
      sends++;session.event(commandEvent('COMMAND_SENT',1,body.commands));
      session.event(commandEvent('COMMAND_COMPLETE',1,body.commands));session.event(controllerStatus(wrong));return null;
    }
    if(route==='machine/softReset'){resets++;return null;}
    return wrong;
  }});
  await assert.rejects(session.move(target,600),/deadline/);
  await session.close();assert.equal(sends,1);assert.equal(resets,1);assert.deepEqual(session.hold,c.start);
});

test('alarm and out-of-bounds movement still stop immediately while awaiting completion',async()=>{
  for(const bad of ['alarm','bounds']){
    const c=config(),target={...c.start,x:99};let session,resets=0;
    session=new Session(c,{pause:async()=>assert.fail('Failure must not wait'),request:async(route,body)=>{
      if(route==='machine/softReset'){resets++;return null;}
      if(route==='machine/sendGcode'){
        session.event(commandEvent('COMMAND_SENT',1,body.commands));session.event(commandEvent('COMMAND_COMPLETE',1,body.commands));
        if(bad==='alarm')session.event(JSON.stringify({eventType:'ControllerStateEvent',event:{state:'ALARM'}}));
        else session.event(controllerStatus(status(c,{...c.start,x:98},'RUN')));
        return null;
      }return status(c);
    }});
    await assert.rejects(session.move(target,600));await session.close();assert.equal(resets,1);
  }
});

test('native held jog sends one $J command, accepts JOG, cancels on release and preserves reference',async()=>{
 const c=config(),plan={axis:'x',sign:-1,limit:100,feed:1000},id='native-hold-test';
 let held=true,session,pos={...c.start},state='IDLE',stopping=false,pulses=0,clock=0,stoppedAt=null;
 const calls=[],lease={active:()=>held,message:()=>{held=false;}};
 session=new Session(c,{request:async(route,body)=>{
  calls.push(route);
  if(route==='jogHold/start'){
   assert.equal(body.delta,-100);assert.equal(body.feed,1000);
   const line='$J=G21G91X-100F1000';
   session.event(commandEvent('COMMAND_SENT',5,line));session.event(commandEvent('COMMAND_COMPLETE',5,line));
   state='JOG';pos.x=95;session.event(controllerStatus(status(c,pos,state)));return {id};
  }
  if(route==='jogHold/pulse'){
   pulses++;held=false;return {id,finished:false,cancelled:false};
  }
  if(route==='jogHold/stop'){stopping=true;stoppedAt=clock;state='IDLE';pos.x=94;session.event(controllerStatus(status(c,pos,state)));return {id,finished:true,cancelled:true,position:pos};}
  if(route==='jogHold/state?id='+id)return {id,finished:true,cancelled:true,position:pos};
  if(route==='machine/sendGcode'){
   assert.equal(body.commands,'$G');
   session.event(commandEvent('COMMAND_SENT',6,'$G'));
   // Reproduce a query acknowledgement lost inside the cancellation interval.
   if(clock-stoppedAt>=300)session.event(commandEvent('COMMAND_COMPLETE',6,'$G','[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\nok'));
   return {};
  }
  if(route==='status/getStatus')return status(c,pos,state);
  assert.fail('Unexpected '+route);
 },now:()=>clock,pause:async ms=>{clock+=ms;}});
 const result=await session.nativeJog(plan,lease,id);
 assert.equal(result.moved,6);assert.equal(stopping,true);assert.equal(pulses,1);
 assert.equal(calls.filter(r=>r==='jogHold/start').length,1);
 assert.equal(calls.includes('machine/softReset'),false);assert.equal(session.failure,null);
 await session.command('$G');
 assert.equal(calls.filter(r=>r==='machine/sendGcode').length,1);
 assert.ok(clock-stoppedAt>=300);
});

test('native jog settling keeps the stopped point guarded and cancels new movement',async()=>{
 const c=config(),plan={axis:'x',sign:-1,limit:100,feed:1000},id='settle-hold-test';
 let session,clock=0,pos={...c.start},held=true,cancels=0;
 session=new Session(c,{now:()=>clock,pause:async ms=>{clock+=ms;},request:async(route)=>{
  if(route==='jogHold/start'){
   const line='$J=G21G91X-100F1000';session.event(commandEvent('COMMAND_SENT',7,line));session.event(commandEvent('COMMAND_COMPLETE',7,line));return {id};
  }
  if(route==='jogHold/pulse'){pos.x=94;return {id,finished:true,position:pos};}
  if(route==='jogHold/state?id='+id){pos={...pos,x:93};return {id,finished:true,position:pos};}
  if(route==='status/getStatus')return status(c,pos);
  if(route==='jogHold/stop'){cancels++;return {id};}
  assert.fail(route);
 }});
 await assert.rejects(session.nativeJog(plan,{active:()=>held},id),/bounds|position/i);
 assert.equal(cancels,1);
 assert.ok(session.failure);
});
test('native held jog refuses movement after release and cancels a bounds failure without retrying start',async()=>{
 const c=config(),plan={axis:'x',sign:-1,limit:100,feed:1000},id='native-hold-test';
 let session,starts=0,cancels=0;
 session=new Session(c,{request:async(route)=>{
  if(route==='jogHold/start'){
   starts++;const line='$J=G21G91X-100F1000';session.event(commandEvent('COMMAND_SENT',6,line));session.event(commandEvent('COMMAND_COMPLETE',6,line));
   session.event(controllerStatus(status(c,{...c.start,x:-1},'JOG')));return {id};
  }
  if(route==='jogHold/stop'){cancels++;return {id};}
  assert.fail(route);
 }});
 assert.equal((await session.nativeJog(plan,{active:()=>false},id)).moved,0);assert.equal(starts,0);
 await assert.rejects(session.nativeJog(plan,{active:()=>true},id),/bounds/);
 assert.equal(starts,1);assert.equal(cancels,1);
});
