"""Read configuration without machine access."""
import argparse
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load_config(demo=False):
    filename = os.environ.get('CNC_BUILDMASTER_CONFIG')
    if not demo and not filename:
        raise ValueError('Set CNC_BUILDMASTER_CONFIG to your machine configuration. Use --demo for simulation.')
    source = Path(filename).expanduser().resolve() if filename else ROOT/'config/example.json'
    c = json.loads(source.read_text())
    if c.get('version') != 1:
        raise ValueError('Expected configuration version 1')
    if not demo and c.get('configured') is not True:
        raise ValueError('The example configuration cannot control a machine. Complete your machine configuration first.')
    def number(value, name, maximum):
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 < value <= maximum:
            raise ValueError(name + ' is outside the permitted range')
    number(c['ugsPort'], 'ugsPort', 65535)
    if not isinstance(c['ugsPort'], int) or c['ugsPort'] < 1024:
        raise ValueError('ugsPort must be an integer from 1024 to 65535')
    number(c['puckHeight'], 'puckHeight', 100)
    if round(c['puckHeight'], 3) != c['puckHeight']:
        raise ValueError('puckHeight permits three decimal places')
    number(c['machine']['connection']['baud'], 'baud', 4000000)
    port = c['machine']['connection']['port']
    if not isinstance(port, str) or not port.startswith('/dev/') or (not demo and 'REPLACE' in port):
        raise ValueError('Enter the serial device path from UGS')
    if c['machine']['sender_defaults']['firmware'] != 'GRBL':
        raise ValueError('This version supports GRBL only')
    baseline = c['baseline']
    if not isinstance(baseline, dict) or not baseline:
        raise ValueError('The GRBL baseline is required')
    for key, value in baseline.items():
        if not key.isdigit() or not math.isfinite(float(value)):
            raise ValueError('Invalid GRBL baseline value')
    for key in ('110', '111', '112'):
        number(float(baseline[key]), 'GRBL $'+key, 100000)
    if not demo and not all(str(k) in baseline for k in (0,1,2,3,4,5,6,10,11,12,13,20,21,22,23,24,25,26,27,30,31,32,100,101,102,110,111,112,120,121,122,130,131,132)):
        raise ValueError('Supply the complete GRBL 1.1 baseline, not the example rates')
    for key, ceiling in {'xy':600,'z':60,'first':50,'second':10}.items():
        number(c['feeds'][key], 'feeds.'+key, ceiling)
    for key in ('dataDir', 'ugsApp'):
        p = Path(c[key]).expanduser()
        c[key] = str((source.parent/p).resolve() if not p.is_absolute() else p.resolve())
    c['configPath'] = str(source)
    return c

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--demo', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(load_config(args.demo)))
    except (ValueError, KeyError, OSError, TypeError) as error:
        parser.exit(1, str(error)+'\n')
