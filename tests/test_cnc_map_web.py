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

    def test_manual_corners_preserve_machine_position_and_offset(self):
        self.arm()
        original=copy.deepcopy(self.c.read_machine())
        with patch.object(web.subprocess,'Popen',side_effect=AssertionError('Motion worker')):
            for name,x,y in [('front-left',0,0),('back-right',10,10),('front-right',10,0),('back-left',0,10)]:
                self.c.perform('corner-entry',{'corner':name,'x':x,'y':y})
        self.assertEqual(self.c.read_machine(),original)
        self.assertEqual(self.c.data['area'],{'x':[0,10],'y':[0,10]})
        self.assertTrue(all(p['source']=='entered' for p in self.c.data['corners']))
        self.c.perform('plan',{'spacing':5})
        self.assertIsNotNone(self.c.data['plan'])
        for value in [True,'',float('nan'),float('inf'),10001,1.0001]:
            with self.assertRaises(ValueError):
                self.c.perform('corner-entry',{'corner':'front-left','x':value,'y':0})
        self.c.stop('test stop')
        with self.assertRaises(ValueError):
            self.c.perform('corner-entry',{'corner':'front-left','x':0,'y':0})

    def test_entered_bounds_do_not_claim_current_position_or_missing_dimension(self):
        self.arm()
        self.c.perform('corner-entry',{'corner':'front-left','x':10,'y':10})
        self.c.perform('corner-entry',{'corner':'front-right','x':20,'y':10})
        self.assertIsNone(self.c.data['area'])
        self.c.perform('corner-entry',{'corner':'back-left','x':10,'y':20})
        self.assertEqual(self.c.data['area'],{'x':[10,20],'y':[10,20]})
        self.c.perform('corner-entry',{'corner':'back-right','x':20,'y':20})
        with self.assertRaisesRegex(ValueError,'Move to a recorded corner'):
            self.c.perform('plan',{'spacing':5})
        self.assertEqual(self.c.data['status']['machineCoord']['x'],0)
        self.c.perform('corner-entry',{'corner':'back-right','x':21,'y':20})
        self.assertIsNone(self.c.data['area'])
        self.assertIsNotNone(self.c.data['geometryIssue'])

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

    def test_scan_cannot_complete_without_saved_result(self):
        worker=Mock(stdout=io.StringIO(''),stdin=io.StringIO())
        worker.wait.return_value=0
        with patch.object(web.subprocess,'Popen',return_value=worker):
            with self.assertRaisesRegex(ValueError,'without a saved'):
                self.c.launch(['fake-worker'],scan=True)
        self.assertIsNone(self.c.data['result'])

    def test_failure_event_cannot_be_masked_by_success_exit(self):
        worker=Mock(stdout=io.StringIO(json.dumps({'kind':'failure','error':'Probe rejected'})+'\n'),stdin=io.StringIO())
        worker.wait.return_value=0
        with patch.object(web.subprocess,'Popen',return_value=worker):
            with self.assertRaisesRegex(ValueError,'Probe rejected'):
                self.c.launch(['fake-worker'],scan=True)

    def test_scan_checks_saved_acceptance_and_map_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            folder=root/'evidence/test-scan'
            folder.mkdir(parents=True)
            (folder/'config.json').write_text('{}')
            xyz=folder/'surface.xyz';xyz.write_text('0 0 0\n0 1 0.1\n')
            summary={'drift':0.001,'requiredG54Z':-14.0}
            (folder/'result.json').write_text(json.dumps({**summary,'physicalObservationConfirmed':True,'offsetsPreserved':True,'appliedInUgs':False}))
            (folder/'ugs-handoff.json').write_text(json.dumps({'sha256':web.hashlib.sha256(xyz.read_bytes()).hexdigest()}))
            event={'kind':'result','path':str(xyz),'summary':summary}
            def run():
                worker=Mock(stdout=io.StringIO(json.dumps(event)+'\n'),stdin=io.StringIO())
                worker.wait.return_value=0
                with patch.dict(self.c.profile,{'dataDir':str(folder.parent)}),patch.object(web.subprocess,'Popen',return_value=worker):
                    self.c.launch(['fake-worker'],scan=True)
            run()
            self.assertEqual(set(self.c.data['result']['acceptedHashes']), {'surface.xyz','config.json','result.json','ugs-handoff.json'})
            self.assertEqual({k:v for k,v in self.c.data['result'].items() if k!='acceptedHashes'},event)
            self.c.data['result']=None
            xyz.write_text('altered')
            with self.assertRaisesRegex(ValueError,'checksum'):run()
            self.assertIsNone(self.c.data['result'])

    def test_missing_reference_ack_is_not_reported_as_changed_offset(self):
        self.assertEqual(web.fault_details('UGS did not acknowledge the reference query')['title'], 'UGS did not answer the reference check')

    def test_failure_explanations_distinguish_drift_from_reference_loss(self):
        self.assertEqual(web.fault_details('Return reference drift exceeds tolerance')['title'],'The measurements did not agree')
        self.assertEqual(web.fault_details('UGS is disconnected')['title'],'UGS is unavailable')
        self.assertEqual(web.fault_details('Controller report stalled')['title'],'Session stopped')

    def test_http_requires_object_generation_and_authenticated_report(self):
        server=web.LocalHTTPServer(('127.0.0.1',0),web.Handler);server.controller=self.c
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
            self.assertEqual(data['apiVersion'],7)
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

    def test_html_has_fresh_scoped_style_nonce_and_only_current_assets(self):
        server = web.LocalHTTPServer(('127.0.0.1', 0), web.Handler)
        server.controller = self.c
        server.host_header = f'127.0.0.1:{server.server_port}'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def get(path):
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
            conn.request('GET', path)
            response = conn.getresponse()
            result = (response.status, response.getheader('Content-Security-Policy'), response.read())
            conn.close()
            return result
        try:
            nonces = []
            for _ in range(2):
                code, policy, body = get('/')
                self.assertEqual(code, 200)
                html = body.decode()
                nonce = web.re.search(r'name="csp-nonce" content="([A-Za-z0-9_-]+)"', html).group(1)
                nonces.append(nonce)
                self.assertIn(f"style-src 'self' 'nonce-{nonce}'", policy)
                self.assertIn("script-src 'self';", policy)
                self.assertNotIn('unsafe-inline', policy)
                self.assertNotIn(self.c.token, html)
                self.assertIn('/app.bundle.js', html)
                self.assertNotIn('/workbench.js', html)
            self.assertNotEqual(*nonces)
            self.assertEqual(get('/app.js')[0], 404)
            self.assertEqual(get('/app.bundle.js')[0], 200)
            self.assertEqual(get('/app.css')[0], 200)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_http_rejects_cross_origin_bad_host_and_no_token(self):
        server=web.LocalHTTPServer(('127.0.0.1',0),web.Handler);server.controller=self.c
        server.host_header=f'127.0.0.1:{server.server_port}'
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            for headers in [{'Host':'evil.example'}, {'Origin':'https://evil.example'},{}]:
                conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
                conn.request('POST','/api/arm',json.dumps({'confirmed':True}),{'Content-Type':'application/json',**headers})
                response=conn.getresponse();self.assertEqual(response.status,403);response.read();conn.close()
            self.assertFalse(self.c.data['armed'])
        finally:server.shutdown();server.server_close();thread.join()

