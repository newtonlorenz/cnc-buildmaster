#!/usr/bin/env node
import {getConfig, apiBase, socketUrl} from './surface_config.mjs';
/** Read-only continuity watcher. Parent must stop its motion worker on failure/exit.
 * Start: node scripts/ugs_map_watch.mjs
 * Keep stdin open. stdout JSON {kind:'ready',...} or {kind:'failure',error,...}.
 * EOF/SIGTERM/SIGINT close this observer; it NEVER sends machine commands or resets.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseEvent, parseOffsets} from './ugs_puck_map.mjs';
import {checkMachineProfile} from './ugs_machine_profile.mjs';
export {serialDevicePath, checkMachineProfile} from './ugs_machine_profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ensure = (ok, message) => { if (!ok) throw Error(message); };
const axes = ['x', 'y', 'z'];
const closeTo = (a,b) => Math.abs(a-b) <= .005 + 1e-9;
const PROFILE_KEYS = ['port', 'portRate', 'firmwareVersion', 'preferredUnits'];

export class ReferenceWatch {
  constructor({settings, status, firmwareSettings}) {
    this.profile = Object.fromEntries(PROFILE_KEYS.map(k => [k,settings[k]]));
    ensure(PROFILE_KEYS.every(k => this.profile[k] !== undefined), 'Incomplete UGS connection profile');
    ensure(this.profile.preferredUnits === 'MM', 'UGS preferred units must be MM');
    this.g54 = null; this.offsets = null; this.firmwareSettings = firmwareSettings;
    this.checkStatus(status);
    ensure(status.state === 'IDLE' && status.feedSpeed === 0, 'Watcher must start at Idle');
  }
  checkSettings(settings) {
    ensure(PROFILE_KEYS.every(k => settings[k] === this.profile[k]), 'UGS connection/units profile changed');
  }
  checkStatus(s) {
    ensure(s && ['IDLE','RUN','JOG'].includes(s.state), `Controller connection/state invalid: ${s?.state}`);
    ensure(s.spindleSpeed === 0 && Number.isFinite(s.feedSpeed) && s.feedSpeed >= 0, 'Unexpected spindle/feed');
    ensure(!s.fileName && !s.remainingRowCount, 'Unexpected loaded/active job');
    ensure(s.machineCoord?.units === 'MM' && s.workCoord?.units === 'MM', 'Coordinate units changed');
    const offset = {};
    for (const a of axes) {
      ensure(Number.isFinite(s.machineCoord[a]) && Number.isFinite(s.workCoord[a]), 'Nonfinite XYZ');
      offset[a] = s.machineCoord[a] - s.workCoord[a];
      if (this.g54) ensure(closeTo(offset[a],this.g54[a]), 'Work reference changed');
    }
    this.g54 ??= offset;
  }
  command(line) {
    ensure(typeof line === 'string', 'Missing command text');
    ensure(!line.includes('\x18'), 'Controller reset command');
    let clean = line.replace(/\([^)]*\)/g,'').replace(/;.*/g,'').trim().toUpperCase();
    if (clean.startsWith('$J=')) clean = clean.slice(3);
    else if (clean.startsWith('$')) {
      ensure(['$I','$$','$#','$G'].includes(clean), 'Unexpected controller configuration/reset/homing command');
      return;
    }
    // Ordinary G0/G1, two-touch G38.2, G90/G91 and G4 are expected worker commands.
    const words = [...clean.matchAll(/([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)];
    for (const [, letter, number] of words) {
      const n = Number(number);
      if (letter === 'G') {
        ensure(![10,20,28,28.1,30,30.1,43,43.1,49,50,51,52,53,55,56,57,58,59,59.1,59.2,59.3,92,92.1,92.2,92.3,93,95].includes(n), 'Reference/units/mode-changing command');
      }
      if (letter === 'M') ensure(![3,4,6].includes(n), 'Spindle start/tool change command');
    }
  }
  response(text) {
    if (typeof text !== 'string') return;
    // Actual command responses can carry a banner; stock EventsSocket has no raw-console event.
    ensure(!/(?:^|[\r\n])\s*Grbl\s+\d[^\r\n]*\[/i.test(text), 'GRBL startup banner; reference lost');
    const modal = text.match(/\[GC:([^\]]+)\]/);
    if (modal) {
      const modes = modal[1].trim().split(/\s+/);
      for (const required of ['G21','G54','G94','M5']) ensure(modes.includes(required), `Observed modal state lost ${required}`);
    }
    if (text.includes('[G54:')) {
      const offsets = parseOffsets(text);
      ensure(axes.every((a,i) => closeTo(offsets.G54[i],this.g54[a])), 'G54 report changed');
      if (this.offsets) ensure(JSON.stringify(offsets) === JSON.stringify(this.offsets), 'Stored offsets changed');
      this.offsets ??= offsets;
    }
  }
  event(raw) {
    const v = parseEvent(raw), e = v.event;
    if (v.eventType === 'ControllerStateEvent') {
      ensure(['IDLE','RUN','JOG'].includes(e.state), `Controller transition: ${e.state}`);
      if (e.previousState !== undefined) ensure(['IDLE','RUN','JOG'].includes(e.previousState), `Reconnect/reset transition from ${e.previousState}`);
    } else if (v.eventType === 'ControllerStatusEvent') {
      this.checkStatus(e.status);
    } else if (v.eventType === 'CommandEvent') {
      if (e.commandEventType === 'COMMAND_SENT') this.command(e.command.command);
      this.response(e.command?.response);
    } else if (v.eventType === 'FirmwareSettingEvent') {
      const setting = e.firmwareSetting;
      ensure(setting && typeof setting.key === 'string', 'Invalid firmware setting event');
      const key = setting.key.replace(/^\$/, '');
      ensure(String(setting.value) === this.firmwareSettings[key], `Firmware setting changed: $${key}`);
    } else if (v.eventType === 'AlarmEvent') {
      throw Error('Controller alarm');
    }
    // SettingChangedEvent has no payload in installed UGS; polling reads its actual settings.
  }
}

