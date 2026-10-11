"""Read-only controller evidence, using simulation and a synthetic clock."""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from cnc_map_web import Controller


class ControllerReportTests(unittest.TestCase):
    def test_report_retains_overrides_but_expires_and_does_not_authorise_motion(self):
        c=Controller(demo=True)
        self.addCleanup(setattr,c,'closed',True)
        c.data['continuityActive']=True
        report={'state':'HOLD','spindleSpeed':1000,'overrides':{'feed':200}}
        with patch('cnc_map_web.time.monotonic',return_value=10):
            c.record_controller_report(report)
        report['overrides']['feed']=100
        with patch('cnc_map_web.time.monotonic',return_value=11):
            observed=c.state()['controllerReport']
        self.assertTrue(observed['fresh'])
        self.assertEqual(observed['status']['overrides']['feed'],200)
        self.assertFalse(c.data['armed'])
        self.assertIsNone(c.data['status'])
        with patch('cnc_map_web.time.monotonic',return_value=14):
            self.assertFalse(c.state()['controllerReport']['fresh'])
        with patch('cnc_map_web.time.monotonic',return_value=11):
            c.monitor_closing=True
            self.assertFalse(c.state()['controllerReport']['fresh'])
            c.monitor_closing=False
            c.data['sessionId']='new-session'
            self.assertFalse(c.state()['controllerReport']['fresh'])

    def test_software_stop_keeps_report_historical_and_unverified(self):
        c=Controller(demo=True)
        self.addCleanup(setattr,c,'closed',True)
        c.data['continuityActive']=True
        c.record_controller_report({'state':'RUN','overrides':{'feed':200}})
        c.stop('Synthetic operator stop')
        self.assertFalse(c.state()['controllerReport']['fresh'])
        self.assertEqual(c.state()['controllerReport']['status']['state'],'RUN')


if __name__=='__main__':unittest.main()
