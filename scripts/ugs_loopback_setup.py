#!/usr/bin/env python3
"""Install/check the version-pinned UGS loopback override. No CNC commands."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'extensions/ugs'
from surface_config import load_config
APP = Path(load_config(demo=True)['ugsApp'])
JAR = APP / 'Contents/Resources/ugsplatform/ugsplatform/modules/ext/com.willwinder.ugs-platform-ugslib/com-willwinder-universalgcodesender/ugs-pendant.jar'
CLASS = 'com/willwinder/universalgcodesender/pendantui/PendantUI.class'
PATCH = STATE / 'loopback-patch.jar'
PREFS = Path.home() / 'Library/Preferences/ugs/UniversalGcodeSender.json'
CONF = Path.home() / 'Library/Application Support/ugsplatform/etc/ugsplatform.conf'
PROPERTY = 'netbeans.patches.com.willwinder.ugs.platform.ugslib'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def check_stock():
    hashes = json.loads((STATE / 'upstream-hashes.json').read_text())
    with ZipFile(JAR) as z:
        for name, expected in hashes.items():
            if sha(z.read(name)) != expected:
                raise ValueError('UGS pendant changed; review/rebuild before enabling API: ' + name)
    extra = STATE/'held-jog-stock-hashes.json'
    if extra.exists():
        modules = APP/'Contents/Resources/ugsplatform/ugsplatform/modules'
        for jar, classes in json.loads(extra.read_text()).items():
            with ZipFile(modules/jar) as z:
                for name, expected in classes.items():
                    if sha(z.read(name)) != expected:
                        raise ValueError('UGS native jog implementation changed; review/rebuild: '+name)
    return hashes


def check():
    stock = check_stock()
    expected = json.loads((STATE / 'patch-hashes.json').read_text())
    with ZipFile(PATCH) as z:
        if set(z.namelist()) != set(expected):
            raise ValueError('Unexpected/missing override classes')
        for name, digest in expected.items():
            if sha(z.read(name)) != digest:
                raise ValueError('Override class changed: ' + name)
    return {'stock_class_sha256': stock[CLASS], 'patch_class_sha256': expected[CLASS],
            'patch_jar_sha256': sha(PATCH.read_bytes()), 'bind_host': '127.0.0.1'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Verify the UGS extension hashes. No machine access.')
    parser.add_argument('--check', action='store_true', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(check()))
    except Exception as error:
        parser.exit(1, str(error)+'\n')
