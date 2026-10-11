#!/usr/bin/env python3
"""Install a local macOS app wrapper; does not start or reconnect the CNC."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import platform
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]

def validate_port(port, ugs_port):
    if type(ugs_port) is not int or not 1024 <= ugs_port <= 65535:
        raise ValueError('The machine configuration needs a valid UGS port')
    if type(port) is not int or not 1024 <= port <= 65535 or port in (8080, ugs_port):
        raise ValueError('Choose a web port from 1024–65535, excluding 8080 and the configured UGS port')
    return port


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--destination',type=Path,default=Path.home()/'Applications/CNC Buildmaster.app')
    parser.add_argument('--desktop-shortcut',action='store_true')
    parser.add_argument('--port',type=int,default=8765,help='Buildmaster web port (default: 8765)')
    args=parser.parse_args(argv)
    if sys.platform!='darwin':raise ValueError('This launcher requires macOS')
    config=args.config.expanduser().resolve(strict=True)
    configuration=json.loads(config.read_text())
    if not isinstance(configuration,dict):raise ValueError('Expected a machine configuration object')
    port=validate_port(args.port,configuration.get('ugsPort'))
    destination=args.destination.expanduser().absolute()
    if destination.exists() or destination.is_symlink():raise ValueError('An app already exists at this destination; preserve it before installing a replacement')
    if destination.suffix!='.app':raise ValueError('Choose an .app destination')
    node=shutil.which('node')
    if not node:raise ValueError('Install Node.js 22 or later before creating the launcher')
    major=int(subprocess.check_output([node,'--version'],text=True).strip().removeprefix('v').split('.')[0])
    if major<22:raise ValueError('Node.js 22 or later is required')
    compiler=subprocess.check_output(['/usr/bin/xcrun','--find','swiftc'],text=True).strip()
    sdk=subprocess.check_output(['/usr/bin/xcrun','--sdk','macosx','--show-sdk-path'],text=True).strip()
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='buildmaster-app-') as temporary:
        app=Path(temporary)/destination.name
        resources=app/'Contents/Resources';resources.mkdir(parents=True)
        executable=app/'Contents/MacOS/Buildmaster';executable.parent.mkdir()
        (resources/'launcher.json').write_text(json.dumps({'project':str(ROOT),'python':str(Path(sys.executable).resolve()),'nodeDirectory':str(Path(node).resolve().parent),'configuration':str(config),'port':port},indent=2)+'\n')
        info={'CFBundleName':'CNC Buildmaster','CFBundleDisplayName':'CNC Buildmaster','CFBundleIdentifier':'com.cncbuildmaster.launcher','CFBundleExecutable':'Buildmaster','CFBundlePackageType':'APPL','CFBundleShortVersionString':'1.0','CFBundleVersion':'1','LSMinimumSystemVersion':'13.0','NSHighResolutionCapable':True,'CFBundleIconFile':'AppIcon','NSHumanReadableCopyright':'CNC Buildmaster · local machine workbench'}
        with (app/'Contents/Info.plist').open('wb') as stream:plistlib.dump(info,stream)
        subprocess.run([compiler,'-sdk',sdk,'-target',platform.machine()+'-apple-macosx13.0','-swift-version','5',str(ROOT/'desktop/macos/Buildmaster.swift'),'-o',str(executable),'-framework','AppKit'],check=True)
        subprocess.run([str(executable),'--write-icon'],check=True)
        subprocess.run(['/usr/bin/iconutil','-c','icns',str(resources/'AppIcon.iconset'),'-o',str(resources/'AppIcon.icns')],check=True)
        shutil.rmtree(resources/'AppIcon.iconset')
        subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(app)],check=True,capture_output=True)
        shutil.copytree(app,destination)
    register='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
    subprocess.run([register,'-f',str(destination)],check=True)
    if args.desktop_shortcut:
        shortcut=Path.home()/'Desktop/CNC Buildmaster.app'
        if shortcut.exists() or shortcut.is_symlink():print('Existing desktop item retained')
        else:shortcut.symlink_to(destination)
    print('Installed:',destination)
    print('Find “CNC Buildmaster” in Spotlight or double-click the desktop shortcut.')

if __name__=='__main__':
    try:main()
    except (OSError,ValueError,subprocess.SubprocessError) as error:sys.exit(str(error))
