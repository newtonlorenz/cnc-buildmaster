import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from pcb_gcode import parse_gcode, aligned_gcode, transform
from pcb_workspace import Workspace
import cnc_map_web as web

BOX = """G21 G90 G17 G94 G54
M5
G0 Z5
G0 X0 Y0
M3 S1000
G1 Z-0.1 F20
G1 X10 F80
Y10
X0
Y0
G0 Z5
M5
M2
"""


def workspace():
    w=Workspace()
    w.import_files([{'name':'isolation.nc','source':BOX}])
    w.placement.update(x=20,y=20)
    w.operation({'id':w.operations[0]['id'],'role':'isolation','tool':'Test cutter','diameter':.2})
    return w


def references(w,session='session'):
    for label,design,machine in [('A',[0,0],[20,20]),('B',[10,0],[30,20]),('C',[0,10],[20,30])]:
        w.reference(label,design,machine,session)
    w.solve(session)


class GcodeTests(unittest.TestCase):
    def test_example_files_parse_without_hardware_or_altering_sources(self):
        root=Path(__file__).resolve().parents[1]/'examples'
        files=sorted(root.glob('*.nc'))
        self.assertEqual(len(files),1)
        for path in files:
            with self.subTest(file=path.name):
                before=path.read_bytes();parsed=parse_gcode(before.decode())
                self.assertGreater(parsed['pointCount'],0)
                self.assertEqual(parsed['warnings'],['The initial approach from the machine position is not shown.'])
                self.assertEqual(path.read_bytes(),before)

    def test_modal_axes_and_initial_unknown_position(self):
        p=parse_gcode(BOX)
        self.assertEqual(p['cutBounds'],{'x':[0,10],'y':[0,10],'z':[-.1,5]})
        self.assertEqual(p['paths'][0]['points'],[[0,0,5]])
        self.assertEqual(p['blocks'][0]['line'],1)
        self.assertGreater(p['feedMinutes'],0)

    def test_inches_incremental_and_dwell_round_trip(self):
        source='G20 G90 G17\nG0 Z.2\nG0 X1 Y2\nM3 S500\nG4 P2\nG91\nG1 Z-.21 F2\nX1 F4\nY1\nG0 Z.21\nM5\nM2\n'
        p=parse_gcode(source)
        result=aligned_gcode(p,{'x':10,'y':20,'angle':90,'mirror':False},{'x':2,'y':3})
        out=parse_gcode(result)
        self.assertAlmostEqual(out['cutBounds']['x'][0],8-76.2)
        self.assertAlmostEqual(out['cutBounds']['x'][1],8-50.8)
        self.assertAlmostEqual(out['cutBounds']['y'][0],17+25.4)
        self.assertAlmostEqual(out['cutBounds']['z'][0],-.254)
        self.assertIn('G4 P2',result);self.assertIn('F101.6',result)

    def test_arc_extrema_full_circle_and_radius_major_minor(self):
        for command,bounds_x,bounds_y in [
            ('G3 X-1 Y0 I-1 J0',[-1,1],[0,1]),
            ('G2 X-1 Y0 I-1 J0',[-1,1],[-1,0]),
            ('G2 I-1 J0',[-1,1],[-1,1]),
            ('G3 X0 Y1 R1',[0,1],[0,1]),
            ('G3 X0 Y1 R-1',[0,2],[0,2]),
            ('G3 X-1 Y0 R-1',[-1,1],[0,1]),
        ]:
            source='G21 G90 G17\nG0 Z5\nG0 X1 Y0\nM3 S500\nG1 Z-.1 F20\n'+command+'\nG0 Z5\nM5\nM2'
            p=parse_gcode(source)
            with self.subTest(command=command):
                for actual,expected in zip(p['cutBounds']['x']+p['cutBounds']['y'],bounds_x+bounds_y):self.assertAlmostEqual(actual,expected,places=6)

    def test_mirrored_rotated_arc_export_preserves_geometry_and_reverses_direction(self):
        source='G21 G90 G17\nG0 Z5\nG0 X1 Y0\nM3 S500\nG1 Z-.1 F20\nG3 X0 Y1 I-1 J0\nG0 Z5\nM5\nM2'
        with self.assertRaisesRegex(ValueError,'Declare G17'):parse_gcode(source.replace(' G17',''))
        p=parse_gcode(source);placement={'x':30,'y':40,'angle':30,'mirror':True}
        transformed=aligned_gcode(p,placement,{'x':10,'y':20})
        out=parse_gcode(transformed)
        original_arc=next(b['move'] for b in p['blocks'] if b.get('move',{}).get('g')==3)
        new_arc=next(b['move'] for b in out['blocks'] if b.get('move',{}).get('g')==2)
        for key in ['from','to','centre']:
            expected=transform(original_arc[key],placement)
            expected[0]-=10;expected[1]-=20
            for a,b in zip(new_arc[key],expected):self.assertAlmostEqual(a,b,places=5)

    def test_rejects_unsupported_incomplete_ambiguous_or_hidden_motion(self):
        cases=['$H','G53 G0 X0 Y0','G92 X0','G55','G18','G81 X1 Y1 Z-1 R2','G90.1','M6','M98 P1',
               'G1 X1 X2','G1 Xnan','G1 X1 ; ok\nG10 L20 P1 X0','G0 G1 X1','G2 X0 Y0 R.1','G2 X0 Y1 I0 J0',
               'G4 P1 X0','G1 A1','G91\nG0 X1','(unclosed','((nested))','!','N-1','N1.5']
        for code in cases:
            with self.subTest(code=code),self.assertRaises(ValueError):
                parse_gcode(code+'\n'+BOX)
        for source in ['G0 X0 Y0\n'+BOX,BOX+'G0 X3',BOX.replace('G0 X0 Y0','G0 X0')]:
            with self.assertRaises(ValueError):parse_gcode(source)

    def test_clearance_warnings_and_no_silent_scaling(self):
        p=parse_gcode(BOX.replace('G1 X10 F80','G0 X10'))
        self.assertTrue(any('Rapid XY' in w for w in p['warnings']))
        p=parse_gcode(BOX.replace('M3 S1000','M3 S1000\nS0'))
        self.assertTrue(any('positive speed' in w for w in p['warnings']))
        w=workspace();w.reference('A',[0,0],[20,20]);w.reference('B',[10,0],[30.2,20])
        with self.assertRaisesRegex(ValueError,'will not be scaled'):w.solve('session')


