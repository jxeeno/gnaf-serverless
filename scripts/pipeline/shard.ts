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
  SHARD_PARTITION,
  DATUM,
} from "./config.js";

/** Convert a nullable value to undefined (for JSON omission) */
function n<T>(val: T | null | undefined): T | undefined {
  if (val === null || val === undefined || val === "") return undefined;
  return val;
}

export function toShardRecord(row: Record<string, unknown>): ShardRecord {
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
export async function readAllRows(
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

/**
 * Build a column index map from a DuckDB result's column names.
 * Maps lowercase column name → column vector index.
 */
function buildColumnMap(
  result: { columnNames: () => string[] }
): Map<string, number> {
  const names = result.columnNames();
  const map = new Map<string, number>();
  for (let i = 0; i < names.length; i++) {
    map.set(names[i].toLowerCase(), i);
  }
  return map;
}

/** Minimal interface for a DuckDB data chunk */
interface DuckDBChunk {
  rowCount: number;
  getColumnVector(idx: number): { getItem(row: number): unknown };
}

/**
 * Build a ShardRecord directly from a DuckDB chunk row using column vectors.
 * Avoids the intermediate Record<string, unknown> allocation that readAllRows creates.
 */
function shardRecordFromChunk(
  chunk: DuckDBChunk,
  row: number,
  col: Map<string, number>
): ShardRecord {
  const g = (name: string) => chunk.getColumnVector(col.get(name)!).getItem(row);

  const rec: ShardRecord = {
    ap: (g("alias_principal") as string) ?? "P",
    sn: g("street_name") as string,
    loc: g("locality_name") as string,
    st: g("state") as string,
    stn: g("state_name") as string,
    lat: g("latitude") as number,
    lng: g("longitude") as number,
    gtc: (g("geocode_type_code") as string) ?? "",
    gtn: (g("geocode_type_name") as string) ?? "",
    glc: (g("level_geocoded_code") as number) ?? 0,
    con: (g("confidence") as number) ?? 0,
  };

  const ps = g("primary_secondary"); if (n(ps)) rec.ps = ps as string;
  const bn = g("building_name"); if (n(bn)) rec.bn = bn as string;
  const lp = g("lot_number_prefix"); if (n(lp)) rec.lp = lp as string;
  const ln = g("lot_number"); if (n(ln)) rec.ln = ln as string;
  const ls = g("lot_number_suffix"); if (n(ls)) rec.ls = ls as string;
  const ftc = g("flat_type_code"); if (n(ftc)) rec.ftc = ftc as string;
  const ftn = g("flat_type_name"); if (n(ftn)) rec.ftn = ftn as string;
  const fnp = g("flat_number_prefix"); if (n(fnp)) rec.fnp = fnp as string;
  const fn = g("flat_number"); if (fn != null) rec.fn = fn as number;
  const fns = g("flat_number_suffix"); if (n(fns)) rec.fns = fns as string;
  const ltc = g("level_type_code"); if (n(ltc)) rec.ltc = ltc as string;
  const ltn = g("level_type_name"); if (n(ltn)) rec.ltn = ltn as string;
  const lnp = g("level_number_prefix"); if (n(lnp)) rec.lnp = lnp as string;
  const lvn = g("level_number"); if (lvn != null) rec.lvn = lvn as number;
  const lns = g("level_number_suffix"); if (n(lns)) rec.lns = lns as string;
  const nfp = g("number_first_prefix"); if (n(nfp)) rec.nfp = nfp as string;
  const nf = g("number_first"); if (nf != null) rec.nf = nf as number;
  const nfs = g("number_first_suffix"); if (n(nfs)) rec.nfs = nfs as string;
  const nlp = g("number_last_prefix"); if (n(nlp)) rec.nlp = nlp as string;
  const nl = g("number_last"); if (nl != null) rec.nl = nl as number;
  const nls = g("number_last_suffix"); if (n(nls)) rec.nls = nls as string;
  const stc = g("street_type_code"); if (n(stc)) rec.stc = stc as string;
  const sta = g("street_type_abbrev"); if (n(sta)) rec.sta = sta as string;
  const ssc = g("street_suffix_code"); if (n(ssc)) rec.ssc = ssc as string;
  const ssn = g("street_suffix_name"); if (n(ssn)) rec.ssn = ssn as string;
  const scc = g("street_class_code"); if (n(scc)) rec.scc = scc as string;
  const scn = g("street_class_name"); if (n(scn)) rec.scn = scn as string;
  const lcc = g("locality_class_code"); if (n(lcc)) rec.lcc = lcc as string;
  const lcn = g("locality_class_name"); if (n(lcn)) rec.lcn = lcn as string;
  const pc = g("postcode"); if (n(pc)) rec.pc = pc as string;
  const gln = g("geocoded_level_name"); if (n(gln)) rec.gln = gln as string;
  const lpi = g("legal_parcel_id"); if (n(lpi)) rec.lpi = lpi as string;
  const mb16 = g("mb_2016_code"); if (n(mb16)) rec.mb16 = mb16 as string;
  const mb21 = g("mb_2021_code"); if (n(mb21)) rec.mb21 = mb21 as string;

  return rec;
}

/** Format elapsed time as "Xs" or "Xm Ys" */
function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000) | 0;
  return s >= 60 ? `${(s / 60) | 0}m ${s % 60}s` : `${s}s`;
}

