# GNAF Serverless Lookup

**Proof of concept** — serverless Australian address lookup API with autocomplete, powered by the [Geocoded National Address File (G-NAF)](https://data.gov.au/dataset/geocoded-national-address-file-g-naf). Runs on Cloudflare Workers with data stored in S3-compatible object storage and a D1 search index.

## How It Works

1. A **data pipeline** downloads GNAF from data.gov.au, denormalizes it with DuckDB, shards the data by MD5-hashed keys, gzip-compresses each shard, and uploads to S3-compatible object storage. It also generates a street search index for Cloudflare D1.
2. A **Cloudflare Worker** serves API requests — autocomplete search uses D1 (FTS5) for street matching and S3 shards for address scoring, while direct lookups fetch the relevant shard from S3.
3. A **React frontend** provides address autocomplete search, direct GNAF PID lookup, and Lot/DP reference lookup.

## API

### `GET /api/addresses/search?q=...&limit=10`

Autocomplete address search. Returns matching streets and scored addresses.

Supports:
- Street name search: `canberra avenue` or `canberra av` (synonym expansion)
- Street number: `113 canberra av`
- Unit/flat: `3/113 canberra av`, `unit 3 113 canberra`, `apt 3 canberra`

```
GET /api/addresses/search?q=113+canberra+av+griffith
```

```json
{
  "streets": [
    {
      "streetId": 3008,
      "display": "CANBERRA AV, GRIFFITH, ACT, 2603",
      "streetName": "CANBERRA",
      "locality": "GRIFFITH",
      "state": "ACT",
      "postcode": "2603",
      "addressCount": 460
    }
  ],
  "addresses": [
    {
      "pid": "GAACT717940975",
      "sla": "113 CANBERRA AV, GRIFFITH ACT 2603",
      "streetId": 3008
    }
  ]
}
```

### `GET /api/streets/:streetId/addresses`

List all addresses on a street (drill-down from search). Supports `?digit=N` for streets with many addresses.

### `GET /api/addresses/:pid`

Look up a single address by GNAF PID.

```
GET /api/addresses/GAACT717940975
```

### `GET /api/addresses?lotdp=:lotdp`

Look up addresses by Lot/DP (legal parcel ID). May return multiple results.

```
GET /api/addresses?lotdp=CANB/GRIF/25/14
```

### Address Response Format

```json
{
  "pid": "GAACT717940975",
  "lpid": "CANB/GRIF/25/14",
  "precedence": "primary",
  "sla": "113 CANBERRA AV, GRIFFITH ACT 2603",
  "mla": ["113 CANBERRA AV", "GRIFFITH ACT 2603"],
  "structured": {
    "confidence": 1,
    "number": { "number": 113 },
    "street": { "name": "CANBERRA", "type": { "code": "AV", "name": "AVENUE" } },
    "locality": { "name": "GRIFFITH" },
    "postcode": "2603",
    "state": { "name": "AUSTRALIAN CAPITAL TERRITORY", "abbreviation": "ACT" }
  },
  "geocoding": {
    "level": { "code": "7", "name": "LOCALITY, STREET, ADDRESS" },
    "geocodes": [{
      "default": true,
      "latitude": -35.32200812,
      "longitude": 149.14668731,
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
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_REGION` | S3 region (default: `auto`) |
| `S3_BUCKET` | S3 bucket name |
| `S3_ACCESS_KEY_ID` | S3 access key |
| `S3_SECRET_ACCESS_KEY` | S3 secret key |
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
npm run pipeline:upload        # Upload shards to S3
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
2. Extract and upload to your bucket:
   ```bash
   tar -xf gnaf-shards-v20260301-gda2020.tar
   aws s3 sync . s3://your-bucket/gnaf/v20260301-gda2020/ --exclude metadata.json --exclude 'search-index/*'
   aws s3 cp metadata.json s3://your-bucket/gnaf/v20260301-gda2020/metadata.json
   ```
3. Create a version pointer:
   ```bash
   echo '{"version":"v20260301-gda2020"}' | aws s3 cp - s3://your-bucket/gnaf/latest.json
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

Set S3 credentials as Wrangler secrets:

```bash
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **API Framework**: Hono
- **Search**: Cloudflare D1 (SQLite FTS5) with synonym expansion
- **Frontend**: React, Tailwind CSS, shadcn/ui, Leaflet
- **Data Processing**: DuckDB, TypeScript (tsx)
- **Storage**: S3-compatible object storage
- **Build**: Vite

## License

GNAF data is provided by the Australian Government under the [End User Licence Agreement](https://data.gov.au/dataset/geocoded-national-address-file-g-naf).
