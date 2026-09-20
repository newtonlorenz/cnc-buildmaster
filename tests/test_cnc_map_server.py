import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import cnc_map_server as server


def unused_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); return sock.getsockname()[1]


class ServerManagerTests(unittest.TestCase):
    def test_web_startup_does_not_depend_on_reverse_dns(self):
        from cnc_map_web import LocalHTTPServer, Handler
        with patch('socket.getfqdn', side_effect=AssertionError('Reverse DNS is unnecessary')):
            with LocalHTTPServer(('127.0.0.1', 0), Handler) as http:
                self.assertEqual(http.server_name, '127.0.0.1')
                self.assertGreater(http.server_port, 0)

    def test_identity_excludes_other_processes_and_workspaces(self):
        info={'uid':os.getuid(),'pid':123,'started':'today','command':f'/usr/bin/python3 {server.SERVER} --port 8765'}
        self.assertTrue(server.is_our_server(info,str(server.ROOT)))
        for command in ['node app.js','java org.netbeans.Main',f'/usr/bin/python3 -c {server.SERVER}', '/usr/bin/python3 /tmp/cnc_map_web.py', f'/usr/bin/python3 {server.SERVER} --unexpected']:
            self.assertFalse(server.is_our_server({**info,'command':command},str(server.ROOT)))
        self.assertFalse(server.is_our_server(info,'/tmp'))
        self.assertFalse(server.is_our_server({**info,'uid':os.getuid()+1},str(server.ROOT)))

    def test_identity_recognises_offline_and_rejects_conflicting_modes(self):
        info = {'uid': os.getuid(), 'pid': 123, 'started': 'today',
                'command': f'/usr/bin/python3 {server.SERVER} --port=8765 --offline'}
        self.assertTrue(server.is_our_server(info, str(server.ROOT)))
        self.assertEqual(server.process_mode(info), {'mode': 'offline', 'offline': True, 'demo': False, 'agentPrepare': False})
        self.assertFalse(server.is_our_server({**info, 'command': info['command']+' --demo'}, str(server.ROOT)))
        with tempfile.TemporaryDirectory() as directory:
            manager = server.Manager(8765, directory)
            with patch.object(server, 'listener', return_value=info):
                self.assertEqual(manager.current()['mode'], 'offline')
                self.assertFalse(manager.current()['managed'])
                with self.assertRaisesRegex(RuntimeError, 'different mode'):
                    manager.start(demo=True)

    def test_cli_rejects_offline_and_demo_before_any_start(self):
        for script, prefix in [('cnc_map_server.py', ['start']), ('cnc_map_web.py', []), ('surface_config.py', [])]:
            result = subprocess.run([sys.executable, str(server.ROOT/'scripts'/script), *prefix,
                                     '--offline', '--demo'], capture_output=True, text=True)
            with self.subTest(script=script):
                self.assertEqual(result.returncode, 2)
                self.assertIn('not allowed with argument', result.stderr)

    def test_start_and_restart_cli_propagate_offline_mode(self):
        for action in ('start', 'restart'):
            manager = MagicMock()
            manager.start.return_value = {'running': True, 'mode': 'offline'}
            with patch.object(server, 'Manager', return_value=manager), \
                 patch.object(sys, 'argv', ['cnc-map', action, '--offline', '--json']), patch('builtins.print'):
                server.main()
            manager.start.assert_called_once_with(demo=False, offline=True, agent_prepare=False)
            self.assertEqual(manager.stop.call_count, int(action == 'restart'))

    def test_offline_lifecycle_without_configuration_is_honest_and_stops_cleanly(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {'CNC_BUILDMASTER_CONFIG': str(Path(directory)/'missing.json')}):
            manager = server.Manager(unused_port(), directory)
            try:
                started = manager.start(offline=True)
                self.assertEqual(started['mode'], 'offline')
                self.assertTrue(started['offline'])
                self.assertFalse(started['demo'])
                self.assertIn('--offline', started['identity']['command'])
                self.assertIn('unavailable', started['message'])
                self.assertEqual(manager.current()['mode'], 'offline')
                self.assertEqual(manager.start(offline=True)['identity'], started['identity'])
                for modes in ({'demo': True}, {}, {'demo': True, 'offline': True}):
                    with self.assertRaises((RuntimeError, ValueError)):
                        manager.start(**modes)
                self.assertIn('OFFLINE preparation', manager.logs())
                self.assertNotIn('UGS mapping', manager.logs())
                self.assertFalse(manager.stop()['running'])
                restarted = manager.start(offline=True)
                self.assertNotEqual(restarted['identity']['pid'], started['identity']['pid'])
                self.assertEqual(restarted['mode'], 'offline')
                self.assertFalse(manager.stop()['running'])
                self.assertFalse(manager.current()['running'])
            finally:
                manager.stop()

    def test_ugs_port_and_unsafe_runtime_refused(self):
        with self.assertRaises(ValueError): server.Manager(8080)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'public';p.mkdir(mode=0o755)
            with self.assertRaises(RuntimeError): server.Manager(8765,p)
            link=Path(d)/'link';link.symlink_to(p,target_is_directory=True)
            with self.assertRaises(RuntimeError): server.Manager(8765,link)

    def test_stale_pid_is_never_signalled(self):
        with tempfile.TemporaryDirectory() as d:
            m=server.Manager(unused_port(),d)
            m.save({'identity':{'pid':os.getpid(),'uid':os.getuid(),'started':'old','command':'obsolete'},'log':None})
            with patch.object(server.os,'kill',side_effect=AssertionError('Should not signal stale PID')):
                self.assertFalse(m.stop()['running'])

    def test_other_listener_refused(self):
        with tempfile.TemporaryDirectory() as d, socket.socket() as sock:
            sock.bind(('127.0.0.1',0));sock.listen()
            m=server.Manager(sock.getsockname()[1],d)
            with patch.object(server.os,'kill',side_effect=AssertionError('Unrelated listener')):
                with self.assertRaises(RuntimeError): m.stop()
                with self.assertRaises(RuntimeError): m.start(demo=True)

    def test_start_reuses_restart_replaces_stop_exits_demo_process(self):
        with tempfile.TemporaryDirectory() as d:
            m=server.Manager(unused_port(),d)
            try:
                with m.locked():
                    a=m.start(demo=True)
                    b=m.start(demo=True)
                    self.assertEqual(a['identity'],b['identity'])
                    self.assertIn('/#',a['url'])
                    self.assertEqual(Path(a['log']).stat().st_mode & 0o777,0o600)
                    self.assertEqual(m.state_file.stat().st_mode & 0o777,0o600)
                    with self.assertRaises(RuntimeError):m.start(demo=False)
                    self.assertFalse(m.stop()['running'])
                    c=m.start(demo=True)
                    self.assertNotEqual(a['identity']['pid'],c['identity']['pid'])
                    self.assertNotEqual(a['url'],c['url'])
                    self.assertIn('DEMO',m.logs())
                    self.assertFalse(m.stop()['running'])
                    self.assertFalse(m.stop()['running'])
            finally:
                m.stop()

    def test_adopts_and_stops_legacy_foreground_demo(self):
        with tempfile.TemporaryDirectory() as d:
            port=unused_port();m=server.Manager(port,d)
            p=subprocess.Popen([sys.executable,str(server.SERVER),'--demo','--port',str(port)],cwd=server.ROOT,stdout=subprocess.PIPE,text=True)
            try:
                self.assertTrue(p.stdout.readline().startswith('Open '))
                self.assertFalse(m.current()['managed'])
                self.assertFalse(m.stop()['running'])
                p.wait(timeout=5)
            finally:
                if p.poll() is None:p.terminate();p.wait(timeout=5)
                p.stdout.close()

if __name__=='__main__':unittest.main()
