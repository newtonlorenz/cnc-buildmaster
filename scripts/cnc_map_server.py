#!/usr/bin/env python3
"""Start, stop, restart or inspect the local CNC mapping web server."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import time

from surface_config import load_config

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT/'scripts/cnc_map_web.py'
ENTRYPOINTS = {str(SERVER), str(ROOT/'scripts/cnc_map_terminal.py'),
               'scripts/cnc_map_web.py', 'scripts/cnc_map_terminal.py'}


def process_info(pid):
    """Read current identity. Never trust a saved PID as ownership evidence."""
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'uid=,lstart=,command='], capture_output=True, text=True)
    if result.returncode or not result.stdout.strip():
        return None
    fields = result.stdout.strip().split(None, 6)
    if len(fields) != 7:
        raise RuntimeError('Cannot inspect process identity')
    command = fields[6]
    return {'pid': pid, 'uid': int(fields[0]), 'started': ' '.join(fields[1:6]), 'command': command}


def process_cwd(pid):
    result = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], capture_output=True, text=True)
    paths = [s[1:] for s in result.stdout.splitlines() if s.startswith('n')]
    return paths[0] if result.returncode == 0 and len(paths) == 1 else None


def is_our_server(info, cwd):
    if not info or info['uid'] != os.getuid() or cwd != str(ROOT):
        return False
    try:
        args = shlex.split(info['command'])
    except ValueError:
        return False
    if len(args) < 2 or not re.fullmatch(r'(?i:python)(?:3(?:\.\d+)?)?', Path(args[0]).name):
        return False
    # Accept only this server's two documented entrypoints and known options.
    if args[1] not in ENTRYPOINTS:
        return False
    tail = args[2:]
    while tail:
        arg = tail.pop(0)
        if arg == '--demo':
            continue
        if arg == '--port' and tail and tail[0].isdigit():
            tail.pop(0); continue
        if re.fullmatch(r'--port=\d+', arg):
            continue
        return False
    return True


def listener(port):
    result = subprocess.run(['lsof', '-a', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-Fpn'], capture_output=True, text=True)
    if result.returncode == 1 and not result.stdout:
        return None
    if result.returncode:
        raise RuntimeError('Cannot inspect the web port: '+result.stderr.strip())
    pids = {int(s[1:]) for s in result.stdout.splitlines() if s.startswith('p')}
    addresses = [s[1:] for s in result.stdout.splitlines() if s.startswith('n')]
    if len(pids) != 1 or addresses != [f'127.0.0.1:{port}']:
        raise RuntimeError(f'Port {port} belongs to an unexpected listener; no process stopped')
    pid = pids.pop(); info = process_info(pid)
    if not is_our_server(info, process_cwd(pid)):
        raise RuntimeError(f'Port {port} is occupied by PID {pid}, which is not this CNC web server; no process stopped')
    return info


def children(pid):
    result = subprocess.run(['pgrep', '-P', str(pid)], capture_output=True, text=True)
    if result.returncode not in (0, 1):
        raise RuntimeError('Cannot inspect server workers')
    return [int(p) for p in result.stdout.split()]


class Manager:
    def __init__(self, port=8765, runtime=None):
        if not 1024 <= port <= 65535 or port == 8080:
            raise ValueError('Choose a web port from 1024–65535, excluding the configured UGS port')
        self.port = port
        self.spawned = []
        self.runtime = Path(runtime or os.environ.get('CNC_MAP_RUNTIME_DIR', ROOT/'.runtime/cnc-map'))
        self.runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = self.runtime.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise RuntimeError('Runtime directory must be a private directory owned by your account')
        self.state_file = self.runtime/f'{port}.json'
        self.lock_file = self.runtime/f'{port}.lock'

    @contextlib.contextmanager
    def locked(self):
        fd = os.open(self.lock_file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise RuntimeError('Another launcher command is in progress; try again when it finishes')
            yield
        finally: os.close(fd)

    def state(self):
        if not self.state_file.exists():
            return None
        try:
            with self.state_file.open() as stream: return json.load(stream)
        except (ValueError, OSError):
            return None

    def save(self, value):
        temporary = self.runtime/f'.{self.port}-{os.getpid()}.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream: json.dump(value, stream, indent=2); stream.write('\n')
        os.replace(temporary, self.state_file)

    def current(self):
        current = listener(self.port)
        saved = self.state()
        if current:
            same = saved and saved.get('identity') == current
            return {**(saved if same else {}), 'identity': current, 'running': True, 'managed': bool(same)}
        # A retiring process may have closed its listening socket before its worker exits.
        if saved and (process_info(saved['identity']['pid']) == saved['identity'] or any(process_info(w['pid']) == w for w in saved.get('workers', []))):
            return {**saved, 'running': True, 'retiring': True}
        return {'running': False, 'lastLog': saved.get('log') if saved else None}

    def stop(self):
        current = self.current()
        if not current['running']:
            return {'running': False, 'message': 'Web server is already stopped.'}
        identity = current['identity']; pid = identity['pid']
        if not is_our_server(process_info(pid), process_cwd(pid)) or process_info(pid) != identity:
            raise RuntimeError('Process identity changed; nothing stopped')
        workers = [info for child in children(pid) if (info := process_info(child))]
        # Also record an older manually launched server, so an incomplete shutdown cannot
        # be mistaken for a free port by a subsequent start command.
        self.save({**current, 'identity': identity, 'workers': workers})
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic()+25
        while time.monotonic() < deadline:
            alive = process_info(pid) == identity
            worker_alive = any(process_info(w['pid']) == w for w in workers)
            if not alive and not worker_alive:
                for child in list(self.spawned):
                    if child.pid == pid:
                        child.wait(timeout=1);self.spawned.remove(child)
                if listener(self.port):
                    raise RuntimeError('Another server appeared during shutdown; no replacement started')
                return {'running': False, 'message': f'Stopped CNC web server (PID {pid}).'}
            time.sleep(.1)
        raise RuntimeError('Server or worker did not exit cleanly; replacement refused. No force-kill was sent. Inspect the log; use the physical stop if movement persists.')

    def start(self, demo=False):
        current = self.current()
        if current['running']:
            if current.get('retiring'):
                raise RuntimeError('The previous server is still shutting down; no second server started')
            if current.get('managed') and current.get('demo') != demo:
                raise RuntimeError('Server is running in a different mode; use restart with the intended --demo option')
            return {**current, 'message': 'Web server is already running.'}
        if self.port == load_config(demo=demo)['ugsPort']:
            raise ValueError('The web port must differ from the UGS port')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
        log = self.runtime/f'{self.port}-{stamp}.log'
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        command = [sys.executable, str(SERVER), '--port', str(self.port)] + (['--demo'] if demo else [])
        with os.fdopen(fd, 'w') as stream:
            child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                     start_new_session=True, close_fds=True)
        self.spawned.append(child)
        identity = process_info(child.pid)
        if identity is None:
            raise RuntimeError(f'Server exited on startup. Log: {log}')
        self.save({'identity': identity, 'log': str(log), 'demo': demo})
        try:
            deadline = time.monotonic()+10
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise RuntimeError(f'Server exited with code {child.returncode}. Log: {log}')
                text = log.read_text()
                match = re.search(rf'^Open (http://127\.0\.0\.1:{self.port}/#[A-Za-z0-9_-]+)$', text, re.M)
                active = listener(self.port) if match else None
                if active and active['pid'] == child.pid:
                    identity = active
                    value = {'identity': identity, 'log': str(log), 'demo': demo, 'url': match[1]}
                    self.save(value)
                    return {**value, 'running': True, 'managed': True, 'message': 'Web server started; controls are not armed.'}
                time.sleep(.1)
            raise RuntimeError(f'Server startup timed out. Log: {log}')
        except BaseException:
            # This is the child we just created; startup never arms or contacts UGS.
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=25)
                except subprocess.TimeoutExpired: pass
            raise

    def logs(self, lines=40):
        state = self.state()
        if not state or not state.get('log'):
            raise RuntimeError('No managed log yet. Restart once with this launcher to capture logs.')
        log = Path(state['log'])
        if log.parent != self.runtime or log.is_symlink():
            raise RuntimeError('Unexpected log path')
        return '\n'.join(log.read_text().splitlines()[-lines:])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('start','stop','restart','status','logs'))
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--demo', action='store_true', help='Start with no hardware access')
    parser.add_argument('--lines', type=int, default=40, help='Lines shown by logs')
    parser.add_argument('--json', action='store_true', help='Machine-readable output')
    args = parser.parse_args()
    try:
        if not 1 <= args.lines <= 1000: raise ValueError('--lines must be 1–1000')
        manager = Manager(args.port)
        with manager.locked():
            if args.action == 'logs':
                print(manager.logs(args.lines)); return
            if args.action == 'restart': manager.stop(); result = manager.start(args.demo)
            elif args.action == 'stop': result = manager.stop()
            elif args.action == 'start': result = manager.start(args.demo)
            else: result = manager.current()
        if args.json:
            print(json.dumps(result)); return
        print(result.get('message') or ('Web server is running.' if result['running'] else 'Web server is stopped.'))
        if result.get('identity'): print('PID:', result['identity']['pid'])
        if result.get('url'): print('Open:', result['url'])
        elif result['running']: print('Use restart to get a fresh browser link and managed log.')
        if result.get('log'): print('Log:', result['log'])
    except (ValueError, RuntimeError, OSError) as error:
        parser.exit(1, str(error)+'\n')


if __name__ == '__main__': main()
