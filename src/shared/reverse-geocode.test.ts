import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as flatbuffers from "flatbuffers";
import { Feature } from "flatgeobuf/lib/mjs/flat-geobuf/feature.js";
import { readFgbLayout, type ReadRange } from "./fgb.js";
import { GeoIndex, decodePid, haversineMetres, type NearestAddress } from "./reverse-geocode.js";

// 234 street-level points around Rhodes NSW, written by the pipeline's own
// DuckDB/GDAL path. Vitest runs from the repo root.
const file = readFileSync("src/shared/fixtures/rhodes.fgb");

function slice(offset: number, length: number): ArrayBuffer {
  if (offset < 0 || offset + length > file.byteLength) {
    throw new Error(`read outside the file: ${offset}+${length}`);
  }
  return file.buffer.slice(file.byteOffset + offset, file.byteOffset + offset + length);
}

const source: ReadRange = async (offset, length) => slice(offset, length);

interface Point {
  pid: string;
  lat: number;
  lng: number;
  offset: number;
}

/** Every point in the file, found by walking the features one after another — no tree involved. */
async function readAllPoints(): Promise<Point[]> {
  const { featuresOffset } = await readFgbLayout(source);
  const points: Point[] = [];
  for (let pos = featuresOffset; pos < file.byteLength; ) {
    const length = new DataView(slice(pos, 4)).getUint32(0, true);
    const bytes = new Uint8Array(slice(pos, 4 + length));
    const feature = Feature.getSizePrefixedRootAsFeature(new flatbuffers.ByteBuffer(bytes.slice()));
    const xy = feature.geometry()!.xyArray()!;
    points.push({ pid: decodePid(bytes), lng: xy[0], lat: xy[1], offset: pos - featuresOffset });
    pos += 4 + length;
  }
  return points;
}

function bruteForce(points: Point[], lat: number, lng: number, limit: number, maxRadius: number) {
  return points
    .map((p) => ({ pid: p.pid, distance: haversineMetres(lat, lng, p.lat, p.lng) }))
    .filter((p) => p.distance <= maxRadius)
    .sort((a, b) => a.distance - b.distance || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0))
    .slice(0, limit);
}

const summarise = (results: NearestAddress[]) =>
  results.map((r) => ({ pid: r.pid, distance: r.distance }));

/** Deterministic pseudo-random numbers, so a failure can be reproduced. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let points: Point[];
let bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };

beforeAll(async () => {
  points = await readAllPoints();
  bounds = {
    minLat: Math.min(...points.map((p) => p.lat)),
    maxLat: Math.max(...points.map((p) => p.lat)),
    minLng: Math.min(...points.map((p) => p.lng)),
    maxLng: Math.max(...points.map((p) => p.lng)),
  };
});

describe("GeoIndex.nearest", () => {
  it("reads every point the file holds", () => {
    expect(points).toHaveLength(234);
  });

  it("finds 76 Rider Bvd at its own geocode", async () => {
    const index = await GeoIndex.open(source, file.byteLength);
    const [hit] = await index.nearest(-33.83263969, 151.08540762, { limit: 1, maxRadius: 100 });
    expect(hit.pid).toBe("GANSW717928588");
    expect(hit.distance).toBeLessThan(1);
  });

  it("agrees with a brute-force search at random points", async () => {
    const index = await GeoIndex.open(source, file.byteLength);
    const random = mulberry32(20260917);
    // Spread the queries a little past the data so some start with an empty box.
    const pad = 0.004;
    for (let i = 0; i < 300; i++) {
      const lat = bounds.minLat - pad + random() * (bounds.maxLat - bounds.minLat + 2 * pad);
      const lng = bounds.minLng - pad + random() * (bounds.maxLng - bounds.minLng + 2 * pad);
      for (const limit of [1, 3, 10]) {
        const got = await index.nearest(lat, lng, { limit, maxRadius: 1000 });
        expect(summarise(got), `limit ${limit} at ${lat},${lng}`).toEqual(
          bruteForce(points, lat, lng, limit, 1000)
        );
      }
    }
  });

  it("finds each point at its own coordinate", async () => {
    const index = await GeoIndex.open(source, file.byteLength);
    for (const p of points) {
      const [hit] = await index.nearest(p.lat, p.lng, { limit: 1, maxRadius: 50 });
      // A point sharing its coordinate with another can lose the PID tiebreak,
      // but the winner must still be at distance 0.
      expect(hit.distance).toBe(0);
      expect(hit.pid).toBe(bruteForce(points, p.lat, p.lng, 1, 50)[0].pid);
    }
  });

  it("reads the last feature in the file, whose length comes from the file size", async () => {
    const index = await GeoIndex.open(source, file.byteLength);
    const last = points.reduce((a, b) => (a.offset > b.offset ? a : b));
    const [hit] = await index.nearest(last.lat, last.lng, { limit: 1, maxRadius: 50 });
    expect(hit.distance).toBe(0);
    expect(hit.pid).toBe(bruteForce(points, last.lat, last.lng, 1, 50)[0].pid);
  });

  it("returns nothing beyond the radius, and finds the address once the radius reaches it", async () => {
    const index = await GeoIndex.open(source, file.byteLength);
    // About 5 km east of the data.
    const lat = bounds.maxLat;
    const lng = bounds.maxLng + 0.055;
    expect(await index.nearest(lat, lng, { limit: 1, maxRadius: 1000 })).toEqual([]);

    const [hit] = await index.nearest(lat, lng, { limit: 1, maxRadius: 20_000 });
    expect(hit.distance).toBeGreaterThan(1000);
    expect(summarise([hit])).toEqual(bruteForce(points, lat, lng, 1, 20_000));
  });

  it("gives the same answers with none of the tree held in memory", async () => {
    const cached = await GeoIndex.open(source, file.byteLength);
    const uncached = await GeoIndex.open(source, file.byteLength, { prefixBudgetBytes: 0 });
    const random = mulberry32(7);
    for (let i = 0; i < 50; i++) {
      const lat = bounds.minLat + random() * (bounds.maxLat - bounds.minLat);
      const lng = bounds.minLng + random() * (bounds.maxLng - bounds.minLng);
      const options = { limit: 3, maxRadius: 500 };
      expect(await uncached.nearest(lat, lng, options)).toEqual(
        await cached.nearest(lat, lng, options)
      );
    }
    expect(uncached.reads).toBeGreaterThan(cached.reads);
  });

  it("reads only features once the whole tree is held in memory", async () => {
    const { featuresOffset } = await readFgbLayout(source);
    const offsets: number[] = [];
    const tracked: ReadRange = async (offset, length) => {
      offsets.push(offset);
      return slice(offset, length);
    };
    const index = await GeoIndex.open(tracked, file.byteLength);
    offsets.length = 0;

    await index.nearest(-33.832, 151.085, { limit: 3, maxRadius: 500 });
    expect(offsets.length).toBeGreaterThan(0);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(featuresOffset);
    }
  });
});