class WorkspaceTests(unittest.TestCase):
    def test_rigid_three_point_alignment_and_stale_reference(self):
        w=workspace()
        placement={'x':20,'y':25,'angle':37,'mirror':False}
        for label,p in [('A',[0,0]),('B',[20,0]),('C',[0,15])]:w.reference(label,p,transform(p,placement),'current')
        w.solve('current')
        self.assertAlmostEqual(w.placement['angle'],37)
        self.assertTrue(w.valid_alignment('current'))
        self.assertFalse(w.valid_alignment('old'))
        w.invalidate('Reconnect')
        self.assertFalse(w.valid_alignment('current'));self.assertIsNone(w.references['A']['machine'])
        self.assertEqual(w.references['A']['design'],[0,0])

    def test_third_point_rejection_and_manual_points_remain_draft(self):
        w=workspace();references(w,None)
        self.assertFalse(w.public('session')['canExport'])
        w.reference('C',[0,10],[20.2,30],'session')
        with self.assertRaisesRegex(ValueError,'point C misses'):w.solve('session')
        w.reference('C',[5,0],[25,20],'session')
        with self.assertRaisesRegex(ValueError,'A–B line'):w.solve('session')

    def test_cutting_footprint_uses_tool_radius_and_depth_allowance(self):
        w=workspace();references(w)
        self.assertTrue(w.public('session')['canExport'])
        w.stock['x']=20
        self.assertFalse(w.public('session')['operations'][0]['fits'])
        w.stock['x']=0;w.stock.update(thickness=.02,spoilAllowance=0)
        self.assertFalse(w.public('session')['operations'][0]['depthOk'])

    def test_import_is_atomic_and_checks_source_hash_on_restore(self):
        w=workspace();original=copy.deepcopy(w.package())
        with self.assertRaises(ValueError):w.import_files([{'name':'ok.nc','source':BOX},{'name':'bad.nc','source':'G53 G0 X0'}])
        self.assertEqual(len(w.operations),1)
        damaged=copy.deepcopy(original);damaged['files'][0]['source']+='(edited)'
        with self.assertRaisesRegex(ValueError,'hash'):Workspace.from_package(damaged)
        for filename in ['../cut.nc','x/y.nc','x\\y.nc','cut.html']:
            with self.assertRaises(ValueError):w.import_files([{'name':filename,'source':BOX}])

    def test_package_round_trip_keeps_sources_and_discards_physical_references(self):
        w=workspace();references(w)
        restored=Workspace.from_package(w.package('session'))
        self.assertEqual(restored.operations[0]['source'],BOX)
        self.assertEqual(restored.placement,w.placement)
        self.assertIsNone(restored.alignment)
        self.assertIsNone(restored.references['A']['machine'])
        self.assertFalse(restored.public('session')['canExport'])

    def test_settings_only_job_can_be_saved_and_reopened(self):
        w=Workspace();w.name='Fixture planning';w.stock.update(width=150,height=80)
        restored=Workspace.from_package(w.package())
        self.assertEqual(restored.name,w.name)
        self.assertEqual(restored.stock,w.stock)
        self.assertEqual(restored.operations,[])
        self.assertFalse(restored.public()['canExport'])

    def test_export_has_all_operations_preserves_original_and_does_not_apply_height_compensation(self):
        w=workspace();references(w)
        archive=w.export('session',{'x':2,'y':3},True)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertEqual(z.read('originals/isolation.nc').decode(),BOX)
            output=z.read('prepared/01-isolation-ALIGNED-DRAFT.nc.txt').decode()
            p=parse_gcode(output)
            self.assertEqual(p['cutBounds']['x'],[18,28])
            self.assertEqual(p['cutBounds']['y'],[17,27])
            self.assertEqual(p['cutBounds']['z'],[-.1,5])
            self.assertIn('M5\nM0',output)
            self.assertFalse(json.loads(z.read('job.pcb-job.json'))['heightCompensationAddedByWorkbench'])
            self.assertEqual(json.loads(z.read('job.pcb-job.json'))['sourceHeightCompensation'],'unknown')
            self.assertFalse(json.loads(z.read('reference.json'))['cuttingReleased'])
        with self.assertRaises(ValueError):w.export('another-session',{'x':2,'y':3})


