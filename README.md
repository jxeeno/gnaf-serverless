# GNAF Serverless Lookup

Serverless Australian address lookup API with autocomplete, powered by the [Geocoded National Address File (G-NAF)](https://data.gov.au/dataset/geocoded-national-address-file-g-naf). Runs on Cloudflare Workers with data stored in R2 object storage and a D1 search index.

## How It Works

1. A **data pipeline** downloads GNAF from data.gov.au, denormalizes it with DuckDB, shards the data by MD5-hashed keys, gzip-compresses each shard, and uploads to Cloudflare R2. It also generates a street search index for Cloudflare D1.
2. A **Cloudflare Worker** serves API requests — autocomplete search uses D1 (FTS5) for street matching and R2 shards for address scoring, while direct lookups fetch the relevant shard from R2 via native bindings.
3. A **React frontend** provides address autocomplete search, direct GNAF PID lookup, and LPID lookup.

## API

### `GET /api/addresses/search?q=...&limit=10`

Autocomplete address search. Returns matching streets and scored addresses.

Supports:
- Street name search: `macquarie street` or `macquarie st` (synonym expansion)
- Street number: `1 macquarie st`
- Unit/flat: `11/1 macquarie st`, `unit 11 1 macquarie`, `apt 11 macquarie`

```
GET /api/addresses/search?q=1+macquarie+st+sydney
```

```json
{
  "streets": [
    {
      "streetId": 115321,
      "display": "MACQUARIE ST, SYDNEY, NSW, 2000",
      "streetName": "MACQUARIE",
      "locality": "SYDNEY",
      "state": "NSW",
      "postcode": "2000",
      "addressCount": 2343
    }
  ],
  "addresses": [
    {
      "pid": "GANSW706597865",
      "sla": "1 MACQUARIE ST, SYDNEY NSW 2000",
      "streetId": 115321
    }
  ]
}
```

### `GET /api/streets/:streetId/addresses`

List all addresses on a street (drill-down from search). Supports `?digit=N` for streets with many addresses.

### `GET /api/addresses/:pid`

Look up a single address by GNAF PID. PIDs are prefixed by state:

```
GET /api/addresses/GANSW706597865   # 1 MACQUARIE ST, SYDNEY NSW
GET /api/addresses/GAVIC412717665   # 1 SPRING ST, MELBOURNE VIC
GET /api/addresses/GAQLD425588765   # 100-102 GEORGE ST, BRISBANE CITY QLD
GET /api/addresses/GAWA_148312575   # 1 HAY ST, PERTH WA
GET /api/addresses/GATAS702241259   # 1 ELIZABETH ST, HOBART TAS
GET /api/addresses/GAACT717940975   # 113 CANBERRA AV, GRIFFITH ACT
```

### `GET /api/addresses?lpid=:lpid`

Look up addresses by legal parcel ID (LPID). May return multiple results. The `lotdp` query parameter is also accepted as an alias.

Examples across states and parcel types:

```
GET /api/addresses?lpid=21/633510           # NSW lot/deposited plan
GET /api/addresses?lpid=CP/SP58841          # NSW strata plan
GET /api/addresses?lpid=1\TP800196          # VIC title plan
GET /api/addresses?lpid=3/CP882348          # QLD community plan
GET /api/addresses?lpid=D073064/50          # WA deposited plan
GET /api/addresses?lpid=114588/1            # TAS title reference
GET /api/addresses?lpid=F/139775/A/3        # SA filing reference
GET /api/addresses?lpid=200//8941/10        # NT lot/plan
GET /api/addresses?lpid=CANB/GRIF/25/14     # ACT block/section
```

### Address Response Format

```json
{
  "pid": "GANSW706597865",
  "lpid": "CP/SP58841",
  "precedence": "primary",
  "sla": "1 MACQUARIE ST, SYDNEY NSW 2000",
  "mla": ["1 MACQUARIE ST", "SYDNEY NSW 2000"],
  "structured": {
    "confidence": 1,
    "number": { "number": 1 },
    "street": { "name": "MACQUARIE", "type": { "code": "ST", "name": "STREET" } },
    "locality": { "name": "SYDNEY" },
    "postcode": "2000",
    "state": { "name": "NEW SOUTH WALES", "abbreviation": "NSW" }
  },
  "geocoding": {
    "level": { "code": "7", "name": "LOCALITY, STREET, ADDRESS" },
    "geocodes": [{
      "default": true,
      "latitude": -33.85932705,
      "longitude": 151.21320051,
      "type": { "code": "FCS", "name": "FRONTAGE CENTRE SETBACK" }
    }]
  }
}
```

#### Address aliases

GNAF links alternate forms of an address (alias) to a canonical one (principal) via `ADDRESS_ALIAS`. Synonym (`SYN`) aliases are included in search, and address results for them include `aliasOf` with the principal PID (when scores tie, the principal is listed first). Other alias types can be fetched by PID but aren't searched.

An alias address includes the principal it belongs to:

```json
"alias": {
  "principalPid": "GANSW712199492",
  "type": { "code": "RA", "name": "RANGED ADDRESS" }
}
```

A principal address lists its aliases:

```json
"aliases": [
  { "pid": "GANSW708314090", "type": { "code": "RA", "name": "RANGED ADDRESS" } }
]
```

Alias types: `SYN` synonym, `RA` ranged address, `LD` level duplication, `FNNFS` flat number vs number-suffix (e.g. 1/25 vs 25A), `FPS` flat prefix/suffix (e.g. 2B vs B2), `CD` contributor defined.

#### Primary and secondary addresses

GNAF links the sub-addresses of a site (the units in an apartment building, the shops in a centre) to the site's own address via `PRIMARY_SECONDARY`. The `precedence` field says whether an address is a `primary` or a `secondary`; these fields say which addresses it is linked to.

A secondary address points at its primary:

```json
"precedence": "secondary",
"primary": {
  "pid": "GANSW717928588",
  "joinType": { "code": "1", "name": "AUTO" }
}
```

A primary address lists its secondaries, ordered by level then unit number:

```json
"precedence": "primary",
"secondaries": [
  { "pid": "GANSW717928480", "joinType": { "code": "1", "name": "AUTO" } },
  { "pid": "GANSW717928483", "joinType": { "code": "1", "name": "AUTO" } }
]
```

Join types: `1` AUTO (matched automatically; parent and child share the same root address), `2` MANUAL (manually created link, which may not share a root address).

The hierarchy is one level deep — no address is both a primary and a secondary, and each secondary has exactly one primary. A handful of large buildings have thousands of secondaries, so `secondaries` can be long; the web UI shows the first 250.

## Development

Install dependencies:

```bash
npm install
```

Start the development server (frontend + worker):

```bash
npm run dev
```

The app will be available at [http://localhost:5173](http://localhost:5173).

## Data Pipeline

The pipeline downloads, processes, and uploads GNAF data. It runs via GitHub Actions on a quarterly schedule or can be run locally.

### Environment Variables

| Variable | Description |
|---|---|
| `S3_ENDPOINT` | R2 S3-compatible endpoint URL (`https://<account_id>.r2.cloudflarestorage.com`) |
| `S3_REGION` | S3 region (default: `auto`) |
| `S3_BUCKET` | R2 bucket name |
| `S3_ACCESS_KEY_ID` | R2 API token access key ID |
| `S3_SECRET_ACCESS_KEY` | R2 API token secret access key |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token. Only needed for the `wrangler d1` commands, not the pipeline scripts. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID. Only needed for the `wrangler d1` commands. |
| `SHARD_PREFIX_LENGTH` | Hex chars for shard key (default: `3`, giving 4096 shards) |
| `GNAF_STATES` | Comma-separated state filter (e.g. `OT,NSW`). Omit for all states. |
| `GNAF_DATUM` | Coordinate datum to download: `GDA2020` (default) or `GDA94` |
| `GNAF_SKIP_LATEST` | Set to `1` to upload without updating the `gnaf/latest.json` pointer |
| `SHARD_PARTITION` | Only shard prefixes starting with this hex digit (`0`–`f`). Used by CI to shard in parallel. |

### Pipeline Steps

Run the full pipeline:

```bash
npm run pipeline:run
```

Or run the steps individually, in this order:

```bash
npm run pipeline:download      # Download GNAF ZIP from data.gov.au
npm run pipeline:import        # Import PSVs into DuckDB and denormalize (includes address aliases and primary/secondary links)
npm run pipeline:shard         # Hash-shard and gzip-compress address/lotdp records
npm run pipeline:search-index  # Generate street shards + D1 search index SQL
npm run pipeline:precompute    # Pre-compute short query results (requires search-index)
npm run pipeline:geo-index     # Build the reverse-geocode index (FlatGeobuf of address points)
npm run pipeline:upload        # Upload shards to R2 and update gnaf/latest.json
```

Notes:

- `npm run pipeline:run` runs all seven steps. It doesn't load the search index into D1; see [Loading the Search Index](#loading-the-search-index).
- `pipeline:download` is skipped if `data/gnaf/` already exists. Delete `data/gnaf/` and `data/gnaf.zip` to pick up a newer GNAF release.
- Local builds are versioned `v<YYYYMMDD>-<datum>` (e.g. `v20260913-gda2020`). CI builds include the GNAF release, e.g. `v20260815-may2026-gda2020`.
- Upload writes to `gnaf/<version>/` and updates `gnaf/latest.json`. Set `GNAF_SKIP_LATEST=1` to leave the pointer alone.
- `pipeline:geo-index` installs DuckDB's `spatial` extension on first run, so it needs network access.

### Reverse-geocode index

`pipeline:geo-index` writes `data/shards/geo/addresses.fgb`, a [FlatGeobuf](https://flatgeobuf.org/) file with a spatial index. It holds one point per street-level address, at the address's default geocode, and each point carries only its GNAF PID. Everything else about an address stays in the address shards. There is no API endpoint for it yet.

"Street-level" means principal addresses that aren't a unit inside another address. Aliases and linked units share their principal's or building's coordinate, so they add no location information. In a tower they would pile thousands of points onto one coordinate. Units are still reachable through their building's `secondaries`. A unit with no building link is kept.

- Points are in the build's datum: EPSG:7844 for GDA2020, or EPSG:4283 for GDA94.
- For the August 2026 release the file holds about 10.7 million points and is about 1.3 GB. It compresses to about 360 MB.
- The step reads the file back and fails the build if the point count, spatial index, geometry type, columns or CRS aren't as expected.
- `metadata.json` describes the file under `geo`: its path, point count, size in bytes and CRS. Upload refuses to run if `metadata.json` lists a geo index that is missing or a different size.
- R2 stores the file uncompressed, because it's read with range requests. Releases ship it gzipped, as its own asset.

### Loading the Search Index

The search index is loaded into D1 automatically by the [Deploy workflow](.github/workflows/deploy-gnaf.yml), which creates a fresh D1 database per release, enables read replication, and updates `wrangler.json` with the new database ID.

`npm run dev` uses the remote D1 database, because the `SEARCH_DB` binding is marked `"remote": true` in `wrangler.json`. To develop against a local copy instead, set `"remote": false` on that binding and load the SQL locally:

```bash
for f in data/shards/search-index/*.sql; do
  npx wrangler d1 execute SEARCH_DB --local --file="$f"
done
```

### GitHub Actions

The [Update GNAF Data workflow](.github/workflows/update-gnaf.yml) runs on the 15th of Feb, May, Aug and Nov, and can be run manually from the Actions tab. It builds the data, publishes a GitHub release, and then starts the [Deploy workflow](.github/workflows/deploy-gnaf.yml).

#### Test builds

To try pipeline changes on a branch without touching production, run the Update GNAF Data workflow on that branch with a `test_suffix` (e.g. `aliases`):

```bash
gh workflow run update-gnaf.yml --ref my-branch -f test_suffix=aliases
```

A test build:

- appends the suffix to the version (e.g. `v20260913-aug2026-gda2020-aliases`)
- uploads to R2 without updating `gnaf/latest.json`
- creates its own D1 database (without read replication) and loads the search index
- commits `wrangler.json` on the branch to point at the test data, which triggers a branch preview build (never on `main`)
- skips the GitHub release and the production deploy

Before merging the branch, revert the `wrangler.json` commit. Clean up the test D1 database and R2 prefix when you're done.

## Using Pre-built Data

Each quarterly GNAF release is published as a [GitHub release](https://github.com/jxeeno/gnaf-serverless/releases) containing pre-processed, hash-sharded address data, the D1 search index, and the reverse-geocode index.

The [Deploy workflow](.github/workflows/deploy-gnaf.yml) uploads shards to R2, creates a new D1 database with read replication, and updates `wrangler.json`. It runs when:

- the Update GNAF Data workflow finishes (it starts the deploy itself, because releases created by GitHub Actions don't trigger other workflows)
- a release is published manually
- you run it from the Actions tab, optionally with a release tag

To deploy manually instead:

1. Download `gnaf-shards-<version>.tar` (about 1.5 GB) from [Releases](https://github.com/jxeeno/gnaf-serverless/releases). For releases that include the reverse-geocode index, also download `gnaf-geo-<version>.fgb.gz` (about 360 MB). The examples below use `v20260815-may2026-gda2020`.
2. Create the R2 bucket, then extract and upload. The geo index must be stored uncompressed:
   ```bash
   npx wrangler r2 bucket create gnaf-data --location oc
   mkdir shards && tar -xf gnaf-shards-v20260815-may2026-gda2020.tar -C shards
   # Only if the release has a geo index
   mkdir -p shards/geo && gunzip -c gnaf-geo-v20260815-may2026-gda2020.fgb.gz > shards/geo/addresses.fgb
   cd shards
   # Upload via R2's S3-compatible API
   aws s3 sync . s3://gnaf-data/gnaf/v20260815-may2026-gda2020/ \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com \
     --exclude 'search-index/*'
   ```
3. Create a D1 database and load the search index:
   ```bash
   npx wrangler d1 create gnaf-search-v20260815-may2026-gda2020 --location=oc
   for f in search-index/*.sql; do
     npx wrangler d1 execute gnaf-search-v20260815-may2026-gda2020 --remote --file="$f"
   done
   ```
4. Optionally enable D1 read replication (the Deploy workflow does this):
   ```bash
   curl -X PATCH \
     "https://api.cloudflare.com/client/v4/accounts/<account_id>/d1/database/<database_id>" \
     -H "Authorization: Bearer <api_token>" \
     -H "Content-Type: application/json" \
     -d '{"read_replication":{"mode":"auto"}}'
   ```
5. Update `wrangler.json`:
   - set the D1 `database_id` and `database_name`
   - set `vars.GNAF_VERSION` to the version (e.g. `v20260815-may2026-gda2020`)
   - if you're deploying to your own account, change `routes` (custom domain `gnaf.k3n.au`) and the R2 `bucket_name`s to your own

## PMTiles Overlays

The `/api/addresses/:pid` endpoint can enrich address responses with additional geographic attributes (e.g. electricity distributor, SA1/SA2, LGA, electorate) by performing point-in-polygon queries against PMTiles vector tile files stored in a separate R2 bucket.

### Setup

1. Create the R2 bucket with an Oceania location hint (for Australian data):
   ```bash
   npx wrangler r2 bucket create gnaf-pmtiles --location oc
   ```

2. Upload PMTiles files to the bucket:
   ```bash
   npx wrangler r2 object put gnaf-pmtiles/elec_distributor_12.pmtiles --file=elec_distributor_12.pmtiles
   ```

3. Configure `PMTILES_LAYERS` in `wrangler.json` (or `.dev.vars` for local dev):
   ```json
   [
     {
       "name": "elec_distributor",
       "label": "Electricity Distributor",
       "file": "elec_distributor_12.pmtiles",
       "layer": "elec_distributor",
       "zoom": 12,
       "properties": ["elec_distributor"]
     }
   ]
   ```

   | Field | Description |
   |-------|-------------|
   | `name` | Unique key in the response `overlays` object |
   | `label` | Human-readable display label |
   | `file` | PMTiles filename in the R2 bucket |
   | `layer` | Vector tile layer name within the PMTiles file |
   | `zoom` | Zoom level to query tiles at |
   | `properties` | Which feature properties to include (omit for all) |

### Response

When overlays are configured and a match is found, the address response includes an `overlays` field. Each overlay contains a `features` array with all matching polygons:

```json
{
  "pid": "GAACT717940975",
  "sla": "113 CANBERRA AV, GRIFFITH ACT 2603",
  "overlays": {
    "elec_distributor": {
      "label": "Electricity Distributor",
      "features": [
        { "elec_distributor": "Evoenergy" }
      ]
    }
  }
}
```

## Deployment

The worker is deployed by Cloudflare Workers Builds when commits are pushed to `main`. Pushes to other branches upload a preview version with a preview URL (`<branch>-gnaf-s3-query.<subdomain>.workers.dev`). `wrangler.json` sets `"preview_urls": true` so production deploys don't turn preview URLs off.

To build and deploy manually:

```bash
npm run build
npm run deploy
```

The worker uses a native R2 binding (`GNAF_BUCKET`) configured in `wrangler.json` — no secrets are needed for data access.

API responses are cached with the Cache API for a week, keyed by URL and GNAF version, so deploying a new data version doesn't serve stale responses.

## Pre-computed Short Queries

Common short queries are pre-computed at build time during the GitHub Actions pipeline (`npm run pipeline:precompute`). The results are stored as individual JSON files in the release archive and uploaded to R2 (`gnaf/{version}/precomputed/{query}.json`). These are served directly for matching requests, bypassing D1 + R2 shard lookups entirely.

Pre-computed query patterns (3,672 total):
| Pattern | Example | Count |
|---------|---------|-------|
| 1-char letter or digit | `a`, `5` | 36 |
| 2-char all letters | `sy`, `ke` | 676 |
| 2-char all digits | `12`, `05` | 100 |
| 1 digit + space + letter | `1 m`, `5 k` | 260 |
| 2 digits + space + letter | `12 k`, `25 s` | 2,600 |

### How short query serving works

When a search request arrives with a short query (e.g. `?q=sy`):

1. The query is normalized: trimmed, non-alphanumeric characters stripped (spaces preserved), lowercased
2. If the normalized query matches a pre-computed pattern, the worker loads the result from R2 (with Cache API caching)
3. The response is returned with an `X-Precomputed: true` header
4. If no pre-computed result exists, the query falls through to the normal D1 + R2 search path and the result is lazily stored in R2 for future requests

## Cache Warming

A Cloudflare Cron Trigger runs every minute to keep caches warm and reduce cold-start latency for search requests.

### What it does

The `scheduled` handler in the worker performs two tasks:

1. **D1 keepalive** — executes `SELECT 1` to prevent cold D1 connections on the next user request.

2. **Warm R2 street shard caches** — iterates all 4,096 street shard files (used by search/autocomplete), checks the Cloudflare Cache API, and fetches from R2 on miss to populate the cache.

### Configuration

The cron trigger is configured in `wrangler.json`:

```json
"triggers": {
  "crons": ["* * * * *"]
}
```

### R2 storage layout

```
gnaf/{version}/precomputed/
├── a.json             # Pre-computed result for query "a"
├── sy.json            # Pre-computed result for query "sy"
├── 1 m.json           # Pre-computed result for query "1 m"
├── 12 k.json          # Pre-computed result for query "12 k"
└── ...                # 3,672 files total
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **API Framework**: Hono
- **Search**: Cloudflare D1 (SQLite FTS5) with synonym expansion
- **Frontend**: React, Tailwind CSS, shadcn/ui, Leaflet
- **Data Processing**: DuckDB, TypeScript (tsx)
- **Storage**: Cloudflare R2 (native binding)
- **Build**: Vite

## License

GNAF data is provided by the Australian Government under the [End User Licence Agreement](https://data.gov.au/dataset/geocoded-national-address-file-g-naf).
