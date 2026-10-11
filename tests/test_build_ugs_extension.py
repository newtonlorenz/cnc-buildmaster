"""Build from maintained sources even when an external override is selected."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import build_ugs_extension as builder


class ExtensionBuildTests(unittest.TestCase):
    def test_external_override_cannot_substitute_stale_source(self):
        for stale_source in (False, True):
            with self.subTest(stale_source=stale_source), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / 'checkout'
                current = root / 'extensions/ugs/src/Current.java'
                current.parent.mkdir(parents=True)
                current.write_text('class Current {}')
                installed = Path(directory) / 'installed'
                installed.mkdir()
                stale = installed / 'src/Stale.java'
                if stale_source:
                    stale.parent.mkdir()
                    stale.write_text('class Stale {}')
                output = installed / 'loopback-patch.jar'

                def compile_fixture(command, **kwargs):
                    self.assertIn(str(current), command)
                    self.assertNotIn(str(stale), command)
                    compiled = Path(command[command.index('-d') + 1]) / 'Current.class'
                    compiled.write_bytes(b'synthetic class fixture')

                with patch.object(builder, 'ROOT', root), patch.object(builder, 'STATE', installed), \
                     patch.object(builder, 'PATCH', output), patch.object(builder, 'check_stock') as stock, \
                     patch.object(builder, 'check', return_value={'verified': True}) as check, \
                     patch.object(builder.subprocess, 'run', side_effect=compile_fixture):
                    self.assertEqual(builder.build('fixture-javac'), {'verified': True})
                stock.assert_called_once_with()
                check.assert_called_once_with()
                with ZipFile(output) as archive:
                    self.assertEqual(archive.namelist(), ['Current.class'])
                self.assertEqual(json.loads((installed / 'patch-hashes.json').read_text()),
                                 {'Current.class': builder.sha(b'synthetic class fixture')})


if __name__ == '__main__':
    unittest.main()
