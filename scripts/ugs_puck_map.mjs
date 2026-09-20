#!/usr/bin/env node
import {getConfig, apiBase, socketUrl} from './surface_config.mjs';
/** Supervised UGS puck mapping. Offline plan is the default; never imports a map or changes offsets.
 * Schema v1: see validateConfig. Coordinates are machine mm; output XY uses the verified G54.
 * --execute requires a local interactive terminal and confirmations, not unattended flags.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {checkMachineProfile} from './ugs_machine_profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = apiBase;
const SOCKET = socketUrl;
const WS_LIBRARY = 'ws';
const EPS = 0.005;
const axes = ['x', 'y', 'z'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ensure = (condition, message) => { if (!condition) throw Error(message); };
const near = (a, b, tolerance = EPS) => Math.abs(a - b) <= tolerance + 1e-9;
const norm = s => s.replace(/\s/g, '').toUpperCase();
const fixed = n => n.toFixed(3);
function keys(value, allowed, label) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`);
  ensure(Object.keys(value).every(k => allowed.includes(k)), `${label}: unknown key`);
}
function finite(n, label) { ensure(typeof n === 'number' && Number.isFinite(n), `${label}: finite number required`); return n; }
function precision(n, label) { finite(n, label); ensure(near(n * 1000, Math.round(n * 1000), 1e-6), `${label}: use at most 3 decimals`); return n; }
function xyz(p, label) { keys(p, axes, label); axes.forEach(a => precision(p[a], `${label}.${a}`)); }
function freeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; }

export function validateConfig(input) {
  const c = structuredClone(input);
  keys(c, ['version', 'grid', 'start', 'travelZ', 'envelope', 'expectedG54', 'feeds', 'probe', 'puckHeight', 'outputDir', 'probeMode'], 'config');
  ensure(c.version === 1, 'Expected config version 1');
  xyz(c.start, 'start'); xyz(c.expectedG54, 'expectedG54');
  precision(c.travelZ, 'travelZ'); ensure(c.start.z === c.travelZ, 'start.z must equal travelZ; no startup positioning');
  keys(c.grid, ['x', 'y', 'spacing'], 'grid');
  precision(c.grid.spacing, 'grid.spacing'); ensure(c.grid.spacing >= 0.1, 'Grid spacing must be at least 0.1 mm');
  for (const a of ['x', 'y']) {
    const values = c.grid[a];
    ensure(Array.isArray(values) && values.length >= 2 && values.length <= 100, `grid.${a}: 2–100 ascending coordinates required`);
    values.forEach((v, i) => {
      precision(v, `grid.${a}`);
      if (i) {
        const step = v - values[i - 1];
        ensure(step >= 0.1 && (near(step, c.grid.spacing, 1e-6) || (i === values.length - 1 && step < c.grid.spacing)), `grid.${a}: common spacing, only last interval may be shorter`);
      }
    });
  }
  // Native UGS derives spacing from the first two Y records, not from metadata.
  ensure(near(c.grid.y[1] - c.grid.y[0], c.grid.spacing, 1e-6), 'First Y interval must equal spacing for native UGS import');
  ensure(c.grid.x.length * c.grid.y.length <= 2500, 'Grid too large');
  ensure(c.grid.x.includes(c.start.x) && c.grid.y.includes(c.start.y), 'Start must match a grid point exactly');
  keys(c.envelope, axes, 'envelope');
  for (const a of axes) {
    const range = c.envelope[a];
    ensure(Array.isArray(range) && range.length === 2, `envelope.${a}: [min,max] required`);
    range.forEach(v => precision(v, `envelope.${a}`));
    ensure(range[0] < range[1], `envelope.${a}: invalid limits`);
  }
  c.feeds ??= {}; keys(c.feeds, ['xy', 'z', 'first', 'second'], 'feeds');
  for (const [k, ceiling] of Object.entries({xy: 600, z: 60, first: 50, second: 10})) {
    c.feeds[k] ??= ceiling;
    precision(c.feeds[k], `feeds.${k}`);
    ensure(c.feeds[k] > 0 && c.feeds[k] <= ceiling, `feeds.${k}: must be >0 and <=${ceiling}`);
  }
  c.probe ??= {};
  keys(c.probe, ['firstSearch', 'allowExtendedSearch', 'retract', 'secondSearch', 'repeatTolerance', 'driftTolerance'], 'probe');
  const defaults = {firstSearch: 5, allowExtendedSearch: false, retract: 1, secondSearch: 1.2, repeatTolerance: 0.02, driftTolerance: 0.02};
  for (const [k, v] of Object.entries(defaults)) c.probe[k] ??= v;
  ensure(typeof c.probe.allowExtendedSearch === 'boolean', 'allowExtendedSearch must be boolean');
  for (const k of Object.keys(defaults).filter(k => k !== 'allowExtendedSearch')) precision(c.probe[k], `probe.${k}`);
  ensure(c.probe.firstSearch > 0 && c.probe.firstSearch <= (c.probe.allowExtendedSearch ? 10 : 5), 'First search exceeds explicit limit');
  ensure(c.probe.retract === 1 && c.probe.secondSearch === 1.2, 'Reviewed retract/search are fixed at 1 / 1.2 mm');
  for (const k of ['repeatTolerance', 'driftTolerance']) ensure(c.probe[k] > 0 && c.probe[k] <= 0.02, `${k}: >0 and <=0.02 mm required`);
  c.probeMode ??= 'puck';
  ensure(['puck', 'copper'].includes(c.probeMode), 'Choose puck or copper probing');
  precision(c.puckHeight, 'puckHeight');
  ensure(c.probeMode === 'copper' ? c.puckHeight === 0 : c.puckHeight > 0 && c.puckHeight <= 100, 'Copper requires zero puck height; puck mode requires its measured height');
  ensure(typeof c.outputDir === 'string' && c.outputDir.trim(), 'outputDir required');
  // The second touch may extend 0.2 mm below its first stopped point.
  const zMin = c.travelZ - c.probe.firstSearch - 0.2;
  ensure(zMin >= c.envelope.z[0] - 1e-9 && c.travelZ + 1 <= c.envelope.z[1] + 1e-9, 'Z envelope must contain both probe searches and the 1 mm inter-touch retract');
  for (const a of ['x', 'y']) ensure(c.grid[a][0] >= c.envelope[a][0] && c.grid[a].at(-1) <= c.envelope[a][1], 'Grid outside reviewed envelope');
  return freeze(c);
}

export function planRoute(c) {
  const candidates = [];
  for (const swap of [false, true]) for (const reverseA of [false, true]) for (const reverseB of [false, true]) {
    const a = swap ? 'y' : 'x', b = swap ? 'x' : 'y';
    const av = [...c.grid[a]], bv = [...c.grid[b]];
    if (reverseA) av.reverse(); if (reverseB) bv.reverse();
    let points = bv.flatMap((v, i) => (i % 2 ? [...av].reverse() : av).map(u => ({[a]: u, [b]: v})));
    const index = points.findIndex(p => p.x === c.start.x && p.y === c.start.y);
    points = [...points.slice(index), ...points.slice(0, index)];
    points.push({...points[0]});
    const distance = points.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
    candidates.push({points, distance});
  }
  return freeze(candidates.sort((a, b) => a.distance - b.distance)[0]);
}

export function parseEvent(text) {
  // Only bare absent rotary-axis NaN is tolerated. Do not repair XYZ, Infinity or strings.
  const result = JSON.parse(text.replace(/"([abc])"\s*:\s*NaN(?=\s*[,}])/g, '"$1":null'));
  const check = v => {
    if (!v || typeof v !== 'object') return;
    for (const [k, value] of Object.entries(v)) {
      if (k === 'pins') continue; // Limit-switch x/y/z are booleans, not coordinates.
      if (axes.includes(k)) finite(value, `event.${k}`);
      check(value);
    }
  };
  check(result); return result;
}

export function probeContact(response, start, distance) {
  const matches = [...response.matchAll(/\[PRB:([^,\]]+),([^,\]]+),([^:\]]+):([01])\]/g)];
  ensure(matches.length === 1 && matches[0][4] === '1', 'Expected exactly one fresh successful PRB');
  const p = Object.fromEntries(axes.map((a, i) => [a, Number(matches[0][i + 1])]));
  axes.forEach(a => finite(p[a], `PRB.${a}`));
  ensure(near(p.x, start.x) && near(p.y, start.y) && p.z < start.z - EPS && p.z >= start.z - distance - EPS, 'PRB outside this command bounds');
  return p;
}

export function commandBounds(from, to) {
  return Object.fromEntries(axes.map(a => [a, [Math.min(from[a], to[a]), Math.max(from[a], to[a])]]));
}
export function checkStatus(s, envelope, g54, allowMotion = false, allowJog = false) {
  ensure(s && s.machineCoord?.units === 'MM' && s.workCoord?.units === 'MM', 'Expected MM status');
  ensure(s.spindleSpeed === 0 && Number.isFinite(s.feedSpeed) && s.feedSpeed >= 0, 'Spindle/feed unexpected');
  ensure((allowJog ? ['IDLE', 'JOG'] : allowMotion ? ['IDLE', 'RUN'] : ['IDLE']).includes(s.state), `Unexpected controller state: ${s.state}`);
  if (!allowMotion && !allowJog) ensure(s.feedSpeed === 0, 'Not stopped');
  ensure(!s.fileName && !s.remainingRowCount, 'Active/selected file is forbidden');
  for (const a of axes) {
    finite(s.machineCoord[a], `machine.${a}`); finite(s.workCoord[a], `work.${a}`);
    ensure(s.machineCoord[a] >= envelope[a][0] - EPS && s.machineCoord[a] <= envelope[a][1] + EPS, `Outside ${a} motion bounds`);
    ensure(near(s.machineCoord[a] - s.workCoord[a], g54[a]), `Work offset changed on ${a}`);
  }
}
export function commandDeadline(distance, feed) {
  return Math.ceil(distance / feed * 60000 * 1.5 + 6000);
}

export function parseOffsets(response) {
  const names = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G28', 'G30', 'G92', 'TLO'];
  const found = {};
  for (const name of names) {
    const matches = [...response.matchAll(new RegExp(`\\[${name}:([^\\]]+)\\]`, 'g'))];
    ensure(matches.length === 1, `Missing/duplicate ${name} offset`);
    const values = matches[0][1].split(',').map(Number);
    ensure(values.length === (name === 'TLO' ? 1 : 3) && values.every(Number.isFinite), `Invalid ${name}`);
    found[name] = values;
  }
  ensure(found.G92.every(v => v === 0) && found.TLO[0] === 0, 'G92/TLO must be zero');
  return found;
}
export function checkModes(response) {
  const m = response.match(/\[GC:([^\]]+)\]/);
  ensure(m, 'Missing modal report');
  const tokens = m[1].trim().split(/\s+/);
  // Every move specifies G90; probes and native jogs specify G91.
  // The inherited distance mode therefore does not change the commanded path.
  ensure(tokens.filter(t => t === 'G90' || t === 'G91').length === 1, 'Expected one distance mode G90 or G91');
  for (const token of ['G21', 'G94', 'G54', 'M5']) ensure(tokens.includes(token), `Required mode ${token} not active`);
}
export function checkBaseline(response, baseline) {
  const settings = {};
  for (const line of response.split(/\r?\n/)) {
    const m = line.match(/^\$(\d+)=(.+)$/);
    if (m) { ensure(!(m[1] in settings), 'Duplicate setting'); settings[m[1]] = m[2].trim(); }
  }
  ensure(Object.keys(settings).length === 34 && Object.keys(baseline).length === 34 && Object.entries(baseline).every(([k, v]) => settings[k] === v), 'Firmware settings differ from baseline');
}

/** Input never queues: bytes and partial lines received outside the current prompt are discarded. */
export class InputGate {
  constructor({write = console.log, cancel = () => {}} = {}) { this.write = write; this.cancel = cancel; this.waiter = null; this.buffer = ''; this.closed = false; }
  ask(prompt, expected) {
    ensure(!this.closed && !this.waiter, 'Input closed or prompt already active');
    this.buffer = ''; this.write(prompt);
    return new Promise((resolve, reject) => { this.waiter = {expected, resolve, reject}; });
  }
  feed(chunk) {
    const text = String(chunk);
    if (text.includes('\u0003')) return this.end('SIGINT');
    if (!this.waiter) {
      if (/(^|[\r\n])quit(?:[\r\n]|$)/i.test(text)) return this.end('quit');
      this.write('Input discarded: wait until the next placement prompt.'); return;
    }
    this.buffer += text;
    ensure(this.buffer.length <= 4096, 'Input too long');
    const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop();
    for (const line of lines) {
      const answer = line.trim().toLowerCase();
      if (answer === 'quit') return this.end('quit');
      if (!this.waiter) { this.buffer = ''; continue; }
      if (answer === this.waiter.expected) {
        const w = this.waiter; this.waiter = null; this.buffer = ''; w.resolve(answer);
      } else this.write(`Expected ${this.waiter.expected ? '"' + this.waiter.expected + '"' : 'ENTER'} or "quit".`);
    }
  }
  end(reason = 'EOF') {
    if (this.closed) return;
    this.closed = true; const error = Error(reason);
    this.waiter?.reject(error); this.waiter = null; this.buffer = ''; this.cancel(error);
  }
}

