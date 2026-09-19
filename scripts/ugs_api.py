#!/usr/bin/env python3
"""Read-only UGS API checks. Does not connect, jog, probe, zero, reset or send files."""
import argparse
import json
import subprocess
import time
import urllib.request

from ugs_loopback_setup import check
from surface_config import load_config

def base():
    return f"http://127.0.0.1:{load_config()['ugsPort']}/api/v1/"
ROUTES = {'status': 'status/getStatus', 'settings': 'settings/getSettings',
          'file': 'files/getFileStatus', 'ports': 'machine/getPortList'}


def verify_listener():
    configuration = load_config()
    check()
    port = configuration['ugsPort']
    lines = subprocess.check_output(
        ['lsof', '-a', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-Fpcn'], text=True).splitlines()
    endpoints = [line[1:] for line in lines if line.startswith('n')]
    pids = {line[1:] for line in lines if line.startswith('p')}
    if endpoints != [f'127.0.0.1:{port}'] or len(pids) != 1:
        raise RuntimeError('API listener is absent, ambiguous or not loopback-only')
    command = subprocess.check_output(['ps', '-p', next(iter(pids)), '-o', 'command='], text=True)
    if 'org.netbeans.Main' not in command or '--branding ugsplatform' not in command:
        raise RuntimeError('API listener is not the expected UGS process')
    return {'pid': int(next(iter(pids))), 'listen': endpoints[0]}


def read(route):
    if route not in (*ROUTES.values(), 'jogHold/capabilities'):
        raise ValueError('Endpoint is not in the read-only allowlist')
    # Ignore ambient HTTP proxy settings; never redirect local API requests.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise RuntimeError('Unexpected API redirect')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(base() + route, timeout=3) as response:
        data = response.read(1_000_001)
    if len(data) > 1_000_000:
        raise RuntimeError('Oversized API response')
    return json.loads(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=[*ROUTES, 'doctor', 'watch'])
    parser.add_argument('--seconds', type=int, default=10)
    args = parser.parse_args()
    try:
        listener = verify_listener()
        if args.action == 'doctor':
            print(json.dumps({'listener': listener, **{k: read(v) for k, v in ROUTES.items() if k != 'ports'}}, indent=2))
        elif args.action == 'watch':
            if not 1 <= args.seconds <= 60:
                raise ValueError('Watch interval must be 1–60 seconds')
            for _ in range(args.seconds):
                print(json.dumps(read(ROUTES['status'])), flush=True)
                time.sleep(1)
        else:
            print(json.dumps(read(ROUTES[args.action]), indent=2))
    except Exception as error:
        parser.exit(1, str(error) + '\n')
