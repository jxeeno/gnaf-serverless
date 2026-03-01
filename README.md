# GNAF Serverless Lookup

Serverless Australian address lookup API powered by the [Geocoded National Address File (G-NAF)](https://data.gov.au/dataset/geocoded-national-address-file-g-naf). Runs on Cloudflare Workers with data stored in any S3-compatible object storage.

## How It Works

1. A **data pipeline** downloads GNAF from data.gov.au, denormalizes it with DuckDB, shards the data by MD5-hashed GNAF PID, gzip-compresses each shard, and uploads to S3-compatible object storage.
2. A **Cloudflare Worker** serves API requests by fetching and caching the relevant shard file from S3, then returning the formatted address response.
3. A **React frontend** provides a UI for looking up addresses by GNAF PID or Lot/DP reference.

## API

### `GET /api/addresses/:pid`

Look up a single address by GNAF PID.

```
GET /api/addresses/GAOT_718710337
```

### `GET /api/addresses?lotdp=:lotdp`

Look up addresses by Lot/DP (legal parcel ID). May return multiple results.

```
GET /api/addresses?lotdp=41/37U/22
```

### Response Format

```json
{
  "pid": "GAOT_718710337",
  "lpid": "41/37U/22",
  "precedence": "primary",
  "sla": "UNIT 1, 19 MURRAY RD, CHRISTMAS ISLAND OT 6798",
  "mla": ["UNIT 1", "19 MURRAY RD", "CHRISTMAS ISLAND OT 6798"],
  "structured": {
    "confidence": 2,
    "number": { "number": 19 },
    "street": { "name": "MURRAY", "type": { "code": "ROAD", "name": "RD" } },
    "locality": { "name": "CHRISTMAS ISLAND" },
    "postcode": "6798",
    "state": { "name": "OTHER TERRITORIES", "abbreviation": "OT" }
  },
  "geocoding": {
    "level": { "code": "7", "name": "LOCALITY, STREET, ADDRESS" },
    "geocodes": [{
      "default": true,
      "latitude": -10.42189,
      "longitude": 105.67814,
      "type": { "code": "PC", "name": "PROPERTY CENTROID" }
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
| `SHARD_PREFIX_LENGTH` | Hex chars for shard key (default: `3`, giving 4096 shards) |
| `GNAF_STATES` | Comma-separated state filter (e.g. `OT,NSW`). Omit for all states. |

### Pipeline Steps

```bash
# Run the full pipeline
npm run pipeline:run

# Or run individual steps
npm run pipeline:download   # Download GNAF ZIP from data.gov.au
npm run pipeline:import     # Import PSVs into DuckDB and denormalize
npm run pipeline:shard      # Hash-shard and gzip-compress records
npm run pipeline:upload     # Upload shards to S3
```

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
- **Frontend**: React, Tailwind CSS, shadcn/ui, Leaflet
- **Data Processing**: DuckDB, TypeScript (tsx)
- **Storage**: S3-compatible object storage
- **Build**: Vite

## License

GNAF data is provided by the Australian Government under the [End User Licence Agreement](https://data.gov.au/dataset/geocoded-national-address-file-g-naf).
