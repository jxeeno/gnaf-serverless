import * as flatbuffers from "flatbuffers";
import { Feature } from "flatgeobuf/lib/mjs/flat-geobuf/feature.js";
import { GeometryType } from "flatgeobuf/lib/mjs/flat-geobuf/geometry-type.js";
import { generateLevelBounds, NODE_ITEM_BYTE_LEN } from "flatgeobuf/lib/mjs/packedrtree.js";
import { readFgbLayout, type FgbLayout, type ReadRange } from "./fgb.js";

/**
 * Nearest-address search over the reverse-geocode FlatGeobuf, read through
 * range requests.
 *
 * Every index node carries the bounding box of what sits under it, and a leaf's
 * box is its point. So the search finds candidates and ranks them by distance
 * from the tree alone, and only reads features — to learn their PIDs — for the
 * handful that win.
 */

export interface NearestAddress {
  pid: string;
  lat: number;
  lng: number;
  /** Great-circle distance from the query point, in metres */
  distance: number;
}

export interface NearestOptions {
  /** How many addresses to return */
  limit: number;
  /** Ignore anything further away than this, in metres */
  maxRadius: number;
}

/** Range requests made while answering one query. */
export interface ReadCounter {
  reads: number;
  bytes: number;
}

/** Thrown when a search box holds more points than a request should touch. */
export class SearchAreaTooLargeError extends Error {}

const EARTH_RADIUS_M = 6_371_008.8;
const METRES_PER_DEGREE = (EARTH_RADIUS_M * Math.PI) / 180;

/** Start small: in a city a 25 m box already holds the answer. */
const START_HALF_WIDTH_M = 25;

/**
 * A safety net, not a tuning knob. Doubling the box each step means a search
 * reaches this only if one step jumps from too few points to tens of thousands.
 */
const MAX_CANDIDATES = 20_000;

/**
 * Hold the top of the tree in memory, up to this size. For the ~10.7M-point
 * index that is the top five of seven levels (~1.8 MiB), so a search reads two
 * tree levels from storage instead of seven.
 */
const DEFAULT_PREFIX_BUDGET_BYTES = 4 * 1024 * 1024;

/** Nodes this close together are read in one request rather than two. */
const NODE_MERGE_GAP = 16;

/** Features this close together (in bytes) are read in one request. */
const FEATURE_MERGE_GAP_BYTES = 8 * 1024;

interface Candidate {
  x: number;
  y: number;
  /** Offset of the feature within the features section */
  offset: number;
  /** Byte length of the feature, including its 4-byte length prefix */
  length: number;
}

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Great-circle (haversine) distance in metres. */
export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * A lat/lng box that contains every point within `halfWidth` metres.
 *
 * It uses the same sphere as haversineMetres, padded by 1%. A great circle
 * bows slightly poleward of a parallel, so an unpadded box can miss a point at
 * almost exactly `halfWidth` east or west.
 */
function boxAround(lat: number, lng: number, halfWidth: number): Rect {
  const padded = halfWidth * 1.01;
  const dLat = padded / METRES_PER_DEGREE;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const dLng = padded / (METRES_PER_DEGREE * cosLat);
  return {
    minX: lng - dLng,
    maxX: lng + dLng,
    minY: Math.max(lat - dLat, -90),
    maxY: Math.min(lat + dLat, 90),
  };
}

