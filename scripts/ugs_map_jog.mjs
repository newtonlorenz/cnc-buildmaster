#!/usr/bin/env node
import {getConfig, apiBase, socketUrl} from './surface_config.mjs';
// A bounded step or held sequence, with one guarded preflight through UGS.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Session} from './ugs_puck_map.mjs';
import {jogPlan,gotoPlan,HoldLease,runJogPlan} from './ugs_jog_policy.mjs';
import {checkMachineProfile} from './ugs_machine_profile.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let input,session,lease,parentGone=false,inputFailure=null,resolveInput,rejectInput;
const first=new Promise((resolve,reject)=>{resolveInput=resolve;rejectInput=reject;});
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
  try{
    if(line.length>65536)throw Error('Oversized jog request');
    const m=JSON.parse(line);
    if(!input){input=m;resolveInput(m);if(m.mode==='hold')lease=new HoldLease(m.holdId,{at:m.at,released:m.released});}
    else {if(!lease)throw Error('Unexpected input during step');lease.message(m);}
  }catch(e){inputFailure=e;session?.fail(e);rejectInput(e);}
});
lines.on('close',()=>{parentGone=true;session?.fail(Error('Parent input closed'));rejectInput(Error('Parent closed before request'));});
const stop=()=>{inputFailure=Error('Operator stop / web session lost');session?.fail(inputFailure);rejectInput(inputFailure);};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
let parentWatch;
try{
  await first;
  const baseline=getConfig().baseline;
  const plan=input.mode==='goto'?gotoPlan(input,baseline):jogPlan(input,baseline);
  if(parentGone||inputFailure)throw inputFailure||Error('Parent input closed');
  const {stdout}=await promisify(execFile)('python3',['scripts/ugs_api.py','doctor'],{cwd:root,encoding:'utf8',timeout:20000});
  const doctor=JSON.parse(stdout);
  checkMachineProfile(doctor.settings,getConfig().machine);
  if(parentGone||inputFailure)throw inputFailure||Error('Parent input closed');
  const {snapshot}=input;
  const start=Object.fromEntries(['x','y','z'].map(a=>[a,doctor.status.machineCoord[a]]));
  const offset=Object.fromEntries(['x','y','z'].map(a=>[a,Number((start[a]-doctor.status.workCoord[a]).toFixed(3))]));
  if(JSON.stringify(doctor.listener)!==JSON.stringify(snapshot.listener))throw Error('UGS process changed');
  for(const a of ['x','y','z'])if(Math.abs(start[a]-snapshot.status.machineCoord[a])>.005||Math.abs(offset[a]-(snapshot.status.machineCoord[a]-snapshot.status.workCoord[a]))>.005)throw Error('Position/reference changed');
  const target=plan.mode==='goto'?plan.target:{...start,[plan.axis]:Number((start[plan.axis]+plan.sign*plan.limit).toFixed(3))};
  const envelope=Object.fromEntries(['x','y','z'].map(a=>[a,[Math.min(start[a],target[a]),Math.max(start[a],target[a])]]));
  const dir=fs.mkdtempSync(path.join(getConfig().dataDir,'web-jog-'));
  const log=(kind,data)=>{
    fs.appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify({utc:new Date().toISOString(),kind,data})+'\n');
    if(kind==='status')console.log(JSON.stringify({kind:'status',status:data}));
  };
  log('operatorRequest',input);log('plan',plan);
  session=new Session({start,expectedG54:offset,envelope},{log});
  if(plan.mode==='hold'){
    let capability;
    try {capability=await session.request('jogHold/capabilities');} catch {throw Error('Smooth hold needs the prepared UGS extension installed and UGS restarted');}
    if(capability?.protocol!==1||capability?.nativeJog!==true)throw Error('Unsupported native jog extension');
  }
  if(parentGone||inputFailure)session.fail(inputFailure||Error('Parent input closed'));
  const parentPID=process.ppid;
  parentWatch=setInterval(()=>{if(process.ppid!==parentPID)session.fail(Error('Parent process lost'));},250);
  const {default:WS}=await import('ws');
  await session.connect(WS);await session.preflight(baseline);
  const result=plan.mode==='hold' ? await session.nativeJog(plan,lease,input.holdId) :
    await runJogPlan(session,plan,{progress:data=>{log('jogProgress',data);console.log(JSON.stringify({kind:'jogProgress',...data}));}});
  await session.verifyReference();session.alive();
  console.log(JSON.stringify({kind:'jogResult',...result,evidence:dir}));
}catch(e){session?.fail(e);console.log(JSON.stringify({kind:'failure',error:e.message}));process.exitCode=1;}
finally{
  clearInterval(parentWatch);await session?.close();
  lines.removeAllListeners();lines.close();process.stdin.pause();
  process.off('SIGTERM',stop);process.off('SIGINT',stop);
}
