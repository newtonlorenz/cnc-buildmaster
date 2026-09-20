"""End-to-end controller transitions use simulations or read-only fake observers."""
import copy
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from cnc_map_web import Controller
from job_workflow import fingerprint

SOURCE='G21\nG90\nG0 X5 Y5 Z3\nM3 S500\nG1 Z-0.1 F5\nG1 X15 Y5 F50\nG1 X15 Y15\nG1 X5 Y15\nG1 X5 Y5\nG0 Z3\nM5\nM2\n'
class SessionWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.c = Controller(demo=True)
        self.c.authenticate(self.c.token, 'owner-a')
        self.addCleanup(setattr, self.c, 'closed', True)
    def action(self, action, **body):
        return self.c.perform(action, {'pcbRevision': self.c.pcb.revision, **body}, self.c.data['sessionId'])
    def aligned(self):
        self.action('arm', confirmed=True)
        self.action('pcb-import', files=[{'name':'paths.nc','source':SOURCE}])
        self.action('pcb-operation', id=self.c.pcb.operations[0]['id'], role='isolation', tool='V-bit', diameter=.2)
        self.action('pcb-workflow', settings={'material':'wood','intent':'engraving','sourceCompensation':'none'})
        for label, point in [('A',[5,5]),('B',[15,5]),('C',[5,15])]:
            self.c.demo_position.update(x=point[0], y=point[1]); self.c.expected=self.c.read_machine()
            self.action('pcb-capture', label=label, design=point)
        self.action('pcb-solve')
        self.action('pcb-map-job', reviewed=True, fingerprint=fingerprint(self.c.pcb))
        area=self.c.data['area'];self.c.demo_position.update(x=area['x'][0],y=area['y'][0]);self.c.expected=self.c.read_machine()
        self.action('plan', spacing=10)
    def scan(self):
        self.action('scan', planId=self.c.data['planId'])
        while self.c.data['prompt']:
            p=self.c.data['prompt'];self.action('reply', id=p['id'], answer=p['expected'])
        self.c.expected=self.c.read_machine()
        self.assertEqual(self.c.data['phase'],'complete')
    def test_prepare_scan_export_then_explicit_handoff_without_reset(self):
        self.aligned();session=self.c.data['sessionId'];self.scan()
        self.assertTrue(self.c.data['continuityActive'])
        result=self.action('pcb-export',reviewed=True)
        self.assertTrue(result['archive']);self.assertEqual(self.c.data['sessionId'],session)
        with patch.object(self.c,'launch',side_effect=AssertionError('No motion')):
            self.action('handoff-finish')
        self.assertTrue(self.c.data['preparationClosed']);self.assertFalse(self.c.data['continuityActive'])
        with self.assertRaisesRegex(ValueError,'monitoring'):self.action('pcb-export',reviewed=True)
        self.assertTrue(self.c.state()['canStartFresh'])
    def test_same_geometry_does_not_resurrect_invalidated_plan(self):
        self.aligned();old_plan=self.c.data['planId'];epoch=self.c.data['jobSetupEpoch']
        values=self.c.pcb.public()['stock']
        settings={'name':self.c.pcb.name,'boardRevision':self.c.pcb.board_revision,'face':self.c.pcb.face,
            'stock':values,'placement':self.c.pcb.placement,'tolerance':.06}
        self.action('pcb-configure',settings=settings)
        self.assertGreater(self.c.data['jobSetupEpoch'],epoch)
        self.assertTrue(self.c.data['mapSource']['invalidated']);self.assertIsNone(self.c.data['planId'])
        settings['tolerance']=.05;self.action('pcb-configure',settings=settings)
        with self.assertRaises(ValueError):self.action('scan',planId=old_plan)
        self.assertFalse(self.c.pcb_state()['guide']['mapMatchesJob'])
    def test_reopening_identical_package_cannot_reuse_completed_map(self):
        self.aligned();package=self.c.pcb.package(self.c.data['sessionId']);self.scan()
        self.c.data['result']={'path':'simulated-placeholder'}
        self.assertTrue(self.c.pcb_state()['guide']['measured'])
        self.action('pcb-load',package=package)
        self.assertFalse(self.c.pcb_state()['guide']['measured'])
        self.c.demo=False;self.c.monitor=Mock();self.c.monitor.poll.return_value=None
        with patch('job_handoff.accepted_payload',side_effect=AssertionError('Stale map accepted')):
            with self.assertRaisesRegex(ValueError,'Job changed'):self.action('surface-import')
        self.c.monitor=None
    def test_monitor_exit_blocks_completed_export(self):
        self.aligned();self.scan();self.c.demo=False
        self.c.monitor=Mock();self.c.monitor.poll.return_value=0
        with self.assertRaisesRegex(ValueError,'monitoring'):self.action('pcb-export',reviewed=True)
        self.c.monitor=None
    def test_only_explicit_expired_owner_recovery_revokes_old_requests(self):
        original=self.c.data['sessionId']
        with self.assertRaisesRegex(ValueError,'still active'):
            self.c.recover_ownership(self.c.token,'owner-b',True)
        self.c.last_seen=time.monotonic()-4
        with self.assertRaises(ValueError):self.c.recover_ownership(self.c.token,'owner-b',False)
        self.c.recover_ownership(self.c.token,'owner-b',True)
        self.assertNotEqual(self.c.data['sessionId'],original)
        self.assertFalse(self.c.data['armed'])
        with self.assertRaises(PermissionError):self.c.authenticate(self.c.token,'owner-a')
        with self.assertRaises(PermissionError):self.c.recover_ownership(self.c.token,'owner-a',True)
        with self.assertRaisesRegex(ValueError,'old setup'):
            self.c.perform('pcb-new',{'pcbRevision':self.c.pcb.revision},original)
    def test_recovery_refuses_workers_and_only_one_simultaneous_contender_wins(self):
        self.c.last_seen=time.monotonic()-4;self.c.child=Mock();self.c.child.poll.return_value=None
        with self.assertRaisesRegex(ValueError,'workers'):self.c.recover_ownership(self.c.token,'owner-b',True)
        self.c.child=None;success=[]
        def recover(owner):
            try:self.c.recover_ownership(self.c.token,owner,True);success.append(owner)
            except (ValueError,PermissionError):pass
        a=threading.Thread(target=recover,args=('owner-b',));b=threading.Thread(target=recover,args=('owner-c',))
        a.start();b.start();a.join();b.join();self.assertEqual(len(success),1)
    def test_recovery_keeps_digital_work_but_clears_physical_evidence(self):
        self.aligned();self.c.stop('test');self.c.last_seen=time.monotonic()-4
        self.c.recover_ownership(self.c.token,'owner-b',True)
        self.assertEqual(len(self.c.pcb.operations),1)
        self.assertIsNone(self.c.pcb.alignment);self.assertIsNone(self.c.data['mapSource'])
        self.assertTrue(all(p['machine'] is None for p in self.c.pcb.references.values()))