/** Web operator bridge: token stays on pipes/environment, IDs are single-use, no PTY. */
export class JsonInputGate extends InputGate {
  constructor({token, emit = value => console.log(JSON.stringify(value)), cancel = () => {}}) {
    super({write: text => emit({kind: 'message', text}), cancel});
    ensure(typeof token === 'string' && token.length >= 32, 'Web stdio needs a >=32 character per-process token');
    this.token = token; this.emit = emit; this.id = null; this.jsonBuffer = '';
  }
  ask(prompt, expected) {
    ensure(!this.closed && !this.waiter, 'Input closed or prompt already active');
    this.id = randomUUID();
    const promise = new Promise((resolve, reject) => { this.waiter = {expected, resolve, reject}; });
    this.emit({kind: 'prompt', id: this.id, prompt, expected});
    return promise;
  }
  feed(chunk) {
    this.jsonBuffer += String(chunk);
    if (this.jsonBuffer.length > 16384) return this.end('Web input too long');
    const lines = this.jsonBuffer.split('\n'); this.jsonBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.end('Malformed web input'); return; }
      if (!message || message.token !== this.token) { this.end('Web input token mismatch'); return; }
      if (message.kind === 'cancel') { this.end('Web operator cancelled'); return; }
      if (!this.waiter || message.id !== this.id) { this.emit({kind: 'discarded', reason: 'No matching active prompt'}); continue; }
      if (typeof message.answer !== 'string') { this.end('Web answer must be a string'); return; }
      const answer = message.answer.trim().toLowerCase();
      if (answer === 'quit') { this.end('quit'); return; }
      if (answer !== this.waiter.expected) { this.emit({kind: 'rejected', id: this.id, reason: 'Answer does not match prompt'}); continue; }
      const waiter = this.waiter; this.waiter = null; const id = this.id; this.id = null;
      this.emit({kind: 'consumed', id}); waiter.resolve(answer);
    }
  }
}

