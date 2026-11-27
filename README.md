# Museum Atlas

A self-hosted map of bird catalogue records for [ericlaslo.com/birds/atlas/](https://ericlaslo.com/birds/atlas/). The ready-to-upload site is in `dist/`. It contains MapLibre GL JS 5.12.0, its worker, Natural Earth geography, fonts, the bird illustration, and the public record snapshot. The web server only needs to serve static files.

## First production snapshot

| Layer | Mapped catalogue records | Source and omissions |
| --- | ---: | --- |
| Eggs | 9,927 | Original Eggs CSV. 8,000 original coordinate pairs and 1,927 matching audit resolutions. 247 identified records have unresolved locations and 15 input rows lack an identifier. |
| Types | 278 | The Types review workbook, **Type Sheet**, header row 6. It preserves the source catalogue columns. The other 256 records lack a usable coordinate pair. |
| Fluids | 0 | Awaiting a coordinate-bearing catalogue export. The taxonomy review’s Fluid Sheet lacks coordinate columns. |
| Skins | 0 | Awaiting a coordinate-bearing catalogue export. |

Eggs and Types publish scientific name, original locality, collector, and collection date in that order. The map shows 10,205 records at 1,911 distinct positions. A ring marks records that share an exact position. The chooser lists each visible layer and catalogue number. The local development site exercises all four layers.

## Preview the included release on Windows

Run the following in PowerShell with Python 3.11 or later installed.

```powershell
Set-Location 'C:\Users\x5769\Documents\GitHub\museum-atlas'
py atlas.py preview
```

Open [the local atlas](http://127.0.0.1:8765/birds/atlas/). A direct visit and browser refresh use the same address as the deployed subdirectory. Press Ctrl+C in PowerShell to stop. If the port is busy, run `py atlas.py preview --port 8770` and use the address it prints. Preview and build use Python’s standard library and work offline.

## Import and build on Windows

Install the Excel reader once in this checkout. CSV-only imports can run with plain `py`.

```powershell
Set-Location 'C:\Users\x5769\Documents\GitHub\museum-atlas'
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

After editing `atlas.config.json`, use these commands to import the selected columns, build the upload folder and preview it.

```powershell
.\.venv\Scripts\python.exe atlas.py import --config .\atlas.config.json
.\.venv\Scripts\python.exe atlas.py build
.\.venv\Scripts\python.exe atlas.py preview
```

The importer prints the path to its row-level `report.csv` and per-layer `summary.json`. Each run has its own directory under `.local/imports/`. This command opens the latest production report in its associated Windows application.

```powershell
$runName = (Get-Content -Raw .\.local\imports\production.current).Trim()
Invoke-Item (Join-Path ".\.local\imports\$runName" 'report.csv')
```

A missing configured file, worksheet or mapped column stops the import and leaves the last successful snapshot available. Use `"file": null` to intentionally leave a layer empty. The build uses the last successful import of the requested mode. On a fresh checkout, `py atlas.py build` can rebuild the shell around the included production snapshot even without access to the workbooks. Each build replaces its generated destination, including old images.

## Configure spreadsheet columns

`atlas.config.json` is the production configuration. Paths can be absolute Windows paths (forward slashes work in JSON) or relative to the configuration file. Keep raw files in the ignored `inputs/` directory or at their existing local paths. The importer reads UTF-8 CSV, including a UTF-8 BOM, and Excel `.xlsx` and `.xlsm`. Save older binary `.xls` files as `.xlsx`. Excel formula cells use their last saved calculated value.

Each layer has the following settings.

| Setting | What to enter |
| --- | --- |
| `file`, `worksheet`, `header_row` | Local file path, Excel tab name, and one-based header row. For CSV use a null worksheet. For Excel a null worksheet selects the first tab. |
| `columns.catalogue` | Header holding the complete catalogue identifier. Keep catalogue numbers as text to preserve prefixes, suffixes and leading zeros. Common fixed-width numeric Excel masks are also supported. Unrecognized numeric ID formats go to the report. |
| `columns.latitude`, `columns.longitude` | Separate decimal-degree columns. Latitude is north-positive, longitude east-positive. The importer checks both components, ranges, and the 0/0 sentinel. |
| `columns.country`, `state`, `county`, `locality` | For Eggs, map the four geographic context columns even when individual cells are blank. Keep original locality as a published field when visitors should see the wording. |
| `columns.species` | Scientific name for Wikipedia searches. Set to null when unavailable. |
| `columns.wikipedia`, `columns.database` | Optional per-record article and collection database URLs. Excel hyperlink targets are supported. Leave null when unavailable. |
| `columns.images`, `image_root` | Optional column of local image filenames, one per line in a cell, and the directory containing those files. Supported image formats are JPEG, PNG, GIF and WebP. The importer copies referenced files with content-based filenames. External image URLs, missing files and invalid formats are reported and omitted. |
| `fields` | Ordered list of the spreadsheet columns and display labels to publish. An empty list still allows catalogue numbers, positions and mapped references. |
| `audit` | Optional Eggs notebook audit CSV. Set to null for an import without an audit. |

This example publishes four columns from a Fluids export.

```json
"fields": [
  {"column": "scientificName", "label": "Identification"},
  {"column": "verbatimLocality", "label": "Original locality"},
  {"column": "recordedBy", "label": "Collector"},
  {"column": "eventDate", "label": "Collection date"}
]
```

Use header text from your own sheet. Delete a field to omit it, move it to change the order, and edit its label to change the record panel. Empty values disappear from the panel. For separate year, month and day columns, use `{"date_parts":["year","month","day"],"label":"Collection date"}`. The source column called `date collected m/d/y` in Eggs and Types holds the **day**. The supplied configuration combines it with year and month and retains partial dates.

### Sources and mappings still needed

* **Eggs and Types** are configured from the original Drive CSV, its companion audit in `../museum-collection-analysis/`, and `AviList Taxonomy Review/AviList_Types_taxonomic_review.xlsx` in that same sibling repository. Update their paths if you move the files. Optional per-record database URLs, preferred Wikipedia URLs or local image columns can be added at any time.
* **Fluids** needs a CSV or Excel snapshot with catalogue number, decimal latitude and decimal longitude. Supply the coordinate-bearing `CM_FluidPreserved.xlsx` if those columns exist there, or another export that contains them. Set the file, worksheet/header row, actual column names, scientific name if known, and your ordered field list.
* **Skins** needs a bird skins CSV or Excel snapshot with the same minimum columns, the worksheet/header row, actual header mappings, scientific name if known, and your ordered field list.

## How positions and records are resolved

The catalogue number stays text. Identity is the pair of layer and catalogue number. Duplicate identifiers within one layer cause all conflicting input rows to be withheld and reported with their source row numbers. A number shared by different layers remains two independent records. Each identified clutch contributes one record, including clutches with a blank egg count.

Eggs follow the [original location notebook](https://github.com/erl67/museum-collection-analysis/blob/main/Egg_collection_location_heatmap.ipynb) and its [companion audit](https://github.com/erl67/museum-collection-analysis/blob/main/Egg_collection_location_audit.csv).

1. Use the current valid original coordinate pair first. An individual zero on the equator or the prime meridian is valid.
2. Join the audit by the complete catalogue number. Reuse a unique row’s valid resolved pair and recorded method when the normalized country, state/province, county, locality and original coordinate components agree with the input. This row-level check allows unchanged records to match across spreadsheet reorders. Ambiguous audit IDs and changed geographies are reported. The legacy heat-map eligibility flag is independent of Atlas inclusion.
3. For other rows, match the full locality key to original-coordinate rows in the current snapshot. Use the median only if all contributing points are within 50 km of it. Next try the notebook’s offline locality reference. Then try the county reference or same-context county median, followed by the state/province reference or same-context state/province median. Each lookup includes country and the available parent administrative context. Resolution ends at state/province.
4. Record panels label approximations and retain the source locality independently. Unresolved rows stay in the local report. Types, Fluids and Skins use supplied coordinates only.

Published JSON contains the selected display values and the catalogue ID, position, applicable location method, and information needed for record links and images. Search Wikipedia uses an English Wikipedia search for the scientific name when a supplied article is unavailable. “View egg slip” is a separate link on Eggs. E1234 opens [the E1234 egg slip](https://ericlaslo.com/birds/eggs/E1234).

## Development fixtures and offline checks

```powershell
py atlas.py import --config .\fixtures\atlas.config.json
py atlas.py build --demo
py atlas.py preview --demo --port 8766
```

Open [the development preview](http://127.0.0.1:8766/birds/atlas/). It carries a **Development fixtures** label. Its nine mapped fictional records include a shared location, same-number records across layers, missing optional fields, a local image, and both Wikipedia link modes. Its build is in `.local/demo-site/`. Production and development have separate snapshot pointers and build destinations.

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Browser verification requires Node.js, Playwright and a local Chromium browser solely on the test machine. For a checkout without Playwright, install it once with `npm install --no-save --package-lock=false playwright`. On Windows the test uses installed Microsoft Edge by default. To select another local Chromium executable, set `$env:ATLAS_BROWSER` to its path. Run the check after building both sites.

```powershell
node .\tests\browser.cjs
```

The test starts its own loopback previews. It checks direct visits and refreshes at `/birds/atlas/`, desktop and phone layouts, layer visibility, shared coordinates, optional fields, egg slip and Wikipedia destinations, and local images. It rejects off-origin resource requests and writes screenshots under `.local/qa/`.

## Upload with cPanel File Manager

1. Preview the **production** build and review its local import report. These commands prepare an upload archive with `index.html` at its root.

   ```powershell
   New-Item -ItemType Directory -Force .\.local | Out-Null
   Compress-Archive -Path .\dist\* -DestinationPath .\.local\museum-atlas-upload.zip -Force
   ```

2. In Namecheap cPanel, find the document root assigned to **ericlaslo.com** under **Domains**. In **File Manager**, open that document root and create or open `birds/atlas/`. For a document root of `public_html`, the destination is `public_html/birds/atlas/`.
3. Upload the zip there and use **Extract** into the same directory, or upload the contents of `dist/` preserving subdirectories. Confirm that `birds/atlas/index.html`, `birds/atlas/data/records.json`, `birds/atlas/vendor/` and `birds/atlas/basemap/` are at those exact levels. Remove the uploaded zip after extraction. For later releases, keep any backup of the previous atlas outside the public document root and replace the generated file set so retired images also leave the public site.
4. Visit [the production atlas](https://ericlaslo.com/birds/atlas/), refresh it, and open a known record. No server application, URL rewrite, credentials in the build, API keys, or tile service are required.

## Asset credits

The map bundles [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/), [Natural Earth](https://www.naturalearthdata.com/) geography, and locally served DM Sans and Spectral fonts. Licenses and geographic coverage are documented in `site/vendor/SOURCES.txt` and `site/basemap/SOURCES.txt`. The bird vignette comes from Mark Catesby’s public-domain common grackle engraving. [National Gallery of Art collection record](https://www.nga.gov/artworks/53847-purple-jack-daw-gracula-quiscula)

The import-only geographic reference is credited in [the reference notes](reference/README.md). The page-filling map and location-to-record interaction follow the requested [Movie Scene Map reference](https://moviescenemap.com/).
