import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from surface_config import ROOT, load_config

class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)/'local.json'
        self.value = json.loads((ROOT/'config/example.json').read_text())
        self.value['configured'] = True
        self.value['machine']['connection']['port'] = '/dev/cu.TEST'
        for k in (0,1,2,3,4,5,6,10,11,12,13,20,21,22,23,24,25,26,27,30,31,32,100,101,102,120,121,122,130,131,132):
            self.value['baseline'][str(k)] = '0'

    def load(self, value=None):
        self.path.write_text(json.dumps(value or self.value))
        with patch.dict(os.environ, {'CNC_BUILDMASTER_CONFIG':str(self.path)}):
            return load_config()

    def test_missing_configuration_blocks_machine_mode(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ValueError):
            load_config()

    def test_example_cannot_enable_machine_mode(self):
        self.value['configured'] = False
        with self.assertRaises(ValueError): self.load()

    def test_other_machine_height_port_and_relative_storage(self):
        self.value.update(puckHeight=19.725, ugsPort=8123)
        c = self.load()
        self.assertEqual(c['puckHeight'], 19.725)
        self.assertEqual(c['ugsPort'], 8123)
        self.assertEqual(c['dataDir'], str((self.path.parent/'data').resolve()))

    def test_node_and_python_use_the_same_configuration(self):
        self.value.update(puckHeight=19.725, ugsPort=8123)
        expected = self.load()
        with patch.dict(os.environ, {'CNC_BUILDMASTER_CONFIG':str(self.path)}):
            text = subprocess.check_output(['node','--input-type=module','-e', "import {getConfig,apiBase,socketUrl} from './scripts/surface_config.mjs'; console.log(JSON.stringify({c:getConfig(),apiBase,socketUrl}));"],cwd=ROOT,text=True)
        result=json.loads(text)
        self.assertEqual(result['c'], expected)
        self.assertEqual(result['apiBase'],'http://127.0.0.1:8123/api/v1/')
        self.assertEqual(result['socketUrl'],'ws://127.0.0.1:8123/ws/v1/events')

    def test_invalid_height_and_port(self):
        for key, values in {'puckHeight':[0,-1,101,True,float('nan'),1.1234], 'ugsPort':[80,65536,8080.5,True]}.items():
            for value in values:
                with self.subTest(key=key,value=value),self.assertRaises(ValueError):
                    c=copy.deepcopy(self.value);c[key]=value;self.load(c)

    def test_incomplete_baseline_is_rejected(self):
        del self.value['baseline']['6']
        with self.assertRaises(ValueError): self.load()

    def test_excess_contact_feed_is_rejected(self):
        self.value['feeds']['second']=11
        with self.assertRaises(ValueError): self.load()

    def test_another_firmware_is_rejected(self):
        self.value['machine']['sender_defaults']['firmware']='TinyG'
        with self.assertRaises(ValueError): self.load()
