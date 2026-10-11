#!/usr/bin/env python3
"""macOS launcher bridge. Reuses the guarded server manager; never owns serial."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from cnc_map_server import Manager, ROOT


def run(action, manager=None, opener=None, *, port=8765):
    manager = manager or Manager(port=port)
    opener = opener or (lambda target: subprocess.run(['/usr/bin/open', str(target)], check=True, capture_output=True))
    if action == 'project':
        opener(ROOT); return {'message': 'Project folder opened.'}
    if action == 'logs':
        opener(manager.runtime); return {'message': 'Log folder opened. Keep session links private.'}
    if action == 'help':
        opener(ROOT/'docs/DESKTOP.md'); return {'message': 'Quick start guide opened.'}
    if action == 'ugs':
        from surface_config import load_config
        app=Path(load_config()['ugsApp'])
        if not app.is_dir(): raise ValueError('Configured UGS application was not found')
        opener(app); return {'message': 'UGS opened. Connect and review the machine in UGS.'}
    if action not in ('status','open','start','stop','restart'):
        raise ValueError('Unknown launcher action')
    with manager.locked():
        current = manager.current()
        if action == 'stop': current=manager.stop()
        elif action == 'restart':
            if current.get('mode') in ('demo','offline'):
                raise ValueError('Use the terminal to restart a demo or offline instance in its intended mode')
            manager.stop();current=manager.start()
        elif action in ('open','start'):
            if not current['running']: current=manager.start()
            if current.get('retiring'): raise ValueError('The previous server is still shutting down')
            if not current.get('url'): raise ValueError('This running instance has no managed link. Use its existing browser tab.')
            if action == 'open': opener(current['url'])
    return {'running':current['running'], 'mode':current.get('mode'),
            'message':('Buildmaster is running' + (' · '+current['mode'] if current.get('mode') else '')) if current['running'] else 'Buildmaster is stopped'}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('status','open','start','stop','restart','ugs','project','logs','help'))
    parser.add_argument('--port',type=int,default=8765)
    args=parser.parse_args(argv)
    try: print(json.dumps(run(args.action,port=args.port)))
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
        # No state/URL/credential dumps. The GUI presents only this error text.
        import re
        print(json.dumps({'error':re.sub(r'#[A-Za-z0-9_-]{12,}', '#[private]', str(error))}));sys.exit(1)

if __name__=='__main__': main()
