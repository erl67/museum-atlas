"""Project only configured fields and explicitly mapped media into the public snapshot."""

import csv
import hashlib
import json
import shutil
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

from .geography import AUDIT_CONTEXT, EggLocations, coordinate_pair
from .tables import collection_date, read_table


ROOT = Path(__file__).resolve().parents[1]
LAYERS = ('eggs', 'types', 'fluids', 'skins')
ROLES = {'catalogue', 'latitude', 'longitude', 'country', 'state', 'county', 'locality',
         'species', 'wikipedia', 'database', 'images'}
AUDIT_COLUMNS = ['catalogNumber', *AUDIT_CONTEXT.values(), 'original_lat', 'original_lon',
                 'map_latitude', 'map_longitude', 'map_method']


def local_path(base, setting):
    return (base / setting).resolve()


def read_audit(path):
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        missing = set(AUDIT_COLUMNS) - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f'{path.name}: missing notebook audit columns {sorted(missing)}')
        selected = AUDIT_COLUMNS + [k for k in ('Decimal Latitude', 'Decimal Long.', 'Decimal Longitude') if k in reader.fieldnames]
        return [{key: (row[key] or '').strip() for key in selected} for row in reader]


def check_field(field):
    if not isinstance(field.get('label'), str) or not field['label'].strip():
        raise ValueError('every published field needs a display label')
    if set(field) == {'label', 'column'} and isinstance(field['column'], str) and field['column']:
        return [field['column']]
    parts = field.get('date_parts')
    if set(field) == {'label', 'date_parts'} and isinstance(parts, list) and len(parts) == 3 and all(isinstance(x, str) and x for x in parts):
        return parts
    raise ValueError('a field needs either column or date_parts [year column, month column, day column]')


def check_source(path, mode):
    if path.is_relative_to(ROOT / 'dist') or (mode == 'production' and path.is_relative_to(ROOT / 'fixtures')):
        raise ValueError(f'{path}: choose an original input outside dist and keep development fixtures in development')


def valid_link(value, wikipedia=False):
    try:
        parts = urlsplit(value)
        host = (parts.hostname or '').lower()
        if parts.scheme.lower() not in {'https', 'http'} or not host or parts.username or parts.password:
            return False
        return not wikipedia or host == 'wikipedia.org' or host.endswith('.wikipedia.org')
    except ValueError:
        return False


def import_image(root, entry, directory):
    relative = Path(entry)
    path = (root / relative).resolve()
    if relative.is_absolute() or not path.is_relative_to(root) or not path.is_file():
        raise ValueError('image must be a file below image_root')
    with path.open('rb') as stream:
        head = stream.read(12)
    if head.startswith(b'\xff\xd8\xff'):
        suffix = '.jpg'
    elif head.startswith(b'\x89PNG\r\n\x1a\n'):
        suffix = '.png'
    elif head[:6] in (b'GIF87a', b'GIF89a'):
        suffix = '.gif'
    elif head.startswith(b'RIFF') and head[8:] == b'WEBP':
        suffix = '.webp'
    else:
        raise ValueError('image must be a JPEG, PNG, GIF or WebP file')
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    name = digest + suffix
    directory.mkdir(exist_ok=True)
    if not (directory / name).exists():
        shutil.copyfile(path, directory / name)
    return 'data/media/' + name