class ControllerPcbTests(unittest.TestCase):
    def setUp(self):
        self.c=web.Controller(demo=True);self.c.authenticate(self.c.token,'test')
    def tearDown(self):self.c.closed=True
    def action(self,action,**body):
        return self.c.perform(action,{'pcbRevision':self.c.pcb.revision,**body},self.c.data['sessionId'])

    def test_offline_preparation_never_calls_machine_and_old_job_requests_fail(self):
        with patch.object(web,'snapshot',side_effect=AssertionError('machine')),patch.object(web.subprocess,'Popen',side_effect=AssertionError('worker')):
            self.action('pcb-import',files=[{'name':'test.nc','source':BOX}])
            revision=self.c.pcb.revision
            self.action('pcb-new')
            with self.assertRaisesRegex(ValueError,'job changed'):self.c.perform('pcb-import',{'pcbRevision':revision,'files':[]})
            self.action('pcb-load',package=workspace().package())
            saved=self.action('pcb-save')
            self.assertIsNone(saved['savedPath'])
            self.assertEqual(saved['package']['format'],'cnc-pcb-job')

    def test_capture_requires_teaching_and_stop_invalidates_references(self):
        self.action('pcb-import',files=[{'name':'test.nc','source':BOX}])
        with self.assertRaisesRegex(ValueError,'Enable teaching'):self.action('pcb-capture',label='A',design=[0,0])
        self.c.perform('arm',{'confirmed':True})
        self.action('pcb-capture',label='A',design=[0,0])
        self.assertEqual(self.c.pcb.references['A']['machine'],[0,0])
        self.c.stop()
        self.assertIsNone(self.c.pcb.references['A']['machine'])
        self.assertEqual(len(self.c.pcb.operations),1)

    def test_job_survives_new_machine_session_without_reusing_alignment(self):
        self.c.pcb=workspace();references(self.c.pcb,self.c.data['sessionId'])
        self.c.stop();self.c.perform('new-session',{})
        self.assertEqual(len(self.c.pcb.operations),1)
        self.assertFalse(self.c.pcb.valid_alignment(self.c.data['sessionId']))

    def test_local_save_is_unique_and_restore_does_not_arm(self):
        self.c.pcb=workspace();self.c.demo=False
        with tempfile.TemporaryDirectory() as folder,patch.object(web,'snapshot',side_effect=AssertionError('machine')):
            self.c.jobs_dir=Path(folder)
            a=self.action('pcb-save');b=self.action('pcb-save')
            self.assertNotEqual(a['savedPath'],b['savedPath'])
            self.action('pcb-load',savedId=Path(a['savedPath']).name)
            self.assertTrue(any('recovery' in p.name for p in Path(folder).glob('*.json')))
            self.assertFalse(self.c.data['armed'])
            with self.assertRaises(ValueError):self.action('pcb-load',savedId='../escape.json')


if __name__=='__main__':unittest.main()
