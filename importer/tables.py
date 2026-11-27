"""Read a configured sheet without converting text catalogue numbers to numbers."""

import calendar
import csv
import re
from datetime import date, datetime
from itertools import islice


def cell_text(value):
    if value is None:
        return ''
    if isinstance(value, datetime):
        return value.date().isoformat() if value.time() == datetime.min.time() else value.isoformat(' ')
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def excel_identifier(cell):
    value = cell.value
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return cell_text(value)
    fmt = (cell.number_format or 'General').split(';')[0]
    if fmt.lower() in {'general', '@'}:
        return cell_text(value)
    # Handle common accession masks, including 00000 and "E"0000"-A".
    # Refuse ambiguous displays so digits or affixes are never silently lost.
    match = re.fullmatch(r'((?:"[^"]*"|\\.|[A-Za-z -])*)(0+)((?:"[^"]*"|\\.|[A-Za-z -])*)', fmt)
    if not match or value < 0 or int(value) != value:
        raise ValueError(f'unsupported numeric catalogue format {fmt!r}; store the identifier as Excel text')
    prefix, digits, suffix = match.groups()
    literal = lambda s: re.sub(r'"([^"]*)"|\\(.)', lambda m: m[1] if m[1] is not None else m[2], s)
    return literal(prefix) + str(int(value)).zfill(len(digits)) + literal(suffix)


def read_table(path, worksheet=None, header_row=1, required=(), catalogue=None, links=()):
    """Return (physical row number, mapped columns, ID format issue)."""
    if not isinstance(header_row, int) or header_row < 1:
        raise ValueError('header_row must be a positive row number')
    if path.suffix.lower() == '.csv':
        if worksheet:
            raise ValueError(f'{path.name}: worksheet is only applicable to Excel files')
        with path.open(encoding='utf-8-sig', newline='') as stream:
            return read_rows(csv.reader(stream), header_row, required, catalogue, links, excel=False)
    if path.suffix.lower() not in {'.xlsx', '.xlsm'}:
        raise ValueError(f'{path.name}: use a UTF-8 CSV, .xlsx or .xlsm workbook')
    try:
        from openpyxl import load_workbook
    except ImportError as error:
        raise ValueError('Excel import requires openpyxl. Run python -m pip install -r requirements.txt') from error
    # Normal mode retains spreadsheet hyperlinks when the displayed value is a label.
    book = load_workbook(path, read_only=not any(links), data_only=True, keep_links=False)
    try:
        if worksheet and worksheet not in book.sheetnames:
            raise ValueError(f'{path.name}: worksheet {worksheet!r} missing; available: {book.sheetnames}')
        sheet = book[worksheet] if worksheet else book.worksheets[0]
        return read_rows(sheet.iter_rows(), header_row, required, catalogue, links, excel=True)
    finally:
        book.close()


def read_rows(rows, header_row, required, catalogue, links, *, excel):
    rows = iter(rows)
    header = next(islice(rows, header_row - 1, None), ())
    names = [cell_text(cell.value if excel else cell) for cell in header]
    missing = set(required) - set(names)
    if missing:
        raise ValueError(f'missing configured column(s): {", ".join(sorted(missing))}')
    indices = []
    for name in dict.fromkeys(required):
        if names.count(name) != 1:
            raise ValueError(f'ambiguous header {name!r}; give the mapped column a unique name')
        indices.append((name, names.index(name)))
    result = []
    for line, cells in enumerate(rows, header_row + 1):
        if not any((cell.value if excel else cell) not in (None, '') for cell in cells):
            continue
        record = {}
        issue = ''
        for name, index in indices:
            if index >= len(cells):
                record[name] = ''
                continue
            cell = cells[index]
            if excel and name == catalogue:
                try:
                    record[name] = excel_identifier(cell)
                except ValueError as error:
                    record[name], issue = cell_text(cell.value), str(error)
            elif excel and name in links and getattr(cell, 'hyperlink', None) and cell.hyperlink.target:
                record[name] = cell.hyperlink.target
            else:
                record[name] = cell_text(cell.value if excel else cell)
        result.append((line, record, issue))
    return result


def collection_date(parts):
    """Format partial dates without filling in a missing month or day."""
    year, month, day = parts
    if not any(parts):
        return ''
    if month.isdigit() and 1 <= int(month) <= 12:
        name = calendar.month_name[int(month)]
        if not day or (day.isdigit() and 1 <= int(day) <= 31):
            return ' '.join(v for v in (str(int(day)) if day else '', name, year) if v)
    if not month and not day:
        return year
    if not year and not month:
        return day if not day.isdigit() else f'Day {day}'
    return ', '.join(f'{label} {v}' for label, v in zip(('year', 'month', 'day'), parts) if v)
