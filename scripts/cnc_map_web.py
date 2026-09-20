#!/usr/bin/env python3
"""Local supervised UGS mapping UI. --offline prepares jobs; --demo simulates a machine."""
import argparse
import base64
import copy
from collections import deque
import json
import hashlib
import os
from pathlib import Path
import secrets
import signal
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from surface_config import load_config, offline_data_dir
from agent_api import AgentGateway, AgentError, Discovery

from cnc_map_terminal import ROOT, CORNERS, snapshot, position, make_config, save_plan, positioning_rectangle, taught_rectangle, finite
from cnc_map_support import fault_details, scan_route, corner_issue
from pcb_workspace import Workspace
from job_actions import ACTIONS as JOB_ACTIONS, perform as job_action
from job_workflow import scan_area, fingerprint, plan_status, configure_workflow, map_source_current, preparation_view

ASSETS = Path(__file__).with_name('cnc-map-web')
MAX_JOB_PACKAGE_BYTES = 24_000_000
OFFLINE_REASON = ('Offline preparation has no machine connection or verified machine configuration. '
                  'Save the planning job, then restart without --offline using your completed '
                  'CNC_BUILDMASTER_CONFIG and establish fresh machine references.')
# Explicitly allow digital operations; future machine endpoints fail closed by default.
OFFLINE_ACTIONS = frozenset({
    'stop', 'pcb-import', 'pcb-configure', 'pcb-operation', 'pcb-reference',
    'pcb-solve', 'pcb-new', 'pcb-load', 'pcb-example', 'pcb-save', 'pcb-workflow',
    'pcb-fixture', 'pcb-fixture-check', 'pcb-camera', 'pcb-recipe', 'pcb-vbit', 'pcb-tool-note',
})


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


