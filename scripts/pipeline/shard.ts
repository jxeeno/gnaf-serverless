import fsp from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { ShardRecord, ShardMetadata } from "../../src/shared/types.js";
import {
  DUCKDB_PATH,
  SHARDS_DIR,
  ADDRESS_SHARDS_DIR,
  LOTDP_SHARDS_DIR,
  SHARD_PREFIX_LENGTH,
  DATUM,
} from "./config.js";

/** Convert a nullable value to undefined (for JSON omission) */
function n<T>(val: T | null | undefined): T | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  return val;
}

function toShardRecord(row: Record<string, unknown>): ShardRecord {
  const rec: ShardRecord = {
    ap: (row.alias_principal as string) ?? "P",
    sn: row.street_name as string,
    loc: row.locality_name as string,
    st: row.state as string,
    stn: row.state_name as string,
    lat: row.latitude as number,
    lng: row.longitude as number,
    gtc: (row.geocode_type_code as string) ?? "",
    gtn: (row.geocode_type_name as string) ?? "",
    glc: (row.level_geocoded_code as number) ?? 0,
    con: (row.confidence as number) ?? 0,
  };

  if (n(row.primary_secondary)) rec.ps = row.primary_secondary as string;
  if (n(row.building_name)) rec.bn = row.building_name as string;
  if (n(row.lot_number_prefix)) rec.lp = row.lot_number_prefix as string;
  if (n(row.lot_number)) rec.ln = row.lot_number as string;
  if (n(row.lot_number_suffix)) rec.ls = row.lot_number_suffix as string;
  if (n(row.flat_type_code)) rec.ftc = row.flat_type_code as string;
  if (n(row.flat_type_name)) rec.ftn = row.flat_type_name as string;
  if (n(row.flat_number_prefix)) rec.fnp = row.flat_number_prefix as string;
  if (row.flat_number != null) rec.fn = row.flat_number as number;
  if (n(row.flat_number_suffix)) rec.fns = row.flat_number_suffix as string;
  if (n(row.level_type_code)) rec.ltc = row.level_type_code as string;
  if (n(row.level_type_name)) rec.ltn = row.level_type_name as string;
  if (n(row.level_number_prefix)) rec.lnp = row.level_number_prefix as string;
  if (row.level_number != null) rec.lvn = row.level_number as number;
  if (n(row.level_number_suffix)) rec.lns = row.level_number_suffix as string;
  if (n(row.number_first_prefix)) rec.nfp = row.number_first_prefix as string;
  if (row.number_first != null) rec.nf = row.number_first as number;
  if (n(row.number_first_suffix)) rec.nfs = row.number_first_suffix as string;
  if (n(row.number_last_prefix)) rec.nlp = row.number_last_prefix as string;
  if (row.number_last != null) rec.nl = row.number_last as number;
  if (n(row.number_last_suffix)) rec.nls = row.number_last_suffix as string;
  if (n(row.street_type_code)) rec.stc = row.street_type_code as string;
  if (n(row.street_type_abbrev)) rec.sta = row.street_type_abbrev as string;
  if (n(row.street_suffix_code)) rec.ssc = row.street_suffix_code as string;
  if (n(row.street_suffix_name)) rec.ssn = row.street_suffix_name as string;
  if (n(row.street_class_code)) rec.scc = row.street_class_code as string;
  if (n(row.street_class_name)) rec.scn = row.street_class_name as string;
  if (n(row.locality_class_code)) rec.lcc = row.locality_class_code as string;
  if (n(row.locality_class_name)) rec.lcn = row.locality_class_name as string;
  if (n(row.postcode)) rec.pc = row.postcode as string;
  if (n(row.geocoded_level_name)) rec.gln = row.geocoded_level_name as string;
  if (n(row.legal_parcel_id)) rec.lpi = row.legal_parcel_id as string;
  if (n(row.mb_2016_code)) rec.mb16 = row.mb_2016_code as string;
  if (n(row.mb_2021_code)) rec.mb21 = row.mb_2021_code as string;

  return rec;
}

/**
 * Read all rows from a DuckDB result into an array of row objects.
 */
async function readAllRows(
  result: { fetchChunk: () => Promise<any>; columnNames: () => string[] }
): Promise<Record<string, unknown>[]> {
  const columns = result.columnNames();
  const rows: Record<string, unknown>[] = [];
  while (true) {
    const chunk = await result.fetchChunk();
    if (!chunk || chunk.rowCount === 0) break;
    for (let i = 0; i < chunk.rowCount; i++) {
      const row: Record<string, unknown> = {};
      for (let j = 0; j < columns.length; j++) {
        row[columns[j].toLowerCase()] = chunk.getColumnVector(j).getItem(i);
      }
      rows.push(row);
    }
  }
  return rows;
}

