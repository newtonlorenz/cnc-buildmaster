"""Agent capability, concurrency and operator-gate tests. No UGS or live server."""
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cnc_map_web as web
import surface_config
from agent_api import AgentError, Discovery, TOOLS
from test_offline_mode import no_machine_io, SOURCE


class AgentApiTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (self.root/'config').mkdir()
        (self.root/'config/example.json').write_bytes((surface_config.ROOT/'config/example.json').read_bytes())
        self.enterContext(patch.object(surface_config, 'ROOT', self.root))
        self.c = web.Controller(offline=True)
        self.g = self.c.agent
        self.addCleanup(setattr, self.c, 'closed', True)

    def demo(self):
        self.c = web.Controller(demo=True)
        self.g = self.c.agent
        self.addCleanup(setattr, self.c, 'closed', True)
        self.c.authenticate(self.c.token, 'human-browser')

    def args(self, action, parameters=None, request_id='request-0001', request=False):
        result = dict(action=action, parameters=parameters or {}, requestId=request_id,
                      sessionId=self.c.data['sessionId'], pcbRevision=self.c.pcb.revision)
        if request: result['reason'] = 'Move towards the first corner after checking clearance.'
        return result

    def http(self, path, body=None, *, browser=False, headers=None):
        handler = web.Handler.__new__(web.Handler)
        handler.server = SimpleNamespace(controller=self.c, host_header='127.0.0.1:8765')
        handler.path = '/api/' + path
        encoded = json.dumps(body).encode() if body is not None else b''
        handler.headers = {'Host': handler.server.host_header, 'Content-Type': 'application/json',
                           'Authorization': 'Bearer ' + (self.c.token if browser else self.g.token),
                           'X-Client-ID': 'human-browser', 'Content-Length': str(len(encoded)), **(headers or {})}
        handler.rfile = io.BytesIO(encoded)
        handler.send = Mock()
        (handler.do_POST if body is not None else handler.do_GET)()
        handler.send.assert_called_once()
        return handler.send.call_args.args[:2]

    def queue(self, action='arm', params=None, request_id='request-0001'):
        return self.g.call('buildmaster_request_action', self.args(action, params, request_id, True))

    def test_observation_is_no_io_no_owner_no_heartbeat_no_credentials(self):
        with no_machine_io():
            capabilities = self.g.capabilities()
            data = self.g.call('buildmaster_status', {})
            job = self.g.call('buildmaster_job', {})
        self.assertIsNone(self.c.owner)
        self.assertEqual(self.c.last_seen, 0)
        self.assertFalse(data['heartbeatRenewed'])
        self.assertNotIn(self.c.token, json.dumps([capabilities, data, job]))
        self.assertNotIn(self.g.token, json.dumps([capabilities, data, job]))
        self.assertNotEqual(self.g.token, self.c.token)
        self.assertEqual(len(capabilities['tools']), 6)
        self.assertTrue(all(t['inputSchema']['additionalProperties'] is False for t in TOOLS))

    def test_http_tokens_are_not_interchangeable_and_origin_remains_checked(self):
        self.assertEqual(self.http('agent/capabilities')[0], 200)
        self.assertEqual(self.http('agent/capabilities', browser=True)[0], 403)
        self.assertEqual(self.http('state')[0], 403)
        for headers in ({'Origin':'https://untrusted.example'}, {'Host':'untrusted.example'}, {'Sec-Fetch-Site':'cross-site'}):
            self.assertEqual(self.http('agent/capabilities', headers=headers)[0], 403)
        self.assertIsNone(self.c.owner)
        self.assertEqual(self.c.last_seen, 0)

    def test_preparation_requires_explicit_access_and_is_serialised_with_browser(self):
        args = self.args('pcb-import', {'files':[{'name':'board.nc', 'source':SOURCE}]})
        with no_machine_io():
            self.assertEqual(self.g.call('buildmaster_prepare', args)['error']['code'], 'ACCESS_DISABLED')
            self.g.access(True)
            args['requestId'] = 'request-0002'
            record = self.g.call('buildmaster_prepare', args)
            self.assertEqual(record['status'], 'completed')
            self.assertEqual(len(self.c.pcb.operations), 1)
            with self.assertRaisesRegex(ValueError, 'Pause agent preparation'):
                self.c.perform('pcb-new', {'pcbRevision':self.c.pcb.revision}, self.c.data['sessionId'])
            self.g.access(False)
            self.c.perform('pcb-new', {'pcbRevision':self.c.pcb.revision}, self.c.data['sessionId'])
        self.assertFalse(self.c.pcb.operations)

    def test_retry_same_request_never_duplicates_and_conflicting_reuse_fails(self):
        self.g.access(True)
        args = self.args('pcb-import', {'files':[{'name':'board.nc', 'source':SOURCE}]})
        first = self.g.call('buildmaster_prepare', args)
        again = self.g.call('buildmaster_prepare', args)
        self.assertEqual(first, again)
        self.assertEqual(len(self.c.pcb.operations), 1)
        altered = copy.deepcopy(args); altered['parameters']['files'][0]['name'] = 'other.nc'
        with self.assertRaisesRegex(AgentError, 'different arguments'):
            self.g.call('buildmaster_prepare', altered)

    def test_agent_cannot_bypass_readiness_raw_commands_or_approval(self):
        self.demo()
        for action in ('reply','jog-hold','jog-pulse','jog-release','spindle','gcode','connect','pcb-export','agent-decide'):
            with self.subTest(action=action), self.assertRaises(AgentError):
                self.g.call('buildmaster_request_action', self.args(action, {}, request=True))
        with self.assertRaises(AgentError):
            self.g.call('buildmaster_request_action', self.args('arm', {'confirmed':True}, request=True))
        self.assertFalse(self.c.data['armed'])
        self.assertEqual(self.http('agent-decide', {'sessionId':self.c.data['sessionId'], 'approve':True})[0], 403)

    def test_operator_approval_is_one_use_and_submission_does_not_claim_completion(self):
        self.demo()
        queued = self.queue()
        self.assertEqual(queued['status'], 'pending')
        self.assertFalse(self.c.data['armed'])
        with self.assertRaises(AgentError): self.g.decide(queued['requestId'], True, False)
        decision = self.g.decide(queued['requestId'], True, True)
        self.assertEqual(decision['status'], 'dispatched')
        self.assertFalse(decision['result']['executionComplete'])
        self.assertTrue(self.c.data['armed'])
        with self.assertRaises(AgentError): self.g.decide(queued['requestId'], True, True)

    def test_only_one_concurrent_decision_dispatches(self):
        self.demo(); self.queue()
        barrier = threading.Barrier(3); outcomes = []
        def approve():
            barrier.wait()
            try: outcomes.append(self.g.decide('request-0001', True, True)['status'])
            except AgentError as error: outcomes.append(error.code)
        threads = [threading.Thread(target=approve) for _ in range(2)]
        for thread in threads: thread.start()
        barrier.wait()
        for thread in threads: thread.join(5); self.assertFalse(thread.is_alive())
        self.assertEqual(sorted(outcomes), ['ALREADY_DECIDED', 'dispatched'])

    def test_changed_job_session_position_and_expiry_invalidate_requests(self):
        for kind in ('job','session','position','expiry'):
            with self.subTest(kind=kind):
                self.demo(); self.queue()
                if kind == 'job': self.c.pcb.changed()
                elif kind == 'session': self.c.data['sessionId'] = 'new-session'
                elif kind == 'position': self.c.data['status'] = {'machineCoord':{'x':10,'y':0,'z':0}}
                else: self.g.records['request-0001']['_deadline'] = 0
                if kind == 'expiry':
                    with self.assertRaises(AgentError): self.g.decide('request-0001', True, True)
                    self.assertEqual(self.g.call('buildmaster_request_status', {'requestId':'request-0001'})['status'], 'expired')
                else:
                    self.assertEqual(self.g.decide('request-0001', True, True)['status'], 'stale')
                self.assertFalse(self.c.data['armed'])

    def test_stop_bypasses_operation_lock_revokes_access_and_pending_requests(self):
        self.demo(); self.queue(); self.g.access(True)
        with self.c.action_lock:
            result = self.g.call('buildmaster_stop', {'reason':'Operator wants to stop'})
        self.assertTrue(result['stopRequested'])
        self.assertFalse(result['physicalStopVerified'])
        self.assertFalse(self.g.prepare_enabled)
        self.assertEqual(self.g.records['request-0001']['status'], 'rejected')
        self.assertTrue(self.c.stopped)

    def test_agent_observation_does_not_prevent_browser_watchdog_stop(self):
        self.demo(); self.c.perform('arm', {'confirmed':True}, self.c.data['sessionId'])
        self.c.last_seen = time.monotonic() - 4
        for _ in range(4): self.g.call('buildmaster_status', {})
        deadline = time.monotonic() + 2
        while not self.c.stopped and time.monotonic() < deadline: time.sleep(.02)
        self.assertTrue(self.c.stopped)
        self.assertIn('heartbeat', self.c.data['error'])

    def test_offline_preparation_save_and_compact_job_hide_raw_sources_and_paths(self):
        self.g.access(True)
        with no_machine_io():
            self.g.call('buildmaster_prepare', self.args('pcb-import', {'files':[{'name':'board.nc','source':SOURCE}]}))
            result = self.g.call('buildmaster_prepare', self.args('pcb-save', request_id='request-0002'))
            job = self.g.call('buildmaster_job', {})['job']
        self.assertTrue(Path(result['result']['savedPath']).is_file())
        self.assertNotIn('package', result['result'])
        self.assertNotIn('paths', job['operations'][0])
        self.assertNotIn('source', job['operations'][0])
        self.assertFalse(job['canExport'])
        with self.assertRaises(AgentError): self.queue()

    def test_preparation_cannot_gain_access_during_active_setup(self):
        self.demo(); self.c.perform('arm', {'confirmed':True}, self.c.data['sessionId'])
        with self.assertRaises(AgentError): self.g.access(True)
        self.assertFalse(self.g.prepare_enabled)

    def test_discovery_is_private_stale_cleanup_cannot_remove_replacement(self):
        runtime = self.root/'runtime'
        with patch.dict(os.environ, {'CNC_MAP_RUNTIME_DIR':str(runtime)}):
            first = Discovery(self.g, 8766, self.root)
            self.assertEqual(first.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(runtime.stat().st_mode & 0o777, 0o700)
            content = json.loads(first.path.read_text())
            self.assertEqual(content['apiBase'], 'http://127.0.0.1:8766')
            other = web.Controller(offline=True)
            second = Discovery(other.agent, 8766, self.root)
            first.close(); self.assertTrue(second.path.exists())
            second.close(); self.assertFalse(second.path.exists())
            target = self.root/'sensitive'; target.write_text('keep')
            (runtime/'agent-8766.json').symlink_to(target)
            with self.assertRaises(AgentError): Discovery(self.g, 8766, self.root)
            self.assertEqual(target.read_text(), 'keep')
            runtime.chmod(0o755)
            with self.assertRaises(AgentError): Discovery(self.g, 8767, self.root)

    def test_stop_wins_over_inflight_access_enable(self):
        def idle_with_stop():
            self.g.call('buildmaster_stop', {'reason':'Stop during permission change'})
            return True
        with patch.object(self.g, 'idle', side_effect=idle_with_stop):
            with self.assertRaisesRegex(AgentError, 'Stop occurred'):
                self.g.access(True, expected_session=self.c.data['sessionId'])
        self.assertFalse(self.g.prepare_enabled)

    def test_access_rechecks_session_after_handler_precheck(self):
        self.demo()
        old_session = self.c.data['sessionId']
        original = self.g.access
        def access_after_reset(enabled, expected_session=None):
            self.c.data['sessionId'] = 'replaced-between-handler-and-lock'
            return original(enabled, expected_session)
        with patch.object(self.g, 'access', side_effect=access_after_reset):
            code, value = self.http('agent-access', {'sessionId':old_session,'enabled':True}, browser=True)
        self.assertEqual(code, 400)
        self.assertIn('Session changed', value['error'])
        self.assertFalse(self.g.prepare_enabled)

    def test_stop_during_new_session_dispatch_cannot_be_undone(self):
        self.demo()
        self.c.data['phase'] = 'complete'
        original_session = self.c.data['sessionId']
        self.queue('new-session')
        original = self.c.close_monitor
        stop_once = True
        def close_with_stop():
            nonlocal stop_once
            original()
            if stop_once:
                stop_once = False
                self.c.stop('Stop while retiring completed observer')
        with patch.object(self.c, 'close_monitor', side_effect=close_with_stop):
            result = self.g.decide('request-0001', True, True)
        self.assertEqual(result['status'], 'interrupted')
        self.assertTrue(self.c.stopped)
        self.assertEqual(self.c.data['phase'], 'stopped')
        self.assertEqual(self.c.data['sessionId'], original_session)

    def test_subprocess_timeout_is_a_terminal_record_not_perpetual_running(self):
        self.demo(); self.queue()
        # Enter the real branch only with the first and sole process call blocked.
        self.c.demo = False
        with patch.object(web.subprocess, 'run', side_effect=web.subprocess.TimeoutExpired('test-only', 20)) as process:
            result = self.g.decide('request-0001', True, True)
        self.assertEqual(process.call_count, 1)
        self.assertEqual(result['status'], 'interrupted')
        self.assertFalse(result['error']['retryable'])
        self.assertTrue(self.c.stopped)
        self.assertEqual(self.g.call('buildmaster_request_status', {'requestId':'request-0001'}), result)

    def test_http_operator_access_and_decision_retain_session_guard(self):
        self.demo(); self.queue()
        session = self.c.data['sessionId']
        self.assertEqual(self.http('agent-access', {'sessionId':'old', 'enabled':True}, browser=True)[0], 400)
        code, result = self.http('agent-decide', {'sessionId':session,'requestId':'request-0001','approve':True,'operatorConfirmed':True}, browser=True)
        self.assertEqual(code, 200)
        self.assertEqual(result['result']['status'], 'dispatched')


if __name__ == '__main__': unittest.main()
