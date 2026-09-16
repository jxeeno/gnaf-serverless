import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { streamSearch } from "flatgeobuf/lib/mjs/packedrtree.js";
import { ColumnType } from "flatgeobuf/lib/mjs/flat-geobuf/column-type.js";
import { GeometryType } from "flatgeobuf/lib/mjs/flat-geobuf/geometry-type.js";
import { readFgbLayout, type ReadRange } from "./fgb.js";

// 234 street-level points around Rhodes NSW, written by the same DuckDB/GDAL
// path the pipeline uses.
// Vitest runs from the repo root.
const file = readFileSync("src/shared/fixtures/rhodes.fgb");

const read: ReadRange = async (offset, length) => {
  if (offset + length > file.byteLength) {
    throw new Error(`read past end of file: ${offset}+${length}`);
  }
  return file.buffer.slice(file.byteOffset + offset, file.byteOffset + offset + length);
};

describe("readFgbLayout", () => {
  it("reads the header the pipeline writes", async () => {
    const { header } = await readFgbLayout(read);
    expect(header.featuresCount).toBe(234);
    expect(header.indexNodeSize).toBe(16);
    expect(header.geometryType).toBe(GeometryType.Point);
    expect(header.columns?.map((c) => [c.name, c.type])).toEqual([
      ["gnaf_pid", ColumnType.String],
    ]);
  });

  it("locates the tree well enough to find every feature", async () => {
    const { header, treeOffset, featuresOffset } = await readFgbLayout(read);
    const everywhere = { minX: -180, minY: -90, maxX: 180, maxY: 90 };

    const hits: number[] = [];
    for await (const [offset] of streamSearch(
      header.featuresCount,
      header.indexNodeSize,
      everywhere,
      (o, size) => read(treeOffset + o, size)
    )) {
      hits.push(offset);
    }

    expect(hits).toHaveLength(234);
    // Every feature must start inside the features section.
    for (const offset of hits) {
      expect(featuresOffset + offset).toBeLessThan(file.byteLength);
    }
  });

  it("puts the features section right after the tree", async () => {
    const { treeOffset, treeLength, featuresOffset } = await readFgbLayout(read);
    expect(treeLength).toBeGreaterThan(0);
    expect(featuresOffset).toBe(treeOffset + treeLength);
    // Each feature starts with its own 4-byte length, which must fit the file.
    const firstLength = new DataView(await read(featuresOffset, 4)).getUint32(0, true);
    expect(featuresOffset + 4 + firstLength).toBeLessThanOrEqual(file.byteLength);
  });

  it("rejects a file that is not FlatGeobuf", async () => {
    const notFgb: ReadRange = async (_offset, length) => new ArrayBuffer(length);
    await expect(readFgbLayout(notFgb)).rejects.toThrow("Not a FlatGeobuf v3 file");
  });
});