export async function shard(): Promise<void> {
  console.log(`Opening DuckDB at ${DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();

  // Limit DuckDB memory so it doesn't compete with Node.js for the 7GB runner
  await conn.run("SET memory_limit = '3GB'");
  await conn.run("SET temp_directory = '/tmp/duckdb_temp'");

  // Create output directories
  await fsp.mkdir(ADDRESS_SHARDS_DIR, { recursive: true });
  await fsp.mkdir(LOTDP_SHARDS_DIR, { recursive: true });

  // Count total addresses
  console.log("Counting addresses...");
  const countResult = await conn.run("SELECT count(*) AS cnt FROM addresses");
  const countChunk = await countResult.fetchChunk();
  const totalAddresses = Number(countChunk!.getColumnVector(0).getItem(0));
  console.log(`Total addresses: ${totalAddresses}`);

  // Step 1: Persist shard prefix columns in DuckDB (sequential scan, NO sort)
  console.log("Computing shard prefixes (adding columns)...");
  await conn.run(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS _addr_shard VARCHAR`);
  await conn.run(
    `UPDATE addresses SET _addr_shard = LEFT(md5(gnaf_pid), ${SHARD_PREFIX_LENGTH})`
  );
  console.log("  Address shard prefixes computed");

  await conn.run(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS _lotdp_shard VARCHAR`);
  await conn.run(
    `UPDATE addresses SET _lotdp_shard = LEFT(md5(legal_parcel_id), ${SHARD_PREFIX_LENGTH}) WHERE legal_parcel_id IS NOT NULL AND legal_parcel_id != ''`
  );
  console.log("  Lot/DP shard prefixes computed");

  // Step 2: Write address shards — query each prefix individually (~3,800 rows each)
  // Instead of sorting 15.8M rows (which OOMs), we iterate 4096 small queries.
  console.log("Discovering non-empty address shard prefixes...");
  const addrPrefixResult = await conn.run(
    `SELECT DISTINCT _addr_shard FROM addresses ORDER BY _addr_shard`
  );
  const addrPrefixRows = await readAllRows(addrPrefixResult);
  const addrPrefixes = addrPrefixRows.map((r) => r._addr_shard as string);
  console.log(`Writing address shards (${addrPrefixes.length} non-empty prefixes)...`);

  let addressShardsWritten = 0;
  let totalProcessed = 0;

  for (const prefix of addrPrefixes) {
    const result = await conn.run(
      `SELECT * EXCLUDE (_addr_shard, _lotdp_shard) FROM addresses WHERE _addr_shard = '${prefix}'`
    );
    const rows = await readAllRows(result);

    if (rows.length === 0) continue;

    const obj: Record<string, ShardRecord> = {};
    for (const row of rows) {
      const pid = row.gnaf_pid as string;
      obj[pid] = toShardRecord(row);
    }

    const compressed = gzipSync(Buffer.from(JSON.stringify(obj)));
    await fsp.writeFile(
      path.join(ADDRESS_SHARDS_DIR, `${prefix}.json.gz`),
      compressed
    );
    addressShardsWritten++;
    totalProcessed += rows.length;

    if (addressShardsWritten % 500 === 0) {
      console.log(
        `  ${addressShardsWritten}/${addrPrefixes.length} address shards (${totalProcessed} rows)...`
      );
    }
  }
  console.log(
    `  ${addressShardsWritten} address shards written (${totalProcessed} rows total)`
  );

  // Step 3: Write lot/DP shards — same per-prefix approach
  console.log("Discovering non-empty lot/DP shard prefixes...");
  const lotdpPrefixResult = await conn.run(
    `SELECT DISTINCT _lotdp_shard FROM addresses WHERE _lotdp_shard IS NOT NULL ORDER BY _lotdp_shard`
  );
  const lotdpPrefixRows = await readAllRows(lotdpPrefixResult);
  const lotdpPrefixes = lotdpPrefixRows.map((r) => r._lotdp_shard as string);
  console.log(`Writing lot/DP shards (${lotdpPrefixes.length} non-empty prefixes)...`);

  let lotdpShardsWritten = 0;
  for (const prefix of lotdpPrefixes) {
    const result = await conn.run(
      `SELECT gnaf_pid, legal_parcel_id FROM addresses WHERE _lotdp_shard = '${prefix}'`
    );
    const rows = await readAllRows(result);

    if (rows.length === 0) continue;

    const obj: Record<string, string[]> = {};
    for (const row of rows) {
      const lpi = row.legal_parcel_id as string;
      const pid = row.gnaf_pid as string;
      if (!obj[lpi]) obj[lpi] = [];
      obj[lpi].push(pid);
    }

    const compressed = gzipSync(Buffer.from(JSON.stringify(obj)));
    await fsp.writeFile(
      path.join(LOTDP_SHARDS_DIR, `${prefix}.json.gz`),
      compressed
    );
    lotdpShardsWritten++;
  }
  console.log(`  ${lotdpShardsWritten} lot/DP shards written`);

  // Write metadata
  const now = new Date();
  const version = `v${now.toISOString().slice(0, 10).replace(/-/g, "")}-${DATUM.toLowerCase()}`;
  const metadata: ShardMetadata = {
    version,
    date: now.toISOString(),
    shardPrefixLength: SHARD_PREFIX_LENGTH,
    totalAddresses,
    totalShards: addressShardsWritten,
    totalLotDpShards: lotdpShardsWritten,
    datum: DATUM,
  };
  await fsp.writeFile(
    path.join(SHARDS_DIR, "metadata.json"),
    JSON.stringify(metadata, null, 2)
  );
  console.log(`Metadata written: ${JSON.stringify(metadata)}`);

  conn.disconnectSync();
  instance.closeSync();
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  shard().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