export class ContactMonitor {
  constructor() { this.open = null; this.stage = 0; }
  observe(pins) {
    if (typeof pins?.probe !== 'boolean') return;
    this.open = !pins.probe;
    if (this.stage === 0 && this.open) this.stage = 1;
    else if (this.stage === 1 && !this.open) this.stage = 2;
    else if (this.stage === 2 && this.open) this.stage = 3;
  }
  requireOpen() { ensure(this.open === true, 'Current probe input is not explicitly open'); }
  requireCycle() { ensure(this.stage === 3, 'Need observed open → actual tool contact → open in this monitor'); this.requireOpen(); }
}

/** Export only full, accepted new measurements plus a passing return reference. */
export function exportMap(c, records) {
  const route = planRoute(c).points;
  ensure(records.length === route.length, 'Incomplete map; raw evidence only');
  records.forEach((r, i) => {
    ensure(r.x === route[i].x && r.y === route[i].y, 'Map point order/membership changed');
    finite(r.contactZ, 'contactZ'); finite(r.spread, 'spread');
    ensure(r.spread >= 0 && r.spread <= c.probe.repeatTolerance + 1e-9, 'Repeat spread exceeds tolerance');
    ensure(r.contactZ < c.travelZ - EPS && r.contactZ >= c.travelZ - c.probe.firstSearch - 0.2 - EPS, 'Map contact outside probe envelope');
  });
  const reference = records[0].contactZ;
  const drift = records.at(-1).contactZ - reference;
  ensure(Math.abs(drift) <= c.probe.driftTolerance + 1e-9, 'Return reference drift exceeds tolerance; map rejected');
  const grid = records.slice(0, -1).sort((a, b) => a.x - b.x || a.y - b.y);
  ensure(new Set(grid.map(p => `${p.x},${p.y}`)).size === c.grid.x.length * c.grid.y.length, 'Missing/duplicate grid points');
  // Six decimals preserve measured differences. Flat maps require the verified native bridge.
  const heights = grid.map(p => Number((p.contactZ - reference).toFixed(6)));

  return {
    xyz: grid.map((p, i) => `${(p.x - c.expectedG54.x).toFixed(6)} ${(p.y - c.expectedG54.y).toFixed(6)} ${heights[i].toFixed(6)}`).join('\n') + '\n',
    flat: Math.max(...heights) === Math.min(...heights), drift, referenceContactZ: reference, requiredG54Z: reference - c.puckHeight,
    datumMatches: near(c.expectedG54.z, reference - c.puckHeight),
    status: 'Measured map accepted numerically; physical observation, work Z datum and UGS import/application require separate verification'
  };
}

