"""Teaching recovery, inset coverage and Z clearance: isolated, no hardware."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from cnc_map_web import Controller
from surface_history import SurfaceHistory


class SurfaceHistoryTests(unittest.TestCase):
    def setUp(self):
        self.c = Controller(demo=True)
        self.c.authenticate(self.c.token, 'history-test')
        self.addCleanup(setattr, self.c, 'closed', True)
        self.c.perform('arm', {'confirmed': True})

    def teach(self):
        for name,x,y in [('front-left',0,0),('back-right',40,30),('front-right',40,0),('back-left',0,30)]:
            self.c.perform('corner-entry',dict(corner=name,x=x,y=y))

    def settle(self):
        deadline=time.monotonic()+2
        while self.c.data['busy'] and time.monotonic()<deadline: time.sleep(.01)
        self.assertFalse(self.c.data['busy'])
        self.assertFalse(self.c.stopped)

    def test_partial_teaching_survives_stop_and_fresh_setup_without_motion(self):
        self.c.perform('capture', {'corner':'front-left'})
        identifier=self.c.data['sessionId']
        self.c.stop('Interrupted teaching')
        record=self.c.perform('history-read', {'id':identifier})
        self.assertEqual(record['cornerCount'],1)
        self.assertEqual(record['phase'],'stopped')
        self.c.perform('new-session',{})
        self.c.perform('arm',{'confirmed':True})
        self.c.demo_position['z']=4;self.c.expected=self.c.read_machine()
        with self.assertRaises(ValueError): self.c.perform('history-restore',{'id':identifier})
        with patch.object(self.c,'launch',side_effect=AssertionError('No movement')):
            self.c.perform('history-restore',{'id':identifier,'confirmed':True})
        self.assertEqual(self.c.data['corners'][0]['z'],4)
        self.assertIsNone(self.c.data['planId'])
        self.assertEqual(self.c.data['measurements'],[])
        self.assertIsNone(self.c.data['result'])

    def test_history_rejects_mismatch_and_stop_during_reference_check(self):
        self.teach();identifier=self.c.data['sessionId']
        self.c.history.records[identifier]['reference']['x']=999
        with self.assertRaisesRegex(ValueError,'offset'): self.c.perform('history-restore',{'id':identifier,'confirmed':True})
        self.c.history.records[identifier]['profile']='different'
        with self.assertRaisesRegex(ValueError,'configuration'): self.c.perform('history-restore',{'id':identifier,'confirmed':True})
        self.c.checkpoint_surface()
        checked=self.c.checked
        def interrupted():
            result=checked();self.c.stop('stop during restore');return result
        with patch.object(self.c,'checked',side_effect=interrupted):
            with self.assertRaisesRegex(ValueError,'stopped'):self.c.perform('history-restore',{'id':identifier,'confirmed':True})
        self.assertFalse(self.c.data['armed'])

    def test_clearance_preserves_xy_rebases_z_and_invalidates_preview(self):
        self.teach();self.c.perform('plan',{'spacing':10})
        previous=copy.deepcopy(self.c.data['corners'])
        for delta in [1,-.1]:
            self.c.perform('clearance-jog',{'axis':'z','delta':delta,'confirmed':True,'speed':'slow'})
            self.settle()
        self.assertEqual([(p['x'],p['y']) for p in previous],[(p['x'],p['y']) for p in self.c.data['corners']])
        self.assertTrue(all(p['z']==.9 for p in self.c.data['corners']))
        self.assertIsNone(self.c.data['planId'])
        self.c.perform('plan',{'spacing':10})
        self.assertEqual(self.c.data['plan']['travelZ'],.9)
        for body in [{'axis':'x','delta':1,'confirmed':True},{'axis':'z','delta':5,'confirmed':True},{'axis':'z','delta':1}]:
            with self.assertRaises(ValueError):self.c.perform('clearance-jog',body)
        self.c.perform('scan',{'planId':self.c.data['planId']})
        with self.assertRaises(ValueError):self.c.perform('clearance-jog',{'axis':'z','delta':1,'confirmed':True})

    def test_reuse_allows_new_z_offset_without_restoring_old_z(self):
        self.teach();identifier=self.c.data['sessionId']
        current=copy.deepcopy(self.c.read_machine())
        current['status']['machineCoord']['z']=3
        current['status']['workCoord']['z']=-7
        with patch.object(self.c,'checked',return_value=current):
            self.c.perform('history-restore',{'id':identifier,'confirmed':True})
        self.assertTrue(all(p['z']==3 for p in self.c.data['corners']))
        self.assertTrue(all(p['status']['workCoord']['z']==-7 for p in self.c.snapshots.values()))

    def test_inset_requires_inner_start_and_includes_interior(self):
        self.teach()
        with self.assertRaisesRegex(ValueError,'grid point'):self.c.perform('plan',{'spacing':10,'edgeInset':5})
        self.c.perform('goto',{'x':5,'y':5});self.settle()
        self.c.perform('plan',{'spacing':10,'edgeInset':5})
        self.assertEqual(self.c.data['plan']['grid']['x'],[5,15,25,35])
        self.assertEqual(self.c.data['plan']['grid']['y'],[5,15,25])
        self.assertEqual(self.c.data['plan']['envelope']['x'],[5,35])
        for bad in [-1,15,True,'5',float('nan'),.0001]:
            with self.assertRaises(ValueError):self.c.perform('plan',{'spacing':10,'edgeInset':bad})

    def test_partial_scan_is_saved_as_history_not_resumable_authority(self):
        self.teach();self.c.perform('plan',{'spacing':10})
        self.c.perform('scan',{'planId':self.c.data['planId']})
        while not self.c.data['measurements']:
            prompt=self.c.data['prompt'];self.c.perform('reply',{'id':prompt['id'],'answer':prompt['expected']})
        identifier=self.c.data['sessionId'];self.c.stop('Interrupted scan')
        item=self.c.perform('history-read',{'id':identifier})
        self.assertEqual(item['measurementCount'],1)
        self.assertNotIn('result',item)
        self.assertNotIn('token',json.dumps(item))
        self.c.perform('new-session',{});self.c.perform('arm',{'confirmed':True})
        self.c.perform('history-restore',{'id':identifier,'confirmed':True})
        self.assertEqual(self.c.data['measurements'],[])
        self.assertIsNone(self.c.data['planId'])

    def test_disk_history_reopens_and_rejects_traversal_and_symlink(self):
        self.teach();record=self.c.history.get(self.c.data['sessionId'])
        with tempfile.TemporaryDirectory() as directory:
            store=SurfaceHistory(directory);store.save(record)
            reopened=SurfaceHistory(directory)
            self.assertEqual(reopened.get(record['id']),record)
            self.assertEqual(reopened.list()[0]['cornerCount'],4)
            with self.assertRaises(ValueError):reopened.get('../config')
            file=Path(directory)/(record['id']+'.json');file.unlink();file.symlink_to(Path(directory)/'missing')
            with self.assertRaises(ValueError):reopened.get(record['id'])

if __name__=='__main__':unittest.main()
