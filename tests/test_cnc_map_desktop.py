import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from cnc_map_desktop import main, run
from install_desktop_launcher import validate_port

class DesktopTests(unittest.TestCase):
    def manager(self, state):
        manager = Mock()
        manager.locked.side_effect = contextlib.nullcontext
        manager.current.return_value = state
        return manager

    def test_open_reuses_running_instance_and_keeps_link_private(self):
        manager = self.manager({'running': True, 'url': 'http://localhost/#secret', 'mode': 'machine'})
        opener = Mock()
        result = run('open', manager, opener)
        manager.start.assert_not_called()
        manager.stop.assert_not_called()
        opener.assert_called_once_with('http://localhost/#secret')
        self.assertNotIn('secret', json.dumps(result))

    def test_open_starts_stopped_server_once(self):
        manager = self.manager({'running': False})
        manager.start.return_value = {'running': True, 'url': 'http://localhost/#secret'}
        opener = Mock()
        run('open', manager, opener)
        manager.start.assert_called_once_with()
        opener.assert_called_once()

    def test_status_never_starts_or_opens(self):
        manager = self.manager({'running': False})
        opener = Mock()
        self.assertFalse(run('status', manager, opener)['running'])
        manager.start.assert_not_called()
        opener.assert_not_called()

    def test_restart_rejects_test_modes_without_stopping(self):
        for mode in ('demo', 'offline'):
            manager = self.manager({'running': True, 'mode': mode})
            with self.assertRaises(ValueError): run('restart', manager, Mock())
            manager.stop.assert_not_called()
            manager.start.assert_not_called()

    def test_missing_link_and_retiring_server_do_not_open(self):
        for state in ({'running': True}, {'running': True, 'retiring': True, 'url': 'private'}):
            manager = self.manager(state)
            opener = Mock()
            with self.assertRaises(ValueError): run('open', manager, opener)
            opener.assert_not_called()
            manager.start.assert_not_called()

    def test_stop_and_restart_delegate_to_guarded_manager(self):
        manager = self.manager({'running': True})
        manager.stop.return_value = {'running': False}
        self.assertFalse(run('stop', manager, Mock())['running'])
        manager.start.assert_not_called()
        manager.start.return_value = {'running': True}
        self.assertTrue(run('restart', manager, Mock())['running'])
        manager.start.assert_called_once_with()

    def test_unknown_action_does_not_touch_service(self):
        manager = self.manager({'running': True})
        with self.assertRaises(ValueError): run('unknown', manager, Mock())
        manager.current.assert_not_called()

    def test_cli_selects_the_requested_port_for_every_service_action(self):
        for action in ('status', 'open', 'start', 'stop', 'restart'):
            manager = self.manager({'running': True, 'url': 'http://127.0.0.1:8877/#private', 'mode': 'real'})
            manager.stop.return_value = {'running': False}
            manager.start.return_value = manager.current.return_value
            output = io.StringIO()
            with patch('cnc_map_desktop.Manager', return_value=manager) as factory, \
                 patch('cnc_map_desktop.subprocess.run'), contextlib.redirect_stdout(output):
                main([action, '--port', '8877'])
            factory.assert_called_once_with(port=8877)
            self.assertNotIn('#private', output.getvalue())

    def test_cli_preserves_default_port_for_existing_launchers(self):
        manager = self.manager({'running': False})
        with patch('cnc_map_desktop.Manager', return_value=manager) as factory, \
             contextlib.redirect_stdout(io.StringIO()):
            main(['status'])
        factory.assert_called_once_with(port=8765)

    def test_installer_rejects_invalid_or_conflicting_ports(self):
        self.assertEqual(validate_port(8877, 8080), 8877)
        for port in (1023, 65536, 8080, 9000, True, '8877'):
            with self.assertRaises(ValueError): validate_port(port, 9000)
        for ugs_port in (None, True, '8080', 1023, 65536):
            with self.assertRaises(ValueError): validate_port(8877, ugs_port)

if __name__ == '__main__': unittest.main()