export function saveMapHandoff(c, result, write) {
  write('surface.xyz', result.xyz);
  write('ugs-handoff.json', JSON.stringify({version:1,mapFile:'surface.xyz',
    sha256:createHash('sha256').update(result.xyz).digest('hex'),units:'MM',
    coordinates:'G54 work XY, Z relative to reference surface',puckHeight:c.puckHeight,probeMode:c.probeMode||'puck',
    capturedG54:c.expectedG54,requiredG54Z:result.requiredG54Z,
    importedInUgs:false,appliedInUgs:false,
    instructions:['Finish custom probing before opening AutoLeveler.',
      'Prefer verified native map import; flat maps require the native bridge. Never Scan surface with a movable puck.',
      'Use zero probe offsets and zero Z surface for this already normalised map.',
      'Verify the material-top cutting datum and full toolpath coverage in UGS.',
      'Apply height compensation exactly once. Keep connection, tool and workholding unchanged.']},null,2));
}

async function api(route, body) {
  const response = await fetch(BASE + route, {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000)});
  ensure(response.ok, `UGS HTTP ${response.status}`);
  const text = await response.text(); return text ? parseEvent(text) : null;
}

/** Dependency-injected transport is exercised offline by mocks; constructor makes no calls. */
export class Session {
  constructor(config, {request = api, log = () => {}, now = Date.now, pause = sleep} = {}) {
    this.c = config; this.request = request; this.log = log; this.pending = null; this.failure = null;
    this.now = now; this.pause = pause; this.statusRevision = 0; this.lastControllerStatus = null;
    this.hold = {...config.start}; this.contact = new ContactMonitor(); this.outstanding = false; this.resetSent = false;
    this.stopping = null; this.offsets = null; this.ws = null; this.closed = false;
  }
  alive() { if (this.failure) throw this.failure; }
  fail(error) {
    if (!this.failure) { this.failure = error; this.log('failure', {error: String(error), referenceValid: false}); }
    if (this.outstanding && !this.resetSent) {
      this.resetSent = true;
      const native = this.pending?.nativeId;
      this.stopping = (native ? this.request('jogHold/stop', {id:native}) : this.request('machine/softReset'))
        .then(() => this.log(native ? 'jogCancel' : 'softReset', 'Requested once; stopped position must be verified'), e => this.log('stop_failed', String(e)));
    }
  }
  status(s, fromControllerEvent = false) {
    if (s?.state !== 'IDLE' || s?.spindleSpeed !== 0 || s?.feedSpeed > 0) this.outstanding = true;
    checkStatus(s, this.c.envelope, this.c.expectedG54, !!this.pending?.allowRun, !!this.pending?.nativeId);
    checkStatus(s, this.pending?.bounds ?? commandBounds(this.hold, this.hold), this.c.expectedG54, !!this.pending?.allowRun, !!this.pending?.nativeId);
    const before = this.contact.open; this.contact.observe(s.pins);
    if (before !== this.contact.open) this.log('probeInput', this.contact.open ? 'OPEN' : 'CONTACT');
    if (fromControllerEvent) {
      this.statusRevision++;
      this.lastControllerStatus = structuredClone(s);
    }
  }
  event(text) {
    try {
      this.log('event', text); const v = parseEvent(text), e = v.event;
      if (v.eventType === 'ControllerStatusEvent') this.status(e.status, true);
      if (v.eventType === 'ControllerStateEvent') {
        if (!(this.pending?.nativeId ? ['IDLE','JOG'] : ['IDLE','RUN']).includes(e.state) || (e.state === 'RUN' && !this.pending?.allowRun)) {
          this.outstanding = true; throw Error(`Controller state/reference changed: ${e.state}`);
        }
      }
      if (v.eventType === 'CommandEvent') {
        const c = e.command, p = this.pending;
        if (e.commandEventType === 'COMMAND_SENT') {
          if (!p || norm(c.command) !== norm(p.line) || p.sent) { this.outstanding = true; throw Error('Concurrent/unexpected UGS command'); }
          ensure(Number.isInteger(c.id), 'Missing command identity'); p.sent = true; p.id = c.id;
          p.sentStatusRevision = this.statusRevision;
        }
        if (e.commandEventType === 'COMMAND_COMPLETE') {
          ensure(p && p.sent && c.id === p.id && norm(c.command) === norm(p.line) && !p.done, 'Unmatched/stale command completion');
          ensure(c.isOk === true && !c.isError && !c.isSkipped, `UGS command failed: ${c.response}`);
          p.done = c;
        }
      }
    } catch (e) { this.fail(e); }
  }
  async connect(WebSocketClass) {
    const ws = this.ws = new WebSocketClass(SOCKET);
    ws.on('message', data => this.event(String(data)));
    ws.on('error', e => this.fail(e));
    ws.on('close', () => { if (!this.closed) this.fail(Error('WebSocket closed; reference continuity lost')); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('WebSocket open timeout')), 4000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', e => { clearTimeout(timer); reject(e); });
    });
    let pongAt = Date.now(); ws.on('pong', () => { pongAt = Date.now(); });
    this.heartbeat = setInterval(() => {
      if (this.closed || this.failure) return;
      if (Date.now() - pongAt > 12000) return this.fail(Error('WebSocket heartbeat lost'));
      try { ws.ping(); } catch (e) { this.fail(e); }
    }, 4000);
    // Status can be unchanged on WS: REST verifies idle/reference during operator waits.
    this.poller = setInterval(async () => {
      if (this.polling || this.pending || this.failure || this.closed) return;
      this.polling = true;
      try {
        const s = await this.request('status/getStatus');
        if (!this.pending && !this.closed) this.status(s);
        const f = await this.request('files/getFileStatus');
        ensure(!f.fileName && !f.remainingRowCount, 'Selected/active file changed');
      } catch (e) { this.fail(e); } finally { this.polling = false; }
    }, 750);
  }
  async command(line, {target = this.hold, distance = 0, feed = 1, probe = false, probeStopTolerance = 0.1} = {}) {
    this.alive(); ensure(!this.pending, 'Commands must be sequential');
    const motion = distance > 0;
    const start = {...this.hold};
    const p = this.pending = {line, sent: false, done: null, motion, allowRun: motion || /^G4(?: |$)/.test(line), bounds: commandBounds(start, target), contact: null};
    if (motion) this.outstanding = true;
    this.log('command', {line, bounds: p.bounds});
    const deadline = this.now() + (motion ? commandDeadline(distance, feed) : 6000);
    const atEnd = s => s && s.state === 'IDLE' && s.feedSpeed === 0 && (probe
      ? p.contact && near(s.machineCoord.x, p.contact.x) && near(s.machineCoord.y, p.contact.y)
        && s.machineCoord.z <= p.contact.z + EPS && s.machineCoord.z >= p.contact.z - probeStopTolerance - 1e-9
      : axes.every(a => near(s.machineCoord[a], target[a])));
    try {
      await this.request('machine/sendGcode', {commands: line});
      while (this.now() < deadline) {
        this.alive(); const s = await this.request('status/getStatus'); this.status(s); this.log('status', s);
        if (p.done && probe && !p.contact) p.contact = probeContact(p.done.response, start, distance);
        // COMMAND_COMPLETE is GRBL's acknowledgement, not completion of buffered motion.
        // REST is a cached snapshot: an old Idle at the start is neither success nor failure.
        // Require a post-SENT controller status at the endpoint and matching REST readback.
        // Short moves need not expose RUN, but must expose their new stopped coordinates.
        const controller = this.lastControllerStatus;
        const motionFinished = !motion || (this.statusRevision > p.sentStatusRevision && atEnd(controller)
          && axes.every(a => near(s.machineCoord[a], controller.machineCoord[a])));
        if (p.done && atEnd(s) && motionFinished) {
          const result = {response: p.done.response, status: s};
          this.hold = Object.fromEntries(axes.map(a => [a, s.machineCoord[a]]));
          this.pending = null; this.outstanding = false; return result;
        }
        await this.pause(75);
      }
      this.log('commandTimeout', {line, commandId:p.id, sent:p.sent, acknowledged:!!p.done, stage:!p.sent?'not-sent':!p.done?'awaiting-acknowledgement':'awaiting-stopped-position', status:this.lastControllerStatus});
      throw Error(`Command deadline exceeded: ${line}; ${!p.sent?'UGS did not send the command':!p.done?'UGS sent the command but no acknowledgement arrived':'acknowledged; fresh stopped position not verified'}. No retry.`);
    } catch (e) { this.fail(e); throw e; }
  }
  async preflight(baseline) {
    this.status(await this.request('status/getStatus'));
    const file = await this.request('files/getFileStatus'); ensure(!file.fileName && !file.remainingRowCount, 'A file is loaded');
    const firmware = (await this.command('$I')).response;
    ensure(firmware.includes('1.1f.20170801'), 'Unexpected firmware');
    checkBaseline((await this.command('$$')).response, baseline);
    checkModes((await this.command('$G')).response);
    this.offsets = parseOffsets((await this.command('$#')).response);
    ensure(axes.every((a, i) => near(this.offsets.G54[i], this.c.expectedG54[a])), 'G54 does not match config');
    this.log('preflight', {firmware, offsets: this.offsets, settingsMatched: true});
  }
  async verifyReference() {
    checkModes((await this.command('$G')).response);
    ensure(JSON.stringify(parseOffsets((await this.command('$#')).response)) === JSON.stringify(this.offsets), 'Offsets changed');
  }
  async waitOpen() {
    const deadline = Date.now() + 2000;
    while (true) {
      this.alive(); this.status(await this.request('status/getStatus'));
      if (this.contact.open === true) return; // An unchanged explicit value remains valid in this connection.
      ensure(Date.now() < deadline, 'Probe did not release'); await sleep(75);
    }
  }
  async move(target, feed) {
    const distance = Math.hypot(...axes.map(a => target[a] - this.hold[a]));
    ensure(distance > 0, 'Zero-length move');
    for (const a of axes) ensure(target[a] >= this.c.envelope[a][0] && target[a] <= this.c.envelope[a][1], 'Move target outside envelope');
    const work = Object.fromEntries(axes.map(a => [a, target[a] - this.c.expectedG54[a]]));
    await this.command(`G90 G21 G94 G54 G1 X${fixed(work.x)} Y${fixed(work.y)} Z${fixed(work.z)} F${fixed(feed)}`, {target, distance, feed});
  }
  async nativeJog(plan, lease, id) {
    this.alive(); ensure(!this.pending, 'Commands must be sequential');
    if (!lease.active()) return {position:{...this.hold},moved:0,limitReached:false};
    const start={...this.hold}, delta=plan.sign*plan.limit;
    const target={...start,[plan.axis]:start[plan.axis]+delta};
    const line=`$J=G21G91${plan.axis.toUpperCase()}${delta}F${plan.feed}`;
    const p=this.pending={line,sent:false,done:null,nativeId:id,bounds:commandBounds(start,target)};
    this.outstanding=true;
    const deadline=this.now()+commandDeadline(plan.limit,plan.feed);
    let released=false;
    const nativeRequest=async(route,body)=>{
      const result=await this.request(route,body);
      this.log('nativeJog', {route,result});
      return result;
    };
    try {
      await nativeRequest('jogHold/start',{id,axis:plan.axis.toUpperCase(),delta,feed:plan.feed,
        expected:axes.map(a=>start[a]),offset:axes.map(a=>this.c.expectedG54[a])});
      while (this.now()<deadline) {
        this.alive();
        let result;
        if (!lease.active() && !released) {
          released=true;result=await nativeRequest('jogHold/stop',{id});
        } else if (!released) result=await nativeRequest('jogHold/pulse',{id});
        else result=await nativeRequest('jogHold/state?id='+encodeURIComponent(id));
        ensure(result.id===id && !result.error, result.error || 'Unexpected native jog ID');
        const s=await this.request('status/getStatus');this.status(s);this.log('status',s);
        if (result.cancelled && !released) {
          lease.message({id,kind:'release'});released=true;
        }
        // The extension observes every controller report, including unchanged Idle,
        // and requires a fresh stopped report after the correlated $J acknowledgement.
        if (result.finished && p.done && s.state==='IDLE' && s.feedSpeed===0 && axes.every(a=>near(s.machineCoord[a],result.position[a]))) {
          this.hold=Object.fromEntries(axes.map(a=>[a,s.machineCoord[a]]));
          // Jog cancellation clears queues in GRBL/UGS. Keep the stopped point
          // guarded across the cancel/report interval before sending $G or $#.
          // This is a checked quiet interval, never an acknowledgement substitute.
          p.bounds=commandBounds(this.hold,this.hold);
          const quietUntil=this.now()+300;
          do {
            await this.pause(75);this.alive();
            const stopped=await nativeRequest('jogHold/state?id='+encodeURIComponent(id));
            ensure(stopped.id===id && stopped.finished && !stopped.error, stopped.error||'Native jog stop changed during settling');
            const current=await this.request('status/getStatus');this.status(current);
            ensure(current.state==='IDLE' && current.feedSpeed===0 && axes.every(a=>near(current.machineCoord[a],this.hold[a]) && near(stopped.position[a],this.hold[a])),
              'Jog position changed after stopping');
          } while(this.now()<quietUntil);
          this.log('jogSettled', {position:this.hold,quietMs:300});
          this.pending=null;this.outstanding=false;
          const moved=Math.abs(this.hold[plan.axis]-start[plan.axis]);
          return {position:{...this.hold},moved,limitReached:near(moved,plan.limit)};
        }
        await this.pause(100);
      }
      throw Error('Native jog did not report a verified stop before its deadline');
    } catch(e) {this.fail(e);throw e;}
  }
  async touch(distance, feed, stopTolerance) {
    this.contact.requireOpen(); const start = {...this.hold};
    const target = {...start, z: start.z - distance};
    ensure(target.z >= this.c.envelope.z[0], 'Probe target outside Z envelope');
    const r = await this.command(`G91 G21 G94 G38.2 Z-${fixed(distance)} F${fixed(feed)}`, {target, distance, feed, probe: true, probeStopTolerance: stopTolerance});
    const contact = probeContact(r.response, start, distance);
    this.contact.open = false; // Fresh successful PRB establishes contact; require subsequent explicit release.
    ensure(Math.abs(r.status.machineCoord.z - contact.z) <= stopTolerance && r.status.machineCoord.z <= contact.z + EPS, 'Unexpected contact stopping distance');
    this.log('touch', {start, contact, stopped: r.status.machineCoord, stopTolerance});
    return contact;
  }
  async measure(point) {
    this.alive(); ensure(near(this.hold.x, point.x) && near(this.hold.y, point.y) && near(this.hold.z, this.c.travelZ), 'Not at expected placement point');
    await this.verifyReference(); this.contact.requireOpen();
    const first = await this.touch(this.c.probe.firstSearch, this.c.feeds.first, 0.1);
    await this.move({...this.hold, z: this.hold.z + 1}, this.c.feeds.z);
    await this.command('G4 P1'); await this.waitOpen();
    const second = await this.touch(1.2, this.c.feeds.second, 0.05);
    const spread = Math.abs(first.z - second.z);
    ensure(spread <= this.c.probe.repeatTolerance + 1e-9, 'Repeat spread exceeds tolerance');
    ensure(this.hold.z < this.c.travelZ, 'Invalid return lift');
    await this.move({...this.hold, z: this.c.travelZ}, this.c.feeds.z);
    await this.waitOpen(); await this.verifyReference();
    const record = {x: point.x, y: point.y, contactZ: second.z, spread, first, second, utc: new Date().toISOString()};
    this.log('measurement', record); return record;
  }
  async close() {
    this.closed = true; clearInterval(this.heartbeat); clearInterval(this.poller);
    await this.stopping;
    if (this.ws) {
      const ws = this.ws;
      await new Promise(resolve => {
        if (ws.readyState === 3) return resolve();
        const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
        ws.once('close', () => { clearTimeout(timer); resolve(); }); ws.close();
      });
    }
  }
}

