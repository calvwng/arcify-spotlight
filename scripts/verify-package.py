"""Verify a ZIP matches the complete built file set without extracting it."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


def verify_package(archive_path, build_path, source_manifest):
    build = Path(build_path)
    expected = {}
    for path in build.rglob('*'):
        if path.is_symlink():
            raise ValueError('Build must not contain symbolic links')
        if path.is_file():
            expected[path.relative_to(build).as_posix()] = path.read_bytes()
    if not expected or expected.get('manifest.json') != Path(source_manifest).read_bytes():
        raise ValueError('Built manifest differs from source or build is empty')
    with zipfile.ZipFile(archive_path) as archive:
        seen = set()
        actual = {}
        for info in archive.infolist():
            name = info.filename
            path = PurePosixPath(name)
            if name in seen or not name or '\\' in name or path.is_absolute() or '..' in path.parts or ':' in name or stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError('Unsafe or duplicate ZIP entry')
            seen.add(name)
            if not info.is_dir():
                actual[name] = archive.read(info)
        if actual != expected:
            raise ValueError('ZIP files or bytes differ from built files')
    rows = [{'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)} for name, data in sorted(expected.items())]
    return {'sourceCommit': os.environ.get('GITHUB_SHA'), 'files': rows,
            'zipSha256': hashlib.sha256(Path(archive_path).read_bytes()).hexdigest()}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: verify-package.py archive.zip dist source-manifest.json')
    print(json.dumps(verify_package(*sys.argv[1:]), indent=2))
