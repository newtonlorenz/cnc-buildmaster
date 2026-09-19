import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
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
