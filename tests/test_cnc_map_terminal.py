import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('cnc_map_terminal',ROOT/'scripts/cnc_map_terminal.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
support_spec=importlib.util.spec_from_file_location('cnc_map_support',ROOT/'scripts/cnc_map_support.py')
support=importlib.util.module_from_spec(support_spec); support_spec.loader.exec_module(support)


def snap(x,y,z=10):
    return {'listener':{'pid':12}, 'file':{'fileName':''}, 'status':{'state':'IDLE','spindleSpeed':0,'feedSpeed':0,
        'machineCoord':{'x':x,'y':y,'z':z,'units':'MM'}, 'workCoord':{'x':x-2,'y':y-3,'z':z+14,'units':'MM'}}}


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self.corners=[snap(0,0),snap(100,0),snap(100,75),snap(0,75)]

    def test_real_runner_schema_and_native_grid(self):
        config=m.make_config(self.corners,50)
        self.assertEqual(config['grid'],{'x':[0,50,100],'y':[0,50,75],'spacing':50})
        self.assertEqual(config['expectedG54'],{'x':2,'y':3,'z':-14})
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'config.json';p.write_text(json.dumps(config))
            result=json.loads(subprocess.check_output(['node',str(ROOT/'scripts/ugs_puck_map.mjs'),'--config',str(p)],text=True))
            self.assertEqual(result['mode'],'OFFLINE PLAN')
            self.assertEqual(len(result['route']['points']),10)
            self.assertEqual(result['route']['points'][0],{'x':0,'y':75})

    def test_misaligned_degenerate_changed_height_and_reference_fail(self):
        for corner, field, value in [(1,'x',0),(1,'y',1),(2,'z',11),(3,'x',1)]:
            c=copy.deepcopy(self.corners);c[corner]['status']['machineCoord'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):m.make_config(c,50)
        c=copy.deepcopy(self.corners);c[1]['listener']['pid']=13
        with self.assertRaises(ValueError):m.make_config(c,50)

    def test_demo_route_matches_actual_runner_for_corner_and_interior_starts(self):
        with tempfile.TemporaryDirectory() as directory:
            for current in [snap(0,0),snap(100,75),snap(50,50)]:
                config=m.make_config(self.corners,25,current)
                p=Path(directory)/'config.json';p.write_text(json.dumps(config))
                planned=json.loads(subprocess.check_output(['node',str(ROOT/'scripts/ugs_puck_map.mjs'),'--config',str(p)],text=True))
                demo=support.scan_route(config)
                self.assertEqual(demo['points'],planned['route']['points'])
                self.assertAlmostEqual(demo['distance'],planned['route']['distance'],places=6)
        c=copy.deepcopy(self.corners);c[1]['status']['workCoord']['x']+=1
        with self.assertRaises(ValueError):m.make_config(c,50)

    def test_spacing_nonfinite_too_dense_and_short_remainder_rejected(self):
        for spacing in [0,-1,100,float('nan'),float('inf'),.001,.1,24.999,50.0001]:
            with self.subTest(spacing=spacing),self.assertRaises(ValueError):m.make_config(self.corners,spacing)

    def test_no_capture_during_motion_or_loaded_job(self):
        for key,value in [('state','RUN'),('feedSpeed',1),('spindleSpeed',1)]:
            c=snap(0,0);c['status'][key]=value
            with self.assertRaises(ValueError):m.position(c)
        c=snap(0,0);c['file']['fileName']='cut.nc'
        with self.assertRaises(ValueError):m.position(c)


if __name__=='__main__':unittest.main()
