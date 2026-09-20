"""Job linkage, import evidence and offline action boundaries."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from pcb_workspace import Workspace
from job_workflow import scan_area, fingerprint, plan_status, configure_workflow, map_source_current
from job_handoff import accepted_payload
from cnc_map_web import Controller
from job_actions import perform
from test_job_tools import fixture, tool, parameters

SOURCE='G21\nG90\nG0 X5 Y5 Z3\nG1 Z-0.1 F10\nG1 X15 Y5 F50\nG1 X15 Y15\nG1 X5 Y15\nG1 X5 Y5\nG0 Z3\nM5\nM2\n'

def job():
    j=Workspace();j.import_files([{'name':'test.nc','source':SOURCE}])
    j.operation({'id':j.operations[0]['id'],'action':'update','role':'isolation','tool':'Test cutter','diameter':1})
    return j

class WorkflowTests(unittest.TestCase):
    def test_fixture_rejects_undersized_or_incomplete_operation_envelopes(self):
        j = job(); j.workflow['fixture'] = fixture(False)
        j.import_files([{'name': 'wide.nc', 'source': SOURCE}])
        first, second = j.operations
        j.operation({'id': second['id'], 'role': 'outline', 'tool': 'Large cutter', 'diameter': 10})
        small = {'diameter': 1, 'holderDiameter': 1, 'length': 10, 'cuttingLength': 4}
        large = {**small, 'diameter': 10, 'holderDiameter': 10}
        j.workflow['fixture']['clamps'] = [{'id': 'right', 'x': 16, 'y': 9, 'width': 1,
                                           'height': 2, 'baseZ': 0, 'heightZ': 5}]
        with self.assertRaisesRegex(ValueError, 'wide.nc.*smaller'):
            perform(j, 'pcb-fixture-check', {'tool': small}, {}, True)
        for supplied in [{first['id']: small}, {first['id']: small, second['id']: small},
                         {first['id']: small, second['id']: large, 'old-id': large}]:
            with self.assertRaises(ValueError): perform(j, 'pcb-fixture-check', {'tools': supplied}, {}, True)
        result = perform(j, 'pcb-fixture-check', {'tools': {first['id']: small, second['id']: large}}, {}, True)
        self.assertTrue(result['operations'][0]['modelClear'])
        self.assertFalse(result['operations'][1]['modelClear'])
        self.assertFalse(result['modelClear'])
        self.assertGreater(result['operations'][1]['collisionCount'], 0)
        self.assertEqual(result['operations'][1]['operationId'], second['id'])
        first['diameter'] = None
        with self.assertRaisesRegex(ValueError, 'save the effective'):
            perform(j, 'pcb-fixture-check', {'tool': large}, {}, True)

    def test_tool_history_survives_setup_changes_and_reopen_without_authority(self):
        j = job(); op_id = j.operations[0]['id']
        for note in ['Measured length; chatter unresolved', 'Replaced cutter; Z still needs probing']:
            perform(j, 'pcb-tool-note', {'operationId': op_id, 'note': note}, {}, True)
        history = copy.deepcopy(j.workflow['toolObservations'])
        j.invalidate('Stop / new setup')
        perform(j, 'pcb-fixture', {'fixture': fixture(False)}, {}, True)
        configure_workflow(j, {'material': 'wood', 'intent': 'engraving', 'sourceCompensation': 'none'})
        self.assertEqual(j.workflow['toolObservations'], history)
        restored = Workspace.from_package(j.package('session'))
        new_id = restored.operations[0]['id']
        self.assertNotEqual(new_id, op_id)
        self.assertEqual(restored.workflow['toolObservations'], history)
        self.assertEqual(restored.workflow['toolChecks'][new_id]['note'], history[-1]['note'])
        self.assertFalse(restored.workflow['toolChecks'][new_id]['zReferenceVerified'])
        self.assertEqual(restored.workflow['toolChecks'][new_id]['status'], 'historical-operator-note')
        self.assertIsNone(restored.alignment)
        self.assertFalse(restored.public('session')['canExport'])
        self.assertFalse(plan_status(restored, 'session', {})['cuttingReleased'])
        self.assertEqual(Workspace.from_package(restored.package()).workflow['toolObservations'], history)

    def test_history_is_not_misbound_by_reorder_duplicate_content_or_changed_source(self):
        j = job(); j.import_files([{'name': 'copy.nc', 'source': SOURCE}])
        original, duplicate = j.operations
        perform(j, 'pcb-tool-note', {'operationId': original['id'], 'note': 'Only original operation'}, {}, True)
        j.operation({'id': duplicate['id'], 'action': 'up'})
        restored = Workspace.from_package(j.package())
        self.assertNotIn(restored.operations[0]['id'], restored.workflow['toolChecks'])
        self.assertIn(restored.operations[1]['id'], restored.workflow['toolChecks'])
        package = j.package()
        original_file = next(f for f in package['files'] if f['name'] == original['name'])
        original_file['source'] += '(source revision)\n'
        original_file['sha256'] = hashlib.sha256(original_file['source'].encode()).hexdigest()
        changed = Workspace.from_package(package)
        self.assertEqual(changed.workflow['toolChecks'], {})
        self.assertEqual(len(changed.workflow['toolObservations']), 1)
        j.operation({'id': original['id'], 'action': 'remove'})
        self.assertEqual(j.workflow['toolChecks'], {})
        self.assertEqual(len(j.workflow['toolObservations']), 1)

    def test_legacy_notes_migrate_by_verified_source_and_saved_authority_is_stripped(self):
        j = job(); op = j.operations[0]; package = j.package()
        del package['job']['workflow']['toolObservations']
        package['job']['workflow']['toolChecks'] = {op['id']: {
            'note': 'Legacy observation', 'recordedAt': '2026-09-20T12:00:00',
            'status': 'verified', 'zReferenceVerified': True, 'executionReleased': True}}
        restored = Workspace.from_package(package)
        note = restored.workflow['toolChecks'][restored.operations[0]['id']]
        self.assertEqual(note['source']['sha256'], op['parsed']['sha256'])
        self.assertEqual(note['note'], 'Legacy observation')
        self.assertFalse(note['zReferenceVerified']); self.assertNotIn('executionReleased', note)
        modern = restored.package()
        modern['job']['workflow']['toolObservations'][0].update(zReferenceVerified=True, status='verified', session='session')
        record = Workspace.from_package(modern).workflow['toolObservations'][0]
        self.assertFalse(record['zReferenceVerified']); self.assertNotIn('session', record)
        for key, value in [('note', 'x' * 2001), ('recordedAt', 'not-a-date'),
                           ('source', {'name': 'test.nc', 'sha256': 'not-a-hash'})]:
            damaged = copy.deepcopy(modern)
            damaged['job']['workflow']['toolObservations'][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): Workspace.from_package(damaged)

    def test_generator_accepts_conservative_parameters_on_faster_configured_machine(self):
        from job_tools import REVIEW_FLAGS
        profile = {'configured': True, 'baseline': {'110': '5000', '111': '6000', '112': '500', '30': '24000'}}
        spec = {'fixture': fixture(False), 'area': {'x': [0, 20], 'y': [0, 15]}, 'tool': tool(), 'parameters': parameters()}
        for kind in ('coupon', 'surfacing'):
            result = perform(job(), 'pcb-generate', {'kind': kind, 'spec': spec, 'stepover': 1,
                             'reviewed': dict.fromkeys(REVIEW_FLAGS, True)}, profile, False)
            self.assertFalse(result['simulation']); self.assertFalse(result['executionReleased'])
            self.assertEqual(result['reviewed']['maxFeed'], 5000)

    def test_coverage_includes_tool_and_margin(self):
        j=job();s=scan_area(j);self.assertEqual(s['area'],{'x':[3.48,16.52],'y':[3.48,16.52]})
        before=fingerprint(j);j.operations[0]['diameter']=2;self.assertNotEqual(before,fingerprint(j))
        j.stock['width']=16
        with self.assertRaises(ValueError):scan_area(j)

    def test_clamps_reject_scan_overlap(self):
        j=job();j.workflow['fixture']=fixture(True)
        with self.assertRaisesRegex(ValueError,'clamp'):scan_area(j)

    def test_saved_recipe_roundtrip_drops_reference_claims(self):
        j=job();recipe={'version':1,'name':'Observation','material':'MDF','tool':tool(),'parameters':parameters(),'observations':[]}
        perform(j,'pcb-recipe',{'recipe':recipe},{},True)
        j.workflow['toolChecks']={'fake':{'zReferenceVerified':True}}
        restored=Workspace.from_package(j.package('session'))
        self.assertEqual(restored.workflow['recipes'],[recipe]);self.assertEqual(restored.workflow['toolChecks'],{})
        self.assertIsNone(restored.workflow['camera'])

    def test_guide_never_turns_a_note_into_cut_release(self):
        j=job();perform(j,'pcb-tool-note',{'operationId':j.operations[0]['id'],'note':'Changed cutter'}, {},True)
        self.assertFalse(j.workflow['toolChecks'][j.operations[0]['id']]['zReferenceVerified'])
        for label, point in [('A', [5,5]), ('B', [15,5]), ('C', [5,15])]:
            j.reference(label, point, point, 'session')
        j.solve('session')
        state={'phase':'complete','result':{'path':'example'},'jobSetupEpoch':0,
               'mapSource':{'fingerprint':fingerprint(j),'setupEpoch':0}}
        status=plan_status(j,'session',state);self.assertTrue(status['measured']);self.assertFalse(status['cuttingReleased'])
        j.placement['x']=2;self.assertFalse(plan_status(j,'session',state)['measured'])

    def test_map_source_requires_current_integer_epoch_and_live_alignment(self):
        j = job()
        for label, point in [('A', [5,5]), ('B', [15,5]), ('C', [5,15])]:
            j.reference(label, point, point, 'session')
        j.solve('session')
        state = {'phase': 'complete', 'result': {'path': 'synthetic'}, 'jobSetupEpoch': 0,
                 'mapSource': {'fingerprint': fingerprint(j), 'setupEpoch': 0}}
        self.assertTrue(map_source_current(j, 'session', state))
        self.assertFalse(map_source_current(j, 'different-session', state))
        for value in [None, True, False, 0.0, '0', 1]:
            for target, key in [('mapSource', 'setupEpoch'), (None, 'jobSetupEpoch')]:
                invalid = copy.deepcopy(state)
                (invalid[target] if target else invalid)[key] = value
                with self.subTest(target=target, value=value):
                    self.assertFalse(map_source_current(j, 'session', invalid))
                    self.assertFalse(plan_status(j, 'session', invalid)['measured'])
        for target, key in [('mapSource', 'setupEpoch'), (None, 'jobSetupEpoch')]:
            invalid = copy.deepcopy(state); del (invalid[target] if target else invalid)[key]
            self.assertFalse(map_source_current(j, 'session', invalid))
        for source in [None, {}, [], {**state['mapSource'], 'invalidated': True},
                       {**state['mapSource'], 'fingerprint': 'old-geometry'}]:
            invalid = {**state, 'mapSource': source}
            self.assertFalse(map_source_current(j, 'session', invalid))
        for field, value in [('phase', 'teach'), ('result', None)]:
            unmeasured = {**state, field: value}
            self.assertTrue(map_source_current(j, 'session', unmeasured))
            self.assertFalse(plan_status(j, 'session', unmeasured)['measured'])
        # Same geometry after reopen cannot inherit a previously accepted map.
        reopened = Workspace.from_package(j.package('session'))
        self.assertEqual(fingerprint(reopened), fingerprint(j))
        self.assertFalse(map_source_current(reopened, 'session', state))
        j.invalidate('Lost setup')
        self.assertFalse(map_source_current(j, 'session', state))

    def test_job_area_is_nonmoving_and_rejects_stale_identity(self):
        c=Controller(True);self.addCleanup(setattr,c,'closed',True)
        c.authenticate(c.token,'workflow-test');c.pcb=job();c.pcb.workflow['sourceCompensation']='none';c.perform('arm',{'confirmed':True})
        for label,point in [('A',[5,5]),('B',[15,5]),('C',[5,15])]:c.pcb.reference(label,point,point,c.data['sessionId'])
        c.pcb.solve(c.data['sessionId']);before=copy.deepcopy(c.demo_position)
        body={'pcbRevision':c.pcb.revision,'reviewed':True,'fingerprint':fingerprint(c.pcb)}
        with patch.object(c,'launch',side_effect=AssertionError('No motion')):c.perform('pcb-map-job',body)
        self.assertEqual(c.demo_position,before);self.assertEqual(c.data['probeMode'],'copper')
        self.assertTrue(all(p['source']=='job' for p in c.data['corners']))
        body['fingerprint']='stale'
        with self.assertRaisesRegex(ValueError,'changed'):c.perform('pcb-map-job',body)
        c.stop('test');c.perform('new-session',{})
        self.assertIsNone(c.data['mapSource']);self.assertIsNone(c.data['handoff'])

    def test_simulation_cannot_import_native_map(self):
        c=Controller(True);self.addCleanup(setattr,c,'closed',True);c.data['phase']='complete'
        with self.assertRaisesRegex(ValueError,'real scan'):c.perform('surface-import',{})

    def test_generator_cannot_override_server_rate_limits(self):
        c=Controller(True);self.addCleanup(setattr,c,'closed',True)
        from job_tools import REVIEW_FLAGS
        spec={'fixture':fixture(False),'area':{'x':[0,20],'y':[0,15]},'tool':tool(),'parameters':parameters()}
        reviewed={k:True for k in REVIEW_FLAGS};reviewed.update(maxPlungeFeed=999,maxFeed=999)
        with self.assertRaisesRegex(ValueError,'plunge|Plunge'):perform(c.pcb,'pcb-generate',{'kind':'coupon','spec':spec,'reviewed':reviewed},c.profile,True)

    def test_both_draft_endpoints_use_real_helper_contract(self):
        c=Controller(True);self.addCleanup(setattr,c,'closed',True)
        from job_tools import REVIEW_FLAGS
        params=parameters();params['plungeFeed']=5
        spec={'fixture':fixture(False),'area':{'x':[0,20],'y':[0,15]},'tool':tool(),'parameters':params}
        for kind in ['coupon','surfacing']:
            result=perform(c.pcb,'pcb-generate',{'kind':kind,'stepover':1,'spec':spec,'reviewed':{k:True for k in REVIEW_FLAGS}},c.profile,True)
            self.assertIn('SIMULATED',result['source']);self.assertTrue(result['filename'].endswith('.nc.txt'))
            self.assertFalse(result['executionReleased'])

    def test_stop_during_import_cannot_publish_verified_receipt(self):
        c=Controller(True);self.addCleanup(setattr,c,'closed',True);c.demo=False;c.data['phase']='complete'
        c.data['continuityActive'] = True
        c.monitor = Mock(); c.monitor.poll.return_value = None
        def imported(_):
            c.stopped=True
            return {'verified':True}
        with patch('job_handoff.accepted_payload',return_value={'sha256':'test'}), patch('ugs_surface_bridge.SurfaceBridge') as bridge:
            bridge.return_value.import_map.side_effect=imported
            with self.assertRaisesRegex(ValueError,'stopped or changed|monitoring is no longer active'):c.perform('surface-import',{})
            bridge.return_value.import_map.assert_called_once()
        self.assertIsNone(c.data['handoff'])

class HandoffEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.path=self.root/'surface.xyz'
        self.raw='0 0 0\n0 5 0.1\n5 0 0.2\n5 5 0.3\n';self.path.write_text(self.raw)
        self.config={'expectedG54':{'x':2,'y':3,'z':0},'grid':{'x':[2,7],'y':[3,8]}}
        self.result={'path':str(self.path),'summary':{'drift':0}}
        self.save('config.json',self.config);self.save('ugs-handoff.json',{'sha256':hashlib.sha256(self.raw.encode()).hexdigest(),'capturedG54':self.config['expectedG54']})
        self.save('result.json',{'drift':0,'physicalObservationConfirmed':True,'offsetsPreserved':True,'appliedInUgs':False})
        self.result['acceptedHashes']={n:hashlib.sha256(self.root.joinpath(n).read_bytes()).hexdigest() for n in ('surface.xyz','config.json','result.json','ugs-handoff.json')}
    def save(self,name,value):self.root.joinpath(name).write_text(json.dumps(value))
    def test_native_rows_come_from_accepted_grid(self):
        p=accepted_payload(self.result,self.root);self.assertEqual(p['relativeZ'],[[0,.2],[.1,.3]])
    def test_modified_map_grid_and_acceptance_refused(self):
        self.path.write_text(self.raw+'0 0 1\n')
        with self.assertRaisesRegex(ValueError,'checksum'):accepted_payload(self.result,self.root)
        self.path.write_text(self.raw);self.config['grid']['x']=[3,8];self.save('config.json',self.config)
        with self.assertRaisesRegex(ValueError,'checksum'):accepted_payload(self.result,self.root)
    def test_outside_directory_refused(self):
        with self.assertRaisesRegex(ValueError,'outside'):accepted_payload(self.result,self.root/'elsewhere')

    def test_mutating_map_and_its_adjacent_checksum_cannot_replace_acceptance(self):
        raw=self.raw.replace('0.3','0.9');self.path.write_text(raw)
        self.save('ugs-handoff.json',{'sha256':hashlib.sha256(raw.encode()).hexdigest(),'capturedG54':self.config['expectedG54']})
        with self.assertRaisesRegex(ValueError,'Accepted evidence checksum changed'):accepted_payload(self.result,self.root)
