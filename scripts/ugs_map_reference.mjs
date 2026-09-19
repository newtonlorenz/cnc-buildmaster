#!/usr/bin/env node
import {getConfig, apiBase, socketUrl} from './surface_config.mjs';
/** Read the actual offset through UGS before accepting its post-connect status cache. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEvent,parseOffsets} from './ugs_puck_map.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ensure=(ok,message)=>{if(!ok)throw Error(message);};
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=.0051;
export async function settleReference({WebSocketClass,request,snapshot,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,log=()=>{}}){
  const initial=await snapshot();let ws,failure=null,commandId=null,offsets=null,lastStatus=null;
  const checked=s=>{
    ensure(s.state==='IDLE'&&s.spindleSpeed===0&&s.feedSpeed===0&&!s.fileName&&!s.remainingRowCount,'Wait for UGS to be connected and stopped');
    ensure(s.machineCoord.units==='MM'&&s.workCoord.units==='MM','Expected MM');
    for(const a of ['x','y','z'])ensure(near(s.machineCoord[a],initial.status.machineCoord[a]),'Machine moved during reference startup');
  };
  checked(initial.status);
  try{
    ws=new WebSocketClass(socketUrl);
    ws.on('message',raw=>{try{
      const v=parseEvent(String(raw)),e=v.event;
      if(v.eventType==='ControllerStatusEvent')checked(e.status);
      if(v.eventType==='ControllerStateEvent')ensure(e.state==='IDLE'&&(!e.previousState||e.previousState==='IDLE'),'Connection changed during reference startup');
      if(v.eventType==='CommandEvent'){
        const c=e.command;
        if(e.commandEventType==='COMMAND_SENT'){
          ensure(c.command.trim()==='$#'&&commandId===null&&Number.isInteger(c.id),'Concurrent command during reference startup');commandId=c.id;log({kind:"referenceSent",commandId});
        }else if(e.commandEventType==='COMMAND_COMPLETE'){
          ensure(commandId!==null&&c.id===commandId&&c.command.trim()==='$#'&&c.isOk===true&&!c.isError&&!c.isSkipped&&!offsets,'Reference query failed');
          offsets=parseOffsets(c.response);log({kind:"referenceAcknowledged",commandId,g54:offsets.G54});
        }
      }
    }catch(e){failure=e;}});
    ws.on('error',e=>{failure=e;});ws.on('close',()=>{failure??=Error('Reference socket closed');});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Reference socket timeout')),3000);
      ws.once('open',()=>{clearTimeout(timer);resolve();});ws.once('error',e=>{clearTimeout(timer);reject(e);});
    });
    await request('machine/sendGcode',{commands:'$#'}); // Query only. No motion or settings write.
    const deadline=now()+8000;let matching=0;
    while(now()<deadline){
      if(failure)throw failure;
      const s=await request('status/getStatus');checked(s);lastStatus=s;
      if(offsets){
        ensure(offsets.G92.every(n=>n===0)&&offsets.TLO[0]===0,'Unexpected temporary/tool offset');
        const matches=['x','y','z'].every((a,i)=>near(s.machineCoord[a]-s.workCoord[a],offsets.G54[i]));
        matching=matches?matching+1:0;
        if(matching>=2){
          const final=await snapshot();checked(final.status);
          ensure(JSON.stringify(final.listener)===JSON.stringify(initial.listener),'UGS process changed');
          ensure(['port','portRate','firmwareVersion','preferredUnits'].every(k=>final.settings[k]===initial.settings[k]),'UGS profile changed');
          ensure(['x','y','z'].every((a,i)=>near(final.status.machineCoord[a]-final.status.workCoord[a],offsets.G54[i])),'Reference cache changed');
          if(failure)throw failure;
          return final;
        }
      }
      await pause(150);
    }
    const diagnostic={commandId,sent:commandId!==null,acknowledged:offsets!==null,
      actualG54:offsets?.G54??null,observedOffset:lastStatus?['x','y','z'].map(a=>lastStatus.machineCoord[a]-lastStatus.workCoord[a]):null};
    log({kind:'referenceTimeout',...diagnostic});
    const reason=commandId===null?'UGS did not send the reference query':!offsets?'UGS did not acknowledge the reference query':'UGS status has not matched the acknowledged G54 offset';
    throw Error(reason+'; no retry was attempted. '+JSON.stringify(diagnostic));
  }finally{
    if(ws){ws.removeAllListeners();ws.on('error',()=>{});ws.terminate();}
  }
}
async function main(){
 const snapshot=async()=>JSON.parse((await promisify(execFile)('python3',['scripts/ugs_api.py','doctor'],{cwd:root,timeout:20000})).stdout);
 const {default:WebSocketClass}=await import('ws');
 const request=async(route,body)=>{
  ensure(route==='status/getStatus'||(route==='machine/sendGcode'&&body?.commands==='$#'),'Read-only startup query guard');
  const response=await fetch(apiBase+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(3000)});
  ensure(response.ok,'UGS reference query HTTP '+response.status);const text=await response.text();return text?parseEvent(text):null;
 };
 console.log(JSON.stringify(await settleReference({WebSocketClass,request,snapshot,log:event=>console.error(JSON.stringify(event))})));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
