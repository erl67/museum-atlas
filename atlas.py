"""Import, build and preview the static Museum Atlas. Run 'py atlas.py --help'."""

import argparse
import json
import os
import shutil
import sys
import tempfile
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from importer.catalogue import ROOT, import_config


LOCAL = ROOT / '.local'
BASE = '/birds/atlas/'


def run_import(config):
    imports = LOCAL / 'imports'
    imports.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='snapshot-', dir=imports))
    try:
        mode, summary = import_config(config.resolve(), run)
    except Exception:
        shutil.rmtree(run)
        raise
    # Concurrent imports can finish independently. A build reads one complete run.
    pointer = run / 'pointer.tmp'
    pointer.write_text(run.name, encoding='ascii')
    os.replace(pointer, imports / (mode + '.current'))
    for name, layer in summary.items():
        print(f"{name.title():7} {layer['mapped']:>6,} mapped / {layer['rows']:,} input rows")
    print(f'Local row report: {run / "report.csv"}\nImport summary:   {run / "summary.json"}')


def output_dir(demo):
    return LOCAL / 'demo-site' if demo else ROOT / 'dist'


def build(demo):
    mode = 'development' if demo else 'production'
    target = output_dir(demo)
    pointer = LOCAL / 'imports' / (mode + '.current')
    if pointer.is_file():
        data = pointer.parent / pointer.read_text(encoding='ascii').strip() / 'data'
    elif (target / 'data' / 'records.json').is_file():
        data = target / 'data'   # Rebuild the packaged release without its raw source workbooks.
    else:
        raise ValueError('Import this snapshot before its first build.')
    snapshot = json.loads((data / 'records.json').read_text(encoding='utf-8'))
    if snapshot['mode'] != mode:
        raise ValueError(f'expected a {mode} snapshot')
    LOCAL.mkdir(exist_ok=True)
    # Stage the whole build on the same volume. Never mix old data or images into it.
    with tempfile.TemporaryDirectory(prefix='build-', dir=LOCAL) as scratch:
        staging = Path(scratch) / 'site'
        staging.mkdir()
        for name in ('index.html', 'atlas.css', 'app.js', 'record-map.js', 'atlas-icon.svg'):
            shutil.copyfile(ROOT / 'site' / name, staging / name)
        for name in ('vendor', 'basemap'):
            shutil.copytree(ROOT / 'site' / name, staging / name)
        (staging / 'art').mkdir()
        for name in ('bird.webp', 'NOTICE.txt'):
            shutil.copyfile(ROOT / 'site' / 'art' / name, staging / 'art' / name)
        (staging / 'data').mkdir()
        shutil.copyfile(data / 'records.json', staging / 'data' / 'records.json')
        for layer in snapshot['layers'].values():
            for record in layer['records']:
                for image in record.get('images', []):
                    rel = Path(image)
                    if rel.parent.as_posix() != 'data/media' or rel.name in ('.', '..'):
                        raise ValueError(f'invalid image path: {image}')
                    (staging / rel.parent).mkdir(exist_ok=True)
                    if not (staging / rel).exists():
                        shutil.copyfile(data / 'media' / rel.name, staging / rel)
        backup = LOCAL / ('previous-build-' + uuid.uuid4().hex)
        if target.exists():
            target.rename(backup)
        try:
            staging.rename(target)
        except OSError:
            if backup.exists() and not target.exists():
                backup.rename(target)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    print(f'Built {mode} site in {target}')


class AtlasHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        path = urlsplit(self.path).path
        if path in ('/', BASE.rstrip('/')):
            self.send_response(302)
            self.send_header('Location', BASE)
            self.end_headers()
            return None
        if not path.startswith(BASE):
            self.send_error(404)
            return None
        self.path = self.path[len(BASE) - 1:]
        return super().send_head()

    def list_directory(self, path):
        self.send_error(403)
        return None


def preview(demo, port):
    root = output_dir(demo)
    if not (root / 'index.html').is_file():
        raise ValueError('Build this site before previewing it.')
    server = ThreadingHTTPServer(('127.0.0.1', port), partial(AtlasHandler, directory=str(root)))
    print(f'Preview: http://127.0.0.1:{server.server_port}{BASE}  (Ctrl+C to stop)', flush=True)
    with server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    importer = commands.add_parser('import', help='import configured local spreadsheets and write review reports')
    importer.add_argument('--config', type=Path, default=ROOT / 'atlas.config.json')
    builder = commands.add_parser('build', help='build production dist/ or the separate development site')
    builder.add_argument('--demo', action='store_true')
    viewer = commands.add_parser('preview', help='serve only the built atlas at /birds/atlas/')
    viewer.add_argument('--demo', action='store_true')
    viewer.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    try:
        if args.command == 'import':
            run_import(args.config)
        elif args.command == 'build':
            build(args.demo)
        else:
            preview(args.demo, args.port)
    except (OSError, ValueError, KeyError) as error:
        print(f'Atlas: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