const COPPER_STARTUP = `Copper scan setup — no movement yet:
- Spindle off, operator at physical stop; no other sender controls in use.
- Blank continuous copper secured; leads connect the cutter and this SAME copper face.
- The puck is removed. Copper contact uses zero puck offset.
- Review the complete grid and fixed travel Z, clip/clamp clearance and cable slack.
- Every first search is bounded; the entire surface must lie within that search envelope.
- AutoLeveler is CLOSED and no cutting file is selected in UGS.
- Continuity and one explicit start confirmation precede automatic two-touch scanning.
Type "confirm startup" to attest all items, or quit.`;

const STARTUP = `Physical startup confirmation (no movement yet):
- Main power on; spindle stationary; operator at physical stop; offline keypad disconnected.
- Same conductive tool and configured puck, no damage or unresolved motion hold; stock secured.
- AutoLeveler tab CLOSED; no other UGS controls, senders or helpers will be used.
- The displayed immutable grid/envelope is physically reachable, fully supported and authorised.
- Current tip is exactly at configured start/travelZ; no startup positioning is permitted.
- Fixed travelZ clears stationary puck, stock and ALL clamps across EVERY route segment;
  upward headroom covers inter-touch retract; attached clip lead has slack throughout.
- Leave puck stationary and keep hands clear until probe, retract AND automatic traverse stop.
- Each ENTER confirms flat puck under tip and actual gap smaller than the announced search.
- Failure may request one reviewed softReset if motion is outstanding: reference then invalid.
Type "confirm startup" to attest ALL items, or quit.`;