def read_layer(layer, settings, base, mode, data_dir, report):
    columns = settings['columns']
    if set(columns) - ROLES:
        raise ValueError(f'unknown column roles: {sorted(set(columns) - ROLES)}')
    fields = settings['fields']
    projected = [check_field(field) for field in fields]
    if len(set(field['label'] for field in fields)) != len(fields):
        raise ValueError('published field labels must be unique within a layer')
    result = {'labels': [f['label'] for f in fields], 'records': []}
    species_column = columns.get('species')
    species_field = next((i for i, f in enumerate(fields) if species_column and f.get('column') == species_column), None)
    if species_field is not None:
        result['speciesField'] = species_field
    if not settings['file']:
        return result, {'source': None, 'rows': 0, 'mapped': 0, 'status': 'no source configured'}
    required_roles = ['catalogue', 'latitude', 'longitude']
    if layer == 'eggs':
        required_roles += ['country', 'state', 'county', 'locality']
    if any(not columns.get(role) for role in required_roles):
        raise ValueError(f'configure these column roles: {", ".join(required_roles)}')
    path = local_path(base, settings['file'])
    check_source(path, mode)
    required = {name for name in columns.values() if name} | {name for names in projected for name in names}
    rows = read_table(path, settings.get('worksheet'), settings.get('header_row', 1), required,
                      columns['catalogue'], [columns.get('wikipedia'), columns.get('database')])
    id_column = columns['catalogue']
    ids = Counter(row[id_column] for _, row, issue in rows if row[id_column] and not issue)
    audit = []
    resolver = None
    if layer == 'eggs':
        if settings.get('audit'):
            audit_file = local_path(base, settings['audit'])
            check_source(audit_file, mode)
            audit = read_audit(audit_file)
        unique_rows = (row for _, row, issue in rows if not issue and ids[row[id_column]] == 1)
        resolver = EggLocations(unique_rows, columns, audit, ROOT / 'reference' / 'egg-places.json')
        for duplicate, matches in resolver.audit.items():
            if len(matches) > 1:
                report.writerow([layer, '', duplicate, 'duplicate audit identifier', f'{len(matches)} audit rows; audit join skipped'])
    image_root = None
    if columns.get('images'):
        if not settings.get('image_root'):
            raise ValueError('configure image_root when mapping images')
        image_root = local_path(base, settings['image_root'])
        check_source(image_root, mode)
    counts = Counter()
    for line, row, format_issue in rows:
        identifier = row[id_column]
        def issue(kind, detail=''):
            report.writerow([layer, line, identifier, kind, detail])
        if format_issue or not identifier or ids[identifier] > 1:
            reason = 'invalid identifier format' if format_issue else ('duplicate identifier' if identifier else 'missing identifier')
            issue(reason, format_issue or (f'{ids[identifier]} input rows withheld' if identifier else ''))
            counts[reason] += 1
            continue
        if resolver:
            pair, method, origin, note = resolver.resolve(row)
            if note:
                issue('audit not reused', note)
        else:
            lat, lon = row[columns['latitude']], row[columns['longitude']]
            pair = coordinate_pair(lat, lon)
            origin = 'original' if pair else ('invalid coordinates' if lat and lon else 'missing coordinates')
            method = 'Original coordinates'
        counts[origin] += 1
        if pair is None:
            issue(origin, ' | '.join(row.get(columns.get(k), '') for k in ('country', 'state', 'county', 'locality')))
            continue
        values = [row[f['column']] if 'column' in f else collection_date([row[k] for k in f['date_parts']]) for f in fields]
        record = {'id': identifier, 'point': [pair[1], pair[0]]}
        if values:
            record['values'] = values
        if method != 'Original coordinates':
            record['method'] = method
        for role in ('wikipedia', 'database'):
            link = row.get(columns.get(role), '')
            if link and valid_link(link, wikipedia=role == 'wikipedia'):
                record[role] = link
            elif link:
                issue('invalid ' + role + ' link')
        if species_field is None and not record.get('wikipedia') and row.get(species_column):
            record['species'] = row[species_column]
        if image_root:
            media = []
            for entry in row.get(columns['images'], '').splitlines():
                if entry.strip():
                    try:
                        media.append(import_image(image_root, entry.strip(), data_dir / 'media'))
                    except (OSError, ValueError) as error:
                        issue('image omitted', f'{entry}: {error}')
            if media:
                record['images'] = list(dict.fromkeys(media))
        result['records'].append(record)
    return result, {'source': str(path), 'rows': len(rows), 'mapped': len(result['records']), 'counts': dict(counts)}


def import_config(config_path, directory):
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    mode = config['mode']
    if mode not in ('production', 'development') or set(config['layers']) != set(LAYERS):
        raise ValueError('set mode to production/development and configure eggs, types, fluids, skins')
    if mode == 'production' and config_path.is_relative_to(ROOT / 'fixtures'):
        raise ValueError('fixture configurations must use development mode')
    data_dir = directory / 'data'
    data_dir.mkdir()
    layers, summary = {}, {}
    with (directory / 'report.csv').open('w', newline='', encoding='utf-8-sig') as stream:
        report = csv.writer(stream)
        report.writerow(['layer', 'source_row', 'catalogue_number', 'issue', 'detail'])
        for layer in LAYERS:
            try:
                layers[layer], summary[layer] = read_layer(layer, config['layers'][layer], config_path.parent, mode, data_dir, report)
            except (KeyError, ValueError, OSError) as error:
                raise ValueError(f'{layer.title()}: {error}') from error
    snapshot = {'mode': mode, 'layers': layers}
    (data_dir / 'records.json').write_text(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
    (directory / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    return mode, summary
