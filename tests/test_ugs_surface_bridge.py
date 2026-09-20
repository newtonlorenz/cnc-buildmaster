"""Offline payload and HTTP-boundary tests; no real UGS or sockets."""
import io
import json
from pathlib import Path
import sys
import unittest
import tempfile
from unittest.mock import patch
from zipfile import ZipFile
import hashlib
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from ugs_surface_bridge import SurfaceBridge, SurfaceBridgeError, make_payload, validate_payload, _decode, check_surface_stock, _NoRedirect


def payload():
    return make_payload('fixture-map-01', [0, 10], [0, 10], [[0, .01], [.02, -.03]])


def readback(p):
    return dict(protocol=1, ok=True, available=True, verified=True,
                native=dict(evidence='native-autoleveler-readback', nativeMapSha256=p['sha256'],
                            mapComplete=True, units='MM', mode='relative', zSurface=0.,
                            probeOffsets=[0., 0., 0.], probeOffsetUnits='MM', scanning=False,
                            processedFile=None, x=p['x'], y=p['y'], relativeZ=p['relativeZ'], applyToGcode=False, meshProcessorCount=0,
                            selectedFile=None, compensationApplied=False))


class Reply(io.BytesIO):
    pass


class Opener:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        value = self.replies.pop(0)
        if isinstance(value, Exception):
            raise value
        return Reply(json.dumps(value).encode())


