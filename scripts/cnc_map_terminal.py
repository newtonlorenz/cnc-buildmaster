#!/usr/bin/env python3
"""Teach four corners for a UGS puck map; also used by the local web interface."""
import datetime
import json
import math
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
from surface_config import load_config

CORNERS = ('front-left', 'front-right', 'back-right', 'back-left')


def finite(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('A finite number is required')
    return value


def snapshot():
    result = subprocess.run([sys.executable, str(ROOT/'scripts/ugs_api.py'), 'doctor'], cwd=ROOT, text=True, capture_output=True, timeout=20)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'UGS connection check failed')
    return json.loads(result.stdout)


def position(doctor):
    s = doctor['status']
    if s['state'] != 'IDLE' or s['spindleSpeed'] != 0 or s['feedSpeed'] != 0 or doctor['file']['fileName'] or doctor['file'].get('remainingRowCount', 0):
        raise ValueError('UGS must be idle, spindle off, with no selected cutting file')
    m, w = s['machineCoord'], s['workCoord']
    if m['units'] != 'MM' or w['units'] != 'MM':
        raise ValueError('UGS units must be MM')
    return ({a: round(finite(m[a]), 3) for a in 'xyz'},
            {a: round(finite(m[a])-finite(w[a]), 3) for a in 'xyz'})


def taught_rectangle(snapshots):
    if len(snapshots) != 4:
        raise ValueError('Record all four named corners')
    if isinstance(snapshots, dict):
        if set(snapshots) != set(CORNERS): raise ValueError('Expected the four named corners')
        snapshots = [snapshots[name] for name in CORNERS]
    points = [position(s)[0] for s in snapshots]
    offsets = [position(s)[1] for s in snapshots]
    if any(s['listener'] != snapshots[0]['listener'] for s in snapshots) or any(o != offsets[0] for o in offsets):
        raise ValueError('UGS process or work offset changed; teach again')
    fl, fr, br, bl = points
    if len({p['z'] for p in points}) != 1:
        raise ValueError('Keep the same raised Z at every corner; teach again')
    if not (fl['x'] == bl['x'] < fr['x'] == br['x'] and fl['y'] == fr['y'] < br['y'] == bl['y']):
        raise ValueError('Corners must form an axis-aligned rectangle: left/right X and front/back Y must match')
    return {'x': [fl['x'], fr['x']], 'y': [fl['y'], bl['y']]}


def positioning_rectangle(snapshots):
    """Bounds become known after two opposite (or three coherent) named corners."""
    sides = {'left': set(), 'right': set(), 'front': set(), 'back': set()}
    for name, snap in snapshots.items():
        if name not in CORNERS: raise ValueError('Invalid corner name')
        p, _ = position(snap)
        front_back, left_right = name.split('-')
        sides[left_right].add(p['x']); sides[front_back].add(p['y'])
    if any(len(values) != 1 for values in sides.values()):
        raise ValueError('Record two opposite corners with matching left/right X and front/back Y')
    bounds = {'x': [next(iter(sides[k])) for k in ('left','right')],
              'y': [next(iter(sides[k])) for k in ('front','back')]}
    if any(lo >= hi for lo,hi in bounds.values()):raise ValueError('Corner names do not match the rectangle orientation')
    return bounds


def grid_axis(lo, hi, spacing):
    lo, hi, spacing = map(finite, (lo, hi, spacing))
    if not 0.1 <= spacing <= hi-lo:
        raise ValueError('Spacing must be at least 0.1 mm and no larger than either side')
    if any(abs(v*1000-round(v*1000)) > 1e-6 for v in (lo, hi, spacing)):
        raise ValueError('Use at most three decimals')
    count = int(math.floor((hi-lo)/spacing + 1e-9))
    if count > 99:
        raise ValueError('Too many points: use a larger spacing')
    values = [round(lo+i*spacing, 3) for i in range(count+1)]
    if hi-values[-1] > 0.0005:
        if hi-values[-1] < 0.1-1e-9:
            raise ValueError('Final interval under 0.1 mm; choose another spacing')
        values.append(round(hi, 3))
    if len(values) > 100:
        raise ValueError('Too many points')
    return values


def make_config(snapshots, spacing, current=None, profile=None, probe_mode="puck"):
    profile = profile or load_config(demo=True)
    if probe_mode not in ('puck', 'copper'): raise ValueError('Choose puck or copper probing')
    bounds = taught_rectangle(snapshots)
    ordered = list(snapshots.values()) if isinstance(snapshots, dict) else snapshots
    current = current or ordered[-1]
    m, offset = position(current)
    taught, taught_offset = position(ordered[0])
    if offset != taught_offset or current['listener'] != ordered[0]['listener'] or m['z'] != taught['z']:
        raise ValueError('Taught height/reference changed; teach again')
    x = grid_axis(*bounds['x'], spacing); y = grid_axis(*bounds['y'], spacing)
    if m['x'] not in x or m['y'] not in y:
        raise ValueError('Move to a recorded corner or grid point before previewing the scan')
    if len(x)*len(y) > 2500:
        raise ValueError('Too many points')
    return {'version': 1, 'grid': {'x': x, 'y': y, 'spacing': finite(spacing)},
            'start': m, 'travelZ': m['z'], 'expectedG54': offset,
            'envelope': {**bounds, 'z': [round(m['z']-5.2, 3), round(m['z']+1, 3)]},
            'probeMode': probe_mode, 'puckHeight': 0 if probe_mode == 'copper' else profile['puckHeight'], 'feeds': profile['feeds'], 'outputDir': profile['dataDir']}


def save_plan(snapshots, spacing, current=None, profile=None, probe_mode="puck"):
    config = make_config(snapshots, spacing, current, profile, probe_mode)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    directory = Path(config['outputDir'])/('puck-map-plan-'+stamp)
    directory.mkdir(parents=True, exist_ok=False)
    path = directory/'config.json'
    path.write_text(json.dumps(config, indent=2)+'\n')
    (directory/'taught-corners.json').write_text(json.dumps(snapshots, indent=2)+'\n')
    return path


def main():
    # Keep the original terminal entrypoint; all teaching now uses the guarded web UI.
    from cnc_map_web import main as web_main
    web_main()


if __name__ == '__main__':
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print('\nSetup cancelled.', file=sys.stderr); sys.exit(130)
    except (ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Error: {error}', file=sys.stderr); sys.exit(1)
