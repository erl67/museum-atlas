import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from importer.catalogue import ROOT, import_config, read_layer
from importer.geography import EggLocations, coordinate_pair
from importer.tables import collection_date, excel_identifier, read_table


COL = dict(catalogue='id', latitude='lat', longitude='lon', country='country',
           state='state', county='county', locality='place')


def egg(identifier='E001', lat='', lon='', country='Demo country', state='North', county='One', place='Harbour'):
    return dict(id=identifier, lat=lat, lon=lon, country=country, state=state, county=county, place=place)


def audit(identifier='E001', **changes):
    values = dict(catalogNumber=identifier, country='Demo country', stateProvince='North', county='One',
                  locality='Harbour', original_lat='', original_lon='', map_latitude='10',
                  map_longitude='20', map_method='Locality/town approximation', eligible_for_map='False')
    return {**values, **changes}


def resolver(rows=(), audits=()):
    return EggLocations(rows, COL, audits, ROOT / 'reference' / 'egg-places.json')


class EggPlacement(unittest.TestCase):
    def test_validation(self):
        for pair in [(0, 0), ('', 3), ('NaN', 8), (2, 'inf'), (91, 0), (40, -181)]:
            self.assertIsNone(coordinate_pair(*pair))
        for pair in [(0, -79), (42, 0), (-90, 180)]:
            self.assertEqual(coordinate_pair(*pair), pair)

    def test_original_wins_and_matching_audit_ignores_egg_weight(self):
        locations = resolver(audits=[audit()])
        self.assertEqual(locations.resolve(egg(lat='0', lon='5'))[:3], ((0, 5), 'Original coordinates', 'original'))
        self.assertEqual(locations.resolve(egg())[:3], ((10, 20), 'Locality/town approximation', 'audit'))

    def test_changed_geography_or_partial_coordinate_cannot_reuse_audit(self):
        locations = resolver(audits=[audit()])
        for row in [egg(lon='5'), egg(state='South'), egg(county='Two'), egg(country='Other'), egg(place='East')]:
            pair, _, origin, note = locations.resolve(row)
            self.assertIsNone(pair)
            self.assertEqual(origin, 'unresolved')
            self.assertIn('changed', note)

    def test_ambiguous_audit_id_and_invalid_resolved_pair(self):
        self.assertIsNone(resolver(audits=[audit(), audit()]).resolve(egg())[0])
        self.assertIsNone(resolver(audits=[audit(map_longitude='220')]).resolve(egg())[0])
        self.assertIsNone(resolver(audits=[audit('E1')]).resolve(egg())[0])

    def test_context_and_priority(self):
        locations = resolver([egg('A', '30', '12'), egg('B', '30.02', '12'), egg('C', '32', '13', county='Two', place='Other')])
        for place, expected in [('Hárbour', 'Matched locality in CSV'), ('Inlet', 'County approximation')]:
            pair, method, _, _ = locations.resolve(egg(place=place))
            self.assertAlmostEqual(pair[0], 30.01)
            self.assertEqual(pair[1], 12)
            self.assertEqual(method, expected)
        self.assertEqual(locations.resolve(egg(county='Elsewhere'))[1], 'State/province approximation')
        for row in [egg(country='Another'), egg(state='South'), egg(state='', county='', place='')]:
            self.assertIsNone(locations.resolve(row)[0])

    def test_widely_scattered_donors_do_not_imply_a_locality_match(self):
        locations = resolver([egg('A', '30', '10'), egg('B', '33', '12')])
        self.assertEqual(locations.resolve(egg())[1], 'County approximation')

    def test_offline_reference_hierarchy(self):
        row = egg(country='United States', state='Pennsylvania', county='Elk', place='Saint Marys, 8 mi N')
        locations = resolver()
        self.assertEqual(locations.resolve(row)[:2], ((41.42784, -78.56086), 'Locality/town approximation'))
        self.assertEqual(locations.resolve({**row, 'place': 'Unlisted'})[1], 'County approximation')
        self.assertEqual(locations.resolve({**row, 'county': 'No such county'})[1], 'State/province approximation')


