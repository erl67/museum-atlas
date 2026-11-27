"""Offline Eggs resolution, following Egg_collection_location_heatmap.ipynb."""

import json
import math
import re
import unicodedata
from collections import defaultdict
from statistics import median


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def coordinate_pair(latitude, longitude):
    lat, lon = number(latitude), number(longitude)
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180 or (lat == 0 and lon == 0):
        return None
    return (lat, lon)


def normalize(value):
    folded = unicodedata.normalize('NFKD', value or '').encode('ascii', 'ignore').decode().casefold()
    result = ' '.join(re.findall(r'[a-z0-9]+', folded))
    return '' if result in {'unknown', 'locality unknown', 'specific locality unknown', 'nan'} else result


def context(row, columns):
    return tuple(normalize(row.get(columns.get(role), '')) for role in ('country', 'state', 'county', 'locality'))


def coordinate_signature(value):
    parsed = number(value)
    return parsed if parsed is not None else (value or '').strip().casefold()


def distance_km(point, other):
    a, b = map(math.radians, (point[0], other[0]))
    dlon = math.radians(other[1] - point[1])
    h = math.sin((a - b) / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dlon / 2) ** 2
    return 12742 * math.asin(math.sqrt(max(0, min(1, h))))


METHODS = {4: 'Matched locality in CSV', 3: 'County approximation', 2: 'State/province approximation'}
AUDIT_CONTEXT = {'country': 'country', 'state': 'stateProvince', 'county': 'county', 'locality': 'locality'}


class EggLocations:
    def __init__(self, rows, columns, audit, reference_file):
        self.columns = columns
        self.audit = defaultdict(list)
        for row in audit:
            if row.get('catalogNumber'):
                self.audit[row['catalogNumber']].append(row)
        with reference_file.open(encoding='utf-8') as stream:
            reference = json.load(stream)
        self.offline = {size: {tuple(key): ((lat, lon), method) for key, lat, lon, method in reference[section]}
                        for size, section in ((4, 'localities'), (3, 'counties'), (2, 'states'))}
        groups = defaultdict(list)
        for row in rows:
            pair = coordinate_pair(row[columns['latitude']], row[columns['longitude']])
            if pair:
                key = context(row, columns)
                for size in METHODS:
                    if key[0] and key[size - 1]:
                        groups[key[:size]].append(pair)
        self.internal = {}
        for key, points in groups.items():
            pair = tuple(median(axis) for axis in zip(*points))
            if len(key) == 4 and any(distance_km(pair, pt) > 50 for pt in points):
                continue
            if coordinate_pair(*pair):
                self.internal[key] = (pair, METHODS[len(key)])

    def resolve(self, row):
        c = self.columns
        raw_pair = (row[c['latitude']], row[c['longitude']])
        original = coordinate_pair(*raw_pair)
        if original:
            return original, 'Original coordinates', 'original', ''

        key = context(row, c)
        matches = self.audit.get(row[c['catalogue']], [])
        note = ''
        if len(matches) == 1:
            audited = matches[0]
            audit_pair = (audited['original_lat'], audited['original_lon'])
            # Pandas writes invalid source text as blank in original_lat/lon. The raw
            # coordinate columns, when present, preserve that distinction in the audit.
            audit_pair = (audited.get('Decimal Latitude', audit_pair[0]),
                          audited.get('Decimal Long.', audited.get('Decimal Longitude', audit_pair[1])))
            if context(audited, AUDIT_CONTEXT) == key and tuple(map(coordinate_signature, raw_pair)) == tuple(map(coordinate_signature, audit_pair)):
                resolved = coordinate_pair(audited['map_latitude'], audited['map_longitude'])
                method = audited['map_method']
                if resolved and method and method not in {'Original coordinates', 'Unresolved'}:
                    return resolved, method, 'audit', ''
            else:
                note = 'Audit geography or original coordinates changed; resolved from current input.'
        elif len(matches) > 1:
            note = 'Ambiguous audit identifier; resolved from current input.'

        for size in (4, 3, 2):
            if not key[0] or not key[size - 1]:
                continue
            part = key[:size]
            internal = self.internal.get(part)
            offline = self.offline[size].get(part)
            result = (internal or offline) if size == 4 else (offline or internal)
            if result:
                return *result, 'fallback', note
        return None, '', 'unresolved', note
