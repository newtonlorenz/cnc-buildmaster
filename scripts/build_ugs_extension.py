#!/usr/bin/env python3
"""Build the UGS extension. Does not change UGS preferences or start UGS."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZipFile, ZIP_DEFLATED
from ugs_loopback_setup import APP, STATE, PATCH, check_stock, check, sha

def build(javac):
    check_stock()
    modules = APP/'Contents/Resources/ugsplatform/ugsplatform/modules'
    sources = sorted((STATE/'src').rglob('*.java'))
    with tempfile.TemporaryDirectory(prefix='buildmaster-ugs-') as temporary:
        directory = Path(temporary)
        classpath = os.pathsep.join(str(p) for p in modules.rglob('*.jar'))
        subprocess.run([javac, '--release', '17', '-cp', classpath, '-d', str(directory), *map(str, sources)], check=True)
        hashes = {}
        archive = directory/'extension.jar'
        with ZipFile(archive, 'w', ZIP_DEFLATED) as output:
            for p in sorted(directory.rglob('*.class')):
                name = p.relative_to(directory).as_posix()
                data = p.read_bytes()
                output.writestr(name, data)
                hashes[name] = sha(data)
        shutil.copy2(archive, PATCH)
        (STATE/'patch-hashes.json').write_text(json.dumps(hashes, indent=2)+'\n')
    return check()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--javac', default='javac')
    args = parser.parse_args()
    if PATCH.exists():
        parser.exit(1, 'An extension build exists. Preserve it before another build.\n')
    print(json.dumps(build(args.javac), indent=2))
