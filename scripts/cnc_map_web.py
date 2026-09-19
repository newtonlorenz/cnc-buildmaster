#!/usr/bin/env python3
"""Local supervised UGS mapping UI. --demo never contacts UGS or exports measurements."""
import argparse
import base64
import copy
from collections import deque
import json
import os
from pathlib import Path
import secrets
import signal
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer

from cnc_map_terminal import ROOT, CORNERS, snapshot, position, make_config, save_plan, positioning_rectangle, finite
from cnc_map_support import fault_details, scan_route, corner_issue
from pcb_workspace import Workspace
from surface_config import load_config

ASSETS = Path(__file__).with_name('cnc-map-web')


class Controller:
    def __init__(self, demo=False):
        self.demo = demo
        self.profile = load_config(demo=demo)
        self.lock = threading.Lock()
        self.action_lock = threading.Lock()
        self.pcb_lock = threading.RLock()
        self.pcb = Workspace()
        self.jobs_dir = Path(self.profile['dataDir'])/'jobs'
        if not demo:
            self.jobs_dir.parent.mkdir(parents=True, exist_ok=True)
        self.child = None
        self.monitor = None
        self.monitor_thread = None
        self.monitor_closing = False
        self.token = secrets.token_urlsafe(32)
        self.owner = None
        self.last_seen = 0
        self.data = dict(demo=demo, armed=False, busy=False, phase='setup', corners=[], plan=None,
                         prompt=None, logs=[], error=None, status=None, result=None, measurements=[], currentPoint=None)
        self.snapshots = {}
        self.plan_path = None
        self.stopped = False
        self.closed = False
        self.demo_position = dict(x=0., y=0., z=0.)
        self.expected = None
        self.hold_id = None
        self.hold_released = True
        self.hold_at = 0
        self.released_holds = deque(maxlen=256)
        limits = self.profile['baseline']
        maxima = {axis: float(limits[str(key)]) for axis,key in zip('xyz',(110,111,112))}
        self.speeds = {name: {a: min(maxima[a], rate[i]) for i,a in enumerate('xyz')} for name,rate in
                       {'slow': (100,100,10), 'normal': (600,600,60), 'fast': (1000,1000,100), 'maximum': (maxima['x'],maxima['y'],maxima['z'])}.items()}
        self.data.update(speeds=self.speeds, hold=None, nativeJog=demo, area=None,
                         configuration={'name': self.profile['name'], 'puckHeight': self.profile['puckHeight'], 'ugsPort': self.profile['ugsPort'], 'feeds': self.profile['feeds']}, apiVersion=3, sessionId=secrets.token_hex(16), fault=None, diagnostics=None,
                         geometryIssue=None, route=None, planId=None, scanStarted=None)
        threading.Thread(target=self.watchdog, daemon=True).start()

    def log(self, message):
        with self.lock:
            entry=time.strftime('%H:%M:%S')+' '+str(message)
            self.data['logs'] = (self.data['logs'] + [entry])[-150:]
            print(entry, flush=True)

    def state(self):
        with self.lock:
            data = copy.deepcopy(self.data)
            data['canStartFresh'] = self.can_start_fresh()
        with self.pcb_lock:
            data['pcbRevision'] = self.pcb.revision
        return data

    def pcb_state(self):
        with self.pcb_lock:
            data = self.pcb.public(self.data['sessionId'])
            data['savedJobs'] = [] if self.demo else [
                {'id': p.name, 'label': p.stem.replace('.pcb-job', '')}
                for p in sorted(self.jobs_dir.glob('*.pcb-job.json'), reverse=True)[:50]
                if p.is_file() and not p.is_symlink()]
            return data

    def save_pcb_package(self, recovery=False):
        package = self.pcb.package(self.data['sessionId'])
        if self.demo:
            return {'package': package, 'savedPath': None}
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        slug = re.sub('[^a-zA-Z0-9]+', '-', self.pcb.name).strip('-')[:40] or 'pcb'
        filename = time.strftime('%Y%m%dT%H%M%S')+'-'+('recovery-' if recovery else '')+slug+'-'+secrets.token_hex(4)+'.pcb-job.json'
        path = self.jobs_dir/filename
        with path.open('x') as f:
            json.dump(package, f, indent=2)
        if not recovery:
            self.pcb.last_saved = str(path); self.pcb.changed()
        return {'package': package, 'savedPath': str(path)}

    def replace_pcb(self, candidate):
        if self.pcb.operations:
            self.save_pcb_package(recovery=True)
        candidate.revision = self.pcb.revision+1
        self.pcb = candidate

    def perform_pcb(self, action, body):
        if self.data['busy']:
            raise ValueError('Wait for the current machine operation before editing the PCB job')
        with self.pcb_lock:
            if body.get('pcbRevision') != self.pcb.revision:
                raise ValueError('The PCB job changed. Review the current preview and try again.')
        live = action in ('pcb-capture', 'pcb-stock-from-area', 'pcb-export')
        s = None
        if live:
            if self.stopped or not self.data['armed'] or self.data['phase'] != 'teach':
                raise ValueError('Enable teaching with a fresh setup before using machine references')
            s = self.checked()
        with self.pcb_lock:
            if live and self.stopped:
                raise ValueError('Machine session stopped')
            if action == 'pcb-import':
                self.pcb.import_files(body.get('files'))
            elif action == 'pcb-configure':
                self.pcb.configure(body.get('settings'))
            elif action == 'pcb-operation':
                self.pcb.operation(body)
            elif action == 'pcb-reference':
                self.pcb.reference(body.get('label'), body.get('design'), body.get('machine'))
            elif action == 'pcb-capture':
                m, _ = position(s)
                self.pcb.reference(body.get('label'), body.get('design'), [m['x'], m['y']], self.data['sessionId'])
            elif action == 'pcb-solve':
                self.pcb.solve(self.data['sessionId'])
            elif action == 'pcb-stock-from-area':
                area = positioning_rectangle(self.snapshots)
                self.pcb.stock.update(x=area['x'][0], y=area['y'][0], width=area['x'][1]-area['x'][0], height=area['y'][1]-area['y'][0])
                self.pcb.invalidate('Using the taught rectangle as usable stock. Check its inset and margin.')
            elif action == 'pcb-new':
                self.replace_pcb(Workspace())
            elif action == 'pcb-load':
                package = body.get('package')
                if 'savedId' in body:
                    name = body['savedId']
                    if self.demo or not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.pcb-job\.json', name):
                        raise ValueError('Invalid saved job')
                    path = self.jobs_dir/name
                    if path.is_symlink() or path.stat().st_size > 24_000_000:
                        raise ValueError('Saved job is unavailable or too large')
                    package = json.loads(path.read_text())
                candidate = Workspace.from_package(package)
                self.replace_pcb(candidate)
            elif action == 'pcb-example':
                base = ROOT/'examples'
                candidate = Workspace()
                names = ['rectangle.nc']
                candidate.import_files([{'name': name, 'source': (base/name).read_text()} for name in names])
                candidate.name = 'Rectangle example'; candidate.board_revision = 'example-1'
                candidate.note = 'Synthetic geometry for preview. No physical process qualification.'
                self.replace_pcb(candidate)
            elif action == 'pcb-save':
                return self.save_pcb_package()
            elif action == 'pcb-export':
                if body.get('reviewed') is not True:
                    raise ValueError('Review the stock, cutter, orientation and draft-export checks')
                _, offset = position(s)
                data = self.pcb.export(self.data['sessionId'], offset, self.demo)
                if self.stopped: raise ValueError('Session stopped while preparing the draft')
                return {'archive': base64.b64encode(data).decode(), 'filename': 'pcb-aligned-draft.zip'}
            else:
                raise ValueError('Unknown PCB action')

    def can_start_fresh(self):
        return (self.data['phase'] in ('stopped', 'complete') and not self.data['busy']
                and not self.action_lock.locked()
                and not (self.child and self.child.poll() is None)
                and not (self.monitor and self.monitor.poll() is None)
                and not (self.monitor_thread and self.monitor_thread.is_alive()))

    def invalidate_plan(self):
        self.data.update(plan=None, route=None, planId=None)
        self.plan_path = None

    def diagnostics(self):
        checks = []
        def add(label, ok, detail):
            checks.append(dict(label=label, ok=ok, detail=detail))
        try:
            s = self.read_machine()
            status = s['status']
            add('Connection', True, 'Demo · no machine access' if self.demo else f"UGS PID {s['listener']['pid']}")
            idle = status['state'] == 'IDLE' and status['feedSpeed'] == 0 and status['spindleSpeed'] == 0
            add('Controller', idle, f"{status['state']} · feed {status['feedSpeed']} · spindle {status['spindleSpeed']}")
            add('Selected job', not bool(s['file'].get('fileName') or s['file'].get('remainingRowCount')), s['file'].get('fileName') or 'No file selected')
            if not self.demo:
                from ugs_api import read
                settings = s['settings']
                machine = self.profile['machine']
                expected_port = machine['connection']['port']
                port = settings['port']
                port_ok = port == expected_port or ('/dev/'+port == expected_port)
                profile_ok = port_ok and str(settings['portRate']) == str(machine['connection']['baud']) and settings['firmwareVersion'] == machine['sender_defaults']['firmware'] and settings['preferredUnits'] == 'MM'
                add('Machine profile', profile_ok, f"{port} · {settings['portRate']} · {settings['firmwareVersion']} · {settings['preferredUnits']}")
                try:
                    cap = read('jogHold/capabilities')
                    native = cap.get('protocol') == 1 and cap.get('nativeJog') is True
                except Exception:
                    native = False
            else:
                native = True
            add('Smooth Hold', native, 'Native jog available' if native else 'Extension not loaded; single steps only')
            add('Surface reference', None, 'A connection check does not establish material Z zero. Fresh probing is still required.')
        except Exception as e:
            add('Connection', False, str(e))
        self.data['diagnostics'] = dict(checkedAt=time.strftime('%Y-%m-%d %H:%M:%S'), checks=checks)
        return self.data['diagnostics']

    def read_machine(self):
        if self.demo:
            m = dict(self.demo_position, units='MM')
            return dict(listener={'pid': -1, 'listen': 'DEMO'}, file={'fileName': ''},
                        status=dict(state='IDLE', spindleSpeed=0, feedSpeed=0, machineCoord=m, workCoord=m.copy()))
        return snapshot()

    def checked(self):
        try:
            s = self.read_machine(); m, offset = position(s)
            if self.expected:
                old, old_offset = position(self.expected)
                if s['listener'] != self.expected['listener'] or offset != old_offset or any(abs(m[a]-old[a]) > .005 for a in 'xyz'):
                    raise ValueError('Machine position or reference changed outside this interface. Stop and start a fresh setup.')
        except Exception as e:
            if self.data['armed']:
                self.stop(str(e))
            raise
        self.data['status'] = s['status']
        return s

    def start_monitor(self):
        if self.demo:
            return
        ready = threading.Event()
        self.monitor_closing = False
        self.monitor = subprocess.Popen(['node', str(ROOT/'scripts/ugs_map_watch.mjs')], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        monitor = self.monitor
        def watch():
            try:
                for line in monitor.stdout:
                    self.log('Connection monitor: '+line.rstrip())
                    try:
                        event = json.loads(line)
                    except ValueError:
                        self.stop('Invalid connection-monitor response'); break
                    if event.get('kind') == 'failure':
                        self.stop(event.get('error', 'Connection monitor failed')); break
                    if event.get('kind') == 'ready':
                        _, offset = position(self.expected)
                        if event.get('listener') != self.expected['listener'] or any(abs(event['g54'][a]-offset[a]) > .005 for a in 'xyz'):
                            self.stop('Connection changed while starting monitor'); break
                        ready.set()
            except Exception as e:
                if not self.monitor_closing:
                    self.stop('Connection monitor error: '+str(e))
            finally:
                if not self.monitor_closing:
                    self.stop('Connection monitor exited; reference invalidated')
                ready.set()
                monitor.stdout.close()
        self.monitor_thread = threading.Thread(target=watch, daemon=True)
        self.monitor_thread.start()
        if not ready.wait(timeout=25):
            self.stop('Connection-monitor startup timed out')
        if self.stopped or monitor.poll() is not None:
            raise ValueError('Continuous UGS monitoring could not start')

    def close_monitor(self):
        self.monitor_closing = True
        monitor = self.monitor
        if monitor and monitor.poll() is None:
            try: monitor.send_signal(signal.SIGTERM)
            except ProcessLookupError: pass
        if monitor and monitor.stdin and not monitor.stdin.closed:
            monitor.stdin.close()

    def stop(self, reason='Operator pressed Stop'):
        with self.lock:
            # Preserve the first cause; worker shutdown errors are secondary evidence.
            first = not self.stopped
            self.stopped = True
            self.data.update(armed=False, prompt=None, phase='stopped')
            if first:
                self.data.update(error=reason, fault=fault_details(reason))
            child = self.child
        if child and child.poll() is None:
            try: child.send_signal(signal.SIGTERM)
            except ProcessLookupError: pass
        self.close_monitor()
        if first:
            with self.pcb_lock:
                self.pcb.invalidate('Machine session stopped. Teach fresh references before exporting.')
            self.log(reason + '. Use the physical stop if motion persists. Start a fresh setup after inspection; no automatic retry.')

    def watchdog(self):
        while not self.closed:
            time.sleep(.25)
            if self.data['armed'] and time.monotonic()-self.last_seen > 3:
                self.stop('Browser heartbeat lost; setup invalidated')

    def authenticate(self, token, owner):
        if not secrets.compare_digest(token or '', self.token) or not owner or len(owner) > 128:
            raise PermissionError('Invalid local session')
        with self.lock:
            if self.owner is None:
                self.owner = owner
            if owner != self.owner:
                raise PermissionError('Another tab owns this session; use the original tab')
            self.last_seen = time.monotonic()

    def launch(self, command, stdin=None, scan=False):
        env = dict(os.environ, UGS_MAP_WEB_TOKEN=self.token)
        failure_reason = None
        last_diagnostic = None
        with self.lock:
            if self.stopped:
                raise ValueError('Session stopped; start a fresh setup after inspection')
            self.child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                          text=True, bufsize=1)
            child = self.child
            if stdin is not None:
                if stdin.get('mode') == 'hold':
                    stdin = {**stdin, 'at': self.hold_at, 'released': self.hold_released}
                child.stdin.write(json.dumps(stdin)+'\n'); child.stdin.flush()
        try:
            for line in child.stdout:
                line = line.rstrip()
                try:
                    event = json.loads(line)
                except ValueError:
                    if line: last_diagnostic = line
                    self.log(line); continue
                if isinstance(event, dict):
                    kind=event.get('kind')
                    if kind == 'message': self.log(event.get('text',''))
                    elif kind == 'status': self.data['status']=event['status']
                    elif kind == 'point': self.data['currentPoint']=event
                    elif kind == 'measurement': self.data['measurements'].append(event['record'])
                    elif kind == 'result': self.data['result']=event
                    elif kind == 'failure':
                        failure_reason = str(event.get('error', 'Runner failed'))
                        self.log(failure_reason)
                    elif kind == 'prompt': self.log(event.get('prompt',''))
                    elif kind not in ('plan','consumed'): self.log(line)
                if isinstance(event, dict) and event.get('kind') == 'prompt':
                    with self.lock:
                        if not self.stopped:
                            self.data['prompt'] = event
            code = child.wait()
            if code:
                raise ValueError(failure_reason or last_diagnostic or f'Monitored operation stopped (exit {code}); inspect the event log')
        finally:
            if child.stdin and not child.stdin.closed:
                child.stdin.close()
            child.stdout.close()
            with self.lock:
                self.child = None
        if self.stopped:
            raise ValueError('Session stopped; reference must be checked again')

    def hold_control(self, action, body):
        hold_id=body.get('id')
        if not isinstance(hold_id,str) or not 8 <= len(hold_id) <= 80:
            raise ValueError('Invalid hold ID')
        with self.lock:
            if action == 'jog-release':
                self.released_holds.append(hold_id)
            if hold_id != self.hold_id or self.stopped:
                return
            if action == 'jog-release':
                self.hold_released=True
            elif self.hold_released or time.time()*1000-self.hold_at > 500:
                self.hold_released=True
                return
            else:
                self.hold_at=time.time()*1000
            message=dict(id=hold_id,kind='release' if self.hold_released else 'pulse',at=self.hold_at)
            if self.child and self.child.poll() is None:
                self.child.stdin.write(json.dumps(message)+'\n');self.child.stdin.flush()

    def perform(self, action, body, session_id=None):
        if not isinstance(body, dict):
            raise ValueError('Expected a JSON object')
        if action == 'stop':
            self.stop(); return
        if session_id is not None and session_id != self.data['sessionId']:
            raise ValueError('This request belongs to an old setup. Refresh the page.')
        if action in ('jog-pulse','jog-release'):
            self.hold_control(action,body); return
        if action == 'reply':
            with self.lock:
                p = self.data['prompt']
                if self.stopped or not p or body.get('id') != p['id'] or body.get('answer') != p['expected']:
                    raise ValueError('Stale or invalid readiness action')
                self.data['prompt'] = None
                if not self.demo:
                    if not self.child or self.child.poll() is not None:
                        raise ValueError('Runner is not waiting')
                    self.child.stdin.write(json.dumps(dict(id=p['id'], answer=body['answer'], token=self.token))+'\n')
                    self.child.stdin.flush()
            if self.demo:
                self.demo_next()
            return
        if not self.action_lock.acquire(blocking=False):
            raise ValueError('An operation is already in progress')
        try:
            if session_id is not None and session_id != self.data['sessionId']:
                raise ValueError('This request belongs to an old setup. Refresh the page.')
            if action.startswith('pcb-'):
                return self.perform_pcb(action, body)
            if action == 'new-session':
                if (self.data['phase'] not in ('stopped', 'complete') or self.data['busy']
                    or (self.child and self.child.poll() is None)
                    or (self.monitor and self.monitor.poll() is None)
                    or (self.monitor_thread and self.monitor_thread.is_alive())):
                    raise ValueError('Wait for all workers to stop before starting a fresh setup')
                self.snapshots = {}; self.expected = None; self.plan_path = None
                self.child = None; self.monitor = None; self.monitor_thread = None
                self.hold_id = None; self.hold_released = True
                self.stopped = False
                with self.pcb_lock:
                    self.pcb.invalidate('New machine setup. Saved job remains; machine references were discarded.')
                self.data.update(armed=False, busy=False, phase='setup', sessionId=secrets.token_hex(16),
                                 corners=[], plan=None, route=None, planId=None, area=None, geometryIssue=None,
                                 prompt=None, status=None, result=None, measurements=[], currentPoint=None,
                                 error=None, fault=None, diagnostics=None, hold=None, scanStarted=None)
                self.log('Fresh setup opened. Previous coordinates were discarded; teaching is not enabled.')
                return
            if action == 'diagnostics':
                if self.data['busy']: raise ValueError('Wait for the current operation before checking the connection')
                return self.diagnostics()
            if self.stopped:
                raise ValueError('Session stopped. Start a fresh setup after inspection.')
            if self.data['busy']:
                raise ValueError('Wait for the current operation')
            if action == 'arm':
                if self.data['phase'] != 'setup':
                    raise ValueError('Session already started')
                if body.get('confirmed') is not True:
                    raise ValueError('Confirm physical setup first')
                try:
                    if self.demo:
                        self.expected=self.checked()
                    else:
                        self.log('Waiting for UGS status to match the controller’s actual work reference…')
                        result=subprocess.run(['node',str(ROOT/'scripts/ugs_map_reference.mjs')],cwd=ROOT,text=True,capture_output=True,timeout=20)
                        if result.returncode:
                            raise ValueError(result.stderr.strip() or 'UGS reference check failed')
                        self.expected=json.loads(result.stdout)
                        self.data['status']=self.expected['status']
                    if self.stopped:
                        raise ValueError('Session stopped during startup')
                    self.start_monitor()
                    self.expected = self.checked()
                except Exception as e:
                    self.stop(str(e))
                    raise
                if not self.demo:
                    from ugs_api import read
                    try:
                        capability=read('jogHold/capabilities')
                        self.data['nativeJog']=capability.get('protocol')==1 and capability.get('nativeJog') is True
                    except Exception:
                        self.data['nativeJog']=False
                with self.lock:
                    can_arm=not self.stopped and time.monotonic()-self.last_seen <= 3
                    if can_arm:
                        self.data.update(armed=True, phase='teach')
                if not can_arm:
                    self.stop('Browser connection lost during startup')
                    raise ValueError('Session stopped or browser connection lost during startup')
                return
            if not self.data['armed']:
                raise ValueError('Review and enable teaching first')
            if action in ('jog','jog-hold'):
                if self.data['phase'] != 'teach':
                    raise ValueError('Jogging locked during a scan')
                axis, delta = body.get('axis'), body.get('delta')
                held=action == 'jog-hold'
                if held and not self.data['nativeJog']:
                    raise ValueError('Smooth hold requires the prepared UGS extension and an UGS restart')
                allowed_steps=(1,) if held else (.1,1,5,10,25,50)
                if not isinstance(axis,str) or axis not in ('x','y','z') or type(delta) not in (float,int) or abs(delta) not in allowed_steps or (axis=='z' and abs(delta)>1):
                    raise ValueError('Invalid bounded jog')
                speed=body.get('speed','normal')
                if speed not in self.speeds: raise ValueError('Invalid speed selection')
                feed=self.speeds[speed][axis]
                hold_id=body.get('id') if held else None
                if held:
                    if not isinstance(hold_id,str) or not 8<=len(hold_id)<=80 or not all(c.isalnum() or c in '_-' for c in hold_id):
                        raise ValueError('Invalid hold ID')
                if self.snapshots:
                    if axis == 'z':
                        raise ValueError('Keep the taught raised Z; clear corners before changing height')
                s=self.checked()
                if held:
                    with self.lock:
                        if hold_id in self.released_holds: return
                        self.hold_id=hold_id;self.hold_released=False;self.hold_at=time.time()*1000
                self.data.update(busy=True,hold=dict(id=hold_id,axis=axis) if held else None)
                self.log(f"Jog {'hold' if held else 'step'}: {axis.upper()} {'+' if delta>0 else '-'}, {feed:g} mm/min")
                self.invalidate_plan()
                limit=(5 if axis=='z' else 100) if held else abs(delta)
                def jog():
                    try:
                        if self.demo:
                            moved=0;step=(.1 if axis=='z' else 1) if held else abs(delta)
                            while moved < limit-1e-6:
                                if self.stopped: raise ValueError('Session stopped')
                                if held and (self.hold_released or time.time()*1000-self.hold_at>500): break
                                self.demo_position[axis]=round(self.demo_position[axis]+(1 if delta>0 else -1)*step,3)
                                moved+=step;self.data['status']=self.read_machine()['status'];time.sleep(.15)
                        else:
                            self.launch(['node',str(ROOT/'scripts/ugs_map_jog.mjs')],
                                dict(axis=axis,delta=delta,snapshot=s,feed=feed,mode='hold' if held else 'step',holdId=hold_id))
                        end=self.read_machine();m,offset=position(end);start,previous_offset=position(s)
                        travelled=(m[axis]-start[axis])*(1 if delta>0 else -1)
                        valid_distance=(-.005<=travelled<=limit+.005) if held else abs(travelled-abs(delta))<=.005
                        if offset!=previous_offset or end['listener']!=s['listener'] or not valid_distance or any(abs(m[a]-start[a])>.005 for a in 'xyz' if a!=axis):
                            raise ValueError('Jog end position or reference mismatch')
                        self.expected=end;self.data['status']=end['status']
                    except Exception as e:
                        self.stop(str(e))
                    finally:
                        with self.lock:
                            if hold_id: self.released_holds.append(hold_id)
                            self.hold_id=None;self.hold_released=True
                            self.data.update(busy=False,hold=None)
                threading.Thread(target=jog,daemon=True).start()
            elif action == 'goto':
                if self.data['phase'] != 'teach': raise ValueError('Cannot position during a scan')
                area=positioning_rectangle(self.snapshots)
                s=self.checked();start,offset=position(s)
                z=position(next(iter(self.snapshots.values())))[0]['z']
                if any(type(body.get(a)) not in (int,float) for a in 'xy'):raise ValueError('XY target must be numeric')
                target={a:round(finite(body.get(a)),3) for a in 'xy'};target['z']=z
                if start['z']!=z or any(not area[a][0]<=p[a]<=area[a][1] for a in 'xy' for p in (start,target)):
                    raise ValueError('Click-to-move requires the taught raised Z and positions inside the taught rectangle')
                if target==start:return
                speed=body.get('speed','normal')
                if speed not in self.speeds: raise ValueError('Invalid speed selection')
                feed=min(self.speeds[speed][a] for a in 'xy')
                self.data.update(busy=True);self.invalidate_plan()
                def move_to():
                    try:
                        if self.demo:
                            time.sleep(.15)
                            if self.stopped:raise ValueError('Session stopped')
                            self.demo_position.update(target)
                        else:
                            self.launch(['node',str(ROOT/'scripts/ugs_map_jog.mjs')],
                                dict(mode='goto',snapshot=s,target=target,area=area,feed=feed))
                        end=self.read_machine();m,new_offset=position(end)
                        if new_offset!=offset or end['listener']!=s['listener'] or any(abs(m[a]-target[a])>.005 for a in 'xyz'):
                            raise ValueError('Positioning end/reference mismatch')
                        self.expected=end;self.data['status']=end['status']
                    except Exception as e:self.stop(str(e))
                    finally:self.data['busy']=False
                threading.Thread(target=move_to,daemon=True).start()
            elif action == 'capture':
                if self.data['phase'] != 'teach':raise ValueError('Cannot capture during a scan')
                name=body.get('corner') or next((n for n in CORNERS if n not in self.snapshots),None)
                if name not in CORNERS:raise ValueError('Select a named corner')
                s=self.checked()
                if self.snapshots and position(s)[0]['z']!=position(next(iter(self.snapshots.values())))[0]['z']:
                    raise ValueError('Keep the same raised Z at every corner')
                self.snapshots[name]=s
                self.data['corners']=[dict(name=name,**position(self.snapshots[name])[0]) for name in CORNERS if name in self.snapshots]
                self.invalidate_plan();self.data.update(area=None, geometryIssue=corner_issue(self.data['corners']))
                try:self.data['area']=positioning_rectangle(self.snapshots)
                except ValueError as e:
                    if len(self.snapshots)>=2 and not self.data['geometryIssue']:
                        self.data['geometryIssue']=str(e)
            elif action == 'reset-corners':
                if self.data['phase'] != 'teach':
                    raise ValueError('Cannot change an active scan')
                self.checked(); self.snapshots = {}; self.data.update(corners=[], area=None, geometryIssue=None); self.invalidate_plan()
                with self.pcb_lock:
                    self.pcb.invalidate('Taught setup cleared. Recheck PCB alignment.')
            elif action == 'plan':
                if self.data['phase'] != 'teach':
                    raise ValueError('Cannot change an active scan')
                self.invalidate_plan()
                current=self.checked()
                config = make_config(self.snapshots, body.get('spacing'),current,self.profile)
                if self.demo:
                    self.data['plan'] = config
                    self.data['route'] = scan_route(config)
                else:
                    path = save_plan(self.snapshots, body.get('spacing'),current,self.profile)
                    output = subprocess.check_output(['node', str(ROOT/'scripts/ugs_puck_map.mjs'), '--config', str(path)], cwd=ROOT, text=True, timeout=10)
                    planned = json.loads(output)
                    self.data.update(plan=planned['config'], route=planned['route']); self.plan_path = path
                self.data['planId'] = secrets.token_hex(16)
            elif action == 'scan':
                if self.data['phase'] != 'teach' or not self.data['plan']:
                    raise ValueError('Preview a valid grid before scanning')
                if body.get('planId') != self.data['planId']:
                    raise ValueError('The scan preview changed. Review the current grid before starting.')
                self.checked(); self.data.update(busy=True, phase='scan', scanStarted=time.time(), measurements=[], currentPoint=None)
                if self.demo:
                    self.demo_index = -2; self.demo_next()
                    return
                def scan():
                    try:
                        self.launch(['node', str(ROOT/'scripts/ugs_puck_map.mjs'), '--config', str(self.plan_path), '--execute', '--web-stdio'], scan=True)
                        with self.lock:
                            if not self.stopped:
                                self.data.update(phase='complete', armed=False)
                        self.close_monitor()
                    except Exception as e:
                        self.stop(str(e))
                    finally:
                        self.data.update(busy=False, prompt=None)
                threading.Thread(target=scan, daemon=True).start()
            else:
                raise ValueError('Unknown action')
        finally:
            self.action_lock.release()

    def demo_next(self):
        plan = self.data['plan']; total=len(plan['grid']['x'])*len(plan['grid']['y'])+1
        if 1 <= self.demo_index <= total:
            p = self.data['route']['points'][self.demo_index-1]
            # Explicitly simulated, memory-only data exercises the full visual workflow.
            reference = self.data['route']['points'][0]
            z = plan['travelZ']-2 + (p['x']-reference['x'])*.001 + (p['y']-reference['y'])*.002
            self.data['measurements'].append(dict(**p, contactZ=z, spread=.002, simulated=True))
        self.demo_index += 1
        if self.demo_index == -1:
            text, answer = 'DEMO: Confirm the displayed grid and clear traverse height. Real mode lists the physical startup checks.', 'confirm startup'
        elif self.demo_index == 0:
            text, answer = 'DEMO: Touch and release puck against the stationary tool twice. Real mode verifies the electrical input.', 'contact ready'
        elif self.demo_index <= total:
            point = self.data['route']['points'][self.demo_index-1]
            self.data['currentPoint'] = dict(index=self.demo_index, total=total, point=point)
            self.demo_position.update(point)
            self.data['status'] = self.read_machine()['status']
            text, answer = f'DEMO point {self.demo_index}/{total}. Puck flat, gap below 5 mm, hands clear. Ready simulates two contacts and advance.', ''
        elif self.demo_index == total+1:
            text, answer = 'DEMO: Confirm clean contacts and travel. No measurements have been taken.', 'accept observations'
        else:
            self.data.update(phase='complete', armed=False, busy=False, prompt=None)
            self.log('Demo complete. No UGS calls, measurements or map export.'); return
        self.data['prompt'] = dict(kind='prompt', id=secrets.token_hex(12), prompt=text, expected=answer)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, content, content_type='application/json'):
        data = content if isinstance(content, bytes) else json.dumps(content).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header('Permissions-Policy', 'camera=(self), microphone=()')
        self.end_headers(); self.wfile.write(data)

    def guard(self, api=False):
        if self.headers.get('Host') != self.server.host_header:
            raise PermissionError('Invalid Host')
        origin = self.headers.get('Origin')
        if origin and origin != 'http://'+self.server.host_header:
            raise PermissionError('Invalid Origin')
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise PermissionError('Cross-site access refused')
        if api:
            self.server.controller.authenticate(self.headers.get('Authorization','').removeprefix('Bearer '), self.headers.get('X-Client-ID'))

    def do_GET(self):
        try:
            self.guard(self.path.startswith('/api/'))
            if self.path in ('/api/state', '/api/report'):
                data = self.server.controller.state()
                if self.path == '/api/report':
                    with self.server.controller.pcb_lock:
                        data['pcb'] = self.server.controller.pcb.public(data['sessionId'], include_paths=False)
                self.send(200, data)
                return
            if self.path == '/api/pcb':
                self.send(200, self.server.controller.pcb_state())
                return
            asset = {'/': ('index.html','text/html; charset=utf-8'), '/app.js': ('app.js','text/javascript'), '/pcb.js': ('pcb.js','text/javascript'), '/camera.js': ('camera.js','text/javascript'), '/style.css': ('style.css','text/css')}.get(self.path)
            if not asset:
                self.send(404, {'error':'Not found'}); return
            self.send(200, (ASSETS/asset[0]).read_bytes(), asset[1])
        except PermissionError as e:
            self.send(403, {'error':str(e)})
        except (ValueError, TypeError, KeyError, OSError) as e:
            self.send(400, {'error':str(e)})

    def do_POST(self):
        try:
            self.guard(True)
            if not self.path.startswith('/api/') or self.headers.get('Content-Type') != 'application/json':
                raise ValueError('Expected JSON API request')
            size=int(self.headers.get('Content-Length','0'))
            maximum = 24_000_000 if self.path in ('/api/pcb-import', '/api/pcb-load') else 16384
            if not 0 < size <= maximum:
                raise ValueError('Invalid request size')
            body=json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError('Expected a JSON object')
            action=self.path.removeprefix('/api/')
            if action != 'stop' and not isinstance(body.get('sessionId'), str):
                raise ValueError('Missing setup ID. Refresh the page.')
            result=self.server.controller.perform(action, body, session_id=body.get('sessionId'))
            self.send(200, {'ok':True, 'result':result})
        except PermissionError as e:
            self.send(403, {'error':str(e)})
        except (ValueError, TypeError, KeyError, subprocess.SubprocessError, OSError) as e:
            self.send(400, {'error':str(e)})


class LocalHTTPServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer resolves the numeric bind address with reverse DNS. This
        # local-only server needs no hostname and must not wait for DNS startup.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--demo', action='store_true')
    parser.add_argument('--port', type=int, default=8765)
    args=parser.parse_args()
    controller=Controller(args.demo)
    server=LocalHTTPServer(('127.0.0.1', args.port), Handler)
    server.controller=controller; server.host_header=f'127.0.0.1:{server.server_port}'
    print(f"Open http://{server.host_header}/#{controller.token}", flush=True)
    print('DEMO — no hardware access' if args.demo else 'UGS mapping — opening the page does not move the CNC', flush=True)
    def terminate(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        controller.stop('Web server closing'); controller.closed=True
        if controller.child:
            try: controller.child.wait(timeout=12)
            except subprocess.TimeoutExpired: print('Runner has not exited. Use the physical stop; do not assume motion stopped.', flush=True)
        if controller.monitor:
            try: controller.monitor.wait(timeout=8)
            except subprocess.TimeoutExpired: print('Read-only monitor did not exit.', flush=True)
        server.server_close()


if __name__=='__main__':
    main()