export async function shard(): Promise<void> {
  const t0 = Date.now();
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
  console.log(`  Address shard prefixes computed (${elapsed(t0)})`);

  await conn.run(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS _lotdp_shard VARCHAR`);
  await conn.run(
    `UPDATE addresses SET _lotdp_shard = LEFT(md5(legal_parcel_id), ${SHARD_PREFIX_LENGTH}) WHERE legal_parcel_id IS NOT NULL AND legal_parcel_id != ''`
  );
  console.log(`  Lot/DP shard prefixes computed (${elapsed(t0)})`);

  // Step 2: Write address shards — query each prefix individually (~3,800 rows each)
  // We keep per-prefix queries (ORDER BY on 15M × 30 cols would need excessive temp storage)
  // but use direct column vector access instead of readAllRows + toShardRecord
  console.log("Discovering non-empty address shard prefixes...");
  const addrPrefixResult = await conn.run(
    `SELECT DISTINCT _addr_shard FROM addresses ORDER BY _addr_shard`
  );
  const addrPrefixRows = await readAllRows(addrPrefixResult);
  const allAddrPrefixes = addrPrefixRows.map((r) => r._addr_shard as string);
  const addrPrefixes = SHARD_PARTITION
    ? allAddrPrefixes.filter((p) => p.startsWith(SHARD_PARTITION))
    : allAddrPrefixes;
  if (SHARD_PARTITION) {
    console.log(`Partition "${SHARD_PARTITION}": ${addrPrefixes.length}/${allAddrPrefixes.length} prefixes`);
  }
  console.log(`Writing address shards (${addrPrefixes.length} non-empty prefixes)...`);

  let addressShardsWritten = 0;
  let totalProcessed = 0;

  for (const prefix of addrPrefixes) {
    const result = await conn.run(
      `SELECT * EXCLUDE (_addr_shard, _lotdp_shard) FROM addresses WHERE _addr_shard = '${prefix}'`
    );
    const col = buildColumnMap(result);
    const pidIdx = col.get("gnaf_pid")!;

    const obj: Record<string, ShardRecord> = {};
    let rowCount = 0;
    while (true) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      const pidCol = chunk.getColumnVector(pidIdx);
      for (let i = 0; i < chunk.rowCount; i++) {
        const pid = pidCol.getItem(i) as string;
        obj[pid] = shardRecordFromChunk(chunk, i, col);
        rowCount++;
      }
    }

    if (rowCount === 0) continue;

    const compressed = gzipSync(Buffer.from(JSON.stringify(obj)));
    await fsp.writeFile(
      path.join(ADDRESS_SHARDS_DIR, `${prefix}.json.gz`),
      compressed
    );
    addressShardsWritten++;
    totalProcessed += rowCount;

    if (addressShardsWritten % 10 === 0) {
      console.log(
        `  ${addressShardsWritten}/${addrPrefixes.length} address shards (${totalProcessed.toLocaleString()} rows, ${elapsed(t0)})...`
      );
    }
  }
  console.log(
    `  ${addressShardsWritten} address shards written (${totalProcessed.toLocaleString()} rows total, ${elapsed(t0)})`
  );

  // Step 3: Write lot/DP shards — single ordered query with streaming
  console.log("Streaming lot/DP shards...");
  const lotdpWhere = SHARD_PARTITION
    ? `WHERE _lotdp_shard IS NOT NULL AND _lotdp_shard LIKE '${SHARD_PARTITION}%'`
    : `WHERE _lotdp_shard IS NOT NULL`;
  const lotdpResult = await conn.run(`
    SELECT gnaf_pid, legal_parcel_id, _lotdp_shard
    FROM addresses
    ${lotdpWhere}
    ORDER BY _lotdp_shard
  `);

  let lotdpShardsWritten = 0;
  let currentLotdpShard = "";
  let currentLotdpObj: Record<string, string[]> = {};
  let lotdpRowsProcessed = 0;

  async function flushLotdpShard() {
    if (!currentLotdpShard || Object.keys(currentLotdpObj).length === 0) return;
    const compressed = gzipSync(Buffer.from(JSON.stringify(currentLotdpObj)));
    await fsp.writeFile(
      path.join(LOTDP_SHARDS_DIR, `${currentLotdpShard}.json.gz`),
      compressed
    );
    lotdpShardsWritten++;
    if (lotdpShardsWritten % 10 === 0) {
      console.log(
        `  ${lotdpShardsWritten} lot/DP shards (${lotdpRowsProcessed.toLocaleString()} rows, ${elapsed(t0)})...`
      );
    }
  }

  while (true) {
    const chunk = await lotdpResult.fetchChunk();
    if (!chunk || chunk.rowCount === 0) break;

    const pidCol = chunk.getColumnVector(0);
    const lpiCol = chunk.getColumnVector(1);
    const shardCol = chunk.getColumnVector(2);

    for (let i = 0; i < chunk.rowCount; i++) {
      const shard = shardCol.getItem(i) as string;
      if (shard !== currentLotdpShard) {
        await flushLotdpShard();
        currentLotdpShard = shard;
        currentLotdpObj = {};
      }
      const lpi = lpiCol.getItem(i) as string;
      const pid = pidCol.getItem(i) as string;
      if (!currentLotdpObj[lpi]) currentLotdpObj[lpi] = [];
      currentLotdpObj[lpi].push(pid);
      lotdpRowsProcessed++;
    }
  }
  await flushLotdpShard();
  console.log(`  ${lotdpShardsWritten} lot/DP shards written (${lotdpRowsProcessed.toLocaleString()} rows, ${elapsed(t0)})`);

  // Write metadata
  if (SHARD_PARTITION) {
    // Partitioned mode: write partial counts for this partition
    const partialMeta = {
      totalAddresses,
      totalShards: addressShardsWritten,
      totalLotDpShards: lotdpShardsWritten,
    };
    await fsp.writeFile(
      path.join(SHARDS_DIR, `_partial_meta_${SHARD_PARTITION}.json`),
      JSON.stringify(partialMeta)
    );
    console.log(`Partial metadata written for partition "${SHARD_PARTITION}": ${JSON.stringify(partialMeta)}`);
  } else {
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
  }
  console.log(`Shard generation complete (${elapsed(t0)})`);

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
