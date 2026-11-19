import fsp from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { GeometryType } from "flatgeobuf/lib/mjs/flat-geobuf/geometry-type.js";
import { ColumnType } from "flatgeobuf/lib/mjs/flat-geobuf/column-type.js";
import type { GeoIndexMetadata, ShardMetadata } from "../../src/shared/types.js";
import { readFgbLayout } from "../../src/shared/fgb.js";
import {
  DATUM,
  DUCKDB_PATH,
  GEO_DIR,
  GEO_FGB_NAME,
  GEO_FGB_PATH,
  GEO_INFO_PATH,
  SHARDS_DIR,
} from "./config.js";

/** Geographic CRS for each datum G-NAF is published in */
const CRS_BY_DATUM: Record<string, string> = {
  GDA2020: "EPSG:7844",
  GDA94: "EPSG:4283",
};

/**
 * Street-level addresses: principals that aren't a unit inside another address.
 *
 * Aliases sit on their principal's doorway and linked units on their building's
 * point, so neither adds a location — and in a tower they would stack thousands
 * of points on one coordinate (2,667 at one Melbourne address), leaving
 * "nearest address" with no meaningful answer. Units stay reachable through
 * their building's record, which lists them. A unit with no building link has
 * no primary_pid and is kept, so nothing becomes unreachable.
 */
const STREET_LEVEL = `
  alias_principal = 'P'
  AND primary_pid IS NULL
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL`;

function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000) | 0;
  return s >= 60 ? `${(s / 60) | 0}m ${s % 60}s` : `${s}s`;
}

/**
 * Write the reverse-geocode index: one point per street-level address, with the
 * GNAF PID as its only property. Everything else about an address stays in the
 * address shards, which the Worker reads once it knows which PIDs are nearest.
 */
export async function generateGeoIndex(): Promise<GeoIndexMetadata> {
  const t0 = Date.now();
  const crs = CRS_BY_DATUM[DATUM];
  if (!crs) {
    throw new Error(`No coordinate reference system known for datum ${DATUM}`);
  }

  console.log(`Opening DuckDB at ${DUCKDB_PATH}...`);
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();

  try {
    await conn.run("SET memory_limit = '3GB'");
    await conn.run("SET temp_directory = '/tmp/duckdb_temp'");
    // Extensions are signature-checked by DuckDB before they load.
    await conn.run("INSTALL spatial; LOAD spatial;");

    const countResult = await conn.run(`SELECT count(*) FROM addresses WHERE ${STREET_LEVEL}`);
    const expected = Number((await countResult.getRows())[0][0]);
    console.log(`Street-level addresses to index: ${expected.toLocaleString()}`);

    await fsp.mkdir(GEO_DIR, { recursive: true });
    // GDAL won't write over an existing file.
    await fsp.rm(GEO_FGB_PATH, { force: true });

    console.log(`Writing ${GEO_FGB_PATH} (${crs})...`);
    // Declaring the geometry type puts it in the header once rather than in
    // every feature, which saves 16 bytes a point.
    await conn.run(`
      COPY (
        SELECT gnaf_pid, ST_Point(longitude, latitude) AS geom
        FROM addresses
        WHERE ${STREET_LEVEL}
      ) TO '${GEO_FGB_PATH.replace(/'/g, "''")}'
      WITH (
        FORMAT GDAL,
        DRIVER 'FlatGeobuf',
        SRS '${crs}',
        GEOMETRY_TYPE 'POINT',
        LAYER_CREATION_OPTIONS 'SPATIAL_INDEX=YES'
      )
    `);
    console.log(`  Written (${elapsed(t0)})`);

    const info = await validate(expected, crs);
    await fsp.writeFile(GEO_INFO_PATH, JSON.stringify(info, null, 2));

    // A local run has already written metadata.json; CI merges geo.json in the
    // release job instead, because this step runs before the metadata exists.
    const metadataPath = path.join(SHARDS_DIR, "metadata.json");
    try {
      const metadata: ShardMetadata = JSON.parse(await fsp.readFile(metadataPath, "utf-8"));
      metadata.geo = info;
      await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      console.log("  Added geo index to metadata.json");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    console.log(
      `Geo index complete: ${info.featuresCount.toLocaleString()} points, ` +
        `${(info.bytes / 1073741824).toFixed(2)} GiB (${elapsed(t0)})`
    );
    return info;
  } finally {
    conn.disconnectSync();
    instance.closeSync();
  }
}

/**
 * Read the file back the way the Worker will, so a file it can't serve fails
 * the build rather than the first reverse-geocode request.
 */
async function validate(expected: number, crs: string): Promise<GeoIndexMetadata> {
  const handle = await fsp.open(GEO_FGB_PATH, "r");
  try {
    const { size } = await handle.stat();
    const { header, featuresOffset } = await readFgbLayout(async (offset, length) => {
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, offset);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + length);
    });

    const problems: string[] = [];
    if (header.featuresCount !== expected) {
      problems.push(`has ${header.featuresCount} features, expected ${expected}`);
    }
    if (header.indexNodeSize === 0) {
      problems.push("has no spatial index");
    }
    if (header.geometryType !== GeometryType.Point) {
      problems.push(`has geometry type ${header.geometryType}, expected Point`);
    }
    const columns = header.columns?.map((c) => `${c.name}:${c.type}`) ?? [];
    if (columns.join(",") !== `gnaf_pid:${ColumnType.String}`) {
      problems.push(`has columns [${columns.join(", ")}], expected only gnaf_pid`);
    }
    const headerCrs = header.crs ? `${header.crs.org}:${header.crs.code}` : "none";
    if (headerCrs !== crs) {
      problems.push(`is in ${headerCrs}, expected ${crs}`);
    }
    if (featuresOffset >= size) {
      problems.push(`ends at ${size} bytes, before its features start (${featuresOffset})`);
    }
    if (problems.length > 0) {
      throw new Error(`Geo index ${GEO_FGB_PATH} ${problems.join("; ")}`);
    }

    console.log(
      `  Validated: ${header.featuresCount.toLocaleString()} points, ` +
        `index node size ${header.indexNodeSize}, ${headerCrs}`
    );
    return {
      file: `geo/${GEO_FGB_NAME}`,
      featuresCount: header.featuresCount,
      bytes: size,
      crs,
    };
  } finally {
    await handle.close();
  }
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateGeoIndex().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
