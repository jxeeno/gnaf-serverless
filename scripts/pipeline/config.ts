import path from "node:path";

export const CKAN_BASE = "https://data.gov.au/data/api/3/action";
export const GNAF_PACKAGE_ID = "geocoded-national-address-file-g-naf";

export const DATUM = process.env.GNAF_DATUM ?? "GDA2020";
export const SHARD_PREFIX_LENGTH = parseInt(
  process.env.SHARD_PREFIX_LENGTH ?? "3",
  10
);

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const GNAF_ZIP_PATH = path.join(DATA_DIR, "gnaf.zip");
export const GNAF_EXTRACT_DIR = path.join(DATA_DIR, "gnaf");
export const DUCKDB_PATH = path.join(DATA_DIR, "gnaf.duckdb");
export const SHARDS_DIR = path.join(DATA_DIR, "shards");
export const ADDRESS_SHARDS_DIR = path.join(SHARDS_DIR, "addresses");
export const LOTDP_SHARDS_DIR = path.join(SHARDS_DIR, "lotdp");

export const S3_ENDPOINT = process.env.S3_ENDPOINT ?? "";
export const S3_REGION = process.env.S3_REGION ?? "auto";
export const S3_BUCKET = process.env.S3_BUCKET ?? "gnaf";
export const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? "";
export const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? "";

/** All states in GNAF */
export const ALL_GNAF_STATES = [
  "ACT",
  "NSW",
  "NT",
  "OT",
  "QLD",
  "SA",
  "TAS",
  "VIC",
  "WA",
] as const;

/** States to process (filterable via GNAF_STATES env var, comma-separated) */
export const GNAF_STATES: readonly string[] = process.env.GNAF_STATES
  ? process.env.GNAF_STATES.split(",").map((s) => s.trim().toUpperCase())
  : ALL_GNAF_STATES;

/** State-specific tables that have one PSV file per state */
export const STATE_TABLES = [
  "ADDRESS_DETAIL",
  "ADDRESS_DEFAULT_GEOCODE",
  "ADDRESS_SITE",
  "ADDRESS_SITE_GEOCODE",
  "STREET_LOCALITY",
  "STREET_LOCALITY_ALIAS",
  "STREET_LOCALITY_POINT",
  "LOCALITY",
  "LOCALITY_ALIAS",
  "LOCALITY_NEIGHBOUR",
  "LOCALITY_POINT",
  "STATE",
  "ADDRESS_MESH_BLOCK_2016",
  "ADDRESS_MESH_BLOCK_2021",
  "MB_2016",
  "MB_2021",
  "PRIMARY_SECONDARY",
  "ADDRESS_ALIAS",
  "ADDRESS_FEATURE",
] as const;

/** Authority/lookup tables (single file each, not per-state) */
export const AUTHORITY_TABLES = [
  "FLAT_TYPE_AUT",
  "LEVEL_TYPE_AUT",
  "STREET_TYPE_AUT",
  "STREET_SUFFIX_AUT",
  "STREET_CLASS_AUT",
  "GEOCODE_TYPE_AUT",
  "GEOCODED_LEVEL_TYPE_AUT",
  "GEOCODE_RELIABILITY_AUT",
  "LOCALITY_CLASS_AUT",
  "ADDRESS_TYPE_AUT",
  "ADDRESS_ALIAS_TYPE_AUT",
  "PS_JOIN_TYPE_AUT",
  "LOCALITY_ALIAS_TYPE_AUT",
] as const;