export async function measureRoute(session, c, route, gate, {log=()=>{}, say=()=>{}, emit=()=>{}}={}) {
  const records=[];
  if (c.probeMode === 'copper') {
    await gate.ask(`Start the complete copper scan: ${route.points.length} measurements including the return check. The entire grid is continuous conductive copper connected to the probe circuit. Every point has a gap below ${c.probe.firstSearch} mm and the reviewed travel Z clears stock, clips and clamps. Hands clear; remain at Stop. Type "start copper scan".`, 'start copper scan');
    session.alive(); log('operator', {action:'start copper scan', points:route.points.length});
  }
  for (let i = 0; i < route.points.length; i++) {
      const point = route.points[i]; const waitStart = Date.now();
      emit({kind:'point',index:i+1,total:route.points.length,point});
      if (c.probeMode !== 'copper') await gate.ask(`Point ${i + 1}/${route.points.length} (${point.x}, ${point.y})${i === route.points.length - 1 ? ' RETURN REFERENCE' : ''}: puck flat, tip centred, gap <${c.probe.firstSearch} mm. Hands clear until next stop. ENTER: first ≤${c.probe.firstSearch} mm/F${c.feeds.first}, retract 1/F${c.feeds.z}, second ≤1.2/F${c.feeds.second}, lift to MZ ${c.travelZ}, automatic XY/F${c.feeds.xy}.`, '');
      log('operator', {action: c.probeMode === 'copper' ? 'approved copper route' : 'ENTER', point, waitMs: Date.now() - waitStart});
      const began = Date.now(); records.push(await session.measure(point)); log('probeDurationMs', Date.now() - began);
      emit({kind:'measurement',record:records.at(-1)});
      say(`Recorded ${records.at(-1).contactZ.toFixed(3)} mm; repeat spread ${records.at(-1).spread.toFixed(3)} mm.`);
      if (i + 1 < route.points.length) {
        const next = route.points[i + 1]; say(`Automatically moving to (${next.x}, ${next.y}); keep hands/puck stationary.`);
        const travelStart = Date.now(); await session.move({...next, z: c.travelZ}, c.feeds.xy); log('travelDurationMs', Date.now() - travelStart);
      }
    }
  return records;
}

