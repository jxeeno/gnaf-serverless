import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as flatbuffers from "flatbuffers";
import { Feature } from "flatgeobuf/lib/mjs/flat-geobuf/feature.js";
import { readFgbLayout, type ReadRange } from "./fgb.js";
import {
  GeoIndex,
  decodePid,
  haversineMetres,
  type GeoIndexOptions,
  type NearestAddress,
} from "./reverse-geocode.js";

// Both fixtures are street-level points written by the pipeline's own
// DuckDB/GDAL path. Vitest runs from the repo root.
//   rhodes:   234 points around Rhodes NSW; a 3-level tree.
//   homebush: 6,289 points around Homebush Bay, with open water and parkland
//             in the middle; a 5-level tree.
const fixtures = {
  rhodes: readFileSync("src/shared/fixtures/rhodes.fgb"),
  homebush: readFileSync("src/shared/fixtures/homebush.fgb"),
};

interface Point {
  pid: string;
  lat: number;
  lng: number;
  offset: number;
}

function reader(file: Buffer) {
  const slice = (offset: number, length: number): ArrayBuffer => {
    if (offset < 0 || offset + length > file.byteLength) {
      throw new Error(`read outside the file: ${offset}+${length}`);
    }
    return file.buffer.slice(file.byteOffset + offset, file.byteOffset + offset + length);
  };
  const source: ReadRange = async (offset, length) => slice(offset, length);
  return { slice, source };
}

/** Every point in a file, found by walking the features in turn — no tree involved. */
async function readAllPoints(file: Buffer): Promise<Point[]> {
  const { slice, source } = reader(file);
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

// How much of the tree is held in memory, from none of it to all of it. The
// zero-byte page cache makes every page read go to storage and be evicted.
const memorySettings: Array<[string, GeoIndexOptions]> = [
  ["whole tree in memory", {}],
  ["top three levels in memory", { prefixBudgetBytes: 1200 }],
  ["nothing in memory", { prefixBudgetBytes: 0, pageCacheBytes: 0 }],
];

describe.each(Object.entries(fixtures))("GeoIndex.nearest on %s", (_name, file) => {
  const { source } = reader(file);
  let points: Point[];
  let bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };

  beforeAll(async () => {
    points = await readAllPoints(file);
    bounds = {
      minLat: Math.min(...points.map((p) => p.lat)),
      maxLat: Math.max(...points.map((p) => p.lat)),
      minLng: Math.min(...points.map((p) => p.lng)),
      maxLng: Math.max(...points.map((p) => p.lng)),
    };
  });

  it.each(memorySettings)("agrees with a brute-force search at random points (%s)", async (_label, options) => {
    const index = await GeoIndex.open(source, file.byteLength, options);
    const random = mulberry32(20260917);
    // Spread the queries a little past the data, so some start far from it.
    const pad = 0.004;
    for (let i = 0; i < 150; i++) {
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
    const random = mulberry32(3);
    const sample = points.length > 300 ? points.filter(() => random() < 300 / points.length) : points;
    for (const p of sample) {
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

  it("reads only features once the whole tree is held in memory", async () => {
    const { featuresOffset } = await readFgbLayout(source);
    const offsets: number[] = [];
    const tracked: ReadRange = async (offset, length) => {
      offsets.push(offset);
      return source(offset, length);
    };
    const index = await GeoIndex.open(tracked, file.byteLength);
    offsets.length = 0;

    const mid = { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 };
    await index.nearest(mid.lat, mid.lng, { limit: 3, maxRadius: 500 });
    expect(offsets.length).toBeGreaterThan(0);
    for (const offset of offsets) {
      expect(offset).toBeGreaterThanOrEqual(featuresOffset);
    }
  });
});

describe("GeoIndex.nearest", () => {
  const file = fixtures.rhodes;
  const { source } = reader(file);

  it("finds 76 Rider Bvd at its own geocode", async () => {
    const index = await GeoIndex.open(source, file.byteLength);
    const [hit] = await index.nearest(-33.83263969, 151.08540762, { limit: 1, maxRadius: 100 });
    expect(hit.pid).toBe("GANSW717928588");
    expect(hit.distance).toBeLessThan(1);
  });

  it("counts one query's reads separately from the index's running total", async () => {
    const index = await GeoIndex.open(source, file.byteLength, { prefixBudgetBytes: 0 });
    const before = index.reads;
    const counter = { reads: 0, bytes: 0 };
    await index.nearest(-33.832, 151.085, { limit: 3, maxRadius: 500 }, counter);
    expect(counter.reads).toBeGreaterThan(0);
    expect(index.reads - before).toBe(counter.reads);
  });

  it("reuses tree pages it has already read", async () => {
    const index = await GeoIndex.open(source, file.byteLength, { prefixBudgetBytes: 0 });
    const first = { reads: 0, bytes: 0 };
    const second = { reads: 0, bytes: 0 };
    await index.nearest(-33.832, 151.085, { limit: 1, maxRadius: 500 }, first);
    await index.nearest(-33.832, 151.085, { limit: 1, maxRadius: 500 }, second);
    // The repeat only needs its feature: every tree page comes from the cache.
    expect(second.reads).toBe(1);
    expect(first.reads).toBeGreaterThan(second.reads);
  });
});

describe("GeoIndex.nearest on homebush, reading from storage", () => {
  const file = fixtures.homebush;
  const { source } = reader(file);

  it("reads only a few pages for a query among houses", async () => {
    // With only the top three levels held in memory, a nearby answer needs the
    // two levels below: a handful of reads, fetched a few at a time.
    const index = await GeoIndex.open(source, file.byteLength, { prefixBudgetBytes: 1200 });
    const counter = { reads: 0, bytes: 0 };
    const [hit] = await index.nearest(-33.8317, 151.0763, { limit: 1, maxRadius: 2000 }, counter);
    expect(hit.distance).toBeLessThan(100);
    expect(counter.reads).toBeLessThanOrEqual(10);
  });
});
