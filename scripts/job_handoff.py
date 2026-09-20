"""Derive the native handoff exclusively from this session's accepted evidence."""
import hashlib
import json
import math
from pathlib import Path
from pcb_gcode import require
from ugs_surface_bridge import make_payload


def accepted_payload(result, data_dir):
    require(isinstance(result, dict) and isinstance(result.get('path'), str), 'No accepted map in this setup')
    path = Path(result['path']).resolve()
    require(path.is_relative_to(Path(data_dir).resolve()) and path.name == 'surface.xyz', 'Map is outside the evidence directory')
    require(0 < path.stat().st_size <= 1_000_000, 'Invalid map size')
    hashes=result.get('acceptedHashes')
    require(isinstance(hashes,dict) and set(hashes)=={'surface.xyz','config.json','result.json','ugs-handoff.json'}, 'No trusted acceptance hashes in this setup')
    evidence={}
    for name,digest in hashes.items():
        sibling=path.with_name(name)
        require(not sibling.is_symlink() and sibling.stat().st_size <= 4_000_000, 'Invalid evidence file')
        evidence[name]=sibling.read_bytes()
        require(hashlib.sha256(evidence[name]).hexdigest()==digest, 'Accepted evidence checksum changed: '+name)
    raw = evidence['surface.xyz']
    handoff = json.loads(evidence['ugs-handoff.json'])
    saved = json.loads(evidence['result.json'])
    config = json.loads(evidence['config.json'])
    require(handoff.get('sha256') == hashlib.sha256(raw).hexdigest(), 'Height map checksum changed')
    require(saved.get('physicalObservationConfirmed') is True and saved.get('offsetsPreserved') is True
            and saved.get('appliedInUgs') is False, 'Measurement acceptance is incomplete')
    require(isinstance(result.get('summary'), dict) and all(saved.get(k) == v for k,v in result['summary'].items()), 'Accepted map summary changed')
    require(handoff.get('capturedG54') == config.get('expectedG54'), 'Map work frame changed')
    rows = [list(map(float,line.split())) for line in raw.decode().splitlines() if line.strip()]
    require(all(len(r) == 3 and all(math.isfinite(v) for v in r) for r in rows), 'Invalid map coordinates')
    xs = sorted(set(r[0] for r in rows)); ys = sorted(set(r[1] for r in rows))
    require(len(rows) == len(xs)*len(ys) and len({(r[0],r[1]) for r in rows}) == len(rows), 'Incomplete or duplicate grid')
    expected = {axis:[round(v-config['expectedG54'][axis],6) for v in config['grid'][axis]] for axis in 'xy'}
    require(xs == expected['x'] and ys == expected['y'], 'Map differs from the accepted scan grid')
    lookup = {(r[0],r[1]):r[2] for r in rows}
    return make_payload('surface-'+handoff['sha256'][:32], xs, ys, [[lookup[(x,y)] for x in xs] for y in ys])