class RectangleCompletionTests(unittest.TestCase):
    def setUp(self):
        self.c = web.Controller(demo=True)
        self.c.authenticate(self.c.token, 'test-client')
        self.c.perform('arm', {'confirmed': True})
        self.area = {'x': [-10.125, 80.137], 'y': [-5.375, 50.129]}
        self.points = dict(zip(web.CORNERS, [(-10.125, -5.375), (80.137, -5.375),
                                           (80.137, 50.129), (-10.125, 50.129)]))

    def tearDown(self):
        self.c.closed = True

    def record(self, names=('front-left', 'back-right'), action='capture'):
        for name in names:
            x, y = self.points[name]
            self.c.demo_position.update(x=x, y=y)
            self.c.expected = self.c.read_machine()
            self.c.perform(action, {'corner': name, 'x': x, 'y': y})

    def seed_plan(self):
        self.c.data.update(plan={'previous': True}, route={'points': []}, planId='previous-plan')
        self.c.plan_path = Path('previous-plan.json')

    def completion_state(self):
        return copy.deepcopy((self.c.snapshots, self.c.expected, self.c.demo_position, self.c.plan_path,
                              {key: self.c.data[key] for key in
                               ('corners', 'area', 'geometryIssue', 'plan', 'route', 'planId')}))

    def assert_rejected(self, body=None, session_id=None, message=None):
        self.seed_plan()
        before = self.completion_state()
        with self.assertRaisesRegex(ValueError, message or '.'):
            self.c.perform('complete-rectangle', {'area': self.area} if body is None else body,
                           session_id=self.c.data['sessionId'] if session_id is None else session_id)
        self.assertEqual(self.completion_state(), before)

    def test_two_opposite_corners_complete_without_changing_captures_or_machine(self):
        original_read = self.c.read_machine
        offset = {'x': 2.375, 'y': -3.125, 'z': 14.25}
        def read_with_offset():
            s = original_read()
            for axis in 'xyz':
                s['status']['workCoord'][axis] -= offset[axis]
            return s
        with patch.object(self.c, 'read_machine', side_effect=read_with_offset):
            self.c.expected = self.c.read_machine()
            for names in [('back-right', 'front-left'), ('back-left', 'front-right')]:
                with self.subTest(names=names):
                    self.c.perform('reset-corners', {})
                    self.record(names)
                    captured = self.c.snapshots.copy()
                    saved = copy.deepcopy(captured)
                    expected = copy.deepcopy(self.c.expected)
                    stationary = self.c.read_machine()
                    # Only the fresh stationary reading has this field.
                    stationary['freshness'] = {'sample': [1]}
                    self.seed_plan()
                    with patch.object(self.c, 'read_machine', return_value=stationary) as read, \
                         patch.object(self.c, 'launch', side_effect=AssertionError('Motion worker')), \
                         patch.object(web.subprocess, 'Popen', side_effect=AssertionError('Child launch')):
                        self.c.perform('complete-rectangle', {'area': self.area}, session_id=self.c.data['sessionId'])
                    read.assert_called_once_with()
                    self.assertEqual(self.c.expected, expected)
                    self.assertEqual(self.c.read_machine()['status'], stationary['status'])
                    self.assertEqual(self.c.data['status'], stationary['status'])
                    self.assertEqual(web.taught_rectangle(self.c.snapshots), self.area)
                    self.assertEqual(self.c.data['area'], self.area)
                    self.assertIsNone(self.c.data['geometryIssue'])
                    for key in ('plan', 'route', 'planId'):
                        self.assertIsNone(self.c.data[key])
                    self.assertIsNone(self.c.plan_path)
                    self.assertFalse(self.c.data['busy'])
                    self.assertEqual(self.c.data['phase'], 'teach')
                    for name, snap in self.c.snapshots.items():
                        if name in captured:
                            self.assertIs(snap, captured[name])
                            self.assertEqual(snap, saved[name])
                        else:
                            self.assertEqual(snap['cornerSource'], 'inferred')
                            self.assertEqual(snap['freshness'], stationary['freshness'])
                            self.assertIsNot(snap['freshness'], stationary['freshness'])
                            self.assertIsNot(snap['status']['machineCoord'], stationary['status']['machineCoord'])
                            self.assertIsNot(snap['status']['workCoord'], stationary['status']['workCoord'])
                            self.assertEqual(web.position(snap)[1], offset)
                            self.assertEqual(web.position(snap)[0]['z'], web.position(stationary)[0]['z'])
                        public = next(p for p in self.c.data['corners'] if p['name'] == name)
                        self.assertEqual(public['source'], 'captured' if name in captured else 'inferred')
                    inferred = [s for n, s in self.c.snapshots.items() if n not in captured]
                    self.assertIsNot(inferred[0]['status'], inferred[1]['status'])

    def test_three_coherent_corners_fill_only_missing_corner_and_preserve_entry_source(self):
        for missing in web.CORNERS:
            with self.subTest(missing=missing):
                self.c.perform('reset-corners', {})
                self.record([n for n in web.CORNERS if n != missing], action='corner-entry')
                before = copy.deepcopy(self.c.snapshots)
                self.c.perform('complete-rectangle', {'area': self.area})
                self.assertEqual(len(self.c.snapshots), 4)
                self.assertEqual(web.taught_rectangle(self.c.snapshots), self.area)
                for name, snap in before.items():
                    self.assertEqual(self.c.snapshots[name], snap)
                    self.assertEqual(self.c.snapshots[name]['cornerSource'], 'entered')
                self.assertEqual(self.c.snapshots[missing]['cornerSource'], 'inferred')
                self.c.perform('plan', {'spacing': 5})
                self.assertIsNotNone(self.c.data['plan'])
                self.assertEqual(self.c.data['plan']['start'], web.position(self.c.expected)[0])

    def test_old_bounds_and_stale_session_are_rejected_atomically(self):
        self.record()
        self.assert_rejected(session_id='old-setup', message='old setup')
        self.c.demo_position['x'] += 1
        self.c.expected = self.c.read_machine()
        self.c.perform('capture', {'corner': 'back-right'})
        self.assert_rejected(message='preview changed')
        # A cached/presented area cannot override the snapshots' current geometry.
        self.c.data['area'] = copy.deepcopy(self.area)
        self.assert_rejected(message='preview changed')

    def test_missing_adjacent_and_inconsistent_corners_reject_supplied_geometry(self):
        for names in [(), ('front-left',), ('front-left', 'front-right'), ('front-left', 'back-left')]:
            with self.subTest(names=names):
                self.c.perform('reset-corners', {})
                self.record(names)
                self.assert_rejected()
        self.c.perform('reset-corners', {})
        self.record(('front-left', 'back-right', 'front-right'))
        self.c.snapshots['front-right']['status']['machineCoord']['x'] += 1
        self.assert_rejected()

    def test_invalid_presented_areas_are_rejected_atomically(self):
        self.record()
        for area in [None, [], {}, {'x': self.area['x']},
                     {'x': self.area['x'], 'y': self.area['y'], 'z': [0, 0]},
                     {'x': 'invalid', 'y': self.area['y']},
                     {'x': [self.area['x'][0]], 'y': self.area['y']},
                     *({'x': [value, self.area['x'][1]], 'y': self.area['y']}
                       for value in [True, '0', None, float('nan'), float('inf'), 10**1000, -10.1251])]:
            with self.subTest(area=area):
                self.assert_rejected({'area': area})

    def test_changed_raised_height_is_rejected_without_partial_corners(self):
        self.record()
        self.c.demo_position['z'] = 1
        self.c.expected = self.c.read_machine()
        self.assert_rejected(message='same raised Z')
        self.assertFalse(self.c.stopped)

    def test_inconsistent_recorded_height_offset_and_listener_reject_staged_corners(self):
        self.record()
        recorded = copy.deepcopy(self.c.snapshots)
        for change in ('height', 'offset', 'listener'):
            with self.subTest(change=change):
                self.c.snapshots = copy.deepcopy(recorded)
                other = self.c.snapshots['back-right']
                if change == 'height':
                    for coords in ('machineCoord', 'workCoord'):
                        other['status'][coords]['z'] += 1
                elif change == 'offset':
                    other['status']['workCoord']['x'] += 1
                else:
                    other['listener']['pid'] += 1
                self.assert_rejected()

    def test_checked_reference_rejects_external_motion_and_latches_stop(self):
        self.record()
        self.c.demo_position['x'] += 1
        with patch.object(self.c, 'checked', wraps=self.c.checked) as checked:
            self.assert_rejected(message='reference changed')
        checked.assert_called_once_with()
        self.assertTrue(self.c.stopped)

    def test_machine_must_be_stationary_with_spindle_off_and_no_selected_file(self):
        self.record()
        for field, value in [('state', 'RUN'), ('feedSpeed', 1), ('spindleSpeed', 1), ('fileName', 'cut.nc')]:
            with self.subTest(field=field):
                self.c.stopped = False
                self.c.data.update(armed=True, phase='teach')
                s = self.c.read_machine()
                s['file' if field == 'fileName' else 'status'][field] = value
                with patch.object(self.c, 'read_machine', return_value=s):
                    self.assert_rejected(message='must be idle')
                self.assertTrue(self.c.stopped)

    def test_stopped_busy_unarmed_and_invalid_phases_reject_before_reading_machine(self):
        self.record()
        for updates in [{'armed': False}, {'busy': True}, {'phase': 'scan'},
                        {'phase': 'setup'}, {'phase': 'complete'}, {'stopped': True}]:
            with self.subTest(updates=updates):
                self.c.stopped = updates.get('stopped', False)
                self.c.data.update(armed=True, busy=False, phase='teach')
                self.c.data.update({k: v for k, v in updates.items() if k != 'stopped'})
                with patch.object(self.c, 'checked', side_effect=AssertionError('Machine read')):
                    self.assert_rejected()

    def test_action_lock_excludes_concurrent_completion(self):
        self.record()
        with self.c.action_lock, patch.object(self.c, 'checked', side_effect=AssertionError('Machine read')):
            self.assert_rejected(message='already in progress')

    def test_stop_during_checked_reference_prevents_atomic_commit(self):
        self.record()
        checked = self.c.checked
        def stop_after_check():
            s = checked()
            self.c.stop('Stop during rectangle completion')
            return s
        with patch.object(self.c, 'checked', side_effect=stop_after_check):
            self.assert_rejected(message='Session stopped')
        self.assertTrue(self.c.stopped)

    def test_http_completion_requires_current_session_and_preserves_actual_position(self):
        self.record()
        server = web.LocalHTTPServer(('127.0.0.1', 0), web.Handler)
        server.controller = self.c
        server.host_header = f'127.0.0.1:{server.server_port}'
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        before = copy.deepcopy(self.c.demo_position)
        try:
            for session_id, expected_code in [(None, 400), ('old-setup', 400), (self.c.data['sessionId'], 200)]:
                body = {'area': self.area}
                if session_id is not None:
                    body['sessionId'] = session_id
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
                try:
                    conn.request('POST', '/api/complete-rectangle', json.dumps(body),
                                 {'Content-Type': 'application/json', 'Authorization': 'Bearer '+self.c.token,
                                  'X-Client-ID': 'test-client'})
                    response = conn.getresponse()
                    self.assertEqual(response.status, expected_code, response.read())
                    self.assertEqual(len(self.c.snapshots), 4 if expected_code == 200 else 2)
                finally:
                    conn.close()
            self.assertEqual(self.c.demo_position, before)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__=='__main__':unittest.main()