class SurfaceBridgeTests(unittest.TestCase):
    def bridge(self, *responses):
        self.guard_calls = 0
        def guard():
            self.guard_calls += 1
        bridge = SurfaceBridge('http://127.0.0.1:8080/api/v1', guard=guard)
        bridge.opener = Opener(*responses)
        return bridge

    def test_hash_is_stable_detached_and_negative_zero_normalised(self):
        p = payload()
        q = make_payload('different-id', [-0., 10], [0, 10], [[-0., .01], [.02, -.03]])
        self.assertEqual(p['sha256'], q['sha256'])
        self.assertEqual(p['sha256'], 'f201f2841fd70c544ae33e66184c66c0e6e9b2a07348c1dbb3986cf9d0bd9574')
        result = validate_payload(p)
        p['relativeZ'][0][0] = 1
        self.assertEqual(result['relativeZ'][0][0], 0)

    def test_refuses_bad_values_hashes_extra_fields_and_shapes(self):
        mutations = [lambda p: p.update(sha256='0'*64), lambda p: p.update(imported=True),
                     lambda p: p.update(protocol=True), lambda p: p.update(protocol=1.),
                     lambda p: p.update(units='INCH'), lambda p: p.update(mode='absolute'),
                     lambda p: p.update(expectedSelectedFile='job.nc'), lambda p: p.update(mapId='../fake'),
                     lambda p: p.update(relativeZ=[[0, 1]]), lambda p: p.update(x=[0, 0]),
                     lambda p: p.update(x=[0, 10, 21]), lambda p: p.update(y=[0, 10, 30]),
                     lambda p: p.update(x=[0, 10001]), lambda p: p.update(relativeZ=[[0, 101], [0, 0]]),
                     lambda p: p.update(relativeZ=[[1, 1], [1, 1]])]
        for value in [float('nan'), float('inf'), float('-inf'), True, '0', None, 10**1000]:
            mutations.append(lambda p, value=value: p['relativeZ'][1].__setitem__(1, value))
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                p = payload(); mutate(p)
                with self.assertRaises(SurfaceBridgeError): validate_payload(p)

    def test_url_restrictions(self):
        for url in ['https://127.0.0.1:8080/api/v1', 'http://localhost:8080/api/v1',
                    'http://127.0.0.1.evil:8080/api/v1', 'http://127.0.0.1:8080@evil/api/v1',
                    'http://127.0.0.1:8080/api/v1?x=1', 'http://127.0.0.1:8080/api/v1#x',
                    'http://user@127.0.0.1:8080/api/v1', 'http://127.0.0.1:8080/other',
                    'http://127.0.0.1/api/v1', 'http://127.0.0.1:80/api/v1']:
            with self.subTest(url=url), self.assertRaises(SurfaceBridgeError):
                SurfaceBridge(url, guard=lambda: None)
        with self.assertRaises(SurfaceBridgeError):
            SurfaceBridge('http://127.0.0.1:8080/api/v1', guard=None)

    def test_missing_extension_is_not_imported(self):
        bridge = self.bridge(HTTPError('url', 404, 'missing', {}, io.BytesIO(b'')))
        self.assertEqual(bridge.capabilities()['code'], 'extension_missing')
        self.assertEqual(self.guard_calls, 1)

    def test_import_requires_two_fresh_guarded_readbacks(self):
        p = payload(); bridge = self.bridge(readback(p), readback(p))
        self.assertTrue(bridge.import_map(p)['verified'])
        self.assertEqual([r.full_url.rsplit('/', 1)[1] for r in bridge.opener.requests], ['import', 'verify'])
        self.assertEqual(self.guard_calls, 2)

    def test_failed_or_lost_import_never_retries(self):
        p = payload(); bridge = self.bridge(URLError('lost response'))
        with self.assertRaisesRegex(SurfaceBridgeError, 'outcome unknown'): bridge.import_map(p)
        self.assertEqual(len(bridge.opener.requests), 1)
        bridge = self.bridge(readback(p), {'protocol': 1, 'ok': True, 'imported': True})
        with self.assertRaises(SurfaceBridgeError): bridge.import_map(p)
        self.assertEqual(len(bridge.opener.requests), 2)

    def test_client_checkbox_and_spoofed_incomplete_status_never_verify(self):
        p = payload()
        for native in [None, {'imported': True}, {'nativeMapSha256': p['sha256']},
                       {**readback(p)['native'], 'selectedFile': {'path': 'other.nc'}},
                       {**readback(p)['native'], 'applyToGcode': True},
                       {**readback(p)['native'], 'meshProcessorCount': 1},
                       {**readback(p)['native'], 'meshProcessorCount': False},
                       {**readback(p)['native'], 'probeOffsets': [False, 0, 0]},
                       {**readback(p)['native'], 'zSurface': False},
                       {**readback(p)['native'], 'nativeMapSha256': '0'*64},
                       {**readback(p)['native'], 'compensationApplied': None},
                       {**readback(p)['native'], 'processedFile': {'path': 'stale.nc'}},
                       {**readback(p)['native'], 'scanning': True},
                       {**readback(p)['native'], 'probeOffsetUnits': 'INCH'},
                       {**readback(p)['native'], 'relativeZ': [[0, 1], [2, 3]]},
                       {**readback(p)['native'], 'x': None}]:
            response = {**readback(p), 'native': native}
            with self.subTest(native=native), self.assertRaises(SurfaceBridgeError): self.bridge(response).verify(p)
        response = readback(p); del response['native']['selectedFile']
        with self.assertRaises(SurfaceBridgeError): self.bridge(response).verify(p)

    def test_guard_failure_prevents_request(self):
        b = self.bridge(readback(payload())); b.guard = lambda: False
        with self.assertRaises(SurfaceBridgeError): b.import_map(payload())
        self.assertFalse(b.opener.requests)

    def test_redirect_is_refused_without_followup_request(self):
        with self.assertRaises(SurfaceBridgeError):
            _NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'http://evil/')

    def test_surface_guard_rejects_changed_class_manifest_and_missing_pins(self):
        with tempfile.TemporaryDirectory(prefix='surface-pin-test-') as tmp:
            root = Path(tmp)
            extension = root / 'extensions/ugs'; extension.mkdir(parents=True)
            modules = root / 'app/Contents/Resources/ugsplatform/ugsplatform/modules'
            modules.mkdir(parents=True)
            pins = {'native.jar': {'Native.class': hashlib.sha256(b'native').hexdigest(),
                                   'META-INF/MANIFEST.MF': hashlib.sha256(b'module dependencies').hexdigest()}}
            pin_file = extension / 'surface-stock-hashes.json'
            pin_file.write_text(json.dumps(pins))
            with patch('ugs_surface_bridge.ROOT', root):
                for changed in [None, 'Native.class', 'META-INF/MANIFEST.MF']:
                    with ZipFile(modules / 'native.jar', 'w') as archive:
                        for name, original in [('Native.class', b'native'), ('META-INF/MANIFEST.MF', b'module dependencies')]:
                            archive.writestr(name, b'changed' if changed == name else original)
                    if changed:
                        with self.assertRaises(SurfaceBridgeError): check_surface_stock(root / 'app')
                    else:
                        self.assertTrue(check_surface_stock(root / 'app')['surfaceStockVerified'])
                pin_file.write_text('{}')
                with self.assertRaises(SurfaceBridgeError): check_surface_stock(root / 'app')
                pin_file.unlink()
                with self.assertRaises(FileNotFoundError): check_surface_stock(root / 'app')

    def test_strict_response_json(self):
        for raw in [b'{"protocol":1,"protocol":1}', b'{"x":NaN}', b'{"x":Infinity}', b'null invalid', b'x'*1_000_001]:
            with self.assertRaises(SurfaceBridgeError): _decode(raw)


if __name__ == '__main__':
    unittest.main()
