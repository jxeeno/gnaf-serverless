# GNAF Serverless Lookup

**Proof of concept** — serverless Australian address lookup API with autocomplete, powered by the [Geocoded National Address File (G-NAF)](https://data.gov.au/dataset/geocoded-national-address-file-g-naf). Runs on Cloudflare Workers with data stored in R2 object storage and a D1 search index.

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
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token (for D1 remote access) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `SHARD_PREFIX_LENGTH` | Hex chars for shard key (default: `3`, giving 4096 shards) |
| `GNAF_STATES` | Comma-separated state filter (e.g. `OT,NSW`). Omit for all states. |

### Pipeline Steps

```bash
# Run the full pipeline
npm run pipeline:run

# Or run individual steps
npm run pipeline:download      # Download GNAF ZIP from data.gov.au
npm run pipeline:import        # Import PSVs into DuckDB and denormalize
npm run pipeline:shard         # Hash-shard and gzip-compress address/lotdp records
npm run pipeline:search-index  # Generate street shards + D1 search index SQL
npm run pipeline:upload        # Upload shards to R2
```

### Loading the Search Index

The search index is split into chunk files for reliable D1 import:

```bash
# Local
for f in data/shards/search-index/*.sql; do
  npx wrangler d1 execute gnaf-search --local --file="$f"
done

# Remote
for f in data/shards/search-index/*.sql; do
  npx wrangler d1 execute gnaf-search --remote --file="$f"
done
```

## Using Pre-built Data

Each quarterly GNAF release is published as a [GitHub release](https://github.com/jxeeno/gnaf-serverless/releases) containing pre-processed, hash-sharded address data and the D1 search index. You can skip the pipeline and upload directly.

1. Download the latest `gnaf-shards-*.tar` from [Releases](https://github.com/jxeeno/gnaf-serverless/releases)
2. Create the R2 bucket and extract/upload:
   ```bash
   npx wrangler r2 bucket create gnaf-data
   tar -xf gnaf-shards-v20260301-gda2020.tar
   # Upload via R2's S3-compatible API
   aws s3 sync . s3://gnaf-data/gnaf/v20260301-gda2020/ \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com \
     --exclude metadata.json --exclude 'search-index/*'
   aws s3 cp metadata.json s3://gnaf-data/gnaf/v20260301-gda2020/metadata.json \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com
   ```
3. Create a version pointer:
   ```bash
   echo '{"version":"v20260301-gda2020"}' | aws s3 cp - s3://gnaf-data/gnaf/latest.json \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com
   ```
4. Load the search index into D1:
   ```bash
   npx wrangler d1 create gnaf-search  # first time only
   for f in search-index/*.sql; do
     npx wrangler d1 execute gnaf-search --remote --file="$f"
   done
   ```
5. Set the `GNAF_VERSION` var in `wrangler.json` to match (e.g. `v20260301-gda2020`)

## Deployment

Build and deploy the worker:

```bash
npm run build
npm run deploy
```

The worker uses a native R2 binding (`GNAF_BUCKET`) configured in `wrangler.json` — no secrets are needed for data access.

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
