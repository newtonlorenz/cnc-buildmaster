"""Local teaching/scan history. Saved geometry never restores machine authority."""
import copy
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading


class SurfaceHistory:
    def __init__(self, directory, memory_only=False):
        self.directory = Path(directory)
        self.memory_only = memory_only
        self.lock = threading.RLock()
        self.records = {}
        if not memory_only:
            for path in sorted(self.directory.glob('*.json'), reverse=True):
                try:
                    item = self.read_file(path)
                    self.records[item['id']] = self.summary(item)
                except (ValueError, OSError, KeyError, TypeError):
                    continue

    @staticmethod
    def summary(item):
        return {key: copy.deepcopy(item[key]) for key in
                ('id', 'updatedAt', 'phase', 'cornerCount', 'measurementCount', 'demo')}

    @staticmethod
    def read_file(path):
        if path.is_symlink() or path.stat().st_size > 4_000_000:
            raise ValueError('History file is unavailable or too large')
        item = json.loads(path.read_text())
        if not isinstance(item, dict) or item.get('version') != 1 or item.get('id') != path.stem:
            raise ValueError('Invalid history record')
        SurfaceHistory.validate(item)
        return item

    @staticmethod
    def validate(item):
        def number(value):
            return type(value) in (int, float) and math.isfinite(value)
        def points(value, limit, axes):
            return isinstance(value, list) and len(value) <= limit and all(
                isinstance(p, dict) and all(number(p.get(a)) for a in axes) for p in value)
        if (not isinstance(item, dict) or item.get('version') != 1 or
            not isinstance(item.get('id'), str) or not re.fullmatch('[0-9a-f]{32}', item['id']) or
            type(item.get('demo')) is not bool or not number(item.get('updatedAt')) or
            not isinstance(item.get('phase'), str) or len(item['phase']) > 80 or
            not points(item.get('corners'), 4, 'xyz') or not item['corners'] or
            not points(item.get('measurements'), 2501, 'xy') or
            item.get('cornerCount') != len(item['corners']) or
            item.get('measurementCount') != len(item['measurements'])):
            raise ValueError('Invalid saved surface history')
        area = item.get('area')
        if area is not None and (not isinstance(area, dict) or any(
            not isinstance(area.get(a), list) or len(area[a]) != 2 or
            not all(number(v) for v in area[a]) or area[a][0] >= area[a][1] for a in 'xy')):
            raise ValueError('Invalid saved area')
        plan = item.get('plan')
        if plan is not None:
            if not isinstance(plan, dict) or not isinstance(plan.get('grid'), dict):
                raise ValueError('Invalid saved grid')
            for axis in 'xy':
                values = plan['grid'].get(axis)
                if not isinstance(values, list) or not 2 <= len(values) <= 100 or not all(number(v) for v in values):
                    raise ValueError('Invalid saved grid axis')
        route = item.get('route')
        if route is not None and (not isinstance(route, dict) or not points(route.get('points'), 2501, 'xy')):
            raise ValueError('Invalid saved route')

    def list(self):
        with self.lock:
            return sorted([self.summary(r) for r in self.records.values()],
                          key=lambda r: r['updatedAt'], reverse=True)[:50]

    def save(self, item):
        with self.lock:
            self.validate(item)
            if not re.fullmatch('[0-9a-f]{32}', item['id']):
                raise ValueError('Invalid history ID')
            raw = json.dumps(item, allow_nan=False)
            if len(raw.encode()) > 4_000_000:
                raise ValueError('History record is too large')
            if not self.memory_only:
                self.directory.mkdir(parents=True, exist_ok=True)
                if self.directory.is_symlink(): raise ValueError('History directory cannot be a symlink')
                fd, name = tempfile.mkstemp(dir=self.directory, prefix='.history-')
                try:
                    with os.fdopen(fd, 'w') as stream:
                        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
                    os.replace(name, self.directory / (item['id'] + '.json'))
                finally:
                    if os.path.exists(name): os.unlink(name)
            self.records[item['id']] = copy.deepcopy(item if self.memory_only else self.summary(item))

    def get(self, identifier):
        with self.lock:
            if not isinstance(identifier, str) or not re.fullmatch('[0-9a-f]{32}', identifier):
                raise ValueError('Choose a saved history record')
            if identifier not in self.records: raise ValueError('History record not found')
            if self.memory_only: return copy.deepcopy(self.records[identifier])
            return self.read_file(self.directory / (identifier + '.json'))