class Controller:
    def __init__(self, demo=False, offline=False):
        self.demo = demo
        self.offline = offline
        self.mode = 'offline' if offline else 'demo' if demo else 'real'
        self.profile = load_config(demo=demo, offline=offline)
        self.lock = threading.Lock()
        self.action_lock = threading.Lock()
        self.pcb_lock = threading.RLock()
        self.pcb = Workspace()
        self.jobs_dir = Path(self.profile['dataDir'])/'jobs'
        if not demo and not offline:
            self.jobs_dir.parent.mkdir(parents=True, exist_ok=True)
        self.child = None
        self.monitor = None
        self.monitor_thread = None
        self.monitor_closing = False
        self.token = secrets.token_urlsafe(32)
        self.owner = None
        self.revoked_owners = set()
        self.last_seen = 0
        self.data = dict(demo=demo, offline=offline, mode=self.mode, armed=False, busy=False, phase='setup', corners=[], plan=None,
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
        self.speeds = {}
        if not offline:
            limits = self.profile['baseline']
            maxima = {axis: float(limits[str(key)]) for axis,key in zip('xyz',(110,111,112))}
            self.speeds = {name: {a: min(maxima[a], rate[i]) for i,a in enumerate('xyz')} for name,rate in
                           {'slow': (100,100,10), 'normal': (600,600,60), 'fast': (1000,1000,100), 'maximum': (maxima['x'],maxima['y'],maxima['z'])}.items()}
        self.data.update(speeds=self.speeds, hold=None, nativeJog=demo, area=None,
                         configuration={'name': self.profile['name'], 'configured': self.profile['configured'], 'puckHeight': self.profile.get('puckHeight'), 'ugsPort': self.profile.get('ugsPort'), 'feeds': self.profile.get('feeds', {})}, apiVersion=7, sessionId=secrets.token_hex(16), fault=None, diagnostics=None,
                         geometryIssue=None, route=None, planId=None, scanStarted=None, probeMode="puck", mapSource=None, handoff=None, jobSetupEpoch=0, continuityActive=False, preparationClosed=False)
        if offline:
            self.data.update(planningOnly=True, machineUnavailableReason=OFFLINE_REASON)
        self.agent = AgentGateway(self)
        if not offline:
            threading.Thread(target=self.watchdog, daemon=True).start()

    def require_machine_mode(self):
        if self.offline:
            raise ValueError(OFFLINE_REASON)

    def check_offline_action(self, action):
        if self.offline and action not in OFFLINE_ACTIONS:
            raise ValueError(OFFLINE_REASON)

    def check_jobs_dir(self):
        if self.offline and self.jobs_dir != offline_data_dir()/'jobs':
            raise ValueError('Offline jobs must stay in the separate offline preparation directory')

    def pcb_public(self, include_paths=True):
        data = self.pcb.public(None if self.offline else self.data['sessionId'], include_paths=include_paths)
        data['hasContent'] = self.pcb.has_content()
        if self.offline:
            data.update(mode='offline', offline=True, planningOnly=True, canExport=False)
        return data

    def log(self, message):
        with self.lock:
            entry=time.strftime('%H:%M:%S')+' '+str(message)
            self.data['logs'] = (self.data['logs'] + [entry])[-150:]
            print(entry, flush=True)

    def state(self):
        with self.lock:
            data = copy.deepcopy(self.data)
            data['canStartFresh'] = self.can_start_fresh()
            # This scalar is an invalidation hint, not a coherent job snapshot
            # or mutation authority. Never block the heartbeat on CAM geometry.
            # Writes still check the supplied revision under pcb_lock.
            data['pcbRevision'] = self.pcb.revision
        data['agent'] = self.agent.public()
        return data

    def pcb_state(self, include_paths=True):
        with self.pcb_lock:
            self.check_jobs_dir()
            data = self.pcb_public(include_paths=include_paths)
            # Share detached immutable geometry only within this locked read.
            # Session/alignment/map authority is checked afresh by each consumer.
            preview = preparation_view(data)
            data['guide'] = plan_status(self.pcb, self.data['sessionId'], self.data, preview=preview)
            try: data['scanProposal'] = scan_area(self.pcb, preview=preview)
            except ValueError as e: data['scanProposal'] = {'error':str(e)}
            data['savedJobs'] = [] if self.demo else [
                {'id': p.name, 'label': p.stem.replace('.pcb-job', '')}
                for p in sorted(self.jobs_dir.glob('*.pcb-job.json'), reverse=True)[:50]
                if p.is_file() and not p.is_symlink()]
            return data

    def save_pcb_package(self, recovery=False):
        self.check_jobs_dir()
        package = self.pcb.package(None if self.offline else self.data['sessionId'])
        if self.offline:
            package.update(mode='offline', offline=True, planningOnly=True)
            package['job'] = self.pcb_public(include_paths=False)
        encoded = json_bytes(package)
        if len(encoded) > MAX_JOB_PACKAGE_BYTES:
            raise ValueError('Job package exceeds the 24 MB UTF-8 limit. Split the job before saving.')
        if self.demo:
            return {'package': package, 'savedPath': None}
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        slug = re.sub('[^a-zA-Z0-9]+', '-', self.pcb.name).strip('-')[:40] or 'pcb'
        filename = time.strftime('%Y%m%dT%H%M%S')+'-'+('recovery-' if recovery else '')+slug+'-'+secrets.token_hex(4)+'.pcb-job.json'
        path = self.jobs_dir/filename
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='wb', dir=self.jobs_dir, prefix='.'+filename+'-',
                                             suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            # Publish a complete sibling atomically, without replacing an existing job.
            os.link(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink()
        if not recovery:
            self.pcb.last_saved = str(path); self.pcb.changed()
        return {'package': package, 'savedPath': str(path)}

    def replace_pcb(self, candidate):
        if self.pcb.has_content():
            self.save_pcb_package(recovery=True)
        candidate.revision = self.pcb.revision+1
        self.pcb = candidate

    def perform_pcb(self, action, body):
        self.check_offline_action(action)
        if self.data['busy']:
            raise ValueError('Wait for the current machine operation before editing the PCB job')
        with self.pcb_lock:
            if body.get('pcbRevision') != self.pcb.revision:
                raise ValueError('The PCB job changed. Review the current preview and try again.')
        live = action in ('pcb-capture', 'pcb-stock-from-area', 'pcb-export', 'pcb-map-job')
        completed_export = action == 'pcb-export' and self.data['phase'] == 'complete'
        s = None
        if live:
            if completed_export:
                self.require_continuity()
                if self.data.get('mapSource') and not map_source_current(self.pcb, self.data['sessionId'], self.data):
                    raise ValueError('Job setup changed after measuring. Recheck alignment and surface coverage.')
            elif self.stopped or not self.data['armed'] or self.data['phase'] != 'teach':
                raise ValueError('Enable teaching with a fresh setup before using machine references')
            s = self.checked()
        with self.pcb_lock:
            if live and self.stopped:
                raise ValueError('Machine session stopped')
            if action in JOB_ACTIONS:
                result = job_action(self.pcb, action, body, self.profile, self.demo)
                if self.offline and isinstance(result, dict):
                    result.update(planningOnly=True, machineConfigurationVerified=False)
                return result
            elif action == 'pcb-workflow':
                configure_workflow(self.pcb, body.get('settings'))
            elif action == 'pcb-map-job':
                if body.get('reviewed') is not True or not self.pcb.valid_alignment(self.data['sessionId']):
                    raise ValueError('Check live board alignment and confirm support and travel clearance first')
                proposal=scan_area(self.pcb, body.get('margin',1))
                if proposal['fingerprint'] != body.get('fingerprint'):
                    raise ValueError('Job geometry changed. Review the updated scan proposal.')
                if self.pcb.workflow['sourceCompensation'] != 'none':
                    raise ValueError('Confirm the source files have no height compensation before planning a new map')
                proposal['setupEpoch'] = self.data['jobSetupEpoch']
                area=proposal['area']; completed={}
                for name in CORNERS:
                    snap=copy.deepcopy(s); fb,lr=name.split('-')
                    for axis,index in [('x',int(lr=='right')),('y',int(fb=='back'))]:
                        offset=s['status']['machineCoord'][axis]-s['status']['workCoord'][axis]
                        snap['status']['machineCoord'][axis]=area[axis][index]
                        snap['status']['workCoord'][axis]=area[axis][index]-offset
                    snap['cornerSource']='job'; completed[name]=snap
                with self.lock:
                    if self.stopped:raise ValueError('Session stopped before accepting the job area')
                    self.snapshots=completed
                    self.data.update(corners=[dict(name=n,source='job',**position(completed[n])[0]) for n in CORNERS],
                                     area=area,geometryIssue=None,mapSource=proposal,probeMode=proposal['probeMode'])
                    self.invalidate_plan()
            elif action == 'pcb-import':
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
                self.pcb.solve(None if self.offline else self.data['sessionId'])
            elif action == 'pcb-stock-from-area':
                area = positioning_rectangle(self.snapshots)
                self.pcb.stock.update(x=area['x'][0], y=area['y'][0], width=area['x'][1]-area['x'][0], height=area['y'][1]-area['y'][0])
                self.pcb.invalidate('Using the taught rectangle as usable stock. Check its inset and margin.')
            elif action == 'pcb-new':
                self.replace_pcb(Workspace())
            elif action == 'pcb-load':
                package = body.get('package')
                if 'savedId' in body:
                    self.check_jobs_dir()
                    name = body['savedId']
                    if self.demo or not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.pcb-job\.json', name):
                        raise ValueError('Invalid saved job')
                    path = self.jobs_dir/name
                    if path.is_symlink() or path.stat().st_size > MAX_JOB_PACKAGE_BYTES:
                        raise ValueError('Saved job is unavailable or too large')
                    package = json.loads(path.read_text(encoding='utf-8'))
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
                data = self.pcb.export(self.data['sessionId'], offset, self.demo, profile=self.profile)
                if completed_export: self.require_continuity()
                if self.stopped: raise ValueError('Session stopped while preparing the draft')
                return {'archive': base64.b64encode(data).decode(), 'filename': 'pcb-aligned-draft.zip'}
            else:
                raise ValueError('Unknown PCB action')

    def job_setup_signature(self):
        with self.pcb_lock:
            return (id(self.pcb), fingerprint(self.pcb), self.pcb.tolerance,
                    json.dumps([self.pcb.references, self.pcb.alignment], sort_keys=True, allow_nan=False))

    def invalidate_job_surface(self):
        # A later edit back to the same geometry cannot resurrect an old map/plan.
        with self.lock:
            self.data['jobSetupEpoch'] += 1
            source = self.data.get('mapSource')
            if source:
                source['invalidated'] = True
                if self.data['phase'] == 'teach':
                    self.snapshots = {}
                    self.data.update(corners=[], area=None, geometryIssue=None)
                    self.invalidate_plan()
                if self.data.get('handoff'):
                    self.data['handoff'] = {**self.data['handoff'], 'verified':False,
                        'historicalReadbackVerified': self.data['handoff'].get('verified') is True,
                        'reason':'The job setup changed after import.'}

    def require_continuity(self):
        if (self.stopped or self.data.get('preparationClosed') or not self.data.get('continuityActive')
                or (not self.demo and (self.monitor_closing or not self.monitor or self.monitor.poll() is not None))):
            raise ValueError('Reference monitoring is no longer active. Establish a fresh setup before using machine references.')

    def can_start_fresh(self):
        return (self.data['phase'] in ('stopped', 'complete') and not self.data['busy']
                and not self.action_lock.locked()
                and not (self.child and self.child.poll() is None)
                and (self.data['phase'] == 'complete' or
                     (not (self.monitor and self.monitor.poll() is None)
                      and not (self.monitor_thread and self.monitor_thread.is_alive()))))

    def invalidate_plan(self):
        self.data.update(plan=None, route=None, planId=None)
        self.plan_path = None

    def diagnostics(self):
        self.require_machine_mode()
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
        self.require_machine_mode()
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
        self.require_machine_mode()
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
        self.data['continuityActive'] = False
        monitor = self.monitor
        if monitor and monitor.poll() is None:
            try: monitor.send_signal(signal.SIGTERM)
            except ProcessLookupError: pass
        if monitor and monitor.stdin and not monitor.stdin.closed:
            monitor.stdin.close()

    def stop(self, reason='Operator pressed Stop'):
        self.agent.cancel()
        if self.offline:
            self.log('Offline preparation: no machine is connected; no stop command was sent.')
            return
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
            if (self.data['armed'] or self.data.get('continuityActive')) and time.monotonic()-self.last_seen > 3:
                self.stop('Browser heartbeat lost; setup invalidated')

    def authenticate(self, token, owner):
        if not secrets.compare_digest(token or '', self.token) or not owner or len(owner) > 128:
            raise PermissionError('Invalid local session')
        with self.lock:
            if owner in self.revoked_owners:
                raise PermissionError('This tab ownership was revoked. Use the recovered tab.')
            if self.owner is None:
                self.owner = owner
            if owner != self.owner:
                raise PermissionError('Another tab owns this session; use the original tab')
            self.last_seen = time.monotonic()

    def recover_ownership(self, token, owner, confirmed):
        if not secrets.compare_digest(token or '', self.token) or not owner or len(owner) > 128:
            raise PermissionError('Invalid local session')
        if confirmed is not True:
            raise ValueError('Confirm recovery and clearing old machine references')
        if not self.action_lock.acquire(blocking=False):
            raise ValueError('Wait for the current operation to finish before recovery')
        try:
            with self.lock:
                if owner in self.revoked_owners:
                    raise PermissionError('This tab ownership was revoked. Use the recovered tab.')
                if owner == self.owner:
                    raise ValueError('This tab already owns the session')
                if self.owner and time.monotonic()-self.last_seen <= 3:
                    raise ValueError('The original tab is still active. Use it or close it before recovery.')
                if (self.data['armed'] or self.data['busy'] or self.data.get('continuityActive')
                    or (self.child and self.child.poll() is None)
                    or (self.monitor and self.monitor.poll() is None)
                    or (self.monitor_thread and self.monitor_thread.is_alive())):
                    raise ValueError('Wait for the old setup and all machine workers to stop before recovery')
                if self.owner: self.revoked_owners.add(self.owner)
                self.owner = owner
                self.last_seen = time.monotonic()
                self.snapshots = {}; self.expected = None; self.plan_path = None
                self.hold_id = None; self.hold_released = True; self.stopped = False
                self.data.update(armed=False, busy=False, phase='setup', sessionId=secrets.token_hex(16),
                    corners=[], plan=None, route=None, planId=None, area=None, geometryIssue=None,
                    prompt=None, status=None, result=None, measurements=[], currentPoint=None,
                    error=None, fault=None, diagnostics=None, hold=None, scanStarted=None,
                    copperApproved=False, mapSource=None, handoff=None, continuityActive=False, preparationClosed=False)
            with self.pcb_lock:
                self.pcb.invalidate('Browser ownership recovered. Capture fresh machine references before export.')
            self.invalidate_job_surface()
            self.log('Closed-tab session recovered. Preparation records kept; old physical references cleared.')
            return {'sessionId':self.data['sessionId'], 'referencesRestored':False}
        finally:
            self.action_lock.release()

    def launch(self, command, stdin=None, scan=False):
        self.require_machine_mode()
        env = dict(os.environ, UGS_MAP_WEB_TOKEN=self.token)
        failure_reason = None
        last_diagnostic = None
        scan_result = None
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
                    elif kind == 'result':
                        if scan_result is not None:
                            failure_reason = 'Duplicate scan result from worker'
                        scan_result = event
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
        if failure_reason:
            raise ValueError(failure_reason)
        if scan:
            if not scan_result:
                raise ValueError('Scan ended without a saved, accepted height map')
            result_path = Path(scan_result.get('path', '')).resolve()
            evidence_root = Path(self.profile['dataDir']).resolve()
            if not result_path.is_relative_to(evidence_root) or result_path.name != 'surface.xyz':
                raise ValueError('Scan result is outside the machine evidence directory')
            saved = json.loads(result_path.with_name('result.json').read_text())
            handoff = json.loads(result_path.with_name('ugs-handoff.json').read_text())
            if handoff.get('sha256') != hashlib.sha256(result_path.read_bytes()).hexdigest():
                raise ValueError('Saved height map does not match its handoff checksum')
            summary = scan_result.get('summary')
            if not isinstance(summary, dict) or any(saved.get(k) != v for k, v in summary.items()):
                raise ValueError('Saved height map summary differs from worker result')
            if (saved.get('physicalObservationConfirmed') is not True or
                    saved.get('offsetsPreserved') is not True or saved.get('appliedInUgs') is not False or
                    not result_path.read_text().strip()):
                raise ValueError('Scan result is incomplete or has unverified acceptance')
            scan_result['acceptedHashes']={name:hashlib.sha256(result_path.with_name(name).read_bytes()).hexdigest() for name in ('surface.xyz','config.json','result.json','ugs-handoff.json')}
            with self.lock:
                if self.stopped:
                    raise ValueError('Session stopped before accepting the saved map')
                self.data['result'] = scan_result

    def hold_control(self, action, body):
        self.require_machine_mode()
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

    def perform(self, action, body, session_id=None, *, actor='browser', agent_request=None):
        cancel_epoch = self.agent.cancel_epoch
        if not isinstance(body, dict):
            raise ValueError('Expected a JSON object')
        self.check_offline_action(action)
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
                if p['expected'] == 'start copper scan':
                    threading.Thread(target=self.demo_copper, daemon=True).start()
                else:
                    self.demo_next()
            return
        if not self.action_lock.acquire(blocking=False):
            raise ValueError('An operation is already in progress')
        try:
            if session_id is not None and session_id != self.data['sessionId']:
                raise ValueError('This request belongs to an old setup. Refresh the page.')
            if actor == 'agent':
                self.agent.check_prepare(action)
            elif self.agent.prepare_enabled:
                raise ValueError('Pause agent preparation before editing or controlling the machine in the browser')
            if agent_request is not None:
                self.agent.check_request(agent_request)
            if action.startswith('pcb-'):
                before = self.job_setup_signature()
                try:
                    return self.perform_pcb(action, body)
                finally:
                    if self.job_setup_signature() != before:
                        self.invalidate_job_surface()
            if action == 'new-session':
                if (self.data['phase'] == 'complete' and not self.data['busy']
                    and not (self.child and self.child.poll() is None)):
                    # The explicit new-map action can retire a read-only observer.
                    # A running motion worker still prevents replacement.
                    self.close_monitor()
                    if self.monitor_thread: self.monitor_thread.join(timeout=2)
                    if self.monitor and self.monitor.poll() is None:
                        self.monitor.wait(timeout=2)
                if (self.data['phase'] not in ('stopped', 'complete') or self.data['busy']
                    or (self.child and self.child.poll() is None)
                    or (self.monitor and self.monitor.poll() is None)
                    or (self.monitor_thread and self.monitor_thread.is_alive())):
                    raise ValueError('Wait for all workers to stop before starting a fresh setup')
                with self.agent.lock:
                    # Stop bypasses action_lock. A delayed reset must not undo it.
                    self.agent.check_epoch(cancel_epoch)
                    if agent_request is not None: self.agent.check_request(agent_request)
                    self.snapshots = {}; self.expected = None; self.plan_path = None
                    self.child = None; self.monitor = None; self.monitor_thread = None
                    self.hold_id = None; self.hold_released = True
                    self.stopped = False
                    with self.pcb_lock:
                        self.pcb.invalidate('New machine setup. Saved job remains; machine references were discarded.')
                    self.data.update(armed=False, busy=False, phase='setup', sessionId=secrets.token_hex(16),
                                     corners=[], plan=None, route=None, planId=None, area=None, geometryIssue=None,
                                     prompt=None, status=None, result=None, measurements=[], currentPoint=None,
                                     error=None, fault=None, diagnostics=None, hold=None, scanStarted=None, copperApproved=False, mapSource=None, handoff=None, continuityActive=False, preparationClosed=False)
                self.log('Fresh setup opened. Previous coordinates were discarded; teaching is not enabled.')
                return
            if action == 'diagnostics':
                if self.data['busy']: raise ValueError('Wait for the current operation before checking the connection')
                return self.diagnostics()
            if self.stopped:
                raise ValueError('Session stopped. Start a fresh setup after inspection.')
            if self.data['busy']:
                raise ValueError('Wait for the current operation')
            if action == 'surface-import':
                if self.demo or self.stopped or self.data['phase'] != 'complete' or self.data['busy']:
                    raise ValueError('Native import requires a completed, accepted real scan in this setup')
                self.require_continuity()
                source=self.data.get('mapSource')
                if source and not map_source_current(self.pcb, self.data['sessionId'], self.data):
                    raise ValueError('Job changed since this map. Review coverage and measure the current setup.')
                from job_handoff import accepted_payload
                from ugs_surface_bridge import SurfaceBridge
                self.data['handoff']=None
                payload=accepted_payload(self.data.get('result'), self.profile['dataDir'])
                import_session=self.data['sessionId']
                def valid_import():
                    if self.stopped or self.data['phase'] != 'complete' or self.data['sessionId'] != import_session:
                        raise ValueError('Setup stopped or changed during import. Inspect the native map in UGS.')
                    self.require_continuity()
                def guard():
                    with self.lock: valid_import()
                    if load_config() != self.profile:
                        raise ValueError('Machine configuration changed since scanning')
                    self.checked()
                    with self.lock: valid_import()
                    return True
                bridge=SurfaceBridge(f"http://127.0.0.1:{self.profile['ugsPort']}/api/v1", guard=guard)
                result=bridge.import_map(payload)
                with self.lock:
                    valid_import()
                    self.data['handoff']={'verified':True,'sha256':payload['sha256'],
                        'compensationApplied':False,'continuityVerified':False,'materialZVerified':False}
                self.log('Native AutoLeveler import read back and verified. Material Z, physical continuity and compensated file remain unverified.')
                return self.data['handoff']
            if action == 'handoff-finish':
                if self.data['phase'] != 'complete' or self.data.get('preparationClosed'):
                    raise ValueError('Finish an accepted surface measurement before closing preparation')
                self.require_continuity()
                self.checked()
                with self.lock:
                    if self.stopped: raise ValueError('Session stopped before closing preparation')
                    self.data.update(preparationClosed=True, armed=False)
                self.close_monitor()
                self.log('Preparation closed. Reference monitoring ended; continue file and compensation review in UGS.')
                return {'preparationClosed':True,'cuttingReleased':False}
            if action == 'probe-mode':
                if self.data['phase'] not in ('setup', 'teach') or body.get('mode') not in ('puck', 'copper'):
                    raise ValueError('Choose a probing method before scanning')
                self.data['probeMode'] = body['mode']
                self.invalidate_plan()
                return
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
                        if result.stderr.strip():
                            self.log(result.stderr.strip())
                        if result.returncode:
                            raise ValueError(result.stderr.strip().splitlines()[-1] or 'UGS reference check failed')
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
                        self.data.update(armed=True, phase='teach', continuityActive=True)
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
            elif action == 'complete-rectangle':
                if self.data['phase'] != 'teach':
                    raise ValueError('Cannot complete the rectangle during a scan')
                area = positioning_rectangle(self.snapshots)
                presented = body.get('area')
                if (not isinstance(presented, dict) or set(presented) != {'x', 'y'} or
                    any(not isinstance(presented[a], list) or len(presented[a]) != 2 or
                        any(type(v) not in (int, float) or v != bound
                            for v, bound in zip(presented[a], area[a])) for a in 'xy')):
                    raise ValueError('The rectangle preview changed. Review the current area before completing it.')
                s = self.checked()
                current, offset = position(s)
                first = next(iter(self.snapshots.values()))
                taught, taught_offset = position(first)
                if current['z'] != taught['z']:
                    raise ValueError('Keep the same raised Z at every corner')
                if offset != taught_offset or s['listener'] != first['listener']:
                    raise ValueError('Taught reference changed; teach again')
                # Stage inferred corners without altering the captures or live status.
                completed = self.snapshots.copy()
                for name in CORNERS:
                    if name in completed:
                        continue
                    inferred = copy.deepcopy(s)
                    front_back, left_right = name.split('-')
                    for axis, index in (('x', int(left_right == 'right')), ('y', int(front_back == 'back'))):
                        value = area[axis][index]
                        work_offset = s['status']['machineCoord'][axis] - s['status']['workCoord'][axis]
                        inferred['status']['machineCoord'][axis] = value
                        inferred['status']['workCoord'][axis] = value - work_offset
                    inferred['cornerSource'] = 'inferred'
                    completed[name] = inferred
                if taught_rectangle(completed) != area:
                    raise ValueError('Completed corners do not match the taught rectangle')
                corners = [dict(name=name, source=completed[name].get('cornerSource', 'captured'),
                                **position(completed[name])[0]) for name in CORNERS]
                with self.lock:
                    # Stop and the watchdog can run while checked() is in progress.
                    if self.stopped or not self.data['armed'] or self.data['phase'] != 'teach' or self.data['busy']:
                        raise ValueError('Session stopped or teaching is no longer idle')
                    self.snapshots = completed
                    self.data.update(corners=corners, area=area, geometryIssue=None)
                    self.invalidate_plan()
            elif action in ('capture', 'corner-entry'):
                if self.data['phase'] != 'teach':raise ValueError('Cannot capture during a scan')
                name=body.get('corner') or next((n for n in CORNERS if n not in self.snapshots),None)
                if name not in CORNERS:raise ValueError('Select a named corner')
                s=self.checked()
                if self.snapshots and position(s)[0]['z']!=position(next(iter(self.snapshots.values())))[0]['z']:
                    raise ValueError('Keep the same raised Z at every corner')
                s=copy.deepcopy(s)
                if action == 'corner-entry':
                    for axis in ('x','y'):
                        value=body.get(axis)
                        if isinstance(value,bool) or not isinstance(value,(int,float)):
                            raise ValueError('Enter numeric machine X and Y in millimetres')
                        value=finite(value)
                        if abs(value)>10000 or abs(value*1000-round(value*1000))>1e-6:
                            raise ValueError('Coordinates must be within 10000 mm and use at most three decimals')
                        offset=s['status']['machineCoord'][axis]-s['status']['workCoord'][axis]
                        s['status']['machineCoord'][axis]=value
                        s['status']['workCoord'][axis]=value-offset
                    s['cornerSource']='entered'
                else:
                    s['cornerSource']='captured'
                self.data['mapSource']=None
                self.snapshots[name]=s
                self.data['corners']=[dict(name=name,source=self.snapshots[name].get('cornerSource','captured'),**position(self.snapshots[name])[0]) for name in CORNERS if name in self.snapshots]
                self.invalidate_plan();self.data.update(area=None, geometryIssue=corner_issue(self.data['corners']))
                try:self.data['area']=positioning_rectangle(self.snapshots)
                except ValueError as e:
                    if len(self.snapshots)>=2 and not self.data['geometryIssue']:
                        self.data['geometryIssue']=str(e)
            elif action == 'reset-corners':
                if self.data['phase'] != 'teach':
                    raise ValueError('Cannot change an active scan')
                self.checked(); self.snapshots = {}; self.data.update(corners=[], area=None, geometryIssue=None, mapSource=None); self.invalidate_plan()
                with self.pcb_lock:
                    self.pcb.invalidate('Taught setup cleared. Recheck PCB alignment.')
            elif action == 'plan':
                if self.data['phase'] != 'teach':
                    raise ValueError('Cannot change an active scan')
                self.invalidate_plan()
                current=self.checked()
                source=self.data.get('mapSource')
                if source and not map_source_current(self.pcb, self.data['sessionId'], self.data):
                    raise ValueError('Job changed after choosing the scan area. Use Map this job again.')
                config = make_config(self.snapshots, body.get('spacing'),current,self.profile,self.data['probeMode'])
                if self.demo:
                    self.data['plan'] = config
                    self.data['route'] = scan_route(config)
                else:
                    path = save_plan(self.snapshots, body.get('spacing'),current,self.profile,self.data['probeMode'])
                    output = subprocess.check_output(['node', str(ROOT/'scripts/ugs_puck_map.mjs'), '--config', str(path)], cwd=ROOT, text=True, timeout=10)
                    planned = json.loads(output)
                    self.data.update(plan=planned['config'], route=planned['route']); self.plan_path = path
                self.data['planId'] = secrets.token_hex(16)
            elif action == 'scan':
                if self.data['phase'] != 'teach' or not self.data['plan']:
                    raise ValueError('Preview a valid grid before scanning')
                if body.get('planId') != self.data['planId']:
                    raise ValueError('The scan preview changed. Review the current grid before starting.')
                if self.data.get('mapSource') and not map_source_current(self.pcb, self.data['sessionId'], self.data):
                    raise ValueError('Job changed. Review the job scan area again.')
                self.checked(); self.data.update(busy=True, phase='scan', scanStarted=time.time(), measurements=[], currentPoint=None)
                if self.demo:
                    self.data['copperApproved']=False
                    self.demo_index = -2; self.demo_next()
                    return
                def scan():
                    try:
                        self.launch(['node', str(ROOT/'scripts/ugs_puck_map.mjs'), '--config', str(self.plan_path), '--execute', '--web-stdio'], scan=True)
                        with self.lock:
                            if not self.stopped:
                                self.data.update(phase='complete', armed=False)
                        # Keep the observer through draft export and native import.
                        # Explicit handoff-finish releases it before UGS file selection.
                    except Exception as e:
                        self.stop(str(e))
                    finally:
                        self.data.update(busy=False, prompt=None)
                threading.Thread(target=scan, daemon=True).start()
            else:
                raise ValueError('Unknown action')
        finally:
            self.action_lock.release()

    def demo_copper(self):
        self.require_machine_mode()
        total = len(self.data['route']['points'])
        # One explicit route approval; Stop/heartbeat remains active for every point.
        while not self.stopped and self.demo_index <= total:
            time.sleep(.12)
            if self.stopped: return
            self.demo_next()
            if self.demo_index <= total: self.data['prompt'] = None

    def demo_next(self):
        self.require_machine_mode()
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
            text, answer = ('DEMO: Verify contact and release using a loose conductive test piece on the same probe circuit.' if self.data['probeMode']=='copper' else 'DEMO: Touch and release puck against the stationary tool. Real mode verifies the electrical input.'), 'contact ready'
        elif self.data['probeMode'] == 'copper' and self.demo_index == 1 and not self.data.get('copperApproved'):
            self.data['copperApproved'] = True
            self.demo_index = 0
            text, answer = 'DEMO: Start the complete copper scan. Real mode checks copper continuity and requires a clear, reviewed route.', 'start copper scan'
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

    def send(self, code, content, content_type='application/json', style_nonce=None):
        data = content if isinstance(content, bytes) else json_bytes(content)
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        # Only styles created by this page's component library receive this nonce.
        # Script sources and arbitrary inline style/script restrictions stay intact.
        nonce_source = f" 'nonce-{style_nonce}'" if style_nonce else ''
        self.send_header('Content-Security-Policy', f"default-src 'self'; script-src 'self'; style-src 'self'{nonce_source}; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
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
            if self.path.startswith('/api/agent/'):
                self.guard()
                self.server.controller.agent.authenticate(self.headers.get('Authorization','').removeprefix('Bearer '))
                if self.path != '/api/agent/capabilities':
                    raise AgentError('NOT_FOUND', 'Use the discovered tools through /api/agent/call')
                self.send(200, self.server.controller.agent.capabilities())
                return
            self.guard(self.path.startswith('/api/'))
            if self.path in ('/api/state', '/api/report'):
                data = self.server.controller.state()
                if self.path == '/api/report':
                    with self.server.controller.pcb_lock:
                        data['pcb'] = self.server.controller.pcb_public(include_paths=False)
                self.send(200, data)
                return
            if self.path == '/api/pcb':
                self.send(200, self.server.controller.pcb_state())
                return
            if self.path.startswith('/api/'):
                self.server.controller.require_machine_mode()
            asset = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.bundle.js': ('app.bundle.js', 'text/javascript'), '/app.css': ('app.css', 'text/css')}.get(self.path)
            if not asset:
                self.send(404, {'error':'Not found'}); return
            content = (ASSETS/asset[0]).read_bytes()
            style_nonce = secrets.token_urlsafe(24) if self.path == '/' else None
            if style_nonce:
                content = content.replace(b'__CSP_NONCE__', style_nonce.encode('ascii'))
            self.send(200, content, asset[1], style_nonce=style_nonce)
        except AgentError as e:
            self.send(403 if e.code == 'UNAUTHORISED' else 400, {'error': {'code': e.code, 'message': str(e), 'retryable': False}})
        except PermissionError as e:
            self.send(403, {'error':str(e)})
        except (ValueError, TypeError, KeyError, OSError) as e:
            self.send(400, {'error':str(e)})

    def do_POST(self):
        try:
            if self.path.startswith('/api/agent/'):
                self.guard()
                self.server.controller.agent.authenticate(self.headers.get('Authorization','').removeprefix('Bearer '))
                if self.path != '/api/agent/call' or self.headers.get('Content-Type') != 'application/json':
                    raise AgentError('INVALID_REQUEST', 'Expected the JSON agent tool endpoint')
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= MAX_JOB_PACKAGE_BYTES:
                    raise AgentError('INVALID_REQUEST', 'Invalid agent request size')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or set(body) != {'name', 'arguments'}:
                    raise AgentError('INVALID_REQUEST', 'Expected name and arguments')
                self.send(200, self.server.controller.agent.call(body['name'], body['arguments']))
                return
            recovery = self.path == '/api/recover-session'
            self.guard(not recovery)
            if not self.path.startswith('/api/') or self.headers.get('Content-Type') != 'application/json':
                raise ValueError('Expected JSON API request')
            size=int(self.headers.get('Content-Length','0'))
            maximum = MAX_JOB_PACKAGE_BYTES if self.path in ('/api/pcb-import', '/api/pcb-load') else 16384
            if not 0 < size <= maximum:
                raise ValueError('Invalid request size')
            body=json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError('Expected a JSON object')
            action=self.path.removeprefix('/api/')
            if recovery:
                result=self.server.controller.recover_ownership(self.headers.get('Authorization','').removeprefix('Bearer '), self.headers.get('X-Client-ID'), body.get('confirmed'))
                self.send(200, {'ok':True, 'result':result}); return
            if action != 'stop' and not isinstance(body.get('sessionId'), str):
                raise ValueError('Missing setup ID. Refresh the page.')
            if action in ('agent-access', 'agent-decide'):
                if body['sessionId'] != self.server.controller.data['sessionId']:
                    raise ValueError('This request belongs to an old setup. Refresh the page.')
                gateway = self.server.controller.agent
                result = (gateway.access(body.get('enabled'), expected_session=body['sessionId']) if action == 'agent-access' else
                          gateway.decide(body.get('requestId'), body.get('approve'), body.get('operatorConfirmed')))
                self.send(200, {'ok':True, 'result':result}); return
            result=self.server.controller.perform(action, body, session_id=body.get('sessionId'))
            self.send(200, {'ok':True, 'result':result})
        except AgentError as e:
            if self.path.startswith('/api/agent/'):
                self.send(403 if e.code == 'UNAUTHORISED' else 400, {'error': {'code': e.code, 'message': str(e), 'retryable': False}})
            else:
                self.send(400, {'error': str(e)})
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
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--demo', action='store_true')
    mode.add_argument('--offline', action='store_true')
    parser.add_argument('--agent-prepare', action='store_true', help='Enable headless preparation at startup; requires --offline')
    parser.add_argument('--port', type=int, default=8765)
    args=parser.parse_args()
    if args.agent_prepare and not args.offline:
        parser.error('--agent-prepare requires --offline; enable real-mode preparation in the app')
    controller=Controller(demo=args.demo, offline=args.offline)
    if args.agent_prepare: controller.agent.access(True)
    server=LocalHTTPServer(('127.0.0.1', args.port), Handler)
    server.controller=controller; server.host_header=f'127.0.0.1:{server.server_port}'
    discovery = Discovery(controller.agent, server.server_port, ROOT)
    print(f"Open http://{server.host_header}/#{controller.token}", flush=True)
    print('OFFLINE preparation — no machine configuration, connection or simulated motion' if args.offline else
          'DEMO — no hardware access' if args.demo else 'UGS mapping — opening the page does not move the CNC', flush=True)
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
        discovery.close()


if __name__=='__main__':
    main()