export async function main(argv = process.argv.slice(2)) {
  const web = argv.includes('--web-stdio');
  const say = text => console.log(web ? JSON.stringify({kind: 'message', text}) : text);
  if (web) ensure(argv.includes('--execute') && typeof process.env.UGS_MAP_WEB_TOKEN === 'string' && process.env.UGS_MAP_WEB_TOKEN.length >= 32, '--web-stdio requires --execute and per-process UGS_MAP_WEB_TOKEN');
  ensure(argv.includes('--config') && argv.indexOf('--config') + 1 < argv.length, 'Usage: node scripts/ugs_puck_map.mjs --config FILE [--execute [--web-stdio]]');
  const configPath = argv[argv.indexOf('--config') + 1];
  ensure(argv.length === (web ? 4 : argv.includes('--execute') ? 3 : 2) && argv[0] === '--config' && (!argv.includes('--execute') || argv[2] === '--execute') && (!web || argv[3] === '--web-stdio'), 'Use --config FILE [--execute [--web-stdio]]');
  const c = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))), route = planRoute(c);
  console.log(JSON.stringify({kind: 'plan', mode: argv.includes('--execute') ? 'EXECUTE requested, not yet armed' : 'OFFLINE PLAN', config: c, route,
    note: (c.probeMode === 'copper' ? 'No initial positioning. One full-route approval; automatic two-touch contacts, lift and traverse. ' : 'No initial positioning. Each ENTER: two touches, lift to travelZ, record, automatically move to next point. Final point repeats reference. Offsets preserved; map import/datum separate.')}, null, web ? undefined : 2));
  if (!argv.includes('--execute')) return;
  ensure(web || (process.stdin.isTTY && process.stdout.isTTY), 'Execution requires a local interactive terminal');
  const outputRoot = path.resolve(ROOT, c.outputDir); fs.mkdirSync(outputRoot, {recursive: true});
  const dir = path.join(outputRoot, `ugs-puck-map-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  fs.mkdirSync(dir);
  const write = (file, data) => fs.writeFileSync(path.join(dir, file), data, {flag: 'wx'});
  write('config.json', JSON.stringify(c, null, 2)); write('runner.mjs', fs.readFileSync(fileURLToPath(import.meta.url)));
  const log = (kind, data) => {
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({utc: new Date().toISOString(), kind, data}) + '\n');
    if (kind === 'probeInput') say('Probe: ' + data);
    if (web && kind === 'status') console.log(JSON.stringify({kind:'status',status:data}));
  };
  const session = new Session(c, {log});
  const gate = web
    ? new JsonInputGate({token: process.env.UGS_MAP_WEB_TOKEN, cancel: e => session.fail(e)})
    : new InputGate({cancel: e => session.fail(e)});
  const onData = chunk => { try { gate.feed(chunk); } catch (e) { gate.end(e.message); } };
  const onEnd = () => gate.end('EOF'); const onInterrupt = () => gate.end('SIGINT'); const onTerm = () => gate.end('SIGTERM');
  process.stdin.setEncoding('utf8'); process.stdin.on('data', onData); process.stdin.on('end', onEnd);
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerm);
  const failureWatch = setInterval(() => { if (session.failure && !gate.closed) gate.end(session.failure.message); }, 100);
  const records = []; let complete = false;
  try {
    await gate.ask(c.probeMode === 'copper' ? COPPER_STARTUP : STARTUP, 'confirm startup'); log('operator', 'All startup confirmations attested');
    if (c.probe.firstSearch > 5) {
      await gate.ask(`Extended ${c.probe.firstSearch} mm descent explicitly configured. Confirm actual gap, search envelope and no intervening obstacle: type "confirm extended search".`, 'confirm extended search');
      log('operator', 'Extended search explicitly confirmed');
    }
  execFileSync(process.env.PYTHON || 'python3', ['scripts/surface_config.py'], {cwd: ROOT});
  ensure(c.probeMode === 'copper' ? c.puckHeight === 0 : c.puckHeight === getConfig().puckHeight, 'Plan puck height differs from machine configuration');
    const doctor = JSON.parse(execFileSync('python3', ['scripts/ugs_api.py', 'doctor'], {cwd: ROOT, encoding: 'utf8', timeout: 15000}));
    log('doctor', doctor);
    ensure(!doctor.file.fileName && !doctor.file.remainingRowCount, 'Doctor: file loaded');
    const machine = getConfig().machine;
    checkMachineProfile(doctor.settings, machine);
    checkStatus(doctor.status, commandBounds(c.start, c.start), c.expectedG54);
    session.alive();
    const {default: WebSocketClass} = await import(WS_LIBRARY);
    await session.connect(WebSocketClass);
    const baseline = getConfig().baseline;
    await session.preflight(baseline);
    await gate.ask(c.probeMode === 'copper' ? 'Verify the actual cutter-to-copper circuit without axis movement: touch and release a loose copper test piece connected to the same copper face against the stationary tool tip, then remove it from the route. Confirm open/contact/open, intact continuous copper across the entire grid and both leads secured. Type "contact ready".' : 'Monitor active. Gently touch puck metal to stationary TOOL TIP and release TWICE, then replace flat: monitor must observe OPEN → CONTACT → OPEN (initial state may be unknown). Confirm undamaged tool/puck and actual contact by typing "contact ready".', 'contact ready');
    session.alive(); session.contact.requireCycle(); log('operator', 'Manual tool-tip contact/release confirmed');
    records.push(...await measureRoute(session,c,route,gate,{log,say,emit:event=>{if(web)console.log(JSON.stringify(event));}}));
    await session.verifyReference(); session.alive();
    const result = exportMap(c, records);
    // Numerical acceptance is separate from physical observation and later UGS import.
    await gate.ask('All points and return check recorded. Confirm every contact/lift/traverse looked normal and setup stayed unchanged: type "accept observations" (otherwise quit; raw evidence only).', 'accept observations');
    session.alive(); await session.verifyReference(); session.alive();
    write('result.json', JSON.stringify({...result, xyz: undefined, records, physicalObservationConfirmed: true, offsetsPreserved: true, appliedInUgs: false}, null, 2));
    saveMapHandoff(c, result, write);
    complete = true;
    if (web) console.log(JSON.stringify({kind:'result',path:path.join(dir,'surface.xyz'),summary:{...result,xyz:undefined}}));
    say(`Saved ${path.join(dir, 'surface.xyz')}\nReturn drift ${fixed(result.drift)} mm. Offsets preserved. Required material-top G54 Z: ${fixed(result.requiredG54Z)}; current ${fixed(c.expectedG54.z)}. Verify datum and native UGS import separately with probe offsets and Z surface zero. Never apply compensation twice.`);
  } catch (e) {
    if (web) console.log(JSON.stringify({kind:'failure',error:e.message}));
    session.fail(e); console.error(`STOP: ${e.message}. Reference invalid; no retry/recovery. If movement persists, use the physical stop. Raw evidence: ${dir}`);
    process.exitCode = 1;
  } finally {
    if (!complete) write('incomplete.json', JSON.stringify({records, referenceValid: false, error: String(session.failure), xyzExported: false}, null, 2));
    clearInterval(failureWatch); await session.close();
    process.stdin.off('data', onData); process.stdin.off('end', onEnd); process.stdin.pause();
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerm);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
