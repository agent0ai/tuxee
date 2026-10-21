#!/usr/bin/env python3
"""Inventory build-audio.sh's output without following duplicate library symlinks."""
import gzip
import io
import json
from pathlib import Path
import sys
import tarfile

root = Path(sys.argv[1]).resolve()
assert (root / 'usr/local/bin/tuxee-pulseaudio').is_file(), 'expected build-audio.sh output'
paths = sorted(root.rglob('*'))
files = {str(p.relative_to(root)): p.stat().st_size for p in paths if p.is_file() and not p.is_symlink()}
assert all(name.startswith('usr/local/') for name in files)
assert not any(name.endswith(('.h', '.a', '.o')) for name in files), 'build-only files must not ship'
buffer = io.BytesIO()
def metadata(info):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ''
    return info
with tarfile.open(fileobj=buffer, mode='w', format=tarfile.GNU_FORMAT, dereference=False) as archive:
    for path in paths:
        archive.add(path, arcname=str(path.relative_to(root)), recursive=False, filter=metadata)
print(json.dumps({'regular_file_bytes': sum(files.values()), 'tar_bytes': len(buffer.getvalue()),
                  'tar_gzip_bytes': len(gzip.compress(buffer.getvalue(), compresslevel=6, mtime=0)),
                  'files': files}, indent=2))
