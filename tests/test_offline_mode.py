"""Preparation with real source text and disposable storage, without any UGS access."""
import copy
from contextlib import ExitStack, contextmanager
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import cnc_map_web as web
import surface_config as configuration
from pcb_workspace import Workspace


SOURCE = 'G21 G90 G17 G94 G54\nM5\nG0 Z5\nG0 X0 Y0\nM3 S500\nG1 Z-0.1 F10\nG1 X10 F80\nY10\nX0\nY0\nG0 Z5\nM5\nM2\n'
MACHINE_ACTIONS = (
    'arm', 'diagnostics', 'status', 'connect', 'ports', 'settings', 'read-machine',
    'jog', 'jog-hold', 'jog-pulse', 'jog-release', 'goto', 'capture', 'corner-entry',
    'complete-rectangle', 'reset-corners', 'plan', 'scan', 'probe-mode', 'reply',
    'new-session', 'surface-import', 'pcb-capture', 'pcb-stock-from-area',
    'pcb-export', 'pcb-map-job', 'pcb-generate', 'future-machine-action',
)


@contextmanager
def no_machine_io():
    """Fail on subprocess or socket use, even if a diagnostic catches the error."""
    with ExitStack() as stack:
        mocks = []
        for target, names in ((web, ('snapshot', 'save_plan')),
                              (web.subprocess, ('Popen', 'run', 'check_output')),
                              (socket, ('socket', 'create_connection'))):
            for name in names:
                mocks.append(stack.enter_context(patch.object(target, name,
                    side_effect=AssertionError('Machine I/O forbidden: '+name))))
        yield
        for mocked in mocks:
            mocked.assert_not_called()


class OfflinePreparationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.enterContext(patch.object(configuration, 'ROOT', self.root))
        self.real_data = self.root/'machine-measurements'
        self.real_data.mkdir()
        self.marker = self.real_data/'surface.xyz'
        self.marker.write_text('existing real measurements\n')
        self.machine_config = self.root/'machine.json'
        self.machine_config.write_text(json.dumps({'dataDir': str(self.real_data)}))
        self.enterContext(patch.dict(os.environ, {'CNC_BUILDMASTER_CONFIG': str(self.machine_config)}))
        # Invalid real configuration is intentionally ignored, not repaired or simulated.
        with no_machine_io(), patch.object(Path, 'read_text', side_effect=AssertionError('Configuration read')):
            self.c = web.Controller(offline=True)
        self.addCleanup(setattr, self.c, 'closed', True)
        self.c.authenticate(self.c.token, 'offline-test')

    def action(self, action, body=None, controller=None):
        c = controller or self.c
        return c.perform(action, {'pcbRevision': c.pcb.revision, **(body or {})},
                         session_id=c.data['sessionId'])

    def http(self, action, body=None, method='POST', headers=None):
        """Exercise actual authenticated handlers without opening any socket."""
        handler = web.Handler.__new__(web.Handler)
        handler.server = SimpleNamespace(controller=self.c, host_header='127.0.0.1:8765')
        handler.path = '/api/'+action
        body = json.dumps({'sessionId': self.c.data['sessionId'],
                           'pcbRevision': self.c.pcb.revision, **(body or {})}).encode()
        handler.headers = {'Host': handler.server.host_header, 'Content-Type': 'application/json',
                           'Authorization': 'Bearer '+self.c.token, 'X-Client-ID': 'offline-test',
                           'Content-Length': str(len(body)), **(headers or {})}
        handler.rfile = io.BytesIO(body)
        handler.send = Mock()
        (handler.do_POST if method == 'POST' else handler.do_GET)()
        handler.send.assert_called_once()
        return handler.send.call_args.args[:2]

    def prepare(self):
        self.action('pcb-import', {'files': [{'name': 'outline.nc', 'source': SOURCE}]})
        settings = self.c.pcb_public()
        settings.update(name='Offline board', boardRevision='r01')
        settings['stock'].update(width=60, height=50, thickness=1.2)
        settings['placement'].update(x=15, y=12)
        self.action('pcb-configure', {'settings': settings})
        self.action('pcb-operation', {'id': self.c.pcb.operations[0]['id'], 'role': 'outline',
                                     'tool': 'Declared cutter', 'diameter': .8})
        self.action('pcb-workflow', {'settings': {'material': 'pcb', 'intent': 'profile',
                                                'sourceCompensation': 'none'}})
        for label, design, entered in [('A', [0, 0], [15, 12]), ('B', [10, 0], [25, 12]),
                                       ('C', [0, 10], [15, 22])]:
            self.action('pcb-reference', {'label': label, 'design': design, 'machine': entered,
                                         'session': self.c.data['sessionId']})
        self.action('pcb-solve')

    def test_snapshot_has_no_machine_configuration_or_simulated_position(self):
        with no_machine_io():
            for route in ('state', 'report', 'pcb'):
                code, value = self.http(route, method='GET')
                self.assertEqual(code, 200)
                self.assertEqual(value['mode'], 'offline')
                self.assertTrue(value['offline'])
                self.assertTrue(value['planningOnly'])
            state = self.c.state()
            self.assertFalse(state['demo'])
            self.assertFalse(state['armed'])
            self.assertFalse(state['nativeJog'])
            self.assertEqual(state['speeds'], {})
            self.assertIsNone(state['status'])
            self.assertIsNone(state['configuration']['ugsPort'])
            self.assertIsNone(state['configuration']['puckHeight'])
            self.assertEqual(state['configuration']['feeds'], {})
            self.assertEqual(state['configuration']['name'], 'Offline preparation')
            self.assertFalse(state['configuration']['configured'])
            self.assertNotIn('baseline', self.c.profile)
            self.assertNotIn('machine', self.c.profile)
            self.assertIn('CNC_BUILDMASTER_CONFIG', state['machineUnavailableReason'])
            self.assertFalse(self.c.jobs_dir.parent.exists())

    def test_all_machine_endpoints_fail_closed_even_if_armed_state_is_forged(self):
        with no_machine_io():
            for forged in (False, True):
                self.c.data.update(armed=forged, phase='complete' if forged else 'setup')
                before = self.c.state()
                for action in MACHINE_ACTIONS:
                    with self.subTest(action=action, forged=forged):
                        code, result = self.http(action, {'confirmed': True, 'reviewed': True})
                        self.assertEqual(code, 400)
                        self.assertIn('Offline preparation', result['error'])
                        self.assertIn('restart without --offline', result['error'])
                        self.assertEqual(self.c.state(), before)
            self.assertIsNone(self.c.child)
            self.assertIsNone(self.c.monitor)
            self.assertIsNone(self.c.monitor_thread)

    def test_internal_machine_entrypoints_also_fail_without_io(self):
        with no_machine_io():
            for function, args in [(self.c.read_machine, ()), (self.c.checked, ()),
                                   (self.c.diagnostics, ()), (self.c.start_monitor, ()),
                                   (self.c.launch, (['node', 'ugs_puck_map.mjs'],)),
                                   (self.c.hold_control, ('jog-pulse', {})),
                                   (self.c.perform_pcb, ('pcb-generate', {})),
                                   (self.c.demo_next, ()), (self.c.demo_copper, ())]:
                with self.subTest(function=function.__name__), self.assertRaisesRegex(ValueError, 'Offline preparation'):
                    function(*args)

    def test_connection_gets_cannot_bypass_the_offline_action_guard(self):
        with no_machine_io():
            for route in ('diagnostics', 'status', 'settings', 'ports', 'machine/status', 'surface-import'):
                with self.subTest(route=route):
                    code, result = self.http(route, method='GET')
                    self.assertEqual(code, 400)
                    self.assertIn('Offline preparation', result['error'])
                    self.assertIn('CNC_BUILDMASTER_CONFIG', result['error'])

    def test_import_placement_draft_alignment_save_and_reopen_are_planning_only(self):
        with no_machine_io():
            self.prepare()
            preview = self.c.pcb_state()
            self.assertEqual(preview['alignment']['status'], 'draft')
            self.assertIsNone(preview['alignment']['session'])
            self.assertFalse(preview['canExport'])
            self.assertTrue(preview['operations'][0]['fits'])
            self.assertTrue(preview['operations'][0]['depthOk'])
            self.assertTrue(preview['operations'][0]['paths'])
            self.assertFalse(preview['guide']['measured'])
            self.assertFalse(preview['guide']['cuttingReleased'])
            saved = self.action('pcb-save')
            path = Path(saved['savedPath'])
            self.assertEqual(path.parent, self.root/'data'/'offline-preparation'/'jobs')
            package = json.loads(path.read_text())
            self.assertTrue(package['planningOnly'])
            self.assertEqual(package['mode'], 'offline')
            self.assertFalse(package['executionReleased'])
            self.assertFalse(package['job']['canExport'])
            self.assertEqual(package['files'][0]['source'], SOURCE)
            reopened = web.Controller(offline=True)
            self.addCleanup(setattr, reopened, 'closed', True)
            self.assertEqual(reopened.pcb_state()['savedJobs'][0]['id'], path.name)
            self.action('pcb-load', {'savedId': path.name}, reopened)
            restored = reopened.pcb_state()
            self.assertEqual(restored['name'], 'Offline board')
            self.assertEqual(restored['stock'], preview['stock'])
            self.assertEqual(restored['placement'], preview['placement'])
            self.assertEqual(reopened.pcb.operations[0]['source'], SOURCE)
            self.assertEqual(restored['workflow']['sourceCompensation'], 'none')
            self.assertIsNone(restored['alignment'])
            for point in restored['references'].values():
                self.assertIsNone(point['machine'])
                self.assertIsNone(point['session'])
            self.assertFalse(restored['canExport'])
            self.assertFalse(reopened.state()['armed'])
            # The standard loader can later read this package without restoring authority.
            real_candidate = Workspace.from_package(package)
            self.assertFalse(real_candidate.valid_alignment(self.c.data['sessionId']))
            self.assertIsNone(real_candidate.alignment)
        self.assertEqual(self.marker.read_text(), 'existing real measurements\n')
        self.assertEqual(list(self.real_data.iterdir()), [self.marker])

    def test_uploaded_claims_cannot_restore_machine_references_or_approvals(self):
        with no_machine_io():
            self.prepare()
            package = self.action('pcb-save')['package']
            package.update(planningOnly=False, executionReleased=True, mode='real')
            package['job']['canExport'] = True
            package['job']['alignment'].update(status='captured', session=self.c.data['sessionId'])
            for point in package['job']['references'].values():
                point['session'] = self.c.data['sessionId']
            self.action('pcb-load', {'package': package})
            self.assertIsNone(self.c.pcb.alignment)
            self.assertFalse(self.c.pcb_state()['canExport'])
            self.assertFalse(self.c.state()['armed'])
            self.assertTrue(self.action('pcb-save')['package']['planningOnly'])

    def test_stop_is_harmless_and_planning_remains_available(self):
        with no_machine_io():
            self.prepare()
            before = copy.deepcopy(self.c.pcb_state())
            self.action('stop')
            self.c.stop('Web server closing')
            self.assertEqual(before, self.c.pcb_state())
            self.assertFalse(self.c.stopped)
            self.assertIsNone(self.c.state()['error'])
            self.assertIn('no stop command was sent', self.c.state()['logs'][-1])
            self.assertTrue(self.action('pcb-save')['savedPath'])

    def test_declared_geometry_and_recipe_calculations_need_no_machine_baseline(self):
        tool = {'diameter': 2, 'cuttingLength': 4, 'length': 10, 'holderDiameter': 8}
        fixture = {'bounds': {'x': [-30, 50], 'y': [-30, 50], 'z': [-10, 40]},
                   'clearance': 0, 'clamps': []}
        samples = [{'spindle': [0, 0, 5], 'camera': [-3, 2, 5]},
                   {'spindle': [10, 0, 5], 'camera': [7, 2, 5]}]
        check = {'spindle': [0, 10, 5], 'camera': [-3, 12, 5]}
        recipe = {'version': 1, 'name': 'Planning trial', 'material': 'Synthetic material', 'tool': tool,
                  'parameters': {'feed': 100, 'plungeFeed': 20, 'depth': .3, 'passDepth': .1,
                                 'clearZ': 6, 'spindleCommand': 500},
                  'observations': []}
        with no_machine_io():
            self.prepare()
            self.action('pcb-fixture', {'fixture': fixture})
            geometric = self.action('pcb-fixture-check', {'tool': tool})
            self.assertEqual(geometric['physicalQualification'], 'not-assessed')
            self.assertTrue(geometric['planningOnly'])
            self.assertFalse(geometric['machineConfigurationVerified'])
            camera = self.action('pcb-camera', {'samples': samples, 'check': check,
                                               'commonZ': 5, 'tolerance': .05})
            self.assertTrue(camera['planningOnly'])
            diameter = self.action('pcb-vbit', {'tipDiameter': .1, 'angle': 30,
                                              'depth': .1, 'maxDiameter': 3})
            self.assertGreater(diameter['diameter'], .1)
            self.assertTrue(diameter['planningOnly'])
            recorded = self.action('pcb-recipe', {'recipe': recipe})
            self.assertTrue(recorded['planningOnly'])
            saved = self.action('pcb-save')['package']
            self.action('pcb-load', {'package': saved})
            self.assertEqual(self.c.pcb.workflow['fixture'], fixture)
            self.assertEqual(len(self.c.pcb.workflow['recipes']), 1)
            self.assertIsNone(self.c.pcb.workflow['camera'])
            self.assertNotIn('baseline', self.c.profile)

    def test_storage_symlinks_and_path_traversal_are_refused(self):
        with no_machine_io():
            self.c.jobs_dir.parent.mkdir(parents=True)
            self.c.jobs_dir.symlink_to(self.real_data, target_is_directory=True)
            for call in (self.c.pcb_state, self.c.save_pcb_package,
                         lambda: web.Controller(offline=True)):
                with self.assertRaisesRegex(ValueError, 'symbolic link'):
                    call()
            self.c.jobs_dir.unlink()
            self.c.jobs_dir.mkdir()
            linked = self.c.jobs_dir/'real.pcb-job.json'
            linked.symlink_to(self.machine_config)
            self.assertEqual(self.c.pcb_state()['savedJobs'], [])
            for name in ('../machine.json', str(self.machine_config), linked.name):
                with self.assertRaises(ValueError):
                    self.action('pcb-load', {'savedId': name})

    def test_authentication_and_revision_checks_remain_required(self):
        with no_machine_io():
            for headers in ({'Authorization': 'Bearer invalid'}, {'Host': 'other.local'},
                            {'Origin': 'https://other.local'}, {'X-Client-ID': 'other-tab'}):
                code, _ = self.http('pcb-save', headers=headers)
                self.assertEqual(code, 403)
            with self.assertRaisesRegex(ValueError, 'PCB job changed'):
                self.action('pcb-save', {'pcbRevision': -1})
            with self.assertRaisesRegex(ValueError, 'old setup'):
                self.c.perform('pcb-save', {}, session_id='old-session')
            self.assertFalse(self.c.jobs_dir.exists())

    def test_configuration_modes_are_exclusive_and_real_default_stays_guarded(self):
        with no_machine_io():
            with self.assertRaisesRegex(ValueError, 'mutually exclusive'):
                web.Controller(demo=True, offline=True)
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(ValueError, 'CNC_BUILDMASTER_CONFIG'):
                    web.Controller()
            self.assertFalse(self.c.jobs_dir.exists())


if __name__ == '__main__':
    unittest.main()
