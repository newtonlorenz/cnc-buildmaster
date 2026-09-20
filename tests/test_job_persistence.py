"""UTF-8 package limits and atomic recovery saves in disposable offline storage."""
import copy
import errno
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import cnc_map_web as web
import surface_config as configuration
from pcb_workspace import Workspace
from pcb_gcode import MAX_SOURCE


SOURCE = 'G21 G90 G17 G94 G54\nM5\nG0 Z5\nG0 X0 Y0\nM3 S500\nG1 Z-.1 F10\nG1 X10 F80\nY10\nX0\nY0\nG0 Z5\nM5\nM2\n'
FIXTURE = {'bounds': {'x': [-30, 50], 'y': [-30, 50], 'z': [-10, 40]}, 'clearance': 0, 'clamps': []}
RECIPE = {'version': 1, 'name': 'Planning recipe', 'material': 'Synthetic material',
          'tool': {'diameter': 2, 'cuttingLength': 4, 'length': 10, 'holderDiameter': 8},
          'parameters': {'feed': 100, 'plungeFeed': 20, 'depth': .3, 'passDepth': .1,
                         'clearZ': 6, 'spindleCommand': 500}, 'observations': []}


class JobPersistenceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.enterContext(patch.object(configuration, 'ROOT', self.root))
        self.c = web.Controller(offline=True)
        self.addCleanup(setattr, self.c, 'closed', True)

    def action(self, action, **body):
        return self.c.perform(action, {'pcbRevision': self.c.pcb.revision, **body},
                              session_id=self.c.data['sessionId'])

    def pending_files(self):
        return list(self.c.jobs_dir.iterdir()) if self.c.jobs_dir.exists() else []

    def test_fixture_recipe_and_settings_only_jobs_get_recovery_before_replacement(self):
        for kind in ('fixture', 'recipe', 'settings'):
            with self.subTest(kind=kind):
                self.c.pcb = Workspace()
                if kind == 'fixture':
                    self.action('pcb-fixture', fixture=copy.deepcopy(FIXTURE))
                elif kind == 'recipe':
                    self.action('pcb-recipe', recipe=copy.deepcopy(RECIPE))
                else:
                    settings = self.c.pcb_public()
                    settings.update(name='Settings without files', boardRevision='r02')
                    settings['stock']['thickness'] = 1.6
                    self.action('pcb-configure', settings=settings)
                self.assertFalse(self.c.pcb.operations)
                before = self.c.pcb_public()
                existing = set(self.pending_files())
                self.action('pcb-new')
                added = set(self.pending_files()) - existing
                self.assertEqual(len(added), 1)
                path = added.pop()
                self.assertIn('-recovery-', path.name)
                saved = json.loads(path.read_bytes())
                restored = Workspace.from_package(saved)
                self.assertEqual(restored.name, before['name'])
                self.assertEqual(restored.stock, before['stock'])
                self.assertEqual(restored.workflow, before['workflow'])
                self.assertEqual(self.c.pcb.name, 'Untitled PCB')
                self.assertFalse(self.c.pcb.has_content())

    def test_empty_workspace_needs_no_recovery(self):
        self.action('pcb-new')
        self.assertEqual(self.pending_files(), [])

    def test_unicode_source_near_import_limit_saves_below_reopen_limit(self):
        count = (MAX_SOURCE-len(SOURCE.encode('utf-8'))-2)//2
        source = ';'+'é'*count+'\n'+SOURCE
        self.assertLessEqual(len(source.encode('utf-8')), MAX_SOURCE)
        self.action('pcb-import', files=[{'name': f'outline-{i}.nc', 'source': source} for i in range(4)])
        self.assertLessEqual(sum(len(o['source'].encode('utf-8')) for o in self.c.pcb.operations), 16_000_000)
        saved = self.action('pcb-save')
        path = Path(saved['savedPath'])
        encoded = path.read_bytes()
        self.assertLess(len(encoded), web.MAX_JOB_PACKAGE_BYTES)
        self.assertGreater(len(json.dumps(saved['package']).encode('utf-8')), web.MAX_JOB_PACKAGE_BYTES)
        self.assertEqual(encoded, web.json_bytes(saved['package']))
        self.assertIn('é'.encode('utf-8'), encoded)
        self.assertNotIn(b'\\u00e9', encoded)
        self.c.pcb = Workspace()
        self.action('pcb-load', savedId=path.name)
        self.assertEqual(len(self.c.pcb.operations), 4)
        self.assertTrue(all(o['source'] == source for o in self.c.pcb.operations))
        self.assertFalse(self.c.state()['armed'])
        self.assertFalse(self.c.pcb_public()['canExport'])
        self.assertEqual(self.pending_files(), [path])

    def package_at_limit(self, excess=0):
        package = self.c.pcb.package()
        package.update(mode='offline', offline=True, planningOnly=True, padding='')
        package['job'] = self.c.pcb_public(include_paths=False)
        needed = web.MAX_JOB_PACKAGE_BYTES - len(web.json_bytes(package)) + excess
        package['padding'] = 'é'*(needed//2)+'a'*(needed % 2)
        return package

    def test_encoded_package_accepts_exact_limit_and_rejects_one_extra_byte_before_writing(self):
        package = self.package_at_limit()
        self.assertEqual(len(web.json_bytes(package)), web.MAX_JOB_PACKAGE_BYTES)
        with patch.object(self.c.pcb, 'package', return_value=package):
            saved = self.action('pcb-save')
        path = Path(saved['savedPath'])
        self.assertEqual(path.stat().st_size, web.MAX_JOB_PACKAGE_BYTES)
        self.c.pcb = Workspace()
        self.action('pcb-load', savedId=path.name)
        package = self.package_at_limit(excess=1)
        previous = self.c.pcb_public()
        with patch.object(self.c.pcb, 'package', return_value=package), \
             patch.object(web.tempfile, 'NamedTemporaryFile', side_effect=AssertionError('No partial save')):
            with self.assertRaisesRegex(ValueError, '24 MB UTF-8 limit'):
                self.action('pcb-save')
        self.assertEqual(self.pending_files(), [path])
        self.assertEqual(self.c.pcb_public(), previous)

    def test_partial_write_flush_and_publish_failures_leave_no_artifact_or_saved_state(self):
        original_temporary = web.tempfile.NamedTemporaryFile
        for stage in ('write', 'flush', 'fsync', 'publish'):
            with self.subTest(stage=stage):
                before = self.c.pcb_public()
                def temporary(*args, **kwargs):
                    stream = original_temporary(*args, **kwargs)
                    original_write = stream.write
                    if stage == 'write':
                        def partial(data):
                            original_write(data[:17])
                            raise OSError(errno.ENOSPC, 'Synthetic disk full')
                        stream.write = partial
                    elif stage == 'flush':
                        stream.flush = Mock(side_effect=OSError(errno.ENOSPC, 'Synthetic flush failure'))
                    return stream
                with patch.object(web.tempfile, 'NamedTemporaryFile', side_effect=temporary), \
                     patch.object(web.os, 'fsync', side_effect=OSError('Synthetic fsync failure') if stage == 'fsync' else None), \
                     patch.object(web.os, 'link', side_effect=OSError('Synthetic publish failure') if stage == 'publish' else None):
                    with self.assertRaises(OSError):
                        self.action('pcb-save')
                self.assertEqual(self.pending_files(), [])
                self.assertEqual(self.c.pcb_public(), before)

    def test_publish_sees_complete_temporary_and_never_overwrites_existing_job(self):
        original_link = web.os.link
        seen = []
        def publish(temporary, final):
            self.assertEqual(temporary.parent, final.parent)
            self.assertFalse(final.exists())
            package = json.loads(temporary.read_bytes())
            self.assertEqual(package['format'], 'cnc-pcb-job')
            self.assertEqual(self.c.pcb_state()['savedJobs'], [])
            seen.append(temporary)
            return original_link(temporary, final)
        with patch.object(web.os, 'link', side_effect=publish):
            saved = self.action('pcb-save')
        path = Path(saved['savedPath'])
        self.assertEqual(self.pending_files(), [path])
        self.assertTrue(all(not p.exists() for p in seen))
        before = self.c.pcb_public()
        contents = path.read_bytes()
        stamp, _, remainder = path.name.partition('-')
        token = remainder.removesuffix('.pcb-job.json').rsplit('-', 1)[1]
        with patch.object(web.time, 'strftime', return_value=stamp), patch.object(web.secrets, 'token_hex', return_value=token):
            with self.assertRaises(FileExistsError):
                self.action('pcb-save')
        self.assertEqual(path.read_bytes(), contents)
        self.assertEqual(self.pending_files(), [path])
        self.assertEqual(self.c.pcb_public(), before)

    def test_recovery_failure_preserves_current_workspace(self):
        self.action('pcb-fixture', fixture=copy.deepcopy(FIXTURE))
        original = self.c.pcb
        before = original.public()
        with patch.object(web.os, 'link', side_effect=OSError(errno.ENOSPC, 'Synthetic disk full')):
            with self.assertRaises(OSError):
                self.action('pcb-new')
        self.assertIs(self.c.pcb, original)
        self.assertEqual(original.public(), before)
        self.assertEqual(self.pending_files(), [])

    def test_demo_enforces_same_encoded_limit_without_writing(self):
        self.c.demo = True
        with patch.object(self.c.pcb, 'package', return_value=self.package_at_limit(excess=1)):
            with self.assertRaisesRegex(ValueError, '24 MB UTF-8 limit'):
                self.action('pcb-save')
        self.assertEqual(self.pending_files(), [])

    def test_http_json_uses_the_same_compact_utf8_encoding(self):
        handler = web.Handler.__new__(web.Handler)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        payload = {'name': 'Préparation', 'files': ['café.nc']}
        handler.send(200, payload)
        self.assertEqual(handler.wfile.getvalue(), web.json_bytes(payload))
        handler.send_header.assert_any_call('Content-Length', str(len(web.json_bytes(payload))))


if __name__ == '__main__':
    unittest.main()