class SpreadsheetImport(unittest.TestCase):
    def test_projections_reports_and_local_images(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp)
            _, summary = import_config(ROOT / 'fixtures' / 'atlas.config.json', dest)
            snapshot = json.loads((dest / 'data/records.json').read_text(encoding='utf-8'))
            self.assertEqual(snapshot['mode'], 'development')
            self.assertEqual([layer['mapped'] for layer in summary.values()], [3, 2, 2, 2])
            layers = snapshot['layers']
            egg_record = layers['eggs']['records'][0]
            self.assertEqual(egg_record['id'], layers['types']['records'][0]['id'])
            self.assertEqual(egg_record['point'], layers['types']['records'][0]['point'])
            self.assertEqual(layers['types']['records'][1]['id'], '00019-B')
            self.assertEqual(layers['eggs']['records'][1]['method'], 'Locality/town approximation')
            image = layers['fluids']['records'][0]['images'][0]
            self.assertEqual((dest / image).read_bytes(), (ROOT / 'site/art/bird.webp').read_bytes())
            self.assertNotIn('EXCLUDED-FIXTURE-COLUMN', str(snapshot))
            self.assertNotIn('eggCount', str(snapshot))
            with (dest / 'report.csv').open(encoding='utf-8-sig', newline='') as stream:
                issues = [r['issue'] for r in csv.DictReader(stream)]
            self.assertCountEqual(issues, ['duplicate identifier', 'duplicate identifier', 'invalid coordinates', 'unresolved'])

    def test_empty_layers_and_external_media(self):
        settings = dict(file=None, columns={'catalogue': 'Number'}, fields=[])
        report = io.StringIO()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            result, _ = read_layer('skins', settings, path, 'production', path, csv.writer(report))
            self.assertEqual(result['records'], [])
            (path / 'rows.csv').write_text('id,lat,lon,img,url\n0003,10,0,https://example.org/p.jpg,javascript:alert(1)\n', encoding='utf-8')
            settings.update(file='rows.csv', image_root='.', columns=dict(catalogue='id', latitude='lat', longitude='lon', images='img', database='url'))
            record = read_layer('skins', settings, path, 'production', path, csv.writer(report))[0]['records'][0]
            self.assertEqual(record, {'id': '0003', 'point': [0, 10]})
            self.assertIn('image omitted', report.getvalue())
            self.assertIn('invalid database link', report.getvalue())

    def test_production_fixture_guard(self):
        config = json.loads((ROOT / 'fixtures/atlas.config.json').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp)
            config['mode'] = 'production'
            config['layers']['eggs']['file'] = str(ROOT / 'fixtures/eggs.csv')
            file = dest / 'config.json'
            file.write_text(json.dumps(config), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'fixtures'):
                import_config(file, dest)

    def test_id_formats(self):
        def formatted(value, fmt): return excel_identifier(SimpleNamespace(value=value, number_format=fmt))
        self.assertEqual(formatted('E0001-B', 'General'), 'E0001-B')
        self.assertEqual(formatted(7, '"E"0000"-B"'), 'E0007-B')
        self.assertEqual(formatted(7, '00000'), '00007')
        self.assertEqual(formatted(7.0, 'General'), '7')
        with self.assertRaises(ValueError):
            formatted(7.2, '00.00')

    def test_partial_dates(self):
        self.assertEqual(collection_date(['1905', '5', '3']), '3 May 1905')
        self.assertEqual(collection_date(['1905', '5', '']), 'May 1905')
        self.assertEqual(collection_date(['1905', '', '']), '1905')
        self.assertEqual(collection_date(['', '', '']), '')
        self.assertEqual(collection_date(['1905', '', '3']), 'year 1905, day 3')

    def test_bad_mapping_or_duplicate_header_fails_import(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'test.csv'
            file.write_text('id,lat,lat\nX,1,2', encoding='utf-8')
            for column in ['missing', 'lat']:
                with self.assertRaises(ValueError):
                    read_table(file, required=[column])

    def test_excel_worksheet_header_date_and_mask(self):
        # Generate a small input in memory specifically to test Excel cell types.
        from openpyxl import Workbook
        from datetime import date
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'records.xlsx'
            book = Workbook()
            sheet = book.create_sheet('Types')
            sheet.append(['Introduction'])
            sheet.append(['ID', 'Collected', 'Article'])
            sheet.append([35, date(1910, 2, 1), 'Article'])
            sheet['A3'].number_format = '"E"0000"A"'
            sheet['C3'].hyperlink = 'https://en.wikipedia.org/wiki/Common_blackbird'
            book.save(path)
            rows = read_table(path, 'Types', 2, ['ID', 'Collected', 'Article'], 'ID', ['Article'])
            self.assertEqual(rows, [(3, {'ID': 'E0035A', 'Collected': '1910-02-01',
                                         'Article': 'https://en.wikipedia.org/wiki/Common_blackbird'}, '')])


if __name__ == '__main__':
    unittest.main()
