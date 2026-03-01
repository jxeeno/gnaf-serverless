import fsp from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  GNAF_EXTRACT_DIR,
  DUCKDB_PATH,
  GNAF_STATES,
} from "./config.js";

/**
 * Recursively find files matching a pattern in a directory.
 */
async function findFiles(
  dir: string,
  match: (name: string) => boolean
): Promise<string[]> {
  const results: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFiles(fullPath, match)));
    } else if (match(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Find PSV files for a given table name, filtered by selected states.
 * Matches files like `{STATE}_{TABLE}_psv.psv` exactly.
 */
async function findPsvFiles(
  baseDir: string,
  tableName: string
): Promise<string[]> {
  const lower = tableName.toLowerCase();
  return findFiles(baseDir, (name) => {
    const n = name.toLowerCase();
    // Match {state}_{table}_psv.psv exactly
    return GNAF_STATES.some(
      (s) => n === `${s.toLowerCase()}_${lower}_psv.psv`
    );
  });
}

/**
 * Find authority PSV files (not prefixed by state).
 * Matches files like `Authority_Code_{TABLE}_psv.psv`.
 */
async function findAuthorityPsvFiles(
  baseDir: string,
  tableName: string
): Promise<string[]> {
  const lower = tableName.toLowerCase();
  return findFiles(baseDir, (name) => {
    const n = name.toLowerCase();
    return n === `authority_code_${lower}_psv.psv`;
  });
}

/**
 * Find PSV files for all states (ignoring state filter). Used for reference tables like STATE.
 */
async function findAllStatePsvFiles(
  baseDir: string,
  tableName: string
): Promise<string[]> {
  const lower = tableName.toLowerCase();
  return findFiles(baseDir, (name) => {
    const n = name.toLowerCase();
    return n.endsWith(".psv") && n.includes(`_${lower}_psv`);
  });
}

export async function importGnaf(): Promise<DuckDBInstance> {
  console.log(`Opening DuckDB at ${DUCKDB_PATH}...`);
  console.log(`States filter: ${GNAF_STATES.join(", ")}`);
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();

  // Helper to run SQL
  const run = async (sql: string) => {
    await conn.run(sql);
  };

  // State-specific tables to import (filtered by GNAF_STATES)
  const stateTables = [
    "ADDRESS_DETAIL",
    "ADDRESS_DEFAULT_GEOCODE",
    "ADDRESS_SITE_GEOCODE",
    "STREET_LOCALITY",
    "STREET_LOCALITY_POINT",
    "LOCALITY",
    "LOCALITY_POINT",
    "ADDRESS_MESH_BLOCK_2016",
    "ADDRESS_MESH_BLOCK_2021",
    "MB_2016",
    "MB_2021",
  ];

  // Tables that need all states regardless of filter (reference/lookup data)
  const allStateTables = [
    "STATE",
  ];

  // Authority tables
  const authorityTables = [
    "FLAT_TYPE_AUT",
    "LEVEL_TYPE_AUT",
    "STREET_TYPE_AUT",
    "STREET_SUFFIX_AUT",
    "STREET_CLASS_AUT",
    "GEOCODE_TYPE_AUT",
    "GEOCODED_LEVEL_TYPE_AUT",
    "GEOCODE_RELIABILITY_AUT",
    "LOCALITY_CLASS_AUT",
  ];

  // Import state-specific tables (filtered by GNAF_STATES)
  for (const table of stateTables) {
    const files = await findPsvFiles(GNAF_EXTRACT_DIR, table);
    if (files.length === 0) {
      console.warn(`  No PSV files found for ${table}, skipping`);
      continue;
    }
    console.log(`Importing ${table} (${files.length} files)...`);
    const fileList = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
    await run(`
      CREATE OR REPLACE TABLE ${table.toLowerCase()} AS
      SELECT * FROM read_csv(
        [${fileList}],
        delim = '|',
        header = true,
        all_varchar = true,
        ignore_errors = true
      )
    `);

    const result = await conn.run(`SELECT count(*) as cnt FROM ${table.toLowerCase()}`);
    const rows = await result.getRows();
    console.log(`  → ${rows[0][0]} rows`);
  }

  // Import reference tables that need all states (e.g. STATE lookup)
  for (const table of allStateTables) {
    const files = await findAllStatePsvFiles(GNAF_EXTRACT_DIR, table);
    if (files.length === 0) {
      console.warn(`  No PSV files found for ${table}, skipping`);
      continue;
    }
    console.log(`Importing ${table} (all states, ${files.length} files)...`);
    const fileList = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
    await run(`
      CREATE OR REPLACE TABLE ${table.toLowerCase()} AS
      SELECT * FROM read_csv(
        [${fileList}],
        delim = '|',
        header = true,
        all_varchar = true,
        ignore_errors = true
      )
    `);

    const result = await conn.run(`SELECT count(*) as cnt FROM ${table.toLowerCase()}`);
    const rows = await result.getRows();
    console.log(`  → ${rows[0][0]} rows`);
  }

  // Import authority tables
  for (const table of authorityTables) {
    const files = await findAuthorityPsvFiles(GNAF_EXTRACT_DIR, table);
    if (files.length === 0) {
      console.warn(`  No PSV files found for ${table}, skipping`);
      continue;
    }
    console.log(`Importing ${table} (${files.length} files)...`);
    const fileList = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
    await run(`
      CREATE OR REPLACE TABLE ${table.toLowerCase()} AS
      SELECT * FROM read_csv(
        [${fileList}],
        delim = '|',
        header = true,
        all_varchar = true,
        ignore_errors = true
      )
    `);

    const result = await conn.run(`SELECT count(*) as cnt FROM ${table.toLowerCase()}`);
    const rows = await result.getRows();
    console.log(`  → ${rows[0][0]} rows`);
  }

  // Step 1: Build localities reference table
  console.log("Building localities reference table...");
  await run(`
    CREATE OR REPLACE TABLE localities AS
    SELECT
      loc.locality_pid,
      loc.locality_name,
      loc.primary_postcode AS postcode,
      st.state_abbreviation AS state,
      st.state_name,
      aut.code AS locality_class_code,
      aut.name AS locality_class_name,
      avg(CAST(pnt.latitude AS DOUBLE)) AS latitude,
      avg(CAST(pnt.longitude AS DOUBLE)) AS longitude
    FROM locality AS loc
    INNER JOIN state AS st ON loc.state_pid = st.state_pid
    INNER JOIN locality_class_aut AS aut ON loc.locality_class_code = aut.code
    LEFT JOIN locality_point AS pnt ON loc.locality_pid = pnt.locality_pid
    GROUP BY ALL
  `);
  let result = await conn.run(`SELECT count(*) as cnt FROM localities`);
  let rows = await result.getRows();
  console.log(`  → ${rows[0][0]} localities`);

  // Step 2: Build denormalized addresses
  console.log("Building denormalized addresses table...");
  await run(`
    CREATE OR REPLACE TABLE addresses AS
    SELECT
      adr.address_detail_pid AS gnaf_pid,
      adr.alias_principal,
      adr.primary_secondary,
      adr.building_name,
      adr.lot_number_prefix,
      adr.lot_number,
      adr.lot_number_suffix,
      adr.flat_type_code,
      flt.name AS flat_type_name,
      adr.flat_number_prefix,
      CAST(adr.flat_number AS INTEGER) AS flat_number,
      adr.flat_number_suffix,
      adr.level_type_code,
      lvl.name AS level_type_name,
      adr.level_number_prefix,
      CAST(adr.level_number AS INTEGER) AS level_number,
      adr.level_number_suffix,
      adr.number_first_prefix,
      CAST(adr.number_first AS INTEGER) AS number_first,
      adr.number_first_suffix,
      adr.number_last_prefix,
      CAST(adr.number_last AS INTEGER) AS number_last,
      adr.number_last_suffix,
      str.street_name,
      str.street_type_code,
      styp.name AS street_type_abbrev,
      str.street_suffix_code,
      ssuf.name AS street_suffix_name,
      str.street_class_code,
      scls.name AS street_class_name,
      loc.locality_name,
      loc.locality_class_code,
      loc.locality_class_name,
      loc.postcode AS locality_postcode,
      adr.postcode,
      loc.state,
      loc.state_name,
      CAST(pnt.latitude AS DOUBLE) AS latitude,
      CAST(pnt.longitude AS DOUBLE) AS longitude,
      pnt.geocode_type_code,
      gty.name AS geocode_type_name,
      CAST(adr.level_geocoded_code AS INTEGER) AS level_geocoded_code,
      glvl.name AS geocoded_level_name,
      CAST(adr.confidence AS INTEGER) AS confidence,
      adr.legal_parcel_id,
      mb16.mb_2016_code,
      mb21.mb_2021_code
    FROM address_detail AS adr
    INNER JOIN street_locality AS str ON adr.street_locality_pid = str.street_locality_pid
    INNER JOIN localities AS loc ON adr.locality_pid = loc.locality_pid
    INNER JOIN address_default_geocode AS pnt ON adr.address_detail_pid = pnt.address_detail_pid
    LEFT JOIN geocode_type_aut AS gty ON pnt.geocode_type_code = gty.code
    LEFT JOIN flat_type_aut AS flt ON adr.flat_type_code = flt.code
    LEFT JOIN level_type_aut AS lvl ON adr.level_type_code = lvl.code
    LEFT JOIN street_type_aut AS styp ON str.street_type_code = styp.code
    LEFT JOIN street_suffix_aut AS ssuf ON str.street_suffix_code = ssuf.code
    LEFT JOIN street_class_aut AS scls ON str.street_class_code = scls.code
    LEFT JOIN geocoded_level_type_aut AS glvl ON CAST(adr.level_geocoded_code AS INTEGER) = CAST(glvl.code AS INTEGER)
    LEFT JOIN (
      SELECT mb1.address_detail_pid, mb2.mb_2016_code
      FROM address_mesh_block_2016 AS mb1
      INNER JOIN mb_2016 AS mb2 ON mb1.mb_2016_pid = mb2.mb_2016_pid
    ) AS mb16 ON adr.address_detail_pid = mb16.address_detail_pid
    LEFT JOIN (
      SELECT mb1.address_detail_pid, mb2.mb_2021_code
      FROM address_mesh_block_2021 AS mb1
      INNER JOIN mb_2021 AS mb2 ON mb1.mb_2021_pid = mb2.mb_2021_pid
    ) AS mb21 ON adr.address_detail_pid = mb21.address_detail_pid
    WHERE CAST(adr.confidence AS INTEGER) > -1
  `);

  result = await conn.run(`SELECT count(*) as cnt FROM addresses`);
  rows = await result.getRows();
  console.log(`  → ${rows[0][0]} addresses`);

  conn.disconnectSync();
  return instance;
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  importGnaf()
    .then((instance) => {
      instance.closeSync();
      console.log("Import complete.");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
