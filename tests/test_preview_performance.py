"""Offline preview work bounds and heartbeat independence; no servers or hardware."""
import copy
import math
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cnc_map_web as web
import pcb_workspace
from pcb_gcode import bounds, transform
from job_workflow import fingerprint, plan_status, preparation_view, scan_area


SOURCE = ('G21 G90 G17 G94 G54\nG0 X5 Y5 Z3\nM3 S500\n'
          'G1 Z-0.1 F10\nG1 X15 Y5 F50\nG1 X5 Y15\nG1 X5 Y5\n'
          'G2 X15 Y5 I5 J0\nG0 Z3\nM5\nM2\n')


class PreviewPerformanceTests(unittest.TestCase):
    def setUp(self):
        # Offline construction does not even start the machine watchdog.
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(web, 'offline_data_dir', return_value=self.root))
        self.enterContext(patch.object(web, 'snapshot', side_effect=AssertionError('No machine reads')))
        for method in ('Popen', 'run', 'check_output'):
            self.enterContext(patch.object(web.subprocess, method, side_effect=AssertionError('No workers')))
        self.c = web.Controller(offline=True)
        self.c.jobs_dir = self.root / 'jobs'

    def load(self, source=SOURCE, count=1):
        self.c.pcb.import_files([{'name': f'operation-{i}.nc', 'source': source} for i in range(count)])
        for operation in self.c.pcb.operations:
            self.c.pcb.operation({'id': operation['id'], 'role': 'isolation',
                                  'tool': 'Test V-bit', 'diameter': .2})
        return self.c.pcb

    def test_state_and_authentication_finish_while_another_thread_holds_job_lock(self):
        held, release, finished = threading.Event(), threading.Event(), threading.Event()
        failures, snapshots = [], []

        def hold_job():
            with self.c.pcb_lock:
                held.set()
                release.wait()

        def heartbeat():
            try:
                for _ in range(3):
                    self.c.authenticate(self.c.token, 'test-owner')
                    snapshots.append(self.c.state())
            except BaseException as error:
                failures.append(error)
            finally:
                finished.set()

        holder = threading.Thread(target=hold_job)
        reader = threading.Thread(target=heartbeat)
        holder.start()
        try:
            self.assertTrue(held.wait(5), 'Lock-holder thread failed to start')
            reader.start()
            # Synchronisation deadline only: completion MUST precede releasing
            # pcb_lock, regardless of preview size or CPU speed.
            self.assertTrue(finished.wait(5), 'State waited for the job lock')
            self.assertFalse(release.is_set())
            self.assertFalse(failures)
            self.assertEqual(len(snapshots), 3)
            self.assertGreater(self.c.last_seen, 0)
            self.assertTrue(all(s['pcbRevision'] == self.c.pcb.revision for s in snapshots))
        finally:
            release.set()
            holder.join(5)
            if reader.ident is not None: reader.join(5)
        self.assertFalse(holder.is_alive())
        self.assertFalse(reader.is_alive())

    def test_revision_hint_tracks_edits_and_replacement_but_does_not_authorise_stale_writes(self):
        before = self.c.state()['pcbRevision']
        job = self.load()
        self.assertEqual(self.c.state()['pcbRevision'], job.revision)
        with self.assertRaisesRegex(ValueError, 'job changed'):
            self.c.perform('pcb-new', {'pcbRevision': before}, self.c.data['sessionId'])
        # Empty replacement avoids persistence while exercising pointer/revision publication.
        self.c.pcb = pcb_workspace.Workspace()
        candidate = pcb_workspace.Workspace()
        self.c.replace_pcb(candidate)
        self.assertEqual(self.c.state()['pcbRevision'], candidate.revision)

    def test_permitted_large_preview_transforms_each_vertex_once(self):
        # Three realistic dense raster files: ~4.2 MB, 297k lines, 594k vertices.
        # These go through the real parser and all file/job size guards.
        source = ('G21 G90 G17 G94 G54\nG0 X5 Y5 Z3\nM3 S500\nG1 Z-0.1 F10\n' +
                  ''.join(f'G1 X{5 + i % 11} Y{5 + (i // 11) % 11} F50\n'
                          for i in range(99000)) + 'G0 Z3\nM5\nM2\n')
        job = self.load(source, count=3)
        job.placement.update(x=35, y=20, angle=31, mirror=True)
        vertices = sum(op['parsed']['pointCount'] for op in job.operations)
        self.assertGreater(vertices, 500000)
        self.assertLessEqual(vertices, 660000)
        transformed = 0

        def count_transform(point, placement):
            nonlocal transformed
            transformed += 1
            return transform(point, placement)

        # Work-count assertions avoid a machine-speed-dependent duration budget.
        # A plain counter avoids retaining 594k Mock call records.
        with patch.object(pcb_workspace, 'transform', new=count_transform), \
                patch.object(job, 'public', wraps=job.public) as public:
            result = self.c.pcb_state()
        self.assertEqual(public.call_count, 1)
        self.assertEqual(transformed, vertices)
        self.assertEqual(sum(len(p['points']) for op in result['operations'] for p in op['paths']), vertices)
        expected = bounds(transform([x, y, z], job.placement)
                          for x in (5, 15) for y in (5, 15) for z in (-.1, 3))
        self.assertEqual(result['bounds'], expected)
        self.assertEqual(result['cutBounds'], expected)
        expected_area = {a: [math.floor((expected[a][0] - .12 - 1) * 1000) / 1000,
                             math.ceil((expected[a][1] + .12 + 1) * 1000) / 1000] for a in 'xy'}
        self.assertEqual(result['scanProposal']['area'], expected_area)
        self.assertTrue(result['guide']['steps'][0]['complete'])
        self.assertFalse(result['guide']['steps'][1]['complete'])
        self.assertFalse(result['guide']['measured'])
        self.assertFalse(result['canExport'])

    def test_geometry_matches_actual_vertices_and_recomputes_after_placement_edits(self):
        job = self.load()
        original = copy.deepcopy(job.operations[0]['parsed'])
        for mirror, angle in ((False, 0), (False, 37), (True, -23)):
            with self.subTest(mirror=mirror, angle=angle):
                job.placement.update(x=35, y=20, angle=angle, mirror=mirror)
                paths = [{**p, 'points': [transform(v, job.placement) for v in p['points']]}
                         for p in original['paths']]
                expected = bounds(v for p in paths for v in p['points'])
                cutting = bounds(v for p in paths if not p['rapid'] for v in p['points'])
                full = job.public()
                compact = job.public(include_paths=False)
                self.assertEqual(full['operations'][0]['paths'], paths)
                self.assertEqual(full['bounds'], expected)
                self.assertEqual(full['cutBounds'], cutting)
                del full['operations'][0]['paths']
                self.assertEqual(full, compact)
        self.assertEqual(job.operations[0]['parsed'], original)
        self.assertIsNone(pcb_workspace.Workspace().public()['bounds'])

    def test_shared_view_is_detached_immutable_and_never_restores_map_authority(self):
        job = self.load()
        session = self.c.data['sessionId']
        for label, point in [('A', [5, 5]), ('B', [15, 5]), ('C', [5, 15])]:
            job.reference(label, point, point.copy(), session)
        job.solve(session)
        public = job.public(session)
        view = preparation_view(public)
        with self.assertRaises(TypeError): view['revision'] = 0
        with self.assertRaises(TypeError): view['operations'][0]['fits'] = False
        with self.assertRaises(TypeError): view['operations'][0]['footprint']['x'][0] = 0
        public['operations'][0]['footprint']['x'][0] = -100
        public['operations'][0]['warnings'].append('altered response')
        machine = {'phase': 'complete', 'result': {'path': 'test-only'}, 'jobSetupEpoch': 1,
                   'mapSource': {'setupEpoch': 1, 'fingerprint': fingerprint(job)}}
        self.assertEqual(scan_area(job, preview=view), scan_area(job))
        self.assertEqual(plan_status(job, session, machine, preview=view), plan_status(job, session, machine))
        self.assertTrue(plan_status(job, session, machine, preview=view)['measured'])
        self.assertFalse(plan_status(job, 'new-session', machine, preview=view)['measured'])
        machine['jobSetupEpoch'] += 1
        self.assertFalse(plan_status(job, session, machine, preview=view)['measured'])
        job.changed()
        with self.assertRaisesRegex(ValueError, 'Job changed'):
            scan_area(job, preview=view)
        with self.assertRaisesRegex(ValueError, 'Job changed'):
            plan_status(job, session, machine, preview=view)

    def test_shared_preview_retains_cutter_depth_stock_and_fixture_guards(self):
        job = self.load()
        operation = job.operations[0]
        for mutation, message in (
                (lambda: operation.update(diameter=None), 'Save each cutter'),
                (lambda: job.stock.update(thickness=.01, spoilAllowance=0), 'stock and depth'),
                (lambda: job.placement.update(x=100), 'stock and depth'),
                (lambda: job.workflow.update(fixture={'clearance': 1, 'clamps': [
                    {'x': 6, 'y': 6, 'width': 2, 'height': 2}]}), 'clamp overlaps')):
            with self.subTest(message=message):
                saved = copy.deepcopy((job.stock, job.placement, job.workflow, operation['diameter']))
                mutation()
                view = preparation_view(job.public())
                with self.assertRaisesRegex(ValueError, message): scan_area(job, preview=view)
                job.stock, job.placement, job.workflow, operation['diameter'] = saved


if __name__ == '__main__':
    unittest.main()