/** Merge sorted-or-not [start, end) ranges whose gap is at most `gap`. */
function mergeRanges(ranges: Array<[number, number]>, gap: number): Array<[number, number]> {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (start - last[1] <= gap) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

export class GeoIndex {
  /** Range requests made since the index was opened, including opening it */
  reads = 0;
  bytesRead = 0;

  private constructor(
    private readonly source: ReadRange,
    private readonly layout: FgbLayout,
    private readonly fileBytes: number,
    /** Node index ranges per level; index 0 is the leaves, the last is the root */
    private readonly levels: Array<[number, number]>,
    /** The first `prefixNodes` nodes of the tree, held in memory */
    private readonly prefix: DataView,
    private readonly prefixNodes: number
  ) {}

  /**
   * Open an index. `fileBytes` is the file's total size, which gives the length
   * of the last feature.
   */
  static async open(
    source: ReadRange,
    fileBytes: number,
    { prefixBudgetBytes = DEFAULT_PREFIX_BUDGET_BYTES } = {}
  ): Promise<GeoIndex> {
    let reads = 0;
    let bytesRead = 0;
    const counted: ReadRange = async (offset, length) => {
      reads++;
      bytesRead += length;
      return source(offset, length);
    };

    const layout = await readFgbLayout(counted);
    const { header } = layout;
    if (header.indexNodeSize === 0) {
      throw new Error("The geo index has no spatial index");
    }
    if (header.geometryType !== GeometryType.Point) {
      throw new Error(`The geo index holds geometry type ${header.geometryType}, not points`);
    }
    if (header.featuresCount === 0) {
      throw new Error("The geo index is empty");
    }

    const levels = generateLevelBounds(header.featuresCount, header.indexNodeSize);

    // Levels are stored root first, so the top of the tree is one contiguous
    // run of nodes. Take as many whole levels as fit the budget.
    let prefixNodes = 0;
    for (let level = levels.length - 1; level >= 0; level--) {
      const end = levels[level][1];
      if (end * NODE_ITEM_BYTE_LEN > prefixBudgetBytes) break;
      prefixNodes = end;
    }
    const prefix =
      prefixNodes > 0
        ? new DataView(await counted(layout.treeOffset, prefixNodes * NODE_ITEM_BYTE_LEN))
        : new DataView(new ArrayBuffer(0));

    const index = new GeoIndex(source, layout, fileBytes, levels, prefix, prefixNodes);
    index.reads = reads;
    index.bytesRead = bytesRead;
    return index;
  }

  private async read(offset: number, length: number, counter?: ReadCounter): Promise<ArrayBuffer> {
    this.reads++;
    this.bytesRead += length;
    if (counter) {
      counter.reads++;
      counter.bytes += length;
    }
    return this.source(offset, length);
  }

  get featuresCount(): number {
    return this.layout.header.featuresCount;
  }

  /**
   * The nearest addresses to a point, closest first. Pass `counter` to count the
   * range requests this one query makes; the totals on the index are shared by
   * every query it serves.
   */
  async nearest(
    lat: number,
    lng: number,
    { limit, maxRadius }: NearestOptions,
    counter?: ReadCounter
  ): Promise<NearestAddress[]> {
    // Grow the box until it holds enough points or reaches the radius limit.
    let halfWidth = Math.min(START_HALF_WIDTH_M, maxRadius);
    let candidates = await this.searchBox(boxAround(lat, lng, halfWidth), counter);
    while (candidates.length < limit && halfWidth < maxRadius) {
      halfWidth = Math.min(halfWidth * 2, maxRadius);
      candidates = await this.searchBox(boxAround(lat, lng, halfWidth), counter);
    }

    let ranked = this.rank(candidates, lat, lng);

    // A square box can hold the k nearest points while missing a closer one
    // just outside its edge, because its corners reach further than its sides.
    // If the k-th point is further than the box's half-width, search again with
    // a box that contains that whole distance.
    if (ranked.length >= limit) {
      const kth = ranked[limit - 1].distance;
      const needed = Math.min(kth, maxRadius);
      if (needed > halfWidth) {
        ranked = this.rank(await this.searchBox(boxAround(lat, lng, needed), counter), lat, lng);
      }
    }

    const within = ranked.filter((c) => c.distance <= maxRadius);
    if (within.length === 0) return [];

    // Include every point tied with the last place, so ties can be broken by PID
    // once the PIDs are known. Otherwise the choice among them would depend on
    // tree order.
    const cutoff = within[Math.min(limit, within.length) - 1].distance;
    const chosen = within.filter((c) => c.distance <= cutoff);
    const pids = await this.readPids(chosen, counter);

    return chosen
      .map((c, i) => ({ pid: pids[i], lat: c.y, lng: c.x, distance: c.distance }))
      .sort((a, b) => a.distance - b.distance || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0))
      .slice(0, limit);
  }

  private rank(candidates: Candidate[], lat: number, lng: number) {
    return candidates
      .map((c) => ({ ...c, distance: haversineMetres(lat, lng, c.y, c.x) }))
      .sort((a, b) => a.distance - b.distance);
  }

  private async readNodes(start: number, count: number, counter?: ReadCounter): Promise<DataView> {
    if (start + count <= this.prefixNodes) {
      return new DataView(
        this.prefix.buffer,
        this.prefix.byteOffset + start * NODE_ITEM_BYTE_LEN,
        count * NODE_ITEM_BYTE_LEN
      );
    }
    return new DataView(
      await this.read(
        this.layout.treeOffset + start * NODE_ITEM_BYTE_LEN,
        count * NODE_ITEM_BYTE_LEN,
        counter
      )
    );
  }

  /** Every point inside `rect`, read level by level from the root. */
  private async searchBox(rect: Rect, counter?: ReadCounter): Promise<Candidate[]> {
    const { levels } = this;
    const nodeSize = this.layout.header.indexNodeSize;
    const found: Candidate[] = [];
    let ranges: Array<[number, number]> = [[0, 1]];

    for (let level = levels.length - 1; level >= 0 && ranges.length > 0; level--) {
      const isLeaf = level === 0;
      const levelEnd = levels[level][1];
      const next: Array<[number, number]> = [];

      // Reading a gap between wanted nodes is harmless: a node that overlaps the
      // box always sits under a parent that overlaps it, so any gap node that
      // matches would have been visited anyway.
      for (const [start, wantedEnd] of mergeRanges(ranges, NODE_MERGE_GAP)) {
        // At the leaves, read one node further so the last hit's feature
        // length can be worked out from where the next feature starts.
        const end = isLeaf ? Math.min(wantedEnd + 1, levelEnd) : wantedEnd;
        const view = await this.readNodes(start, end - start, counter);

        for (let i = start; i < wantedEnd; i++) {
          const o = (i - start) * NODE_ITEM_BYTE_LEN;
          const minX = view.getFloat64(o, true);
          const minY = view.getFloat64(o + 8, true);
          const maxX = view.getFloat64(o + 16, true);
          const maxY = view.getFloat64(o + 24, true);
          if (maxX < rect.minX || maxY < rect.minY || minX > rect.maxX || minY > rect.maxY) {
            continue;
          }
          const offset = Number(view.getBigUint64(o + 32, true));

          if (!isLeaf) {
            // An inner node's offset is the index of its first child.
            next.push([offset, Math.min(offset + nodeSize, levels[level - 1][1])]);
            continue;
          }

          const nextOffset =
            i + 1 < levelEnd
              ? Number(view.getBigUint64(o + NODE_ITEM_BYTE_LEN + 32, true))
              : this.fileBytes - this.layout.featuresOffset;
          found.push({ x: minX, y: minY, offset, length: nextOffset - offset });
          if (found.length > MAX_CANDIDATES) {
            throw new SearchAreaTooLargeError(
              `More than ${MAX_CANDIDATES} addresses in the search area; use a smaller radius`
            );
          }
        }
      }
      ranges = next;
    }
    return found;
  }

  /** Read the PID of each candidate, batching features that sit close together. */
  private async readPids(candidates: Candidate[], counter?: ReadCounter): Promise<string[]> {
    const order = candidates.map((c, i) => ({ c, i })).sort((a, b) => a.c.offset - b.c.offset);
    const pids = new Array<string>(candidates.length);

    let batch: typeof order = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const from = batch[0].c.offset;
      const to = Math.max(...batch.map(({ c }) => c.offset + c.length));
      const bytes = new Uint8Array(
        await this.read(this.layout.featuresOffset + from, to - from, counter)
      );
      for (const { c, i } of batch) {
        pids[i] = decodePid(bytes.subarray(c.offset - from, c.offset - from + c.length));
      }
      batch = [];
    };

    for (const entry of order) {
      const last = batch[batch.length - 1];
      if (last && entry.c.offset - (last.c.offset + last.c.length) > FEATURE_MERGE_GAP_BYTES) {
        await flush();
      }
      batch.push(entry);
    }
    await flush();
    return pids;
  }
}

const textDecoder = new TextDecoder();

/**
 * The GNAF PID from one feature, including its 4-byte length prefix.
 *
 * FlatGeobuf packs properties as a column index (uint16) followed by the value;
 * a string value is a uint32 byte length and then UTF-8. The index has exactly
 * one column, gnaf_pid, which the pipeline checks when it builds the file.
 */
export function decodePid(featureBytes: Uint8Array): string {
  // flatbuffers reads from a ByteBuffer's start, so give it its own copy.
  const feature = Feature.getSizePrefixedRootAsFeature(
    new flatbuffers.ByteBuffer(featureBytes.slice())
  );
  const props = feature.propertiesArray();
  if (!props || props.byteLength < 6) {
    throw new Error("Geo index feature has no properties");
  }
  const view = new DataView(props.buffer, props.byteOffset, props.byteLength);
  if (view.getUint16(0, true) !== 0) {
    throw new Error("Geo index feature's first property isn't gnaf_pid");
  }
  const length = view.getUint32(2, true);
  return textDecoder.decode(props.subarray(6, 6 + length));
}
