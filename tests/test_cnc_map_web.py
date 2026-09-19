import copy
import http.client
import io
import importlib.util
import json
from pathlib import Path
import sys
import threading
import tempfile
import time
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import cnc_map_web as web


class WebTests(unittest.TestCase):
    def setUp(self):
        self.c=web.Controller(demo=True)
        self.c.authenticate(self.c.token,'test-client')
    def tearDown(self):self.c.closed=True
    def arm(self):self.c.perform('arm',{'confirmed':True})
    def teach(self):
        self.arm()
        for x,y in [(0,0),(10,0),(10,10),(0,10)]:
            self.c.demo_position.update(x=x,y=y)
            self.c.expected=self.c.read_machine()
            self.c.perform('capture',{})
        self.c.perform('plan',{'spacing':5})

    def test_demo_never_calls_hardware_or_writes_evidence(self):
        with patch.object(web,'snapshot',side_effect=AssertionError('Hardware call')),patch.object(web,'save_plan',side_effect=AssertionError('Evidence write')),patch.object(web.subprocess,'Popen',side_effect=AssertionError('Child launch')):
            self.teach();self.c.perform('scan',{'planId':self.c.data['planId']})
            while self.c.data['prompt']:
                p=self.c.data['prompt'];self.c.perform('reply',{'id':p['id'],'answer':p['expected']})
            self.assertEqual(self.c.data['phase'],'complete')

    def test_owner_token_and_stale_readiness(self):
        with self.assertRaises(PermissionError):self.c.authenticate('bad','test-client')
        with self.assertRaises(PermissionError):self.c.authenticate(self.c.token,'other-tab')
        self.teach();self.c.perform('scan',{'planId':self.c.data['planId']})
        p=self.c.data['prompt'];answer={'id':p['id'],'answer':p['expected']}
        self.c.perform('reply',answer)
        with self.assertRaises(ValueError):self.c.perform('reply',answer)

    def test_startup_and_jog_axis_locks(self):
        with self.assertRaises(ValueError):self.c.perform('jog',{'axis':'x','delta':1})
        with self.assertRaises(ValueError):self.c.perform('arm',{'confirmed':False})
        self.arm();self.c.perform('capture',{})
        for axis,delta in [('z',1),('x',100),(None,1),('x',float('nan'))]:
            with self.subTest(axis=axis),self.assertRaises(ValueError):self.c.perform('jog',{'axis':axis,'delta':delta})

    def test_any_corner_order_recapture_and_click_move(self):
        self.arm()
        for name,x,y in [('back-right',10,10),('front-left',0,0),('back-left',0,10),('front-right',10,0)]:
            self.c.demo_position.update(x=x,y=y);self.c.expected=self.c.read_machine()
            self.c.perform('capture',{'corner':name})
        self.assertEqual(self.c.data['area'],{'x':[0,10],'y':[0,10]})
        self.c.perform('plan',{'spacing':5})
        self.assertEqual(self.c.data['plan']['start'],{'x':10,'y':0,'z':0})
        for x,y in [(-1,5),(5,11),(float('nan'),5)]:
            with self.assertRaises(ValueError):self.c.perform('goto',{'x':x,'y':y})
        self.c.perform('goto',{'x':5,'y':5,'speed':'maximum'})
        with self.assertRaises(ValueError):self.c.perform('goto',{'x':0,'y':0})
        deadline=time.monotonic()+2
        while self.c.data['busy'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(self.c.demo_position,{'x':5,'y':5,'z':0})
        self.assertIsNone(self.c.data['plan'])
        self.c.perform('plan',{'spacing':5})
        self.assertEqual(self.c.data['plan']['start']['x'],5)
        self.c.perform('capture',{'corner':'front-right'})
        self.assertEqual(len(self.c.snapshots),4);self.assertIsNone(self.c.data['area'])
        with self.assertRaises(ValueError):self.c.perform('goto',{'x':0,'y':0})

    def test_click_move_requires_complete_area_and_same_raised_z(self):
        self.arm()
        with self.assertRaises(ValueError):self.c.perform('goto',{'x':0,'y':0})
        for name,x,y in [('front-left',0,0),('front-right',10,0),('back-right',10,10),('back-left',0,10)]:
            self.c.demo_position.update(x=x,y=y);self.c.expected=self.c.read_machine();self.c.perform('capture',{'corner':name})
        self.c.demo_position['z']=1;self.c.expected=self.c.read_machine()
        with self.assertRaises(ValueError):self.c.perform('goto',{'x':5,'y':5})

    def test_hold_unavailable_without_native_extension(self):
        self.arm();self.c.data['nativeJog']=False
        with self.assertRaisesRegex(ValueError,'extension'):self.c.perform('jog-hold',{'id':'test-hold-missing','axis':'x','delta':1})
        self.assertFalse(self.c.data['busy'])

    def test_two_opposite_corners_enable_exact_positioning_before_remaining_captures(self):
        self.arm()
        for name,x,y in [('back-right',80.137,50.129),('front-left',0,0)]:
            self.c.demo_position.update(x=x,y=y);self.c.expected=self.c.read_machine();self.c.perform('capture',{'corner':name})
        self.assertEqual(self.c.data['area'],{'x':[0,80.137],'y':[0,50.129]})
        with self.assertRaises(ValueError):self.c.perform('plan',{'spacing':25})
        self.c.perform('goto',{'x':80.137,'y':0})
        deadline=time.monotonic()+2
        while self.c.data['busy'] and time.monotonic()<deadline:time.sleep(.01)
        self.c.perform('capture',{'corner':'front-right'})
        self.assertEqual(self.c.data['corners'][1]['x'],80.137)

    def test_jog_updates_expected_and_no_concurrent_moves(self):
        self.arm();self.c.perform('jog',{'axis':'x','delta':1})
        with self.assertRaises(ValueError):self.c.perform('capture',{})
        deadline=time.monotonic()+2
        while self.c.data['busy'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(self.c.data['status']['machineCoord']['x'],1)
        self.c.perform('capture',{})

    def test_outside_motion_reference_and_stop_latch(self):
        self.arm();self.c.demo_position['x']=2
        with self.assertRaises(ValueError):self.c.perform('capture',{})
        self.assertTrue(self.c.stopped)
        self.assertEqual(self.c.data['fault']['title'],'The position reference changed')
        self.c.stop()
        with self.assertRaises(ValueError):self.c.perform('arm',{'confirmed':True})
        with self.assertRaises(ValueError):self.c.perform('capture',{})

    def test_heartbeat_loss_latches_stop(self):
        self.arm();self.c.last_seen=time.monotonic()-4
        deadline=time.monotonic()+1
        while not self.c.stopped and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(self.c.stopped)
        self.assertFalse(self.c.data['armed'])


    def test_actual_runner_bridge_reaches_prompt_then_cancels_without_confirmation(self):
        self.teach()
        with tempfile.TemporaryDirectory() as directory:
            config=copy.deepcopy(self.c.data['plan']);config['outputDir']=directory
            path=Path(directory)/'plan.json';path.write_text(json.dumps(config))
            self.c.demo=False
            failures=[]
            def run():
                try:self.c.launch(['node',str(web.ROOT/'scripts/ugs_puck_map.mjs'),'--config',str(path),'--execute','--web-stdio'],scan=True)
                except ValueError as e:failures.append(str(e))
            thread=threading.Thread(target=run);thread.start()
            deadline=time.monotonic()+5
            while not self.c.data['prompt'] and thread.is_alive() and time.monotonic()<deadline:
                self.c.last_seen=time.monotonic();time.sleep(.02)
            try:
                self.assertEqual(self.c.data['prompt']['expected'],'confirm startup')
                self.c.stop('Test stop before any startup confirmation')
            finally:
                if self.c.child and self.c.child.poll() is None:self.c.child.terminate()
                thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertTrue(failures)
            records=list(Path(directory).glob('ugs-puck-map-*/events.jsonl'))
            self.assertEqual(len(records),1)
            self.assertFalse(any(json.loads(line)['kind']=='command' for line in records[0].read_text().splitlines()))

    def test_watcher_failure_stops_active_worker_and_invalidates_session(self):
        self.arm()
        self.c.demo=False
        worker=Mock();worker.poll.return_value=None
        self.c.child=worker
        monitor=Mock();monitor.poll.return_value=None
        monitor.stdin=io.StringIO()
        monitor.stdout=io.StringIO(json.dumps({'kind':'failure','error':'Controller reconnected'})+'\n')
        with patch.object(web.subprocess,'Popen',return_value=monitor):
            with self.assertRaises(ValueError):self.c.start_monitor()
        self.assertTrue(self.c.stopped)
        worker.send_signal.assert_called()
        self.assertIsNone(self.c.data['prompt'])

    def test_released_hold_cannot_start_if_start_request_arrives_late(self):
        self.arm();h='test-hold-release'
        self.c.perform('jog-release',{'id':h})
        self.c.perform('jog-hold',{'id':h,'axis':'x','delta':1})
        self.assertFalse(self.c.data['busy'])
        self.assertEqual(self.c.demo_position['x'],0)

    def test_held_jog_repeats_and_release_stops_without_resetting_session(self):
        self.arm();h='test-hold-moving'
        self.c.perform('jog-hold',{'id':h,'axis':'x','delta':1,'speed':'maximum'})
        for _ in range(4):
            time.sleep(.1);self.c.perform('jog-pulse',{'id':h})
        self.c.perform('jog-release',{'id':h})
        deadline=time.monotonic()+2
        while self.c.data['busy'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertFalse(self.c.stopped)
        self.assertGreaterEqual(self.c.demo_position['x'],2)
        stopped=self.c.demo_position['x']
        self.c.perform('jog-pulse',{'id':h})
        self.c.perform('jog-hold',{'id':h,'axis':'x','delta':1})
        self.assertFalse(self.c.data['busy']);self.assertEqual(self.c.demo_position['x'],stopped)

    def test_held_jog_expires_without_keepalive(self):
        self.arm();h='test-hold-timeout'
        self.c.perform('jog-hold',{'id':h,'axis':'z','delta':1})
        deadline=time.monotonic()+2
        while self.c.data['busy'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertFalse(self.c.data['busy']);self.assertFalse(self.c.stopped)
        self.assertLessEqual(self.c.demo_position['z'],.4)

    def test_speed_choices_and_larger_steps_are_bounded(self):
        self.arm()
        self.assertEqual(self.c.speeds['maximum'],{'x':100,'y':100,'z':10})
        with self.assertRaises(ValueError):self.c.perform('jog',{'axis':'x','delta':50,'speed':'unlimited'})
        with self.assertRaises(ValueError):self.c.perform('jog',{'axis':'z','delta':50,'speed':'maximum'})
        self.c.perform('jog',{'axis':'x','delta':50,'speed':'maximum'})
        deadline=time.monotonic()+2
        while self.c.data['busy'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(self.c.demo_position['x'],50)

    def test_fresh_setup_clears_references_and_rejects_delayed_actions(self):
        self.teach()
        old=self.c.data['sessionId']
        self.c.stop('Work reference changed')
        self.c.stop('Shutdown error')
        self.assertEqual(self.c.data['error'],'Work reference changed')
        self.assertTrue(self.c.state()['canStartFresh'])
        with patch.object(web,'snapshot',side_effect=AssertionError('Hardware call')),patch.object(web.subprocess,'Popen',side_effect=AssertionError('Child launch')):
            self.c.perform('new-session',{},session_id=old)
        self.assertEqual(self.c.data['phase'],'setup')
        self.assertFalse(self.c.data['armed'])
        self.assertNotEqual(self.c.data['sessionId'],old)
        self.assertFalse(self.c.snapshots)
        for key in ['status','plan','planId','route','area','prompt','result','fault','diagnostics']:
            self.assertIsNone(self.c.data[key],key)
        self.assertIsNone(self.c.expected)
        for action,body in [('arm',{'confirmed':True}),('jog',{'axis':'x','delta':1}),('jog-pulse',{'id':'old-hold-id'}),('reply',{})]:
            with self.subTest(action=action),self.assertRaisesRegex(ValueError,'old setup'):
                self.c.perform(action,body,session_id=old)
        # Stop is deliberately independent of the setup generation.
        self.c.perform('stop',{},session_id=old)
        self.assertTrue(self.c.stopped)

    def test_fresh_setup_waits_for_workers_and_disallows_reset_of_teaching(self):
        self.arm()
        with self.assertRaises(ValueError):self.c.perform('new-session',{})
        self.c.stop()
        worker=Mock();worker.poll.return_value=None;worker.is_alive.return_value=True
        for field in ['child','monitor','monitor_thread']:
            with self.subTest(field=field):
                setattr(self.c,field,worker)
                self.assertFalse(self.c.state()['canStartFresh'])
                with self.assertRaises(ValueError):self.c.perform('new-session',{})
                setattr(self.c,field,None)
        self.c.data['busy']=True
        self.assertFalse(self.c.state()['canStartFresh'])
        with self.assertRaises(ValueError):self.c.perform('new-session',{})

    def test_stale_grid_preview_cannot_start_scan(self):
        self.teach();old=self.c.data['planId']
        self.c.perform('plan',{'spacing':2.5})
        with self.assertRaisesRegex(ValueError,'preview changed'):
            self.c.perform('scan',{'planId':old})
        self.assertEqual(self.c.data['phase'],'teach')
        with self.assertRaises(ValueError):self.c.perform('plan',{'spacing':0})
        self.assertIsNone(self.c.data['plan'])
        with self.assertRaises(ValueError):self.c.perform('scan',{'planId':old})

    def test_demo_diagnostics_and_measurements_are_offline_and_explicitly_simulated(self):
        with patch.object(web,'snapshot',side_effect=AssertionError('Hardware call')),patch.object(web,'save_plan',side_effect=AssertionError('Evidence write')):
            self.c.perform('diagnostics',{})
            self.assertTrue(self.c.data['diagnostics']['checks'][0]['ok'])
            self.teach();self.c.perform('scan',{'planId':self.c.data['planId']})
            while self.c.data['prompt']:
                p=self.c.data['prompt'];self.c.perform('reply',{'id':p['id'],'answer':p['expected']})
            self.assertEqual(len(self.c.data['measurements']),10)
            self.assertTrue(all(m['simulated'] for m in self.c.data['measurements']))
            self.assertEqual(self.c.data['measurements'][0]['contactZ'],self.c.data['measurements'][-1]['contactZ'])
            self.assertEqual(len(self.c.data['route']['points']),10)
            self.assertTrue(self.c.state()['canStartFresh'])

    def test_corner_mismatch_has_actionable_feedback(self):
        self.teach()
        self.c.demo_position['x']=2;self.c.expected=self.c.read_machine()
        self.c.perform('capture',{'corner':'front-left'})
        self.assertIsNone(self.c.data['area'])
        self.assertIn('same X',self.c.data['geometryIssue'])
        self.assertIn('front-left: 2.000',self.c.data['geometryIssue'])

    def test_failed_startup_keeps_actual_error_and_does_not_start_monitor(self):
        self.c.demo=False
        with patch.object(web.subprocess,'run',return_value=Mock(returncode=1,stderr='UGS is disconnected')),patch.object(self.c,'start_monitor') as monitor:
            with self.assertRaisesRegex(ValueError,'UGS is disconnected'):self.arm()
            monitor.assert_not_called()
        self.assertTrue(self.c.stopped)
        self.assertEqual(self.c.data['error'],'UGS is disconnected')

    def test_worker_failure_preserves_the_actionable_reason(self):
        worker=Mock()
        worker.stdout=io.StringIO(json.dumps({'kind':'failure','error':'UGS connected profile differs from machine record: units must be MM'})+'\n')
        worker.stdin=io.StringIO();worker.wait.return_value=1
        with patch.object(web.subprocess,'Popen',return_value=worker):
            with self.assertRaisesRegex(ValueError,'units must be MM'):
                self.c.launch(['fake-worker'])
        self.assertIsNone(self.c.child)

    def test_failure_explanations_distinguish_drift_from_reference_loss(self):
        self.assertEqual(web.fault_details('Return reference drift exceeds tolerance')['title'],'The measurements did not agree')
        self.assertEqual(web.fault_details('UGS is disconnected')['title'],'UGS is unavailable')
        self.assertEqual(web.fault_details('Controller report stalled')['title'],'Session stopped')

    def test_http_requires_object_generation_and_authenticated_report(self):
        server=web.ThreadingHTTPServer(('127.0.0.1',0),web.Handler);server.controller=self.c
        server.host_header=f'127.0.0.1:{server.server_port}'
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def request(method,path,body=None,auth=True):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
            headers={'Content-Type':'application/json'}
            if auth:headers.update(Authorization='Bearer '+self.c.token,**{'X-Client-ID':'test-client'})
            conn.request(method,path,json.dumps(body) if body is not None else None,headers)
            response=conn.getresponse();code=response.status;data=json.loads(response.read());conn.close()
            return code,data
        try:
            for body in [[],{'confirmed':True},{'confirmed':True,'sessionId':'stale'}]:
                self.assertEqual(request('POST','/api/arm',body)[0],400)
            self.assertFalse(self.c.data['armed'])
            self.assertEqual(request('GET','/api/report',auth=False)[0],403)
            code,data=request('GET','/api/report')
            self.assertEqual(code,200)
            self.assertNotIn(self.c.token,json.dumps(data))
            self.assertEqual(data['apiVersion'],3)
            self.assertIn('pcb',data)
            self.assertEqual(request('GET','/api/pcb',auth=False)[0],403)
            code,pcb=request('GET','/api/pcb')
            self.assertEqual(code,200)
            self.assertEqual(pcb['operations'],[])
            self.assertEqual(request('POST','/api/pcb-new',{'sessionId':data['sessionId'],'pcbRevision':-1})[0],400)
            self.assertEqual(request('POST','/api/pcb-new',{'sessionId':data['sessionId'],'pcbRevision':pcb['revision']})[0],200)
            self.assertEqual(request('POST','/api/stop',{})[0],200)
            self.assertTrue(self.c.stopped)
        finally:server.shutdown();server.server_close();thread.join()

    def test_http_rejects_cross_origin_bad_host_and_no_token(self):
        server=web.ThreadingHTTPServer(('127.0.0.1',0),web.Handler);server.controller=self.c
        server.host_header=f'127.0.0.1:{server.server_port}'
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            for headers in [{'Host':'evil.example'}, {'Origin':'https://evil.example'},{}]:
                conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                conn.request('POST','/api/arm',json.dumps({'confirmed':True}),{'Content-Type':'application/json',**headers})
                response=conn.getresponse();self.assertEqual(response.status,403);response.read();conn.close()
            self.assertFalse(self.c.data['armed'])
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