export function heartbeatExpired(lastPong, now, timeout = 8000) { return now-lastPong > timeout; }

export async function runWatch({WebSocketClass, doctor, firmwareSettings, request, stdin = process.stdin,
  emit = value => console.log(JSON.stringify(value)), heartbeatMs = 2000, heartbeatTimeoutMs = 8000,
  pollMs = 750, openTimeoutMs = 5000} = {}) {
  let ws, heartbeat, poller, openedTimer, polling = false, ended = false, ready = false, failure = null;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const end = error => {
    if (ended) return; ended = true;
    if (error) { failure = error; emit({kind:'failure', error: String(error.message ?? error), referenceValid:false}); }
    finish();
  };
  const eof = () => end(); const interrupt = () => end();
  stdin.on('end',eof); stdin.on('error',end); stdin.resume();
  process.on('SIGTERM',interrupt); process.on('SIGINT',interrupt);
  try {
    ensure(!stdin.readableEnded, 'Parent pipe already closed');
    const watch = new ReferenceWatch({settings:doctor.settings,status:doctor.status,firmwareSettings});
    ensure(!doctor.file.fileName && !doctor.file.remainingRowCount, 'Unexpected selected file');
    ws = new WebSocketClass(socketUrl);
    ws.on('message',data => { if (!ended) try { watch.event(String(data)); } catch(e) { end(e); } });
    ws.on('error',end); ws.on('close',() => { if (!ended) end(Error('Continuity WebSocket closed')); });
    let lastPong = Date.now(), pongSeen = false, snapshotChecked = false, readyStatus = null;
    const maybeReady = () => {
      if (!ended && pongSeen && snapshotChecked && !ready) {
        ready = true;
        emit({kind:'ready', listener:doctor.listener, g54:watch.g54, status:readyStatus,
          limitation:'Stock UGS events expose no raw-console stream; resets are detected from controller transitions, observable banner responses and reference changes. Parent must stop workers on watcher failure or unexpected exit.'});
      }
    };
    ws.on('pong',() => { lastPong=Date.now();pongSeen=true;maybeReady(); });
    openedTimer = setTimeout(() => { if (!ready) end(Error('Watcher readiness timeout')); },openTimeoutMs);
    ws.once('open',async () => {
      try {
        if (ended) return;
        ws.ping();
        // Snapshot after listener is attached; no command/serial API is used.
        readyStatus = await request('status/getStatus');
        watch.checkStatus(readyStatus);
        ensure(readyStatus.state === 'IDLE' && readyStatus.feedSpeed === 0, 'Watcher readiness requires Idle');
        watch.checkSettings(await request('settings/getSettings'));
        snapshotChecked=true;maybeReady();
        if (ended) return;
        heartbeat=setInterval(() => {
          if (ended) return;
          if (heartbeatExpired(lastPong,Date.now(),heartbeatTimeoutMs)) return end(Error('Continuity heartbeat lost'));
          try {ws.ping();}catch(e){end(e);}
        },heartbeatMs);
        poller=setInterval(async () => {
          if (ended || polling) return; polling=true;
          try {
            watch.checkStatus(await request('status/getStatus'));
            watch.checkSettings(await request('settings/getSettings'));
          }catch(e){end(e);}finally{polling=false;}
        },pollMs);
      }catch(e){end(e);}
    });
    await finished;
  } catch(e) { end(e); }
  finally {
    clearTimeout(openedTimer);clearInterval(heartbeat);clearInterval(poller);
    stdin.off('end',eof);stdin.off('error',end);stdin.pause();
    process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);
    if (ws && ws.readyState !== 3) {
      await new Promise(resolve => {
        const timer=setTimeout(() => {ws.terminate();resolve();},500);
        ws.once('close',()=>{clearTimeout(timer);resolve();});
        try {ws.close();}catch{ws.terminate();clearTimeout(timer);resolve();}
      });
    }
  }
  return failure ? 1 : 0;
}

async function main() {
  ensure(process.argv.length === 2, 'Usage: node scripts/ugs_map_watch.mjs (parent holds stdin open)');
  // Live read-only startup is only entered when this script is executed, never on import.
  const doctor=JSON.parse(execFileSync('python3',['scripts/ugs_api.py','doctor'],{cwd:ROOT,encoding:'utf8',timeout:20000}));
  const machine=getConfig().machine;
  checkMachineProfile(doctor.settings, machine);
  const firmwareSettings=getConfig().baseline;
  const {default:WebSocketClass}=await import('ws');
  const request=async route => {
    ensure(['status/getStatus','settings/getSettings'].includes(route), 'Read-only route guard');
    const r=await fetch(apiBase+route,{redirect:'error',signal:AbortSignal.timeout(2000)});
    ensure(r.ok,`UGS read HTTP ${r.status}`);return parseEvent(await r.text());
  };
  process.exitCode=await runWatch({WebSocketClass,doctor,firmwareSettings,request});
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e=>{console.log(JSON.stringify({kind:'failure',error:e.message,referenceValid:false}));process.exitCode=1;});
}
