#!/usr/bin/env python3
"""Strict surface-map client. No motion, file selection, or compensation apply.

Caller must check the existing UGS listener/process/extension guard first.
This module never connects to serial, retries imports, or follows redirects.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import struct
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
DOMAIN = b'CNC-BUILDMASTER-SURFACE-V1\0MM\0relative\0'
FIELDS = {'protocol', 'mapId', 'mode', 'units', 'x', 'y', 'relativeZ', 'sha256', 'expectedSelectedFile'}
MAX_BYTES = 1_000_000


class SurfaceBridgeError(ValueError):
    """A refused, unavailable, or unverified native handoff."""


def _number(n, limit):
    if isinstance(n, bool) or not isinstance(n, (int, float)) or abs(n) > limit or not math.isfinite(n):
        raise SurfaceBridgeError('Nonfinite, nonnumeric, or out-of-bounds map coordinate')
    return 0.0 if n == 0 else float(n)


def _grid(x, y, z):
    if not isinstance(x, list) or not isinstance(y, list) or not 2 <= len(x) <= 100 or not 2 <= len(y) <= 100:
        raise SurfaceBridgeError('Expected 2..100 coordinates on each axis')
    x = [_number(n, 10000) for n in x]
    y = [_number(n, 10000) for n in y]
    step = max(x[1] - x[0], y[1] - y[0])
    if not 0.001 <= step <= 10000:
        raise SurfaceBridgeError('Invalid grid resolution')
    for axis in (x, y):
        for i in range(1, len(axis)):
            delta = axis[i] - axis[i - 1]
            if delta < 0.001 or delta > step + 1e-9 or (i < len(axis) - 1 and abs(delta - step) > 1e-9):
                raise SurfaceBridgeError('Grid cannot be represented by native UGS resolution')
    if not isinstance(z, list) or len(z) != len(y) or any(not isinstance(row, list) or len(row) != len(x) for row in z):
        raise SurfaceBridgeError('Expected relativeZ[y][x] rectangular grid')
    z = [[_number(n, 100) for n in row] for row in z]
    if not any(n == 0 for row in z for n in row):
        raise SurfaceBridgeError('Relative map needs an explicit zero datum sample')
    return x, y, z


def grid_sha256(x, y, relative_z):
    x, y, z = _grid(x, y, relative_z)
    payload = bytearray(DOMAIN + struct.pack('>II', len(x), len(y)))
    for n in x + y + [n for row in z for n in row]:
        payload.extend(struct.pack('>d', n))
    return hashlib.sha256(payload).hexdigest()


def make_payload(map_id, x, y, relative_z):
    """Return a detached payload. Heights must already be relative material Z."""
    x, y, z = _grid(x, y, relative_z)
    return validate_payload(dict(protocol=1, mapId=map_id, mode='relative', units='MM',
                                 x=x, y=y, relativeZ=z, sha256=grid_sha256(x, y, z), expectedSelectedFile=None))


def validate_payload(value):
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise SurfaceBridgeError('Missing or unknown surface-map fields')
    if type(value['protocol']) is not int or value['protocol'] != 1 or value['mode'] != 'relative' or value['units'] != 'MM':
        raise SurfaceBridgeError('Expected protocol 1, relative mode, MM')
    if not isinstance(value['mapId'], str) or not re.fullmatch(r'[-A-Za-z0-9_]{8,80}', value['mapId']):
        raise SurfaceBridgeError('Invalid map ID')
    if value['expectedSelectedFile'] is not None:
        raise SurfaceBridgeError('No file may be selected for this operation')
    x, y, z = _grid(value['x'], value['y'], value['relativeZ'])
    digest = grid_sha256(x, y, z)
    if value['sha256'] != digest:
        raise SurfaceBridgeError('Surface digest mismatch')
    return {**value, 'x': x, 'y': y, 'relativeZ': z}


def check_surface_stock(app):
    """Read-only extra startup guard; parent must call this from check_stock."""
    modules = Path(app) / 'Contents/Resources/ugsplatform/ugsplatform/modules'
    pins = json.loads((ROOT / 'extensions/ugs/surface-stock-hashes.json').read_text())
    if not pins:
        raise SurfaceBridgeError('Missing native surface pins')
    for jar, entries in pins.items():
        with ZipFile(modules / jar) as archive:
            for name, expected in entries.items():
                if hashlib.sha256(archive.read(name)).hexdigest() != expected:
                    raise SurfaceBridgeError('UGS native surface dependency changed: ' + name)
    return {'supportedVersion': '2.1.26', 'surfaceStockVerified': True}


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SurfaceBridgeError('Duplicate JSON key')
        result[key] = value
    return result


def _decode(data):
    if len(data) > MAX_BYTES:
        raise SurfaceBridgeError('Surface response too large')
    try:
        return json.loads(data, object_pairs_hook=_unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(SurfaceBridgeError('Nonfinite JSON')))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise SurfaceBridgeError('Invalid surface response JSON') from error


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SurfaceBridgeError('UGS redirect refused')


class SurfaceBridge:
    def __init__(self, api_base, *, guard, timeout=5):
        parsed = urlsplit(api_base)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment
                or parsed.path.rstrip('/') != '/api/v1' or parsed.port is None
                or not 1024 <= parsed.port <= 65535):
            raise SurfaceBridgeError('Expected explicit loopback UGS /api/v1 URL')
        if not callable(guard):
            raise SurfaceBridgeError('The existing UGS identity guard is required')
        self.base = api_base.rstrip('/') + '/surfaceMap/'
        self.guard = guard
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), _NoRedirect())

    def _request(self, endpoint, payload=None):
        if self.guard() is False:  # Raises on stale/unverified process, listener or extension.
            raise SurfaceBridgeError('UGS identity guard refused')
        data = None if payload is None else json.dumps(validate_payload(payload), allow_nan=False).encode()
        req = Request(self.base + endpoint, data=data, headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                result = _decode(response.read(MAX_BYTES + 1))
        except HTTPError as error:
            if error.code == 404:
                error.close()
                return {'ok': False, 'protocol': 1, 'available': False, 'code': 'extension_missing',
                        'imported': False, 'compensationApplied': None}
            try:
                detail = _decode(error.read(MAX_BYTES + 1))
            finally:
                error.close()
            if not isinstance(detail, dict):
                raise SurfaceBridgeError('Invalid native error response')
            raise SurfaceBridgeError('Native surface request refused: ' + str(detail.get('code', error.code))) from error
        except (URLError, TimeoutError, OSError) as error:
            # An import may have completed; the caller must verify, never retry automatically.
            raise SurfaceBridgeError('UGS surface response unavailable; import outcome unknown; verify native state') from error
        if not isinstance(result, dict) or type(result.get('protocol')) is not int or result['protocol'] != 1:
            raise SurfaceBridgeError('Unsupported/spoofed native surface response')
        return result

    def capabilities(self):
        return self._request('capabilities')

    def status(self):
        return self._request('status')

    @staticmethod
    def _verified(result, payload):
        native = result.get('native')
        if (result.get('ok') is not True or result.get('available') is not True or result.get('verified') is not True
                or not isinstance(native, dict) or native.get('evidence') != 'native-autoleveler-readback'
                or native.get('nativeMapSha256') != payload['sha256'] or native.get('mapComplete') is not True
                or native.get('units') != 'MM' or native.get('mode') != 'relative'
                or native.get('zSurface') != 0 or type(native.get('zSurface')) not in (int, float)
                or native.get('probeOffsets') != [0.0, 0.0, 0.0]
                or any(type(n) not in (int, float) for n in native.get('probeOffsets', []))
                or native.get('probeOffsetUnits') != 'MM' or native.get('scanning') is not False
                or native.get('processedFile') is not None or 'processedFile' not in native
                or native.get('applyToGcode') is not False or native.get('meshProcessorCount') != 0
                or type(native.get('meshProcessorCount')) is not int
                or native.get('selectedFile') is not None or 'selectedFile' not in native
                or native.get('compensationApplied') is not False):
            raise SurfaceBridgeError('Native readback does not verify this unapplied map')
        if grid_sha256(native.get('x'), native.get('y'), native.get('relativeZ')) != payload['sha256']:
            raise SurfaceBridgeError('Native grid does not match its declared digest')
        return result

    def verify(self, payload):
        payload = validate_payload(payload)
        return self._verified(self._request('verify', payload), payload)

    def import_map(self, payload):
        payload = validate_payload(payload)
        self._verified(self._request('import', payload), payload)
        # Fresh server read after the transaction; no client-side imported flag.
        return self.verify(payload)
