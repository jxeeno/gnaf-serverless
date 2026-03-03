/**
 * Compact shard record stored in S3.
 * Short keys to minimize storage size. Null/undefined fields are omitted.
 */
export interface ShardRecord {
  /** alias_principal: 'P' (principal) | 'A' (alias) */
  ap: string;
  /** primary_secondary */
  ps?: string;
  /** building_name */
  bn?: string;
  /** lot_number_prefix */
  lp?: string;
  /** lot_number */
  ln?: string;
  /** lot_number_suffix */
  ls?: string;
  /** flat_type_code */
  ftc?: string;
  /** flat_type_name */
  ftn?: string;
  /** flat_number_prefix */
  fnp?: string;
  /** flat_number */
  fn?: number;
  /** flat_number_suffix */
  fns?: string;
  /** level_type_code */
  ltc?: string;
  /** level_type_name */
  ltn?: string;
  /** level_number_prefix */
  lnp?: string;
  /** level_number */
  lvn?: number;
  /** level_number_suffix */
  lns?: string;
  /** number_first_prefix */
  nfp?: string;
  /** number_first */
  nf?: number;
  /** number_first_suffix */
  nfs?: string;
  /** number_last_prefix */
  nlp?: string;
  /** number_last */
  nl?: number;
  /** number_last_suffix */
  nls?: string;
  /** street_name */
  sn: string;
  /** street_type_code (long form, e.g. "ROAD") */
  stc?: string;
  /** street_type_abbrev (e.g. "RD") */
  sta?: string;
  /** street_suffix_code */
  ssc?: string;
  /** street_suffix_name */
  ssn?: string;
  /** street_class_code */
  scc?: string;
  /** street_class_name */
  scn?: string;
  /** locality_name */
  loc: string;
  /** locality_class_code */
  lcc?: string;
  /** locality_class_name */
  lcn?: string;
  /** postcode */
  pc?: string;
  /** state abbreviation */
  st: string;
  /** state name */
  stn: string;
  /** latitude */
  lat: number;
  /** longitude */
  lng: number;
  /** geocode_type_code */
  gtc: string;
  /** geocode_type_name */
  gtn: string;
  /** geocoded_level_code */
  glc: number;
  /** geocoded_level_name */
  gln?: string;
  /** confidence */
  con: number;
  /** legal_parcel_id */
  lpi?: string;
  /** mb_2016_code */
  mb16?: string;
  /** mb_2021_code */
  mb21?: string;
}

/** A shard file: map of GNAF PID → ShardRecord */
export type AddressShardData = Record<string, ShardRecord>;

/** A lot/DP shard file: map of lot/DP string → array of GNAF PIDs */
export type LotDpShardData = Record<string, string[]>;

/** A compact address entry in a street shard */
export interface StreetAddressEntry {
  /** GNAF PID */
  p: string;
  /** Display prefix (everything before the street name, e.g. "UNIT 3, 28") */
  d: string;
  /** number_first (for numeric matching) */
  n?: number;
  /** number_last (for range matching, e.g., 99 in "95-99") */
  n2?: number;
  /** flat_number (for numeric matching) */
  f?: number;
  /** level_number (for numeric matching) */
  l?: number;
}

/** A street shard file: map of street key → array of address entries */
export type StreetShardData = Record<string, StreetAddressEntry[]>;

/** Metadata written alongside shard files */
export interface ShardMetadata {
  version: string;
  date: string;
  shardPrefixLength: number;
  totalAddresses: number;
  totalShards: number;
  totalLotDpShards: number;
  datum: string;
}

/**
 * Compact place record stored in R2 shards.
 * Short keys to minimize storage size. Null/undefined fields are omitted.
 */
export interface PlaceShardRecord {
  /** primary name */
  nm: string;
  /** primary category (e.g. "restaurant") */
  cat: string;
  /** alternate categories */
  cats?: string[];
  /** latitude */
  lat: number;
  /** longitude */
  lng: number;
  /** confidence (0-1) */
  con: number;
  /** freeform address */
  addr?: string;
  /** locality */
  loc?: string;
  /** region/state */
  reg?: string;
  /** postcode */
  pc?: string;
  /** country code */
  ctr?: string;
  /** phone */
  ph?: string;
  /** website */
  web?: string;
  /** brand name */
  br?: string;
}

/** A place shard file: map of Overture place ID → PlaceShardRecord */
export type PlaceShardData = Record<string, PlaceShardRecord>;

/** Metadata written alongside place shard files */
export interface PlaceShardMetadata {
  version: string;
  date: string;
  shardPrefixLength: number;
  totalPlaces: number;
  totalShards: number;
}

/** Full addressr-compatible API response */
export interface AddressResponse {
  pid: string;
  lpid?: string;
  precedence?: "primary" | "secondary";
  sla: string;
  ssla?: string;
  mla: string[];
  smla?: string[];
  structured: {
    confidence: number;
    buildingName?: string;
    lotNumber?: {
      prefix?: string;
      number?: string;
      suffix?: string;
    };
    flat?: {
      type: { code: string; name: string };
      prefix?: string;
      number?: number;
      suffix?: string;
    };
    level?: {
      type: { code: string; name: string };
      prefix?: string;
      number?: number;
      suffix?: string;
    };
    number?: {
      prefix?: string;
      number?: number;
      suffix?: string;
      last?: {
        prefix?: string;
        number?: number;
        suffix?: string;
      };
    };
    street: {
      name: string;
      type?: { code: string; name: string };
      suffix?: { code: string; name: string };
      class?: { code: string; name: string };
    };
    locality: {
      name: string;
      class?: { code: string; name: string };
    };
    postcode?: string;
    state: {
      name: string;
      abbreviation: string;
    };
  };
  geocoding: {
    level: { code: string; name: string };
    geocodes: Array<{
      default: boolean;
      latitude: number;
      longitude: number;
      type: { code: string; name: string };
    }>;
  };
}
